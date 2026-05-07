import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { DEFAULT_SYSTEM_PROMPT, runAgentTurn } from "../../src/pi-agent.js";

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

test("default system prompt requires wiki evidence for scientific questions", () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /answer_research_question/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /answer_paper_wiki_question/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /clarify_research_topic/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /user is the research lead/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /local wiki/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /cite/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /replace_file_text/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /delete_file/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /compile_latex/);
});

test("runAgentTurn executes a tool call and appends the resulting messages", async () => {
  const registration = registerFauxProvider();
  const prompt = "Search the local papers.";
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("search_local_papers", { query: "agent memory" })], { stopReason: "toolUse" }),
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
      (message) => isAssistantMessage(message) && findAssistantToolCall(message, "search_local_papers") !== undefined
    );
    assert.notEqual(toolCallingAssistantIndex, -1);

    const toolCallingAssistant = result.newMessages[toolCallingAssistantIndex];
    assert.ok(toolCallingAssistant);
    assert.ok(isAssistantMessage(toolCallingAssistant));

    const toolCall = findAssistantToolCall(toolCallingAssistant, "search_local_papers");
    assert.ok(toolCall);
    assert.ok(userMessageIndex < toolCallingAssistantIndex);

    const toolResultIndex = findMessageIndex(
      result.newMessages,
      (message) =>
        isToolResultMessage(message) &&
        message.toolName === "search_local_papers" &&
        message.toolCallId === toolCall.id
    );
    assert.notEqual(toolResultIndex, -1);
    assert.ok(userMessageIndex < toolResultIndex);
    assert.ok(toolCallingAssistantIndex < toolResultIndex);

    const toolResult = result.newMessages[toolResultIndex];
    assert.ok(toolResult);
    assert.ok(isToolResultMessage(toolResult));
    assert.equal(toolResult.toolName, "search_local_papers");
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
        event.type === "tool_execution_start" && event.toolName === "search_local_papers"
    );
    assert.ok(toolExecutionStart);
    assert.equal(toolExecutionStart.toolCallId, toolCall.id);

    const toolExecutionEnd = observedEvents.find(
      (event): event is ToolExecutionEndEvent =>
        event.type === "tool_execution_end" &&
        event.toolName === "search_local_papers" &&
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
        isAssistantMessage(message) && findAssistantToolCall(message, "search_local_papers")?.id === toolCall.id
    );
    assert.ok(persistedToolCallingAssistant);

    const persistedToolResult = context.messages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) &&
        message.toolName === "search_local_papers" &&
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
  const articleUrlA = "https://example.com/workspace-a.pdf";
  const articleUrlB = "https://example.com/workspace-b.pdf";
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("download_paper", { url: articleUrlA })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Queued the first workspace paper.")]),
    fauxAssistantMessage([fauxToolCall("download_paper", { url: articleUrlB })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Queued the second workspace paper.")])
  ]);

  const workspaceA = await mkdtemp(path.join(tmpdir(), "pi-agent-workspace-a-"));
  const workspaceB = await mkdtemp(path.join(tmpdir(), "pi-agent-workspace-b-"));

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
      prompt: "Queue a paper from the first workspace."
    });
    const firstToolResult = firstTurn.newMessages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) && message.toolName === "download_paper"
    );
    assert.ok(firstToolResult);
    assert.equal(firstToolResult.isError, false);
    assert.equal((firstToolResult.details as { articleUrl?: string }).articleUrl, articleUrlA);

    const firstWorkspaceTools = context.tools;
    assert.ok(firstWorkspaceTools);

    const secondTurn = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: workspaceB,
      context,
      prompt: "Queue a paper from the second workspace."
    });
    const secondToolResult = secondTurn.newMessages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) && message.toolName === "download_paper"
    );
    assert.ok(secondToolResult);
    assert.equal(secondToolResult.isError, false);
    assert.equal((secondToolResult.details as { articleUrl?: string }).articleUrl, articleUrlB);
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
  const articleUrl = "https://example.com/rebuilt-workspace.pdf";
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("remember_counter", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Used the custom tool.")]),
    fauxAssistantMessage([fauxToolCall("download_paper", { url: articleUrl })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Used the rebuilt tool set.")])
  ]);

  const workspaceA = await mkdtemp(path.join(tmpdir(), "pi-agent-workspace-a-"));
  const workspaceB = await mkdtemp(path.join(tmpdir(), "pi-agent-workspace-b-"));

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
      prompt: "Switch workspaces and queue a paper."
    });
    const secondToolResult = secondTurn.newMessages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) && message.toolName === "download_paper"
    );
    assert.ok(secondToolResult);
    assert.equal(secondToolResult.isError, false);
    assert.equal((secondToolResult.details as { articleUrl?: string }).articleUrl, articleUrl);
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

