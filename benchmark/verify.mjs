// Stage 2: adversarially verify candidates and freeze the benchmark.
//
// Usage: node benchmark/verify.mjs [--in benchmark/candidates.jsonl]
//          [--out benchmark/benchmark.jsonl] [--rejected benchmark/rejected.jsonl]
//          [--concurrency 4]
//
// Two passes per item:
//   1. Mechanical: every evidence quote must be a (whitespace-normalized) verbatim
//      substring of its source parse. Fails -> rejected, no LLM call.
//   2. Adversarial LLM check, instructed to REJECT unless the item is airtight:
//      - grounded items: evidence window must entail the gold answer as the only
//        defensible reading and the question must be self-contained.
//      - abstention items: the (truncated) full parse must NOT contain the info.
//      - synthesis items: every rubric point must be supported by its source summary.
//
// Survivors are frozen to benchmark.jsonl with stable ids and a dev/holdout split
// (~20% holdout, assigned by question hash so it is reproducible).
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  BENCHMARK_DIR,
  callLlm,
  extractJson,
  findQuote,
  fnv1a,
  listSources,
  pLimit,
  parseArgs,
  quoteWindow,
  readJsonl,
  readTextCapped,
  resolveBenchToolModel,
  writeJsonl
} from "./lib.mjs";

const GROUNDED_CATEGORIES = new Set(["factual", "numerical", "pointer", "multihop"]);

function groundedVerifyPrompt(item, windows) {
  const evidenceBlocks = windows
    .map((window, index) => `EVIDENCE WINDOW ${index + 1} (source ${window.sourceKey}):\n${window.text}`)
    .join("\n\n");
  return `You are an adversarial reviewer for a QA benchmark on superconducting quantum design. Your default stance is REJECT. Pass an item only if it is airtight.

ITEM:
question: ${item.question}
gold_answer: ${item.gold_answer}
category: ${item.category}

${evidenceBlocks}

Reject if ANY of the following holds:
- The question is not self-contained (a knowledge-base agent could not identify which work is meant without extra context).
- The evidence does not clearly entail the gold answer.
- Another defensible answer exists given the question wording (ambiguity).
- The gold answer misstates units, uncertainty, or value relative to the evidence.
- The question is generic textbook knowledge answerable without any document.

Output STRICT JSON: {"verdict": "pass" | "fail", "reason": "one sentence"}`;
}

function abstentionVerifyPrompt(item, parseText) {
  return `You are an adversarial reviewer for a QA benchmark. This item expects the agent to ABSTAIN because the document supposedly does NOT contain the requested information.

question: ${item.question}
claimed absence: ${item.absence_claim ?? "(none provided)"}

DOCUMENT TEXT (may be truncated):
${parseText}

Reject ("fail") if the document DOES report the requested information, or if the question is too vague to decide what is being asked, or if the question fails to identify the work it refers to.
Output STRICT JSON: {"verdict": "pass" | "fail", "reason": "one sentence"}`;
}

function synthesisVerifyPrompt(item, summaryBlocks) {
  return `You are an adversarial reviewer for a synthesis benchmark. Check every rubric point against the source summaries below. Your default stance is REJECT.

question: ${item.question}
rubric:
${(item.rubric ?? []).map((r, i) => `${i + 1}. [${r.sourceKey}] ${r.point}`).join("\n")}

${summaryBlocks}

Reject ("fail") if any rubric point is unsupported by its named source summary, or if the question does not match the rubric.
Output STRICT JSON: {"verdict": "pass" | "fail", "reason": "one sentence"}`;
}

function itemEvidence(item) {
  if (Array.isArray(item.evidence)) {
    return item.evidence;
  }
  if (item.evidence_quote && item.anchor_source) {
    return [{ sourceKey: item.anchor_source, quote: item.evidence_quote }];
  }
  return [];
}

