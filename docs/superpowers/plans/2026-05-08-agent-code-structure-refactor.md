# Agent Code Structure Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the agent runtime code into focused modules while preserving all current agent behavior, tool surfaces, CLI/RPC protocol, and public exports.

**Architecture:** Keep `src/pi-agent.ts` as the executable compatibility facade. Move prompts, routing, runtime loop, CLI/RPC/session stats, and tool boundary metadata into focused modules under `src/agent/`, with one-way dependencies from CLI to runtime to routing/prompts/tools. Keep `createTools` implementation in `src/agent/tools.ts`.

**Tech Stack:** TypeScript ES modules, Node.js built-in test runner, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, existing `rtk npm test` workflow.

---

## File Structure

- Create: `src/agent/agent-prompts.ts`
  - Owns the five system prompt constants currently defined at the top of `src/pi-agent.ts`.
- Create: `src/agent/agent-routing.ts`
  - Owns worker role types, route matching, worker prompt lookup, handoff types, handoff path extraction, and handoff message construction.
- Create: `src/agent/agent-runtime.ts`
  - Owns `runAgentTurn`, `runSessionPrompt`, model-loop retry, tool-loop limiting, clean worker execution, and runtime tool creation.
- Create: `src/agent/agent-cli.ts`
  - Owns CLI args, model base URL override, RPC mode, REPL event formatting, chat session stats, stdin/interactive helpers, and `main`.
- Create: `src/agent/tool-boundaries.ts`
  - Owns `ToolProfile`, `ToolBoundaryRole`, tool-name metadata, boundary tool-name arrays, and `getToolBoundaryToolNames`.
- Modify: `src/pi-agent.ts`
  - Reduce to facade exports and direct-execution glue.
- Modify: `src/agent/tools.ts`
  - Import profile/boundary types and metadata from `tool-boundaries`; keep `createTools` and tool bodies in place.
- Modify: `test/index.test.ts`
  - Strengthen public export compatibility assertions.
- Modify: `test/agent/tools.test.ts`
  - Import `getToolBoundaryToolNames` from `tool-boundaries` as well as `tools.ts` to lock compatibility.
- Modify: `test/agent/pi-agent.test.ts`
  - Keep behavior tests importing from `src/pi-agent.ts`; add focused export identity checks for extracted modules when useful.

---

### Task 1: Add Compatibility Tests Before Moving Code

**Files:**
- Modify: `test/index.test.ts`
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Extend the public entrypoint export test**

In `test/index.test.ts`, add these imports:

```ts
import {
  DEFAULT_SYSTEM_PROMPT,
  PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT,
  PAPER_WRITING_WORKER_SYSTEM_PROMPT,
  WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT,
  DESIGN_SUBAGENT_SYSTEM_PROMPT,
  parsePaperWritingWorkerCommand,
  routeChatPromptToWorker,
  runSessionPrompt
} from "../src/pi-agent.js";
```

Then add these assertions inside `test("public entrypoint re-exports the reusable library APIs", ...)`:

```ts
assert.equal(publicApi.DEFAULT_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT);
assert.equal(publicApi.PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT, PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT);
assert.equal(publicApi.PAPER_WRITING_WORKER_SYSTEM_PROMPT, PAPER_WRITING_WORKER_SYSTEM_PROMPT);
assert.equal(publicApi.WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT, WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT);
assert.equal(publicApi.DESIGN_SUBAGENT_SYSTEM_PROMPT, DESIGN_SUBAGENT_SYSTEM_PROMPT);
assert.equal(publicApi.parsePaperWritingWorkerCommand, parsePaperWritingWorkerCommand);
assert.equal(publicApi.routeChatPromptToWorker, routeChatPromptToWorker);
assert.equal(publicApi.runSessionPrompt, runSessionPrompt);
```

- [ ] **Step 2: Run the focused export test before implementation**

Run:

```bash
rtk npm test -- --test-name-pattern "public entrypoint re-exports"
```

Expected: PASS. This proves the current facade contract before extraction.

