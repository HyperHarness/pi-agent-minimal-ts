// Shared helpers for the knowledge-base benchmark pipeline.
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { complete, getEnvApiKey, getModels, getProviders } from "@mariozechner/pi-ai";
import { applyModelBaseUrlOverride, resolveInitialModel } from "../dist/src/index.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const KB_SOURCES_DIR = path.join(REPO_ROOT, "knowledge-base", "sources");
export const BENCHMARK_DIR = path.join(REPO_ROOT, "benchmark");

function collectAvailableModels() {
  const models = [];
  for (const provider of getProviders()) {
    models.push(...getModels(provider));
  }
  return models;
}

// Resolves the model for benchmark tooling (generator/verifier/judge).
// BENCH_PROVIDER/BENCH_MODEL/BENCH_BASE_URL override PI_PROVIDER/PI_MODEL/PI_BASE_URL
// so the judge can differ from the agent under test.
export function resolveBenchToolModel() {
  const selection = resolveInitialModel({
    envProvider: process.env.BENCH_PROVIDER ?? process.env.PI_PROVIDER,
    envModel: process.env.BENCH_MODEL ?? process.env.PI_MODEL,
    availableModels: collectAvailableModels(),
    hasConfiguredAuth: (provider) => getEnvApiKey(provider) !== undefined
  });
  return applyModelBaseUrlOverride(selection.model, {
    envBaseUrl: process.env.BENCH_BASE_URL ?? process.env.PI_BASE_URL
  });
}

// Resolves the agent-under-test model exactly the way the CLI does (PI_* only).
export function resolveAgentModel() {
  const selection = resolveInitialModel({
    envProvider: process.env.PI_PROVIDER,
    envModel: process.env.PI_MODEL,
    availableModels: collectAvailableModels(),
    hasConfiguredAuth: (provider) => getEnvApiKey(provider) !== undefined
  });
  return applyModelBaseUrlOverride(selection.model, {
    envBaseUrl: process.env.PI_BASE_URL
  });
}

export function assistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

export function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === "assistant") {
      return assistantText(message);
    }
  }
  return "";
}

export function sumUsage(messages) {
  const total = { input: 0, output: 0, totalTokens: 0, cost: 0 };
  for (const message of messages) {
    if (message?.role === "assistant" && message.usage) {
      total.input += message.usage.input ?? 0;
      total.output += message.usage.output ?? 0;
      total.totalTokens += message.usage.totalTokens ?? 0;
      total.cost += message.usage.cost?.total ?? 0;
    }
  }
  return total;
}

const TRANSIENT_PATTERNS = [/overloaded/i, /try again/i, /temporarily/i, /\b429\b/, /\b5\d\d\b/, /timeout/i, /ECONNRESET/i, /fetch failed/i];

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return Object.assign(new Error("LLM call aborted"), { name: "AbortError" });
}

function sleepWithSignal(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// `signal` is optional: when supplied, the request and the retry backoff are
// cancelled as soon as the benchmark item times out instead of running on.
export async function callLlm(model, { system, user, maxTokens = 4096, attempts = 4, signal }) {
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) {
      throw abortError(signal);
    }
    let response;
    try {
      // Await the actual request settlement. A raced abort promise would let the
      // benchmark advance while a provider that ignored cancellation was still live.
      response = await complete(
        model,
        {
          ...(system ? { systemPrompt: system } : {}),
          messages: [{ role: "user", content: user, timestamp: Date.now() }]
        },
        { apiKey: getEnvApiKey(model.provider), maxTokens, ...(signal ? { signal } : {}) }
      );
      if (signal?.aborted) throw abortError(signal);
    } catch (error) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      lastError = error instanceof Error ? error.message : String(error);
      response = undefined;
    }
    if (response && response.stopReason !== "error") {
      return { text: assistantText(response), usage: response.usage };
    }
    lastError = response?.errorMessage ?? lastError ?? "unknown error";
    if (!TRANSIENT_PATTERNS.some((pattern) => pattern.test(lastError)) && response) {
      break;
    }
    await sleepWithSignal(2000 * (attempt + 1), signal);
  }
  throw new Error(`LLM call failed: ${lastError}`);
}

