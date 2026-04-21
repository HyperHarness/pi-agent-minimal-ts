# Minimal Pi Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal runnable TypeScript agent script based on `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core`, with multi-turn conversation, real tool calling, and sandbox-safe automated tests.

**Architecture:** Keep the project small and explicit. A thin resolver chooses the initial model using `pi-ai` metadata and env-based auth discovery, `agentLoop()` drives tool-enabled conversation turns, and a readline REPL keeps session state in memory. Tests use the faux provider from `pi-ai` to validate the tool-call loop without paid API traffic.

**Tech Stack:** Node.js, TypeScript, Node built-in test runner, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`

---

### Task 1: Update project configuration for the pi-based agent

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

- [ ] **Step 1: Update package metadata and scripts for ESM and the new entrypoint**

```json
{
  "name": "pi-agent-minimal-ts",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test --test-isolation=none dist/test/**/*.test.js",
    "agent": "npm run build && node dist/src/pi-agent.js"
  }
}
```

- [ ] **Step 2: Install the agent dependencies**

Run: `npm install @mariozechner/pi-ai @mariozechner/pi-agent-core`

Expected: install completes successfully and updates `package-lock.json`

- [ ] **Step 3: Adjust the compiler and existing local imports for NodeNext ESM**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Keep the existing baseline sample module valid under ESM imports**

```ts
export function add(left: number, right: number): number {
  return left + right;
}
```

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/index.js";

test("add returns the sum of two numbers", () => {
  assert.equal(add(2, 3), 5);
});
```

### Task 2: Write failing tests for resolver behavior first

**Files:**
- Create: `test/agent/model-resolver.test.ts`
- Test: `test/agent/model-resolver.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@mariozechner/pi-ai";
import { resolveInitialModel, type ModelResolverOptions } from "../../src/agent/model-resolver.js";

function createModel(provider: string, id: string): Model {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    baseUrl: "https://example.test/v1"
  } as Model;
}

test("resolveInitialModel prefers explicit provider and model", () => {
  const availableModels = [
    createModel("openai", "gpt-5.4"),
    createModel("anthropic", "claude-opus-4-6")
  ];

  const result = resolveInitialModel({
    cliProvider: "anthropic",
    cliModel: "claude-opus-4-6",
    envProvider: undefined,
    envModel: undefined,
    availableModels,
    hasConfiguredAuth: () => true
  });

  assert.equal(result.provider, "anthropic");
  assert.equal(result.model.id, "claude-opus-4-6");
});

test("resolveInitialModel falls back to the preferred default model among authenticated providers", () => {
  const openai = createModel("openai", "gpt-5.4");
  const anthropic = createModel("anthropic", "claude-opus-4-6");

  const result = resolveInitialModel({
    cliProvider: undefined,
    cliModel: undefined,
    envProvider: undefined,
    envModel: undefined,
    availableModels: [anthropic, openai],
    hasConfiguredAuth: (provider) => provider === "openai" || provider === "anthropic"
  });

  assert.equal(result.provider, "anthropic");
  assert.equal(result.model.id, "claude-opus-4-6");
});

test("resolveInitialModel throws when no authenticated model is available", () => {
  assert.throws(() => {
    resolveInitialModel({
      cliProvider: undefined,
      cliModel: undefined,
      envProvider: undefined,
      envModel: undefined,
      availableModels: [createModel("openai", "gpt-5.4")],
      hasConfiguredAuth: () => false
    });
  }, /No usable model/i);
});
```

- [ ] **Step 2: Run the resolver test to verify it fails**

Run: `npm test`

Expected: FAIL because `src/agent/model-resolver.ts` does not exist yet

### Task 3: Implement the model resolver minimally

**Files:**
- Create: `src/agent/model-resolver.ts`
- Test: `test/agent/model-resolver.test.ts`

- [ ] **Step 1: Write the minimal resolver implementation**