test("runAgentTurn retries transient overloaded assistant errors without rerunning completed tools", async () => {
  const registration = registerFauxProvider();
  const prompt = "Download the paper.";
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("remember_counter", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Our servers are currently overloaded. Please try again later."
    }),
    fauxAssistantMessage([fauxText("Download task was queued.")])
  ]);

  let executionCount = 0;
  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: [
      {
        name: "remember_counter",
        label: "Remember Counter",
        description: "Tracks executions.",
        parameters: Type.Object({}),
        execute: async () => {
          executionCount += 1;
          return {
            content: [{ type: "text", text: `count:${executionCount}` }],
            details: { count: executionCount }
          };
        }
      }
    ]
  };
  const observedEvents: AgentEvent[] = [];

  try {
    const result = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt,
      onEvent: (event) => {
        observedEvents.push(event);
      }
    });

    assert.equal(executionCount, 1);
    assert.equal(
      observedEvents.filter(
        (event) => event.type === "tool_execution_start" && event.toolName === "remember_counter"
      ).length,
      1
    );
    assert.equal(
      observedEvents.filter(
        (event) => event.type === "tool_execution_end" && event.toolName === "remember_counter"
      ).length,
      1
    );
    assert.equal(
      observedEvents.some(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.errorMessage === "Our servers are currently overloaded. Please try again later."
      ),
      false
    );
    assert.ok(
      result.newMessages.some(
        (message) => isAssistantMessage(message) && messageHasText(message, "Download task was queued.")
      )
    );
    assert.equal(
      result.newMessages.some(
        (message) =>
          isAssistantMessage(message) &&
          message.errorMessage === "Our servers are currently overloaded. Please try again later."
      ),
      false
    );
    assert.deepEqual(context.messages, result.newMessages);
  } finally {
    registration.unregister();
  }
});

test("runAgentTurn stops after ninety tool loops in one turn", async () => {
  const registration = registerFauxProvider();
  const prompt = "Keep using the tool.";
  registration.setResponses([
    ...Array.from({ length: 91 }, (_value, index) =>
      fauxAssistantMessage([fauxToolCall("remember_counter", { index })], { stopReason: "toolUse" })
    ),
    fauxAssistantMessage([fauxText("This response should be aborted before it streams.")])
  ]);

  let executionCount = 0;
  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: [
      {
        name: "remember_counter",
        label: "Remember Counter",
        description: "Tracks executions.",
        parameters: Type.Object({ index: Type.Number() }),
        execute: async () => {
          executionCount += 1;
          return {
            content: [{ type: "text", text: `count:${executionCount}` }],
            details: { count: executionCount }
          };
        }
      }
    ]
  };
  const observedEvents: AgentEvent[] = [];

  try {
    const result = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt,
      onEvent: (event) => {
        observedEvents.push(event);
      }
    });

    assert.equal(executionCount, 90);
    assert.equal(
      observedEvents.filter(
        (event) =>
          event.type === "tool_execution_end" &&
          event.toolName === "remember_counter" &&
          !event.isError
      ).length,
      90
    );
    assert.equal(
      observedEvents.filter(
        (event) =>
          event.type === "tool_execution_end" &&
          event.toolName === "remember_counter" &&
          event.isError
      ).length,
      1
    );

    const finalMessage = result.newMessages.at(-1);
    assert.ok(finalMessage);
    assert.ok(isAssistantMessage(finalMessage));
    assert.equal(finalMessage.stopReason, "aborted");
    assert.match(finalMessage.errorMessage ?? "", /stopped after 90 tool loops/);
    assert.deepEqual(context.messages, []);
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

