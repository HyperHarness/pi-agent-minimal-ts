# Wiki Knowledge Core Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first durable wiki knowledge-core layer: source manifests, operation journal records, and health visibility for missing manifests.

**Architecture:** Keep the existing `knowledge-base/` layout and public tool names. Add focused stores under `src/agent/wiki/` and make `writePaperWikiSource()` write `summary.md`, `manifests/<paperKey>.json`, and `index.md` under one journaled operation.

**Tech Stack:** TypeScript, Node `fs/promises`, built-in `node:test`, existing wiki and paper reader stores.

---

### Task 1: Source Manifest Store

**Files:**
- Create: `src/agent/wiki/manifest-store.ts`
- Modify: `src/agent/wiki/store.ts`
- Modify: `src/agent/wiki/types.ts`
- Test: `test/agent/paper-reader.test.ts`

- [ ] **Step 1: Write the failing test**

Add assertions to `writePaperWikiSource saves an LLM source summary and searchPaperWiki finds it`:

```ts
assert.equal(source.manifestPath, "knowledge-base/manifests/arxiv-2601.00003.json");
const manifest = JSON.parse(await readFile(path.join(workspace, source.manifestPath), "utf8"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.kind, "paper-source");
assert.equal(manifest.paperKey, "arxiv-2601.00003");
assert.equal(manifest.status, "ready");
assert.equal(manifest.sourceSummaryPath, "knowledge-base/sources/arxiv-2601.00003/summary.md");
assert.equal(manifest.parse.engine, "plain-text-baseline");
assert.equal(manifest.parse.markdownPath, "knowledge-base/sources/arxiv-2601.00003/parses/plain-text-baseline/document.md");
assert.equal(manifest.provenance.pdfSha256, parsed.pdfSha256);
assert.deepEqual(manifest.tags, ["quantum-simulation"]);
assert.deepEqual(manifest.relatedPaperKeys, []);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "writePaperWikiSource saves an LLM source summary"`

Expected: FAIL because `manifestPath` is missing or the manifest file does not exist.

- [ ] **Step 3: Implement minimal manifest store**

Create `src/agent/wiki/manifest-store.ts` with:

```ts
export type WikiSourceManifestStatus =
  | "ready"
  | "stale"
  | "blocked"
  | "low_quality"
  | "citation_incomplete"
  | "missing_artifact";

export interface WikiSourceManifest {
  schemaVersion: 1;
  kind: "paper-source";
  paperKey: string;
  title: string;
  status: WikiSourceManifestStatus;
  createdAt: string;
  updatedAt: string;
  sourceSummaryPath: string;
  provenance: {
    recordPath?: string;
    articleUrl?: string;
    rawPdfPath?: string;
    pdfSha256?: string;
  };
  parse: {
    engine: string;
    markdownPath: string;
    jsonPath: string;
    qualityPath: string;
  };
  tags: string[];
  relatedPaperKeys: string[];
  synthesisPageKeys: string[];
}
```

Add `getPaperWikiSourceManifestPath(workspaceDir, paperKey)`, `writeWikiSourceManifest()`, and `readWikiSourceManifest()` using stable pretty JSON.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "writePaperWikiSource saves an LLM source summary"`

Expected: PASS.

### Task 2: Operation Journal

**Files:**
- Create: `src/agent/wiki/journal.ts`
- Modify: `src/agent/wiki/store.ts`
- Modify: `src/agent/wiki/content.ts`
- Test: `test/agent/paper-reader.test.ts`

- [ ] **Step 1: Write the failing test**

In the same source-write test, assert a JSONL journal event exists:

```ts
assert.equal(source.operationJournalPath, "knowledge-base/state/wiki-operations.jsonl");
const journalLines = (await readFile(path.join(workspace, source.operationJournalPath), "utf8")).trim().split("\n");
const journalEvents = journalLines.map((line) => JSON.parse(line));
assert.equal(journalEvents[0].phase, "begin");
assert.equal(journalEvents[0].intent, "write_source_summary");
assert.equal(journalEvents[0].owner, "wiki-agent");
assert.ok(journalEvents[0].plannedFiles.includes("knowledge-base/manifests/arxiv-2601.00003.json"));
assert.equal(journalEvents.at(-1).phase, "complete");
assert.equal(journalEvents.at(-1).operationId, journalEvents[0].operationId);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "writePaperWikiSource saves an LLM source summary"`

Expected: FAIL because the journal path or events do not exist.

- [ ] **Step 3: Implement minimal journal**

Create `beginWikiOperation()` and `completeWikiOperation()` in `src/agent/wiki/journal.ts`. Append JSONL to `knowledge-base/state/wiki-operations.jsonl`. Include `operationId`, `phase`, `intent`, `owner`, timestamps, inputs, planned files, and written files.

- [ ] **Step 4: Wrap source summary write**

In `writePaperWikiSource()`, begin before writing `summary.md`, `manifest`, and `index.md`; complete after all three writes. Return `operationId` and `operationJournalPath`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "writePaperWikiSource saves an LLM source summary"`