- [ ] **Step 3: Add tool-boundary compatibility test**

In `test/agent/tools.test.ts`, change the import from `../../src/agent/tools.js` to keep the existing imports and add a second import:

```ts
import { getToolBoundaryToolNames as getToolBoundaryToolNamesFromBoundaryModule } from "../../src/agent/tool-boundaries.js";
```

Add this test near the existing boundary test:

```ts
test("tools module re-exports tool boundary names from the boundary module", () => {
  for (const role of [
    "wiki-agent",
    "paper-download-subagent",
    "wiki-evidence-worker",
    "design-subagent",
    "paper-writing-worker",
  ] as const) {
    assert.deepEqual(getToolBoundaryToolNames(role), getToolBoundaryToolNamesFromBoundaryModule(role));
  }
});
```

- [ ] **Step 4: Run the new boundary test and verify the expected red state**

Run:

```bash
rtk npm test -- --test-name-pattern "tools module re-exports tool boundary names"
```

Expected: FAIL with a module-not-found error for `src/agent/tool-boundaries.js`. This is the intended red test for the first extraction.

- [ ] **Step 5: Commit the tests after they are green in Task 2**

Do not commit after the red run. Commit after Task 2 makes these tests pass:

```bash
git add test/index.test.ts test/agent/tools.test.ts src/agent/tool-boundaries.ts src/agent/tools.ts
git commit -m "test: lock agent refactor compatibility contracts"
```

---

### Task 2: Extract Tool Boundary Metadata

**Files:**
- Create: `src/agent/tool-boundaries.ts`
- Modify: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Create the boundary metadata module**

Create `src/agent/tool-boundaries.ts` with the current `ToolProfile`, `ToolBoundaryRole`, `ToolName`, `TOOL_BOUNDARY_NAMES`, and `getToolBoundaryToolNames` declarations moved unchanged from `src/agent/tools.ts`.

The new file must start with this shape:

```ts
export type ToolProfile = "default" | "full";

export type ToolBoundaryRole =
  | "wiki-agent"
  | "paper-download-subagent"
  | "wiki-evidence-worker"
  | "design-subagent"
  | "paper-writing-worker";

type ToolName =
  | "answer_paper_wiki_question"
  | "answer_research_question"
  | "block_paper_download"
  | "bootstrap_wiki_page_evidence"
  | "build_wiki_page"
  | "clarify_research_topic"
  | "compile_latex"
  | "delete_file"
  | "download_paper"
  | "expand_research_topic"
  | "fetch_paper_webpage"
  | "fetch_url"
  | "generate_paper_wiki_summary"
  | "get_time"
  | "inspect_paper"
  | "list_files"
  | "list_local_papers"
  | "load_paper_writing_skill"
  | "merge_wiki_aliases"
  | "open_paper_page_for_login"
  | "paper_wiki_relations"
  | "parse_paper"
  | "read_file"
  | "read_paper_section"
  | "register_manual_paper_download"
  | "replace_file_text"
  | "research_topic_bootstrap"
  | "search_local_papers"
  | "search_paper_text"
  | "search_paper_wiki"
  | "search_papers"
  | "web_search"
  | "wiki_health"
  | "wiki_health_fix"
  | "wiki_lint"
  | "write_design_artifact"
  | "write_file"
  | "write_paper_wiki_source";
```

After that block, paste the existing `TOOL_BOUNDARY_NAMES` object exactly and export:

```ts
export function getToolBoundaryToolNames(role: ToolBoundaryRole): string[] {
  return [...TOOL_BOUNDARY_NAMES[role]];
}
```

- [ ] **Step 2: Import boundary metadata in `tools.ts`**

At the import section of `src/agent/tools.ts`, add:

```ts
import {
  getToolBoundaryToolNames as getToolBoundaryToolNamesFromBoundaryModule,
  TOOL_BOUNDARY_NAMES,
  type ToolBoundaryRole,
  type ToolProfile
} from "./tool-boundaries.js";
```

