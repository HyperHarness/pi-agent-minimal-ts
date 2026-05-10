# Wiki Agent Architecture Complete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the schema-first wiki-agent redesign so the local wiki becomes a durable, typed, auditable, downstream-consumable research knowledge substrate.

**Architecture:** Phase 1 already added source manifests, a minimal operation journal, and health visibility for missing manifests. This plan completes the remaining architecture in five phases: workspace contract and typed store, read-only evidence contract, migration of existing wiki tools to the core layers, wiki-agent coordination policy, and optional validated domain execution bindings. Each phase must preserve the existing `knowledge-base/` layout and public tool names unless the task explicitly adds a new facade.

**Tech Stack:** TypeScript, Node `fs/promises`, built-in `node:test`, existing wiki stores, existing paper reader and downloader modules, existing `@mariozechner/pi-ai` tool schemas.

---

## Current Baseline

Phase 1 is committed in `5666867 Add wiki knowledge core manifests`.

Completed baseline capabilities:

- `src/agent/wiki/manifest-store.ts` writes source manifests under `knowledge-base/manifests/<paperKey>.json`.
- `src/agent/wiki/journal.ts` appends JSONL operation records under `knowledge-base/state/wiki-operations.jsonl`.
- `writePaperWikiSource()` writes `summary.md`, manifest, index, and journal events.
- `wiki_health` reports and fixes `source_manifest_missing`.

This complete plan starts from that baseline.

## File Structure Plan

Create focused wiki-core modules instead of expanding `content.ts` further:

- `src/agent/wiki/workspace-contract.ts`: authoritative workspace roots, lifecycle categories, and relative path helpers.
- `src/agent/wiki/page-schema.ts`: typed wiki page metadata, frontmatter parser, validator, and serializer.
- `src/agent/wiki/typed-store.ts`: read/list/write typed wiki pages while preserving human-authored markdown bodies.
- `src/agent/wiki/retrieval-contract.ts`: read-only evidence API for downstream workers and tools.
- `src/agent/wiki/retrieval-search.ts`: structured scoring and insufficient-evidence reporting.
- `src/agent/wiki/coordinator.ts`: deterministic wiki-agent coordination planner.
- `src/agent/wiki/domain-bindings.ts`: optional validated executable binding registry.

Modify existing modules in place:

- `src/agent/wiki/store.ts`: delegate path roots to `workspace-contract.ts`.
- `src/agent/wiki/content.ts`: use typed store, retrieval contract, and journal for all multi-file writes.
- `src/agent/wiki/bootstrap.ts`: retrieve evidence through `retrieval-contract.ts`.
- `src/agent/wiki/health.ts`: validate typed pages, stale manifests, and interrupted operations.
- `src/agent/wiki/lint.ts`: use typed page diagnostics and evidence contracts.
- `src/agent/wiki/structure-plan.ts`: consume governance diagnostics from typed store and manifests.
- `src/agent/wiki/structure-apply.ts`: record journal events for multi-file structure changes.
- `src/agent/wiki/tools.ts`: expose new coordinator and retrieval outputs while preserving existing tool names.
- `src/agent/wiki/index.ts`: export new wiki-core modules.

Add focused tests:

- `test/agent/wiki-workspace-contract.test.ts`
- `test/agent/wiki-page-schema.test.ts`
- `test/agent/wiki-typed-store.test.ts`
- `test/agent/wiki-retrieval-contract.test.ts`
- `test/agent/wiki-coordinator.test.ts`
- `test/agent/wiki-domain-bindings.test.ts`

Update existing tests:

- `test/agent/paper-reader.test.ts`
- `test/agent/wiki-health.test.ts`
- `test/agent/wiki-maintenance.test.ts`
- `test/agent/tools.test.ts`
- `test/agent/tools-extension.test.ts`
- `test/agent/wiki-domain-boundary.test.ts`

## Phase 2: Workspace Contract And Typed Wiki Store

### Task 1: Authoritative Workspace Contract

**Files:**
- Create: `src/agent/wiki/workspace-contract.ts`
- Modify: `src/agent/wiki/store.ts`
- Modify: `src/agent/wiki/index.ts`
- Test: `test/agent/wiki-workspace-contract.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/agent/wiki-workspace-contract.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  resolveWikiWorkspaceContract,
  wikiPathForLifecycle,
  type WikiLifecycleKind
} from "../../src/agent/wiki/workspace-contract.js";

test("resolveWikiWorkspaceContract exposes stable lifecycle roots", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-contract-"));
  try {
    const contract = resolveWikiWorkspaceContract(workspace);
    assert.equal(contract.schemaVersion, 1);
    assert.equal(contract.workspaceDir, workspace);
    assert.equal(contract.rootRelativePath, "knowledge-base");
    assert.equal(contract.roots.rawInputs.relativePath, "knowledge-base/raw/pdfs");
    assert.equal(contract.roots.sourceRecords.relativePath, "knowledge-base/sources");
    assert.equal(contract.roots.sourceSummaries.relativePath, "knowledge-base/sources");
    assert.equal(contract.roots.synthesisPages.relativePath, "knowledge-base/pages");
    assert.equal(contract.roots.assets.relativePath, "knowledge-base/assets");
    assert.equal(contract.roots.manifests.relativePath, "knowledge-base/manifests");
    assert.equal(contract.roots.runtimeState.relativePath, "knowledge-base/state");
    assert.equal(contract.files.index.relativePath, "knowledge-base/index.md");
    assert.equal(contract.files.humanLog.relativePath, "knowledge-base/log.md");

    const lifecycle: WikiLifecycleKind = "manifests";
    assert.equal(
      wikiPathForLifecycle(contract, lifecycle, "arxiv-2601.00003.json").relativePath,
      "knowledge-base/manifests/arxiv-2601.00003.json"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- --test-name-pattern "resolveWikiWorkspaceContract"
```

Expected: FAIL because `workspace-contract.ts` does not exist.

- [ ] **Step 3: Implement the workspace contract**

Create `src/agent/wiki/workspace-contract.ts`:

```ts
import path from "node:path";
import { resolvePaperLibraryPaths } from "../knowledge-base.js";

export type WikiLifecycleKind =
  | "rawInputs"
  | "sourceRecords"
  | "parseArtifacts"
  | "sourceSummaries"
  | "synthesisPages"
  | "assets"
  | "manifests"
  | "runtimeState";

export interface WikiWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

export interface WikiWorkspaceContract {
  schemaVersion: 1;
  workspaceDir: string;
  rootRelativePath: "knowledge-base";
  roots: Record<WikiLifecycleKind, WikiWorkspacePath>;
  files: {
    index: WikiWorkspacePath;
    humanLog: WikiWorkspacePath;
    operationJournal: WikiWorkspacePath;
  };
}

function toWikiPath(workspaceDir: string, absolutePath: string): WikiWorkspacePath {
  return {
    absolutePath,
    relativePath: path.relative(workspaceDir, absolutePath).split(path.sep).join("/")
  };
}

export function resolveWikiWorkspaceContract(workspaceDir: string): WikiWorkspaceContract {
  const paths = resolvePaperLibraryPaths(workspaceDir);
  const statePath = paths.stateRoot;
  return {
    schemaVersion: 1,
    workspaceDir,
    rootRelativePath: "knowledge-base",
    roots: {
      rawInputs: toWikiPath(workspaceDir, paths.rawPdfRoot),
      sourceRecords: toWikiPath(workspaceDir, paths.sourcesRoot),
      parseArtifacts: toWikiPath(workspaceDir, paths.sourcesRoot),
      sourceSummaries: toWikiPath(workspaceDir, paths.sourcesRoot),
      synthesisPages: toWikiPath(workspaceDir, paths.pagesRoot),
      assets: toWikiPath(workspaceDir, paths.assetsRoot),
      manifests: toWikiPath(workspaceDir, paths.manifestsRoot),
      runtimeState: toWikiPath(workspaceDir, statePath)
    },
    files: {
      index: toWikiPath(workspaceDir, paths.indexPath),
      humanLog: toWikiPath(workspaceDir, paths.logPath),
      operationJournal: toWikiPath(workspaceDir, path.join(statePath, "wiki-operations.jsonl"))
    }
  };
}

export function wikiPathForLifecycle(
  contract: WikiWorkspaceContract,
  lifecycle: WikiLifecycleKind,
  childPath: string
): WikiWorkspacePath {
  const absolutePath = path.join(contract.roots[lifecycle].absolutePath, childPath);
  return {
    absolutePath,
    relativePath: path.relative(contract.workspaceDir, absolutePath).split(path.sep).join("/")
  };
}
```

- [ ] **Step 4: Delegate store path helpers to the contract**

Modify `src/agent/wiki/store.ts` so these helpers read from `resolveWikiWorkspaceContract(workspaceDir)`:

```ts
import { resolveWikiWorkspaceContract } from "./workspace-contract.js";
```

Then update helpers such as:

```ts
export function getPaperWikiSourcesDir(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).roots.sourceSummaries.absolutePath;
}

export function getPaperWikiPagesDir(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).roots.synthesisPages.absolutePath;
}

export function getPaperWikiManifestsDir(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).roots.manifests.absolutePath;
}

export function getPaperWikiOperationJournalPath(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).files.operationJournal.absolutePath;
}
```

- [ ] **Step 5: Export the contract**

Add to `src/agent/wiki/index.ts`:

```ts
export * from "./workspace-contract.js";
```

- [ ] **Step 6: Verify focused and compatibility tests**

Run:

```bash
npm test -- --test-name-pattern "resolveWikiWorkspaceContract|writePaperWikiSource saves an LLM source summary"
```

Expected: PASS.

- [ ] **Step 7: Commit Phase 2 Task 1**

```bash
git add src/agent/wiki/workspace-contract.ts src/agent/wiki/store.ts src/agent/wiki/index.ts test/agent/wiki-workspace-contract.test.ts
git commit -m "Add wiki workspace contract"
```

### Task 2: Typed Page Schema Parser And Serializer

**Files:**
- Create: `src/agent/wiki/page-schema.ts`
- Modify: `src/agent/wiki/index.ts`
- Test: `test/agent/wiki-page-schema.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `test/agent/wiki-page-schema.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWikiPageMarkdown,
  serializeWikiPageMarkdown,
  validateWikiPageMetadata
} from "../../src/agent/wiki/page-schema.js";

test("parseWikiPageMarkdown parses paper-source metadata and body", () => {
  const markdown = [
    "---",
    'type: "paper-source"',
    'key: "arxiv-2601.00003"',
    'title: "Manifest-backed source"',
    "aliases:",
    '  - "manifest source"',
    "tags:",
    '  - "quantum-simulation"',
    'evidence_contract: "paper-backed"',
    "source_refs:",
    '  - "arxiv-2601.00003"',
    'created_at: "2026-05-10T00:00:00.000Z"',
    'updated_at: "2026-05-10T00:00:00.000Z"',
    "---",
    "",
    "# Manifest-backed source",
    "",
    "Grounded body."
  ].join("\n");

  const parsed = parseWikiPageMarkdown(markdown, "knowledge-base/sources/arxiv-2601.00003/summary.md");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.page?.metadata.type, "paper-source");
  assert.equal(parsed.page?.metadata.key, "arxiv-2601.00003");
  assert.deepEqual(parsed.page?.metadata.tags, ["quantum-simulation"]);
  assert.equal(parsed.page?.body.trim(), "# Manifest-backed source\n\nGrounded body.");
});

test("validateWikiPageMetadata reports malformed pages without throwing", () => {
  const result = validateWikiPageMetadata({
    type: "synthesis",
    key: "",
    title: "",
    aliases: [],
    tags: [],
    evidence_contract: "paper-backed",
    source_refs: [],
    created_at: "not-a-date",
    updated_at: "2026-05-10T00:00:00.000Z"
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), [
    "missing_key",
    "missing_title",
    "invalid_created_at",
    "missing_source_refs"
  ]);
});

