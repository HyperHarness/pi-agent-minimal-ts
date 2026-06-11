// Stage 4: grade a run and produce a report.
//
// Usage:
//   node benchmark/grade.mjs --responses benchmark/results/agent-dev.jsonl
//        [--benchmark benchmark/benchmark.jsonl] [--compare benchmark/results/baseline-dev.jsonl]
//        [--concurrency 4]
//
// Scoring:
//   - pointer:    mechanical — gold sourceKey must appear in the answer.
//   - abstention: mechanical NOT_IN_KB token, LLM fallback for phrased refusals.
//                 Any substantive answer = fail (this is the hallucination metric).
//   - factual / numerical / multihop: LLM judge sees gold answer + evidence quotes
//     (the agent never does). Numerical answers must match within rounding of the
//     last reported digit, with units. correct=1, partial=0.5.
//   - synthesis:  judge counts rubric points covered; score = covered / total.
//   - citations:  precision/recall of cited sourceKeys vs gold_sources, plus the
//     uncited-answer and unknown-key rates.
// With --compare, reports per-category delta vs the comparison run (e.g. no-KB
// baseline) and the "discriminative accuracy": accuracy restricted to items the
// baseline got wrong — the cleanest signal that the KB, not pretraining, answered.
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import {
  BENCHMARK_DIR,
  callLlm,
  extractJson,
  listSources,
  pLimit,
  parseArgs,
  readJsonl,
  resolveBenchToolModel,
  writeJsonl
} from "./lib.mjs";

const ABSTAIN_PATTERN = /\bNOT_IN_KB\b/;

function judgePrompt(item, answer) {
  const evidence = (item.evidence ?? [])
    .map((entry) => `[${entry.sourceKey}] "${entry.quote}"`)
    .join("\n");
  const numericalRule =
    item.category === "numerical"
      ? '\n- For numerical answers: the value must match the gold answer within rounding of its last reported digit, with compatible units. Missing or wrong uncertainty when the gold answer includes one -> at best "partial".'
      : "";
  return `You are grading an answer against a gold reference for a QA benchmark on superconducting quantum design.

QUESTION: ${item.question}
GOLD ANSWER: ${item.gold_answer}
GOLD EVIDENCE:
${evidence}

CANDIDATE ANSWER:
${answer}

Rules:
- "correct": the candidate states the gold answer's content (paraphrase is fine; extra correct context is fine).
- "partial": the core is right but a material detail is wrong/missing (value imprecise, one half of a comparison missing).
- "incorrect": contradicts the gold answer, answers something else, or abstains.${numericalRule}
Output STRICT JSON: {"verdict": "correct" | "partial" | "incorrect", "reason": "one sentence"}`;
}

function synthesisJudgePrompt(item, answer) {
  return `You are grading an open synthesis answer against a rubric.

QUESTION: ${item.question}
RUBRIC:
${item.rubric.map((point, index) => `${index + 1}. [${point.sourceKey}] ${point.point}`).join("\n")}

CANDIDATE ANSWER:
${answer}

For each rubric point decide whether the candidate answer covers its substance (exact wording not required, source key citation not required for coverage).
Output STRICT JSON: {"covered": [list of covered rubric point numbers], "reason": "one sentence"}`;
}

function abstentionJudgePrompt(item, answer) {
  return `QUESTION: ${item.question}
The correct behavior is to state that the information is not available in the knowledge base.

CANDIDATE ANSWER:
${answer}

Does the candidate clearly decline / state the information is unavailable (correct), or does it give a substantive answer (incorrect)?
Output STRICT JSON: {"verdict": "correct" | "incorrect", "reason": "one sentence"}`;
}

function extractCitedKeys(answer, knownKeys) {
  const cited = new Set();
  for (const key of knownKeys) {
    if (answer.includes(key)) {
      cited.add(key);
    }
  }
  return [...cited];
}