// Extracts the first JSON object/array from LLM output (handles code fences and prose).
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) {
    candidates.push(fenced[1]);
  }
  candidates.push(text);
  for (const candidate of candidates) {
    const start = candidate.search(/[{[]/);
    if (start === -1) continue;
    const open = candidate[start];
    const close = open === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  throw new Error(`No parseable JSON in LLM output: ${text.slice(0, 300)}`);
}

export async function listSources() {
  const entries = await readdir(KB_SOURCES_DIR, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(KB_SOURCES_DIR, entry.name, "metadata.json");
    if (!existsSync(metadataPath)) continue;
    let metadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch {
      continue;
    }
    if (metadata.status !== "ready") continue;
    const parseArtifact = (metadata.artifacts ?? []).find((artifact) => artifact.kind === "parse" && artifact.markdownPath);
    if (!parseArtifact) continue;
    sources.push({
      sourceKey: metadata.sourceKey ?? entry.name,
      title: metadata.title ?? entry.name,
      tags: metadata.tags ?? [],
      relatedSourceKeys: metadata.relatedSourceKeys ?? [],
      citation: metadata.citation ?? {},
      parsePath: path.join(REPO_ROOT, parseArtifact.markdownPath),
      summaryPath: metadata.summaryPath ? path.join(REPO_ROOT, metadata.summaryPath) : undefined
    });
  }
  sources.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  return sources;
}

export async function readTextCapped(filePath, maxChars) {
  const text = await readFile(filePath, "utf8");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[...document truncated at ${maxChars} of ${text.length} chars...]`;
}

export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Maps an offset into `lowered` (the whole-string lowercase of `text`) back to an
// offset into `text`. Case folding can expand one code unit into several (e.g.
// "İ" -> "i̇"), so lowered offsets drift past every expansion; apart from those
// expansions, per-unit lowercase lengths equal the whole-string ones, so walking
// unit by unit recovers the original offset exactly.
function originalOffset(text, lowered, loweredOffset, end = false) {
  if (text.length === lowered.length) {
    return loweredOffset; // no expansion anywhere: offsets coincide
  }
  let loweredPos = 0;
  for (let originalPos = 0; originalPos < text.length; originalPos += 1) {
    const nextLoweredPos = loweredPos + text[originalPos].toLowerCase().length;
    if (loweredOffset < nextLoweredPos) {
      return originalPos + (end && loweredOffset > loweredPos ? 1 : 0);
    }
    loweredPos = nextLoweredPos;
  }
  return text.length;
}

// Verbatim-quote check tolerant to whitespace/markdown line-wrapping and case
// differences. Matching is case-insensitive, but `normalizedDoc` keeps the
// document's original casing and `index`/`length` address it, so callers can
// show verbatim evidence text.
export function findQuote(quote, documentText) {
  const normalizedDoc = normalizeWhitespace(documentText);
  const loweredDoc = normalizedDoc.toLowerCase();
  const normalizedQuote = normalizeWhitespace(quote).toLowerCase();
  if (normalizedQuote.length < 10) {
    return { found: false, index: -1, length: 0, normalizedDoc };
  }
  const loweredIndex = loweredDoc.indexOf(normalizedQuote);
  if (loweredIndex === -1) {
    return { found: false, index: -1, length: 0, normalizedDoc };
  }
  const index = originalOffset(normalizedDoc, loweredDoc, loweredIndex);
  const end = originalOffset(normalizedDoc, loweredDoc, loweredIndex + normalizedQuote.length, true);
  return { found: true, index, length: end - index, normalizedDoc };
}

// Returns a window of document text around the quote for verification prompts.
// The window preserves the document's original casing, so unit-sensitive checks
// (MHz vs mHz, mK vs MK) see the evidence as written.
export function quoteWindow(quote, documentText, radius = 2500) {
  const { found, index, length, normalizedDoc } = findQuote(quote, documentText);
  if (!found) {
    return undefined;
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(normalizedDoc.length, index + length + radius);
  return normalizedDoc.slice(start, end);
}

export async function readJsonl(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }
  const text = await readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export async function appendJsonl(filePath, record) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export async function writeJsonl(filePath, records) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Stable content-derived benchmark item id. Positional ids (sq-001, ...) were
// reassigned on every verify run, so a re-freeze that accepted a different
// subset silently re-bound existing results files to different questions.
export function benchmarkItemId(item) {
  return `sq-${contentDigest([item.category, item.question]).slice(0, 24)}`;
}

function canonicalContent(value) {
  if (Array.isArray(value)) return value.map(canonicalContent);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalContent(value[key])]));
  }
  return value;
}

function contentDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalContent(value))).digest("hex");
}

// Normalizes the evidence field of a candidate/frozen item (array form or the
// legacy evidence_quote + anchor_source pair).
export function itemEvidence(item) {
  if (Array.isArray(item.evidence)) {
    return item.evidence;
  }
  if (item.evidence_quote && item.anchor_source) {
    return [{ sourceKey: item.anchor_source, quote: item.evidence_quote }];
  }
  return [];
}

// Freezes a verified candidate into its benchmark form. The id is derived from
// the item's own content, never from its position in the accepted list.
export function freezeItem(item) {
  const contentHash = fnv1a(`${item.category}::${item.question}`);
  return {
    id: benchmarkItemId(item),
    category: item.category,
    question: item.question,
    gold_answer: item.gold_answer ?? null,
    gold_sources: item.gold_sources ?? [],
    evidence: itemEvidence(item),
    rubric: item.rubric ?? undefined,
    absence_claim: item.absence_claim ?? undefined,
    answerable: item.category !== "abstention",
    difficulty: item.difficulty ?? "medium",
    split: contentHash % 5 === 0 ? "holdout" : "dev"
  };
}

// Duplicate ids would shadow each other in every id-keyed join, so
// verify.mjs refuses to freeze them instead of papering over with position.
export function duplicateItemIds(items) {
  const counts = new Map();
  for (const item of items) {
    const id = item.id ?? benchmarkItemId(item);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

// Fingerprint of everything an item's answer is graded against. The id pins
// category + question; the fingerprint additionally covers gold answer,
// sources, evidence, rubric, and absence claim, so responses recorded against
// an earlier freeze are rejected even when the question (and id) is unchanged.
export function benchmarkItemFingerprint(item) {
  const gradedContent = {
    id: item.id,
    category: item.category,
    question: item.question,
    answerable: item.answerable ?? item.category !== "abstention",
    gold_answer: item.gold_answer ?? null,
    gold_sources: item.gold_sources ?? [],
    evidence: itemEvidence(item).map((entry) => ({ sourceKey: entry.sourceKey, quote: entry.quote })),
    rubric: item.rubric ?? null,
    absence_claim: item.absence_claim ?? null
  };
  return `sha256:${contentDigest(gradedContent)}`;
}

// Validates that every record in a responses file was produced against exactly
// this benchmark content. Resume (run.mjs) and grading (grade.mjs) join by id,
// so unbindable records must be rejected here — loudly — instead of silently
// skipping new questions or scoring old answers against different items.
// Returns the set of validated record ids (the resume "done" set).
export function assertResponsesCurrent(responses, benchmark, filePath) {
  const duplicates = duplicateItemIds(benchmark);
  if (duplicates.length) throw new Error(`Duplicate benchmark ids: ${duplicates.join(", ")}`);
  const benchmarkById = new Map(benchmark.map((item) => [item.id, item]));
  const problems = [];
  for (const response of responses) {
    const item = benchmarkById.get(response.id);
    if (!item) {
      problems.push(`id ${String(response.id)} is not in the benchmark`);
      continue;
    }
    if (typeof response.fingerprint !== "string" || response.fingerprint !== benchmarkItemFingerprint(item)) {
      problems.push(`id ${String(response.id)} no longer matches its benchmark item (content changed since the run)`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `stale responses in ${filePath} (produced against a different benchmark freeze):\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        `\nmove the file away, or re-run benchmark/run.mjs against the current benchmark before resuming or grading`
    );
  }
  return new Set(responses.map((response) => response.id));
}

// Minimal concurrency limiter for parallel LLM calls.
export function pLimit(limit) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

export function parseArgs(argv, defaults = {}) {
  const args = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const nextToken = argv[i + 1];
    if (nextToken === undefined || nextToken.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = nextToken;
      i += 1;
    }
  }
  return args;
}
