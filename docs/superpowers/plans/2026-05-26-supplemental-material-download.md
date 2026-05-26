# Supplemental Material Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download supplemental material files for supported publisher articles and attach them to the same paper record as the main article.

**Architecture:** Content scripts detect supplemental material URLs while preserving the main PDF candidate. The background worker fetches supplemental PDF bytes with browser credentials and sends them to the native host through a new protocol message. The native host saves the files under `knowledge-base/sources/<paperKey>/supplemental/` and merges metadata into the publisher acquisition record without changing the main PDF status.

**Tech Stack:** TypeScript, Node test runner, Chrome MV3 extension JavaScript, existing paper extension native-host protocol.

---

## File Map

- Modify `src/agent/paper/types.ts`: add `PaperSupplementalMaterial` and optional `supplementalMaterials` on publisher paper records and source metadata.
- Modify `src/agent/knowledge-base.ts`: keep supplemental material out of global raw roots; files live under the article source directory.
- Modify `src/agent/paper/storage/paper-store.ts`: preserve `supplementalMaterials` in source metadata and add a helper to merge supplemental material entries by URL.
- Modify `src/agent/paper/extension/paper-extension-protocol.ts`: add `register_supplemental_material` message and `supplemental_registered` response.
- Modify `src/agent/paper/extension/paper-extension-host.ts`: handle supplemental registration and write files under `knowledge-base/sources/<paperKey>/supplemental/`.
- Modify `src/agent/paper/extension/paper-download-jobs.ts`: allow supplemental file metadata in job events.
- Modify `browser-extension/paper-downloader/content/common.js`: add generic supplemental link detection.
- Modify `browser-extension/paper-downloader/content/aps.js`: add APS supplemental URL derivation from APS article URLs.
- Modify `browser-extension/paper-downloader/content/science.js` and `browser-extension/paper-downloader/content/nature.js` only if publisher-specific detection is needed after generic tests.
- Modify `browser-extension/paper-downloader/content/runner.js`: include supplemental candidates in `paper_page_classified`.
- Modify `browser-extension/paper-downloader/background.js`: fetch supplemental candidates and send native registrations.
- Test `test/agent/paper-extension-protocol.test.ts`.
- Test `test/agent/paper-extension-host.test.ts`.
- Test `test/agent/paper-store.test.ts`.
- Test `test/browser-extension/paper-downloader.test.mjs`.

## Task 1: Protocol Types

**Files:**
- Modify: `src/agent/paper/extension/paper-extension-protocol.ts`
- Test: `test/agent/paper-extension-protocol.test.ts`

- [ ] **Step 1: Write the failing protocol test**

Add this test near the existing `register_download_bytes` test:

```ts
test("parseExtensionHostMessage accepts register_supplemental_material messages", () => {
  const message = parseExtensionHostMessage({
    type: "register_supplemental_material",
    jobId: "job-supplement",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    source: "aps",
    materialUrl: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
    materialBase64: "JVBERi0xLjQK",
    filename: "SM.pdf",
    mimeType: "application/pdf",
    title: "Supplemental Material"
  });

  assert.deepEqual(message, {
    type: "register_supplemental_material",
    jobId: "job-supplement",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    source: "aps",
    materialUrl: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
    materialBase64: "JVBERi0xLjQK",
    filename: "SM.pdf",
    mimeType: "application/pdf",
    title: "Supplemental Material"
  });
});

test("parseExtensionHostResponse accepts supplemental_registered responses", () => {
  const response = parseExtensionHostResponse({
    type: "supplemental_registered",
    jobId: "job-supplement",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    materialUrl: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
    path: "knowledge-base/sources/aps-10.1103-PhysRevLett.111.080502/supplemental/SM.pdf",
    sha256: "abc123",
    recordPath: "knowledge-base/sources/aps/10.1103-PhysRevLett.111.080502/acquisition.json",
    title: "Supplemental Material"
  });

  assert.deepEqual(response, {
    type: "supplemental_registered",
    jobId: "job-supplement",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    materialUrl: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
    path: "knowledge-base/sources/aps-10.1103-PhysRevLett.111.080502/supplemental/SM.pdf",
    sha256: "abc123",
    recordPath: "knowledge-base/sources/aps/10.1103-PhysRevLett.111.080502/acquisition.json",
    title: "Supplemental Material"
  });
});
```

- [ ] **Step 2: Run the protocol test and verify RED**

