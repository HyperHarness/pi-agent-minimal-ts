import { createInterface } from "node:readline/promises";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  getEnvApiKey,
  getModels,
  getProviders,
  type Api,
  type Model
} from "@mariozechner/pi-ai";
import type { AgentContext, AgentEvent } from "@mariozechner/pi-agent-core";
import { DEFAULT_SYSTEM_PROMPT, DESIGN_AGENT_SYSTEM_PROMPT } from "./agent-prompts.js";
import { configureEnvProxy } from "./env-proxy.js";
import { resolveInitialModel } from "./model-resolver.js";
import {
  cleanupTools,
  createTools,
  createToolsForBoundary,
  getToolBoundaryToolNames,
  type AgentTools
} from "./tools.js";
import { readPaperDownloadJobEvents, summarizePaperDownloadJobs } from "./paper/extension/paper-download-jobs.js";
import { createQueuedPaperExtensionBridge } from "./paper/extension/paper-extension-bridge.js";
import { createWikiEvidenceWorker } from "./wiki/worker.js";
import {
  compactOutputText,
  forgetAgentContextWorkspaceDir,
  getAssistantText,
  isRecord,
  runSessionPrompt,
  type AgentMessageEventHandler,
  type SessionPromptResult,
  type WorkerRoutingPolicy
} from "./agent-runtime.js";

export interface CliArgs {
  provider?: string;
  model?: string;
  baseUrl?: string;
  mode: "chat" | "rpc";
  useSession: boolean;
  sessionDir?: string;
  help: boolean;
}

export interface AgentChatSessionStats {
  workspaceDir: string;
  initialWikiPagePaths: Set<string>;
  downloadedPapers: Set<string>;
  queuedDownloadJobs: Set<string>;
  completedQueuedDownloadJobs: Set<string>;
  createdWikiPages: Set<string>;
  modifiedWikiPages: Set<string>;
}

export type AgentEntrypointProfile = "wiki-agent" | "design-agent" | "routed-agent";

export interface ResolvedAgentEntrypointProfile {
  systemPrompt: string;
  workerRouting: WorkerRoutingPolicy;
  createTools: () => AgentTools;
  toolNames: string[];
}

const ROUTED_AGENT_TOOL_NAMES = [
  "list_files",
  "read_file",
  "write_file",
  "replace_file_text",
  "delete_file",
  "compile_latex",
  "web_search",
  "fetch_url",
  "search_papers",
  "download_paper",
  "block_paper_download",
  "inspect_paper",
  "read_paper_section",
  "search_paper_text",
  "answer_paper_wiki_question",
  "answer_research_question",
  "bootstrap_wiki_page_evidence",
  "build_wiki_page",
  "merge_wiki_aliases",
  "clarify_research_topic",
  "research_topic_bootstrap",
  "expand_research_topic",
  "wiki_review_page",
  "search_local_papers",
  "wiki_health",
  "wiki_lint",
  "wiki_structure_plan",
  "wiki_apply_structure_plan",
  "wiki_health_fix"
] as const;

function collectAvailableModels(): Model<Api>[] {
  const models: Model<Api>[] = [];

  for (const provider of getProviders()) {
    models.push(...(getModels(provider) as Model<Api>[]));
  }

  return models;
}

function createRoutedAgentTools(workspaceDir: string, model: Model<Api>): AgentTools {
  const wikiEvidenceWorker = createWikiEvidenceWorker(model, workspaceDir);
  return createTools(workspaceDir, {
    extensionBridge: createQueuedPaperExtensionBridge({ workspaceDir }),
    paperSummaryWorker: wikiEvidenceWorker.paperSummaryWorker,
    paperWikiPageWorker: wikiEvidenceWorker.paperWikiPageWorker
  });
}

