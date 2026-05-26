# Strict Agent CLI Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambiguous `agent` CLI with strict `wiki-agent` and `design-agent` entrypoints, with Feishu connected only to `wiki-agent`.

**Architecture:** Keep one shared runtime and CLI implementation, but pass a fixed entrypoint profile into it. `wiki-agent` runs with wiki/paper tools and non-design worker routing; `design-agent` runs directly with the design prompt and design tool boundary, with worker routing disabled.

**Tech Stack:** TypeScript ESM, Node test runner, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, existing local tool-boundary registry.

---

## File Structure

- Modify `src/agent/agent-runtime.ts`
  - Add a session routing policy so callers can allow all worker routes, allow only non-design wiki/paper routes, or disable worker routing.
  - Preserve the current router for internal compatibility tests, but let strict CLI entrypoints opt out of design routing.
- Modify `src/agent/agent-cli.ts`
  - Add `AgentEntrypointProfile = "wiki-agent" | "design-agent" | "routed-agent"`.
  - Initialize system prompt, tools, routing policy, and help text from the selected profile.
  - Keep shared chat/RPC code in one file.
- Create `src/wiki-agent.ts`
  - Thin executable wrapper around `main({ profile: "wiki-agent" })`.
- Create `src/design-agent.ts`
  - Thin executable wrapper around `main({ profile: "design-agent" })`.
- Modify `src/pi-agent.ts`
  - Stop acting as the documented public executable; keep library exports.
  - If direct execution remains for internal compatibility, default it to wiki-agent behavior rather than the old routed behavior.
- Modify `src/agent/tool-types.ts`
  - Tighten `wiki-agent` boundary to wiki/paper tools only and exclude design tools plus arbitrary write/compile tools.
  - Preserve `design-agent` read-only wiki/paper retrieval plus design-code/dependency/script/artifact tools.
- Modify `src/feishu-bridge/config.ts`
  - Change default built-in entrypoint from `dist/src/pi-agent.js` to `dist/src/wiki-agent.js`.
- Modify `package.json`
  - Remove `agent` and `agent:rpc`.
  - Add `wiki-agent`, `wiki-agent:rpc`, `design-agent`, and `design-agent:rpc`.
- Modify `README.md` and `docs/feishu-bridge.env.example`
  - Replace old `npm run agent` guidance with strict entrypoint guidance.
  - State Feishu only connects to `wiki-agent`.
- Modify tests:
  - `test/agent/pi-agent.test.ts` for runtime routing policy and profile behavior.
  - `test/agent/tools.test.ts` for strict tool boundaries.
  - `test/feishu-bridge/config.test.ts` for bridge default entrypoint.
  - `test/index.test.ts` only if public exports change.
  - Add a package-script assertion in an existing test file or a small new test.

## Task 1: Add Runtime Routing Policy

**Files:**
- Modify: `src/agent/agent-runtime.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Write failing tests for routing policy**

Add tests near the existing `runSessionPrompt routes design package requests to design-agent boundary` case:

```ts
test("runSessionPrompt can disable worker routing for fixed design-agent sessions", async () => {
  const registration = registerFauxProvider();
  registration.setResponses([fauxAssistantMessage([fauxText("Design session handled directly.")])]);
  const context: AgentContext = {
    systemPrompt: "design prompt",
    messages: [],
    tools: []
  };

  try {
    const result = await piAgent.runSessionPrompt({
      model: registration.getModel(),
      workspaceDir: process.cwd(),
      context,
      prompt: "design-agent install gdstk",
      workerRouting: "none"
    });

    assert.equal(result.action, "continue");
    assert.equal(result.newMessages.length, 2);
    assert.ok(isAssistantMessage(result.newMessages[1]));
    assert.ok(messageHasText(result.newMessages[1], "Design session handled directly."));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(result.newMessages)));
    assert.ok(!result.newMessages.some((message) => isAssistantMessage(message) && messageHasText(message, "worker_handoff")));
  } finally {
    registration.unregister();
  }
});

