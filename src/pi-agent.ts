import { createInterface } from "node:readline/promises";
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
import { createTools } from "./agent/tools.js";

type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;
type AgentMessageEventHandler = (event: AgentEvent) => Promise<void> | void;

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant. Use tools when they are useful.";

export interface CliArgs {
  provider?: string;
  model?: string;
  baseUrl?: string;
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

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmedBaseUrl = baseUrl?.trim();
  return trimmedBaseUrl ? trimmedBaseUrl : undefined;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--provider" || arg === "--model" || arg === "--base-url") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }

      if (arg === "--provider") {
        parsed.provider = value;
      } else if (arg === "--model") {
        parsed.model = value;
      } else {
        parsed.baseUrl = normalizeBaseUrl(value);
      }

      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
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
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_USE_AFTER_CLOSE") {
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
  const tools = [...createTools(options.workspaceDir)];
  const stream = agentLoop(
    [userMessage],
    { ...options.context, tools },
    {
      model: options.model,
      convertToLlm: convertAgentMessagesToLlm,
      getApiKey: (provider) => getEnvApiKey(provider),
      toolExecution: "sequential"
    }
  );
  const resultPromise = stream.result();

  for await (const event of stream) {
    await options.onEvent?.(event);
  }

  const newMessages = await resultPromise;
  if (!isFailedTurn(newMessages)) {
    options.context.messages = [...options.context.messages, ...newMessages];
  }
  options.context.tools = tools;

  return { newMessages };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    process.stdout.write(
      "Usage: node dist/src/pi-agent.js [--provider <name>] [--model <id>] [--base-url <url>]\n"
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

  const context: AgentContext = {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    messages: [],
    tools: [...createTools(process.cwd())]
  };
  const repl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  process.stdout.write(`model> ${selection.provider}/${runtimeModel.id}\n`);

  try {
    while (true) {
      const prompt = await repl.question("> ");
      const trimmedPrompt = prompt.trim();

      if (!trimmedPrompt) {
        continue;
      }

      if (trimmedPrompt === "exit" || trimmedPrompt === "quit") {
        break;
      }

      await runAgentTurn({
        model: runtimeModel,
        workspaceDir: process.cwd(),
        context,
        prompt: trimmedPrompt,
        onEvent: createReplEventHandler(process.stdout)
      });
    }
  } finally {
    repl.close();
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
