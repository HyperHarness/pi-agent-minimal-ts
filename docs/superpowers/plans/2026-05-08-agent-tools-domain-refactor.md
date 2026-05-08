# Agent Tools Domain Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/agent/tools.ts` into focused tool-domain modules without changing tool behavior, ordering, profiles, or worker boundaries.

**Architecture:** `src/agent/tools.ts` remains the public assembly facade for `createTools()` and `createToolsForBoundary()`. New domain modules create tools for one responsibility area and import shared construction types from `src/agent/tool-types.ts`; domain modules must not import from `src/agent/tools.ts`.

**Tech Stack:** TypeScript ESM, `@mariozechner/pi-ai` schemas, `@mariozechner/pi-agent-core` tools, Node built-in test runner via `rtk npm test`.

---

## File Structure

- Create `src/agent/tool-types.ts`: shared dependency, metadata, and domain factory types.
- Create `src/agent/file-tools.ts`: workspace file, time, skill loading, and LaTeX compile tools.
- Create `src/agent/web-tools.ts`: `web_search`, `fetch_url`, and `fetch_paper_webpage`.
- Create `src/agent/paper-tools.ts`: paper search, download, blocklist, manual registration, login open, parse, inspect, section read, and text search tools.
- Create `src/agent/design-tools.ts`: `write_design_artifact`.
- Create `src/agent/library-health-tools.ts`: local paper listing/search and wiki health tools.
- Create `src/agent/wiki-tools.ts`: wiki source, summary, relations, search, question answering, research, bootstrap, page build, alias merge, research topic, and lint tools.
- Modify `src/agent/tools.ts`: keep assembly, profile selection, boundary filtering, cleanup metadata helpers, and compatibility exports.
- Modify `test/agent/tools.test.ts`: strengthen ordered tool-name and boundary characterization tests.

## Current Tool Order Contract

Default profile order must stay:

```ts
[
  "list_files",
  "read_file",
  "write_file",
  "replace_file_text",
  "delete_file",
  "compile_latex",
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
  "search_local_papers",
  "wiki_health",
  "wiki_lint",
  "wiki_health_fix",
]
```

Full profile order must stay the same default order with `"get_time"` prepended and these tools appended:

```ts
[
  "write_paper_wiki_source",
  "generate_paper_wiki_summary",
  "paper_wiki_relations",
  "search_paper_wiki",
  "write_design_artifact",
  "load_paper_writing_skill",
  "list_local_papers",
  "fetch_paper_webpage",
  "register_manual_paper_download",
  "open_paper_page_for_login",
  "parse_paper",
]
```

## Task 1: Strengthen Tool Assembly Characterization Tests

**Files:**
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Add reusable ordered-name constants near the existing createTools tests**

```ts
const EXPECTED_DEFAULT_TOOL_NAMES = [
  "list_files",
  "read_file",
  "write_file",
  "replace_file_text",
  "delete_file",
  "compile_latex",
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
  "search_local_papers",
  "wiki_health",
  "wiki_lint",
  "wiki_health_fix",
] as const;

const EXPECTED_FULL_ONLY_TOOL_NAMES = [
  "write_paper_wiki_source",
  "generate_paper_wiki_summary",
  "paper_wiki_relations",
  "search_paper_wiki",
  "write_design_artifact",
  "load_paper_writing_skill",
  "list_local_papers",
  "fetch_paper_webpage",
  "register_manual_paper_download",
  "open_paper_page_for_login",
  "parse_paper",
] as const;

const EXPECTED_FULL_TOOL_NAMES = [
  "get_time",
  ...EXPECTED_DEFAULT_TOOL_NAMES,
  ...EXPECTED_FULL_ONLY_TOOL_NAMES,
] as const;
```

- [ ] **Step 2: Replace inline arrays in the two profile tests**

```ts
assert.deepEqual(toolNames, [...EXPECTED_DEFAULT_TOOL_NAMES]);
assert.deepEqual(toolNames, [...EXPECTED_FULL_TOOL_NAMES]);
```

- [ ] **Step 3: Add one boundary loop test that covers all roles with ordered names**