function createWikiAgentTools(workspaceDir: string, model: Model<Api>): AgentTools {
  const wikiEvidenceWorker = createWikiEvidenceWorker(model, workspaceDir);
  return createToolsForBoundary(workspaceDir, "wiki-agent", {
    extensionBridge: createQueuedPaperExtensionBridge({ workspaceDir }),
    paperSummaryWorker: wikiEvidenceWorker.paperSummaryWorker,
    paperWikiPageWorker: wikiEvidenceWorker.paperWikiPageWorker
  });
}

export function resolveAgentEntrypointProfile(
  profile: AgentEntrypointProfile,
  workspaceDir: string,
  model: Model<Api>
): ResolvedAgentEntrypointProfile {
  if (profile === "wiki-agent") {
    return {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      workerRouting: "wiki-paper",
      createTools: () => createWikiAgentTools(workspaceDir, model),
      toolNames: getToolBoundaryToolNames("wiki-agent")
    };
  }

  if (profile === "design-agent") {
    return {
      systemPrompt: DESIGN_AGENT_SYSTEM_PROMPT,
      workerRouting: "none",
      createTools: () => createToolsForBoundary(workspaceDir, "design-agent"),
      toolNames: getToolBoundaryToolNames("design-agent")
    };
  }

  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    workerRouting: "all",
    createTools: () => createRoutedAgentTools(workspaceDir, model),
    toolNames: [...ROUTED_AGENT_TOOL_NAMES]
  };
}

function formatToolFieldValue(value: unknown, maxLength = 180): string | null {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return compactOutputText(value, maxLength);
}

function formatToolFields(record: Record<string, unknown> | undefined, fields: readonly string[]): string {
  if (!record) {
    return "";
  }

  const entries = fields.flatMap((field) => {
    const value = formatToolFieldValue(record[field]);
    return value ? [`${field}=${value}`] : [];
  });

  return entries.length > 0 ? ` ${entries.join(" ")}` : "";
}

function formatToolStartSummary(event: Extract<AgentEvent, { type: "tool_execution_start" }>): string {
  const args = isRecord(event.args) ? event.args : undefined;
  if (
    event.toolName === "read_file" ||
    event.toolName === "write_file" ||
    event.toolName === "replace_file_text" ||
    event.toolName === "delete_file" ||
    event.toolName === "list_files"
  ) {
    return formatToolFields(args, ["path"]);
  }

  if (event.toolName === "compile_latex") {
    return formatToolFields(args, ["texPath"]);
  }

  return "";
}

function formatSearchToolDetails(details: unknown): string | null {
  if (!isRecord(details)) {
    return null;
  }

  const query = compactOutputText(details.query, 240);
  const count = typeof details.count === "number" ? details.count : undefined;
  const results = Array.isArray(details.results) ? details.results.filter(isRecord) : [];
  if (!query && count === undefined && results.length === 0) {
    return null;
  }

  const lines: string[] = [];
  if (query) {
    lines.push(`[tool:search] query: ${query}`);
  }
  if (count !== undefined) {
    const shown = results.length;
    lines.push(`[tool:search] results: ${count}${shown > 0 && shown < count ? `, showing ${shown}` : ""}`);
  }

  results.forEach((result, index) => {
    const title = compactOutputText(result.title, 140) ?? "(untitled)";
    const url = compactOutputText(result.url, 240);
    const summary = compactOutputText(result.summary, 220);
    const source = compactOutputText(result.source, 40);
    const action = compactOutputText(result.action, 60);
    const canonicalId = compactOutputText(result.canonicalId, 120);
    const metadata = [source, action, canonicalId].filter(Boolean).join(" | ");

    lines.push(`  ${index + 1}. ${title}${metadata ? ` [${metadata}]` : ""}`);
    if (url) {
      lines.push(`     url: ${url}`);
    }
    if (summary) {
      lines.push(`     summary: ${summary}`);
    }
  });

  return lines.length > 0 ? `${lines.join("\n")}\n` : null;
}

function formatToolExecutionDetails(event: Extract<AgentEvent, { type: "tool_execution_end" }>): string | null {
  if (event.isError || (event.toolName !== "web_search" && event.toolName !== "search_papers")) {
    return null;
  }

  return formatSearchToolDetails(event.result.details);
}

