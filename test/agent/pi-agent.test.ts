import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, AssistantMessage, Model, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import {
  Type,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider
} from "@mariozechner/pi-ai";
import type { AgentContext, AgentEvent } from "@mariozechner/pi-agent-core";
import * as piAgent from "../../src/pi-agent.js";
import { cleanupTools } from "../../src/agent/tools.js";
import { runAgentTurn } from "../../src/pi-agent.js";

type AgentMessage = AgentContext["messages"][number];
type ToolExecutionStartEvent = Extract<AgentEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;
type AssistantToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}

function isUserMessage(message: AgentMessage): message is UserMessage {
  return message.role === "user";
}

function findAssistantToolCall(
  message: AssistantMessage,
  toolName: string
): AssistantToolCall | undefined {
  return message.content.find(
    (content): content is AssistantToolCall =>
      content.type === "toolCall" && content.name === toolName
  );
}

function messageHasText(message: AssistantMessage, text: string): boolean {
  return message.content.some(
    (content) => content.type === "text" && typeof content.text === "string" && content.text === text
  );
}

function userMessageHasPrompt(message: UserMessage, prompt: string): boolean {
  return typeof message.content === "string"
    ? message.content === prompt
    : message.content.some(
        (content) => content.type === "text" && typeof content.text === "string" && content.text === prompt
      );
}

function findMessageIndex(
  messages: AgentMessage[],
  predicate: (message: AgentMessage, index: number) => boolean
): number {
  return messages.findIndex((message, index) => predicate(message, index));
}

test("runAgentTurn executes a tool call and appends the resulting messages", async () => {
  const registration = registerFauxProvider();
  const prompt = "What time is it?";
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("get_time", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Done using the tool.")])
  ]);

  const observedEvents: AgentEvent[] = [];
  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: []
  };

  try {
    const result = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt,
      onEvent: (event: AgentEvent) => {
        observedEvents.push(event);
      }
    });

    const userMessageIndex = findMessageIndex(
      result.newMessages,
      (message) => isUserMessage(message) && userMessageHasPrompt(message, prompt)
    );
    assert.notEqual(userMessageIndex, -1);

    const toolCallingAssistantIndex = findMessageIndex(
      result.newMessages,
      (message) => isAssistantMessage(message) && findAssistantToolCall(message, "get_time") !== undefined
    );
    assert.notEqual(toolCallingAssistantIndex, -1);

    const toolCallingAssistant = result.newMessages[toolCallingAssistantIndex];
    assert.ok(toolCallingAssistant);
    assert.ok(isAssistantMessage(toolCallingAssistant));

    const toolCall = findAssistantToolCall(toolCallingAssistant, "get_time");
    assert.ok(toolCall);
    assert.ok(userMessageIndex < toolCallingAssistantIndex);

    const toolResultIndex = findMessageIndex(
      result.newMessages,
      (message) =>
        isToolResultMessage(message) &&
        message.toolName === "get_time" &&
        message.toolCallId === toolCall.id
    );
    assert.notEqual(toolResultIndex, -1);
    assert.ok(userMessageIndex < toolResultIndex);
    assert.ok(toolCallingAssistantIndex < toolResultIndex);

    const toolResult = result.newMessages[toolResultIndex];
    assert.ok(toolResult);
    assert.ok(isToolResultMessage(toolResult));
    assert.equal(toolResult.toolName, "get_time");
    assert.equal(toolResult.toolCallId, toolCall.id);
    assert.equal(toolResult.isError, false);
    assert.ok(
      toolResult.content.some(
        (content) =>
          content.type === "text" && typeof content.text === "string" && content.text.length > 0
      )
    );

    const finalAssistantIndex = findMessageIndex(
      result.newMessages,
      (message, index) =>
        index > toolResultIndex &&
        isAssistantMessage(message) &&
        messageHasText(message, "Done using the tool.")
    );
    assert.notEqual(finalAssistantIndex, -1);

    const toolExecutionStart = observedEvents.find(
      (event): event is ToolExecutionStartEvent =>
        event.type === "tool_execution_start" && event.toolName === "get_time"
    );
    assert.ok(toolExecutionStart);
    assert.equal(toolExecutionStart.toolCallId, toolCall.id);

    const toolExecutionEnd = observedEvents.find(
      (event): event is ToolExecutionEndEvent =>
        event.type === "tool_execution_end" &&
        event.toolName === "get_time" &&
        event.toolCallId === toolCall.id
    );
    assert.ok(toolExecutionEnd);
    assert.equal(toolExecutionEnd.toolCallId, toolCall.id);
    assert.equal(toolExecutionEnd.isError, toolResult.isError);
    assert.deepEqual(toolExecutionEnd.result.content, toolResult.content);
    assert.deepEqual(toolExecutionEnd.result.details, toolResult.details);

    const toolExecutionStartIndex = observedEvents.findIndex((event) => event === toolExecutionStart);
    const toolExecutionEndIndex = observedEvents.findIndex((event) => event === toolExecutionEnd);
    assert.notEqual(toolExecutionStartIndex, -1);
    assert.notEqual(toolExecutionEndIndex, -1);
    assert.ok(toolExecutionStartIndex < toolExecutionEndIndex);

    assert.deepEqual(context.messages, result.newMessages);

    const persistedToolCallingAssistant = context.messages.find(
      (message): message is AssistantMessage =>
        isAssistantMessage(message) && findAssistantToolCall(message, "get_time")?.id === toolCall.id
    );
    assert.ok(persistedToolCallingAssistant);

    const persistedToolResult = context.messages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) &&
        message.toolName === "get_time" &&
        message.toolCallId === toolCall.id
    );
    assert.ok(persistedToolResult);
    assert.deepEqual(persistedToolResult.content, toolResult.content);
    assert.deepEqual(persistedToolResult.details, toolResult.details);
    assert.equal(persistedToolResult.isError, toolResult.isError);

    assert.ok(
      context.messages.some(
        (message) => isAssistantMessage(message) && messageHasText(message, "Done using the tool.")
      )
    );
  } finally {
    registration.unregister();
  }
});