async function gradeItem(item, response, knownKeys, model) {
  const answer = (response.answer ?? "").trim();
  const grade = {
    id: item.id,
    category: item.category,
    citedSources: extractCitedKeys(answer, knownKeys),
    abstained: ABSTAIN_PATTERN.test(answer) || answer.length === 0
  };

  if (response.error && !answer) {
    return { ...grade, score: 0, verdict: "error", reason: response.error };
  }

  if (item.category === "abstention") {
    if (grade.abstained) {
      return { ...grade, score: 1, verdict: "correct", reason: "abstained" };
    }
    const { text } = await callLlm(model, { user: abstentionJudgePrompt(item, answer), maxTokens: 400 });
    const verdict = extractJson(text);
    return { ...grade, score: verdict.verdict === "correct" ? 1 : 0, verdict: verdict.verdict, reason: verdict.reason };
  }

  if (grade.abstained) {
    return { ...grade, score: 0, verdict: "incorrect", reason: "abstained on answerable item" };
  }

  if (item.category === "pointer") {
    const hit = item.gold_sources.every((key) => grade.citedSources.includes(key) || answer.includes(key));
    return { ...grade, score: hit ? 1 : 0, verdict: hit ? "correct" : "incorrect", reason: hit ? "gold sourceKey named" : "gold sourceKey not named" };
  }

  if (item.category === "synthesis") {
    const { text } = await callLlm(model, { user: synthesisJudgePrompt(item, answer), maxTokens: 600 });
    const result = extractJson(text);
    const covered = Array.isArray(result.covered) ? result.covered.length : 0;
    const score = item.rubric.length > 0 ? covered / item.rubric.length : 0;
    return { ...grade, score, verdict: `covered ${covered}/${item.rubric.length}`, reason: result.reason };
  }

  const { text } = await callLlm(model, { user: judgePrompt(item, answer), maxTokens: 400 });
  const verdict = extractJson(text);
  const score = verdict.verdict === "correct" ? 1 : verdict.verdict === "partial" ? 0.5 : 0;
  return { ...grade, score, verdict: verdict.verdict, reason: verdict.reason };
}

function citationStats(items, gradesById) {
  let precisionSum = 0;
  let recallSum = 0;
  let counted = 0;
  let uncited = 0;
  for (const item of items) {
    if (!item.answerable || item.gold_sources.length === 0) continue;
    const grade = gradesById.get(item.id);
    if (!grade || grade.verdict === "error" || grade.abstained) continue;
    counted += 1;
    const cited = grade.citedSources;
    if (cited.length === 0) {
      uncited += 1;
      continue;
    }
    const hits = cited.filter((key) => item.gold_sources.includes(key)).length;
    precisionSum += hits / cited.length;
    recallSum += hits / item.gold_sources.length;
  }
  return {
    items: counted,
    precision: counted ? precisionSum / counted : 0,
    recall: counted ? recallSum / counted : 0,
    uncitedRate: counted ? uncited / counted : 0
  };
}