Run: `npm test -- test/agent/paper-extension-protocol.test.ts`

Expected: FAIL with `type must be a valid extension host message type` or a missing `supplemental_registered` response branch.

- [ ] **Step 3: Implement protocol types and parsers**

Add a message union branch:

```ts
| {
    type: "register_supplemental_material";
    jobId: string;
    articleUrl: string;
    source: PaperSource;
    materialUrl: string;
    materialBase64: string;
    filename?: string;
    mimeType?: string;
    title?: string;
  }
```

Add a response union branch:

```ts
| {
    type: "supplemental_registered";
    jobId: string;
    articleUrl: string;
    materialUrl: string;
    path: string;
    sha256: string;
    recordPath: string;
    title?: string;
  }
```

Add parser branches using existing `parseRequiredString`, `parsePaperSource`, and `parseOptionalFields`.

- [ ] **Step 4: Run the protocol test and verify GREEN**

Run: `npm test -- test/agent/paper-extension-protocol.test.ts`

Expected: PASS.

## Task 2: Paper Record Storage

**Files:**
- Modify: `src/agent/knowledge-base.ts`
- Modify: `src/agent/paper/types.ts`
- Modify: `src/agent/paper/storage/paper-store.ts`
- Test: `test/agent/paper-store.test.ts`

- [ ] **Step 1: Write the failing paper-store test**

Add a test that writes a publisher record with supplemental material and asserts both `acquisition.json` and `source.json` preserve it:

```ts
test("writePaperRecord persists publisher supplemental materials into source metadata", async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "paper-store-supplemental-"));
  const supplementalPath = path.join(
    workspaceDir,
    "knowledge-base",
    "raw",
    "supplemental",
    "aps",
    "10.1103-PhysRevLett.111.080502",
    "SM.pdf"
  );
  const pdfPath = path.join(workspaceDir, "knowledge-base", "raw", "pdfs", "aps-main.pdf");

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await mkdir(path.dirname(supplementalPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\nmain\n", "utf8");
    await writeFile(supplementalPath, "%PDF-1.7\nsupplement\n", "utf8");

    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "aps",
        articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
        recordedAt: "2026-05-26T00:00:00.000Z",
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: "10.1103/PhysRevLett.111.080502",
        pdfUrl: "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.111.080502",
        downloadPath: pdfPath,
        supplementalMaterials: [
          {
            url: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
            title: "Supplemental Material",
            filename: "SM.pdf",
            path: supplementalPath,
            mimeType: "application/pdf",
            sha256: "supplement-sha",
            downloadedAt: "2026-05-26T00:01:00.000Z"
          }
        ]
      }
    });

    const acquisition = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(acquisition.supplementalMaterials[0].filename, "SM.pdf");
    const source = JSON.parse(await readFile(path.join(path.dirname(recordPath), "source.json"), "utf8"));
    assert.equal(source.supplementalMaterials[0].title, "Supplemental Material");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the paper-store test and verify RED**

Run: `npm test -- test/agent/paper-store.test.ts`

Expected: FAIL from TypeScript compile errors for missing `supplementalMaterials` types or missing metadata propagation.

- [ ] **Step 3: Add data model and path support**

Keep `PaperLibraryPaths` focused on global roots. Supplemental files are placed under the resolved source directory for the publisher record.

Add this exported interface in `src/agent/paper/types.ts`:

```ts
export interface PaperSupplementalMaterial {
  url: string;
  title?: string;
  filename: string;
  path: string;
  mimeType?: string;
  sha256: string;
  downloadedAt: string;
}
```

Add `supplementalMaterials?: PaperSupplementalMaterial[];` to `PaperSourceMetadata` and to each supported-publisher record type that can exist without a main PDF: `DownloadedPublisherPaperRecord`, `PublisherPreprintFallbackPaperRecord`, `PublisherPendingPaperRecord`, and `ManualFallbackPaperRecord`.

- [ ] **Step 4: Preserve supplemental metadata in source writes**

Update `writePaperSourceMetadataForRecord` in `src/agent/paper/storage/paper-store.ts` so source metadata includes:

```ts
...(record.source !== "external" && record.supplementalMaterials
  ? { supplementalMaterials: record.supplementalMaterials }
  : {}),