test("runSessionPrompt wiki routing policy refuses design worker handoff while keeping paper routing", async () => {
  const registration = registerFauxProvider();
  registration.setResponses([fauxAssistantMessage([fauxText("Wiki session handled design request as out of scope.")])]);
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
      prompt: "please ask design-agent to install the gdstk Python package",
      workerRouting: "wiki-paper"
    });
    assert.equal(designResult.action, "continue");
    assert.ok(
      !designResult.newMessages.some((message) =>
        isAssistantMessage(message) &&
        message.content.some((content) => content.type === "text" && content.text.includes('"role":"design-agent"'))
      )
    );
  } finally {
    registration.unregister();
  }
});
```

- [ ] **Step 2: Run targeted test and confirm it fails**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/pi-agent.test.js --test-name-pattern "worker routing|routing policy"
```

Expected: TypeScript fails because `workerRouting` is not defined on `RunAgentTurnOptions`, or tests fail because design prompts still route to design-agent.

- [ ] **Step 3: Implement routing policy**

In `src/agent/agent-runtime.ts`, add:

```ts
export type WorkerRoutingPolicy = "all" | "wiki-paper" | "none";

function isWorkerRouteAllowed(role: RoutedWorkerRole, policy: WorkerRoutingPolicy): boolean {
  const normalizedRole = normalizeWorkerRole(role);
  if (policy === "all") {
    return true;
  }
  if (policy === "none") {
    return false;
  }
  return (
    normalizedRole === "paper-writing-worker" ||
    normalizedRole === "paper-download-subagent" ||
    normalizedRole === "wiki-evidence-worker"
  );
}
```

Extend `RunAgentTurnOptions`:

```ts
export interface RunAgentTurnOptions {
  model: Model<Api>;
  workspaceDir: string;
  context: AgentContext;
  prompt: string;
  onEvent?: AgentMessageEventHandler;
  workerRouting?: WorkerRoutingPolicy;
}
```

Change the route block in `runSessionPrompt`:

```ts
  const workerRouting = options.workerRouting ?? "all";
  const routedWorker = workerRouting === "none" ? null : routeChatPromptToWorker(trimmedPrompt);
  if (routedWorker !== null && isWorkerRouteAllowed(routedWorker.role, workerRouting)) {
    const workerResult = await runRoutedWorkerPrompt({
      model: options.model,
      workspaceDir: options.workspaceDir,
      role: routedWorker.role,
      routeReason: routedWorker.reason,
      instruction: routedWorker.instruction,
      onEvent: options.onEvent
    });
```

Do not route disallowed workers; let the fixed agent profile answer with its own prompt and tools.

- [ ] **Step 4: Run targeted tests and commit**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/pi-agent.test.js --test-name-pattern "worker routing|routing policy|routes design package"
```

Expected: all selected tests pass.

Commit:

```bash
rtk git add src/agent/agent-runtime.ts test/agent/pi-agent.test.ts
rtk git commit -m "Add agent session routing policy"
```

## Task 2: Create Strict Entrypoint Profiles

**Files:**
- Modify: `src/agent/agent-cli.ts`
- Create: `src/wiki-agent.ts`
- Create: `src/design-agent.ts`
- Modify: `src/pi-agent.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Write failing tests for profile context and tools**

Add tests that import the CLI module and assert profile configuration without launching a real model:

```ts
test("agent CLI profiles initialize strict prompts, routing, and tool boundaries", async () => {
  const cli = await import("../../dist/src/agent/agent-cli.js") as {
    resolveAgentEntrypointProfile?: (profile: "wiki-agent" | "design-agent" | "routed-agent", workspaceDir: string, model: Model<Api>) => {
      systemPrompt: string;
      workerRouting: "all" | "wiki-paper" | "none";
      toolNames: string[];
    };
  };
  assert.equal(typeof cli.resolveAgentEntrypointProfile, "function");
  const registration = registerFauxProvider();
  try {
    const wiki = cli.resolveAgentEntrypointProfile!("wiki-agent", process.cwd(), registration.getModel());
    assert.equal(wiki.workerRouting, "wiki-paper");
    assert.match(wiki.systemPrompt, /wiki/i);
    assert.ok(wiki.toolNames.includes("build_wiki_page"));
    assert.ok(!wiki.toolNames.includes("update_design_dependency"));

    const design = cli.resolveAgentEntrypointProfile!("design-agent", process.cwd(), registration.getModel());
    assert.equal(design.workerRouting, "none");
    assert.match(design.systemPrompt, /design-agent/);
    assert.ok(design.toolNames.includes("sync_design_environment"));
    assert.ok(design.toolNames.includes("search_paper_wiki"));
    assert.ok(!design.toolNames.includes("build_wiki_page"));
  } finally {
    registration.unregister();
  }
});
```

