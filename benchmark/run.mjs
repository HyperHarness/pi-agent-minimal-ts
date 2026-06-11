// Stage 3: run the agent under test (or a no-KB baseline) over the frozen benchmark.
//
// Usage:
//   node benchmark/run.mjs --split dev [--benchmark benchmark/benchmark.jsonl]
//        [--out benchmark/results/agent-dev.jsonl] [--limit N] [--timeout-s 600]
//   node benchmark/run.mjs --split dev --baseline   # bare model, no KB access
//
// Agent mode invokes the wiki-agent profile TS function (runAgentTurn) with a FRESH
// conversation context per item, worker routing disabled (questions must not be
// hijacked by the paper-download router), and the repo root as workspace so the
// agent sees knowledge-base/. Tools are created once and shared across items.
//
// Baseline mode sends the same question to the bare model with no tools — items the
// baseline already answers correctly are weak discriminators (pretraining
// contamination); the grader reports the agent-vs-baseline delta.
//
// Resumable: item ids already in the output file are skipped.
import path from "node:path";
import {
  BENCHMARK_DIR,
  REPO_ROOT,
  appendJsonl,
  callLlm,
  lastAssistantText,
  parseArgs,
  readJsonl,
  resolveAgentModel,
  sumUsage
} from "./lib.mjs";
import { cleanupTools, resolveAgentEntrypointProfile, runAgentTurn } from "../dist/src/index.js";

function agentPrompt(question) {
  return `Answer the following question using ONLY the local knowledge base in this workspace (knowledge-base/). Do not use prior knowledge for facts; every claim must be grounded in a knowledge-base source.

Question: ${question}

Requirements:
- Be concise and precise. Report exact numbers with units and uncertainties where the source gives them.
- Cite the supporting knowledge-base sourceKey(s) in square brackets, e.g. [arxiv-2308.09240].
- If the knowledge base does not contain the information needed, reply with exactly: NOT_IN_KB`;
}

const BASELINE_SYSTEM = `You are an expert in superconducting quantum computing and circuit design. Answer concisely and precisely from your own knowledge, with exact numbers, units, and uncertainties when you know them. If you do not know the specific answer, reply with exactly: NOT_IN_KB`;

async function runWithTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    benchmark: path.join(BENCHMARK_DIR, "benchmark.jsonl"),
    split: "dev",
    "timeout-s": "600"
  });
  const baseline = Boolean(args.baseline);
  const mode = baseline ? "baseline" : "agent";
  const out = args.out ?? path.join(BENCHMARK_DIR, "results", `${mode}-${args.split}.jsonl`);

  const model = resolveAgentModel();
  console.log(`mode: ${mode}; model: ${model.provider}/${model.id} (baseUrl: ${model.baseUrl ?? "default"})`);

  let items = await readJsonl(args.benchmark);
  if (args.split !== "all") {
    items = items.filter((item) => item.split === args.split);
  }
  const done = new Set((await readJsonl(out)).map((record) => record.id));
  items = items.filter((item) => !done.has(item.id));
  if (args.limit) {
    items = items.slice(0, Number(args.limit));
  }
  console.log(`items to run: ${items.length} (already done: ${done.size}) -> ${out}`);

  const timeoutMs = Number(args["timeout-s"]) * 1000;
  let tools;
  let profile;
  if (!baseline) {
    profile = resolveAgentEntrypointProfile("wiki-agent", REPO_ROOT, model);
    tools = profile.createTools();
  }

  try {
    for (const [index, item] of items.entries()) {
      const startedAt = Date.now();
      const record = { id: item.id, category: item.category, mode, model: `${model.provider}/${model.id}` };
      try {
        if (baseline) {
          const { text, usage } = await runWithTimeout(
            callLlm(model, { system: BASELINE_SYSTEM, user: item.question, maxTokens: 2000 }),
            timeoutMs
          );
          record.answer = text;
          record.usage = { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: usage.cost?.total ?? 0 };
        } else {
          const context = { systemPrompt: profile.systemPrompt, messages: [], tools };
          const result = await runWithTimeout(
            runAgentTurn({ model, workspaceDir: REPO_ROOT, context, prompt: agentPrompt(item.question), workerRouting: "none" }),
            timeoutMs
          );
          record.answer = lastAssistantText(result.newMessages);
          record.usage = sumUsage(result.newMessages);
          record.toolCalls = result.newMessages.filter((message) => message?.role === "toolResult").length;
        }
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        record.answer = "";
      }
      record.elapsedMs = Date.now() - startedAt;
      await appendJsonl(out, record);
      const status = record.error ? `ERROR ${record.error}` : `${record.elapsedMs} ms`;
      console.log(`[${index + 1}/${items.length}] ${item.id} (${item.category}) ${status}`);
    }
  } finally {
    if (tools) {
      await cleanupTools(tools).catch(() => {});
    }
  }

  console.log(`done -> ${out}`);
  console.log(`next: node benchmark/grade.mjs --responses ${out}`);
}

await main();
