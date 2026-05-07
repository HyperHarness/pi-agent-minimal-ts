import { createInterface } from "node:readline/promises";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  getEnvApiKey,
  getModels,
  getProviders,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolResultMessage,
  type UserMessage
} from "@mariozechner/pi-ai";
import { agentLoop, type AgentContext, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveInitialModel } from "./agent/model-resolver.js";
import { configureEnvProxy } from "./agent/env-proxy.js";
import { createQueuedPaperExtensionBridge } from "./agent/paper-extension-bridge.js";
import type {
  PaperSummaryWorker,
  PaperSummaryWorkerOutput
} from "./agent/paper-summary.js";
import type {
  PaperWikiPageWorker,
  PaperWikiPageWorkerOutput
} from "./agent/paper-wiki/types.js";
import { cleanupTools, createTools, getToolsWorkspaceDir } from "./agent/tools.js";
import { readPaperDownloadJobEvents, summarizePaperDownloadJobs } from "./agent/paper-download-jobs.js";

type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;
type AgentMessageEventHandler = (event: AgentEvent) => Promise<void> | void;

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a research assistant for scientific and technical work. The user is the research lead; you help structure the work, surface choices, gather evidence, and grow the wiki, but you do not silently choose the long-term research agenda for them.",
  "When the user points at a local workspace directory or file, first inspect it with list_files and read_file before saying whether you can read it or asking research-scope clarification. Workspace-absolute paths are acceptable when they are inside the current workspace.",
  "When the user asks you to modify local writing-project files, actually edit workspace files with replace_file_text, write_file, or delete_file after inspecting them; do not respond only with an execution plan. When the user asks for a compiled manuscript PDF, use compile_latex and report the produced PDF path.",
  "For scientific, technical, paper, physics, quantum, method, experiment, or literature-comparison questions, first run answer_research_question so local wiki evidence is checked before any external search or download.",
  "When the user gives a broad research direction without a clear focus, boundary, depth, time window, or desired output, first use clarify_research_topic and ask the user concise steering questions; wait for the user's focus before starting a large research program.",
  "When the user asks to deeply understand, map, exhaustively research, or keep expanding a research direction and the focus is clear enough, enter research-program mode: run research_topic_bootstrap, then expand_research_topic; do not stop merely because local wiki evidence already exists.",
  "When the user asks to organize, build, maintain, or update a durable knowledge framework or topic page, use build_wiki_page; it will bootstrap source-summary evidence when no page exists yet.",
  "When a research answer produces a durable concept, comparison, mechanism, open problem, or literature synthesis that is likely to be useful later, call build_wiki_page before the final answer so the Q&A naturally grows knowledge-base/wiki/pages/; skip this for one-off factual, operational, or troubleshooting questions.",
  "When the user asks to check the structure of the wiki itself, use wiki_lint for page/link/index/concept health and wiki_health for paper download/parse/summary health.",
  "Use answer_paper_wiki_question only for explicitly local-wiki-only questions or quick evidence checks.",
  "When calling paper wiki or research tools, use concise English search terms when that will better match paper titles, abstracts, and source summaries.",
  "Ground claims in the retrieved wiki evidence and cite paper keys or source paths for substantive conclusions.",
  "Treat knowledge-base/wiki/pages/ as the durable knowledge-entry layer and knowledge-base/wiki/sources/ as the citeable evidence layer; index.md should navigate knowledge entries, not enumerate downloaded papers.",
  "If the local wiki has no supporting evidence, say that the current wiki does not contain enough evidence instead of presenting unsupported claims as wiki-grounded."
].join(" ");
const contextWorkspaceDirs = new WeakMap<AgentContext, string>();
const TRANSIENT_MODEL_RETRY_ATTEMPTS = 5;
const MAX_AGENT_TOOL_LOOPS_PER_TURN = 90;
const TRANSIENT_MODEL_RETRY_PATTERNS = [
  /\boverloaded\b/i,
  /try again later/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /\b503\b/i
];

