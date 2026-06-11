// Stage 1: generate candidate benchmark items from the raw source parses.
//
// Usage: node benchmark/generate.mjs [--out benchmark/candidates.jsonl] [--concurrency 4] [--max-tasks N]
//
// Deterministic task assignment over the sorted source list:
//   - every 2nd source        -> 1 factual + 1 numerical item (from full parse)
//   - every 4th source (i%4=1) -> 1 retrieval "pointer" item (answer = sourceKey)
//   - every 4th source (i%4=3) -> 1 abstention item (plausible detail NOT in the paper)
//   - related-source pairs     -> up to 25 multi-hop comparison items
//   - shared-tag clusters      -> up to 8 open synthesis items (rubric-graded)
//
// Resumable: already-generated task ids in the output file are skipped.
import path from "node:path";
import {
  BENCHMARK_DIR,
  appendJsonl,
  callLlm,
  extractJson,
  listSources,
  pLimit,
  parseArgs,
  readJsonl,
  readTextCapped,
  resolveBenchToolModel
} from "./lib.mjs";

const PARSE_CHAR_CAP = 50_000;
const PAIR_PARSE_CHAR_CAP = 25_000;

const COMMON_RULES = `
General rules for every item:
- The question must be SELF-CONTAINED: include enough identifying context (device name, architecture, author/year, distinctive technique) that a knowledge-base agent can locate the right paper. Never say "this paper" or "the authors" without identification.
- Prefer long-tail specifics (exact reported numbers, device-specific design choices, named failure modes) over textbook facts that any physicist knows without reading the paper.
- "evidence_quote" must be an EXACT VERBATIM substring of the document text (30-300 chars). Do not paraphrase, do not fix typos, do not merge separated sentences.
- "gold_answer" must be fully determined by the evidence quote (plus the question), with units and uncertainties when reported.
- Output STRICT JSON only, no commentary.`;

function singleSourcePrompt(source, parseText, roles) {
  const wantFactual = roles.includes("factual");
  const wantPointer = roles.includes("pointer");
  const wantAbstention = roles.includes("abstention");
  const parts = [];
  if (wantFactual) {
    parts.push(`1. One "factual" item: a qualitative but specific question about a finding, design choice, or mechanism in the paper.
2. One "numerical" item: a question whose answer is an exact reported value (fidelity, coherence time, frequency, coupling strength, gate duration...). The number must appear in the evidence quote.`);
  }
  if (wantPointer) {
    parts.push(`One "pointer" item: a question of the form "Which source in the knowledge base reports/demonstrates <distinctive finding>? Answer with its sourceKey." where the finding is distinctive enough that exactly this paper matches. gold_answer must be exactly "${source.sourceKey}".`);
  }
  if (wantAbstention) {
    parts.push(`One "abstention" item: a question in the same style about THIS paper (identify it the same way), asking for a specific metric, device variant, or result that the paper does NOT report. It must sound plausible. Set gold_answer to "NOT_IN_KB", omit evidence_quote, and add "absence_claim": one sentence stating precisely what information is absent from the paper.`);
  }
  return `You are constructing a retrieval-grounded QA benchmark for a knowledge base about superconducting quantum design.

Document sourceKey: ${source.sourceKey}
Document title: ${source.title}

Create the following items:
${parts.join("\n")}
${COMMON_RULES}

Output schema:
{"items": [{"category": "factual|numerical|pointer|abstention", "question": "...", "gold_answer": "...", "evidence_quote": "...", "absence_claim": "...", "difficulty": "easy|medium|hard"}]}

DOCUMENT TEXT:
${parseText}`;
}

function multiHopPrompt(sourceA, sourceB, parseA, parseB) {
  return `You are constructing a retrieval-grounded QA benchmark for a knowledge base about superconducting quantum design.

Create ONE "multihop" item that REQUIRES information from BOTH documents below to answer (a comparison, a combination, or a contrast). A reader of only one document must be unable to answer it. Identify both works in the question (device/architecture names, authors/years).
${COMMON_RULES}
- Provide one evidence quote PER document.

Output schema:
{"items": [{"category": "multihop", "question": "...", "gold_answer": "...", "evidence": [{"sourceKey": "${sourceA.sourceKey}", "quote": "..."}, {"sourceKey": "${sourceB.sourceKey}", "quote": "..."}], "difficulty": "medium|hard"}]}

DOCUMENT 1 (sourceKey ${sourceA.sourceKey}, title: ${sourceA.title}):
${parseA}

DOCUMENT 2 (sourceKey ${sourceB.sourceKey}, title: ${sourceB.title}):
${parseB}`;
}

function synthesisPrompt(tag, members, summaries) {
  const summaryBlocks = members
    .map((member, index) => `SOURCE ${index + 1} (sourceKey ${member.sourceKey}, title: ${member.title}):\n${summaries[index]}`)
    .join("\n\n");
  return `You are constructing a synthesis benchmark for a knowledge base about superconducting quantum design.

Topic tag: "${tag}". The sources below all address this topic.

Create ONE open-ended "synthesis" item: a question asking to survey/synthesize what the knowledge base says about this topic (approaches, trade-offs, failure modes, reported results). Then write a grading rubric of 4-6 bullet points, each a distinct claim that a good answer should cover, each grounded in one of the sources (name the sourceKey in the rubric point).

Output STRICT JSON only:
{"items": [{"category": "synthesis", "question": "...", "rubric": [{"point": "...", "sourceKey": "..."}], "difficulty": "hard"}]}

${summaryBlocks}`;
}

