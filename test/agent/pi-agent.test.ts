import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, AssistantMessage, Context, Model, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import {
  Type,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider
} from "@mariozechner/pi-ai";
import type { AgentContext, AgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentChatSessionStats } from "../../src/pi-agent.js";

async function resolveBuiltModuleUrl(relativePath: string): Promise<string> {
  const rootUrl = new URL("../..", import.meta.url);
  const primaryUrl = new URL(relativePath, rootUrl);
  try {
    await access(primaryUrl);
    return primaryUrl.href;
  } catch {
    return new URL(`dist/${relativePath}`, rootUrl).href;
  }
}

const piAgent: typeof import("../../src/pi-agent.js") = await import(await resolveBuiltModuleUrl("src/pi-agent.js"));
const agentCli: typeof import("../../src/agent/agent-cli.js") = await import(
  await resolveBuiltModuleUrl("src/agent/agent-cli.js")
);
const toolsModule: typeof import("../../src/agent/tools.js") = await import(
  await resolveBuiltModuleUrl("src/agent/tools.js")
);
const { cleanupTools } = toolsModule;
const { DEFAULT_SYSTEM_PROMPT, DESIGN_AGENT_SYSTEM_PROMPT, runAgentTurn } = piAgent;

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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value);
}

function parseWorkerHandoff(message: AssistantMessage): unknown {
  const text = message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  const json = text.match(/```json\s*([\s\S]*?)\s*```/)?.[1];
  assert.ok(json);
  return JSON.parse(json);
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
  assert.match(DEFAULT_SYSTEM_PROMPT, /wiki_lint/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /wiki_structure_plan/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /wiki_apply_structure_plan/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /cite/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /strict wiki-agent entrypoint/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /wiki and paper workflows/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /wiki_health_fix/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /source summaries/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /design-agent outputs/);
  assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /compile_latex/);
});

test("paper writing worker system prompt keeps manuscript edits in the worker boundary", () => {
  const prompt = (piAgent as { PAPER_WRITING_WORKER_SYSTEM_PROMPT?: string }).PAPER_WRITING_WORKER_SYSTEM_PROMPT;
  assert.equal(typeof prompt, "string");
  const promptText = prompt as string;
  assert.match(promptText, /paper-writing-worker/);
  assert.match(promptText, /load_paper_writing_skill/);
  assert.match(promptText, /compile_latex/);
  assert.match(promptText, /Do not download papers/);
});

test("router worker system prompts describe isolated responsibilities", () => {
  const wikiPrompt = (piAgent as { WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT?: string }).WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT;
  const downloadPrompt = (piAgent as { PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT?: string })
    .PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT;
  const designPrompt = (piAgent as { DESIGN_AGENT_SYSTEM_PROMPT?: string }).DESIGN_AGENT_SYSTEM_PROMPT;
  const legacyDesignPrompt = (piAgent as { DESIGN_SUBAGENT_SYSTEM_PROMPT?: string }).DESIGN_SUBAGENT_SYSTEM_PROMPT;
  assert.equal(typeof wikiPrompt, "string");
  assert.equal(typeof downloadPrompt, "string");
  assert.equal(typeof designPrompt, "string");
  assert.equal(legacyDesignPrompt, designPrompt);
  assert.match(wikiPrompt as string, /wiki-evidence-worker/);
  assert.match(wikiPrompt as string, /source-summary/);
  assert.match(downloadPrompt as string, /paper-download-subagent/);
  assert.match(downloadPrompt as string, /download_paper/);
  assert.match(downloadPrompt as string, /get_time first/);
  assert.match(downloadPrompt as string, /past N years/);
  assert.match(designPrompt as string, /design-agent/);
  assert.match(designPrompt as string, /layout-code/);
  assert.match(designPrompt as string, /design-repo\/design-code/);
  assert.match(designPrompt as string, /sync_design_environment/);
  assert.match(designPrompt as string, /root \.venv/);
  assert.match(designPrompt as string, /Do not install packages ad hoc with pip/);
  assert.match(designPrompt as string, /design-projects\/.*deprecated/);
});