```

- [ ] **Step 5: Run the paper-store test and verify GREEN**

Run: `npm test -- test/agent/paper-store.test.ts`

Expected: PASS.

## Task 3: Native Host Supplemental Registration

**Files:**
- Modify: `src/agent/paper/extension/paper-extension-host.ts`
- Modify: `src/agent/paper/extension/paper-download-jobs.ts`
- Test: `test/agent/paper-extension-host.test.ts`

- [ ] **Step 1: Write the failing native-host test**

Add this test near the Science supplement rejection test:

```ts
test("handleExtensionHostMessage registers APS supplemental material on the publisher record", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502";
  const materialUrl = "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf";

  try {
    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-05-26T10:30:00.000Z"),
      message: {
        type: "register_supplemental_material",
        jobId: "job-aps-supplement",
        articleUrl,
        source: "aps",
        materialUrl,
        materialBase64: Buffer.from("%PDF-1.7\nsupplement pdf\n").toString("base64"),
        filename: "SM.pdf",
        mimeType: "application/pdf",
        title: "Supplemental Material"
      }
    });

    assert.equal(response.type, "supplemental_registered");
    assert.equal(response.articleUrl, articleUrl);
    assert.equal(response.materialUrl, materialUrl);
    assert.match(response.path, /knowledge-base\/sources\/aps-10\.1103-PhysRevLett\.111\.080502\/supplemental\/SM\.pdf$/);

    const recordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "aps",
      canonicalId: "10.1103/PhysRevLett.111.080502",
      articleUrl
    });
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(record.status, "publisher_pending");
    assert.equal(record.supplementalMaterials[0].url, materialUrl);
    assert.equal(await readFile(response.path, "utf8"), "%PDF-1.7\nsupplement pdf\n");

    const events = await readPaperDownloadJobEvents({ workspaceDir });
    assert.equal(events.at(-1)?.status, "supplemental_material_downloaded");
    assert.equal(events.at(-1)?.downloadPath, response.path);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the native-host test and verify RED**

Run: `npm test -- test/agent/paper-extension-host.test.ts`

Expected: FAIL because the protocol message is not routed by `handleExtensionHostMessage` and the job event status is not yet accepted.

- [ ] **Step 3: Add event status support**

In `src/agent/paper/extension/paper-download-jobs.ts`, add `"supplemental_material_downloaded"` and `"supplemental_material_failed"` to the local job-event status union/parser, and allow optional `materialUrl`, `mimeType`, and `sha256` fields.

- [ ] **Step 4: Implement supplemental registration**

In `handleExtensionHostMessage`, route `message.type === "register_supplemental_material"` to `registerSupplementalMaterial`.

Implement helpers in `paper-extension-host.ts`:

```ts
function decodeSupplementalBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function sanitizeSupplementalFilename(value: string | undefined, materialUrl: string): string {
  const preferred = value?.trim() || path.basename(new URL(materialUrl).pathname) || "supplemental-material";
  const cleaned = preferred
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[ .]+$/g, "");
  return cleaned || "supplemental-material";
}

```

The registration function resolves the supported publisher canonical ID, writes the decoded PDF bytes under `path.dirname(resolvePaperRecordPath(...))/supplemental/`, reads any existing record, merges the material by `url`, and writes a `publisher_pending` record when no record exists.

- [ ] **Step 5: Run the native-host test and verify GREEN**

Run: `npm test -- test/agent/paper-extension-host.test.ts`

Expected: PASS.

## Task 4: Extension Supplemental Detection

**Files:**
- Modify: `browser-extension/paper-downloader/content/common.js`
- Modify: `browser-extension/paper-downloader/content/aps.js`
- Modify: `browser-extension/paper-downloader/content/runner.js`
- Test: `test/browser-extension/paper-downloader.test.mjs`

- [ ] **Step 1: Write failing content-script tests**

Add assertions to `publisher helpers extract Nature, Science, and APS PDF candidates` or a new test:

```js
test("publisher helpers extract supplemental material candidates", () => {
  assert.deepEqual(
    globalThis.PiAgentPaperCommon.findSupplementalMaterialCandidates({
      document: doc('<a href="/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf">Supplemental Material</a>'),
      baseUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502"
    }),
    [
      {
        url: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
        title: "Supplemental Material"
      }
    ]
  );

  assert.deepEqual(
    globalThis.PiAgentPaperAps.findApsSupplementalMaterialCandidates({
      document: doc("<main>No direct links</main>"),
      baseUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502"
    }),
    [
      {
        url: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502",
        title: "Supplemental Material"
      }
    ]
  );
});
```

