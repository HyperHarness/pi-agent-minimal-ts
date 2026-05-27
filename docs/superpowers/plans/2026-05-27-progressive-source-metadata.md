# Progressive Source Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make paper `metadata.json` use progressive disclosure: source lookup and LLM-readable parse artifacts stay in metadata, while download/runtime details stay in `acquisition.json`.

**Architecture:** Tighten the paper metadata writer so it emits only minimal provenance and parse artifacts. Keep acquisition as the authority for raw PDFs, PDF URLs, browser/download status, reading queue status, supplemental files, and fallback details. Update wiki summary metadata and local paper listing code so omitted runtime fields are normal.

**Tech Stack:** TypeScript, Node `node:test`, existing paper storage and wiki metadata modules.

---

### Task 1: Update Paper Metadata Writer Tests

**Files:**
- Modify: `test/agent/paper-store.test.ts`

- [ ] **Step 1: Change supplemental-material metadata expectation**

In `test/agent/paper-store.test.ts`, replace this assertion inside `writePaperRecord persists publisher supplemental materials into source metadata`:

```ts
assert.equal(metadata.artifacts.some((artifact) => artifact.note === "Supplemental Material"), true);
```

with:

```ts
assert.deepEqual(metadata.artifacts, []);
assert.equal(metadata.provenance.acquisitionPath, "knowledge-base/sources/aps-10.1103-PhysRevLett.111.080502/acquisition.json");
assert.equal("pdfUrl" in metadata.provenance, false);
assert.equal("downloadPath" in metadata.provenance, false);
```

- [ ] **Step 2: Change manual-fallback provenance expectation**

In `paper source metadata writes durable metadata.json without legacy source.json`, change the local metadata type from:

```ts
provenance: KnowledgeSourceMetadata["provenance"] & { acquisitionPath?: string; downloadStatus?: string };
```

to:

```ts
provenance: KnowledgeSourceMetadata["provenance"] & { acquisitionPath?: string };
```

Then replace:

```ts
assert.equal(metadata.provenance.downloadStatus, "manual_fallback_opened");
```

with:

```ts
assert.equal("downloadStatus" in metadata.provenance, false);
assert.equal("recordPath" in metadata.provenance, false);
assert.equal("source" in metadata.provenance, false);
assert.equal("canonicalId" in metadata.provenance, false);
```

- [ ] **Step 3: Change queued-reading metadata expectation**

In `paper source metadata derives arXiv ids and preserves manually enriched fields on record updates`, replace:

```ts
assert.equal(updated.provenance.readingStatus, "queued");
assert.equal(updated.citation.citationStatus, "complete");
assert.equal(updated.status, "ready");
```

with:

```ts
assert.equal("readingStatus" in updated.provenance, false);
assert.equal("downloadStatus" in updated.provenance, false);
assert.equal("pdfUrl" in updated.provenance, false);
assert.equal("downloadPath" in updated.provenance, false);
assert.deepEqual(updated.artifacts, []);
assert.equal(updated.citation.citationStatus, "complete");
assert.equal(updated.status, "missing_artifact");
```

- [ ] **Step 4: Change repair test to keep only parse artifacts**

In `paper metadata repair refreshes legacy raw paths and supplemental artifacts`, replace the final assertions:

```ts
assert.equal(repaired.provenance.recordPath, `knowledge-base/sources/${paperKey}/acquisition.json`);
assert.equal(repaired.provenance.acquisitionPath, `knowledge-base/sources/${paperKey}/acquisition.json`);
assert.equal(repaired.provenance.rawPath, `knowledge-base/raw/pdfs/${paperKey}.pdf`);
assert.equal(repaired.provenance.downloadPath, `knowledge-base/raw/pdfs/${paperKey}.pdf`);
assert.equal(repaired.artifacts.length, 2);
assert.equal(repaired.artifacts[0]?.path, `knowledge-base/raw/pdfs/${paperKey}-supplemental-Barends2013supp.pdf`);
assert.equal(repaired.artifacts[1]?.path, `knowledge-base/raw/pdfs/${paperKey}.pdf`);
```

with:

```ts
assert.equal(repaired.provenance.acquisitionPath, `knowledge-base/sources/${paperKey}/acquisition.json`);
assert.equal("recordPath" in repaired.provenance, false);
assert.equal("rawPath" in repaired.provenance, false);
assert.equal("downloadPath" in repaired.provenance, false);
assert.equal(repaired.artifacts.length, 1);
assert.equal(repaired.artifacts[0]?.kind, "parse");
assert.equal(repaired.artifacts[0]?.engine, "webpage");
assert.equal(repaired.artifacts[0]?.path, `knowledge-base/sources/${paperKey}/parses/webpage`);
assert.equal(repaired.artifacts[0]?.markdownPath, `knowledge-base/sources/${paperKey}/parses/webpage/document.md`);
assert.equal(repaired.artifacts[0]?.jsonPath, `knowledge-base/sources/${paperKey}/parses/webpage/parse.json`);
assert.equal(repaired.artifacts[0]?.qualityPath, `knowledge-base/sources/${paperKey}/parses/webpage/quality.json`);
```