export interface CliArgs {
  provider?: string;
  model?: string;
  baseUrl?: string;
  mode: "chat" | "rpc";
  useSession: boolean;
  sessionDir?: string;
  help: boolean;
}

export interface RunAgentTurnOptions {
  model: Model<Api>;
  workspaceDir: string;
  context: AgentContext;
  prompt: string;
  onEvent?: AgentMessageEventHandler;
}

export interface RunAgentTurnResult {
  newMessages: AgentMessage[];
}

export interface SessionPromptResult {
  action: "stop" | "continue";
  newMessages: AgentMessage[];
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

function isLlmMessage(message: AgentMessage): message is LlmMessage {
  if (typeof message !== "object" || message === null || !("role" in message)) {
    return false;
  }

  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
  );
}

function convertAgentMessagesToLlm(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message) => (isLlmMessage(message) ? [message] : []));
}

function collectAvailableModels(): Model<Api>[] {
  const models: Model<Api>[] = [];

  for (const provider of getProviders()) {
    models.push(...(getModels(provider) as Model<Api>[]));
  }

  return models;
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compactOutputText(value: unknown, maxLength = 180): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const compacted = value.replace(/\s+/g, " ").trim();
  if (!compacted) {
    return null;
  }

  return compacted.length > maxLength
    ? `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`
    : compacted;
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
  const pagesDir = path.join(workspaceDir, "knowledge-base", "wiki", "pages");

  try {
    const entries = await readdir(pagesDir, { withFileTypes: true });
    return new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => normalizeRelativePath(path.join("knowledge-base", "wiki", "pages", entry.name)))
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
  sessionDir?: string;
  useSession: boolean;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}): Promise<void> {
  if (options.useSession && options.sessionDir) {
    await mkdir(options.sessionDir, { recursive: true });
  }

  const context: AgentContext = {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    messages: [],
    tools: []
  };
  const repl = createInterface({
    input: options.input
  });

  try {
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
    await cleanupTools(context.tools);
    contextWorkspaceDirs.delete(context);
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

      output.write(`[tool:start] ${event.toolName}\n`);
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

function isDirectExecution(metaUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && metaUrl === pathToFileURL(entryPath).href;
}

function isFailedTurn(messages: AgentMessage[]): boolean {
  const lastMessage = messages[messages.length - 1];
  return (
    lastMessage !== undefined &&
    lastMessage.role === "assistant" &&
    (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted")
  );
}

function getFailedAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
  const lastMessage = messages[messages.length - 1];
  return lastMessage !== undefined &&
    lastMessage.role === "assistant" &&
    (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted")
    ? lastMessage
    : undefined;
}

function isTransientModelFailure(message: AssistantMessage | undefined): boolean {
  const errorMessage = message?.errorMessage;
  return typeof errorMessage === "string" &&
    TRANSIENT_MODEL_RETRY_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

interface AgentToolLoopLimiter {
  abortController: AbortController;
  exceeded: boolean;
  maxLoops: number;
  seenAssistantMessages: WeakSet<AssistantMessage>;
  toolLoops: number;
}

function createToolLoopLimitErrorMessage(maxLoops: number): string {
  return `Agent tool loop limit exceeded: stopped after ${maxLoops} tool loops in one user turn.`;
}

function createAgentToolLoopLimiter(maxLoops: number): AgentToolLoopLimiter {
  return {
    abortController: new AbortController(),
    exceeded: false,
    maxLoops,
    seenAssistantMessages: new WeakSet(),
    toolLoops: 0
  };
}

function registerAssistantToolLoop(
  limiter: AgentToolLoopLimiter,
  assistantMessage: AssistantMessage
): string | undefined {
  if (limiter.seenAssistantMessages.has(assistantMessage)) {
    return limiter.exceeded
      ? createToolLoopLimitErrorMessage(limiter.maxLoops)
      : undefined;
  }

  limiter.seenAssistantMessages.add(assistantMessage);
  limiter.toolLoops += 1;
  if (limiter.toolLoops <= limiter.maxLoops) {
    return undefined;
  }

  limiter.exceeded = true;
  const reason = createToolLoopLimitErrorMessage(limiter.maxLoops);
  limiter.abortController.abort(reason);
  return reason;
}

function applyToolLoopLimitToMessages(
  messages: AgentMessage[],
  limiter: AgentToolLoopLimiter
): AgentMessage[] {
  if (!limiter.exceeded) {
    return messages;
  }

  const failedAssistant = getFailedAssistantMessage(messages);
  if (!failedAssistant) {
    return messages;
  }

  return [
    ...messages.slice(0, -1),
    {
      ...failedAssistant,
      errorMessage: createToolLoopLimitErrorMessage(limiter.maxLoops)
    }
  ];
}

function applyToolLoopLimitToDelayedEvents(
  events: AgentEvent[],
  limiter: AgentToolLoopLimiter
): AgentEvent[] {
  if (!limiter.exceeded) {
    return events;
  }

  return events.map((event) => {
    if (
      event.type !== "message_end" ||
      event.message.role !== "assistant" ||
      (event.message.stopReason !== "error" && event.message.stopReason !== "aborted")
    ) {
      return event;
    }

    return {
      ...event,
      message: {
        ...event.message,
        errorMessage: createToolLoopLimitErrorMessage(limiter.maxLoops)
      }
    };
  });
}

async function flushAgentEvents(
  events: AgentEvent[],
  onEvent: AgentMessageEventHandler | undefined
): Promise<void> {
  if (!onEvent) {
    return;
  }

  for (const event of events) {
    await onEvent(event);
  }
}

async function runAgentLoopAttempt(options: {
  inputMessages: AgentMessage[];
  context: AgentContext;
  tools: NonNullable<AgentContext["tools"]>;
  model: Model<Api>;
  onEvent?: AgentMessageEventHandler;
  toolLoopLimiter: AgentToolLoopLimiter;
}): Promise<{ delayedEvents: AgentEvent[]; messages: AgentMessage[] }> {
  const delayedEvents: AgentEvent[] = [];
  const stream = agentLoop(
    options.inputMessages,
    { ...options.context, tools: options.tools },
    {
      model: options.model,
      convertToLlm: convertAgentMessagesToLlm,
      getApiKey: (provider) => getEnvApiKey(provider),
      beforeToolCall: async ({ assistantMessage }) => {
        const reason = registerAssistantToolLoop(options.toolLoopLimiter, assistantMessage);
        return reason ? { block: true, reason } : undefined;
      },
      toolExecution: "sequential"
    },
    options.toolLoopLimiter.abortController.signal
  );
  const resultPromise = stream.result();

  for await (const event of stream) {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      (event.message.stopReason === "error" || event.message.stopReason === "aborted")
    ) {
      delayedEvents.push(event);
      continue;
    }

    await options.onEvent?.(event);
  }

  return {
    delayedEvents,
    messages: applyToolLoopLimitToMessages(await resultPromise, options.toolLoopLimiter)
  };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Summary worker did not return a JSON object.");
  }
}

function parsePaperSummaryWorkerOutput(value: unknown): PaperSummaryWorkerOutput {
  if (!isRecord(value)) {
    throw new Error("Summary worker did not return a JSON object.");
  }
  const summaryMarkdown = value.summaryMarkdown;
  if (typeof summaryMarkdown !== "string" || !summaryMarkdown.trim()) {
    throw new Error("Summary worker JSON must include summaryMarkdown.");
  }

  const readString = (key: string): string | undefined =>
    typeof value[key] === "string" ? value[key] : undefined;
  const readStringList = (key: string): string[] | undefined => {
    const candidate = value[key];
    return Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === "string")
      : undefined;
  };
  const confidence = readString("confidence");

  return {
    summaryMarkdown,
    ...(readString("title") ? { title: readString("title") } : {}),
    ...(readStringList("tags") ? { tags: readStringList("tags") } : {}),
    ...(readStringList("keyFindings") ? { keyFindings: readStringList("keyFindings") } : {}),
    ...(readStringList("limitations") ? { limitations: readStringList("limitations") } : {}),
    ...(readStringList("openQuestions") ? { openQuestions: readStringList("openQuestions") } : {}),
    ...(readStringList("relatedPaperKeys") ? { relatedPaperKeys: readStringList("relatedPaperKeys") } : {}),
    ...(confidence === "high" || confidence === "medium" || confidence === "low" ? { confidence } : {}),
    ...(readStringList("groundingWarnings") ? { groundingWarnings: readStringList("groundingWarnings") } : {})
  };
}

function parsePaperWikiPageWorkerOutput(value: unknown): PaperWikiPageWorkerOutput {
  if (!isRecord(value)) {
    throw new Error("Wiki page worker did not return a JSON object.");
  }
  const title = value.title;
  const pageMarkdown = value.pageMarkdown;
  if (typeof title !== "string" || !title.trim()) {
    throw new Error("Wiki page worker JSON must include title.");
  }
  if (typeof pageMarkdown !== "string" || !pageMarkdown.trim()) {
    throw new Error("Wiki page worker JSON must include pageMarkdown.");
  }

  const readString = (key: string): string | undefined =>
    typeof value[key] === "string" ? value[key] : undefined;
  const readStringList = (key: string): string[] | undefined => {
    const candidate = value[key];
    return Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === "string")
      : undefined;
  };
  const confidence = readString("confidence");

  return {
    title,
    pageMarkdown,
    ...(readStringList("tags") ? { tags: readStringList("tags") } : {}),
    ...(readStringList("openQuestions") ? { openQuestions: readStringList("openQuestions") } : {}),
    ...(readStringList("relatedPageKeys") ? { relatedPageKeys: readStringList("relatedPageKeys") } : {}),
    ...(confidence === "high" || confidence === "medium" || confidence === "low" ? { confidence } : {}),
    ...(readStringList("groundingWarnings") ? { groundingWarnings: readStringList("groundingWarnings") } : {})
  };
}