function aggregate(items, gradesById) {
  const perCategory = {};
  for (const item of items) {
    const grade = gradesById.get(item.id);
    if (!grade) continue;
    const bucket = (perCategory[item.category] ??= { n: 0, scoreSum: 0, errors: 0 });
    bucket.n += 1;
    bucket.scoreSum += grade.score;
    if (grade.verdict === "error") bucket.errors += 1;
  }
  const rows = Object.entries(perCategory).map(([category, bucket]) => ({
    category,
    n: bucket.n,
    accuracy: bucket.n ? bucket.scoreSum / bucket.n : 0,
    errors: bucket.errors
  }));
  const totalN = rows.reduce((sum, row) => sum + row.n, 0);
  const overall = totalN ? rows.reduce((sum, row) => sum + row.accuracy * row.n, 0) / totalN : 0;
  return { rows, overall, totalN };
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    benchmark: path.join(BENCHMARK_DIR, "benchmark.jsonl"),
    concurrency: "4"
  });
  if (!args.responses) {
    throw new Error("--responses <file> is required");
  }
  const model = resolveBenchToolModel();
  console.log(`judge model: ${model.provider}/${model.id}`);

  const benchmark = await readJsonl(args.benchmark);
  const benchmarkById = new Map(benchmark.map((item) => [item.id, item]));
  const responses = await readJsonl(args.responses);
  const knownKeys = (await listSources()).map((source) => source.sourceKey);

  const limit = pLimit(Number(args.concurrency));
  const grades = await Promise.all(
    responses
      .filter((response) => benchmarkById.has(response.id))
      .map((response) =>
        limit(async () => {
          const item = benchmarkById.get(response.id);
          try {
            const grade = await gradeItem(item, response, knownKeys, model);
            console.log(`${item.id} (${item.category}): ${grade.verdict}`);
            return grade;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`${item.id}: grading error ${message}`);
            return { id: item.id, category: item.category, citedSources: [], abstained: false, score: 0, verdict: "error", reason: message };
          }
        })
      )
  );
  const gradesById = new Map(grades.map((grade) => [grade.id, grade]));
  const gradedItems = benchmark.filter((item) => gradesById.has(item.id));

  const main = aggregate(gradedItems, gradesById);
  const citations = citationStats(gradedItems, gradesById);
  const usage = responses.reduce(
    (total, response) => ({
      totalTokens: total.totalTokens + (response.usage?.totalTokens ?? 0),
      cost: total.cost + (response.usage?.cost ?? 0),
      elapsedMs: total.elapsedMs + (response.elapsedMs ?? 0)
    }),
    { totalTokens: 0, cost: 0, elapsedMs: 0 }
  );

  let compareSection = "";
  let discriminative;
  if (args.compare) {
    const compareResponses = await readJsonl(args.compare);
    const compareGrades = await Promise.all(
      compareResponses
        .filter((response) => benchmarkById.has(response.id) && gradesById.has(response.id))
        .map((response) =>
          limit(async () => {
            const item = benchmarkById.get(response.id);
            try {
              return await gradeItem(item, response, knownKeys, model);
            } catch {
              return { id: item.id, category: item.category, citedSources: [], abstained: false, score: 0, verdict: "error", reason: "grading error" };
            }
          })
        )
    );
    const compareById = new Map(compareGrades.map((grade) => [grade.id, grade]));
    const sharedItems = gradedItems.filter((item) => compareById.has(item.id));
    const compareAgg = aggregate(sharedItems, compareById);
    const mainShared = aggregate(sharedItems, gradesById);

    const hardItems = sharedItems.filter((item) => item.answerable && (compareById.get(item.id)?.score ?? 0) < 1);
    const hardAgg = aggregate(hardItems, gradesById);
    discriminative = { n: hardItems.length, accuracy: hardAgg.overall };

    const deltaRows = mainShared.rows.map((row) => {
      const compareRow = compareAgg.rows.find((r) => r.category === row.category);
      return `| ${row.category} | ${row.n} | ${formatPct(row.accuracy)} | ${formatPct(compareRow?.accuracy ?? 0)} | ${formatPct(row.accuracy - (compareRow?.accuracy ?? 0))} |`;
    });
    compareSection = `
## Agent vs. comparison run (${path.basename(args.compare)})

| category | n | this run | comparison | delta |
|---|---|---|---|---|
${deltaRows.join("\n")}

Overall: ${formatPct(mainShared.overall)} vs ${formatPct(compareAgg.overall)} (delta ${formatPct(mainShared.overall - compareAgg.overall)})

**Discriminative accuracy** (answerable items the comparison run did NOT fully solve — the cleanest KB-vs-pretraining signal): ${formatPct(discriminative.accuracy)} over ${discriminative.n} items.
`;
  }

  const abstentionGrades = gradedItems.filter((item) => item.category === "abstention").map((item) => gradesById.get(item.id));
  const falseAnswerRate = abstentionGrades.length
    ? abstentionGrades.filter((grade) => grade.score === 0 && grade.verdict !== "error").length / abstentionGrades.length
    : 0;

  const report = `# Benchmark report

Responses: \`${args.responses}\` (${responses.length} responses, ${gradedItems.length} graded)
Judge: ${model.provider}/${model.id}

## Accuracy by category

| category | n | accuracy | errors |
|---|---|---|---|
${main.rows.map((row) => `| ${row.category} | ${row.n} | ${formatPct(row.accuracy)} | ${row.errors} |`).join("\n")}

**Overall: ${formatPct(main.overall)}** over ${main.totalN} items.

## Grounding

- Citation precision: ${formatPct(citations.precision)} / recall: ${formatPct(citations.recall)} (over ${citations.items} answered items)
- Uncited-answer rate: ${formatPct(citations.uncitedRate)}
- False-answer rate on abstention items (hallucination metric): ${formatPct(falseAnswerRate)}

## Cost

- Total tokens: ${usage.totalTokens.toLocaleString()} — reported cost: $${usage.cost.toFixed(4)}
- Mean latency per item: ${(usage.elapsedMs / Math.max(1, responses.length) / 1000).toFixed(1)} s
${compareSection}`;

  const outDir = path.join(path.dirname(args.responses), "reports");
  await mkdir(outDir, { recursive: true });
  const base = path.basename(args.responses, ".jsonl");
  await writeJsonl(path.join(outDir, `${base}-grades.jsonl`), grades);
  await writeFile(path.join(outDir, `${base}-report.md`), report, "utf8");
  console.log(`\n${report}`);
  console.log(`written: ${path.join(outDir, `${base}-report.md`)}`);
}

await main();