test("runAgentTurn default tools queue extension download jobs", async () => {
  const registration = registerFauxProvider();
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-extension-workspace-"));
  const articleUrl = "https://example.com/research/paper.pdf";
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("download_paper", { url: articleUrl })], {
      stopReason: "toolUse"
    }),
    fauxAssistantMessage([fauxText("Queued the paper download.")])
  ]);

  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: []
  };

  try {
    const result = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: workspace,
      context,
      prompt: "Download this paper PDF."
    });

    const toolResult = result.newMessages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) && message.toolName === "download_paper"
    );
    assert.ok(toolResult);
    assert.equal(toolResult.isError, false);
    const details = toolResult.details as { jobId?: string };
    assert.equal(typeof details.jobId, "string");
    assert.ok(details.jobId?.startsWith("paper-external-"));
    assert.deepEqual(toolResult.details, {
      status: "extension_job_queued",
      source: "external",
      articleUrl,
      jobId: details.jobId,
      message: "Paper download job queued for the browser extension."
    });
  } finally {
    registration.unregister();
    await cleanupTools(context.tools);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentTurn reuses the same tools across prompts in one context", async () => {
  const registration = registerFauxProvider();
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("remember_counter", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("First turn complete.")]),
    fauxAssistantMessage([fauxToolCall("remember_counter", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Second turn complete.")])
  ]);

  let executionCount = 0;
  const rememberCounterTool: NonNullable<AgentContext["tools"]>[number] = {
    name: "remember_counter",
    label: "Remember Counter",
    description: "Keeps a counter across prompts within one session.",
    parameters: Type.Object({}),
    execute: async () => {
      executionCount += 1;
      return {
        content: [{ type: "text", text: `count:${executionCount}` }],
        details: { count: executionCount }
      };
    }
  };
  const tools = [rememberCounterTool];
  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools
  };

  try {
    const firstTurn = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "Use the counter tool once."
    });
    const firstToolResult = firstTurn.newMessages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) && message.toolName === "remember_counter"
    );
    assert.ok(firstToolResult);
    assert.equal(firstToolResult.isError, false);
    assert.deepEqual(firstToolResult.details, { count: 1 });
    assert.deepEqual(firstToolResult.content, [{ type: "text", text: "count:1" }]);
    assert.strictEqual(context.tools, tools);

    const secondTurn = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "Use the same counter tool again."
    });
    const secondToolResult = secondTurn.newMessages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) && message.toolName === "remember_counter"
    );
    assert.ok(secondToolResult);
    assert.equal(secondToolResult.isError, false);
    assert.deepEqual(secondToolResult.details, { count: 2 });
    assert.deepEqual(secondToolResult.content, [{ type: "text", text: "count:2" }]);
    assert.strictEqual(context.tools, tools);

    assert.equal(executionCount, 2);
  } finally {
    registration.unregister();
  }
});