```ts
test("createToolsForBoundary keeps every boundary in declared order", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    for (const role of [
      "wiki-agent",
      "paper-download-subagent",
      "wiki-evidence-worker",
      "design-subagent",
      "paper-writing-worker",
    ] as const) {
      const tools = createToolsForBoundary(workspace, role);
      assert.deepEqual(tools.map((tool) => tool.name), getToolBoundaryToolNames(role));
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run characterization tests**

Run:

```bash
rtk npm test -- --test-name-pattern "createTools exposes|createTools full profile|createToolsForBoundary"
```

Expected: PASS. These are characterization tests for current behavior.

- [ ] **Step 5: Commit**

```bash
git add test/agent/tools.test.ts
git commit -m "test: characterize tool assembly order"
```

## Task 2: Extract Shared Tool Construction Types

**Files:**
- Create: `src/agent/tool-types.ts`
- Modify: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Create `tool-types.ts` with the existing shared dependency surface**

The file must import the same dependency function and worker types currently referenced by `ToolDependencies`.

```ts
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { resolveDefaultPaperBrowserSessionFactory } from "./browser-session.js";
import type { PaperBrowserManagerClient } from "./paper-browser-manager-client.js";
import type { PaperExtensionBridge } from "./paper-extension-bridge.js";
import type { registerManualPaperDownload, searchPapers, downloadPaper } from "./paper-manager.js";
import type { inspectPaper, parsePaper, readPaperSection, searchPaperText } from "./paper-reader/paper-reader.js";
import type { savePaperWebPageParse } from "./paper-reader/engines/webpage.js";
import type { bootstrapPaperWikiPageEvidence } from "./paper-wiki/bootstrap.js";
import type { lintPaperWiki } from "./paper-wiki/lint.js";
import type { mergePaperWikiAliases, searchPaperWiki, writePaperWikiPage, writePaperWikiSource } from "./paper-wiki/paper-wiki.js";
import type { PaperWikiPageWorker } from "./paper-wiki/types.js";
import type { paperWikiRelations } from "./paper-relations.js";
import type { generatePaperWikiSummary, PaperSummaryWorker } from "./paper-summary.js";
import type { checkWikiHealth, fixWikiHealth, PaperDownloadWorker } from "./wiki-health.js";
import type { searchApsPapers } from "./aps-search.js";
import type { fetchPaperWebPage } from "./paper-webpage-fetch.js";
import type { listLocalPapers, searchLocalPapers } from "./local-paper-library.js";
import type { ToolProfile } from "./tool-boundaries.js";
import type { fetchWebPage } from "./web-fetch.js";
import type { searchWeb } from "./web-search.js";

export type OpenPaperPageForLoginDependency = (input: {
  url: string;
}) => Promise<{
  openedUrl: string;
  profileDir?: string;
  executablePath?: string;
}>;

export interface ToolDependencies {
  searchWeb?: typeof searchWeb;
  fetchWebPage?: typeof fetchWebPage;
  fetchPaperWebPage?: typeof fetchPaperWebPage;
  savePaperWebPageParse?: typeof savePaperWebPageParse;
  searchPapers?: typeof searchPapers;
  searchApsPapers?: typeof searchApsPapers;
  downloadPaper?: typeof downloadPaper;
  registerManualPaperDownload?: typeof registerManualPaperDownload;
  parsePaper?: typeof parsePaper;
  inspectPaper?: typeof inspectPaper;
  readPaperSection?: typeof readPaperSection;
  searchPaperText?: typeof searchPaperText;
  writePaperWikiSource?: typeof writePaperWikiSource;
  writePaperWikiPage?: typeof writePaperWikiPage;
  generatePaperWikiSummary?: typeof generatePaperWikiSummary;
  paperWikiRelations?: typeof paperWikiRelations;
  bootstrapPaperWikiPageEvidence?: typeof bootstrapPaperWikiPageEvidence;
  lintPaperWiki?: typeof lintPaperWiki;
  paperSummaryWorker?: PaperSummaryWorker;
  paperWikiPageWorker?: PaperWikiPageWorker;
  searchPaperWiki?: typeof searchPaperWiki;
  listLocalPapers?: typeof listLocalPapers;
  searchLocalPapers?: typeof searchLocalPapers;
  checkWikiHealth?: typeof checkWikiHealth;
  fixWikiHealth?: typeof fixWikiHealth;
  paperDownloadWorker?: PaperDownloadWorker;
  openPaperPageForLogin?: OpenPaperPageForLoginDependency;
  browserSessionFactory?: ReturnType<typeof resolveDefaultPaperBrowserSessionFactory>;
  paperBrowserManagerClient?: PaperBrowserManagerClient;
  extensionBridge?: PaperExtensionBridge;
  usePlaywrightPaperFallback?: boolean;
  allowBuildWikiPageExternalEvidence?: boolean;
  toolProfile?: ToolProfile;
}