Remove the local `ToolProfile`, `ToolBoundaryRole`, `ToolName`, `TOOL_BOUNDARY_NAMES`, and `getToolBoundaryToolNames` declarations from `tools.ts`.

Add this compatibility export near the bottom of `tools.ts`:

```ts
export type { ToolBoundaryRole, ToolProfile } from "./tool-boundaries.js";

export function getToolBoundaryToolNames(role: ToolBoundaryRole): string[] {
  return getToolBoundaryToolNamesFromBoundaryModule(role);
}
```

- [ ] **Step 3: Run the boundary tests**

Run:

```bash
rtk npm test -- --test-name-pattern "createTools exposes|createTools full profile|createToolsForBoundary|tools module re-exports tool boundary names"
```

Expected: PASS.

- [ ] **Step 4: Commit Task 1 and Task 2 together**

Run:

```bash
git add test/index.test.ts test/agent/tools.test.ts src/agent/tool-boundaries.ts src/agent/tools.ts
git commit -m "refactor: extract tool boundary metadata"
```

---

### Task 3: Extract Prompt Constants

**Files:**
- Create: `src/agent/agent-prompts.ts`
- Modify: `src/pi-agent.ts`
- Test: `test/index.test.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Create `agent-prompts.ts`**

Move these complete constants from `src/pi-agent.ts` into `src/agent/agent-prompts.ts` unchanged:

- the full declaration starting with `export const DEFAULT_SYSTEM_PROMPT = [`
- the full declaration starting with `export const PAPER_WRITING_WORKER_SYSTEM_PROMPT = [`
- the full declaration starting with `export const WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT = [`
- the full declaration starting with `export const PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT = [`
- the full declaration starting with `export const DESIGN_SUBAGENT_SYSTEM_PROMPT = [`

The moved declarations must keep the exact current string arrays, order, punctuation, and `.join(" ")` calls from `src/pi-agent.ts`.

- [ ] **Step 2: Import and re-export prompts from `pi-agent.ts`**

In `src/pi-agent.ts`, replace the moved constant definitions with:

```ts
export {
  DEFAULT_SYSTEM_PROMPT,
  DESIGN_SUBAGENT_SYSTEM_PROMPT,
  PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT,
  PAPER_WRITING_WORKER_SYSTEM_PROMPT,
  WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT
} from "./agent/agent-prompts.js";

import {
  DEFAULT_SYSTEM_PROMPT,
  DESIGN_SUBAGENT_SYSTEM_PROMPT,
  PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT,
  PAPER_WRITING_WORKER_SYSTEM_PROMPT,
  WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT
} from "./agent/agent-prompts.js";
```

The import is still needed for local runtime functions until later tasks move those functions.

- [ ] **Step 3: Run focused prompt tests**

Run:

```bash
rtk npm test -- --test-name-pattern "default system prompt|router worker system prompts|paper writing worker system prompt|public entrypoint re-exports"
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add src/agent/agent-prompts.ts src/pi-agent.ts test/index.test.ts
git commit -m "refactor: extract agent prompt constants"
```

---

### Task 4: Extract Pure Worker Routing and Handoff Helpers

**Files:**
- Create: `src/agent/agent-routing.ts`
- Modify: `src/pi-agent.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Create `agent-routing.ts` with pure routing exports**

Move these declarations from `src/pi-agent.ts` to `src/agent/agent-routing.ts`:

```ts
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
  DESIGN_SUBAGENT_SYSTEM_PROMPT,
  PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT,
  PAPER_WRITING_WORKER_SYSTEM_PROMPT,
  WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT
} from "./agent-prompts.js";

export type RoutedWorkerRole =
  | "paper-writing-worker"
  | "paper-download-subagent"
  | "wiki-evidence-worker"
  | "design-subagent";
```

Also move these existing items unchanged:

- `RoutedWorkerPrompt`
- `WorkerHandoff`
- `parsePaperWritingWorkerCommand`
- `matchExplicitWorkerRoute`
- `routeChatPromptToWorker`
- `systemPromptForWorker`
- `addString`
- `firstString`
- `extractWorkerHandoffPaths`
- `nextOwnerForWorker`
- `createWorkerHandoffMessage`

Export these functions from `agent-routing.ts`:

```ts
export function parsePaperWritingWorkerCommand(text: string): string | null
export function routeChatPromptToWorker(text: string): RoutedWorkerPrompt | null
export function systemPromptForWorker(role: RoutedWorkerRole): string
export function extractWorkerHandoffPaths(
  toolName: string,
  details: unknown,
  handoff: {
    changedFiles: Set<string>;
    artifacts: Set<string>;
    sourcePaths: Set<string>;
    pagePaths: Set<string>;
    designRecords: Set<string>;
  }
): void
export function nextOwnerForWorker(role: RoutedWorkerRole): WorkerHandoff["nextSuggestedOwner"]
export function createWorkerHandoffMessage(handoff: WorkerHandoff): AssistantMessage
```

- [ ] **Step 2: Import routing helpers in `pi-agent.ts`**

Add this import in `src/pi-agent.ts`:

```ts
import {
  createWorkerHandoffMessage,
  extractWorkerHandoffPaths,
  nextOwnerForWorker,
  parsePaperWritingWorkerCommand,
  routeChatPromptToWorker,
  systemPromptForWorker,
  type RoutedWorkerPrompt,
  type RoutedWorkerRole,
  type WorkerHandoff
} from "./agent/agent-routing.js";
```

Re-export compatibility APIs:

```ts
export {
  parsePaperWritingWorkerCommand,
  routeChatPromptToWorker
} from "./agent/agent-routing.js";
export type {
  RoutedWorkerPrompt,
  RoutedWorkerRole,
  WorkerHandoff
} from "./agent/agent-routing.js";
```

Remove the duplicated local declarations from `pi-agent.ts`.

- [ ] **Step 3: Run routing/session focused tests**

Run:

```bash
rtk npm test -- --test-name-pattern "routes paper write commands|public entrypoint re-exports"
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add src/agent/agent-routing.ts src/pi-agent.ts
git commit -m "refactor: extract agent worker routing"
```

---

### Task 5: Extract Agent Runtime Loop

**Files:**
- Create: `src/agent/agent-runtime.ts`
- Modify: `src/pi-agent.ts`
- Test: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Create `agent-runtime.ts`**

Move these imports from `src/pi-agent.ts` into `src/agent/agent-runtime.ts` as needed:

```ts
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
import { createQueuedPaperExtensionBridge } from "./paper-extension-bridge.js";
import { cleanupTools, createTools, createToolsForBoundary, getToolsWorkspaceDir } from "./tools.js";
import type { PaperSummaryWorker, PaperSummaryWorkerOutput } from "./paper-summary.js";
import type { PaperWikiPageWorker, PaperWikiPageWorkerOutput } from "./paper-wiki/types.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT
} from "./agent-prompts.js";
import {
  createWorkerHandoffMessage,
  extractWorkerHandoffPaths,
  nextOwnerForWorker,
  routeChatPromptToWorker,
  systemPromptForWorker,
  type RoutedWorkerPrompt,
  type RoutedWorkerRole,
  type WorkerHandoff
} from "./agent-routing.js";
```

Move these declarations and functions from `src/pi-agent.ts` unchanged:

- `LlmMessage`
- `AgentMessageEventHandler`
- `RunAgentTurnOptions`
- `RunAgentTurnResult`
- `SessionPromptResult`
- `contextWorkspaceDirs`
- retry constants
- `isLlmMessage`
- `convertAgentMessagesToLlm`
- `getAssistantText`
- `isRecord`
- `compactOutputText`
- failed-turn helpers
- tool-loop limiter helpers
- `flushAgentEvents`
- `runAgentLoopAttempt`
- `extractJsonObject`
- `parsePaperSummaryWorkerOutput`
- `parsePaperWikiPageWorkerOutput`
- `runRoutedWorkerPrompt`
- `createWikiEvidenceWorker`
- `createRuntimeTools`
- `runSessionPrompt`
- `runAgentTurn`

Export `AgentMessageEventHandler`, `RunAgentTurnOptions`, `RunAgentTurnResult`, `SessionPromptResult`, `runSessionPrompt`, `runAgentTurn`, `getAssistantText`, `isRecord`, and `compactOutputText`.

- [ ] **Step 2: Re-export runtime APIs from `pi-agent.ts`**

In `src/pi-agent.ts`, add:

```ts
export {
  runAgentTurn,
  runSessionPrompt
} from "./agent/agent-runtime.js";
export type {
  AgentMessageEventHandler,
  RunAgentTurnOptions,
  RunAgentTurnResult,
  SessionPromptResult
} from "./agent/agent-runtime.js";
```

Import local runtime helpers still used by CLI code in `pi-agent.ts`:

```ts
import {
  compactOutputText,
  getAssistantText,
  isRecord,
  runSessionPrompt,
  type AgentMessageEventHandler,
  type SessionPromptResult
} from "./agent/agent-runtime.js";
```

Remove the moved runtime code from `pi-agent.ts`.

- [ ] **Step 3: Run runtime tests**

Run:

```bash
rtk npm test -- --test-name-pattern "runAgentTurn|runSessionPrompt|routes paper write commands|stops after ninety tool loops|retries transient"
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add src/agent/agent-runtime.ts src/pi-agent.ts
git commit -m "refactor: extract agent runtime loop"
```

---

### Task 6: Extract CLI, RPC, REPL, and Session Stats

**Files:**
- Create: `src/agent/agent-cli.ts`
- Modify: `src/pi-agent.ts`
- Test: `test/agent/pi-agent.test.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: Create `agent-cli.ts`**

Move these declarations and functions from `src/pi-agent.ts` to `src/agent/agent-cli.ts`:

- `CliArgs`
- `AgentChatSessionStats`
- `collectAvailableModels`
- `formatToolFieldValue`
- `formatToolFields`
- `formatToolStartSummary`
- `formatSearchToolDetails`
- `formatToolExecutionDetails`
- `formatToolProgressDetails`
- `normalizeBaseUrl`
- `normalizeWorkspaceDir`
- `normalizeRelativePath`
- `readInitialWikiPagePaths`
- `createAgentChatSessionStats`
- `getStringField`
- `getPaperIdentity`
- `recordPaperDownloadStats`
- `recordWikiPageStats`
- `recordAgentChatSessionStats`
- `getPendingDownloadQueueCount`
- `refreshAgentChatSessionDownloadQueue`
- `formatAgentChatSessionStats`
- `parseCliArgs`
- `writeRpcEvent`
- `extractRpcPromptMessage`
- `runRpcMode`
- `applyModelBaseUrlOverride`
- `createReplEventHandler`
- `isDirectExecution`
- `readInteractivePrompt`
- `consumePromptLines`
- `main`

Use these imports at the top of `agent-cli.ts`:

```ts
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
import { resolveInitialModel } from "./model-resolver.js";
import { configureEnvProxy } from "./env-proxy.js";
import { cleanupTools } from "./tools.js";
import { readPaperDownloadJobEvents, summarizePaperDownloadJobs } from "./paper-download-jobs.js";
import { DEFAULT_SYSTEM_PROMPT } from "./agent-prompts.js";
import {
  compactOutputText,
  getAssistantText,
  isRecord,
  runSessionPrompt,
  type AgentMessageEventHandler,
  type SessionPromptResult
} from "./agent-runtime.js";
```

Export the functions and types currently imported by tests from `src/pi-agent.ts`.

- [ ] **Step 2: Reduce `src/pi-agent.ts` to facade and direct-execution glue**

Replace the body of `src/pi-agent.ts` with this shape:

```ts
import { pathToFileURL } from "node:url";
import process from "node:process";
import { main } from "./agent/agent-cli.js";

export * from "./agent/agent-prompts.js";
export * from "./agent/agent-routing.js";
export * from "./agent/agent-runtime.js";
export {
  applyModelBaseUrlOverride,
  consumePromptLines,
  createAgentChatSessionStats,
  createReplEventHandler,
  formatAgentChatSessionStats,
  getPendingDownloadQueueCount,
  main,
  parseCliArgs,
  readInteractivePrompt,
  recordAgentChatSessionStats,
  refreshAgentChatSessionDownloadQueue
} from "./agent/agent-cli.js";
export type {
  AgentChatSessionStats,
  CliArgs
} from "./agent/agent-cli.js";

function isDirectExecution(metaUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && metaUrl === pathToFileURL(entryPath).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 3: Run CLI/session tests**

Run:

```bash
rtk npm test -- --test-name-pattern "parseCliArgs|createReplEventHandler|readInteractivePrompt|consumePromptLines|agent chat session stats|public entrypoint re-exports"
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
rtk npm test -- --test-name-pattern "public entrypoint re-exports"
```

Expected: PASS. This command includes the TypeScript build through the project `npm test` script.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/agent/agent-cli.ts src/pi-agent.ts test/index.test.ts
git commit -m "refactor: extract agent cli runtime"
```

---

### Task 7: Final Verification and Cleanup Review

**Files:**
- Inspect: `src/pi-agent.ts`
- Inspect: `src/agent/agent-prompts.ts`
- Inspect: `src/agent/agent-routing.ts`
- Inspect: `src/agent/agent-runtime.ts`
- Inspect: `src/agent/agent-cli.ts`
- Inspect: `src/agent/tool-boundaries.ts`
- Inspect: `src/agent/tools.ts`

- [ ] **Step 1: Check for accidental duplicate definitions**

Run:

```bash
rg -n "export const DEFAULT_SYSTEM_PROMPT|export type ToolProfile|function routeChatPromptToWorker|export async function runAgentTurn|export async function main" src/pi-agent.ts src/agent
```

Expected:

- prompt constants only in `src/agent/agent-prompts.ts`
- `ToolProfile` only in `src/agent/tool-boundaries.ts`
- `routeChatPromptToWorker` implementation only in `src/agent/agent-routing.ts`
- `runAgentTurn` implementation only in `src/agent/agent-runtime.ts`
- `main` implementation only in `src/agent/agent-cli.ts`

- [ ] **Step 2: Run focused behavioral verification**

Run:

```bash
rtk npm test -- --test-name-pattern "runSessionPrompt|routeChatPromptToWorker|createReplEventHandler|createTools exposes|createToolsForBoundary|public entrypoint re-exports"
```

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run:

```bash
rtk npm test
```

Expected: PASS.

If this fails with `listen EPERM: operation not permitted 127.0.0.1`, record that exact sandbox error and rerun the focused behavioral verification from Step 2 plus any failing non-network test by name.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git diff --stat HEAD
git diff -- src/pi-agent.ts src/agent/tools.ts src/agent/agent-prompts.ts src/agent/agent-routing.ts src/agent/agent-runtime.ts src/agent/agent-cli.ts src/agent/tool-boundaries.ts test/index.test.ts test/agent/tools.test.ts
```

Expected:

- `src/pi-agent.ts` is short and only contains facade/direct-execution glue.
- `src/agent/tools.ts` still contains `createTools` and tool implementation bodies.
- No prompt text, tool name, tool order, route regex, RPC event key, or REPL line format is intentionally changed.

- [ ] **Step 5: Commit final verification cleanup if needed**

If Step 4 finds formatting or import cleanup changes, commit them:

```bash
git add src test
git commit -m "refactor: finalize agent module split"
```

If there are no cleanup changes after the previous task commits, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: Tasks cover prompt extraction, routing extraction, runtime extraction, CLI/RPC/session extraction, tool boundary extraction, facade preservation, and final verification.
- Compatibility coverage: Tests preserve public exports, default/full profile ordering, worker boundary ordering, worker routing, session behavior, REPL formatting, and build behavior.
- Scope control: The plan keeps all tool implementation bodies in `src/agent/tools.ts` and does not change default capabilities or routing semantics.
- Verification: Focused tests run after each extraction, then `rtk npm test` runs at the end.