function createPaperSummaryWorker(model: Model<Api>): PaperSummaryWorker {
  return async (input) => {
    const prompt: UserMessage = {
      role: "user",
      timestamp: Date.now(),
      content: [
        "Create a grounded paper wiki source summary from the evidence JSON below.",
        "Use only the supplied evidence. Do not invent claims, metrics, or citations.",
        "Return only a JSON object with these fields: title, summaryMarkdown, tags, keyFindings, limitations, openQuestions, relatedPaperKeys, confidence, groundingWarnings.",
        "summaryMarkdown should be concise Markdown suitable for a retrieval source page, normally 3 to 6 paragraphs.",
        "keyFindings, limitations, openQuestions, tags, relatedPaperKeys, and groundingWarnings must be arrays of strings.",
        "If relatedCandidates are supplied, choose relatedPaperKeys only from those candidate paperKey values when there is a real conceptual or methodological connection.",
        "confidence must be high, medium, or low.",
        JSON.stringify({
          paperKey: input.evidence.paperKey,
          title: input.evidence.title,
          engine: input.evidence.engine,
          articleUrl: input.evidence.articleUrl,
          quality: input.evidence.quality,
          sections: input.evidence.sections,
          paths: input.evidence.paths,
          relatedCandidates: input.evidence.relatedCandidates,
          totalMarkdownChars: input.evidence.totalMarkdownChars,
          truncated: input.evidence.truncated,
          markdown: input.evidence.markdown
        })
      ].join("\n\n")
    };
    const context: AgentContext = {
      systemPrompt:
        "You are a careful scientific summarization subagent. You write grounded summaries from supplied paper text only.",
      messages: [],
      tools: []
    };
    const stream = agentLoop(
      [prompt],
      context,
      {
        model,
        convertToLlm: convertAgentMessagesToLlm,
        getApiKey: (provider) => getEnvApiKey(provider),
        toolExecution: "sequential"
      }
    );
    const resultPromise = stream.result();
    for await (const _event of stream) {
      // Drain the stream; the summary worker intentionally does not emit UI events.
    }
    const messages = await resultPromise;
    const assistant = messages
      .filter((message): message is AssistantMessage => message.role === "assistant")
      .at(-1);
    const text = assistant ? getAssistantText(assistant) : "";
    return parsePaperSummaryWorkerOutput(extractJsonObject(text));
  };
}