function buildTasks(sources) {
  const tasks = [];
  sources.forEach((source, index) => {
    const roles = [];
    if (index % 2 === 0) roles.push("factual");
    if (index % 4 === 1) roles.push("pointer");
    if (index % 4 === 3) roles.push("abstention");
    if (roles.length > 0) {
      tasks.push({ taskId: `single:${source.sourceKey}`, kind: "single", source, roles });
    }
  });

  const byKey = new Map(sources.map((source) => [source.sourceKey, source]));
  const pairKeys = new Set();
  for (const source of sources) {
    for (const related of source.relatedSourceKeys) {
      if (!byKey.has(related) || related === source.sourceKey) continue;
      const pair = [source.sourceKey, related].sort().join("|");
      pairKeys.add(pair);
    }
  }
  const sortedPairs = [...pairKeys].sort();
  const stride = Math.max(1, Math.floor(sortedPairs.length / 25));
  const chosenPairs = sortedPairs.filter((_, index) => index % stride === 0).slice(0, 25);
  for (const pair of chosenPairs) {
    const [keyA, keyB] = pair.split("|");
    tasks.push({ taskId: `pair:${pair}`, kind: "pair", sourceA: byKey.get(keyA), sourceB: byKey.get(keyB) });
  }

  const tagMap = new Map();
  for (const source of sources) {
    for (const tag of source.tags) {
      const normalized = tag.toLowerCase().trim();
      if (!tagMap.has(normalized)) tagMap.set(normalized, []);
      tagMap.get(normalized).push(source);
    }
  }
  const clusterTags = [...tagMap.entries()]
    .filter(([, members]) => members.length >= 3 && members.length <= 8)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, 8);
  for (const [tag, members] of clusterTags) {
    tasks.push({ taskId: `synthesis:${tag}`, kind: "synthesis", tag, members });
  }

  return tasks;
}

async function runTask(task, model) {
  if (task.kind === "single") {
    const parseText = await readTextCapped(task.source.parsePath, PARSE_CHAR_CAP);
    const { text } = await callLlm(model, {
      user: singleSourcePrompt(task.source, parseText, task.roles),
      maxTokens: 3000
    });
    const parsed = extractJson(text);
    return (parsed.items ?? []).map((item) => ({
      ...item,
      gold_sources: item.category === "abstention" ? [] : [task.source.sourceKey],
      anchor_source: task.source.sourceKey
    }));
  }
  if (task.kind === "pair") {
    const [parseA, parseB] = await Promise.all([
      readTextCapped(task.sourceA.parsePath, PAIR_PARSE_CHAR_CAP),
      readTextCapped(task.sourceB.parsePath, PAIR_PARSE_CHAR_CAP)
    ]);
    const { text } = await callLlm(model, {
      user: multiHopPrompt(task.sourceA, task.sourceB, parseA, parseB),
      maxTokens: 3000
    });
    const parsed = extractJson(text);
    return (parsed.items ?? []).map((item) => ({
      ...item,
      gold_sources: [task.sourceA.sourceKey, task.sourceB.sourceKey]
    }));
  }
  const summaries = await Promise.all(
    task.members.map((member) => (member.summaryPath ? readTextCapped(member.summaryPath, 6000) : ""))
  );
  const { text } = await callLlm(model, {
    user: synthesisPrompt(task.tag, task.members, summaries),
    maxTokens: 3000
  });
  const parsed = extractJson(text);
  return (parsed.items ?? []).map((item) => ({
    ...item,
    gold_sources: task.members.map((member) => member.sourceKey),
    tag: task.tag
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    out: path.join(BENCHMARK_DIR, "candidates.jsonl"),
    concurrency: "4"
  });
  const model = resolveBenchToolModel();
  console.log(`generator model: ${model.provider}/${model.id} (baseUrl: ${model.baseUrl ?? "default"})`);

  const sources = await listSources();
  console.log(`sources ready: ${sources.length}`);
  let tasks = buildTasks(sources);
  const existing = await readJsonl(args.out);
  const doneTaskIds = new Set(existing.map((record) => record.taskId));
  tasks = tasks.filter((task) => !doneTaskIds.has(task.taskId));
  if (args["max-tasks"]) {
    tasks = tasks.slice(0, Number(args["max-tasks"]));
  }
  console.log(`tasks to run: ${tasks.length} (already done: ${doneTaskIds.size})`);

  const limit = pLimit(Number(args.concurrency));
  let completed = 0;
  let failed = 0;
  await Promise.all(
    tasks.map((task) =>
      limit(async () => {
        try {
          const items = await runTask(task, model);
          await appendJsonl(args.out, { taskId: task.taskId, items });
          completed += 1;
          console.log(`[${completed + failed}/${tasks.length}] ok ${task.taskId} (+${items.length} items)`);
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[${completed + failed}/${tasks.length}] FAIL ${task.taskId}: ${message}`);
        }
      })
    )
  );

  const all = await readJsonl(args.out);
  const totalItems = all.reduce((sum, record) => sum + (record.items?.length ?? 0), 0);
  console.log(`done. tasks ok=${completed} failed=${failed}; candidate items on disk: ${totalItems}`);
  console.log(`next: node benchmark/verify.mjs --in ${args.out}`);
}

await main();