export interface ToolSetMetadata {
  cleanup: () => Promise<void>;
  workspaceDir: string;
}

export type AgentTools = AgentTool<any>[] & ToolSetMetadata;
```

- [ ] **Step 2: Import and re-export the shared types from `tools.ts`**

```ts
import type { AgentTools, ToolDependencies, ToolSetMetadata } from "./tool-types.js";

export type { AgentTools, ToolDependencies } from "./tool-types.js";
```

Remove the moved `ToolDependencies`, `ToolSetMetadata`, and `AgentTools` declarations from `tools.ts`.

- [ ] **Step 3: Run focused tests**

Run:

```bash
rtk npm test -- --test-name-pattern "createTools exposes|createToolsForBoundary|public entrypoint re-exports"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/tool-types.ts src/agent/tools.ts
git commit -m "refactor: extract shared tool construction types"
```

## Task 3: Extract File and Workspace Tools

**Files:**
- Create: `src/agent/file-tools.ts`
- Modify: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Move file-tool schemas, helper functions, and type aliases into `file-tools.ts`**

Move the code for these tool names into the new module:

```ts
export function createFileTools(input: {
  workspaceDir: string;
}): {
  defaultTools: AgentTool<any>[];
  prependFullTools: AgentTool<any>[];
  tailFullTools: AgentTool<any>[];
} {
  return {
    defaultTools: [
      listFilesTool,
      readFileTool,
      writeFileTool,
      replaceFileTextTool,
      deleteFileTool,
      compileLatexTool,
    ],
    prependFullTools: [
      getTimeTool,
    ],
    tailFullTools: [
      loadPaperWritingSkillTool,
    ],
  };
}
```

The implementation must preserve the current `executionMode`, descriptions, parameters, path safety checks, and `details` shapes.

- [ ] **Step 2: Replace inline file-tool construction in `tools.ts`**

```ts
const fileTools = createFileTools({ workspaceDir: resolvedWorkspaceDir });
```

Use `...fileTools` in the default array and `...fullProfileFileTools` in the full-profile additions while preserving the current positions:

```ts
const tools = [
  ...fileTools.defaultTools,
  webSearchTool,
  fetchUrlTool,
] as unknown as AgentTools;

if (dependencies.toolProfile === "full") {
  tools.unshift(...fileTools.prependFullTools);
  tools.push(...fileTools.tailFullTools);
}
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
rtk npm test -- --test-name-pattern "read_file|write_file|replace_file_text|delete_file|compile_latex|get_time|load_paper_writing_skill|createTools exposes|createTools full profile"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/file-tools.ts src/agent/tools.ts test/agent/tools.test.ts
git commit -m "refactor: extract file tool domain"
```

## Task 4: Extract Web Tools

**Files:**
- Create: `src/agent/web-tools.ts`
- Modify: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Move web schemas, summaries, and tool bodies into `web-tools.ts`**

Create a factory with defaults resolved inside the domain module:

```ts
export function createWebTools(input: {
  workspaceDir: string;
  dependencies: ToolDependencies;
}): {
  defaultTools: AgentTool<any>[];
  fullTools: AgentTool<any>[];
} {
  return {
    defaultTools: [webSearchTool, fetchUrlTool],
    fullTools: [fetchPaperWebpageTool],
  };
}
```

Keep `web_search`, `fetch_url`, and `fetch_paper_webpage` result content and `details` values unchanged.

- [ ] **Step 2: Replace inline web construction in `tools.ts`**

```ts
const webTools = createWebTools({
  workspaceDir: resolvedWorkspaceDir,
  dependencies,
});
```

Use `...webTools.defaultTools` where `webSearchTool` and `fetchUrlTool` currently appear. Push `...webTools.fullTools` in the full-profile additions at the current `fetch_paper_webpage` position.

- [ ] **Step 3: Run focused tests**

Run:

```bash
rtk npm test -- --test-name-pattern "web_search|fetch_url|fetch_paper_webpage|createTools exposes|createTools full profile|createToolsForBoundary"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/web-tools.ts src/agent/tools.ts
git commit -m "refactor: extract web tool domain"
```

## Task 5: Extract Paper Acquisition and Reading Tools

**Files:**
- Create: `src/agent/paper-tools.ts`
- Modify: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`
- Test: `test/agent/tools-extension.test.ts`