test("agent CLI profiles initialize strict prompts, routing, and tool boundaries", async () => {
  const registration = registerFauxProvider();
  const workspaceDir = process.cwd();

  const wikiProfile = agentCli.resolveAgentEntrypointProfile(
    "wiki-agent",
    workspaceDir,
    registration.getModel()
  );
  const designProfile = agentCli.resolveAgentEntrypointProfile(
    "design-agent",
    workspaceDir,
    registration.getModel()
  );
  const routedProfile = agentCli.resolveAgentEntrypointProfile(
    "routed-agent",
    workspaceDir,
    registration.getModel()
  );

  assert.equal(wikiProfile.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  assert.equal(wikiProfile.workerRouting, "wiki-paper");
  assert.deepEqual(wikiProfile.toolNames, toolsModule.getToolBoundaryToolNames("wiki-agent"));

  assert.equal(designProfile.systemPrompt, DESIGN_AGENT_SYSTEM_PROMPT);
  assert.equal(designProfile.workerRouting, "none");
  assert.deepEqual(designProfile.toolNames, toolsModule.getToolBoundaryToolNames("design-agent"));

  assert.equal(routedProfile.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  assert.equal(routedProfile.workerRouting, "all");

  const wikiTools = wikiProfile.createTools();
  try {
    assert.deepEqual(wikiTools.map((tool) => tool.name), wikiProfile.toolNames);
    assert.deepEqual(wikiTools.map((tool) => tool.name), toolsModule.getToolBoundaryToolNames("wiki-agent"));
  } finally {
    await cleanupTools(wikiTools);
  }

  const designTools = designProfile.createTools();
  try {
    assert.deepEqual(designTools.map((tool) => tool.name), designProfile.toolNames);
    assert.deepEqual(designTools.map((tool) => tool.name), toolsModule.getToolBoundaryToolNames("design-agent"));
  } finally {
    await cleanupTools(designTools);
  }

  const routedTools = routedProfile.createTools();
  try {
    const routedToolNames = routedTools.map((tool) => tool.name);
    const defaultTools = toolsModule.createTools(workspaceDir);
    try {
      assert.deepEqual(routedToolNames, routedProfile.toolNames);
      assert.deepEqual(routedToolNames, defaultTools.map((tool) => tool.name));
      assert.ok(routedToolNames.includes("download_paper"));
      assert.ok(routedToolNames.includes("build_wiki_page"));
      assert.equal(routedToolNames.includes("sync_design_environment"), false);
      assert.equal(routedToolNames.includes("update_design_dependency"), false);
    } finally {
      await cleanupTools(defaultTools);
    }
  } finally {
    await cleanupTools(routedTools);
  }
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

test("runAgentTurn compacts oversized tool results only at the model boundary", async () => {
  const registration = registerFauxProvider();
  const prompt = "Use the large-result tool.";
  const largeText = `prefix-${"x".repeat(30000)}-suffix`;
  let modelBoundaryToolResultText = "";
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("large_result", {})], { stopReason: "toolUse" }),
    (llmContext: Context) => {
      const toolResult = llmContext.messages.find(
        (message): message is ToolResultMessage =>
          message.role === "toolResult" && message.toolName === "large_result"
      );
      assert.ok(toolResult);
      modelBoundaryToolResultText = toolResult.content
        .filter((content): content is Extract<ToolResultMessage["content"][number], { type: "text" }> =>
          content.type === "text"
        )
        .map((content) => content.text)
        .join("\n");
      return fauxAssistantMessage([fauxText("Large result handled.")]);
    }
  ]);

  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: [
      {
        name: "large_result",
        label: "Large Result",
        description: "Returns a large payload.",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: largeText }],
          details: { payload: largeText }
        })
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

    assert.ok(modelBoundaryToolResultText.length < largeText.length);
    assert.match(modelBoundaryToolResultText, /truncated/i);
    assert.equal(modelBoundaryToolResultText.includes("-suffix"), false);

    const toolResult = result.newMessages.find(
      (message): message is ToolResultMessage =>
        isToolResultMessage(message) && message.toolName === "large_result"
    );
    assert.ok(toolResult);
    assert.deepEqual(toolResult.content, [{ type: "text", text: largeText }]);
    assert.deepEqual(toolResult.details, { payload: largeText });

    const toolExecutionEnd = observedEvents.find(
      (event): event is ToolExecutionEndEvent =>
        event.type === "tool_execution_end" && event.toolName === "large_result"
    );
    assert.ok(toolExecutionEnd);
    assert.deepEqual(toolExecutionEnd.result.content, [{ type: "text", text: largeText }]);
    assert.deepEqual(toolExecutionEnd.result.details, { payload: largeText });
    assert.deepEqual(context.messages, result.newMessages);
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