async function verifyItem(item, sourcesByKey, model) {
  const category = item.category;

  if (GROUNDED_CATEGORIES.has(category)) {
    const evidence = itemEvidence(item);
    if (evidence.length === 0) {
      return { verdict: "fail", reason: "no evidence quote" };
    }
    const windows = [];
    for (const entry of evidence) {
      const source = sourcesByKey.get(entry.sourceKey);
      if (!source) {
        return { verdict: "fail", reason: `unknown sourceKey ${entry.sourceKey}` };
      }
      const documentText = await readFile(source.parsePath, "utf8");
      if (!findQuote(entry.quote ?? "", documentText).found) {
        return { verdict: "fail", reason: `quote not found verbatim in ${entry.sourceKey}` };
      }
      windows.push({ sourceKey: entry.sourceKey, text: quoteWindow(entry.quote, documentText) });
    }
    const { text } = await callLlm(model, { user: groundedVerifyPrompt(item, windows), maxTokens: 500 });
    return extractJson(text);
  }

  if (category === "abstention") {
    const source = sourcesByKey.get(item.anchor_source);
    if (!source) {
      return { verdict: "fail", reason: "missing anchor source" };
    }
    const parseText = await readTextCapped(source.parsePath, 50_000);
    const { text } = await callLlm(model, { user: abstentionVerifyPrompt(item, parseText), maxTokens: 500 });
    return extractJson(text);
  }

  if (category === "synthesis") {
    if (!Array.isArray(item.rubric) || item.rubric.length < 3) {
      return { verdict: "fail", reason: "rubric missing or too short" };
    }
    const blocks = [];
    for (const point of item.rubric) {
      const source = sourcesByKey.get(point.sourceKey);
      if (!source || !source.summaryPath) {
        return { verdict: "fail", reason: `rubric cites unknown source ${point.sourceKey}` };
      }
      blocks.push(`SUMMARY (${point.sourceKey}):\n${await readTextCapped(source.summaryPath, 5000)}`);
    }
    const uniqueBlocks = [...new Set(blocks)].join("\n\n");
    const { text } = await callLlm(model, { user: synthesisVerifyPrompt(item, uniqueBlocks), maxTokens: 500 });
    return extractJson(text);
  }

  return { verdict: "fail", reason: `unknown category ${category}` };
}

function freezeItem(item, sequence) {
  const id = `sq-${String(sequence).padStart(3, "0")}`;
  const split = fnv1a(`${item.category}::${item.question}`) % 5 === 0 ? "holdout" : "dev";
  return {
    id,
    category: item.category,
    question: item.question,
    gold_answer: item.gold_answer ?? null,
    gold_sources: item.gold_sources ?? [],
    evidence: itemEvidence(item),
    rubric: item.rubric ?? undefined,
    absence_claim: item.absence_claim ?? undefined,
    answerable: item.category !== "abstention",
    difficulty: item.difficulty ?? "medium",
    split
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    in: path.join(BENCHMARK_DIR, "candidates.jsonl"),
    out: path.join(BENCHMARK_DIR, "benchmark.jsonl"),
    rejected: path.join(BENCHMARK_DIR, "rejected.jsonl"),
    concurrency: "4"
  });
  const model = resolveBenchToolModel();
  console.log(`verifier model: ${model.provider}/${model.id}`);

  const sources = await listSources();
  const sourcesByKey = new Map(sources.map((source) => [source.sourceKey, source]));
  const records = await readJsonl(args.in);
  const candidates = records.flatMap((record) =>
    (record.items ?? []).map((item) => ({ ...item, taskId: record.taskId }))
  );
  console.log(`candidates: ${candidates.length}`);

  const limit = pLimit(Number(args.concurrency));
  const results = await Promise.all(
    candidates.map((item, index) =>
      limit(async () => {
        try {
          const verdict = await verifyItem(item, sourcesByKey, model);
          const passed = verdict.verdict === "pass";
          console.log(`[${index + 1}/${candidates.length}] ${passed ? "pass" : "FAIL"} (${item.category}) ${passed ? "" : verdict.reason ?? ""}`);
          return { item, verdict };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[${index + 1}/${candidates.length}] ERROR (${item.category}): ${message}`);
          return { item, verdict: { verdict: "fail", reason: `verifier error: ${message}` } };
        }
      })
    )
  );

  const accepted = results.filter((result) => result.verdict.verdict === "pass").map((result) => result.item);
  const rejected = results
    .filter((result) => result.verdict.verdict !== "pass")
    .map((result) => ({ ...result.item, reject_reason: result.verdict.reason }));

  const categoryOrder = ["factual", "numerical", "pointer", "multihop", "abstention", "synthesis"];
  accepted.sort((a, b) => {
    const orderDelta = categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    return orderDelta !== 0 ? orderDelta : a.question.localeCompare(b.question);
  });
  const frozen = accepted.map((item, index) => freezeItem(item, index + 1));

  await writeJsonl(args.out, frozen);
  await writeJsonl(args.rejected, rejected);

  const byCategory = {};
  const bySplit = { dev: 0, holdout: 0 };
  for (const item of frozen) {
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    bySplit[item.split] += 1;
  }
  console.log(`\nfrozen: ${frozen.length} items -> ${args.out}`);
  console.log(`rejected: ${rejected.length} -> ${args.rejected}`);
  console.log(`by category: ${JSON.stringify(byCategory)}`);
  console.log(`split: ${JSON.stringify(bySplit)}`);
  console.log(`next: node benchmark/run.mjs --split dev`);
}

await main();