test("runAgentTurn rebuilds built-in tools when the workspace changes", async () => {
  const registration = registerFauxProvider();
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("read_file", { path: "notes.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Read the first workspace.")]),
    fauxAssistantMessage([fauxToolCall("read_file", { path: "notes.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Read the second workspace.")])
  ]);

  const workspaceA = await mkdtemp(path.join(tmpdir(), "pi-agent-workspace-a-"));
  const workspaceB = await mkdtemp(path.join(tmpdir(), "pi-agent-workspace-b-"));
  const relativePath = "notes.txt";
  await writeFile(path.join(workspaceA, relativePath), "from workspace A", "utf8");
  await writeFile(path.join(workspaceB, relativePath), "from workspace B", "utf8");

  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: []
  };

  try {
    const firstTurn = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: workspaceA,
      context,
      prompt: "Read notes.txt from the first workspace."
    });
    const firstToolResult = firstTurn.newMessages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) && message.toolName === "read_file"
    );
    assert.ok(firstToolResult);
    assert.equal(firstToolResult.isError, false);
    assert.deepEqual(firstToolResult.content, [{ type: "text", text: "from workspace A" }]);

    const firstWorkspaceTools = context.tools;
    assert.ok(firstWorkspaceTools);

    const secondTurn = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: workspaceB,
      context,
      prompt: "Read notes.txt from the second workspace."
    });
    const secondToolResult = secondTurn.newMessages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) && message.toolName === "read_file"
    );
    assert.ok(secondToolResult);
    assert.equal(secondToolResult.isError, false);
    assert.deepEqual(secondToolResult.content, [{ type: "text", text: "from workspace B" }]);
    assert.ok(context.tools);
    assert.notStrictEqual(context.tools, firstWorkspaceTools);
  } finally {
    registration.unregister();
    await Promise.all([
      rm(workspaceA, { recursive: true, force: true }),
      rm(workspaceB, { recursive: true, force: true })
    ]);
  }
});

test("runAgentTurn cleans up the prior tool set before replacing it on workspace switch", async () => {
  const registration = registerFauxProvider();
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("remember_counter", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Used the custom tool.")]),
    fauxAssistantMessage([fauxToolCall("read_file", { path: "notes.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Used the rebuilt tool set.")])
  ]);

  const workspaceA = await mkdtemp(path.join(tmpdir(), "pi-agent-workspace-a-"));
  const workspaceB = await mkdtemp(path.join(tmpdir(), "pi-agent-workspace-b-"));
  await writeFile(path.join(workspaceB, "notes.txt"), "from workspace B", "utf8");

  const cleanupCalls: number[] = [];
  const customTools = [
    {
      name: "remember_counter",
      label: "Remember Counter",
      description: "Keeps a counter across prompts within one session.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "count:1" }],
        details: { count: 1 }
      })
    }
  ] as NonNullable<AgentContext["tools"]>;
  Object.assign(customTools, {
    cleanup: async () => {
      cleanupCalls.push(1);
    }
  });

  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: customTools
  };

  try {
    await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: workspaceA,
      context,
      prompt: "Use the custom tool in the first workspace."
    });

    assert.deepEqual(cleanupCalls, []);

    const secondTurn = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: workspaceB,
      context,
      prompt: "Switch workspaces and read notes.txt."
    });
    const secondToolResult = secondTurn.newMessages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) && message.toolName === "read_file"
    );
    assert.ok(secondToolResult);
    assert.equal(secondToolResult.isError, false);
    assert.deepEqual(secondToolResult.content, [{ type: "text", text: "from workspace B" }]);
    assert.deepEqual(cleanupCalls, [1]);
    assert.notStrictEqual(context.tools, customTools);
  } finally {
    registration.unregister();
    await Promise.all([
      rm(workspaceA, { recursive: true, force: true }),
      rm(workspaceB, { recursive: true, force: true })
    ]);
  }
});