test("runSessionPrompt routes paper write commands to the paper-writing worker boundary", async () => {
  const runSessionPrompt = (
    piAgent as {
      runSessionPrompt?: (options: {
        model: Model<Api>;
        workspaceDir: string;
        context: AgentContext;
        prompt: string;
        onEvent?: (event: AgentEvent) => void;
      }) => Promise<{ action: "stop" | "continue"; newMessages: AgentMessage[] }>;
    }
  ).runSessionPrompt;
  assert.equal(typeof runSessionPrompt, "function");

  const parsePaperWritingWorkerCommand = (
    piAgent as {
      parsePaperWritingWorkerCommand?: (text: string) => string | null;
    }
  ).parsePaperWritingWorkerCommand;
  const routeChatPromptToWorker = (
    piAgent as {
      routeChatPromptToWorker?: (text: string) => {
        role:
          | "paper-writing-worker"
          | "paper-download-subagent"
          | "wiki-evidence-worker"
          | "design-agent"
          | "design-subagent";
        instruction: string;
        reason: "explicit" | "intent";
      } | null;
    }
  ).routeChatPromptToWorker;
  assert.equal(typeof parsePaperWritingWorkerCommand, "function");
  assert.equal(typeof routeChatPromptToWorker, "function");
  assert.equal(parsePaperWritingWorkerCommand!("paper write polish the abstract"), "polish the abstract");
  assert.equal(parsePaperWritingWorkerCommand!("/paper-writing-worker 修改论文"), "修改论文");
  assert.equal(parsePaperWritingWorkerCommand!("同意，请你修改论文"), "同意，请你修改论文");
  assert.deepEqual(routeChatPromptToWorker!("让paper-writing-worker评审论文，找出问题点"), {
    role: "paper-writing-worker",
    instruction: "让paper-writing-worker评审论文，找出问题点",
    reason: "intent"
  });
  assert.deepEqual(routeChatPromptToWorker!("wiki evidence summarize local papers"), {
    role: "wiki-evidence-worker",
    instruction: "summarize local papers",
    reason: "explicit"
  });
  for (const prompt of ["补summaries", "补 summary", "补 source summaries", "补 source summary"]) {
    const routed = routeChatPromptToWorker!(prompt);
    assert.equal(routed?.role, "wiki-evidence-worker");
    assert.equal(routed?.reason, "intent");
    assert.match(routed?.instruction ?? "", /generate_paper_wiki_summary/);
    assert.match(routed?.instruction ?? "", /mode=write/);
  }
  assert.deepEqual(routeChatPromptToWorker!("paper download latest superconducting qubit chip design papers"), {
    role: "paper-download-subagent",
    instruction: "latest superconducting qubit chip design papers",
    reason: "explicit"
  });
  assert.deepEqual(routeChatPromptToWorker!("下载最新的超导量子芯片设计论文"), {
    role: "paper-download-subagent",
    instruction: "下载最新的超导量子芯片设计论文",
    reason: "intent"
  });
  assert.deepEqual(routeChatPromptToWorker!("design 写一个芯片设计 failure record"), {
    role: "design-agent",
    instruction: "写一个芯片设计 failure record",
    reason: "explicit"
  });
  assert.deepEqual(routeChatPromptToWorker!("design-agent 安装 gdsfactory"), {
    role: "design-agent",
    instruction: "安装 gdsfactory",
    reason: "explicit"
  });
  assert.deepEqual(routeChatPromptToWorker!("design subagent 安装 gdsfactory"), {
    role: "design-agent",
    instruction: "安装 gdsfactory",
    reason: "explicit"
  });
  assert.deepEqual(routeChatPromptToWorker!("请让design subagent安装gdsfactory这个python包"), {
    role: "design-agent",
    instruction: "请让design subagent安装gdsfactory这个python包",
    reason: "intent"
  });
  assert.deepEqual(routeChatPromptToWorker!("请同步 design-repo/design-code 的 uv 环境"), {
    role: "design-agent",
    instruction: "请同步 design-repo/design-code 的 uv 环境",
    reason: "intent"
  });
  assert.deepEqual(routeChatPromptToWorker!("update design-code python dependency"), {
    role: "design-agent",
    instruction: "update design-code python dependency",
    reason: "intent"
  });
  assert.deepEqual(routeChatPromptToWorker!("check pyproject dependencies for gdsfactory layout"), {
    role: "design-agent",
    instruction: "check pyproject dependencies for gdsfactory layout",
    reason: "intent"
  });
  assert.equal(routeChatPromptToWorker!("sync uv environment"), null);
  assert.equal(routeChatPromptToWorker!("update python dependency"), null);
  assert.equal(routeChatPromptToWorker!("install python package"), null);
  assert.equal(routeChatPromptToWorker!("check pyproject dependencies"), null);
  assert.equal(routeChatPromptToWorker!("请解释一下router layer的设计"), null);

  const registration = registerFauxProvider();
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-paper-writing-worker-"));
  const skillDir = path.join(workspace, "skills", "paper-writing-worker", "sciwrite");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "prompt.md"), "SciWrite local prompt.", "utf8");
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("load_paper_writing_skill", { skillName: "sciwrite" })], {
      stopReason: "toolUse"
    }),
    fauxAssistantMessage([fauxToolCall("write_file", { path: "demo.txt", content: "edited manuscript" })], {
      stopReason: "toolUse"
    }),
    fauxAssistantMessage([fauxText("Paper-writing worker finished.")])
  ]);

  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: []
  };
  const observedEvents: AgentEvent[] = [];

  try {
    const result = await runSessionPrompt!({
      model: registration.getModel(),
      workspaceDir: workspace,
      context,
      prompt: "paper write polish the manuscript",
      onEvent: (event) => {
        observedEvents.push(event);
      }
    });

    assert.equal(result.action, "continue");
    assert.ok(
      observedEvents.some(
        (event) => event.type === "tool_execution_start" && event.toolName === "load_paper_writing_skill"
      )
    );
    assert.ok(
      observedEvents.some(
        (event): event is ToolExecutionEndEvent =>
          event.type === "tool_execution_end" &&
          event.toolName === "load_paper_writing_skill" &&
          !event.isError
      )
    );
    assert.ok(
      observedEvents.some(
        (event): event is ToolExecutionEndEvent =>
          event.type === "tool_execution_end" &&
          event.toolName === "write_file" &&
          !event.isError
      )
    );
    assert.deepEqual(context.tools, []);
    assert.equal(result.newMessages.length, 2);
    assert.ok(isUserMessage(result.newMessages[0]));
    assert.ok(isAssistantMessage(result.newMessages[1]));
    const handoff = parseWorkerHandoff(result.newMessages[1]) as {
      role?: string;
      status?: string;
      changedFiles?: string[];
      toolsUsed?: string[];
      finalResponse?: string;
      nextSuggestedOwner?: string;
    };
    assert.equal(handoff.role, "paper-writing-worker");
    assert.equal(handoff.status, "completed");
    assert.deepEqual(handoff.changedFiles, ["demo.txt"]);
    assert.deepEqual(handoff.toolsUsed, ["load_paper_writing_skill", "write_file"]);
    assert.equal(handoff.finalResponse, "Paper-writing worker finished.");
    assert.equal(handoff.nextSuggestedOwner, "wiki-agent");
    assert.deepEqual(context.messages, result.newMessages);
  } finally {
    registration.unregister();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runSessionPrompt routes design package requests to design-agent boundary", async () => {
  const registration = registerFauxProvider();
  registration.setResponses([
    fauxAssistantMessage([fauxText("Design dependency checked.")])
  ]);

  const context: AgentContext = {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    messages: [],
    tools: []
  };

  try {
    const result = await piAgent.runSessionPrompt({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "请让design subagent安装gdsfactory这个python包"
    });

    const handoff = result.newMessages
      .filter(isAssistantMessage)
      .map((message) => {
        try {
          return parseWorkerHandoff(message) as { role?: string; instruction?: string };
        } catch {
          return undefined;
        }
      })
      .find((candidate) => candidate?.role === "design-agent");

    assert.ok(handoff);
    assert.equal(handoff.instruction, "请让design subagent安装gdsfactory这个python包");
  } finally {
    registration.unregister();
  }
});