- [ ] **Step 5: Run the focused test and verify it fails**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/paper-store.test.js --test-name-pattern "source metadata|supplemental"
```

Expected: FAIL before implementation. Failures should mention old raw artifacts or provenance fields still being present.

---

### Task 2: Emit Minimal Paper Metadata and Parse Artifacts

**Files:**
- Modify: `src/agent/paper/storage/paper-store.ts`
- Test: `test/agent/paper-store.test.ts`

- [ ] **Step 1: Replace `PaperMetadataProvenance` with minimal paper additions**

In `src/agent/paper/storage/paper-store.ts`, replace:

```ts
type PaperMetadataProvenance = KnowledgeSourceMetadata["provenance"] & {
  source?: PaperSource;
  canonicalId?: string;
  acquisitionPath?: string;
  pdfUrl?: string;
  downloadPath?: string;
  downloadStatus?: PaperRecord["status"];
  readingStatus?: PaperRecordReadingManifest["status"];
  recordedAt?: string;
  preprintFallback?: unknown;
};
```

with:

```ts
type PaperMetadataProvenance = KnowledgeSourceMetadata["provenance"] & {
  acquisitionPath?: string;
};
```

- [ ] **Step 2: Add a helper for ready parse artifacts**

Immediately above `buildPaperMetadataArtifacts`, add:

```ts
function metadataArtifactFromRecordManifest(input: {
  workspaceDir: string;
  manifest: PaperRecordArtifactManifest | undefined;
}): KnowledgeSourceArtifact | undefined {
  const manifest = input.manifest;
  if (
    !manifest ||
    manifest.status !== "ready" ||
    !manifest.markdownPath ||
    !manifest.parsePath ||
    !manifest.qualityPath ||
    !manifest.engine
  ) {
    return undefined;
  }
  const markdownPath = toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: manifest.markdownPath });
  return {
    kind: "parse",
    path: path.dirname(markdownPath),
    engine: manifest.engine,
    markdownPath,
    jsonPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: manifest.parsePath }),
    qualityPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: manifest.qualityPath })
  };
}
```

- [ ] **Step 3: Replace `buildPaperMetadataArtifacts`**

Replace the full `buildPaperMetadataArtifacts` function with:

```ts
function buildPaperMetadataArtifacts(input: {
  workspaceDir: string;
  record: PaperRecord;
  existing?: ExistingPaperMetadata;
}): KnowledgeSourceArtifact[] {
  let artifacts = Array.isArray(input.existing?.artifacts)
    ? input.existing.artifacts
        .filter((artifact) => artifact.kind === "parse")
        .reduce<KnowledgeSourceArtifact[]>(
          (normalizedArtifacts, artifact) => appendArtifact(normalizedArtifacts, normalizeKnowledgeSourceArtifact({
            workspaceDir: input.workspaceDir,
            artifact
          })),
          []
        )
    : [];
  for (const artifact of [
    metadataArtifactFromRecordManifest({ workspaceDir: input.workspaceDir, manifest: input.record.webpage }),
    metadataArtifactFromRecordManifest({ workspaceDir: input.workspaceDir, manifest: input.record.parse })
  ]) {
    if (artifact) {
      artifacts = appendArtifact(artifacts, artifact);
    }
  }
  return artifacts;
}
```

- [ ] **Step 4: Update status derivation and provenance emission**

Inside `writePaperMetadataForRecord`, delete the unused `pdfUrl`, `downloadPath`, and `rawPath` local constants:

```ts
const pdfUrl = getRecordPdfUrl(input.record);
const downloadPath = getRecordDownloadPath(input.record);
const rawPath = downloadPath
  ? toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: downloadPath })
  : existingProvenance?.rawPath;
```

Then add this before constructing `metadata`:

```ts
const artifacts = buildPaperMetadataArtifacts({
  workspaceDir: input.workspaceDir,
  record: input.record,
  existing
});
const metadataStatus: KnowledgeSourceMetadata["status"] =
  missingFields.length > 0
    ? "citation_incomplete"
    : artifacts.length > 0
      ? "ready"
      : "missing_artifact";
