# Pi Agent REPL Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the REPL entrypoint so the agent remains independently runnable while its prompt loop becomes easier to automate and test.

**Architecture:** Keep `runAgentTurn()` as the low-level execution primitive, add a thin session/runtime layer that can process prompts without terminal dependencies, and make `main()` choose between interactive `readline` input and non-interactive stdin line consumption. This preserves the current CLI behavior while removing the REPL's tight coupling to a live terminal.

**Tech Stack:** Node.js, TypeScript, Node built-in test runner, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`

---

### Task 1: Add failing tests for prompt-session behavior

**Files:**
- Modify: `test/agent/pi-agent.test.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Add tests for stop commands and empty prompts**

```ts
test("runSessionPrompt stops on exit and quit commands", async () => {
  const runSessionPrompt = (
    piAgent as {
      runSessionPrompt?: (options: {
        model: Model<Api>;
        workspaceDir: string;
        context: AgentContext;
        prompt: string;
      }) => Promise<{ action: "continue" | "stop"; newMessages: AgentMessage[] }>;
    }
  ).runSessionPrompt;
  assert.equal(typeof runSessionPrompt, "function");

  const registration = registerFauxProvider();
  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: []
  };

  try {
    const exitResult = await runSessionPrompt!({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "exit"
    });
    const quitResult = await runSessionPrompt!({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "quit"
    });

    assert.equal(exitResult.action, "stop");
    assert.equal(quitResult.action, "stop");
    assert.deepEqual(exitResult.newMessages, []);
    assert.deepEqual(quitResult.newMessages, []);
  } finally {
    registration.unregister();
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
      }) => Promise<{ action: "continue" | "stop"; newMessages: AgentMessage[] }>;
    }
  ).runSessionPrompt;
  assert.equal(typeof runSessionPrompt, "function");

  const registration = registerFauxProvider();
  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Use tools when they are useful.",
    messages: [],
    tools: []
  };

  try {
    const result = await runSessionPrompt!({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "   "
    });

    assert.equal(result.action, "continue");
    assert.deepEqual(result.newMessages, []);
    assert.deepEqual(context.messages, []);
  } finally {
    registration.unregister();
  }
});
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `npm test -- --test-name-pattern "runSessionPrompt"`

Expected: FAIL because `runSessionPrompt` is not exported yet

### Task 2: Add failing tests for prompt-source helpers

**Files:**
- Modify: `test/agent/pi-agent.test.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Add tests for EOF handling and stdin line consumption**

```ts
test("readInteractivePrompt treats closed readline as a normal stop signal", async () => {
  const readInteractivePrompt = (
    piAgent as {
      readInteractivePrompt?: (repl: { question: (prompt: string) => Promise<string> }) => Promise<string | null>;
    }
  ).readInteractivePrompt;
  assert.equal(typeof readInteractivePrompt, "function");

  const closedReadline = {
    question: async () => {
      const error = new Error("readline was closed") as Error & { code?: string };
      error.code = "ERR_USE_AFTER_CLOSE";
      throw error;
    }
  };

  const result = await readInteractivePrompt!(closedReadline);
  assert.equal(result, null);
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

  const prompts: string[] = [];

  async function* lines(): AsyncIterable<string> {
    yield "first prompt";
    yield "";
    yield "second prompt";
    yield "exit";
    yield "third prompt";
  }

  await consumePromptLines!({
    lines: lines(),
    onPrompt: async (prompt) => {
      prompts.push(prompt);
      return { action: prompt === "exit" ? "stop" : "continue" };
    }
  });

  assert.deepEqual(prompts, ["first prompt", "second prompt", "exit"]);
});
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `npm test -- --test-name-pattern "readInteractivePrompt|consumePromptLines"`

Expected: FAIL because the prompt-source helpers do not exist yet

### Task 3: Implement the runtime/session helpers

**Files:**
- Modify: `src/pi-agent.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Add session result types and the prompt-processing helper**

```ts
export interface SessionPromptResult {
  action: "continue" | "stop";
  newMessages: AgentMessage[];
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
```

- [ ] **Step 2: Run the targeted test to verify it passes**

Run: `npm test -- --test-name-pattern "runSessionPrompt"`

Expected: PASS for the new session helper tests

### Task 4: Implement prompt-source helpers for interactive and stdin-driven use

**Files:**
- Modify: `src/pi-agent.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Add the interactive prompt reader and generic line consumer**

```ts
export async function readInteractivePrompt(repl: {
  question: (prompt: string) => Promise<string>;
}): Promise<string | null> {
  try {
    return await repl.question("> ");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_USE_AFTER_CLOSE"
    ) {
      return null;
    }

    throw error;
  }
}

export async function consumePromptLines(options: {
  lines: AsyncIterable<string>;
  onPrompt: (prompt: string) => Promise<{ action: "continue" | "stop" }>;
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
```

- [ ] **Step 2: Run the targeted test to verify it passes**

Run: `npm test -- --test-name-pattern "readInteractivePrompt|consumePromptLines"`

Expected: PASS for the new prompt-source helper tests

### Task 5: Wire `main()` to the new runtime boundaries

**Files:**
- Modify: `src/pi-agent.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Update `main()` to choose interactive or non-interactive mode**

```ts
const handlePrompt = async (prompt: string) =>
  runSessionPrompt({
    model: runtimeModel,
    workspaceDir: process.cwd(),
    context,
    prompt,
    onEvent: createReplEventHandler(process.stdout)
  });

if (process.stdin.isTTY) {
  try {
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
  } finally {
    repl.close();
  }
} else {
  try {
    await consumePromptLines({
      lines: repl,
      onPrompt: handlePrompt
    });
  } finally {
    repl.close();
  }
}
```

- [ ] **Step 2: Run the full test suite to verify everything still passes**

Run: `npm test`

Expected: PASS with zero failing tests

### Task 6: Verify the new non-interactive behavior manually

**Files:**
- Test: `src/pi-agent.ts`

- [ ] **Step 1: Run the agent with piped input and verify it exits cleanly**

Run: `@("hello", "exit") | npm.cmd run agent -- --provider openai --model gpt-5.4 --base-url https://bench.openq.top/v1`

Expected: the agent starts, handles at least one prompt, and exits without `ERR_USE_AFTER_CLOSE`

- [ ] **Step 2: Re-run the automated test command before completion**

Run: `npm test`

Expected: PASS with zero failing tests