```ts
import type { KnownProvider, Model } from "@mariozechner/pi-ai";

export interface ModelResolverOptions {
  cliProvider?: string;
  cliModel?: string;
  envProvider?: string;
  envModel?: string;
  availableModels: Model[];
  hasConfiguredAuth: (provider: string) => boolean;
}

export interface ResolvedModelSelection {
  provider: string;
  model: Model;
}

const DEFAULT_MODELS: Partial<Record<KnownProvider, string>> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-5.4",
  google: "gemini-2.5-pro",
  openrouter: "openai/gpt-5.1-codex",
  xai: "grok-4-fast-non-reasoning",
  groq: "openai/gpt-oss-120b",
  mistral: "devstral-medium-latest"
};

function findExactModel(provider: string | undefined, modelId: string, availableModels: Model[]): Model | undefined {
  const candidates = provider
    ? availableModels.filter((model) => model.provider === provider)
    : availableModels;
  return candidates.find((model) => model.id === modelId);
}

export function resolveInitialModel(options: ModelResolverOptions): ResolvedModelSelection {
  const explicitProvider = options.cliProvider ?? options.envProvider;
  const explicitModel = options.cliModel ?? options.envModel;

  if (explicitProvider && explicitModel) {
    const model = findExactModel(explicitProvider, explicitModel, options.availableModels);
    if (!model) {
      throw new Error(`Requested model not found: ${explicitProvider}/${explicitModel}`);
    }
    return { provider: explicitProvider, model };
  }

  const authenticatedModels = options.availableModels.filter((model) => options.hasConfiguredAuth(model.provider));
  if (authenticatedModels.length === 0) {
    throw new Error("No usable model found with configured authentication.");
  }

  for (const [provider, defaultModelId] of Object.entries(DEFAULT_MODELS)) {
    const model = authenticatedModels.find(
      (candidate) => candidate.provider === provider && candidate.id === defaultModelId,
    );
    if (model) {
      return { provider, model };
    }
  }

  const fallback = authenticatedModels[0];
  return { provider: fallback.provider, model: fallback };
}
```

- [ ] **Step 2: Run the resolver test to verify it passes**

Run: `npm test`

Expected: resolver tests pass and earlier baseline tests still pass

### Task 4: Write failing tests for the local tools

**Files:**
- Create: `test/agent/tools.test.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Write the failing tool tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTools } from "../../src/agent/tools.js";

test("read_file reads a UTF-8 file inside the workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const nested = path.join(workspace, "notes.txt");
  await writeFile(nested, "hello from workspace", "utf8");

  try {
    const tools = createTools(workspace);
    const readFileTool = tools.find((tool) => tool.name === "read_file");
    assert.ok(readFileTool);

    const result = await readFileTool.execute("call-1", { path: "notes.txt" }, undefined);
    assert.equal(result.content[0]?.type, "text");
    assert.match((result.content[0] as { text: string }).text, /hello from workspace/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file rejects escaping the workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace);
    const readFileTool = tools.find((tool) => tool.name === "read_file");
    assert.ok(readFileTool);

    await assert.rejects(
      () => readFileTool.execute("call-2", { path: "../secret.txt" }, undefined),
      /outside the workspace/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tool test to verify it fails**

Run: `npm test`

Expected: FAIL because `src/agent/tools.ts` does not exist yet

### Task 5: Implement the tool definitions minimally

**Files:**
- Create: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Write the minimal tool implementations**

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const getTimeSchema = Type.Object({
  timezone: Type.Optional(Type.String({ description: "Optional IANA timezone" }))
});

const readFileSchema = Type.Object({
  path: Type.String({ description: "Relative file path inside the workspace" })
});

type GetTimeArgs = Static<typeof getTimeSchema>;
type ReadFileArgs = Static<typeof readFileSchema>;

function assertInsideWorkspace(workspaceDir: string, requestedPath: string): string {
  if (!requestedPath.trim()) {
    throw new Error("Path is required.");
  }
  if (path.isAbsolute(requestedPath)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const resolved = path.resolve(workspaceDir, requestedPath);
  const relative = path.relative(workspaceDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Requested path is outside the workspace.");
  }
  return resolved;
}

export function createTools(workspaceDir: string): AgentTool[] {
  const getTimeTool: AgentTool<typeof getTimeSchema> = {
    name: "get_time",
    label: "Get Time",
    description: "Get the current time, optionally in a specific timezone.",
    parameters: getTimeSchema,
    execute: async (_toolCallId, args: GetTimeArgs) => {
      const formatter = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: args.timezone
      });
      return {
        content: [{ type: "text", text: formatter.format(new Date()) }],
        details: { timezone: args.timezone ?? "system" }
      };
    }
  };

  const readFileTool: AgentTool<typeof readFileSchema> = {
    name: "read_file",
    label: "Read File",
    description: "Read a UTF-8 text file inside the workspace.",
    parameters: readFileSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, args: ReadFileArgs) => {
      const filePath = assertInsideWorkspace(workspaceDir, args.path);
      const content = await readFile(filePath, "utf8");
      return {
        content: [{ type: "text", text: content }],
        details: { path: args.path }
      };
    }
  };

  return [getTimeTool, readFileTool];
}
```

- [ ] **Step 2: Run the tool test to verify it passes**

Run: `npm test`

Expected: resolver tests, tool tests, and baseline tests pass

### Task 6: Write the failing integration test for the agent loop