function formatToolProgressDetails(event: Extract<AgentEvent, { type: "tool_execution_update" }>): string | null {
  const partialResult = event.partialResult;
  if (!isRecord(partialResult)) {
    return null;
  }

  const details = partialResult.details;
  const progress = isRecord(details) ? details.progress : undefined;
  const progressMessage = isRecord(progress) ? compactOutputText(progress.message, 260) : null;
  if (progressMessage) {
    return `[tool:progress] ${event.toolName} ${progressMessage}\n`;
  }

  const content = partialResult.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .filter(isRecord)
    .find((item) => item.type === "text" && typeof item.text === "string")?.text;
  const message = compactOutputText(text, 260);
  return message ? `[tool:progress] ${event.toolName} ${message}\n` : null;
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmedBaseUrl = baseUrl?.trim();
  return trimmedBaseUrl ? trimmedBaseUrl : undefined;
}

function normalizeWorkspaceDir(workspaceDir: string): string {
  return path.resolve(workspaceDir);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function readInitialWikiPagePaths(workspaceDir: string): Promise<Set<string>> {
  const pagesDir = path.join(workspaceDir, "knowledge-base", "pages");

  try {
    const entries = await readdir(pagesDir, { withFileTypes: true });
    return new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => normalizeRelativePath(path.join("knowledge-base", "pages", entry.name)))
    );
  } catch {
    return new Set();
  }
}

