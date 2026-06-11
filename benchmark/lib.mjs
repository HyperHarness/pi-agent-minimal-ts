// Shared helpers for the knowledge-base benchmark pipeline.
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

export async function callLlm(model, { system, user, maxTokens = 4096, attempts = 4 }) {
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await complete(
        model,
        {
          ...(system ? { systemPrompt: system } : {}),
          messages: [{ role: "user", content: user, timestamp: Date.now() }]
        },
        { apiKey: getEnvApiKey(model.provider), maxTokens }
      );
    } catch (error) {
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
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
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

// Verbatim-quote check tolerant to whitespace/markdown line-wrapping differences.
export function findQuote(quote, documentText) {
  const normalizedDoc = normalizeWhitespace(documentText).toLowerCase();
  const normalizedQuote = normalizeWhitespace(quote).toLowerCase();
  if (normalizedQuote.length < 10) {
    return { found: false, index: -1 };
  }
  const index = normalizedDoc.indexOf(normalizedQuote);
  return { found: index !== -1, index, normalizedDoc };
}

// Returns a window of document text around the quote for verification prompts.
export function quoteWindow(quote, documentText, radius = 2500) {
  const { found, index, normalizedDoc } = findQuote(quote, documentText);
  if (!found) {
    return undefined;
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(normalizedDoc.length, index + normalizeWhitespace(quote).length + radius);
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