test("runSessionPrompt can disable worker routing for fixed design-agent sessions", async () => {
  const registration = registerFauxProvider();
  registration.setResponses([
    fauxAssistantMessage([fauxText("Handled inside the fixed design-agent session.")])
  ]);

  const context: AgentContext = {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    messages: [],
    tools: []
  };

  try {
    const result = await piAgent.runSessionPrompt({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "请让design subagent安装gdsfactory这个python包",
      workerRouting: "none"
    });

    const assistantMessages = result.newMessages.filter(isAssistantMessage);
    assert.ok(
      assistantMessages.some((message) => messageHasText(message, "Handled inside the fixed design-agent session."))
    );
    assert.equal(
      assistantMessages.some((message) => JSON.stringify(message.content).includes("worker_handoff")),
      false
    );
    assert.equal(
      assistantMessages.some((message) => JSON.stringify(message.content).includes('"role":"design-agent"')),
      false
    );
    assert.deepEqual(
      (context.tools ?? []).map((tool) => tool.name),
      toolsModule.getToolBoundaryToolNames("design-agent")
    );
  } finally {
    await cleanupTools(context.tools);
    registration.unregister();
  }
});

test("runSessionPrompt wiki routing policy refuses design worker handoff while keeping paper routing", async () => {
  const registration = registerFauxProvider();
  registration.setResponses([
    fauxAssistantMessage([fauxText("Handled without design handoff.")]),
    fauxAssistantMessage([fauxText("Paper worker finished under wiki policy.")])
  ]);

  const context: AgentContext = {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    messages: [],
    tools: []
  };

  try {
    const designResult = await piAgent.runSessionPrompt({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "请让design subagent安装gdsfactory这个python包",
      workerRouting: "wiki-paper"
    });

    const designAssistantMessages = designResult.newMessages.filter(isAssistantMessage);
    assert.ok(
      designAssistantMessages.some((message) => messageHasText(message, "Handled without design handoff."))
    );
    assert.equal(
      designAssistantMessages.some((message) => JSON.stringify(message.content).includes("worker_handoff")),
      false
    );
    assert.equal(
      designAssistantMessages.some((message) => JSON.stringify(message.content).includes('"role":"design-agent"')),
      false
    );
    assert.deepEqual(
      (context.tools ?? []).map((tool) => tool.name),
      toolsModule.getToolBoundaryToolNames("wiki-agent")
    );

    const paperResult = await piAgent.runSessionPrompt({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "paper write revise the abstract",
      workerRouting: "wiki-paper"
    });

    const handoff = paperResult.newMessages
      .filter(isAssistantMessage)
      .map((message) => {
        try {
          return parseWorkerHandoff(message) as { role?: string; finalResponse?: string };
        } catch {
          return undefined;
        }
      })
      .find((candidate) => candidate?.role === "paper-writing-worker");

    assert.ok(handoff);
    assert.equal(handoff.finalResponse, "Paper worker finished under wiki policy.");
  } finally {
    await cleanupTools(context.tools);
    registration.unregister();
  }
});

