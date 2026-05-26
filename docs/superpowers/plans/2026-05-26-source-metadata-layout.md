# Source Metadata Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split `source.json` plus top-level `manifests/` layout with per-source `metadata.json` as the single durable source manifest.

**Architecture:** Add a focused source metadata store under `src/agent/wiki/`, then migrate paper acquisition, local library indexing, wiki retrieval, source writing, and health checks to use `knowledge-base/sources/<sourceKey>/metadata.json`. Remove the old `source.json` paper metadata writes and top-level manifest writes instead of preserving compatibility branches.

**Tech Stack:** TypeScript ESM, Node `fs/promises`, Node test runner, existing `npm run build` and `npm test` workflow.

---

## File Structure

- Create `src/agent/wiki/source-metadata-store.ts`: owns `KnowledgeSourceMetadata` types, validators, path helper, read/write helpers, and identity validation for `sources/<sourceKey>/metadata.json`.
- Modify `src/agent/wiki/index.ts`: export the new source metadata store instead of the old manifest-store surface.
- Modify `src/agent/wiki/page-templates.ts`, `src/agent/wiki/types.ts`, `src/agent/wiki/tools.ts`, `src/agent/wiki/retrieval-search.ts`: import `WikiSourceKind` from the new source metadata store.
- Modify `src/agent/knowledge-base.ts`: remove `manifestsRoot` from the primary path contract.
- Modify `src/agent/wiki/workspace-contract.ts`: remove `"manifests"` from `WikiLifecycleKind` and workspace roots.
- Modify `src/agent/wiki/store.ts`: add `getKnowledgeSourceMetadataPath(...)`; remove public use of `getPaperWikiManifestsDir(...)` and `getPaperWikiSourceManifestPath(...)`.
- Modify `src/agent/paper/types.ts`: replace `PaperSourceMetadata` with the `KnowledgeSourceMetadata` contract for durable source metadata.
- Modify `src/agent/paper/storage/paper-store.ts`: write `metadata.json` next to `acquisition.json`; remove `resolvePaperSourcePath(...)` as the main path helper.
- Modify `src/agent/paper/storage/local-paper-library.ts`: read `metadata.json` instead of `source.json`.
- Modify `src/agent/paper/reading/paper-reader-store.ts`: return and update `metadataPath` instead of `sourcePath` where it refers to the source metadata file.
- Modify `src/agent/wiki/content.ts`: write source summaries and update `metadata.json` instead of writing top-level manifests.
- Modify `src/agent/wiki/retrieval-contract.ts`: read `metadata.json` for source evidence.
- Modify `src/agent/wiki/bootstrap.ts`: read `metadata.json` for source-kind and tag hints.
- Modify `src/agent/wiki/health.ts` and `src/agent/wiki/maintenance.ts`: report and repair missing/malformed `metadata.json`; remove top-level manifest health paths.
- Rename or rewrite `test/agent/wiki-manifest-store.test.ts` as `test/agent/source-metadata-store.test.ts`.
- Update focused tests in `test/agent/paper-store.test.ts`, `test/agent/local-paper-library.test.ts`, `test/agent/paper-reader.test.ts`, `test/agent/wiki-retrieval-contract.test.ts`, `test/agent/wiki-health.test.ts`, `test/agent/tools.test.ts`, and extension-host tests that currently assert `source.json`.
- Update docs references in `docs/code-architecture.md` after behavior changes are passing.

## Task 1: Add Source Metadata Store

**Files:**
- Create: `src/agent/wiki/source-metadata-store.ts`
- Modify: `src/agent/wiki/index.ts`
- Modify: `src/agent/wiki/page-templates.ts`
- Modify: `src/agent/wiki/types.ts`
- Modify: `src/agent/wiki/tools.ts`
- Modify: `src/agent/wiki/retrieval-search.ts`
- Test: `test/agent/source-metadata-store.test.ts`
- Remove later in this task: `test/agent/wiki-manifest-store.test.ts`

- [ ] **Step 1: Write the failing metadata-store tests**

Create `test/agent/source-metadata-store.test.ts` with these tests:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  getKnowledgeSourceMetadataPath,
  isWikiSourceKind,
  readKnowledgeSourceMetadata,
  validateKnowledgeSourceMetadataIdentity,
  writeKnowledgeSourceMetadata,
  type KnowledgeSourceMetadata
} from "../../src/agent/wiki/source-metadata-store.js";

async function withWorkspace(name: string, run: (workspaceDir: string) => Promise<void>): Promise<void> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), name));
  try {
    await run(workspaceDir);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function writeWorkspaceFile(workspaceDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(workspaceDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function metadata(overrides: Partial<KnowledgeSourceMetadata> = {}): KnowledgeSourceMetadata {
  const timestamp = "2026-05-26T00:00:00.000Z";
  return {
    schemaVersion: 1,
    sourceKind: "software-doc",
    sourceKey: "software-doc-hfss-eigenmode",
    title: "HFSS Eigenmode Solver Documentation",
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
    summaryPath: "knowledge-base/sources/software-doc-hfss-eigenmode/summary.md",
    citation: {
      citationStatus: "complete",
      missingFields: []
    },
    provenance: {
      url: "https://example.invalid/hfss/eigenmode",
      retrievedAt: timestamp,
      softwareName: "Ansys HFSS",
      softwareVersion: "2025 R2"
    },
    artifacts: [
      {
        kind: "snapshot",
        path: "knowledge-base/sources/software-doc-hfss-eigenmode/artifacts/snapshot.html"
      }
    ],
    tags: ["hfss", "em-simulation", "package-modes"],
    relatedSourceKeys: [],
    synthesisPageKeys: ["hfss-eigenmode-simulation-workflow"],
    ...overrides
  };
}

test("writeKnowledgeSourceMetadata writes metadata.json inside the source directory", async () => {
  await withWorkspace("source-metadata-write-", async (workspaceDir) => {
    const relativePath = await writeKnowledgeSourceMetadata({
      workspaceDir,
      metadata: metadata()
    });

    assert.equal(relativePath, "knowledge-base/sources/software-doc-hfss-eigenmode/metadata.json");
    const rawText = await readFile(path.join(workspaceDir, relativePath), "utf8");
    assert.ok(rawText.includes('\n  "schemaVersion": 1,\n'));
    assert.ok(rawText.endsWith("\n"));
    const persisted = JSON.parse(rawText) as KnowledgeSourceMetadata;
    assert.equal(persisted.sourceKind, "software-doc");
    assert.equal(persisted.sourceKey, "software-doc-hfss-eigenmode");
    assert.equal(persisted.provenance.softwareName, "Ansys HFSS");
  });
});

test("readKnowledgeSourceMetadata reads metadata.json by source key", async () => {
  await withWorkspace("source-metadata-read-", async (workspaceDir) => {
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/sources/material-sapphire-permittivity/metadata.json",
      `${JSON.stringify(metadata({
        sourceKind: "material-database",
        sourceKey: "material-sapphire-permittivity",
        title: "Sapphire permittivity values",
        status: "needs_review",
        summaryPath: "knowledge-base/sources/material-sapphire-permittivity/summary.md",
        provenance: {
          url: "https://example.invalid/materials/sapphire",
          retrievedAt: "2026-05-26T00:00:00.000Z"
        },
        artifacts: [
          {
            kind: "table",
            path: "knowledge-base/sources/material-sapphire-permittivity/artifacts/parameters.json"
          }
        ],
        tags: ["materials", "sapphire"],
        synthesisPageKeys: []
      }), null, 2)}\n`
    );

    const result = await readKnowledgeSourceMetadata({
      workspaceDir,
      sourceKey: "material-sapphire-permittivity"
    });

    assert.equal(result.status, "ready");
    assert.equal(result.metadata?.sourceKind, "material-database");
    assert.equal(result.metadata?.sourceKey, "material-sapphire-permittivity");
    assert.equal(result.metadata?.status, "needs_review");
  });
});

test("readKnowledgeSourceMetadata rejects sourceKey mismatches", async () => {
  await withWorkspace("source-metadata-identity-", async (workspaceDir) => {
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/sources/material-sapphire-permittivity/metadata.json",
      `${JSON.stringify(metadata({
        sourceKind: "material-database",
        sourceKey: "material-silicon-permittivity",
        title: "Mismatched material metadata"
      }), null, 2)}\n`
    );

    const result = await readKnowledgeSourceMetadata({
      workspaceDir,
      sourceKey: "material-sapphire-permittivity"
    });

    assert.equal(result.status, "malformed");
    assert.match(result.diagnostics.join("\n"), /does not match requested source key/);
  });
});

test("readKnowledgeSourceMetadata rejects malformed metadata", async () => {
  await withWorkspace("source-metadata-malformed-", async (workspaceDir) => {
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/sources/malformed/metadata.json",
      `${JSON.stringify({
        ...metadata({ sourceKey: "malformed" }),
        artifacts: [{ kind: "table" }]
      }, null, 2)}\n`
    );

    const result = await readKnowledgeSourceMetadata({
      workspaceDir,
      sourceKey: "malformed"
    });

    assert.equal(result.status, "malformed");
    assert.match(result.diagnostics.join("\n"), /malformed metadata shape/);
  });
});