function createPaperWikiPageWorker(model: Model<Api>): PaperWikiPageWorker {
  return async (input) => {
    const prompt: UserMessage = {
      role: "user",
      timestamp: Date.now(),
      content: [
        "Create a grounded topic wiki synthesis page from the evidence JSON below.",
        "Use only the supplied source-summary evidence. Do not invent papers, metrics, or unsupported claims.",
        "Return only a JSON object with these fields: title, pageMarkdown, tags, openQuestions, relatedPageKeys, confidence, groundingWarnings.",
        "pageMarkdown should be concise but structured Markdown with sections such as Overview, Key Concepts, Evidence, Challenges, Representative Papers, and Open Questions when appropriate.",
        "Every substantive claim should cite supplied paper keys inline, for example [arxiv-2507.09690].",
        "tags, openQuestions, relatedPageKeys, and groundingWarnings must be arrays of strings.",
        "confidence must be high, medium, or low.",
        JSON.stringify({
          topic: input.topic,
          question: input.question,
          evidence: input.evidence
        })
      ].join("\n\n")
    };
    const context: AgentContext = {
      systemPrompt:
        "You are a careful scientific wiki synthesis subagent. You write grounded topic pages from supplied paper source summaries only.",
      messages: [],
      tools: []
    };
    const stream = agentLoop(
      [prompt],
      context,
      {
        model,
        convertToLlm: convertAgentMessagesToLlm,
        getApiKey: (provider) => getEnvApiKey(provider),
        toolExecution: "sequential"
      }
    );
    const resultPromise = stream.result();
    for await (const _event of stream) {
      // Drain the stream; the wiki page worker intentionally does not emit UI events.
    }
    const messages = await resultPromise;
    const assistant = messages
      .filter((message): message is AssistantMessage => message.role === "assistant")
      .at(-1);
    const text = assistant ? getAssistantText(assistant) : "";
    return parsePaperWikiPageWorkerOutput(extractJsonObject(text));
  };
}