test("readInteractivePrompt treats Ctrl+C AbortError as a normal stop signal", async () => {
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
      throw Object.assign(new Error("Aborted with Ctrl+C"), { name: "AbortError" });
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

test("agent chat session stats summarize downloads, queues, and wiki page writes", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-session-stats-"));
  const pagesDir = path.join(workspace, "knowledge-base", "wiki", "pages");
  await mkdir(pagesDir, { recursive: true });
  await writeFile(path.join(pagesDir, "existing-page.md"), "# Existing\n", "utf8");

  try {
    const createStats = (
      piAgent as {
        createAgentChatSessionStats?: (workspaceDir: string) => Promise<piAgent.AgentChatSessionStats>;
      }
    ).createAgentChatSessionStats;
    const recordStats = (
      piAgent as {
        recordAgentChatSessionStats?: (stats: piAgent.AgentChatSessionStats, event: AgentEvent) => void;
      }
    ).recordAgentChatSessionStats;
    const formatStats = (
      piAgent as {
        formatAgentChatSessionStats?: (stats: piAgent.AgentChatSessionStats) => string;
      }
    ).formatAgentChatSessionStats;
    const refreshQueue = (
      piAgent as {
        refreshAgentChatSessionDownloadQueue?: (stats: piAgent.AgentChatSessionStats) => Promise<void>;
      }
    ).refreshAgentChatSessionDownloadQueue;
    assert.equal(typeof createStats, "function");
    assert.equal(typeof recordStats, "function");
    assert.equal(typeof formatStats, "function");
    assert.equal(typeof refreshQueue, "function");

    const stats = await createStats!(workspace);
    const recordToolEnd = (toolName: string, details: unknown) => {
      recordStats!(stats, {
        type: "tool_execution_end",
        toolName,
        toolCallId: `${toolName}-call`,
        isError: false,
        result: {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details
        }
      } as AgentEvent);
    };

    recordToolEnd("download_paper", {
      status: "downloaded",
      canonicalId: "2401.01234",
      articleUrl: "https://arxiv.org/abs/2401.01234"
    });
    recordToolEnd("download_paper", {
      status: "extension_job_queued",
      jobId: "queued-1",
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659"
    });
    recordToolEnd("answer_research_question", {
      downloaded: [
        {
          status: "downloaded",
          paperKey: "arxiv-2601.00425"
        },
        {
          status: "extension_job_queued",
          jobId: "queued-2",
          articleUrl: "https://www.nature.com/articles/example"
        }
      ]
    });
    recordToolEnd("download_paper", {
      status: "downloaded",
      jobId: "queued-1",
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659"
    });
    recordToolEnd("build_wiki_page", {
      status: "written",
      page: {
        pagePath: "knowledge-base/wiki/pages/existing-page.md"
      }
    });
    recordToolEnd("build_wiki_page", {
      status: "written",
      page: {
        pagePath: "knowledge-base/wiki/pages/new-page.md"
      }
    });

    await mkdir(path.join(workspace, ".browser-profile"), { recursive: true });
    await writeFile(
      path.join(workspace, ".browser-profile", "paper-download-jobs.jsonl"),
      [
        JSON.stringify({
          jobId: "queued-2",
          recordedAt: "2026-04-30T00:00:00.000Z",
          status: "downloaded",
          articleUrl: "https://www.nature.com/articles/example",
          paperKey: "nature-example"
        })
      ].join("\n"),
      "utf8"
    );
    await refreshQueue!(stats);

    assert.equal(stats.downloadedPapers.size, 4);
    assert.equal(piAgent.getPendingDownloadQueueCount(stats), 0);
    assert.deepEqual([...stats.modifiedWikiPages], ["knowledge-base/wiki/pages/existing-page.md"]);
    assert.deepEqual([...stats.createdWikiPages], ["knowledge-base/wiki/pages/new-page.md"]);

    const output = formatStats!(stats);
    assert.match(output, /本次聊天下载论文: 4/);
    assert.match(output, /下载队列未完成: 0/);
    assert.match(output, /新建 wiki page: 1/);
    assert.match(output, /改动 wiki page: 1/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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

test("createReplEventHandler prints compact search tool details", () => {
  const handlerFactory = (
    piAgent as {
      createReplEventHandler?: (output: NodeJS.WriteStream) => (event: AgentEvent) => void;
    }
  ).createReplEventHandler;
  assert.equal(typeof handlerFactory, "function");

  const writes: string[] = [];
  const output: { write: (chunk: string | Uint8Array) => boolean } = {
    write: (chunk) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }
  };
  const handleEvent = handlerFactory!(output as NodeJS.WriteStream);

  handleEvent({
    type: "tool_execution_end",
    toolName: "search_papers",
    toolCallId: "call-search",
    isError: false,
    result: {
      content: [],
      details: {
        query: "latest superconducting quantum computing papers",
        maxResults: 3,
        count: 2,
        results: [
          {
            title: "A superconducting qubit paper",
            url: "https://journals.aps.org/prapplied/abstract/10.1103/example",
            summary: "A compact summary of the search result.",
            source: "aps",
            action: "authorized_download",
            canonicalId: "10.1103/example"
          }
        ]
      }
    }
  } as AgentEvent);

  const outputText = writes.join("");
  assert.match(outputText, /\[tool:end\] search_papers ok/);
  assert.match(outputText, /\[tool:search\] query: latest superconducting quantum computing papers/);
  assert.match(outputText, /\[tool:search\] results: 2, showing 1/);
  assert.match(outputText, /A superconducting qubit paper/);
  assert.match(outputText, /https:\/\/journals\.aps\.org\/prapplied\/abstract\/10\.1103\/example/);
});

test("createReplEventHandler prints tool progress updates", () => {
  const handlerFactory = (
    piAgent as {
      createReplEventHandler?: (output: NodeJS.WriteStream) => (event: AgentEvent) => void;
    }
  ).createReplEventHandler;
  assert.equal(typeof handlerFactory, "function");

  const writes: string[] = [];
  const output: { write: (chunk: string | Uint8Array) => boolean } = {
    write: (chunk) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }
  };
  const handleEvent = handlerFactory!(output as NodeJS.WriteStream);

  handleEvent({
    type: "tool_execution_update",
    toolName: "generate_paper_wiki_summary",
    toolCallId: "call-summary",
    args: { paperKey: "aps-target" },
    partialResult: {
      content: [{ type: "text", text: "Building summary evidence for aps-target." }],
      details: {
        progress: {
          stage: "building_evidence",
          paperKey: "aps-target",
          message: "Building summary evidence for aps-target."
        }
      }
    }
  } as AgentEvent);

  assert.match(
    writes.join(""),
    /\[tool:progress\] generate_paper_wiki_summary Building summary evidence for aps-target\./
  );
});

test("parseCliArgs accepts --base-url", () => {
  const parseCliArgs = (
    piAgent as {
      parseCliArgs?: (argv: string[]) => {
        provider?: string;
        model?: string;
        baseUrl?: string;
        mode: "chat" | "rpc";
        useSession: boolean;
        sessionDir?: string;
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
    mode: "chat",
    useSession: true,
    help: false
  });
});

test("parseCliArgs accepts RPC mode and session controls", () => {
  const parseCliArgs = (
    piAgent as {
      parseCliArgs?: (argv: string[]) => {
        mode: "chat" | "rpc";
        useSession: boolean;
        sessionDir?: string;
        help: boolean;
      };
    }
  ).parseCliArgs;
  assert.equal(typeof parseCliArgs, "function");

  const parsed = parseCliArgs!(["--mode", "rpc", "--session-dir", ".memory/pi-sessions/chat-1", "--no-session"]);

  assert.deepEqual(parsed, {
    mode: "rpc",
    useSession: false,
    sessionDir: ".memory/pi-sessions/chat-1",
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