Expected: PASS.

### Task 3: Health Visibility For Missing Manifests

**Files:**
- Modify: `src/agent/wiki/health.ts`
- Test: `test/agent/wiki-health.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that creates a downloaded, parsed paper with `summary.md` but no manifest:

```ts
test("checkWikiHealth reports source summaries without manifests", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2401.00999.pdf");
    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeJson(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00999", "acquisition.json"), {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.00999",
      recordedAt: "2026-05-10T00:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.00999",
      pdfUrl: "https://arxiv.org/pdf/2401.00999.pdf",
      downloadPath: pdfPath
    });
    await writeJson(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00999", "source.json"), {
      paperKey: "arxiv-2401.00999",
      source: "arxiv",
      canonicalId: "2401.00999",
      articleUrl: "https://arxiv.org/abs/2401.00999",
      pdfPath
    });
    const parsedDir = path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00999", "parses", "plain-text-baseline");
    await writeText(path.join(parsedDir, "document.md"), "A complete parse about wiki manifests.");
    await writeJson(path.join(parsedDir, "parse.json"), { paperKey: "arxiv-2401.00999", engine: "plain-text-baseline" });
    await writeJson(path.join(parsedDir, "quality.json"), {
      status: "good",
      score: 0.9,
      pages: 1,
      totalTextLength: 2000,
      emptyPageCount: 0,
      headingCount: 1,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: []
    });
    await writeText(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00999", "summary.md"), "---\ntype: \"paper-source-summary\"\npaper_key: \"arxiv-2401.00999\"\ntitle: \"Manifest gap\"\n---\n\n# Manifest gap\n");

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.source_manifest_missing, 1);
    assert.ok(result.issues.some((issue) => issue.kind === "source_manifest_missing" && issue.paperKey === "arxiv-2401.00999"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "source summaries without manifests"`

Expected: FAIL because `source_manifest_missing` is not a health issue kind.

- [ ] **Step 3: Implement health issue**

Add `source_manifest_missing` to `WikiHealthIssueKind`, `ISSUE_KINDS`, action summary, and the scan loop. Only report it when a local paper has a wiki summary and the corresponding manifest JSON is absent.

- [ ] **Step 4: Run focused test**

Run: `npm test -- --test-name-pattern "source summaries without manifests"`

Expected: PASS.

### Task 4: Export And Verification

**Files:**
- Modify: `src/agent/wiki/index.ts`
- Modify: `src/index.ts` if public API tests require it
- Test: `test/agent/wiki-domain-boundary.test.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: Export new stores from wiki facade**

Add:

```ts
export * from "./manifest-store.js";
export * from "./journal.js";
```

- [ ] **Step 2: Run focused wiki tests**

Run: `npm test -- --test-name-pattern "writePaperWikiSource|source summaries without manifests|wiki domain facade"`

Expected: PASS.

- [ ] **Step 3: Run full validation**

Run: `npm test`

Expected: PASS.

### Self-Review

- Spec coverage: This plan covers workspace lifecycle hooks already present, required source manifests, operation WAL for source summary writes, and health visibility for missing manifests. Typed page schema and downstream retrieval contracts remain explicit later phases.
- Placeholder scan: No TODO/TBD placeholders remain in steps.
- Type consistency: `manifestPath`, `operationId`, and `operationJournalPath` are added to `PaperWikiSourceResult`; `source_manifest_missing` is added to wiki health issue types and summaries.