```

Change:

```ts
status: missingFields.length === 0 ? "ready" : "citation_incomplete",
```

to:

```ts
status: metadataStatus,
```

Replace the `provenance` object with:

```ts
provenance: {
  url: input.record.articleUrl,
  ...(doi ? { doi } : {}),
  ...(arxivId ? { arxivId } : {}),
  acquisitionPath
},
```

Replace:

```ts
artifacts: buildPaperMetadataArtifacts({
  workspaceDir: input.workspaceDir,
  record: input.record,
  existing,
  rawPath
}),
```

with:

```ts
artifacts,
```

- [ ] **Step 5: Remove now-unused helpers if TypeScript reports them**

If `tsc` reports `getRecordPdfUrl` or `getRecordDownloadPath` as unused after this task, remove only the unused function. Do not remove `getRecordDownloadPath` if `paperRecordFromSourceMetadata` still uses it indirectly through other code in the same file.

- [ ] **Step 6: Run the focused test and verify it passes**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/paper-store.test.js --test-name-pattern "source metadata|supplemental"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agent/paper/storage/paper-store.ts test/agent/paper-store.test.ts
git commit -m "Tighten paper source metadata disclosure"
```

---

### Task 3: Keep Wiki Summary Metadata Free of Raw Download Fields

**Files:**
- Modify: `src/agent/wiki/content.ts`
- Modify: `test/agent/paper-reader.test.ts`

- [ ] **Step 1: Update wiki summary test expectation**

In `test/agent/paper-reader.test.ts`, in the test that asserts metadata after `writePaperWikiSource`, replace:

```ts
assert.equal(metadata.provenance.rawSha256, parsed.pdfSha256);
```

with:

```ts
assert.equal("rawSha256" in metadata.provenance, false);
assert.equal("rawPath" in metadata.provenance, false);
assert.equal("recordPath" in metadata.provenance, false);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/paper-reader.test.js --test-name-pattern "writePaperWikiSource"
```

Expected: FAIL because wiki summary metadata still preserves raw download fields.

- [ ] **Step 3: Replace wiki summary provenance construction**

In `src/agent/wiki/content.ts`, replace the `provenance` block in `writePaperWikiSource` metadata construction:

```ts
provenance: {
  ...(previousMetadata?.provenance ?? {}),
  ...(source?.recordPath ? { recordPath: relativeToWorkspace(input.workspaceDir, source.recordPath) } : {}),
  ...(source?.articleUrl ? { url: source.articleUrl } : {}),
  ...(source?.canonicalId && source.source === "arxiv" ? { arxivId: source.canonicalId } : {}),
  ...(source?.pdfPath ? { rawPath: relativeToWorkspace(input.workspaceDir, source.pdfPath) } : {}),
  ...(document.pdfSha256 ? { rawSha256: document.pdfSha256 } : {})
},
```

with:

```ts
provenance: {
  ...(source?.articleUrl ?? previousMetadata?.provenance.url ? {
    url: source?.articleUrl ?? previousMetadata?.provenance.url
  } : {}),
  ...(previousMetadata?.provenance.doi ? { doi: previousMetadata.provenance.doi } : {}),
  ...(source?.canonicalId && source.source === "arxiv"
    ? { arxivId: source.canonicalId }
    : previousMetadata?.provenance.arxivId
      ? { arxivId: previousMetadata.provenance.arxivId }
      : {}),
  ...(source?.recordPath
    ? { acquisitionPath: relativeToWorkspace(input.workspaceDir, source.recordPath) }
    : previousMetadata?.provenance.acquisitionPath
      ? { acquisitionPath: previousMetadata.provenance.acquisitionPath }
      : {})
},
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/paper-reader.test.js --test-name-pattern "writePaperWikiSource"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/wiki/content.ts test/agent/paper-reader.test.ts
git commit -m "Keep wiki source metadata focused on readable artifacts"
```

---

### Task 4: Make Local Paper Listing Use Acquisition for Download Details

**Files:**
- Modify: `src/agent/paper/storage/local-paper-library.ts`
- Test: `test/agent/paper-store.test.ts` if existing local-paper tests are there; otherwise add to the local-paper-library test file found by `rg -n "listLocalPapers" test/agent`

- [ ] **Step 1: Find the existing local-paper listing test file**

Run:

```bash
rg -n "listLocalPapers|LocalPaper" test/agent
```

Expected: output points to the test file that already covers `listLocalPapers`.

- [ ] **Step 2: Add a regression test for minimal metadata with acquisition download state**

In the existing `listLocalPapers` test file, add this test:

```ts
test("listLocalPapers reads download details from acquisition when metadata is minimal", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "local-paper-progressive-"));
  try {
    const paperKey = "arxiv-2401.01234";
    const sourceDir = path.join(workspaceDir, "knowledge-base", "sources", paperKey);
    const pdfPath = path.join(workspaceDir, "knowledge-base", "raw", "pdfs", `${paperKey}.pdf`);
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\npaper\n", "utf8");
    await writeFile(path.join(sourceDir, "acquisition.json"), `${JSON.stringify({
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.01234",
      recordedAt: "2026-05-27T00:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.01234",
      pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
      downloadPath: pdfPath
    }, null, 2)}\n`, "utf8");
    await writeFile(path.join(sourceDir, "metadata.json"), `${JSON.stringify({
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: paperKey,
      title: "Minimal Metadata Paper",
      status: "missing_artifact",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${paperKey}/summary.md`,
      citation: {
        citationStatus: "complete",
        missingFields: [],
        arxivId: "2401.01234",
        authors: ["Ada Lovelace"],
        year: 2024,
        venue: "arXiv"
      },
      provenance: {
        url: "https://arxiv.org/abs/2401.01234",
        arxivId: "2401.01234",
        acquisitionPath: `knowledge-base/sources/${paperKey}/acquisition.json`
      },
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    }, null, 2)}\n`, "utf8");

    const result = await listLocalPapers({ workspaceDir, status: "downloaded", maxResults: 10 });

    assert.equal(result.total, 1);
    assert.equal(result.results[0]?.paperKey, paperKey);
    assert.equal(result.results[0]?.hasPdf, true);
    assert.equal(result.results[0]?.recordPath, `knowledge-base/sources/${paperKey}/acquisition.json`);
    assert.equal(result.results[0]?.pdfPath, `knowledge-base/raw/pdfs/${paperKey}.pdf`);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the focused test**

Run the test file found in Step 1 after build. For example:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/paper-store.test.js --test-name-pattern "listLocalPapers reads download details"
```

Expected: PASS if `collectAcquisitions` already supplies the fields; FAIL if metadata normalization overwrites them.

- [ ] **Step 4: Simplify metadata normalization if needed**

If Step 3 fails because metadata lookup no longer exposes `recordPath` or `pdfPath`, modify `normalizeKnowledgeSourceMetadata` in `src/agent/paper/storage/local-paper-library.ts` so it does not read raw PDF paths from metadata and maps acquisition path only:

```ts
const articleUrl = readOptionalString(provenance.url);
const recordPath = readOptionalString(provenance.acquisitionPath);
const pdfPath = undefined;
```

Keep `canonicalId` derived from citation:

```ts
const canonicalId =
  readOptionalString(citation.doi) ??
  readOptionalString(citation.arxivId);
```

Do not reintroduce `provenance.recordPath`, `provenance.rawPath`, or `provenance.downloadPath` as active metadata fields.

- [ ] **Step 5: Run the focused test again**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/paper-store.test.js --test-name-pattern "listLocalPapers reads download details"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/paper/storage/local-paper-library.ts test/agent/paper-store.test.ts
git commit -m "Read paper download details from acquisition records"
```

---

### Task 5: Clean the Example Record and Verify Health

**Files:**
- Modify: `knowledge-base/sources/nature-nature14270/metadata.json`

- [ ] **Step 1: Refresh or edit the sample metadata shape**

Update `knowledge-base/sources/nature-nature14270/metadata.json` so `provenance` contains only:

```json
{
  "url": "https://www.nature.com/articles/nature14270",
  "doi": "10.1038/nature14270",
  "acquisitionPath": "knowledge-base/sources/nature-nature14270/acquisition.json"
}
```

Set `artifacts` to an empty array unless a real parse artifact exists under `knowledge-base/sources/nature-nature14270/parses/...`.

Set `status` to:

```json
"missing_artifact"
```

because this source currently has a downloaded PDF but no registered LLM-readable parse artifact.

- [ ] **Step 2: Run source metadata focused checks**

Run:

```bash
npm run build && node --test --experimental-test-isolation=none dist/test/agent/source-metadata-store.test.js dist/test/agent/wiki-health.test.js --test-name-pattern "metadata"
```

Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add knowledge-base/sources/nature-nature14270/metadata.json
git commit -m "Clean progressive metadata example"
```

---

### Task 6: Final Review

**Files:**
- Review: `git diff main~4..HEAD` or the equivalent commit range for this branch

- [ ] **Step 1: Check no runtime acquisition fields are newly emitted**

Run:

```bash
rg -n '"recordPath"|"downloadStatus"|"readingStatus"|"pdfUrl"|"downloadPath"|"rawPath"|"canonicalId"|"source"' knowledge-base/sources/nature-nature14270/metadata.json
```

Expected: no matches except `"sourceKind"` if the search pattern is broadened by the shell or editor. The exact command above should not match `sourceKind`.

- [ ] **Step 2: Check parse artifact metadata still exists where produced**

Run:

```bash
rg -n '"kind": "parse"|"markdownPath"|"qualityPath"' test/agent src/agent
```

Expected: parse artifact assertions and writer code still exist.

- [ ] **Step 3: Final full verification**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Final commit if Task 6 changed files**

If Task 6 required any edits, commit them:

```bash
git add src test knowledge-base
git commit -m "Finalize progressive source metadata cleanup"
```