- [ ] **Step 2: Run targeted test and confirm it fails**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/pi-agent.test.js --test-name-pattern "CLI profiles"
```

Expected: FAIL because `resolveAgentEntrypointProfile` does not exist.

- [ ] **Step 3: Implement profile resolution**

In `src/agent/agent-cli.ts`, update imports:

```ts
import { DEFAULT_SYSTEM_PROMPT, DESIGN_AGENT_SYSTEM_PROMPT } from "./agent-prompts.js";
import { cleanupTools, createTools, createToolsForBoundary, type ToolBoundaryRole } from "./tools.js";
import type { WorkerRoutingPolicy } from "./agent-runtime.js";
import { createQueuedPaperExtensionBridge } from "./paper/extension/paper-extension-bridge.js";
import { createWikiEvidenceWorker } from "./wiki/worker.js";
```

Add types and helper:

```ts
export type AgentEntrypointProfile = "wiki-agent" | "design-agent" | "routed-agent";

export interface ResolvedAgentEntrypointProfile {
  name: AgentEntrypointProfile;
  systemPrompt: string;
  workerRouting: WorkerRoutingPolicy;
  createTools: () => ReturnType<typeof createTools>;
  toolNames: string[];
}

function createProfileTools(profile: AgentEntrypointProfile, workspaceDir: string, model: Model<Api>) {
  if (profile === "design-agent") {
    return createToolsForBoundary(workspaceDir, "design-agent");
  }
  if (profile === "wiki-agent") {
    const wikiEvidenceWorker = createWikiEvidenceWorker(model, workspaceDir);
    return createToolsForBoundary(workspaceDir, "wiki-agent", {
      extensionBridge: createQueuedPaperExtensionBridge({ workspaceDir }),
      paperSummaryWorker: wikiEvidenceWorker.paperSummaryWorker,
      paperWikiPageWorker: wikiEvidenceWorker.paperWikiPageWorker
    });
  }
  const wikiEvidenceWorker = createWikiEvidenceWorker(model, workspaceDir);
  return createTools(workspaceDir, {
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
  const tools = createProfileTools(profile, workspaceDir, model);
  const systemPrompt = profile === "design-agent" ? DESIGN_AGENT_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT;
  const workerRouting: WorkerRoutingPolicy =
    profile === "design-agent" ? "none" : profile === "wiki-agent" ? "wiki-paper" : "all";
  return {
    name: profile,
    systemPrompt,
    workerRouting,
    createTools: () => createProfileTools(profile, workspaceDir, model),
    toolNames: tools.map((tool) => tool.name)
  };
}
```

- [ ] **Step 4: Wire profile into chat and RPC execution**

Change `main` signature:

```ts
export async function main(options: {
  argv?: string[];
  profile?: AgentEntrypointProfile;
} = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const profileName = options.profile ?? "wiki-agent";
```

Use `argv` in `parseCliArgs(argv)`. After `runtimeModel` is resolved, create a profile:

```ts
  const profile = resolveAgentEntrypointProfile(profileName, process.cwd(), runtimeModel);
```

Update `runRpcMode` options to include `profile: ResolvedAgentEntrypointProfile`, initialize:

```ts
  const context: AgentContext = {
    systemPrompt: options.profile.systemPrompt,
    messages: [],
    tools: options.profile.createTools()
  };
```

Pass routing:

```ts
workerRouting: options.profile.workerRouting
```

In chat mode, initialize:

```ts
  const context: AgentContext = {
    systemPrompt: profile.systemPrompt,
    messages: [],
    tools: profile.createTools()
  };
```

Pass `workerRouting: profile.workerRouting` into `runSessionPrompt`.

- [ ] **Step 5: Add thin entrypoint files**

Create `src/wiki-agent.ts`:

```ts
import process from "node:process";
import { pathToFileURL } from "node:url";
import { main } from "./agent/agent-cli.js";

function isDirectExecution(metaUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && metaUrl === pathToFileURL(entryPath).href;
}

export { main } from "./agent/agent-cli.js";

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main({ profile: "wiki-agent" }).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
```

Create `src/design-agent.ts`:

```ts
import process from "node:process";
import { pathToFileURL } from "node:url";
import { main } from "./agent/agent-cli.js";

function isDirectExecution(metaUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && metaUrl === pathToFileURL(entryPath).href;
}

export { main } from "./agent/agent-cli.js";

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main({ profile: "design-agent" }).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
```

Update direct execution in `src/pi-agent.ts`:

```ts
if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main({ profile: "wiki-agent" }).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 6: Run targeted tests and commit**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/pi-agent.test.js --test-name-pattern "CLI profiles|worker routing|routing policy"
```

Expected: all selected tests pass.

Commit:

```bash
rtk git add src/agent/agent-cli.ts src/wiki-agent.ts src/design-agent.ts src/pi-agent.ts test/agent/pi-agent.test.ts
rtk git commit -m "Add strict wiki and design agent entrypoint profiles"
```

## Task 3: Tighten Public Tool Boundaries

**Files:**
- Modify: `src/agent/tool-types.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Write failing boundary tests**

Extend `createToolsForBoundary exposes isolated wiki and worker tool surfaces`:

```ts
const wikiForbiddenTools = [
  "write_file",
  "replace_file_text",
  "delete_file",
  "compile_latex",
  "update_design_dependency",
  "sync_design_environment",
  "verify_design_python_import",
  "run_design_script",
  "write_design_code_file",
  "replace_design_code_file_text"
];
for (const toolName of wikiForbiddenTools) {
  assert.ok(!wikiAgentTools.some((tool) => tool.name === toolName), `wiki-agent must not expose ${toolName}`);
}
assert.ok(wikiAgentTools.some((tool) => tool.name === "download_paper"));
assert.ok(wikiAgentTools.some((tool) => tool.name === "build_wiki_page"));
assert.ok(wikiAgentTools.some((tool) => tool.name === "wiki_apply_structure_plan"));

const designForbiddenTools = [
  "build_wiki_page",
  "merge_wiki_aliases",
  "wiki_apply_structure_plan",
  "download_paper",
  "write_paper_wiki_source",
  "generate_paper_wiki_summary",
  "write_file"
];
for (const toolName of designForbiddenTools) {
  assert.ok(!designTools.some((tool) => tool.name === toolName), `design-agent must not expose ${toolName}`);
}
assert.ok(designTools.some((tool) => tool.name === "answer_paper_wiki_question"));
assert.ok(designTools.some((tool) => tool.name === "search_paper_wiki"));
assert.ok(designTools.some((tool) => tool.name === "sync_design_environment"));
```

- [ ] **Step 2: Run targeted test and confirm it fails**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/tools.test.js --test-name-pattern "isolated wiki and worker tool surfaces"
```

Expected: FAIL because current `wiki-agent` boundary still exposes `replace_file_text` and lacks `download_paper`.

- [ ] **Step 3: Update `wiki-agent` boundary**

In `src/agent/tool-types.ts`, set the `wiki-agent` tool list to:

```ts
  "wiki-agent": [
    "list_files",
    "read_file",
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
    "list_local_papers",
    "wiki_health",
    "wiki_lint",
    "wiki_structure_plan",
    "wiki_apply_structure_plan",
    "wiki_health_fix"
  ],
```

Keep `DESIGN_AGENT_TOOL_NAMES` unchanged except for adding tests that prove it has no wiki-write or paper-download tools.

- [ ] **Step 4: Run targeted tests and commit**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/tools.test.js --test-name-pattern "isolated wiki and worker tool surfaces|every boundary"
```

Expected: selected tests pass.

Commit:

```bash
rtk git add src/agent/tool-types.ts test/agent/tools.test.ts
rtk git commit -m "Tighten wiki and design agent tool boundaries"
```

## Task 4: Replace Public NPM Scripts And Feishu Default

**Files:**
- Modify: `package.json`
- Modify: `src/feishu-bridge/config.ts`
- Test: `test/feishu-bridge/config.test.ts`
- Test: add package-script assertions to `test/index.test.ts`

- [ ] **Step 1: Write failing tests for package scripts**

In `test/index.test.ts`, import `readFileSync` and add:

```ts
test("package scripts expose strict wiki and design agent entrypoints only", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.ok(pkg.scripts);
  assert.equal(pkg.scripts.agent, undefined);
  assert.equal(pkg.scripts["agent:rpc"], undefined);
  assert.equal(pkg.scripts["wiki-agent"], "npm run build && node dist/src/wiki-agent.js");
  assert.equal(pkg.scripts["wiki-agent:rpc"], "npm run build && node dist/src/wiki-agent.js --mode rpc");
  assert.equal(pkg.scripts["design-agent"], "npm run build && node dist/src/design-agent.js");
  assert.equal(pkg.scripts["design-agent:rpc"], "npm run build && node dist/src/design-agent.js --mode rpc");
});
```

Update `test/feishu-bridge/config.test.ts`:

```ts
test('loadConfig defaults the bridge to this repository wiki-agent RPC entrypoint', () => {
  const cwd = makeTempDir();
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
    },
    () => {
      const config = loadConfig(cwd);

      assert.equal(config.pi.command, process.execPath);
      assert.deepEqual(config.pi.commandArgs, [path.join(cwd, 'dist', 'src', 'wiki-agent.js')]);
    },
  );
});
```

- [ ] **Step 2: Run targeted tests and confirm they fail**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/index.test.js dist/test/feishu-bridge/config.test.js --test-name-pattern "strict wiki and design|wiki-agent RPC"
```

Expected: FAIL because package scripts and Feishu default still reference `pi-agent.js` / `agent:rpc`.

- [ ] **Step 3: Update package scripts**

In `package.json`, replace scripts:

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "test": "npm run build && node --test --experimental-test-isolation=none dist/test/**/*.test.js test/scripts/**/*.test.mjs",
  "wiki-agent": "npm run build && node dist/src/wiki-agent.js",
  "wiki-agent:rpc": "npm run build && node dist/src/wiki-agent.js --mode rpc",
  "design-agent": "npm run build && node dist/src/design-agent.js",
  "design-agent:rpc": "npm run build && node dist/src/design-agent.js --mode rpc",
  "feishu-bridge": "npm run build && node dist/src/feishu-bridge/index.js",
  "wiki:web": "node scripts/wiki-web.mjs",
  "paper-extension-host": "node dist/src/paper-extension-host.js"
}
```

- [ ] **Step 4: Update Feishu default entrypoint**

In `src/feishu-bridge/config.ts`, change `getDefaultAgentEntry` if it currently returns `dist/src/pi-agent.js`:

```ts
function getDefaultAgentEntry(cwd: string): string {
  return path.join(cwd, 'dist', 'src', 'wiki-agent.js');
}
```

Keep `PI_COMMAND` override behavior unchanged.

- [ ] **Step 5: Run targeted tests and commit**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/index.test.js dist/test/feishu-bridge/config.test.js --test-name-pattern "strict wiki and design|wiki-agent RPC|PI_COMMAND"
```

Expected: selected tests pass.

Commit:

```bash
rtk git add package.json src/feishu-bridge/config.ts test/index.test.ts test/feishu-bridge/config.test.ts
rtk git commit -m "Switch public scripts to strict agent entrypoints"
```

## Task 5: Update Documentation And Boundary Prompts

**Files:**
- Modify: `README.md`
- Modify: `docs/feishu-bridge.env.example`
- Modify: `src/agent/agent-prompts.ts` only if the default wiki prompt still advertises generic file/manuscript/code tools that are no longer available to `wiki-agent`.
- Test: `test/agent/pi-agent.test.ts` if prompt assertions need updates.

- [ ] **Step 1: Scan old documentation references**

Run:

```bash
rg -n "npm run agent|agent:rpc|dist/src/pi-agent\\.js|design-subagent|router automatically|If no worker route matches" README.md docs src test package.json
```

Expected: output lists only references that need removal or explicit compatibility notes.

- [ ] **Step 2: Update README entrypoint docs**

Replace old run examples with:

```md
npm run wiki-agent
npm run wiki-agent:rpc -- --provider openai --model gpt-5.4
npm run design-agent
```

Add a concise boundary section:

```md
The public CLI has two strict entrypoints:

- `npm run wiki-agent`: wiki and paper workflows. This is the Feishu bridge target. It can update wiki pages and paper-backed knowledge records, and it can read design-agent outputs for curation.
- `npm run design-agent`: design/code workflows. It can manage `design-repo/design-code`, declare dependencies, sync the root `.venv`, run bounded design scripts, and write design records/artifacts. It can retrieve wiki and local paper evidence, but it cannot write wiki pages.

`npm run agent` and `npm run agent:rpc` are intentionally not public scripts. Use the specific entrypoint that matches the work.
```

- [ ] **Step 3: Update Feishu env example**

In `docs/feishu-bridge.env.example`, replace old `PI_COMMAND` guidance with:

```env
# By default the bridge starts the repository wiki-agent RPC entrypoint.
# Override PI_COMMAND only if you provide a compatible JSONL RPC command.
# Design work should be run through npm run design-agent outside the Feishu bridge.
```

- [ ] **Step 4: Update prompt assertions if needed**

If `DEFAULT_SYSTEM_PROMPT` still says to use tools removed from the `wiki-agent` public surface, update it to describe wiki/paper scope and design boundary refusal. Then update assertions in `test/agent/pi-agent.test.ts` from generic file/manuscript expectations to wiki/paper expectations:

```ts
assert.match(DEFAULT_SYSTEM_PROMPT, /wiki/i);
assert.match(DEFAULT_SYSTEM_PROMPT, /paper/i);
assert.match(DEFAULT_SYSTEM_PROMPT, /design-agent/i);
assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /compile_latex/);
```

- [ ] **Step 5: Run doc reference scan and targeted tests, then commit**

Run:

```bash
rg -n "npm run agent|agent:rpc|dist/src/pi-agent\\.js" README.md docs package.json src test
npm run build && node --test --experimental-test-isolation=none dist/test/agent/pi-agent.test.js dist/test/index.test.js
```

Expected: `rg` has no stale public-entrypoint hits except intentional migration notes in specs/plans; tests pass.

Commit:

```bash
rtk git add README.md docs/feishu-bridge.env.example src/agent/agent-prompts.ts test/agent/pi-agent.test.ts
rtk git commit -m "Document strict wiki and design agent entrypoints"
```

## Task 6: Final Verification

**Files:**
- No planned code changes unless verification finds a real issue.

- [ ] **Step 1: Run full TypeScript test suite**

Run:

```bash
npm test
```

Expected:

```text
# fail 0
```

- [ ] **Step 2: Run design-code Python checks**

Run:

```bash
.venv/bin/python -m pytest design-repo/design-code/tests
.venv/bin/python -m ruff check design-repo/design-code/src design-repo/design-code/tests
```

Expected:

```text
1 passed
All checks passed!
```

- [ ] **Step 3: Run diff and status checks**

Run:

```bash
git diff --check
git status --short --branch
git -C design-repo/design-code status --short --branch
```

Expected:

```text
git diff --check has no output
main is ahead of origin/main by the new commits
design-repo/design-code has no uncommitted changes
```

- [ ] **Step 4: Final commit only if verification required fixes**

If verification required fixes, commit them:

```bash
rtk git add <fixed-files>
rtk git commit -m "Verify strict agent entrypoints"
```

If no fixes were needed, do not create an empty commit.

## Self-Review

- Spec coverage:
  - Removing `agent` / `agent:rpc`: Task 4.
  - New wiki/design CLI and RPC entrypoints: Tasks 2 and 4.
  - Feishu only connects to wiki-agent: Task 4 and Task 5.
  - Wiki-agent wiki/paper only and no design code tools: Tasks 1, 3, and 5.
  - Design-agent design/code only with read-only wiki/paper retrieval: Tasks 2 and 3.
  - Wiki/design collaboration through durable design outputs: Task 5 documentation, existing design artifact tools preserved in Task 3.
  - Shared runtime without duplicate CLI code: Task 2.
- Placeholder scan:
  - No TBD/TODO/implement-later placeholders.
  - Each task has concrete file paths, commands, expected results, and commit commands.
- Type consistency:
  - `WorkerRoutingPolicy` values are consistently `"all" | "wiki-paper" | "none"`.
  - `AgentEntrypointProfile` values are consistently `"wiki-agent" | "design-agent" | "routed-agent"`.