test("metadata path helper points inside sources sourceKey directory", () => {
  const workspaceDir = path.resolve("/workspace");
  assert.equal(
    getKnowledgeSourceMetadataPath(workspaceDir, "arxiv-2601.00003"),
    path.join(workspaceDir, "knowledge-base", "sources", "arxiv-2601.00003", "metadata.json")
  );
});

test("wiki source kinds exclude design artifacts owned by design-repo", () => {
  assert.equal(isWikiSourceKind("design-artifact"), false);
  assert.equal(isWikiSourceKind("code-output"), true);
});

test("validateKnowledgeSourceMetadataIdentity checks summary path when provided", () => {
  const diagnostics = validateKnowledgeSourceMetadataIdentity({
    metadata: metadata(),
    sourceKey: "software-doc-hfss-eigenmode",
    summaryPath: "knowledge-base/sources/software-doc-hfss-eigenmode/wrong.md"
  });

  assert.match(diagnostics.join("\n"), /metadata summaryPath/);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm run build
```

Expected: FAIL because `src/agent/wiki/source-metadata-store.ts` does not exist yet and imports cannot be resolved.

- [ ] **Step 3: Implement the source metadata store**

Create `src/agent/wiki/source-metadata-store.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPaperWikiSourcesDir, relativeToWorkspace, sanitizeWikiFilename } from "./store.js";

export type WikiSourceKind =
  | "paper"
  | "material-database"
  | "software-doc"
  | "vendor-note"
  | "standard"
  | "lab-note"
  | "code-output"
  | "webpage"
  | "manual";

export type KnowledgeSourceStatus =
  | "ready"
  | "stale"
  | "blocked"
  | "low_quality"
  | "citation_incomplete"
  | "missing_artifact"
  | "version_unknown"
  | "needs_review";

export type KnowledgeSourceArtifactKind =
  | "raw"
  | "parse"
  | "chunk"
  | "table"
  | "figure"
  | "script"
  | "result"
  | "log"
  | "snapshot";

export interface KnowledgeSourceArtifact {
  kind: KnowledgeSourceArtifactKind;
  path: string;
  engine?: string;
  markdownPath?: string;
  jsonPath?: string;
  qualityPath?: string;
  sha256?: string;
  note?: string;
}

export interface KnowledgeSourceMetadata {
  schemaVersion: 1;
  sourceKind: WikiSourceKind;
  sourceKey: string;
  title: string;
  status: KnowledgeSourceStatus;
  createdAt: string;
  updatedAt: string;
  summaryPath?: string;
  citation?: {
    authors?: string[];
    year?: number;
    venue?: string;
    publisher?: string;
    doi?: string;
    arxivId?: string;
    citationStatus?: "complete" | "incomplete";
    missingFields?: string[];
  };
  provenance: {
    url?: string;
    pdfUrl?: string;
    rawPath?: string;
    rawSha256?: string;
    acquisitionPath?: string;
    retrievedAt?: string;
    version?: string;
    softwareName?: string;
    softwareVersion?: string;
    vendor?: string;
    license?: string;
  };
  artifacts: KnowledgeSourceArtifact[];
  tags: string[];
  relatedSourceKeys: string[];
  synthesisPageKeys: string[];
  reviewNotes?: string[];
}

export type KnowledgeSourceMetadataReadStatus = "ready" | "missing" | "malformed";

export interface ReadKnowledgeSourceMetadataResult {
  status: KnowledgeSourceMetadataReadStatus;
  metadata?: KnowledgeSourceMetadata;
  diagnostics: string[];
}

export const WIKI_SOURCE_KINDS: readonly WikiSourceKind[] = [
  "paper",
  "material-database",
  "software-doc",
  "vendor-note",
  "standard",
  "lab-note",
  "code-output",
  "webpage",
  "manual"
];

const WIKI_SOURCE_KIND_SET = new Set<string>(WIKI_SOURCE_KINDS);
const KNOWLEDGE_SOURCE_STATUSES = new Set<string>([
  "ready",
  "stale",
  "blocked",
  "low_quality",
  "citation_incomplete",
  "missing_artifact",
  "version_unknown",
  "needs_review"
]);
const ARTIFACT_KINDS = new Set<string>([
  "raw",
  "parse",
  "chunk",
  "table",
  "figure",
  "script",
  "result",
  "log",
  "snapshot"
]);
const ARTIFACT_OPTIONAL_STRING_FIELDS = ["engine", "markdownPath", "jsonPath", "qualityPath", "sha256", "note"] as const;
const PROVENANCE_OPTIONAL_STRING_FIELDS = [
  "url",
  "pdfUrl",
  "rawPath",
  "rawSha256",
  "acquisitionPath",
  "retrievedAt",
  "version",
  "softwareName",
  "softwareVersion",
  "vendor",
  "license"
] as const;

export function isWikiSourceKind(value: unknown): value is WikiSourceKind {
  return typeof value === "string" && WIKI_SOURCE_KIND_SET.has(value);
}

export function getKnowledgeSourceMetadataPath(workspaceDir: string, sourceKey: string): string {
  return path.join(getPaperWikiSourcesDir(workspaceDir), sanitizeWikiFilename(sourceKey), "metadata.json");
}

export async function writeKnowledgeSourceMetadata(input: {
  workspaceDir: string;
  metadata: KnowledgeSourceMetadata;
}): Promise<string> {
  const metadataPath = getKnowledgeSourceMetadataPath(input.workspaceDir, input.metadata.sourceKey);
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify(input.metadata, null, 2)}\n`, "utf8");
  return relativeToWorkspace(input.workspaceDir, metadataPath);
}

export async function readKnowledgeSourceMetadata(input: {
  workspaceDir: string;
  sourceKey: string;
  summaryPath?: string;
}): Promise<ReadKnowledgeSourceMetadataResult> {
  const metadataPath = getKnowledgeSourceMetadataPath(input.workspaceDir, input.sourceKey);
  const relativePath = relativeToWorkspace(input.workspaceDir, metadataPath);
  try {
    const rawMetadata = await readFile(metadataPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMetadata);
    } catch (error) {
      return {
        status: "malformed",
        diagnostics: [`${relativePath}: malformed metadata JSON: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
    if (!isKnowledgeSourceMetadata(parsed)) {
      return {
        status: "malformed",
        diagnostics: [`${relativePath}: malformed metadata shape.`]
      };
    }
    const identityDiagnostics = validateKnowledgeSourceMetadataIdentity({
      metadata: parsed,
      sourceKey: input.sourceKey,
      ...(input.summaryPath ? { summaryPath: input.summaryPath } : {})
    });
    if (identityDiagnostics.length > 0) {
      return {
        status: "malformed",
        diagnostics: identityDiagnostics.map((diagnostic) => `${relativePath}: malformed metadata identity: ${diagnostic}`)
      };
    }
    return {
      status: "ready",
      metadata: parsed,
      diagnostics: []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "missing",
        diagnostics: [`${relativePath}: missing metadata for source.`]
      };
    }
    return {
      status: "malformed",
      diagnostics: [`${relativePath}: unable to read metadata: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

export function validateKnowledgeSourceMetadataIdentity(input: {
  metadata: KnowledgeSourceMetadata;
  sourceKey: string;
  summaryPath?: string;
}): string[] {
  const diagnostics: string[] = [];
  if (input.metadata.sourceKey !== input.sourceKey) {
    diagnostics.push(`metadata sourceKey "${input.metadata.sourceKey}" does not match requested source key "${input.sourceKey}".`);
  }
  if (
    input.summaryPath !== undefined &&
    input.metadata.summaryPath !== undefined &&
    normalizeMetadataRelativePath(input.metadata.summaryPath) !== normalizeMetadataRelativePath(input.summaryPath)
  ) {
    diagnostics.push(`metadata summaryPath "${input.metadata.summaryPath}" does not match source summary path "${input.summaryPath}".`);
  }
  return diagnostics;
}

function normalizeMetadataRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasOptionalStringFields<T extends readonly string[]>(value: Record<string, unknown>, fields: T): boolean {
  return fields.every((field) => value[field] === undefined || typeof value[field] === "string");
}

function isKnowledgeSourceArtifact(value: unknown): value is KnowledgeSourceArtifact {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    ARTIFACT_KINDS.has(value.kind) &&
    typeof value.path === "string" &&
    hasOptionalStringFields(value, ARTIFACT_OPTIONAL_STRING_FIELDS)
  );
}

function isKnowledgeSourceCitation(value: unknown): value is KnowledgeSourceMetadata["citation"] {
  return (
    value === undefined ||
    (
      isRecord(value) &&
      (value.authors === undefined || isStringArray(value.authors)) &&
      (value.year === undefined || typeof value.year === "number") &&
      hasOptionalStringFields(value, ["venue", "publisher", "doi", "arxivId", "citationStatus"] as const) &&
      (value.citationStatus === undefined || value.citationStatus === "complete" || value.citationStatus === "incomplete") &&
      (value.missingFields === undefined || isStringArray(value.missingFields))
    )
  );
}

function isKnowledgeSourceMetadata(value: unknown): value is KnowledgeSourceMetadata {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isWikiSourceKind(value.sourceKind) &&
    typeof value.sourceKey === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    KNOWLEDGE_SOURCE_STATUSES.has(value.status) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.summaryPath === undefined || typeof value.summaryPath === "string") &&
    isKnowledgeSourceCitation(value.citation) &&
    isRecord(value.provenance) &&
    hasOptionalStringFields(value.provenance, PROVENANCE_OPTIONAL_STRING_FIELDS) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isKnowledgeSourceArtifact) &&
    isStringArray(value.tags) &&
    isStringArray(value.relatedSourceKeys) &&
    isStringArray(value.synthesisPageKeys) &&
    (value.reviewNotes === undefined || isStringArray(value.reviewNotes))
  );
}
```

- [ ] **Step 4: Export and update type imports**

Modify `src/agent/wiki/index.ts`:

```ts
export * from "./source-metadata-store.js";
```

In `src/agent/wiki/page-templates.ts`, `src/agent/wiki/types.ts`, `src/agent/wiki/tools.ts`, and `src/agent/wiki/retrieval-search.ts`, replace:

```ts
import type { WikiSourceKind } from "./manifest-store.js";
```

with:

```ts
import type { WikiSourceKind } from "./source-metadata-store.js";
```

In `src/agent/wiki/tools.ts`, replace the mixed import from `./manifest-store.js` with:

```ts
import { isWikiSourceKind, type WikiSourceKind } from "./source-metadata-store.js";
```

- [ ] **Step 5: Remove old manifest-store test file from the test suite**

Delete `test/agent/wiki-manifest-store.test.ts`. Keep `src/agent/wiki/manifest-store.ts` until later tasks have migrated all imports.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/source-metadata-store.test.js
```

Expected: PASS for the new metadata-store tests.

- [ ] **Step 7: Commit**

```bash
git add src/agent/wiki/source-metadata-store.ts src/agent/wiki/index.ts src/agent/wiki/page-templates.ts src/agent/wiki/types.ts src/agent/wiki/tools.ts src/agent/wiki/retrieval-search.ts test/agent/source-metadata-store.test.ts test/agent/wiki-manifest-store.test.ts
git commit -m "Add source metadata store"
```

## Task 2: Update Workspace And Path Helpers

**Files:**
- Modify: `src/agent/knowledge-base.ts`
- Modify: `src/agent/wiki/workspace-contract.ts`
- Modify: `src/agent/wiki/store.ts`
- Test: `test/agent/paper-store.test.ts`
- Test: `test/agent/wiki-retrieval-contract.test.ts`

- [ ] **Step 1: Write failing path contract assertions**

In `test/agent/paper-store.test.ts`, update the path contract test to assert there is no primary `manifestsRoot`:

```ts
test("resolvePaperLibraryPaths exposes source directories without top-level manifests root", () => {
  const workspaceDir = path.resolve("/tmp/pi-workspace");
  const paths = resolvePaperLibraryPaths(workspaceDir);

  assert.equal(paths.sourceArtifactsRoot, path.join(workspaceDir, "knowledge-base", "sources"));
  assert.equal(paths.sourcesRoot, path.join(workspaceDir, "knowledge-base", "sources"));
  assert.equal(Object.hasOwn(paths, "manifestsRoot"), false);
});
```

In `test/agent/wiki-retrieval-contract.test.ts`, add a helper expectation near source evidence tests:

```ts
assert.equal(
  getKnowledgeSourceMetadataPath(workspaceDir, paperKey),
  path.join(workspaceDir, "knowledge-base", "sources", paperKey, "metadata.json")
);
```

Import it:

```ts
import { getKnowledgeSourceMetadataPath } from "../../src/agent/wiki/source-metadata-store.js";
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm run build
```

Expected: FAIL while `PaperLibraryPaths` still requires `manifestsRoot` and workspace contract still exposes `manifests`.

- [ ] **Step 3: Remove `manifestsRoot` from the knowledge-base path contract**

Modify `src/agent/knowledge-base.ts`:

```ts
export interface PaperLibraryPaths {
  workspaceDir: string;
  libraryRoot: string;
  rawRoot: string;
  rawPdfRoot: string;
  wikiRoot: string;
  sourceArtifactsRoot: string;
  sourcesRoot: string;
  pagesRoot: string;
  assetsRoot: string;
  stateRoot: string;
  indexPath: string;
  logPath: string;
}
```

And remove this returned property from `resolvePaperLibraryPaths(...)`:

```ts
manifestsRoot: path.join(wikiRoot, "manifests"),
```

- [ ] **Step 4: Remove `manifests` from workspace lifecycle roots**

Modify `src/agent/wiki/workspace-contract.ts`:

```ts
export type WikiLifecycleKind =
  | "rawInputs"
  | "sourceRecords"
  | "parseArtifacts"
  | "sourceSummaries"
  | "synthesisPages"
  | "assets"
  | "runtimeState";
```

And remove the `manifests` root from `resolveWikiWorkspaceContract(...)`.

- [ ] **Step 5: Replace manifest path helpers in `store.ts`**

In `src/agent/wiki/store.ts`, remove `getPaperWikiManifestsDir(...)` and `getPaperWikiSourceManifestPath(...)`.

Add:

```ts
export function getKnowledgeSourceMetadataPath(workspaceDir: string, sourceKey: string): string {
  return wikiPathForLifecycle(
    resolveWikiWorkspaceContract(workspaceDir),
    "sourceRecords",
    `${sanitizeWikiFilename(sourceKey)}/metadata.json`
  ).absolutePath;
}
```

Keep `source-metadata-store.ts` as the public import location for this helper. Use the `store.ts` helper only from modules that already depend on `store.ts`.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/paper-store.test.js dist/test/agent/source-metadata-store.test.js
```

Expected: PASS for path and metadata-store tests.

- [ ] **Step 7: Commit**

```bash
git add src/agent/knowledge-base.ts src/agent/wiki/workspace-contract.ts src/agent/wiki/store.ts test/agent/paper-store.test.ts test/agent/wiki-retrieval-contract.test.ts
git commit -m "Use per-source metadata path contract"
```

## Task 3: Migrate Paper Store From `source.json` To `metadata.json`

**Files:**
- Modify: `src/agent/paper/types.ts`
- Modify: `src/agent/paper/storage/paper-store.ts`
- Modify: `src/agent/paper/reading/paper-reader-store.ts`
- Test: `test/agent/paper-store.test.ts`
- Test: `test/agent/paper-reader.test.ts`
- Test: `test/agent/paper-extension-host.test.ts`
- Test: `test/agent/paper-manager.test.ts`

- [ ] **Step 1: Update paper-store tests first**

In `test/agent/paper-store.test.ts`, replace assertions that read `source.json` with `metadata.json`. The main write test should assert:

```ts
test("writePaperRecord writes citation metadata into metadata.json next to acquisition state", async () => {
  await withWorkspace("paper-store-metadata-", async (workspaceDir) => {
    const recordPath = path.join(workspaceDir, "knowledge-base", "sources", "science-10.1126-science.adz8659", "acquisition.json");
    await writePaperRecord({
      workspaceDir,
      recordPath,
      record: {
        source: "science",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        canonicalId: "10.1126/science.adz8659",
        title: "A test Science paper",
        status: "downloaded",
        recordedAt: "2026-05-26T00:00:00.000Z",
        downloadPath: path.join(workspaceDir, "knowledge-base", "raw", "pdfs", "science-10.1126-science.adz8659.pdf")
      }
    });

    const metadataPath = path.join(path.dirname(recordPath), "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as KnowledgeSourceMetadata;
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.sourceKind, "paper");
    assert.equal(metadata.sourceKey, "science-10.1126-science.adz8659");
    assert.equal(metadata.title, "A test Science paper");
    assert.equal(metadata.provenance.acquisitionPath, "knowledge-base/sources/science-10.1126-science.adz8659/acquisition.json");
    assert.equal(metadata.provenance.url, "https://www.science.org/doi/10.1126/science.adz8659");
    assert.equal(metadata.citation?.doi, "10.1126/science.adz8659");
    await assert.rejects(readFile(path.join(path.dirname(recordPath), "source.json"), "utf8"));
  });
});
```

Import:

```ts
import type { KnowledgeSourceMetadata } from "../../src/agent/wiki/source-metadata-store.js";
```

- [ ] **Step 2: Run the failing paper-store tests**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/paper-store.test.js
```

Expected: FAIL because current code still writes and reads `source.json`.

- [ ] **Step 3: Replace paper source metadata types**

In `src/agent/paper/types.ts`, replace the paper-only `PaperSourceMetadata` interface with this alias:

```ts
export type PaperSourceMetadata = KnowledgeSourceMetadata;
```

Add the import:

```ts
import type { KnowledgeSourceMetadata } from "../wiki/source-metadata-store.js";
```

Then prefer `KnowledgeSourceMetadata` in new code paths.

- [ ] **Step 4: Replace paper metadata path helpers**

In `src/agent/paper/storage/paper-store.ts`, replace:

```ts
export function resolvePaperSourcePath(input: {
  workspaceDir: string;
  source: PaperSource;
  canonicalId?: string;
  articleUrl: string;
}): string {
  return path.join(path.dirname(resolvePaperRecordPath(input)), "source.json");
}

function resolvePaperSourcePathFromRecordPath(recordPath: string): string {
  return path.join(path.dirname(recordPath), "source.json");
}
```

with:

```ts
export function resolvePaperMetadataPath(input: {
  workspaceDir: string;
  source: PaperSource;
  canonicalId?: string;
  articleUrl: string;
}): string {
  return path.join(path.dirname(resolvePaperRecordPath(input)), "metadata.json");
}

function resolvePaperMetadataPathFromRecordPath(recordPath: string): string {
  return path.join(path.dirname(recordPath), "metadata.json");
}
```

- [ ] **Step 5: Build `KnowledgeSourceMetadata` in the paper store**

Replace `writePaperSourceMetadataForRecord(...)` with `writePaperMetadataForRecord(...)`:

```ts
export async function writePaperMetadataForRecord(input: {
  workspaceDir: string;
  record: PaperRecord;
  recordPath: string;
  enrichCitationMetadata?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const metadataPath = resolvePaperMetadataPathFromRecordPath(input.recordPath);
  const existing = await readExistingKnowledgeSourceMetadata(metadataPath);
  const acquisitionPath = toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: input.recordPath });
  const baseDoi = getRecordDoi(input.record) ?? existing?.citation?.doi;
  const baseArxivId = getRecordArxivId(input.record) ?? existing?.citation?.arxivId;
  const baseTitle = readRecordString(input.record, "title") ?? existing?.title;
  const localParseMetadata = await readLocalParseCitationMetadata({
    workspaceDir: input.workspaceDir,
    record: input.record,
    ...(baseArxivId ? { arxivId: baseArxivId } : {})
  });
  const remoteMetadata = input.enrichCitationMetadata
    ? await readRemoteCitationMetadata({
        ...(baseDoi ? { doi: baseDoi } : {}),
        ...(baseArxivId ? { arxivId: baseArxivId } : {}),
        ...(baseTitle ? { title: baseTitle } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
      })
    : undefined;
  const title = completeString(readRecordString(input.record, "title"), existing?.title, localParseMetadata?.title, remoteMetadata?.title) ?? paperKeyFromRecordPath(input.recordPath);
  const authors = completeAuthors(existing?.citation?.authors ?? [], localParseMetadata?.authors, remoteMetadata?.authors);
  const year = completeNumber(existing?.citation?.year, localParseMetadata?.year, remoteMetadata?.year);
  const venue = completeString(
    existing?.citation?.venue,
    localParseMetadata?.venue,
    remoteMetadata?.venue,
    getApsVenueFromDoi(baseDoi),
    getVenueFromArticleUrl(input.record.articleUrl),
    baseArxivId ? "arXiv" : undefined
  );
  const publisher = getRecordPublisher(input.record) ?? existing?.citation?.publisher;
  const doi = baseDoi ?? localParseMetadata?.doi ?? remoteMetadata?.doi;
  const arxivId = baseArxivId ?? remoteMetadata?.arxivId;
  const missingFields = getMissingCitationFields({ title, authors, year, venue, doi, arxivId, articleUrl: input.record.articleUrl });
  const pdfUrl = getRecordPdfUrl(input.record);
  const downloadPath = getRecordDownloadPath(input.record);
  const sourceKey = paperKeyFromRecordPath(input.recordPath);
  const now = new Date().toISOString();
  const metadata: KnowledgeSourceMetadata = {
    schemaVersion: 1,
    sourceKind: "paper",
    sourceKey,
    title,
    status: missingFields.length === 0 ? "ready" : "citation_incomplete",
    createdAt: existing?.createdAt ?? readRecordString(input.record, "recordedAt") ?? now,
    updatedAt: now,
    ...(existing?.summaryPath ? { summaryPath: existing.summaryPath } : {}),
    citation: {
      authors,
      ...(typeof year === "number" ? { year } : {}),
      ...(venue ? { venue } : {}),
      ...(publisher ? { publisher } : {}),
      ...(doi ? { doi } : {}),
      ...(arxivId ? { arxivId } : {}),
      citationStatus: missingFields.length === 0 ? "complete" : "incomplete",
      missingFields
    },
    provenance: {
      url: input.record.articleUrl,
      ...(pdfUrl ? { pdfUrl } : {}),
      ...(downloadPath ? { rawPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: downloadPath }) } : {}),
      acquisitionPath
    },
    artifacts: existing?.artifacts ?? [],
    tags: existing?.tags ?? [],
    relatedSourceKeys: existing?.relatedSourceKeys ?? [],
    synthesisPageKeys: existing?.synthesisPageKeys ?? []
  };
  await writeKnowledgeSourceMetadata({ workspaceDir: input.workspaceDir, metadata });
  return metadataPath;
}
```

Add imports:

```ts
import {
  readKnowledgeSourceMetadata,
  writeKnowledgeSourceMetadata,
  type KnowledgeSourceMetadata
} from "../../wiki/source-metadata-store.js";
```

Add this local reader next to the paper metadata writer:

```ts
async function readExistingKnowledgeSourceMetadata(metadataPath: string): Promise<KnowledgeSourceMetadata | undefined> {
  try {
    return JSON.parse(await readFile(metadataPath, "utf8")) as KnowledgeSourceMetadata;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 6: Replace source-refresh helper with metadata-refresh helper**

Replace `writePaperSourceMetadataForSource(...)` with:

```ts
export async function writePaperMetadataForSourceDirectory(input: {
  workspaceDir: string;
  sourceDir: string;
  enrichCitationMetadata?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const sourceDir = path.isAbsolute(input.sourceDir)
    ? path.resolve(input.sourceDir)
    : path.resolve(input.workspaceDir, input.sourceDir);
  const metadataPath = path.join(sourceDir, "metadata.json");
  const existing = await readExistingKnowledgeSourceMetadata(metadataPath);
  if (!existing?.provenance.url) {
    throw new Error("metadata.json must include provenance.url before citation metadata can be refreshed.");
  }
  const recordPath = path.join(sourceDir, "acquisition.json");
  const record = paperRecordFromKnowledgeSourceMetadata({ existing });
  return writePaperMetadataForRecord({
    workspaceDir: input.workspaceDir,
    record,
    recordPath,
    enrichCitationMetadata: input.enrichCitationMetadata,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}
```

Replace `paperRecordFromSourceMetadata(...)` with `paperRecordFromKnowledgeSourceMetadata(...)` that reads from `existing.sourceKind`, `existing.provenance.url`, `existing.citation`, and `existing.provenance.rawPath`.

- [ ] **Step 7: Update write wrapper**

In `writePaperRecordAndSourceMetadata(...)`, rename the function to `writePaperRecordAndMetadata(...)` and call:

```ts
await writePaperMetadataForRecord({
  workspaceDir: input.workspaceDir,
  record: input.record,
  recordPath: input.recordPath,
  ...(input.enrichCitationMetadata !== undefined ? { enrichCitationMetadata: input.enrichCitationMetadata } : {}),
  ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
});
```

Update callers in the same file.

- [ ] **Step 8: Update reader-store naming**

In `src/agent/paper/reading/paper-reader-store.ts`, change return fields that refer to the metadata file from:

```ts
sourcePath: path.join(paperDir, "source.json"),
```

to:

```ts
metadataPath: path.join(paperDir, "metadata.json"),
```

Rename public result fields that point at the metadata file from `sourcePath` to `metadataPath`, then update compile errors and tests to use `metadataPath`.

- [ ] **Step 9: Run targeted paper tests**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/paper-store.test.js dist/test/agent/paper-reader.test.js dist/test/agent/paper-extension-host.test.js dist/test/agent/paper-manager.test.js
```

Expected: PASS after all `source.json` paper metadata assertions are updated to `metadata.json`.

- [ ] **Step 10: Commit**

```bash
git add src/agent/paper/types.ts src/agent/paper/storage/paper-store.ts src/agent/paper/reading/paper-reader-store.ts test/agent/paper-store.test.ts test/agent/paper-reader.test.ts test/agent/paper-extension-host.test.ts test/agent/paper-manager.test.ts
git commit -m "Write paper metadata to metadata json"
```

## Task 4: Migrate Local Library And Paper Relation Readers

**Files:**
- Modify: `src/agent/paper/storage/local-paper-library.ts`
- Modify: `src/agent/wiki/summary.ts`
- Modify: `src/agent/wiki/relations.ts`
- Test: `test/agent/local-paper-library.test.ts`
- Test: `test/agent/paper-summary.test.ts`
- Test: `test/agent/paper-relations.test.ts`

- [ ] **Step 1: Update local library tests to write `metadata.json`**

In `test/agent/local-paper-library.test.ts`, replace fixture writes like:

```ts
await writeJson(path.join(paperDir, "source.json"), {
  schemaVersion: 2,
  paperKey,
  source: "nature",
  title: "Paper title",
  authors: ["A. Author"],
  articleUrl: "https://example.invalid/paper",
  acquisitionPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
  recordPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
  downloadStatus: "downloaded",
  citationStatus: "complete",
  missingFields: [],
  resolvedFrom: "acquisition",
  sourceConfidence: "high",
  recordedAt: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-26T00:00:00.000Z"
});
```

with:

```ts
await writeJson(path.join(paperDir, "metadata.json"), {
  schemaVersion: 1,
  sourceKind: "paper",
  sourceKey: paperKey,
  title: "Paper title",
  status: "ready",
  createdAt: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-26T00:00:00.000Z",
  citation: {
    authors: ["A. Author"],
    citationStatus: "complete",
    missingFields: []
  },
  provenance: {
    url: "https://example.invalid/paper",
    acquisitionPath: `knowledge-base/sources/${paperKey}/acquisition.json`
  },
  artifacts: [],
  tags: [],
  relatedSourceKeys: [],
  synthesisPageKeys: []
});
```

- [ ] **Step 2: Run failing local library tests**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/local-paper-library.test.js dist/test/agent/paper-summary.test.js dist/test/agent/paper-relations.test.js
```

Expected: FAIL while local library code still reads `source.json`.

- [ ] **Step 3: Read metadata in local library**

In `src/agent/paper/storage/local-paper-library.ts`, replace:

```ts
entry.sourcePath = entry.sourcePath ?? relativeToWorkspace(workspaceDir, path.join(paths.sourceArtifactsRoot, sourceDir.name, "source.json"));
...
const sourcePath = path.join(paperDir, "source.json");
const source = await readJsonFile<PaperReaderSource & Partial<PaperSourceMetadata>>(sourcePath);
```

with:

```ts
entry.sourcePath = entry.sourcePath ?? relativeToWorkspace(workspaceDir, path.join(paths.sourceArtifactsRoot, sourceDir.name, "metadata.json"));
...
const metadataPath = path.join(paperDir, "metadata.json");
const metadata = await readJsonFile<KnowledgeSourceMetadata>(metadataPath);
```

Import:

```ts
import type { KnowledgeSourceMetadata } from "../../wiki/source-metadata-store.js";
```

Update `paperKeyFromSourceDirectory(...)` and `applySource(...)` call sites to use metadata:

```ts
const paperKey = paperKeyFromSourceDirectory(sourceDir.name, metadata);
entry.sourcePath = entry.sourcePath ?? relativeToWorkspace(workspaceDir, metadataPath);
if (metadata) {
  applySourceMetadata(entry, metadata, metadataPath, workspaceDir);
}
```

Add:

```ts
function applySourceMetadata(
  entry: LocalPaperEntry,
  metadata: KnowledgeSourceMetadata,
  metadataPath: string,
  workspaceDir: string
): void {
  entry.sourcePath = relativeToWorkspace(workspaceDir, metadataPath);
  entry.title = entry.title ?? metadata.title;
  entry.authors = entry.authors.length > 0 ? entry.authors : metadata.citation?.authors ?? [];
  entry.year = entry.year ?? metadata.citation?.year;
  entry.venue = entry.venue ?? metadata.citation?.venue;
  entry.publisher = entry.publisher ?? metadata.citation?.publisher;
  entry.doi = entry.doi ?? metadata.citation?.doi;
  entry.arxivId = entry.arxivId ?? metadata.citation?.arxivId;
  entry.articleUrl = entry.articleUrl ?? metadata.provenance.url;
  entry.pdfPath = entry.pdfPath ?? metadata.provenance.rawPath;
  entry.pdfSha256 = entry.pdfSha256 ?? metadata.provenance.rawSha256;
  entry.citationStatus = metadata.citation?.citationStatus ?? entry.citationStatus;
  entry.missingFields = metadata.citation?.missingFields ?? entry.missingFields;
}
```

- [ ] **Step 4: Update source summary and relation readers**

In `src/agent/wiki/summary.ts` and `src/agent/wiki/relations.ts`, replace `source.json` reads with `metadata.json` reads and map fields through `KnowledgeSourceMetadata.citation` and `.provenance`.

Use this conversion pattern:

```ts
const metadata = await readJsonFile<KnowledgeSourceMetadata>(path.join(sourceRoot, "metadata.json"));
const title = metadata?.title;
const doi = metadata?.citation?.doi;
const articleUrl = metadata?.provenance.url;
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/local-paper-library.test.js dist/test/agent/paper-summary.test.js dist/test/agent/paper-relations.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/paper/storage/local-paper-library.ts src/agent/wiki/summary.ts src/agent/wiki/relations.ts test/agent/local-paper-library.test.ts test/agent/paper-summary.test.ts test/agent/paper-relations.test.ts
git commit -m "Read local paper metadata from metadata json"
```

## Task 5: Migrate Wiki Source Writing And Retrieval

**Files:**
- Modify: `src/agent/wiki/content.ts`
- Modify: `src/agent/wiki/retrieval-contract.ts`
- Modify: `src/agent/wiki/bootstrap.ts`
- Remove: `src/agent/wiki/manifest-store.ts`
- Test: `test/agent/wiki-retrieval-contract.test.ts`
- Test: `test/agent/paper-reader.test.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Update retrieval tests to write metadata beside summary**

In `test/agent/wiki-retrieval-contract.test.ts`, replace fixture writes to `knowledge-base/manifests/${paperKey}.json` with:

```ts
await writeWorkspaceFile(
  workspaceDir,
  `knowledge-base/sources/${paperKey}/metadata.json`,
  `${JSON.stringify({
    schemaVersion: 1,
    sourceKind: "paper",
    sourceKey: paperKey,
    title: "Legacy source summary",
    status: "ready",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    summaryPath: `knowledge-base/sources/${paperKey}/summary.md`,
    citation: {
      authors: ["A. Author"],
      citationStatus: "complete",
      missingFields: []
    },
    provenance: {
      url: "https://arxiv.org/abs/2601.00003"
    },
    artifacts: [],
    tags: ["frequency-allocation"],
    relatedSourceKeys: [],
    synthesisPageKeys: []
  }, null, 2)}\n`
);
```

Update assertions:

```ts
assert.equal(result.item?.manifest?.schemaVersion, 1);
assert.equal(result.item?.manifest?.sourceKind, "paper");
```

Rename the evidence item property from `manifest` to `metadata` in `WikiEvidenceItem` and update assertions:

```ts
assert.equal(result.item?.metadata?.schemaVersion, 1);
```

- [ ] **Step 2: Update source write tests**

In `test/agent/paper-reader.test.ts` and `test/agent/tools.test.ts`, replace expected manifest path:

```ts
assert.equal(source.manifestPath, "knowledge-base/manifests/arxiv-2601.00003.json");
```

with:

```ts
assert.equal(source.metadataPath, "knowledge-base/sources/arxiv-2601.00003/metadata.json");
```

Also assert no manifest file is created:

```ts
await assert.rejects(readFile(path.join(workspace, "knowledge-base", "manifests", "arxiv-2601.00003.json"), "utf8"));
```

- [ ] **Step 3: Run failing wiki tests**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/wiki-retrieval-contract.test.js dist/test/agent/paper-reader.test.js dist/test/agent/tools.test.js
```

Expected: FAIL while content and retrieval still use top-level manifests.

- [ ] **Step 4: Write metadata in `writePaperWikiSource(...)`**

In `src/agent/wiki/content.ts`, replace imports from `manifest-store.js` with:

```ts
import {
  readKnowledgeSourceMetadata,
  writeKnowledgeSourceMetadata,
  type KnowledgeSourceMetadata
} from "./source-metadata-store.js";
```

Remove `getPaperWikiManifestsDir` and `getPaperWikiSourceManifestPath` imports.

In `writePaperWikiSource(...)`, replace `manifestPath` with:

```ts
const metadataPath = getKnowledgeSourceMetadataPath(input.workspaceDir, input.paperKey);
const metadataPathRelative = relativeToWorkspace(input.workspaceDir, metadataPath);
```

Use `metadataPathRelative` in `plannedFiles`, `writtenFiles`, and result output.

Build metadata:

```ts
const existingMetadata = await readKnowledgeSourceMetadata({
  workspaceDir: input.workspaceDir,
  sourceKey: input.paperKey
});
const metadata: KnowledgeSourceMetadata = {
  ...(existingMetadata.metadata ?? {
    schemaVersion: 1,
    sourceKind: "paper",
    sourceKey: input.paperKey,
    title,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    provenance: {},
    artifacts: [],
    tags: [],
    relatedSourceKeys: [],
    synthesisPageKeys: []
  }),
  title,
  status: "ready",
  updatedAt: now,
  summaryPath: sourcePathRelative,
  provenance: {
    ...(existingMetadata.metadata?.provenance ?? {}),
    ...(source?.recordPath ? { acquisitionPath: relativeToWorkspace(input.workspaceDir, source.recordPath) } : {}),
    ...(source?.articleUrl ? { url: source.articleUrl } : {}),
    ...(source?.pdfPath ? { rawPath: relativeToWorkspace(input.workspaceDir, source.pdfPath) } : {}),
    ...(document.pdfSha256 ? { rawSha256: document.pdfSha256 } : {})
  },
  artifacts: [
    ...((existingMetadata.metadata?.artifacts ?? []).filter((artifact) => artifact.kind !== "parse")),
    {
      kind: "parse",
      path: relativeToWorkspace(input.workspaceDir, artifacts.markdownPath),
      engine,
      markdownPath: relativeToWorkspace(input.workspaceDir, artifacts.markdownPath),
      jsonPath: relativeToWorkspace(input.workspaceDir, artifacts.parsePath),
      qualityPath: relativeToWorkspace(input.workspaceDir, artifacts.qualityPath)
    }
  ],
  tags: cleanStringValues(input.tags),
  relatedSourceKeys: cleanStringValues(input.relatedPaperKeys),
  synthesisPageKeys: existingMetadata.metadata?.synthesisPageKeys ?? []
};
```

Then write:

```ts
await writeKnowledgeSourceMetadata({
  workspaceDir: input.workspaceDir,
  metadata
});
```

- [ ] **Step 5: Read metadata in retrieval contract**

In `src/agent/wiki/retrieval-contract.ts`, replace source manifest imports with:

```ts
import {
  readKnowledgeSourceMetadata,
  type KnowledgeSourceMetadata,
  type WikiSourceKind
} from "./source-metadata-store.js";
```

Change `WikiEvidenceItem` from:

```ts
manifest?: WikiSourceManifestV2;
```

to:

```ts
metadata?: KnowledgeSourceMetadata;
```

Replace `readSourceManifestForEvidence(...)` with:

```ts
async function readSourceMetadataForEvidence(input: {
  workspaceDir: string;
  expectedSourceKey: string;
  expectedSummaryPath: string;
}): Promise<{
  metadata?: KnowledgeSourceMetadata;
  missing: boolean;
  malformed: boolean;
  diagnostics: string[];
}> {
  const result = await readKnowledgeSourceMetadata({
    workspaceDir: input.workspaceDir,
    sourceKey: input.expectedSourceKey,
    summaryPath: input.expectedSummaryPath
  });
  return {
    metadata: result.metadata,
    missing: result.status === "missing",
    malformed: result.status === "malformed",
    diagnostics: result.diagnostics
  };
}
```

When building the source evidence item, map:

```ts
sourceKind: metadataRead.metadata?.sourceKind,
sourceKey: metadataRead.metadata?.sourceKey ?? options.key,
metadata: metadataRead.metadata,
tags: metadataRead.metadata?.tags ?? [],
sourceRefs: [metadataRead.metadata?.sourceKey ?? options.key],
updatedAt: metadataRead.metadata?.updatedAt
```

- [ ] **Step 6: Update bootstrap metadata reads**

In `src/agent/wiki/bootstrap.ts`, replace:

```ts
const manifest = await readNormalizedWikiSourceManifest({
  workspaceDir,
  sourceKey: paperKey
});
```

with:

```ts
const metadata = await readKnowledgeSourceMetadata({
  workspaceDir,
  sourceKey: paperKey
});
```

Use `metadata.metadata?.sourceKind`, `metadata.metadata?.tags`, and `metadata.metadata?.relatedSourceKeys`.

- [ ] **Step 7: Delete manifest store**

After all imports have moved, delete `src/agent/wiki/manifest-store.ts`.

Run:

```bash
rg -n "manifest-store|WikiSourceManifest|readNormalizedWikiSourceManifest|writeWikiSourceManifest|getWikiSourceManifestPath|getPaperWikiSourceManifestPath|getPaperWikiManifestsDir" src test
```

Expected: no matches except plan/spec docs.

- [ ] **Step 8: Run targeted wiki tests**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/wiki-retrieval-contract.test.js dist/test/agent/paper-reader.test.js dist/test/agent/tools.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/agent/wiki/content.ts src/agent/wiki/retrieval-contract.ts src/agent/wiki/bootstrap.ts src/agent/wiki/manifest-store.ts test/agent/wiki-retrieval-contract.test.ts test/agent/paper-reader.test.ts test/agent/tools.test.ts
git commit -m "Use metadata json for wiki source evidence"
```

## Task 6: Migrate Health And Maintenance

**Files:**
- Modify: `src/agent/wiki/health.ts`
- Modify: `src/agent/wiki/maintenance.ts`
- Test: `test/agent/wiki-health.test.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Update health tests for missing metadata**

In `test/agent/wiki-health.test.ts`, replace the source-manifest missing test with:

```ts
test("checkWikiHealth reports source summaries without metadata", async () => {
  await withWorkspace("wiki-health-missing-metadata-", async (workspace) => {
    const paperKey = "arxiv-2401.00999";
    await writeText(
      path.join(workspace, "knowledge-base", "sources", paperKey, "summary.md"),
      "# Summary\n\nA complete summary without metadata."
    );

    const result = await checkWikiHealth({ workspaceDir: workspace });
    const issue = result.issues.find((candidate) => candidate.kind === "source_metadata_missing");

    assert.equal(issue?.paperKey, paperKey);
    assert.deepEqual(issue?.paths, [`knowledge-base/sources/${paperKey}/metadata.json`]);
  });
});
```

Update malformed manifest tests to malformed metadata tests:

```ts
await writeText(
  path.join(workspace, "knowledge-base", "sources", "malformed", "metadata.json"),
  "{not json"
);
```

Assert:

```ts
assert.equal(issue?.kind, "source_metadata_malformed");
```

- [ ] **Step 2: Run failing health tests**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/wiki-health.test.js
```

Expected: FAIL while health still reports source manifest issues.

- [ ] **Step 3: Replace health issue kinds and paths**

In `src/agent/wiki/health.ts`, rename issue kinds:

```ts
"source_manifest_missing" -> "source_metadata_missing"
"source_manifest_artifact_missing" -> "source_metadata_artifact_missing"
"source_manifest_malformed" -> "source_metadata_malformed"
```

Replace path construction:

```ts
getPaperWikiSourceManifestPath(workspaceDir, entry.paperKey)
```

with:

```ts
getKnowledgeSourceMetadataPath(workspaceDir, entry.paperKey)
```

Replace messages:

```ts
"Wiki source summary has no durable source manifest."
```

with:

```ts
"Wiki source summary has no source metadata."
```

- [ ] **Step 4: Replace artifact validation over top-level manifests**

Replace the directory scan in `sourceManifestArtifactIssues(...)` with a source-directory scan:

```ts
async function sourceMetadataArtifactIssues(workspaceDir: string): Promise<WikiHealthIssue[]> {
  const sourcesDir = getPaperWikiSourcesDir(workspaceDir);
  let entries: Dirent[];
  try {
    entries = await readdir(sourcesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const issues: WikiHealthIssue[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const sourceKey = entry.name;
    const metadataPath = getKnowledgeSourceMetadataPath(workspaceDir, sourceKey);
    const result = await readKnowledgeSourceMetadata({ workspaceDir, sourceKey });
    if (result.status === "missing") {
      continue;
    }
    if (result.status === "malformed" || !result.metadata) {
      issues.push({
        kind: "source_metadata_malformed",
        severity: "high",
        paperKey: sourceKey,
        message: "Source metadata is malformed.",
        paths: [relativeToWorkspace(workspaceDir, metadataPath)],
        metadata: { diagnostics: result.diagnostics }
      });
      continue;
    }
    const candidatePaths = [
      ...(result.metadata.summaryPath ? [{ name: "summaryPath", value: result.metadata.summaryPath }] : []),
      ...(result.metadata.provenance.acquisitionPath ? [{ name: "provenance.acquisitionPath", value: result.metadata.provenance.acquisitionPath }] : []),
      ...(result.metadata.provenance.rawPath ? [{ name: "provenance.rawPath", value: result.metadata.provenance.rawPath }] : []),
      ...result.metadata.artifacts.flatMap((artifact) => [
        { name: "artifacts.path", value: artifact.path },
        ...(artifact.markdownPath ? [{ name: "artifacts.markdownPath", value: artifact.markdownPath }] : []),
        ...(artifact.jsonPath ? [{ name: "artifacts.jsonPath", value: artifact.jsonPath }] : []),
        ...(artifact.qualityPath ? [{ name: "artifacts.qualityPath", value: artifact.qualityPath }] : [])
      ])
    ];
    const missingPaths = [];
    for (const candidatePath of candidatePaths) {
      const validation = validateWorkspaceRelativeManifestPath(workspaceDir, candidatePath.value);
      if (!validation.ok) {
        missingPaths.push(`${candidatePath.name}: ${validation.relativePath ?? String(candidatePath.value)}`);
        continue;
      }
      if (!(await pathExists(validation.absolutePath))) {
        missingPaths.push(`${candidatePath.name}: ${validation.relativePath}`);
      }
    }
    if (missingPaths.length > 0) {
      issues.push({
        kind: "source_metadata_artifact_missing",
        severity: "high",
        paperKey: sourceKey,
        message: "One or more source metadata artifact paths are missing on disk.",
        paths: missingPaths
      });
    }
  }
  return issues;
}
```

- [ ] **Step 5: Replace metadata backfill repair**

Replace `fixBySourceManifestBackfill(...)` with `fixBySourceMetadataBackfill(...)`:

```ts
async function fixBySourceMetadataBackfill(input: {
  workspaceDir: string;
  issue: WikiHealthIssue;
  dryRun: boolean;
}): Promise<WikiHealthFixItem> {
  if (input.dryRun) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "source_metadata_backfill",
      message: `Dry run: would backfill source metadata for ${input.issue.paperKey}.`
    };
  }
  try {
    const metadataPath = await backfillKnowledgeSourceMetadataFromSummary({
      workspaceDir: input.workspaceDir,
      sourceKey: input.issue.paperKey
    });
    return {
      issue: input.issue,
      status: "fixed",
      action: "source_metadata_backfill",
      message: `Backfilled source metadata for ${input.issue.paperKey}.`,
      details: { metadataPath }
    };
  } catch (error) {
    return {
      issue: input.issue,
      status: "failed",
      action: "source_metadata_backfill",
      message: error instanceof Error ? error.message : "Source metadata backfill failed."
    };
  }
}
```

Implement `backfillKnowledgeSourceMetadataFromSummary(...)` in `source-metadata-store.ts` for source summaries created before metadata in the same new layout. It must write `metadata.json`, not a top-level manifest.

- [ ] **Step 6: Update maintenance scans**

In `src/agent/wiki/maintenance.ts`, replace top-level manifest scans with source-directory metadata scans. The scan root should be:

```ts
const sourcesDir = getPaperWikiSourcesDir(workspaceDir);
```

Each source metadata path should be:

```ts
const metadataPath = getKnowledgeSourceMetadataPath(workspaceDir, sourceKey);
```

- [ ] **Step 7: Run targeted health tests**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/wiki-health.test.js dist/test/agent/tools.test.js
```

Expected: PASS for health/tool tests.

- [ ] **Step 8: Commit**

```bash
git add src/agent/wiki/health.ts src/agent/wiki/maintenance.ts src/agent/wiki/source-metadata-store.ts test/agent/wiki-health.test.ts test/agent/tools.test.ts
git commit -m "Check wiki health through source metadata"
```

## Task 7: Remove Remaining Old Layout References And Update Docs

**Files:**
- Modify: `docs/code-architecture.md`
- Modify: tests found by search
- Modify: source files found by search
- Test: full repository test suite

- [ ] **Step 1: Search for old runtime references**

Run:

```bash
rg -n "source\\.json|knowledge-base/manifests|manifestsRoot|getPaperWikiManifestsDir|getPaperWikiSourceManifestPath|manifest-store|WikiSourceManifest|readNormalizedWikiSourceManifest|writeWikiSourceManifest|writePaperSourceMetadataForSource|resolvePaperSourcePath" src test docs README.md
```

Expected: matches remain only in historical design/plan docs where old layout is described, not in runtime code or active tests.

- [ ] **Step 2: Remove or rename remaining runtime references**

For runtime matches, use these replacements:

```text
source.json -> metadata.json
knowledge-base/manifests/<key>.json -> knowledge-base/sources/<key>/metadata.json
source_manifest_missing -> source_metadata_missing
source manifest -> source metadata
manifestPath result field -> metadataPath result field
```

For import matches:

```ts
import type { WikiSourceKind } from "./source-metadata-store.js";
```

For result fields in tests:

```ts
assert.equal(result.metadataPath, `knowledge-base/sources/${paperKey}/metadata.json`);
```

- [ ] **Step 3: Update architecture docs**

In `docs/code-architecture.md`, replace the wiki construction bullet that says V2 manifests live in top-level `knowledge-base/manifests/` with:

```md
4. `wiki/source-metadata-store.ts` writes and validates per-source `metadata.json` files under `knowledge-base/sources/<sourceKey>/`. Metadata uses `sourceKind` and `sourceKey` for papers plus non-paper evidence such as material databases, software docs, standards, vendor notes, lab notes, code output, webpages, and manual sources. Reads must verify that the source directory key matches `metadata.json.sourceKey`. Design artifact source records belong under `design-repo/`, not as a wiki source kind.
```

Update any module table row for `manifest-store.ts` to `source-metadata-store.ts`.

- [ ] **Step 4: Run old-reference search again**

Run:

```bash
rg -n "source\\.json|knowledge-base/manifests|manifestsRoot|getPaperWikiManifestsDir|getPaperWikiSourceManifestPath|manifest-store|WikiSourceManifest|readNormalizedWikiSourceManifest|writeWikiSourceManifest|writePaperSourceMetadataForSource|resolvePaperSourcePath" src test docs README.md
```

Expected: no matches in `src/` or active tests. Matches in historical docs under `docs/superpowers/specs/` or `docs/superpowers/plans/` are acceptable when they describe old decisions.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm test
```

Expected: build succeeds and all Node tests pass.

- [ ] **Step 6: Commit**

```bash
git add src test docs/code-architecture.md README.md
git commit -m "Finish metadata json source layout"
```

## Final Verification

- [ ] **Step 1: Confirm no old runtime paths remain**

Run:

```bash
rg -n "source\\.json|knowledge-base/manifests|manifestsRoot|getPaperWikiManifestsDir|getPaperWikiSourceManifestPath|manifest-store|WikiSourceManifest|readNormalizedWikiSourceManifest|writeWikiSourceManifest|writePaperSourceMetadataForSource|resolvePaperSourcePath" src test
```

Expected: no matches.

- [ ] **Step 2: Confirm full suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git status --short
git log --oneline -7
```

Expected: working tree is clean after commits; latest commits correspond to the tasks above.