- [ ] **Step 1: Move paper schemas, paper reading closure helpers, and paper tool bodies into `paper-tools.ts`**

The factory must own its browser-manager cleanup because these tools create or use the paper browser manager client.

```ts
export function createPaperTools(input: {
  workspaceDir: string;
  dependencies: ToolDependencies;
}): {
  defaultTools: AgentTool<any>[];
  fullTools: AgentTool<any>[];
  cleanup: () => Promise<void>;
} {
  return {
    defaultTools: [
      searchPapersTool,
      downloadPaperTool,
      blockPaperDownloadTool,
      inspectPaperTool,
      readPaperSectionTool,
      searchPaperTextTool,
    ],
    fullTools: [
      registerManualPaperDownloadTool,
      openPaperPageForLoginTool,
      parsePaperTool,
    ],
    cleanup: closePaperManager,
  };
}
```

Keep `describeDownloadReadingClosure`, publisher webpage queue behavior, arXiv webpage/TeX/PDF fallback behavior, and injected dependency defaults unchanged.

- [ ] **Step 2: Compose paper tools from `tools.ts`**

```ts
const paperTools = createPaperTools({
  workspaceDir: resolvedWorkspaceDir,
  dependencies,
});
```

Use `...paperTools.defaultTools` in the current default paper positions and `...paperTools.fullTools` in the current full-profile tail positions.

- [ ] **Step 3: Preserve cleanup metadata**

Replace `closePaperManager` ownership in `tools.ts` with domain cleanup fan-out:

```ts
const cleanupCallbacks = [
  paperTools.cleanup,
];

Object.defineProperties(tools, {
  cleanup: {
    enumerable: false,
    value: async () => {
      for (const cleanup of cleanupCallbacks) {
        await cleanup();
      }
    },
  },
  workspaceDir: {
    enumerable: false,
    value: resolvedWorkspaceDir,
  },
});
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
rtk npm test -- --test-name-pattern "search_papers|download_paper|block_paper_download|register_manual_paper_download|open_paper_page_for_login|parse_paper|inspect_paper|read_paper_section|search_paper_text|cleanup closes"
```

Expected: PASS.

- [ ] **Step 5: Run extension-tool tests**

Run:

```bash
rtk npm test -- test/agent/tools-extension.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/paper-tools.ts src/agent/tools.ts test/agent/tools.test.ts test/agent/tools-extension.test.ts
git commit -m "refactor: extract paper tool domain"
```

## Task 6: Extract Design Artifact Tool

**Files:**
- Create: `src/agent/design-tools.ts`
- Modify: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Move design artifact schema and tool body into `design-tools.ts`**

```ts
export function createDesignTools(input: {
  workspaceDir: string;
}): {
  fullTools: AgentTool<any>[];
} {
  return {
    fullTools: [writeDesignArtifactTool],
  };
}
```

Keep the existing restriction that this tool writes only under `knowledge-base/design-records/`.

- [ ] **Step 2: Compose full-profile design tool from `tools.ts`**

```ts
const designTools = createDesignTools({
  workspaceDir: resolvedWorkspaceDir,
});
```

Push `...designTools.fullTools` at the current `write_design_artifact` full-profile position.

- [ ] **Step 3: Run focused tests**

Run:

```bash
rtk npm test -- --test-name-pattern "write_design_artifact|design-subagent|createTools full profile"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/design-tools.ts src/agent/tools.ts
git commit -m "refactor: extract design tool domain"
```

## Task 7: Extract Local Library and Wiki Health Tools

**Files:**
- Create: `src/agent/library-health-tools.ts`
- Modify: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Move local-library and wiki-health schemas and tool bodies into `library-health-tools.ts`**

```ts
export function createLibraryHealthTools(input: {
  workspaceDir: string;
  dependencies: ToolDependencies;
}): {
  defaultTools: AgentTool<any>[];
  fullTools: AgentTool<any>[];
} {
  return {
    defaultTools: [
      searchLocalPapersTool,
      wikiHealthTool,
      wikiHealthFixTool,
    ],
    fullTools: [
      listLocalPapersTool,
    ],
  };
}
```

Keep `wiki_health_fix` download-worker and summary-worker dependency forwarding unchanged.

- [ ] **Step 2: Compose maintenance tools from `tools.ts`**

```ts
const libraryHealthTools = createLibraryHealthTools({
  workspaceDir: resolvedWorkspaceDir,
  dependencies,
});
```

