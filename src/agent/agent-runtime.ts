import path from "node:path";
import {
  getEnvApiKey,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolResultMessage,
  type UserMessage
} from "@mariozechner/pi-ai";
import { agentLoop, type AgentContext, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { createQueuedPaperExtensionBridge } from "./paper/extension/paper-extension-bridge.js";
import { createWikiEvidenceWorker } from "./wiki/worker.js";
import { cleanupTools, createTools, createToolsForBoundary, getToolsWorkspaceDir } from "./tools.js";
import {
  createWorkerHandoffMessage,
  extractWorkerHandoffPaths,
  nextOwnerForWorker,
  normalizeWorkerRole,
  routeChatPromptToWorker,
  systemPromptForWorker,
  type RoutedWorkerPrompt,
  type RoutedWorkerRole,
  type WorkerHandoff
} from "./agent-routing.js";

type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;
type AgentMessageEventHandler = (event: AgentEvent) => Promise<void> | void;
const contextWorkspaceDirs = new WeakMap<AgentContext, string>();
const TRANSIENT_MODEL_RETRY_ATTEMPTS = 5;
const MAX_AGENT_TOOL_LOOPS_PER_TURN = 90;
const MAX_LLM_TOOL_RESULT_TEXT_CHARS = 8000;
const MAX_LLM_TOOL_RESULT_TOTAL_TEXT_CHARS = 48000;
const TRANSIENT_MODEL_RETRY_PATTERNS = [
  /\boverloaded\b/i,
  /try again later/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /\b503\b/i
];

export function forgetAgentContextWorkspaceDir(context: AgentContext): void {
  contextWorkspaceDirs.delete(context);
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

function toolResultTextLength(message: ToolResultMessage): number {
  return message.content.reduce(
    (total, item) => total + (item.type === "text" ? item.text.length : item.data.length),
    0
  );
}

function createToolResultContextNotice(message: ToolResultMessage, originalChars: number): string {
  return [
    "[tool result truncated for model context]",
    `tool=${message.toolName}`,
    `originalChars=${originalChars}`,
    "Full result is preserved in tool events and session history."
  ].join(" ");
}

function compactToolResultForLlmContext(
  message: ToolResultMessage,
  remainingTextBudget: number
): { message: ToolResultMessage; usedTextBudget: number } {
  const originalChars = toolResultTextLength(message);
  const maxChars = Math.max(0, Math.min(MAX_LLM_TOOL_RESULT_TEXT_CHARS, remainingTextBudget));
  const baseMessage = {
    role: "toolResult" as const,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
    timestamp: message.timestamp
  };

  if (originalChars <= maxChars) {
    return {
      message: {
        ...baseMessage,
        content: message.content
      },
      usedTextBudget: originalChars
    };
  }

  const notice = createToolResultContextNotice(message, originalChars);
  const contentBudget = Math.max(0, maxChars - notice.length - 2);
  let remainingContentBudget = contentBudget;
  const compactedContent: ToolResultMessage["content"] = [];

  for (const item of message.content) {
    if (remainingContentBudget <= 0) {
      break;
    }

    if (item.type === "text") {
      const text = item.text.slice(0, remainingContentBudget);
      if (text.length > 0) {
        compactedContent.push({ type: "text", text });
        remainingContentBudget -= text.length;
      }
      continue;
    }

    const placeholder = `[image omitted from model context: mimeType=${item.mimeType} chars=${item.data.length}]`;
    const text = placeholder.slice(0, remainingContentBudget);
    if (text.length > 0) {
      compactedContent.push({ type: "text", text });
      remainingContentBudget -= text.length;
    }
  }

  compactedContent.push({ type: "text", text: notice });
  return {
    message: {
      ...baseMessage,
      content: compactedContent
    },
    usedTextBudget: toolResultTextLength({
      ...baseMessage,
      content: compactedContent
    })
  };
}

function compactToolResultsForLlmContext(messages: AgentMessage[]): AgentMessage[] {
  let remainingTextBudget = MAX_LLM_TOOL_RESULT_TOTAL_TEXT_CHARS;
  const compacted = new Array<AgentMessage>(messages.length);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "toolResult") {
      compacted[index] = message;
      continue;
    }

    const result = compactToolResultForLlmContext(message, remainingTextBudget);
    compacted[index] = result.message;
    remainingTextBudget = Math.max(0, remainingTextBudget - result.usedTextBudget);
  }

  return compacted;
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

function normalizeWorkspaceDir(workspaceDir: string): string {
  return path.resolve(workspaceDir);
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
      transformContext: async (messages) => compactToolResultsForLlmContext(messages),
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

async function runRoutedWorkerPrompt(options: {
  model: Model<Api>;
  workspaceDir: string;
  role: RoutedWorkerRole;
  routeReason: RoutedWorkerPrompt["reason"];
  instruction: string;
  onEvent?: AgentMessageEventHandler;
}): Promise<{ messages: AgentMessage[]; handoff: WorkerHandoff }> {
  const normalizedRole = normalizeWorkerRole(options.role);
  const workerTools = createToolsForBoundary(options.workspaceDir, options.role, {
    extensionBridge: createQueuedPaperExtensionBridge({ workspaceDir: options.workspaceDir })
  });
  const workerContext: AgentContext = {
    systemPrompt: systemPromptForWorker(options.role),
    messages: [],
    tools: workerTools
  };
  const prompt: UserMessage = {
    role: "user",
    content: options.instruction,
    timestamp: Date.now()
  };
  const toolLoopLimiter = createAgentToolLoopLimiter(MAX_AGENT_TOOL_LOOPS_PER_TURN);
  const changedFiles = new Set<string>();
  const artifacts = new Set<string>();
  const sourcePaths = new Set<string>();
  const pagePaths = new Set<string>();
  const designRecords = new Set<string>();
  const toolsUsed: string[] = [];
  const failedTools: string[] = [];
  const onWorkerEvent: AgentMessageEventHandler = async (event) => {
    if (event.type === "tool_execution_end") {
      toolsUsed.push(event.toolName);
      if (event.isError) {
        failedTools.push(event.toolName);
      } else {
        extractWorkerHandoffPaths(event.toolName, event.result.details, {
          changedFiles,
          artifacts,
          sourcePaths,
          pagePaths,
          designRecords
        });
      }
    }

    await options.onEvent?.(event);
  };

  try {
    const attemptResult = await runAgentLoopAttempt({
      inputMessages: [prompt],
      context: workerContext,
      tools: workerTools,
      model: options.model,
      onEvent: onWorkerEvent,
      toolLoopLimiter
    });
    await flushAgentEvents(
      applyToolLoopLimitToDelayedEvents(attemptResult.delayedEvents, toolLoopLimiter),
      onWorkerEvent
    );
    const finalAssistant = attemptResult.messages
      .filter((message): message is AssistantMessage => message.role === "assistant")
      .at(-1);
    const finalResponse = finalAssistant ? compactOutputText(getAssistantText(finalAssistant), 1200) ?? "" : "";
    return {
      messages: attemptResult.messages,
      handoff: {
        role: normalizedRole,
        instruction: options.instruction,
        routeReason: options.routeReason,
        status: isFailedTurn(attemptResult.messages) ? "failed" : "completed",
        changedFiles: [...changedFiles].sort(),
        artifacts: [...artifacts].sort(),
        sourcePaths: [...sourcePaths].sort(),
        pagePaths: [...pagePaths].sort(),
        designRecords: [...designRecords].sort(),
        toolsUsed: [...new Set(toolsUsed)],
        failedTools: [...new Set(failedTools)],
        finalResponse,
        nextSuggestedOwner: nextOwnerForWorker(normalizedRole)
      }
    };
  } finally {
    await cleanupTools(workerTools);
  }
}

function createRuntimeTools(workspaceDir: string, model: Model<Api>) {
  const wikiEvidenceWorker = createWikiEvidenceWorker(model, workspaceDir);
  return createTools(workspaceDir, {
    extensionBridge: createQueuedPaperExtensionBridge({ workspaceDir }),
    paperSummaryWorker: wikiEvidenceWorker.paperSummaryWorker,
    paperWikiPageWorker: wikiEvidenceWorker.paperWikiPageWorker
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

  const routedWorker = routeChatPromptToWorker(trimmedPrompt);
  if (routedWorker !== null) {
    const workerResult = await runRoutedWorkerPrompt({
      model: options.model,
      workspaceDir: options.workspaceDir,
      role: routedWorker.role,
      routeReason: routedWorker.reason,
      instruction: routedWorker.instruction,
      onEvent: options.onEvent
    });
    const userMessage: UserMessage = {
      role: "user",
      content: trimmedPrompt,
      timestamp: Date.now()
    };
    const handoffMessage = createWorkerHandoffMessage(workerResult.handoff);
    const newMessages: AgentMessage[] = [userMessage, handoffMessage];

    if (!isFailedTurn(workerResult.messages)) {
      options.context.messages = [...options.context.messages, ...newMessages];
    }

    return { action: "continue", newMessages };
  }

  const result = await runAgentTurn({
    ...options,
    prompt: trimmedPrompt
  });

  return { action: "continue", newMessages: result.newMessages };
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

export { getAssistantText, isRecord, compactOutputText };
export type { AgentMessageEventHandler };