test("runAgentTurn does not persist a failed turn into context history", async () => {
  const registration = registerFauxProvider();
  const prompt = "Try again later";
  const previousMessages: AgentMessage[] = [
    {
      role: "user",
      content: "Earlier prompt",
      timestamp: 1
    },
    fauxAssistantMessage([fauxText("Earlier answer")], { timestamp: 2 })
  ];
  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [...previousMessages],
    tools: []
  };

  registration.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Authentication failed"
    })
  ]);

  try {
    const result = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt
    });

    assert.equal(result.newMessages.length, 2);

    const failedPrompt = result.newMessages[0];
    assert.ok(failedPrompt);
    assert.ok(isUserMessage(failedPrompt));
    assert.ok(userMessageHasPrompt(failedPrompt, prompt));

    const failedAssistant = result.newMessages[1];
    assert.ok(failedAssistant);
    assert.ok(isAssistantMessage(failedAssistant));
    assert.equal(failedAssistant.stopReason, "error");
    assert.equal(failedAssistant.errorMessage, "Authentication failed");

    assert.deepEqual(context.messages, previousMessages);
  } finally {
    registration.unregister();
  }
});

test("runSessionPrompt stops on exit and quit commands", async () => {
  const runSessionPrompt = (
    piAgent as {
      runSessionPrompt?: (options: {
        model: Model<Api>;
        workspaceDir: string;
        context: AgentContext;
        prompt: string;
      }) => Promise<{ action: "stop" | "continue"; newMessages: AgentMessage[] }>;
    }
  ).runSessionPrompt;
  assert.equal(typeof runSessionPrompt, "function");

  const model = new Proxy({} as Record<string, unknown>, {
    get() {
      throw new Error("model should not be called for session control commands");
    }
  }) as unknown as Model<Api>;

  for (const prompt of ["exit", "quit"]) {
    const context: AgentContext = {
      systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
      messages: [],
      tools: []
    };

    const result = await runSessionPrompt!({
      model,
      workspaceDir: process.cwd(),
      context,
      prompt
    });

    assert.deepEqual(result, { action: "stop", newMessages: [] });
    assert.deepEqual(context.messages, []);
  }
});

test("runSessionPrompt ignores empty prompts without calling the model", async () => {
  const runSessionPrompt = (
    piAgent as {
      runSessionPrompt?: (options: {
        model: Model<Api>;
        workspaceDir: string;
        context: AgentContext;
        prompt: string;
      }) => Promise<{ action: "stop" | "continue"; newMessages: AgentMessage[] }>;
    }
  ).runSessionPrompt;
  assert.equal(typeof runSessionPrompt, "function");

  const model = new Proxy({} as Record<string, unknown>, {
    get() {
      throw new Error("model should not be called for empty prompts");
    }
  }) as unknown as Model<Api>;

  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [
      {
        role: "user",
        content: "Earlier prompt",
        timestamp: 1
      }
    ],
    tools: []
  };
  const previousMessages = [...context.messages];

  const result = await runSessionPrompt!({
    model,
    workspaceDir: process.cwd(),
    context,
    prompt: "   \t  "
  });

  assert.deepEqual(result, { action: "continue", newMessages: [] });
  assert.deepEqual(context.messages, previousMessages);
});

test("readInteractivePrompt treats closed readline as a normal stop signal", async () => {
  const readInteractivePrompt = (
    piAgent as {
      readInteractivePrompt?: (repl: {
        question: (prompt: string) => Promise<string>;
      }) => Promise<string | null>;
    }
  ).readInteractivePrompt;
  assert.equal(typeof readInteractivePrompt, "function");

  const repl = {
    question: async () => {
      throw Object.assign(new Error("readline closed"), { code: "ERR_USE_AFTER_CLOSE" });
    }
  };

  const result = await readInteractivePrompt!(repl);

  assert.equal(result, null);
});

test("readInteractivePrompt rethrows non-close errors", async () => {
  const readInteractivePrompt = (
    piAgent as {
      readInteractivePrompt?: (repl: {
        question: (prompt: string) => Promise<string>;
      }) => Promise<string | null>;
    }
  ).readInteractivePrompt;
  assert.equal(typeof readInteractivePrompt, "function");

  const error = Object.assign(new Error("boom"), { code: "EFAIL" });
  const repl = {
    question: async () => {
      throw error;
    }
  };

  await assert.rejects(readInteractivePrompt!(repl), (caughtError: unknown) => {
    assert.equal(caughtError, error);
    return true;
  });
});