Use `...libraryHealthTools.defaultTools` and `...libraryHealthTools.fullTools` at their current positions.

- [ ] **Step 3: Run focused tests**

Run:

```bash
rtk npm test -- --test-name-pattern "list_local_papers|search_local_papers|wiki_health|wiki_health_fix|createToolsForBoundary"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/library-health-tools.ts src/agent/tools.ts
git commit -m "refactor: extract library health tool domain"
```

## Task 8: Extract Wiki and Research Tools

**Files:**
- Create: `src/agent/wiki-tools.ts`
- Modify: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Move wiki and research schemas, compact-result helpers, progress helpers, and tool bodies into `wiki-tools.ts`**

The factory must receive callable paper-tool operations when it needs to reuse them for research workflows:

```ts
export function createWikiTools(input: {
  workspaceDir: string;
  dependencies: ToolDependencies;
  searchPapersTool: AgentTool<any>;
  downloadPaperTool: AgentTool<any>;
  parsePaperTool: AgentTool<any>;
}): {
  defaultTools: AgentTool<any>[];
  fullTools: AgentTool<any>[];
} {
  return {
    defaultTools: [
      answerPaperWikiQuestionTool,
      answerResearchQuestionTool,
      bootstrapWikiPageEvidenceTool,
      buildWikiPageTool,
      mergeWikiAliasesTool,
      clarifyResearchTopicTool,
      researchTopicBootstrapTool,
      expandResearchTopicTool,
      wikiLintTool,
    ],
    fullTools: [
      writePaperWikiSourceTool,
      generatePaperWikiSummaryTool,
      paperWikiRelationsTool,
      searchPaperWikiTool,
    ],
  };
}
```

Keep `answer_research_question` local-wiki-first behavior, auto-download gates, auto-summarize gates, worker progress messages, and `build_wiki_page` external-evidence boundary behavior unchanged.

- [ ] **Step 2: Export named paper tool references from `paper-tools.ts`**

Return a lookup map from `createPaperTools` so `tools.ts` can pass exactly the tool objects that wiki/research workflows call today:

```ts
toolsByName: {
  searchPapersTool,
  downloadPaperTool,
  parsePaperTool,
}
```

- [ ] **Step 3: Compose wiki tools from `tools.ts`**

```ts
const wikiTools = createWikiTools({
  workspaceDir: resolvedWorkspaceDir,
  dependencies,
  searchPapersTool: paperTools.toolsByName.searchPapersTool,
  downloadPaperTool: paperTools.toolsByName.downloadPaperTool,
  parsePaperTool: paperTools.toolsByName.parsePaperTool,
});
```

Use `...wikiTools.defaultTools` and `...wikiTools.fullTools` in the exact current positions.

- [ ] **Step 4: Run focused tests**

Run:

```bash
rtk npm test -- --test-name-pattern "write_paper_wiki_source|generate_paper_wiki_summary|paper_wiki_relations|search_paper_wiki|answer_paper_wiki_question|answer_research_question|bootstrap_wiki_page_evidence|build_wiki_page|merge_wiki_aliases|clarify_research_topic|research_topic_bootstrap|expand_research_topic|wiki_lint|createToolsForBoundary"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/wiki-tools.ts src/agent/paper-tools.ts src/agent/tools.ts
git commit -m "refactor: extract wiki research tool domain"
```

## Task 9: Reduce `tools.ts` to Assembly and Compatibility Exports

**Files:**
- Modify: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: Remove domain-only imports and helpers from `tools.ts`**

After all domain moves, `tools.ts` should primarily import:

```ts
import type { AgentTool } from "@mariozechner/pi-agent-core";
import path from "node:path";
import { createDesignTools } from "./design-tools.js";
import { createFileTools } from "./file-tools.js";
import { createLibraryHealthTools } from "./library-health-tools.js";
import { createPaperTools } from "./paper-tools.js";
import { createWebTools } from "./web-tools.js";
import { createWikiTools } from "./wiki-tools.js";
import type { AgentTools, ToolDependencies, ToolSetMetadata } from "./tool-types.js";
import {
  getToolBoundaryToolNames as getToolBoundaryToolNamesFromBoundaryModule,
  TOOL_BOUNDARY_NAMES,
  type ToolBoundaryRole,
  type ToolProfile,
} from "./tool-boundaries.js";
```