**Files:**
- Create: `test/agent/pi-agent.test.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Write the failing faux-provider integration test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider
} from "@mariozechner/pi-ai";
import { runAgentTurn } from "../../src/pi-agent.js";

test("runAgentTurn executes a tool call and appends the resulting messages", async () => {
  const registration = registerFauxProvider();
  registration.setResponses([
    fauxAssistantMessage([fauxToolCall("get_time", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Done using the tool.")])
  ]);

  const events: string[] = [];
  const context = {
    systemPrompt: "You are a helpful assistant.",
    messages: [],
    tools: []
  };

  try {
    const result = await runAgentTurn({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "What time is it?",
      onEvent: (event) => {
        events.push(event.type);
      }
    });

    assert.ok(events.includes("tool_execution_start"));
    assert.ok(events.includes("tool_execution_end"));
    assert.equal(result.newMessages[0]?.role, "user");
    assert.equal(result.newMessages[result.newMessages.length - 1]?.role, "assistant");
    assert.equal(context.messages.length, result.newMessages.length);
  } finally {
    registration.unregister();
  }
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `npm test`

Expected: FAIL because `src/pi-agent.ts` does not exist yet

### Task 7: Implement the minimal runnable agent script

**Files:**
- Create: `src/pi-agent.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Write the minimal reusable turn runner and REPL entrypoint**

```ts
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { getEnvApiKey, getModels, getProviders, type Message, type Model } from "@mariozechner/pi-ai";
import { agentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig } from "@mariozechner/pi-agent-core";
import { resolveInitialModel } from "./agent/model-resolver.js";
import { createTools } from "./agent/tools.js";

function toLlmMessages(messages: AgentContext["messages"]): Message[] {
  return messages.filter(
    (message): message is Message =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
}

function getAvailableModels(): Model[] {
  return getProviders().flatMap((provider) => getModels(provider));
}

export interface RunAgentTurnOptions {
  model: Model;
  workspaceDir: string;
  context: AgentContext;
  prompt: string;
  onEvent?: (event: AgentEvent) => void;
}

export async function runAgentTurn(options: RunAgentTurnOptions) {
  const userMessage = { role: "user" as const, content: options.prompt, timestamp: Date.now() };
  const config: AgentLoopConfig = {
    model: options.model,
    convertToLlm: async (messages) => toLlmMessages(messages),
    toolExecution: "sequential"
  };

  const stream = agentLoop([userMessage], {
    ...options.context,
    tools: createTools(options.workspaceDir)
  }, config);

  for await (const event of stream) {
    options.onEvent?.(event);
  }

  const newMessages = await stream.result();
  options.context.messages.push(...newMessages);
  options.context.tools = createTools(options.workspaceDir);
  return { newMessages };
}

function resolveCliArgs(argv: string[]) {
  let provider: string | undefined;
  let model: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--provider") {
      provider = argv[index + 1];
      index += 1;
    } else if (value === "--model") {
      model = argv[index + 1];
      index += 1;
    }
  }

  return { provider, model };
}

export async function main(argv = process.argv.slice(2)) {
  const { provider: cliProvider, model: cliModel } = resolveCliArgs(argv);
  const resolved = resolveInitialModel({
    cliProvider,
    cliModel,
    envProvider: process.env.PI_PROVIDER,
    envModel: process.env.PI_MODEL,
    availableModels: getAvailableModels(),
    hasConfiguredAuth: (provider) => getEnvApiKey(provider) !== undefined
  });

  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: createTools(process.cwd())
  };

  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const prompt = (await rl.question("> ")).trim();
      if (!prompt) continue;
      if (prompt === "exit" || prompt === "quit") break;

      await runAgentTurn({
        model: resolved.model,
        workspaceDir: process.cwd(),
        context,
        prompt,
        onEvent: (event) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            process.stdout.write(event.assistantMessageEvent.delta);
          }
          if (event.type === "tool_execution_start") {
            process.stdout.write(`\n[tool:start] ${event.toolName}\n`);
          }
          if (event.type === "tool_execution_end") {
            process.stdout.write(`\n[tool:end] ${event.toolName}\n`);
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            process.stdout.write("\n");
          }
        }
      });
    }
  } finally {
    rl.close();
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 2: Run the full test suite to verify it passes**

Run: `npm test`

Expected: all resolver, tool, integration, and baseline tests pass

### Task 8: Verify the runnable script behavior

**Files:**
- Modify: `package.json` if runtime adjustments are required
- Test: `src/pi-agent.ts`

- [ ] **Step 1: Run the agent entrypoint with an invalid model configuration to verify startup failure is clear**

Run: `node dist/src/pi-agent.js --provider openai --model definitely-not-a-real-model`

Expected: exits non-zero with a clear “Requested model not found” error

- [ ] **Step 2: Re-run the automated test command before completion**

Run: `npm test`

Expected: PASS with zero failing tests