export async function createAgentChatSessionStats(workspaceDir: string): Promise<AgentChatSessionStats> {
  const resolvedWorkspaceDir = normalizeWorkspaceDir(workspaceDir);
  return {
    workspaceDir: resolvedWorkspaceDir,
    initialWikiPagePaths: await readInitialWikiPagePaths(resolvedWorkspaceDir),
    downloadedPapers: new Set(),
    queuedDownloadJobs: new Set(),
    completedQueuedDownloadJobs: new Set(),
    createdWikiPages: new Set(),
    modifiedWikiPages: new Set()
  };
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getPaperIdentity(record: Record<string, unknown>): string | undefined {
  return (
    getStringField(record, "paperKey") ??
    getStringField(record, "canonicalId") ??
    getStringField(record, "articleUrl") ??
    getStringField(record, "recordPath") ??
    getStringField(record, "path") ??
    getStringField(record, "title")
  );
}

function recordPaperDownloadStats(stats: AgentChatSessionStats, details: unknown): void {
  if (!isRecord(details)) {
    return;
  }

  const status = getStringField(details, "status");
  const jobId = getStringField(details, "jobId");
  if (status === "downloaded") {
    const identity = getPaperIdentity(details);
    if (identity) {
      stats.downloadedPapers.add(identity);
    }
    if (jobId) {
      stats.completedQueuedDownloadJobs.add(jobId);
    }
  } else if (status === "extension_job_queued") {
    if (jobId) {
      stats.queuedDownloadJobs.add(jobId);
    }
  }

  const downloaded = details.downloaded;
  if (Array.isArray(downloaded)) {
    for (const item of downloaded) {
      recordPaperDownloadStats(stats, item);
    }
  }
}

function recordWikiPageStats(stats: AgentChatSessionStats, details: unknown): void {
  if (!isRecord(details)) {
    return;
  }

  const page = isRecord(details.page) ? details.page : undefined;
  const pagePath = page ? getStringField(page, "pagePath") : undefined;
  if (!pagePath) {
    return;
  }

  const normalizedPagePath = normalizeRelativePath(pagePath);
  if (stats.initialWikiPagePaths.has(normalizedPagePath)) {
    stats.modifiedWikiPages.add(normalizedPagePath);
    return;
  }

  stats.createdWikiPages.add(normalizedPagePath);
}

export function recordAgentChatSessionStats(stats: AgentChatSessionStats, event: AgentEvent): void {
  if (event.type !== "tool_execution_end" || event.isError) {
    return;
  }

  if (
    event.toolName === "download_paper" ||
    event.toolName === "answer_research_question"
  ) {
    recordPaperDownloadStats(stats, event.result.details);
  }

  if (event.toolName === "build_wiki_page") {
    recordWikiPageStats(stats, event.result.details);
  }
}

export function getPendingDownloadQueueCount(stats: AgentChatSessionStats): number {
  let pending = 0;
  for (const jobId of stats.queuedDownloadJobs) {
    if (!stats.completedQueuedDownloadJobs.has(jobId)) {
      pending += 1;
    }
  }
  return pending;
}

export async function refreshAgentChatSessionDownloadQueue(stats: AgentChatSessionStats): Promise<void> {
  if (stats.queuedDownloadJobs.size === 0) {
    return;
  }

  const summaries = summarizePaperDownloadJobs(
    await readPaperDownloadJobEvents({ workspaceDir: stats.workspaceDir })
  );
  for (const summary of summaries) {
    if (!stats.queuedDownloadJobs.has(summary.jobId) || summary.status !== "downloaded") {
      continue;
    }

    stats.completedQueuedDownloadJobs.add(summary.jobId);
    const identity = summary.paperKey ?? summary.articleUrl ?? summary.recordPath ?? summary.downloadPath;
    if (identity) {
      stats.downloadedPapers.add(identity);
    }
  }
}

export function formatAgentChatSessionStats(stats: AgentChatSessionStats): string {
  return [
    "session> stats",
    `- 本次聊天下载论文: ${stats.downloadedPapers.size}`,
    `- 下载队列未完成: ${getPendingDownloadQueueCount(stats)}`,
    `- 新建 wiki page: ${stats.createdWikiPages.size}`,
    `- 改动 wiki page: ${stats.modifiedWikiPages.size}`
  ].join("\n") + "\n";
}

export function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { mode: "chat", useSession: true, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--no-session") {
      parsed.useSession = false;
      continue;
    }

    if (arg === "--provider" || arg === "--model" || arg === "--base-url" || arg === "--mode" || arg === "--session-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }

      if (arg === "--provider") {
        parsed.provider = value;
      } else if (arg === "--model") {
        parsed.model = value;
      } else if (arg === "--base-url") {
        parsed.baseUrl = normalizeBaseUrl(value);
      } else if (arg === "--mode") {
        if (value !== "chat" && value !== "rpc") {
          throw new Error(`Unsupported mode: ${value}`);
        }
        parsed.mode = value;
      } else {
        parsed.sessionDir = value;
      }

      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function writeRpcEvent(output: NodeJS.WriteStream, event: Record<string, unknown>): void {
  output.write(`${JSON.stringify(event)}\n`);
}

function extractRpcPromptMessage(command: unknown): string | undefined {
  if (!isRecord(command)) {
    return undefined;
  }

  const message = command.message;
  return typeof message === "string" ? message : undefined;
}

async function runRpcMode(options: {
  model: Model<Api>;
  workspaceDir: string;
  entrypointProfile: ResolvedAgentEntrypointProfile;
  sessionDir?: string;
  useSession: boolean;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}): Promise<void> {
  if (options.useSession && options.sessionDir) {
    await mkdir(options.sessionDir, { recursive: true });
  }

  const repl = createInterface({
    input: options.input
  });
  let context: AgentContext | undefined;

  try {
    const tools = options.entrypointProfile.createTools();
    context = {
      systemPrompt: options.entrypointProfile.systemPrompt,
      messages: [],
      tools
    };

    for await (const line of repl) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }

      let command: unknown;
      try {
        command = JSON.parse(trimmedLine);
      } catch (error) {
        writeRpcEvent(options.output, {
          type: "error",
          errorMessage: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      if (!isRecord(command)) {
        writeRpcEvent(options.output, {
          type: "error",
          errorMessage: "RPC command must be a JSON object."
        });
        continue;
      }

      const id = typeof command.id === "string" ? command.id : undefined;
      if (command.type !== "prompt") {
        writeRpcEvent(options.output, {
          type: "response",
          ...(id ? { id } : {}),
          success: false,
          error: `Unsupported RPC command: ${String(command.type)}`
        });
        continue;
      }

      const message = extractRpcPromptMessage(command);
      if (message === undefined) {
        writeRpcEvent(options.output, {
          type: "response",
          ...(id ? { id } : {}),
          success: false,
          error: "RPC prompt command requires a string message."
        });
        continue;
      }

      writeRpcEvent(options.output, {
        type: "response",
        ...(id ? { id } : {}),
        success: true
      });

      try {
        const result = await runSessionPrompt({
          model: options.model,
          workspaceDir: options.workspaceDir,
          context,
          prompt: message,
          workerRouting: options.entrypointProfile.workerRouting,
          onEvent: (event) => {
            if (event.type === "message_update") {
              writeRpcEvent(options.output, {
                type: "message_update",
                assistantMessageEvent: event.assistantMessageEvent
              });
              return;
            }

            if (event.type === "tool_execution_start") {
              writeRpcEvent(options.output, {
                type: "tool_execution_start",
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                args: event.args
              });
              return;
            }

            if (event.type === "tool_execution_update") {
              writeRpcEvent(options.output, {
                type: "tool_execution_update",
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                partialResult: event.partialResult
              });
              return;
            }

            if (event.type === "tool_execution_end") {
              writeRpcEvent(options.output, {
                type: "tool_execution_end",
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                isError: event.isError,
                result: event.result
              });
            }
          }
        });

        writeRpcEvent(options.output, {
          type: "agent_end",
          action: result.action
        });

        if (result.action === "stop") {
          break;
        }
      } catch (error) {
        writeRpcEvent(options.output, {
          type: "error",
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } finally {
    repl.close();
    await cleanupTools(context?.tools);
    if (context) {
      forgetAgentContextWorkspaceDir(context);
    }
  }
}

export function applyModelBaseUrlOverride<TApi extends Api>(
  model: Model<TApi>,
  overrides: { cliBaseUrl?: string; envBaseUrl?: string }
): Model<TApi> {
  const baseUrl =
    normalizeBaseUrl(overrides.cliBaseUrl) ?? normalizeBaseUrl(overrides.envBaseUrl);

  if (!baseUrl || baseUrl === model.baseUrl) {
    return model;
  }

  return {
    ...model,
    baseUrl
  };
}

export function createReplEventHandler(output: NodeJS.WriteStream): AgentMessageEventHandler {
  let isStreamingAssistantText = false;
  let streamedAssistantText = false;

  return (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (!isStreamingAssistantText) {
        output.write("assistant> ");
        isStreamingAssistantText = true;
      }

      streamedAssistantText = true;
      output.write(event.assistantMessageEvent.delta);
      return;
    }

    if (event.type === "tool_execution_start") {
      if (isStreamingAssistantText) {
        output.write("\n");
        isStreamingAssistantText = false;
      }

      output.write(`[tool:start] ${event.toolName}${formatToolStartSummary(event)}\n`);
      return;
    }

    if (event.type === "tool_execution_end") {
      output.write(`[tool:end] ${event.toolName} ${event.isError ? "error" : "ok"}\n`);
      const detailsOutput = formatToolExecutionDetails(event);
      if (detailsOutput) {
        output.write(detailsOutput);
      }
      return;
    }

    if (event.type === "tool_execution_update") {
      const detailsOutput = formatToolProgressDetails(event);
      if (detailsOutput) {
        output.write(detailsOutput);
      }
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = getAssistantText(event.message);

      if (isStreamingAssistantText) {
        output.write("\n");
        isStreamingAssistantText = false;
      } else if (!streamedAssistantText && text) {
        output.write(`assistant> ${text}\n`);
      }

      if (event.message.errorMessage) {
        output.write(`assistant error> ${event.message.errorMessage}\n`);
      }

      streamedAssistantText = false;
    }
  };
}

export async function readInteractivePrompt(
  repl: {
    question: (prompt: string) => Promise<string>;
  }
): Promise<string | null> {
  try {
    return await repl.question("> ");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (
        ("code" in error && error.code === "ERR_USE_AFTER_CLOSE") ||
        ("name" in error && error.name === "AbortError")
      )
    ) {
      return null;
    }

    throw error;
  }
}

export async function consumePromptLines(options: {
  lines: AsyncIterable<string>;
  onPrompt: (prompt: string) => Promise<{ action: "continue" | "stop" }> | { action: "continue" | "stop" };
}): Promise<void> {
  for await (const line of options.lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const result = await options.onPrompt(trimmedLine);
    if (result.action === "stop") {
      break;
    }
  }
}

export async function main(options: {
  argv?: string[];
  profile?: AgentEntrypointProfile;
} = {}): Promise<void> {
  configureEnvProxy();

  const cli = parseCliArgs(options.argv ?? process.argv.slice(2));
  if (cli.help) {
    const helpEntrypoint = options.profile === "design-agent" ? "design-agent" : "wiki-agent";
    process.stdout.write(
      `Usage: node dist/src/${helpEntrypoint}.js [--mode chat|rpc] [--session-dir <dir>] [--no-session] [--provider <name>] [--model <id>] [--base-url <url>]\n`
    );
    return;
  }

  const selection = resolveInitialModel({
    cliProvider: cli.provider,
    cliModel: cli.model,
    envProvider: process.env.PI_PROVIDER,
    envModel: process.env.PI_MODEL,
    availableModels: collectAvailableModels(),
    hasConfiguredAuth: (provider) => getEnvApiKey(provider) !== undefined
  });
  const runtimeModel = applyModelBaseUrlOverride(selection.model, {
    cliBaseUrl: cli.baseUrl,
    envBaseUrl: process.env.PI_BASE_URL
  });
  const workspaceDir = process.cwd();
  const entrypointProfile = resolveAgentEntrypointProfile(options.profile ?? "wiki-agent", workspaceDir, runtimeModel);

  if (cli.mode === "rpc") {
    await runRpcMode({
      model: runtimeModel,
      workspaceDir,
      entrypointProfile,
      sessionDir: cli.sessionDir,
      useSession: cli.useSession,
      input: process.stdin,
      output: process.stdout
    });
    return;
  }

  const sessionStats = await createAgentChatSessionStats(workspaceDir);
  const replEventHandler = createReplEventHandler(process.stdout);
  const repl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  let context: AgentContext | undefined;

  try {
    const tools = entrypointProfile.createTools();
    context = {
      systemPrompt: entrypointProfile.systemPrompt,
      messages: [],
      tools
    };
    const activeContext = context;
    const handlePrompt = async (prompt: string): Promise<SessionPromptResult> => {
      return runSessionPrompt({
        model: runtimeModel,
        workspaceDir,
        context: activeContext,
        prompt,
        workerRouting: entrypointProfile.workerRouting,
        onEvent: async (event) => {
          recordAgentChatSessionStats(sessionStats, event);
          await replEventHandler(event);
        }
      });
    };

    process.stdout.write(`model> ${selection.provider}/${runtimeModel.id}\n`);

    if (process.stdin.isTTY) {
      while (true) {
        const prompt = await readInteractivePrompt(repl);
        if (prompt === null) {
          break;
        }

        const result = await handlePrompt(prompt);
        if (result.action === "stop") {
          break;
        }
      }
    } else {
      await consumePromptLines({
        lines: repl,
        onPrompt: handlePrompt
      });
    }
  } finally {
    repl.close();
    try {
      await refreshAgentChatSessionDownloadQueue(sessionStats);
      process.stdout.write(formatAgentChatSessionStats(sessionStats));
    } finally {
      await cleanupTools(context?.tools);
      if (context) {
        forgetAgentContextWorkspaceDir(context);
      }
    }
  }
}