test("serializeWikiPageMarkdown preserves the body under normalized metadata", () => {
  const markdown = serializeWikiPageMarkdown({
    metadata: {
      schema_version: 1,
      type: "concept",
      key: "frequency-crowding",
      title: "Frequency crowding",
      aliases: ["crowding"],
      tags: ["superconducting-qubits"],
      evidence_contract: "paper-backed",
      source_refs: ["arxiv-2601.00003"],
      created_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z"
    },
    body: "# Frequency crowding\n\nA typed concept page."
  });

  assert.match(markdown, /^---\n/);
  assert.match(markdown, /schema_version: 1/);
  assert.match(markdown, /type: "concept"/);
  assert.match(markdown, /# Frequency crowding/);
});
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "parseWikiPageMarkdown|validateWikiPageMetadata|serializeWikiPageMarkdown"
```

Expected: FAIL because `page-schema.ts` does not exist.

- [ ] **Step 3: Implement page schema types and parser**

Create `src/agent/wiki/page-schema.ts` with these exported types:

```ts
export type WikiPageType =
  | "paper-source"
  | "synthesis"
  | "concept"
  | "method"
  | "finding"
  | "dataset"
  | "question"
  | "design-record"
  | "alias";

export type WikiEvidenceContract =
  | "paper-backed"
  | "design-backed"
  | "code-backed"
  | "mixed"
  | "none";

export interface WikiPageMetadata {
  schema_version: 1;
  type: WikiPageType;
  key: string;
  title: string;
  aliases: string[];
  tags: string[];
  evidence_contract: WikiEvidenceContract;
  source_refs: string[];
  related_pages?: string[];
  related_papers?: string[];
  canonical_page?: string;
  created_at: string;
  updated_at: string;
}

export interface WikiTypedPage {
  path: string;
  metadata: WikiPageMetadata;
  body: string;
}

export interface WikiPageSchemaError {
  code:
    | "missing_frontmatter"
    | "invalid_frontmatter"
    | "invalid_type"
    | "missing_key"
    | "missing_title"
    | "invalid_created_at"
    | "invalid_updated_at"
    | "missing_source_refs"
    | "missing_canonical_page";
  message: string;
  path?: string;
}
```

Implement `parseWikiPageMarkdown()`, `validateWikiPageMetadata()`, and `serializeWikiPageMarkdown()` using the existing simple YAML subset style used in `content.ts`: quoted scalars, arrays with `- "value"`, and `[]`. Do not add a new YAML dependency.

- [ ] **Step 4: Export page schema**

Add to `src/agent/wiki/index.ts`:

```ts
export * from "./page-schema.js";
```

- [ ] **Step 5: Verify parser tests**

Run:

```bash
npm test -- --test-name-pattern "parseWikiPageMarkdown|validateWikiPageMetadata|serializeWikiPageMarkdown"
```

Expected: PASS.

- [ ] **Step 6: Commit Phase 2 Task 2**

```bash
git add src/agent/wiki/page-schema.ts src/agent/wiki/index.ts test/agent/wiki-page-schema.test.ts
git commit -m "Add typed wiki page schema"
```

### Task 3: Typed Wiki Store

**Files:**
- Create: `src/agent/wiki/typed-store.ts`
- Modify: `src/agent/wiki/index.ts`
- Test: `test/agent/wiki-typed-store.test.ts`

- [ ] **Step 1: Write failing typed-store tests**

Create `test/agent/wiki-typed-store.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  listTypedWikiPages,
  readTypedWikiPage,
  writeTypedWikiPage
} from "../../src/agent/wiki/typed-store.js";