- [ ] **Step 2: Run the browser-extension test and verify RED**

Run: `node --test test/browser-extension/paper-downloader.test.mjs`

Expected: FAIL because `findSupplementalMaterialCandidates` and `findApsSupplementalMaterialCandidates` are undefined.

- [ ] **Step 3: Add generic supplemental detection**

In `common.js`, add `findSupplementalMaterialCandidates(input)` that scans `a[href]`, resolves URLs, and returns unique `{ url, title }` candidates when the visible text or href matches supplemental material patterns. Export it on `root.PiAgentPaperCommon`.

- [ ] **Step 4: Add APS fallback derivation**

In `aps.js`, add `deriveApsSupplementalUrl(baseUrl)` and `findApsSupplementalMaterialCandidates(input)`. The fallback should derive `/prl/supplemental/<doi>` from `/prl/abstract/<doi>` and `/doi/<doi>` when generic detection returns no candidates.

- [ ] **Step 5: Include candidates in runner messages**

In `runner.js`, call a publisher helper for supplemental material and include `supplementalMaterials` in `paper_page_classified` messages when `classification.status === "page_classified"`.

- [ ] **Step 6: Run the browser-extension test and verify GREEN**

Run: `node --test test/browser-extension/paper-downloader.test.mjs`

Expected: PASS.

## Task 5: Background Fetch and Native Registration

**Files:**
- Modify: `browser-extension/paper-downloader/background.js`
- Test: `test/browser-extension/paper-downloader.test.mjs`

- [ ] **Step 1: Write the failing background test**

Add a test after the webpage asset test:

```js
test("background registers supplemental materials without blocking the main PDF download", async () => {
  const fetchCalls = [];
  const job = {
    jobId: "job-aps-supplement",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    source: "aps",
    title: "APS paper"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return new Response(Buffer.from("%PDF-1.7\nsupplement pdf\n"), {
        status: 200,
        headers: { "content-type": "application/pdf" }
      });
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl: "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.111.080502",
      supplementalMaterials: [
        {
          url: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
          title: "Supplemental Material"
        }
      ]
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();

  assert.deepEqual(fetchCalls, [
    {
      url: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
      init: { credentials: "include" }
    }
  ]);
  const supplemental = messagesOf(fakeChrome, "register_supplemental_material")[0];
  assert.equal(supplemental.materialUrl, "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf");
  assert.equal(supplemental.filename, "SM.pdf");
  assert.equal(messagesOf(fakeChrome, "register_download_bytes").length, 1);
});
```

- [ ] **Step 2: Run the browser-extension test and verify RED**

Run: `node --test test/browser-extension/paper-downloader.test.mjs`

Expected: FAIL because no supplemental native registration is sent.

- [ ] **Step 3: Implement background supplemental fetch**

Add constants:

```js
const MAX_SUPPLEMENTAL_MATERIAL_COUNT = 8;
const MAX_SUPPLEMENTAL_MATERIAL_BYTES = 32 * 1024 * 1024;
```

Add `fetchSupplementalMaterials(job, candidates)` that deduplicates URLs, fetches with browser credentials, checks the size cap, verifies the response is a PDF, base64-encodes bytes, and sends `register_supplemental_material`. Call it from `handlePaperPageClassified` after webpage snapshot handling and before `startAutomaticDownload(job, message.pdfUrl)`.

- [ ] **Step 4: Run the browser-extension test and verify GREEN**

Run: `node --test test/browser-extension/paper-downloader.test.mjs`

Expected: PASS.

## Task 6: Integration Validation

**Files:**
- Modify only files changed by prior tasks.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- test/agent/paper-extension-protocol.test.ts
npm test -- test/agent/paper-store.test.ts
npm test -- test/agent/paper-extension-host.test.ts
node --test test/browser-extension/paper-downloader.test.mjs
```

Expected: all commands PASS.

- [ ] **Step 2: Run full suite**

Run: `npm test`

Expected: PASS. If the sandbox reports `listen EPERM 127.0.0.1`, rerun outside the sandbox or report the sandbox limitation with the focused test results.

- [ ] **Step 3: Inspect final diff**

Run: `git diff --stat` and `git diff --check`.

Expected: no whitespace errors and changes limited to supplemental material support, tests, spec, and plan.