test("consumePromptLines reuses one session across multiple stdin lines", async () => {
  const consumePromptLines = (
    piAgent as {
      consumePromptLines?: (options: {
        lines: AsyncIterable<string>;
        onPrompt: (prompt: string) => Promise<{ action: "continue" | "stop" }>;
      }) => Promise<void>;
    }
  ).consumePromptLines;
  assert.equal(typeof consumePromptLines, "function");

  const processedPrompts: string[] = [];

  async function* lines(): AsyncIterable<string> {
    yield "";
    yield "   ";
    yield "hello";
    yield "exit";
    yield "ignored";
  }

  await consumePromptLines!({
    lines: lines(),
    onPrompt: async (prompt) => {
      processedPrompts.push(prompt);
      return prompt === "exit" ? { action: "stop" } : { action: "continue" };
    }
  });

  assert.deepEqual(processedPrompts, ["hello", "exit"]);
});

test("createReplEventHandler prints assistant error messages", () => {
  const handlerFactory = (
    piAgent as {
      createReplEventHandler?: (output: NodeJS.WriteStream) => (event: AgentEvent) => void;
    }
  ).createReplEventHandler;
  assert.equal(typeof handlerFactory, "function");

  const output: { write: (chunk: string | Uint8Array) => boolean } = {
    write: (chunk) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }
  };
  const writes: string[] = [];
  const handleEvent = handlerFactory!(output as NodeJS.WriteStream);

  handleEvent({
    type: "message_end",
    message: fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Authentication failed"
    })
  });

  assert.match(writes.join(""), /Authentication failed/);
});

test("parseCliArgs accepts --base-url", () => {
  const parseCliArgs = (
    piAgent as {
      parseCliArgs?: (argv: string[]) => {
        provider?: string;
        model?: string;
        baseUrl?: string;
        help: boolean;
      };
    }
  ).parseCliArgs;
  assert.equal(typeof parseCliArgs, "function");

  const parsed = parseCliArgs!([
    "--provider",
    "openai",
    "--model",
    "gpt-5.4",
    "--base-url",
    "https://proxy.example.com/v1"
  ]);

  assert.deepEqual(parsed, {
    provider: "openai",
    model: "gpt-5.4",
    baseUrl: "https://proxy.example.com/v1",
    help: false
  });
});

test("applyModelBaseUrlOverride prefers CLI base URL over env", () => {
  const applyModelBaseUrlOverride = (
    piAgent as {
      applyModelBaseUrlOverride?: (
        model: Model<Api>,
        overrides: { cliBaseUrl?: string; envBaseUrl?: string }
      ) => Model<Api>;
    }
  ).applyModelBaseUrlOverride;
  assert.equal(typeof applyModelBaseUrlOverride, "function");

  const registration = registerFauxProvider();

  try {
    const originalModel = registration.getModel() as Model<Api>;
    const overriddenModel = applyModelBaseUrlOverride!(originalModel, {
      cliBaseUrl: "https://cli.example.com/v1",
      envBaseUrl: "https://env.example.com/v1"
    });

    assert.notStrictEqual(overriddenModel, originalModel);
    assert.equal(overriddenModel.baseUrl, "https://cli.example.com/v1");
    assert.equal(originalModel.baseUrl, "http://localhost:0");
  } finally {
    registration.unregister();
  }
});

test("applyModelBaseUrlOverride uses env base URL when CLI base URL is absent", () => {
  const applyModelBaseUrlOverride = (
    piAgent as {
      applyModelBaseUrlOverride?: (
        model: Model<Api>,
        overrides: { cliBaseUrl?: string; envBaseUrl?: string }
      ) => Model<Api>;
    }
  ).applyModelBaseUrlOverride;
  assert.equal(typeof applyModelBaseUrlOverride, "function");

  const registration = registerFauxProvider();

  try {
    const originalModel = registration.getModel() as Model<Api>;
    const overriddenModel = applyModelBaseUrlOverride!(originalModel, {
      envBaseUrl: "https://env.example.com/v1"
    });

    assert.notStrictEqual(overriddenModel, originalModel);
    assert.equal(overriddenModel.baseUrl, "https://env.example.com/v1");
    assert.equal(originalModel.baseUrl, "http://localhost:0");
  } finally {
    registration.unregister();
  }
});