test("runSessionPrompt paper download worker queues browser extension jobs", async () => {
  const runSessionPrompt = (
    piAgent as {
      runSessionPrompt?: (options: {
        model: Model<Api>;
        workspaceDir: string;
        context: AgentContext;
        prompt: string;
        onEvent?: (event: AgentEvent) => void;
      }) => Promise<{ action: "stop" | "continue"; newMessages: AgentMessage[] }>;
    }
  ).runSessionPrompt;
  assert.equal(typeof runSessionPrompt, "function");

  const registration = registerFauxProvider();
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-paper-download-worker-"));
  const articleUrl = "https://example.com/research/paper";
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("download_paper", { url: articleUrl })], {
      stopReason: "toolUse"
    }),
    fauxAssistantMessage([fauxText("Queued by paper-download-subagent.")])
  ]);

  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: []
  };
  const observedEvents: AgentEvent[] = [];

  try {
    const result = await runSessionPrompt!({
      model: registration.getModel(),
      workspaceDir: workspace,
      context,
      prompt: `paper download ${articleUrl}`,
      onEvent: (event) => {
        observedEvents.push(event);
      }
    });

    assert.equal(result.action, "continue");
    const toolExecutionEnd = observedEvents.find(
      (event): event is ToolExecutionEndEvent =>
        event.type === "tool_execution_end" &&
        event.toolName === "download_paper" &&
        !event.isError
    );
    assert.ok(toolExecutionEnd);
    const details = toolExecutionEnd.result.details as { status?: string; jobId?: string; articleUrl?: string };
    assert.equal(details.status, "extension_job_queued");
    assert.equal(details.articleUrl, articleUrl);
    assert.equal(typeof details.jobId, "string");

    const jobsPath = path.join(workspace, ".browser-profile", "paper-download-jobs.jsonl");
    const rawJobs = await readFile(jobsPath, "utf8");
    assert.match(rawJobs, /"status":"queued"/);
    assert.match(rawJobs, /"source":"external"/);
    assert.match(rawJobs, new RegExp(articleUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const handoff = parseWorkerHandoff(result.newMessages[1] as AssistantMessage) as {
      role?: string;
      toolsUsed?: string[];
    };
    assert.equal(handoff.role, "paper-download-subagent");
    assert.deepEqual(handoff.toolsUsed, ["download_paper"]);
  } finally {
    registration.unregister();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runSessionPrompt routes summary backfill through a configured wiki evidence summary worker", async () => {
  const runSessionPrompt = (
    piAgent as {
      runSessionPrompt?: (options: {
        model: Model<Api>;
        workspaceDir: string;
        context: AgentContext;
        prompt: string;
        onEvent?: (event: AgentEvent) => void;
      }) => Promise<{ action: "stop" | "continue"; newMessages: AgentMessage[] }>;
    }
  ).runSessionPrompt;
  assert.equal(typeof runSessionPrompt, "function");

  const registration = registerFauxProvider();
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-summary-worker-"));
  const paperKey = "nature-s41586-026-10658-6";
  const parseDir = path.join(
    workspace,
    "knowledge-base",
    "sources",
    paperKey,
    "parses",
    "opendataloader-local"
  );
  registration.setResponses([
    fauxAssistantMessage([
      fauxToolCall("generate_paper_wiki_summary", { paperKey, mode: "write" })
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([
      fauxText(JSON.stringify({
        title: "An AI system to help scientists write expert-level empirical software",
        summaryMarkdown: "Grounded source summary from the clean wiki-evidence-worker summary pass.",
        tags: ["ai-scientist"],
        keyFindings: ["The system supports empirical scientific software work."],
        evidenceAnchors: [
          {
            summary: "The paper studies AI support for empirical software.",
            quote: "empirical scientific software",
            paperKey,
            sectionId: "abstract",
            page: 1
          }
        ],
        limitations: [],
        openQuestions: [],
        relatedPaperKeys: [],
        confidence: "high",
        groundingWarnings: []
      }))
    ]),
    fauxAssistantMessage([fauxText("Summaries backfilled.")])
  ]);

  const context: AgentContext = {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    messages: [],
    tools: []
  };
  const observedEvents: AgentEvent[] = [];

  try {
    await writeJson(path.join(workspace, "knowledge-base", "sources", paperKey, "source.json"), {
      paperKey,
      source: "nature",
      canonicalId: "s41586-026-10658-6",
      articleUrl: "https://www.nature.com/articles/s41586-026-10658-6",
      title: "An AI system to help scientists write expert-level empirical software"
    });
    await writeText(path.join(parseDir, "document.md"), [
      "# Abstract",
      "",
      "This paper studies empirical scientific software.",
      "",
      "# Main",
      "",
      "The AI system helps scientists write expert-level empirical scientific software."
    ].join("\n"));
    await writeJson(path.join(parseDir, "parse.json"), {
      paperKey,
      engine: "opendataloader-local",
      pdfSha256: "sha-summary-worker",
      createdAt: "2026-05-25T00:00:00.000Z",
      pages: 1,
      elements: [],
      sections: [
        {
          id: "abstract",
          title: "Abstract",
          level: 1,
          pageFrom: 1,
          pageTo: 1
        }
      ]
    });
    await writeJson(path.join(parseDir, "quality.json"), {
      status: "good",
      score: 0.95,
      pages: 1,
      totalTextLength: 1200,
      emptyPageCount: 0,
      headingCount: 2,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: []
    });
    await writeText(
      path.join(workspace, "knowledge-base", "sources", paperKey, "chunks", "opendataloader-local.jsonl"),
      "{\"id\":\"chunk-1\"}\n"
    );

    const result = await runSessionPrompt!({
      model: registration.getModel(),
      workspaceDir: workspace,
      context,
      prompt: "补summaries",
      onEvent: (event) => {
        observedEvents.push(event);
      }
    });

    assert.equal(result.action, "continue");
    const summaryToolEnd = observedEvents.find(
      (event): event is ToolExecutionEndEvent =>
        event.type === "tool_execution_end" &&
        event.toolName === "generate_paper_wiki_summary" &&
        !event.isError
    );
    assert.ok(summaryToolEnd);
    assert.equal((summaryToolEnd.result.details as { status?: string }).status, "written");
    assert.match(
      await readFile(path.join(workspace, "knowledge-base", "sources", paperKey, "summary.md"), "utf8"),
      /Grounded source summary from the clean wiki-evidence-worker summary pass/
    );
  } finally {
    registration.unregister();
    await rm(workspace, { recursive: true, force: true });
  }
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
  const pagesDir = path.join(workspace, "knowledge-base", "pages");
  await mkdir(pagesDir, { recursive: true });
  await writeFile(path.join(pagesDir, "existing-page.md"), "# Existing\n", "utf8");

  try {
    const createStats = (
      piAgent as {
        createAgentChatSessionStats?: (workspaceDir: string) => Promise<AgentChatSessionStats>;
      }
    ).createAgentChatSessionStats;
    const recordStats = (
      piAgent as {
        recordAgentChatSessionStats?: (stats: AgentChatSessionStats, event: AgentEvent) => void;
      }
    ).recordAgentChatSessionStats;
    const formatStats = (
      piAgent as {
        formatAgentChatSessionStats?: (stats: AgentChatSessionStats) => string;
      }
    ).formatAgentChatSessionStats;
    const refreshQueue = (
      piAgent as {
        refreshAgentChatSessionDownloadQueue?: (stats: AgentChatSessionStats) => Promise<void>;
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
        pagePath: "knowledge-base/pages/existing-page.md"
      }
    });
    recordToolEnd("build_wiki_page", {
      status: "written",
      page: {
        pagePath: "knowledge-base/pages/new-page.md"
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
    assert.deepEqual([...stats.modifiedWikiPages], ["knowledge-base/pages/existing-page.md"]);
    assert.deepEqual([...stats.createdWikiPages], ["knowledge-base/pages/new-page.md"]);

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

test("createReplEventHandler prints file tool paths in start lines only", () => {
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
    type: "tool_execution_start",
    toolName: "write_file",
    toolCallId: "call-write",
    args: { path: "paper-projects/main.tex", content: "..." }
  } as AgentEvent);
  handleEvent({
    type: "tool_execution_end",
    toolName: "write_file",
    toolCallId: "call-write",
    isError: false,
    result: {
      content: [{ type: "text", text: "Wrote paper-projects/main.tex." }],
      details: { path: "paper-projects/main.tex", bytes: 1234 }
    }
  } as AgentEvent);

  const outputText = writes.join("");
  assert.match(outputText, /\[tool:start\] write_file path=paper-projects\/main\.tex/);
  assert.match(outputText, /\[tool:end\] write_file ok\n/);
  assert.doesNotMatch(outputText, /\[tool:end\] write_file ok .*path=/);
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