function createRuntimeTools(workspaceDir: string, model: Model<Api>) {
  return createTools(workspaceDir, {
    extensionBridge: createQueuedPaperExtensionBridge({ workspaceDir }),
    paperSummaryWorker: createPaperSummaryWorker(model),
    paperWikiPageWorker: createPaperWikiPageWorker(model)
  });
}

export async function runSessionPrompt(
  options: RunAgentTurnOptions
): Promise<SessionPromptResult> {
  const trimmedPrompt = options.prompt.trim();

  if (!trimmedPrompt) {
    return { action: "continue", newMessages: [] };
  }

  if (trimmedPrompt === "exit" || trimmedPrompt === "quit") {
    return { action: "stop", newMessages: [] };
  }

  const result = await runAgentTurn({
    ...options,
    prompt: trimmedPrompt
  });

  return { action: "continue", newMessages: result.newMessages };
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

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<RunAgentTurnResult> {
  const userMessage: UserMessage = {
    role: "user",
    content: options.prompt,
    timestamp: Date.now()
  };
  const workspaceDir = normalizeWorkspaceDir(options.workspaceDir);
  const existingTools = options.context.tools ?? [];
  const previousWorkspaceDir =
    contextWorkspaceDirs.get(options.context) ?? getToolsWorkspaceDir(existingTools);
  let tools = existingTools;

  if (existingTools.length === 0) {
    tools = createRuntimeTools(workspaceDir, options.model);
  } else if (previousWorkspaceDir !== undefined && previousWorkspaceDir !== workspaceDir) {
    await cleanupTools(existingTools);
    tools = createRuntimeTools(workspaceDir, options.model);
  }

  const originalMessages = options.context.messages;
  let contextMessages = originalMessages;
  let inputMessages: AgentMessage[] = [userMessage];
  let acceptedTurnMessages: AgentMessage[] = [];
  let newMessages: AgentMessage[] = [];
  const toolLoopLimiter = createAgentToolLoopLimiter(MAX_AGENT_TOOL_LOOPS_PER_TURN);

  for (let attempt = 0; attempt <= TRANSIENT_MODEL_RETRY_ATTEMPTS; attempt += 1) {
    const attemptResult = await runAgentLoopAttempt({
      inputMessages,
      context: { ...options.context, messages: contextMessages },
      tools,
      model: options.model,
      onEvent: options.onEvent,
      toolLoopLimiter
    });
    const failedAssistant = getFailedAssistantMessage(attemptResult.messages);
    const shouldRetry =
      attempt < TRANSIENT_MODEL_RETRY_ATTEMPTS &&
      isTransientModelFailure(failedAssistant);

    if (!shouldRetry) {
      await flushAgentEvents(
        applyToolLoopLimitToDelayedEvents(attemptResult.delayedEvents, toolLoopLimiter),
        options.onEvent
      );
      newMessages = [...acceptedTurnMessages, ...attemptResult.messages];
      break;
    }

    const retryMessages = attemptResult.messages.slice(0, -1);
    acceptedTurnMessages = [...acceptedTurnMessages, ...retryMessages];
    contextMessages = [...originalMessages, ...acceptedTurnMessages];
    inputMessages = [];
  }

  if (!isFailedTurn(newMessages)) {
    options.context.messages = [...originalMessages, ...newMessages];
  }
  options.context.tools = tools;
  contextWorkspaceDirs.set(options.context, workspaceDir);

  return { newMessages };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  configureEnvProxy();

  const cli = parseCliArgs(argv);
  if (cli.help) {
    process.stdout.write(
      "Usage: node dist/src/pi-agent.js [--mode chat|rpc] [--session-dir <dir>] [--no-session] [--provider <name>] [--model <id>] [--base-url <url>]\n"
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

  if (cli.mode === "rpc") {
    await runRpcMode({
      model: runtimeModel,
      workspaceDir: process.cwd(),
      sessionDir: cli.sessionDir,
      useSession: cli.useSession,
      input: process.stdin,
      output: process.stdout
    });
    return;
  }

  const context: AgentContext = {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    messages: [],
    tools: []
  };
  const sessionStats = await createAgentChatSessionStats(process.cwd());
  const replEventHandler = createReplEventHandler(process.stdout);
  const repl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const handlePrompt = async (prompt: string): Promise<SessionPromptResult> => {
    return runSessionPrompt({
      model: runtimeModel,
      workspaceDir: process.cwd(),
      context,
      prompt,
      onEvent: async (event) => {
        recordAgentChatSessionStats(sessionStats, event);
        await replEventHandler(event);
      }
    });
  };

  process.stdout.write(`model> ${selection.provider}/${runtimeModel.id}\n`);

  try {
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
    await refreshAgentChatSessionDownloadQueue(sessionStats);
    process.stdout.write(formatAgentChatSessionStats(sessionStats));
    await cleanupTools(context.tools);
    contextWorkspaceDirs.delete(context);
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