test("typed store lists valid pages and reports malformed pages", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-typed-store-"));
  try {
    await mkdir(path.join(workspace, "knowledge-base", "pages"), { recursive: true });
    await writeFile(path.join(workspace, "knowledge-base", "pages", "valid.md"), [
      "---",
      "schema_version: 1",
      'type: "concept"',
      'key: "valid"',
      'title: "Valid Page"',
      "aliases: []",
      "tags: []",
      'evidence_contract: "paper-backed"',
      "source_refs:",
      '  - "arxiv-2601.00003"',
      'created_at: "2026-05-10T00:00:00.000Z"',
      'updated_at: "2026-05-10T00:00:00.000Z"',
      "---",
      "",
      "# Valid Page"
    ].join("\n"), "utf8");
    await writeFile(path.join(workspace, "knowledge-base", "pages", "broken.md"), "# Broken\n", "utf8");

    const result = await listTypedWikiPages({ workspaceDir: workspace, includeSources: false, includePages: true });

    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].metadata.key, "valid");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].errors[0].code, "missing_frontmatter");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("writeTypedWikiPage writes normalized metadata and preserves body", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-typed-write-"));
  try {
    const result = await writeTypedWikiPage({
      workspaceDir: workspace,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "frequency-crowding",
          title: "Frequency crowding",
          aliases: [],
          tags: ["superconducting-qubits"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00003"],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Frequency crowding\n\nBody."
      }
    });

    assert.equal(result.relativePath, "knowledge-base/pages/frequency-crowding.md");
    const page = await readTypedWikiPage({ workspaceDir: workspace, key: "frequency-crowding" });
    assert.equal(page.page?.metadata.type, "concept");
    assert.equal(page.page?.body.trim(), "# Frequency crowding\n\nBody.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run typed-store tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "typed store lists valid pages|writeTypedWikiPage"
```

Expected: FAIL because `typed-store.ts` does not exist.

- [ ] **Step 3: Implement typed store**

Create `src/agent/wiki/typed-store.ts` with:

```ts
export interface WikiPageDiagnostic {
  path: string;
  relativePath: string;
  errors: WikiPageSchemaError[];
}

export interface ListTypedWikiPagesOptions {
  workspaceDir: string;
  includeSources?: boolean;
  includePages?: boolean;
  types?: WikiPageType[];
  tags?: string[];
  sourceRefs?: string[];
  evidenceContracts?: WikiEvidenceContract[];
}

export interface ListTypedWikiPagesResult {
  pages: WikiTypedPage[];
  diagnostics: WikiPageDiagnostic[];
}
```

Implementation requirements:

- Source summaries are read from `listPaperWikiSourceFiles(workspaceDir)`.
- Synthesis and typed pages are read from `listPaperWikiPageFiles(workspaceDir)`.
- Invalid pages are returned in `diagnostics` and never thrown as fatal list errors.
- `writeTypedWikiPage()` writes only under `knowledge-base/pages/<key>.md`.
- `readTypedWikiPage()` returns `{ page?: WikiTypedPage; diagnostics: WikiPageDiagnostic[] }`.

- [ ] **Step 4: Export typed store**

Add to `src/agent/wiki/index.ts`:

```ts
export * from "./typed-store.js";
```

- [ ] **Step 5: Verify typed-store tests**

Run:

```bash
npm test -- --test-name-pattern "typed store lists valid pages|writeTypedWikiPage"
```

Expected: PASS.

- [ ] **Step 6: Commit Phase 2 Task 3**

```bash
git add src/agent/wiki/typed-store.ts src/agent/wiki/index.ts test/agent/wiki-typed-store.test.ts
git commit -m "Add typed wiki page store"
```

### Task 4: Health And Lint Use Typed Diagnostics

**Files:**
- Modify: `src/agent/wiki/health.ts`
- Modify: `src/agent/wiki/lint.ts`
- Test: `test/agent/wiki-health.test.ts`
- Test: `test/agent/wiki-maintenance.test.ts`

- [ ] **Step 1: Add health test for malformed typed pages**

Add to `test/agent/wiki-health.test.ts`:

```ts
test("checkWikiHealth reports malformed typed wiki pages", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "pages", "broken.md"), "# Broken page\n");

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.wiki_page_malformed, 1);
    assert.ok(result.issues.some((issue) =>
      issue.kind === "wiki_page_malformed" &&
      issue.path === "knowledge-base/pages/broken.md"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Add lint test for weak evidence contracts**

Add to `test/agent/wiki-maintenance.test.ts`:

```ts
test("lintPaperWiki reports pages with missing source refs for paper-backed contracts", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "pages", "weak.md"), [
      "---",
      "schema_version: 1",
      'type: "synthesis"',
      'key: "weak"',
      'title: "Weak Evidence"',
      "aliases: []",
      "tags: []",
      'evidence_contract: "paper-backed"',
      "source_refs: []",
      'created_at: "2026-05-10T00:00:00.000Z"',
      'updated_at: "2026-05-10T00:00:00.000Z"',
      "---",
      "",
      "# Weak Evidence"
    ].join("\n"));

    const result = await lintPaperWiki({ workspaceDir: workspace, includeQualityAudit: true });

    assert.ok(result.issues.some((issue) =>
      issue.kind === "weak_evidence_contract" &&
      issue.path === "knowledge-base/pages/weak.md"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "malformed typed wiki pages|missing source refs"
```

Expected: FAIL because the new health and lint issue kinds do not exist.

- [ ] **Step 4: Implement issue kinds**

Add these issue kinds:

```ts
type WikiHealthIssueKind =
  | ExistingKinds
  | "wiki_page_malformed"
  | "wiki_page_evidence_weak";
```

For lint, add or reuse the issue kind:

```ts
"weak_evidence_contract"
```

Use `listTypedWikiPages()` diagnostics in both modules. A `paper-backed` page with no `source_refs` is weak. An `alias` page with no `canonical_page` is malformed.

- [ ] **Step 5: Verify focused tests**

Run:

```bash
npm test -- --test-name-pattern "malformed typed wiki pages|missing source refs"
```

Expected: PASS.

- [ ] **Step 6: Run Phase 2 full focused validation**

Run:

```bash
npm test -- --test-name-pattern "wiki|writePaperWikiSource|build_wiki_page"
```

Expected: PASS.

- [ ] **Step 7: Commit Phase 2 Task 4**

```bash
git add src/agent/wiki/health.ts src/agent/wiki/lint.ts test/agent/wiki-health.test.ts test/agent/wiki-maintenance.test.ts
git commit -m "Report typed wiki page diagnostics"
```

## Phase 3: Read-Only Evidence Retrieval Contract

### Task 5: Evidence Retrieval Contract Facade

**Files:**
- Create: `src/agent/wiki/retrieval-contract.ts`
- Modify: `src/agent/wiki/index.ts`
- Test: `test/agent/wiki-retrieval-contract.test.ts`

- [ ] **Step 1: Write failing read-contract tests**

Create `test/agent/wiki-retrieval-contract.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writePaperWikiSource, writePaperWikiPage } from "../../src/agent/wiki/content.js";
import {
  readWikiEvidenceItem,
  listWikiEvidenceItems
} from "../../src/agent/wiki/retrieval-contract.js";
import { seedParsedPaper } from "./helpers/paper-reader-fixtures.js";

test("retrieval contract reads source evidence without exposing layout internals", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-retrieval-"));
  try {
    await seedParsedPaper({ workspace, paperKey: "arxiv-2601.00003", title: "Retrieval Source" });
    await writePaperWikiSource({
      workspaceDir: workspace,
      paperKey: "arxiv-2601.00003",
      title: "Retrieval Source",
      summaryMarkdown: "# Retrieval Source\n\nEvidence body.",
      tags: ["retrieval"]
    });

    const item = await readWikiEvidenceItem({
      workspaceDir: workspace,
      kind: "source",
      key: "arxiv-2601.00003"
    });

    assert.equal(item.status, "ready");
    assert.equal(item.item?.kind, "source");
    assert.equal(item.item?.key, "arxiv-2601.00003");
    assert.equal(item.item?.manifest?.status, "ready");
    assert.match(item.item?.body ?? "", /Evidence body/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("retrieval contract lists typed pages by tag and evidence contract", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-retrieval-list-"));
  try {
    await writePaperWikiPage({
      workspaceDir: workspace,
      topic: "Frequency allocation",
      pageKey: "frequency-allocation",
      title: "Frequency allocation",
      pageMarkdown: "# Frequency allocation\n\nSynthesis body.",
      tags: ["superconducting-qubits"],
      evidenceContract: "paper-backed",
      sourceCitations: [{ paperKey: "arxiv-2601.00003", path: "knowledge-base/sources/arxiv-2601.00003/summary.md" }]
    });

    const result = await listWikiEvidenceItems({
      workspaceDir: workspace,
      kinds: ["page"],
      tags: ["superconducting-qubits"],
      evidenceContracts: ["paper-backed"]
    });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, "page");
    assert.equal(result.items[0].key, "frequency-allocation");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run read-contract tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "retrieval contract"
```

Expected: FAIL because `retrieval-contract.ts` does not exist.

- [ ] **Step 3: Implement retrieval contract types and readers**

Create `src/agent/wiki/retrieval-contract.ts`:

```ts
export type WikiEvidenceKind = "source" | "page";
export type WikiEvidenceReadStatus = "ready" | "missing" | "malformed" | "blocked";

export interface WikiEvidenceItem {
  kind: WikiEvidenceKind;
  key: string;
  title: string;
  body: string;
  relativePath: string;
  tags: string[];
  aliases: string[];
  evidenceContract: WikiEvidenceContract;
  sourceRefs: string[];
  manifest?: WikiSourceManifest;
  diagnostics: string[];
}

export interface ReadWikiEvidenceItemOptions {
  workspaceDir: string;
  kind: WikiEvidenceKind;
  key: string;
}

export interface ReadWikiEvidenceItemResult {
  status: WikiEvidenceReadStatus;
  item?: WikiEvidenceItem;
  diagnostics: string[];
}
```

Implementation requirements:

- Source reads load typed source markdown and its manifest.
- Page reads load from `typed-store.ts`.
- All returned paths are workspace-relative.
- Missing manifests become diagnostics on source evidence, not thrown errors.
- `listWikiEvidenceItems()` supports filters for `kinds`, `tags`, `sourceRefs`, `evidenceContracts`, and `keys`.

- [ ] **Step 4: Export retrieval contract**

Add to `src/agent/wiki/index.ts`:

```ts
export * from "./retrieval-contract.js";
```

- [ ] **Step 5: Verify read-contract tests**

Run:

```bash
npm test -- --test-name-pattern "retrieval contract"
```

Expected: PASS.

- [ ] **Step 6: Commit Phase 3 Task 5**

```bash
git add src/agent/wiki/retrieval-contract.ts src/agent/wiki/index.ts test/agent/wiki-retrieval-contract.test.ts
git commit -m "Add wiki evidence retrieval contract"
```

### Task 6: Structured Evidence Search

**Files:**
- Create: `src/agent/wiki/retrieval-search.ts`
- Modify: `src/agent/wiki/content.ts`
- Modify: `src/agent/wiki/bootstrap.ts`
- Test: `test/agent/wiki-retrieval-contract.test.ts`
- Test: `test/agent/paper-reader.test.ts`

- [ ] **Step 1: Write failing structured-search test**

Add to `test/agent/wiki-retrieval-contract.test.ts`:

```ts
test("searchWikiEvidence returns match reasons and insufficient evidence status", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-structured-search-"));
  try {
    const empty = await searchWikiEvidence({
      workspaceDir: workspace,
      query: "frequency allocation",
      preferredKinds: ["source"],
      maxResults: 5
    });
    assert.equal(empty.status, "insufficient_evidence");
    assert.equal(empty.results.length, 0);

    await seedParsedPaper({ workspace, paperKey: "arxiv-2601.00003", title: "Frequency allocation in qubits" });
    await writePaperWikiSource({
      workspaceDir: workspace,
      paperKey: "arxiv-2601.00003",
      title: "Frequency allocation in qubits",
      summaryMarkdown: "# Frequency allocation in qubits\n\nKey findings mention frequency collisions.",
      tags: ["frequency-allocation"],
      keyFindings: ["Frequency allocation reduces collisions."]
    });

    const result = await searchWikiEvidence({
      workspaceDir: workspace,
      query: "frequency allocation",
      preferredKinds: ["source"],
      maxResults: 5
    });

    assert.equal(result.status, "ready");
    assert.equal(result.results[0].item.key, "arxiv-2601.00003");
    assert.ok(result.results[0].matchReasons.includes("title"));
    assert.ok(result.results[0].matchReasons.includes("tag"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run structured-search test and verify failure**

Run:

```bash
npm test -- --test-name-pattern "searchWikiEvidence"
```

Expected: FAIL because `searchWikiEvidence()` does not exist.

- [ ] **Step 3: Implement structured search**

Create `src/agent/wiki/retrieval-search.ts`:

```ts
export type WikiEvidenceSearchStatus = "ready" | "insufficient_evidence";

export interface WikiEvidenceSearchResult {
  item: WikiEvidenceItem;
  score: number;
  matchReasons: Array<"title" | "alias" | "tag" | "source_ref" | "body">;
  warnings: string[];
}

export interface WikiEvidenceSearchResponse {
  status: WikiEvidenceSearchStatus;
  query: string;
  results: WikiEvidenceSearchResult[];
  insufficientReason?: string;
}
```

Scoring rules:

- title match: `+8`
- alias match: `+6`
- tag match: `+6`
- source ref match: `+4`
- body match: `+1` per occurrence, capped at `+6`
- source evidence sorts before page evidence when `preferredKinds` contains `"source"` first
- page evidence sorts before source evidence when `preferredKinds` contains `"page"` first

- [ ] **Step 4: Route existing search through structured search**

Modify `searchPaperWiki()` in `src/agent/wiki/content.ts` so it calls `searchWikiEvidence()` and maps results back into the existing `PaperWikiSearchResult` shape. Preserve existing output fields: `kind`, `key`, `paperKey`, `pageKey`, `title`, `path`, `snippet`.

Modify `bootstrapPaperWikiPageEvidence()` in `src/agent/wiki/bootstrap.ts` so seed searches use `searchWikiEvidence()` and keep existing bootstrap result shape.

- [ ] **Step 5: Export structured search**

Add to `src/agent/wiki/index.ts`:

```ts
export * from "./retrieval-search.js";
```

- [ ] **Step 6: Verify focused search tests**

Run:

```bash
npm test -- --test-name-pattern "searchWikiEvidence|searchPaperWiki finds|bootstrapPaperWikiPageEvidence"
```

Expected: PASS.

- [ ] **Step 7: Commit Phase 3 Task 6**

```bash
git add src/agent/wiki/retrieval-search.ts src/agent/wiki/content.ts src/agent/wiki/bootstrap.ts src/agent/wiki/index.ts test/agent/wiki-retrieval-contract.test.ts test/agent/paper-reader.test.ts
git commit -m "Add structured wiki evidence search"
```

## Phase 4: Refactor Existing Wiki Tools Onto Core Layers

### Task 7: Journal All Multi-File Wiki Writes

**Files:**
- Modify: `src/agent/wiki/content.ts`
- Modify: `src/agent/wiki/structure-apply.ts`
- Modify: `src/agent/wiki/health.ts`
- Test: `test/agent/paper-reader.test.ts`
- Test: `test/agent/wiki-maintenance.test.ts`
- Test: `test/agent/wiki-health.test.ts`

- [ ] **Step 1: Add tests for journaled page and structure writes**

Add assertions to the existing page-write and structure-apply tests:

```ts
assert.equal(result.operationJournalPath, "knowledge-base/state/wiki-operations.jsonl");
const events = (await readFile(path.join(workspace, result.operationJournalPath), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.ok(events.some((event) => event.intent === "write_synthesis_page" && event.phase === "begin"));
assert.ok(events.some((event) => event.intent === "write_synthesis_page" && event.phase === "complete"));
```

For `applyWikiStructurePlan()`, assert the intent is `apply_structure_plan`.

- [ ] **Step 2: Add health test for interrupted operations**

Add to `test/agent/wiki-health.test.ts`:

```ts
test("checkWikiHealth reports interrupted wiki operations", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "state", "wiki-operations.jsonl"), JSON.stringify({
      schemaVersion: 1,
      phase: "begin",
      operationId: "wiki-op-test",
      intent: "write_synthesis_page",
      owner: "wiki-agent",
      startedAt: "2026-05-10T00:00:00.000Z",
      plannedFiles: ["knowledge-base/pages/test.md"],
      inputs: {}
    }) + "\n");

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.wiki_operation_interrupted, 1);
    assert.ok(result.issues.some((issue) => issue.kind === "wiki_operation_interrupted"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "write_synthesis_page|apply_structure_plan|interrupted wiki operations"
```

Expected: FAIL because these operations are not fully journaled and interrupted operations are not reported.

- [ ] **Step 4: Extend journal intent types**

In `src/agent/wiki/journal.ts`, extend `WikiOperationIntent`:

```ts
export type WikiOperationIntent =
  | "write_source_summary"
  | "write_synthesis_page"
  | "merge_aliases"
  | "apply_structure_plan"
  | "rebuild_index"
  | "repair";
```

- [ ] **Step 5: Wrap multi-file writes**

Wrap these operations:

- `writePaperWikiPage()` with `write_synthesis_page`
- `mergePaperWikiAliases()` with `merge_aliases`
- `applyWikiStructurePlan()` with `apply_structure_plan`
- deterministic health fixes that write more than one file with `repair`

Return `operationId` and `operationJournalPath` from result types where the operation writes files.

- [ ] **Step 6: Report interrupted operations**

In `health.ts`, read `wiki-operations.jsonl`, group by `operationId`, and report `wiki_operation_interrupted` when a `begin` event has no terminal `complete`, `failed`, or `cancelled` event. Add repair action that marks stale operations as `failed` with reason `interrupted operation detected by wiki_health`.

- [ ] **Step 7: Verify focused tests**

Run:

```bash
npm test -- --test-name-pattern "write_synthesis_page|apply_structure_plan|interrupted wiki operations"
```

Expected: PASS.

- [ ] **Step 8: Commit Phase 4 Task 7**

```bash
git add src/agent/wiki/content.ts src/agent/wiki/structure-apply.ts src/agent/wiki/health.ts test/agent/paper-reader.test.ts test/agent/wiki-maintenance.test.ts test/agent/wiki-health.test.ts
git commit -m "Journal wiki multi-file writes"
```

### Task 8: Existing Tools Consume Retrieval Contract

**Files:**
- Modify: `src/agent/wiki/tools.ts`
- Modify: `src/agent/wiki/bootstrap.ts`
- Modify: `src/agent/tools.ts`
- Test: `test/agent/tools.test.ts`
- Test: `test/agent/tools-extension.test.ts`

- [ ] **Step 1: Add tool tests for evidence status distinctions**

Add tests that call `answer_research_question` through the tool layer and assert the result distinguishes:

```ts
assert.equal(result.evidenceStatus, "local_evidence");
```

For an empty wiki with `autoDownload: false`, assert:

```ts
assert.equal(result.evidenceStatus, "insufficient_evidence");
assert.equal(result.localEvidence.length, 0);
```

For a blocklisted or license-denied source, assert:

```ts
assert.equal(result.evidenceStatus, "blocked_acquisition");
assert.ok(result.blocked.length >= 1);
```

- [ ] **Step 2: Run tool tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "answer_research_question"
```

Expected: FAIL because existing outputs do not expose the structured evidence status consistently.

- [ ] **Step 3: Update result shape internally while preserving old fields**

In the implementation behind `answer_research_question`, add:

```ts
type ResearchEvidenceStatus =
  | "local_evidence"
  | "newly_acquired_evidence"
  | "blocked_acquisition"
  | "insufficient_evidence";
```

Keep existing fields so older callers do not break. Add the new fields:

```ts
evidenceStatus: ResearchEvidenceStatus;
localEvidence: WikiEvidenceSearchResult[];
newEvidence: WikiEvidenceSearchResult[];
blocked: Array<{ paperKey?: string; reason: string; source?: string }>;
limitations: string[];
```

- [ ] **Step 4: Route local evidence reads through retrieval contract**

Replace direct `searchPaperWiki()` and file reads inside wiki answer flows with `searchWikiEvidence()` and `readWikiEvidenceItem()`. When evidence is enough, do not call external search/download.

- [ ] **Step 5: Verify focused tool tests**

Run:

```bash
npm test -- --test-name-pattern "answer_research_question|bootstrap_wiki_page_evidence|search_paper_wiki"
```

Expected: PASS.

- [ ] **Step 6: Commit Phase 4 Task 8**

```bash
git add src/agent/wiki/tools.ts src/agent/wiki/bootstrap.ts src/agent/tools.ts test/agent/tools.test.ts test/agent/tools-extension.test.ts
git commit -m "Route wiki tools through evidence contract"
```

## Phase 5: Wiki-Agent Coordinator

### Task 9: Deterministic Coordination Planner

**Files:**
- Create: `src/agent/wiki/coordinator.ts`
- Modify: `src/agent/wiki/index.ts`
- Test: `test/agent/wiki-coordinator.test.ts`

- [ ] **Step 1: Write failing coordinator tests**

Create `test/agent/wiki-coordinator.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { planWikiAgentWork } from "../../src/agent/wiki/coordinator.js";

test("coordinator answers locally when evidence is sufficient", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-coordinator-local-"));
  try {
    const plan = await planWikiAgentWork({
      workspaceDir: workspace,
      intent: "answer_scientific_question",
      query: "frequency allocation",
      localEvidenceCount: 3,
      hasBlockedAcquisition: false
    });

    assert.equal(plan.decision, "answer_from_local_wiki");
    assert.deepEqual(plan.steps.map((step) => step.action), [
      "search_local_evidence",
      "read_selected_evidence",
      "answer_with_citations"
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coordinator requests acquisition only for evidence gaps", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-coordinator-gap-"));
  try {
    const plan = await planWikiAgentWork({
      workspaceDir: workspace,
      intent: "answer_scientific_question",
      query: "frequency allocation",
      localEvidenceCount: 0,
      hasBlockedAcquisition: false
    });

    assert.equal(plan.decision, "acquire_then_summarize");
    assert.deepEqual(plan.steps.map((step) => step.action), [
      "search_local_evidence",
      "search_external_candidates",
      "download_candidate_papers",
      "generate_source_summaries",
      "rerun_local_retrieval",
      "answer_with_citations"
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run coordinator tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "coordinator"
```

Expected: FAIL because `coordinator.ts` does not exist.

- [ ] **Step 3: Implement coordinator types and planner**

Create `src/agent/wiki/coordinator.ts`:

```ts
export type WikiAgentIntent =
  | "answer_scientific_question"
  | "build_topic_page"
  | "maintenance_session";

export type WikiAgentDecision =
  | "answer_from_local_wiki"
  | "acquire_then_summarize"
  | "build_from_fixed_evidence"
  | "plan_maintenance"
  | "report_blocked_or_insufficient";

export type WikiAgentAction =
  | "search_local_evidence"
  | "read_selected_evidence"
  | "search_external_candidates"
  | "download_candidate_papers"
  | "generate_source_summaries"
  | "rerun_local_retrieval"
  | "answer_with_citations"
  | "bootstrap_topic_evidence"
  | "write_synthesis_page"
  | "run_health_and_lint"
  | "produce_structure_plan"
  | "apply_low_risk_repairs"
  | "summarize_remaining_risks";

export interface WikiAgentCoordinationStep {
  action: WikiAgentAction;
  owner: "wiki-agent" | "paper-download-subagent" | "wiki-evidence-worker" | "wiki-synthesis-worker";
  reason: string;
}

export interface WikiAgentCoordinationPlan {
  decision: WikiAgentDecision;
  intent: WikiAgentIntent;
  query?: string;
  steps: WikiAgentCoordinationStep[];
  handoff: Record<string, unknown>;
}
```

Implement `planWikiAgentWork()` as a deterministic planner. It should not call LLMs or download papers.

- [ ] **Step 4: Export coordinator**

Add to `src/agent/wiki/index.ts`:

```ts
export * from "./coordinator.js";
```

- [ ] **Step 5: Verify coordinator tests**

Run:

```bash
npm test -- --test-name-pattern "coordinator"
```

Expected: PASS.

- [ ] **Step 6: Commit Phase 5 Task 9**

```bash
git add src/agent/wiki/coordinator.ts src/agent/wiki/index.ts test/agent/wiki-coordinator.test.ts
git commit -m "Add wiki agent coordination planner"
```

### Task 10: Apply Coordinator Policy To Research And Page Workflows

**Files:**
- Modify: `src/agent/wiki/tools.ts`
- Modify: `src/agent/wiki/bootstrap.ts`
- Modify: `src/agent/wiki/summary.ts`
- Test: `test/agent/tools.test.ts`
- Test: `test/agent/tools-extension.test.ts`
- Test: `test/agent/wiki-coordinator.test.ts`

- [ ] **Step 1: Add tests that enforce worker boundaries**

Add tests for:

```ts
assert.equal(result.coordination.decision, "acquire_then_summarize");
assert.ok(result.coordination.steps.some((step) => step.owner === "paper-download-subagent"));
assert.ok(result.coordination.steps.some((step) => step.owner === "wiki-evidence-worker"));
assert.ok(!result.coordination.steps.some((step) =>
  step.owner === "wiki-agent" &&
  step.action === "download_candidate_papers"
));
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "worker boundaries|coordination"
```

Expected: FAIL because public workflow outputs do not include coordination plans.

- [ ] **Step 3: Add coordination output to workflows**

For `answer_research_question`, `bootstrap_wiki_page_evidence`, and `build_wiki_page`, add a `coordination` object using `planWikiAgentWork()`. Preserve existing fields.

- [ ] **Step 4: Enforce policy in code paths**

Rules to enforce:

- If local evidence is sufficient, skip external search and download.
- If local evidence is insufficient and `autoDownload` is `false`, return `insufficient_evidence`.
- If acquisition is blocked or license-denied, return `blocked_acquisition` and do not ask the user for routine access recovery.
- Source-summary construction remains owned by `wiki-evidence-worker`.
- Synthesis-page writing uses fixed evidence and refuses writes with an empty paper-backed `sourceCitations`.

- [ ] **Step 5: Verify focused workflow tests**

Run:

```bash
npm test -- --test-name-pattern "answer_research_question|bootstrap_wiki_page_evidence|build_wiki_page|coordination"
```

Expected: PASS.

- [ ] **Step 6: Commit Phase 5 Task 10**

```bash
git add src/agent/wiki/tools.ts src/agent/wiki/bootstrap.ts src/agent/wiki/summary.ts test/agent/tools.test.ts test/agent/tools-extension.test.ts test/agent/wiki-coordinator.test.ts
git commit -m "Apply wiki coordinator policy to workflows"
```

## Phase 6: Domain Execution Bindings And Knowledge Governance

### Task 11: Optional Domain Execution Bindings

**Files:**
- Create: `src/agent/wiki/domain-bindings.ts`
- Modify: `src/agent/wiki/page-schema.ts`
- Modify: `src/agent/wiki/index.ts`
- Test: `test/agent/wiki-domain-bindings.test.ts`

- [ ] **Step 1: Write failing domain-binding tests**

Create `test/agent/wiki-domain-bindings.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  listWikiDomainBindings,
  validateWikiDomainBinding
} from "../../src/agent/wiki/domain-bindings.js";

test("domain bindings expose validated helper metadata without executing arbitrary code", () => {
  const bindings = listWikiDomainBindings();
  assert.ok(bindings.some((binding) => binding.key === "transmon-frequency-estimate"));
  const binding = bindings.find((candidate) => candidate.key === "transmon-frequency-estimate");
  assert.equal(binding?.domain, "superconducting-qubits");
  assert.equal(binding?.executionMode, "deterministic-local");
});

test("validateWikiDomainBinding accepts known bindings and rejects unknown bindings", () => {
  assert.deepEqual(validateWikiDomainBinding("transmon-frequency-estimate"), {
    ok: true,
    key: "transmon-frequency-estimate"
  });
  assert.deepEqual(validateWikiDomainBinding("unknown-helper"), {
    ok: false,
    key: "unknown-helper",
    reason: "unknown_binding"
  });
});
```

- [ ] **Step 2: Run domain-binding tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "domain bindings"
```

Expected: FAIL because `domain-bindings.ts` does not exist.

- [ ] **Step 3: Implement binding registry**

Create `src/agent/wiki/domain-bindings.ts`:

```ts
export interface WikiDomainBinding {
  key: string;
  domain: "superconducting-qubits" | "benchmark" | "workflow";
  title: string;
  description: string;
  executionMode: "deterministic-local";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

const DOMAIN_BINDINGS: WikiDomainBinding[] = [
  {
    key: "transmon-frequency-estimate",
    domain: "superconducting-qubits",
    title: "Transmon frequency estimate",
    description: "Validated metadata hook for transmon and resonator estimate helpers.",
    executionMode: "deterministic-local",
    inputSchema: { type: "object", required: ["ej", "ec"] },
    outputSchema: { type: "object", required: ["frequencyGhz"] }
  }
];
```

Export `listWikiDomainBindings()` and `validateWikiDomainBinding(key)`. This task registers metadata only; it does not execute user-provided code.

- [ ] **Step 4: Extend page schema with optional execution binding**

Add to `WikiPageMetadata`:

```ts
execution_binding?: string;
```

Validation rule: if `execution_binding` is present, `validateWikiDomainBinding(execution_binding)` must return `ok: true`.

- [ ] **Step 5: Export domain bindings**

Add to `src/agent/wiki/index.ts`:

```ts
export * from "./domain-bindings.js";
```

- [ ] **Step 6: Verify domain-binding tests**

Run:

```bash
npm test -- --test-name-pattern "domain bindings|parseWikiPageMarkdown"
```

Expected: PASS.

- [ ] **Step 7: Commit Phase 6 Task 11**

```bash
git add src/agent/wiki/domain-bindings.ts src/agent/wiki/page-schema.ts src/agent/wiki/index.ts test/agent/wiki-domain-bindings.test.ts
git commit -m "Add wiki domain binding registry"
```

### Task 12: Governance Reports Derived From Core Stores

**Files:**
- Modify: `src/agent/wiki/health.ts`
- Modify: `src/agent/wiki/lint.ts`
- Modify: `src/agent/wiki/structure-plan.ts`
- Modify: `src/agent/wiki/relations.ts`
- Test: `test/agent/wiki-health.test.ts`
- Test: `test/agent/wiki-maintenance.test.ts`

- [ ] **Step 1: Add governance tests**

Add tests that seed:

- a manifest whose `parse.markdownPath` is missing
- a source summary not cited by any synthesis page
- repeated tags that deserve concept pages
- an alias candidate pair

Assert:

```ts
assert.ok(health.issues.some((issue) => issue.kind === "source_manifest_artifact_missing"));
assert.ok(lint.issues.some((issue) => issue.kind === "source_without_synthesis_coverage"));
assert.ok(plan.actions.some((action) => action.type === "create_concept_page"));
assert.ok(plan.actions.some((action) => action.type === "create_alias_page"));
```

- [ ] **Step 2: Run governance tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "source_manifest_artifact_missing|source_without_synthesis_coverage|create_concept_page|create_alias_page"
```

Expected: FAIL until governance diagnostics read typed pages and manifests.

- [ ] **Step 3: Implement manifest artifact checks**

In `health.ts`, use `readWikiSourceManifest()` for every manifest and verify workspace-relative paths exist:

- `sourceSummaryPath`
- `parse.markdownPath`
- `parse.jsonPath`
- `parse.qualityPath`
- `provenance.rawPdfPath` when present

Report `source_manifest_artifact_missing` with the missing path and manifest key.

- [ ] **Step 4: Implement synthesis coverage diagnostics**

In `lint.ts`, list source evidence and typed pages. Report `source_without_synthesis_coverage` when a ready source manifest is not referenced by any page `source_refs`.

- [ ] **Step 5: Use typed tags and aliases in structure planning**

In `structure-plan.ts`, use typed store tags and aliases instead of prose-only heuristics. Keep current ranking behavior, but add deterministic reasons derived from typed fields.

- [ ] **Step 6: Verify governance tests**

Run:

```bash
npm test -- --test-name-pattern "source_manifest_artifact_missing|source_without_synthesis_coverage|create_concept_page|create_alias_page"
```

Expected: PASS.

- [ ] **Step 7: Commit Phase 6 Task 12**

```bash
git add src/agent/wiki/health.ts src/agent/wiki/lint.ts src/agent/wiki/structure-plan.ts src/agent/wiki/relations.ts test/agent/wiki-health.test.ts test/agent/wiki-maintenance.test.ts
git commit -m "Derive wiki governance from typed stores"
```

## Final Integration And Release Verification

### Task 13: End-To-End Architecture Validation

**Files:**
- Modify: `docs/wiki-web-graph.md` if public graph behavior changes
- Modify: `README.md` only if new commands or tool names are exposed
- Modify: `test/agent/tool-organization.test.ts` if the source-file organization threshold changes

- [ ] **Step 1: Run TypeScript build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 2: Run focused wiki suite**

```bash
npm test -- --test-name-pattern "wiki|paper wiki|answer_research_question|bootstrap_wiki_page_evidence|build_wiki_page"
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: PASS. If sandboxed localhost tests fail with `listen EPERM`, rerun `npm test` with approved non-sandbox execution and record that reason in the final handoff.

- [ ] **Step 4: Run final status checks**

```bash
git status --short --branch
git log --oneline -5
```

Expected: working tree only contains intended files, and the phase commits are visible.

- [ ] **Step 5: Commit final docs or threshold updates**

```bash
git add README.md docs/wiki-web-graph.md test/agent/tool-organization.test.ts
git commit -m "Document wiki knowledge core architecture"
```

Only run this commit if one of those files changed during final integration.

## Phase Acceptance Criteria

Phase 2 is complete when:

- all wiki roots come from `resolveWikiWorkspaceContract()`
- typed page parsing reports malformed pages without breaking listing
- health and lint expose malformed page and weak evidence-contract diagnostics

Phase 3 is complete when:

- downstream callers can search and read wiki evidence through `retrieval-contract.ts`
- search results include match reasons, evidence type, warnings, and insufficient-evidence status
- `search_paper_wiki` and bootstrap evidence preserve existing public shapes while using the new retrieval core

Phase 4 is complete when:

- source writes, synthesis writes, alias merges, structure applies, index rebuilds, and repairs are journaled
- interrupted operations are visible in `wiki_health`
- existing wiki tools consume the retrieval contract instead of reaching into physical layout for normal reads

Phase 5 is complete when:

- coordinator plans make local-first, acquire-only-on-gap, summarize-through-worker decisions explicit
- public research and page workflows expose compact coordination metadata
- acquisition, parsing, evidence writing, synthesis writing, and paper writing remain separate responsibilities

Phase 6 is complete when:

- optional domain execution bindings are validated metadata, not arbitrary code execution
- governance reports derive from typed pages, manifests, and journal state
- index and graph views are treated as derived artifacts

## Self-Review

- Spec coverage: The plan maps the spec's seven architecture layers to Phase 2 through Phase 6. Phase 1 already covers source manifests and the first operation journal slice; Phase 2 covers workspace contract and typed store; Phase 3 covers the read contract and structured retrieval; Phase 4 migrates existing tools and write semantics; Phase 5 adds coordination policy; Phase 6 covers validated domain bindings and governance.
- Placeholder scan: The plan uses concrete file paths, function names, test names, issue kinds, commands, and expected outcomes. It avoids unresolved placeholder markers and vague "add tests" instructions.
- Type consistency: Shared names are stable across tasks: `resolveWikiWorkspaceContract`, `WikiTypedPage`, `WikiEvidenceItem`, `searchWikiEvidence`, `planWikiAgentWork`, `WikiDomainBinding`, `wiki_operation_interrupted`, and `source_manifest_artifact_missing`.