- [ ] **Step 2: Keep assembly explicit in `createTools()`**

The final assembly should read like this, with the exact tool order preserved:

```ts
const tools = [
  ...fileTools.defaultTools,
  ...webTools.defaultTools,
  ...paperTools.defaultTools,
  ...wikiTools.defaultTools,
  ...libraryHealthTools.defaultTools,
] as unknown as AgentTools;

if (dependencies.toolProfile === "full") {
  tools.unshift(...fileTools.prependFullTools);
  tools.push(
    ...wikiTools.fullTools,
    ...designTools.fullTools,
    ...fileTools.tailFullTools,
    ...libraryHealthTools.fullTools,
    ...webTools.fullTools,
    ...paperTools.fullTools,
  );
}
```

Keep `"get_time"` in `fileTools.prependFullTools` and `"load_paper_writing_skill"` in `fileTools.tailFullTools`.

- [ ] **Step 3: Keep cleanup and metadata helpers in `tools.ts`**

```ts
export async function cleanupTools(tools: ReadonlyArray<AgentTool<any>> | undefined): Promise<void> {
  const cleanup = (tools as Partial<ToolSetMetadata> | undefined)?.cleanup;
  if (typeof cleanup === "function") {
    await cleanup();
  }
}

export function getToolsWorkspaceDir(
  tools: ReadonlyArray<AgentTool<any>> | undefined
): string | undefined {
  const workspaceDir = (tools as Partial<ToolSetMetadata> | undefined)?.workspaceDir;
  return typeof workspaceDir === "string" ? workspaceDir : undefined;
}
```

- [ ] **Step 4: Run focused compatibility tests**

Run:

```bash
rtk npm test -- --test-name-pattern "public entrypoint re-exports|createTools exposes|createTools full profile|createToolsForBoundary|tools module re-exports"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tool-types.ts src/agent/file-tools.ts src/agent/web-tools.ts src/agent/paper-tools.ts src/agent/design-tools.ts src/agent/library-health-tools.ts src/agent/wiki-tools.ts test/agent/tools.test.ts test/index.test.ts
git commit -m "refactor: reduce tools module to assembly"
```

## Task 10: Full Verification and Final Review

**Files:**
- Verify all changed source and test files.

- [ ] **Step 1: Run formatting whitespace check**

Run:

```bash
git diff --check
```

Expected: no output, exit code 0.

- [ ] **Step 2: Run full test suite**

Run:

```bash
rtk npm test
```

Expected: PASS with the full suite count and zero failures.

- [ ] **Step 3: Inspect public API and file size result**

Run:

```bash
wc -l src/agent/tools.ts src/agent/*-tools.ts src/agent/tool-types.ts
```

Expected: `src/agent/tools.ts` is much smaller than before, and domain modules exist with focused names.

- [ ] **Step 4: Review diff for accidental behavior changes**

Run:

```bash
git diff --stat HEAD~7..HEAD
git diff -- src/agent/tools.ts src/agent/tool-types.ts src/agent/file-tools.ts src/agent/web-tools.ts src/agent/paper-tools.ts src/agent/design-tools.ts src/agent/library-health-tools.ts src/agent/wiki-tools.ts test/agent/tools.test.ts test/index.test.ts
```

Expected: domain code moved into focused modules; no tool names, descriptions, parameter schemas, profile order, or boundary order changed except for import/export plumbing.

- [ ] **Step 5: Commit verification-only fixes if any were needed**

If verification required a fix, commit the fix with a narrow message:

```bash
git add src/agent/tools.ts src/agent/tool-types.ts src/agent/file-tools.ts src/agent/web-tools.ts src/agent/paper-tools.ts src/agent/design-tools.ts src/agent/library-health-tools.ts src/agent/wiki-tools.ts test/agent/tools.test.ts test/agent/tools-extension.test.ts test/index.test.ts
git commit -m "fix: preserve tool domain refactor behavior"
```

If no fix was needed, do not create an empty commit.

## Execution Notes

- Use an isolated worktree before implementation work.
- Keep commits small and ordered by the tasks above.
- Use `apply_patch` for manual edits.
- Do not change private paper artifacts or knowledge-base content.
- If a focused test command does not match any tests because a test name changed, run `rtk npm test -- test/agent/tools.test.ts` and record the actual command in the final notes.
- If full tests fail due to an environment-only localhost binding restriction, capture the exact failing message and run the non-network focused tests listed above before reporting the blocker.
