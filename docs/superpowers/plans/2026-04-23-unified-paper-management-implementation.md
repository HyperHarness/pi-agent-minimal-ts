# Unified Paper Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split arXiv and publisher paper tools with one `search_papers` tool and one `download_paper` tool that search arXiv first, expand with `web_search`, deduplicate overlapping results, download supported sources into the workspace, and open unsupported sources for user continuation.

**Architecture:** Add a small `paper-manager` orchestration layer plus a `paper-store` persistence layer. `paper-manager` will call existing `searchArxiv`, `searchWeb`, and publisher browser-manager downloads, merge results into one logical paper model, route downloads by source type, and persist a normalized record under `downloads/papers/index/`. `tools.ts` becomes a thin adapter over this manager and `README.md` documents the new behavior.

**Tech Stack:** TypeScript, Node.js built-ins (`fs/promises`, `crypto`, `path`), existing `searchWeb`, existing `searchArxiv`, existing paper browser manager client, Playwright-backed browser session reuse, Node test runner

---

## File Structure

**Create:**
- `src/agent/paper-types.ts`
  Shared paper source, search result, download result, and record types used by the manager, store, and tool layer.
- `src/agent/paper-store.ts`
  File-path resolution, filename sanitization, record-path generation, and JSON record persistence under `downloads/papers/index/`.
- `src/agent/paper-manager.ts`
  Two-stage search orchestration, source classification, cross-source deduplication, primary-source ranking, download routing, publisher fallback handling, and external URL handoff.
- `test/agent/paper-store.test.ts`
  Unit tests for filename generation, record-path generation, and record persistence.
- `test/agent/paper-manager.test.ts`
  Unit tests for search merge/dedupe, arXiv download routing, publisher fallback routing, and external URL handoff.

**Modify:**
- `src/agent/arxiv.ts`
  Add arXiv URL parsing plus direct PDF download helpers for the unified manager.
- `src/agent/paper-download.ts`
  Keep publisher-specific automatic download logic, but expose it as a strategy the unified manager can call.
- `src/agent/browser-session.ts`
  Reuse the local Chrome/Edge opener for unsupported external URLs and make the helper naming fit both publisher fallback and generic open flows.
- `src/agent/tools.ts`
  Remove `search_arxiv`, `download_arxiv_pdf`, and `download_paper_pdf`; add `search_papers` and `download_paper`; route through the unified manager.
- `src/index.ts`
  Re-export the new paper manager and store modules.
- `test/agent/arxiv.test.ts`
  Cover arXiv locator parsing and PDF-body validation.
- `test/agent/tools.test.ts`
  Replace old paper tool assertions with the unified search/download tool behavior.
- `README.md`
  Replace old tool docs and examples with the new unified paper workflow.

## Task 1: Add Shared Paper Types And Persistent Record Storage

**Files:**
- Create: `src/agent/paper-types.ts`
- Create: `src/agent/paper-store.ts`
- Create: `test/agent/paper-store.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing paper-store tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  resolvePaperPdfPath,
  resolvePaperRecordPath,
  writePaperRecord
} from "../../src/agent/paper-store.js";

test("resolvePaperPdfPath uses source-specific filenames", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));

  try {
    assert.equal(
      resolvePaperPdfPath({
        workspaceDir,
        source: "arxiv",
        canonicalId: "2401.01234"
      }),
      path.join(workspaceDir, "downloads", "papers", "arxiv-2401.01234.pdf")
    );

    assert.equal(
      resolvePaperPdfPath({
        workspaceDir,
        source: "science",
        canonicalId: "10.1126/science.adz8659"
      }),
      path.join(workspaceDir, "downloads", "papers", "science-10.1126-science.adz8659.pdf")
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("writePaperRecord persists external_opened records under downloads/papers/index", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));

  try {
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "external",
        articleUrl: "https://example.com/paper",
        openedUrl: "https://example.com/paper",
        recordedAt: "2026-04-23T14:00:00.000Z",
        handlingMethod: "system_browser_open",
        status: "external_opened"
      }
    });

    const saved = JSON.parse(await readFile(recordPath, "utf8"));

    assert.equal(recordPath.startsWith(path.join(workspaceDir, "downloads", "papers", "index")), true);
    assert.equal(path.basename(recordPath).startsWith("external-example.com-"), true);
    assert.equal(saved.status, "external_opened");
    assert.equal(saved.source, "external");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the new test file and verify it fails**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/paper-store.test.js`

Expected: FAIL with module-not-found or missing-export errors for `paper-store`.

- [ ] **Step 3: Add the shared paper types**

Create `src/agent/paper-types.ts`:

```ts
export type PaperSource = "arxiv" | "science" | "nature" | "aps" | "external";
export type PaperAction = "direct_download" | "authorized_download" | "open_url_only";

export interface PaperSearchSource {
  source: PaperSource;
  canonicalId?: string;
  articleUrl: string;
  pdfUrl?: string;
  action: PaperAction;
}

export interface PaperSearchResult {
  title: string;
  authors: string[];
  summary: string;
  primarySource: PaperSource;
  primaryAction: PaperAction;
  sources: PaperSearchSource[];
}

export interface PaperRecord {
  source: PaperSource;
  canonicalId?: string;
  articleUrl: string;
  pdfUrl?: string;
  downloadPath?: string;
  openedUrl?: string;
  recordedAt: string;
  handlingMethod: "direct_http" | "browser_session" | "system_browser_open";
  status: "downloaded" | "manual_fallback_opened" | "external_opened";
  failure?: {
    code: string;
    message: string;
  };
}

export type DownloadedPaperResult = {
  status: "downloaded";
  source: "arxiv" | "science" | "nature" | "aps";
  canonicalId: string;
  articleUrl: string;
  finalPdfUrl: string;
  path: string;
  recordPath: string;
};

export type ManualFallbackPaperResult = {
  status: "manual_fallback_opened";
  source: "science" | "nature" | "aps";
  canonicalId: string;
  articleUrl: string;
  fallbackUrl: string;
  recordPath: string;
  failure: {
    code: string;
    message: string;
  };
  profileDir?: string;
  executablePath?: string;
};

export type ExternalOpenedPaperResult = {
  status: "external_opened";
  source: "external";
  articleUrl: string;
  openedUrl: string;
  recordPath: string;
  executablePath?: string;
};

export type PaperDownloadResult =
  | DownloadedPaperResult
  | ManualFallbackPaperResult
  | ExternalOpenedPaperResult;
```

- [ ] **Step 4: Implement the record-path and record-write helpers**

Create `src/agent/paper-store.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PaperRecord, PaperSource } from "./paper-types.js";

function sanitizeFilenameComponent(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "");
}

export function resolvePaperPdfPath(options: {
  workspaceDir: string;
  source: Exclude<PaperSource, "external">;
  canonicalId: string;
}): string {
  const filename = `${options.source}-${sanitizeFilenameComponent(options.canonicalId)}.pdf`;
  return path.join(options.workspaceDir, "downloads", "papers", filename);
}

export function resolvePaperRecordPath(options: {
  workspaceDir: string;
  source: PaperSource;
  canonicalId?: string;
  articleUrl: string;
}): string {
  const basename =
    options.canonicalId
      ? `${options.source}-${sanitizeFilenameComponent(options.canonicalId)}.json`
      : `external-${sanitizeFilenameComponent(new URL(options.articleUrl).hostname)}-${createHash("sha1")
          .update(options.articleUrl)
          .digest("hex")
          .slice(0, 8)}.json`;

  return path.join(options.workspaceDir, "downloads", "papers", "index", basename);
}

export async function writePaperRecord(options: {
  workspaceDir: string;
  record: PaperRecord;
}): Promise<string> {
  const recordPath = resolvePaperRecordPath({
    workspaceDir: options.workspaceDir,
    source: options.record.source,
    canonicalId: options.record.canonicalId,
    articleUrl: options.record.articleUrl
  });

  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, JSON.stringify(options.record, null, 2), "utf8");
  return recordPath;
}
```

- [ ] **Step 5: Re-export the new modules**

Modify `src/index.ts`:

```ts
export * from "./agent/paper-types.js";
export * from "./agent/paper-store.js";
```

- [ ] **Step 6: Run the targeted paper-store test and verify it passes**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/paper-store.test.js`

Expected: PASS for both `paper-store` tests.

- [ ] **Step 7: Commit**

```bash
git add src/agent/paper-types.ts src/agent/paper-store.ts src/index.ts test/agent/paper-store.test.ts
git commit -m "feat: add paper record storage"
```

## Task 2: Extend arXiv Helpers For URL Parsing And Real PDF Downloads

**Files:**
- Modify: `src/agent/arxiv.ts`
- Modify: `test/agent/arxiv.test.ts`

- [ ] **Step 1: Write the failing arXiv parsing and PDF-body tests**

Add to `test/agent/arxiv.test.ts`:

```ts
import { buildArxivPdfUrl, downloadArxivPdf, parseArxivLocator, searchArxiv } from "../../src/agent/arxiv.js";

test("parseArxivLocator accepts abs and pdf URLs", () => {
  assert.deepEqual(parseArxivLocator("https://arxiv.org/pdf/2401.01234.pdf"), {
    id: "2401.01234",
    absUrl: "https://arxiv.org/abs/2401.01234",
    pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf"
  });

  assert.deepEqual(parseArxivLocator("https://arxiv.org/abs/2401.01234v2"), {
    id: "2401.01234",
    absUrl: "https://arxiv.org/abs/2401.01234",
    pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf"
  });
});

test("downloadArxivPdf rejects bodies that are not real PDFs", async () => {
  await assert.rejects(
    () =>
      downloadArxivPdf({
        input: "2401.01234",
        fetchImpl: async () =>
          new Response("<html>not a pdf</html>", {
            status: 200,
            headers: { "content-type": "text/html" }
          })
      }),
    /pdf/i
  );
});
```

- [ ] **Step 2: Run the targeted arXiv test file and verify it fails**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/arxiv.test.js`

Expected: FAIL with missing export errors for `parseArxivLocator` and `downloadArxivPdf`.

- [ ] **Step 3: Add arXiv locator parsing**

Modify `src/agent/arxiv.ts`:

```ts
export function parseArxivLocator(input: string): {
  id: string;
  absUrl: string;
  pdfUrl: string;
} {
  const trimmed = input.trim();

  if (/^https?:\/\/arxiv\.org\/abs\//i.test(trimmed)) {
    const id = normalizeArxivId(new URL(trimmed).pathname.replace(/^\/abs\//i, ""));
    return {
      id,
      absUrl: buildArxivAbsUrl(id),
      pdfUrl: buildArxivPdfUrl(id)
    };
  }

  if (/^https?:\/\/arxiv\.org\/pdf\//i.test(trimmed)) {
    const id = normalizeArxivId(
      new URL(trimmed).pathname.replace(/^\/pdf\//i, "").replace(/\.pdf$/i, "")
    );

    return {
      id,
      absUrl: buildArxivAbsUrl(id),
      pdfUrl: buildArxivPdfUrl(id)
    };
  }

  const id = normalizeArxivId(trimmed);
  return {
    id,
    absUrl: buildArxivAbsUrl(id),
    pdfUrl: buildArxivPdfUrl(id)
  };
}
```

- [ ] **Step 4: Add direct arXiv PDF download with `%PDF-` validation**

Modify `src/agent/arxiv.ts`:

```ts
export async function downloadArxivPdf(options: {
  input: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  canonicalId: string;
  articleUrl: string;
  finalPdfUrl: string;
  pdfBytes: Buffer;
}> {
  const locator = parseArxivLocator(options.input);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(locator.pdfUrl);

  if (!response.ok) {
    throw new Error(`arXiv PDF download failed with HTTP ${response.status}.`);
  }

  const pdfBytes = Buffer.from(await response.arrayBuffer());
  if (pdfBytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("arXiv PDF download did not return a valid PDF.");
  }

  return {
    canonicalId: locator.id,
    articleUrl: locator.absUrl,
    finalPdfUrl: locator.pdfUrl,
    pdfBytes
  };
}
```

- [ ] **Step 5: Run the targeted arXiv test file and verify it passes**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/arxiv.test.js`

Expected: PASS for the new arXiv locator and PDF validation tests.

- [ ] **Step 6: Commit**

```bash
git add src/agent/arxiv.ts test/agent/arxiv.test.ts
git commit -m "feat: add arxiv download helpers"
```

## Task 3: Build The Unified Paper Search Manager

**Files:**
- Create: `src/agent/paper-manager.ts`
- Create: `test/agent/paper-manager.test.ts`

- [ ] **Step 1: Write the failing paper search manager tests**

Create `test/agent/paper-manager.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { searchPapers } from "../../src/agent/paper-manager.js";

test("searchPapers runs arXiv search first, expands with web search, and merges duplicates", async () => {
  const results = await searchPapers({
    query: "agent memory",
    maxResults: 5,
    searchArxivImpl: async () => [
      {
        id: "2501.01234",
        title: "Agent Memory for Tools",
        authors: ["Ada Lovelace"],
        summary: "Preprint summary",
        absUrl: "https://arxiv.org/abs/2501.01234",
        pdfUrl: "https://arxiv.org/pdf/2501.01234.pdf"
      }
    ],
    searchWebImpl: async () => [
      {
        title: "Agent Memory for Tools",
        url: "https://www.nature.com/articles/s41586-019-1666-5",
        snippet: "Journal version"
      },
      {
        title: "Agent Memory for Tools",
        url: "https://example.com/paper",
        snippet: "Mirror copy"
      }
    ]
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].primarySource, "nature");
  assert.equal(results[0].primaryAction, "authorized_download");
  assert.deepEqual(results[0].sources.map((source) => source.source), [
    "nature",
    "arxiv",
    "external"
  ]);
});

test("searchPapers marks unsupported hosts as open_url_only", async () => {
  const results = await searchPapers({
    query: "graph agents",
    maxResults: 5,
    searchArxivImpl: async () => [],
    searchWebImpl: async () => [
      {
        title: "Graph Agents in Practice",
        url: "https://example.com/graph-agents",
        snippet: "External article"
      }
    ]
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].primarySource, "external");
  assert.equal(results[0].primaryAction, "open_url_only");
});
```

- [ ] **Step 2: Run the new paper-manager test file and verify it fails**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/paper-manager.test.js`

Expected: FAIL with module-not-found or missing-export errors for `paper-manager`.

- [ ] **Step 3: Implement source classification, title normalization, and merge logic**

Create `src/agent/paper-manager.ts`:

```ts
import { searchArxiv, type ArxivSearchResult } from "./arxiv.js";
import { searchWeb, type WebSearchResult } from "./web-search.js";
import type { PaperAction, PaperSearchResult, PaperSearchSource, PaperSource } from "./paper-types.js";

export interface SearchPapersOptions {
  query: string;
  maxResults?: number;
  searchArxivImpl?: typeof searchArxiv;
  searchWebImpl?: typeof searchWeb;
}

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyUrl(url: string): {
  source: PaperSource;
  action: PaperAction;
} {
  const hostname = new URL(url).hostname.toLowerCase();

  if (hostname === "www.science.org" || hostname === "science.org") {
    return { source: "science", action: "authorized_download" };
  }

  if (hostname === "www.nature.com" || hostname === "nature.com") {
    return { source: "nature", action: "authorized_download" };
  }

  if (
    hostname === "journals.aps.org" ||
    hostname === "www.aps.org" ||
    hostname === "aps.org"
  ) {
    return { source: "aps", action: "authorized_download" };
  }

  if (hostname === "arxiv.org" || hostname === "www.arxiv.org") {
    return { source: "arxiv", action: "direct_download" };
  }

  return { source: "external", action: "open_url_only" };
}

function sortSources(sources: PaperSearchSource[]): PaperSearchSource[] {
  const priority: Record<PaperSource, number> = {
    science: 0,
    nature: 0,
    aps: 0,
    arxiv: 1,
    external: 2
  };

  return [...sources].sort((left, right) => priority[left.source] - priority[right.source]);
}

export async function searchPapers(options: SearchPapersOptions): Promise<PaperSearchResult[]> {
  const searchArxivImpl = options.searchArxivImpl ?? searchArxiv;
  const searchWebImpl = options.searchWebImpl ?? searchWeb;

  const [arxivResults, webResults] = await Promise.all([
    searchArxivImpl({ query: options.query, maxResults: options.maxResults }),
    searchWebImpl({ query: options.query, maxResults: options.maxResults })
  ]);

  const merged = new Map<string, PaperSearchResult>();

  for (const result of arxivResults) {
    const key = normalizeTitleKey(result.title);
    merged.set(key, {
      title: result.title,
      authors: result.authors,
      summary: result.summary,
      primarySource: "arxiv",
      primaryAction: "direct_download",
      sources: [
        {
          source: "arxiv",
          canonicalId: result.id,
          articleUrl: result.absUrl,
          pdfUrl: result.pdfUrl,
          action: "direct_download"
        }
      ]
    });
  }

  for (const result of webResults) {
    const key = normalizeTitleKey(result.title);
    const classified = classifyUrl(result.url);
    const existing = merged.get(key);
    const sourceEntry: PaperSearchSource = {
      source: classified.source,
      articleUrl: result.url,
      action: classified.action
    };

    if (!existing) {
      merged.set(key, {
        title: result.title,
        authors: [],
        summary: result.snippet,
        primarySource: classified.source,
        primaryAction: classified.action,
        sources: [sourceEntry]
      });
      continue;
    }

    existing.sources.push(sourceEntry);
    existing.sources = sortSources(existing.sources);
    existing.primarySource = existing.sources[0].source;
    existing.primaryAction = existing.sources[0].action;
  }

  return [...merged.values()].slice(0, options.maxResults ?? 5);
}
```

- [ ] **Step 4: Run the targeted paper-manager search tests and verify they pass**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/paper-manager.test.js`

Expected: PASS for both search-manager tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/paper-manager.ts test/agent/paper-manager.test.ts
git commit -m "feat: add unified paper search manager"
```

## Task 4: Add Unified Download Routing, Publisher Fallback, And External URL Handoff

**Files:**
- Modify: `src/agent/paper-manager.ts`
- Modify: `src/agent/paper-download.ts`
- Modify: `src/agent/browser-session.ts`
- Modify: `test/agent/paper-manager.test.ts`

- [ ] **Step 1: Write the failing unified download routing tests**

Add to `test/agent/paper-manager.test.ts`:

```ts
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadPaper } from "../../src/agent/paper-manager.js";

test("downloadPaper downloads arXiv ids and writes a record", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));

  try {
    const result = await downloadPaper({
      workspaceDir,
      id: "2401.01234",
      downloadArxivPdfImpl: async () => ({
        canonicalId: "2401.01234",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        finalPdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
        pdfBytes: Buffer.from("%PDF-arxiv")
      })
    });

    assert.equal(result.status, "downloaded");
    assert.equal(result.source, "arxiv");
    assert.equal((await readFile(result.path)).subarray(0, 5).toString("ascii"), "%PDF-");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper delegates supported publisher URLs and preserves manual fallback results", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: "https://www.science.org/doi/10.1126/science.adz8659",
      downloadPublisherPaperImpl: async () => {
        throw Object.assign(new Error("manual login required"), {
          code: "manual_login_required"
        });
      },
      openPublisherForLoginImpl: async () => ({
        openedUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        profileDir: path.join(workspaceDir, ".browser-profile", "paper-access")
      })
    });

    assert.equal(result.status, "manual_fallback_opened");
    assert.equal(result.source, "science");
    assert.equal(result.failure.code, "manual_login_required");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper opens unsupported external URLs instead of rejecting them", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: "https://example.com/paper",
      openExternalUrlImpl: async () => ({
        url: "https://example.com/paper",
        openedUrl: "https://example.com/paper",
        profileDir: path.join(workspaceDir, ".browser-profile", "paper-access"),
        executablePath: "C:\\Path\\To\\Chrome\\chrome.exe"
      })
    });

    assert.equal(result.status, "external_opened");
    assert.equal(result.source, "external");
    assert.equal(result.openedUrl, "https://example.com/paper");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the targeted paper-manager test file and verify it fails**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/paper-manager.test.js`

Expected: FAIL with missing-export errors for `downloadPaper`.

- [ ] **Step 3: Make the browser opener usable for both fallback and external handoff**

Modify `src/agent/browser-session.ts`:

```ts
export async function openPageInSystemChrome(
  options: OpenSystemChromePageOptions
): Promise<OpenSystemChromePageResult> {
  return openPageInSystemChromeForManualLogin(options);
}
```

- [ ] **Step 4: Expose the publisher automatic downloader as a strategy function**

Modify `src/agent/paper-download.ts`:

```ts
export function resolvePublisherCanonicalId(input: {
  publisher: "science" | "nature" | "aps";
  url: string;
}): string {
  const parsedUrl = new URL(input.url);

  if (input.publisher === "science") {
    const doi = parsedUrl.pathname.match(/^\/doi\/(?:pdf\/)?(.+)$/i)?.[1];
    if (!doi) {
      throw new Error(`Unable to derive a Science DOI from ${input.url}`);
    }
    return doi;
  }

  if (input.publisher === "nature") {
    const articleId = parsedUrl.pathname.match(/^\/articles\/([^/?#]+?)(?:\.pdf)?$/i)?.[1];
    if (!articleId) {
      throw new Error(`Unable to derive a Nature article id from ${input.url}`);
    }
    return articleId;
  }

  const doi = parsedUrl.pathname.match(/^\/(?:doi|[^/]+)\/(?:abstract|pdf)\/(.+)$/i)?.[1];
  if (!doi) {
    throw new Error(`Unable to derive an APS DOI from ${input.url}`);
  }
  return doi;
}

export async function downloadPublisherPaper(options: {
  workspaceDir: string;
  url: string;
  browserSession: PaperBrowserSession;
}) {
  const downloaded = await downloadPaperPdf(options);
  return {
    ...downloaded,
    canonicalId: resolvePublisherCanonicalId({
      publisher: downloaded.publisher,
      url: downloaded.finalArticleUrl
    })
  };
}

export function resolvePublisherCanonicalIdFromArticleUrl(options: {
  publisher: "science" | "nature" | "aps";
  articleUrl: string;
}): string {
  return resolvePublisherCanonicalId({
    publisher: options.publisher,
    url: options.articleUrl
  });
}
```

- [ ] **Step 5: Implement unified download routing in the paper manager**

Modify `src/agent/paper-manager.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { downloadArxivPdf } from "./arxiv.js";
import { openPageInSystemChrome } from "./browser-session.js";
import {
  downloadPublisherPaper,
  resolvePublisherCanonicalIdFromArticleUrl
} from "./paper-download.js";
import { resolvePaperPdfPath, writePaperRecord } from "./paper-store.js";
import type { PaperDownloadResult } from "./paper-types.js";

function isFallbackEligiblePublisherError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === "string" &&
    ["browser_session_unavailable", "manual_login_required", "authorization_failed", "pdf_not_found", "download_failed"].includes(
      (error as Error & { code: string }).code
    )
  );
}

export async function downloadPaper(options: {
  workspaceDir: string;
  id?: string;
  url?: string;
  downloadArxivPdfImpl?: typeof downloadArxivPdf;
  downloadPublisherPaperImpl?: (input: { workspaceDir: string; url: string }) => Promise<{
    path: string;
    publisher: "science" | "nature" | "aps";
    canonicalId: string;
    articleUrl: string;
    finalArticleUrl: string;
    finalPdfUrl: string;
  }>;
  openPublisherForLoginImpl?: (input: { workspaceDir: string; url: string }) => Promise<{
    openedUrl: string;
    profileDir?: string;
    executablePath?: string;
  }>;
  openExternalUrlImpl?: typeof openPageInSystemChrome;
  now?: () => string;
}): Promise<PaperDownloadResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const input = options.id ?? options.url;

  if (!input || (options.id && options.url)) {
    throw new Error("Exactly one of id or url is required.");
  }

  if (options.id) {
    const downloadArxivPdfImpl = options.downloadArxivPdfImpl ?? downloadArxivPdf;
    const arxiv = await downloadArxivPdfImpl({ input: options.id });
    const pdfPath = resolvePaperPdfPath({
      workspaceDir: options.workspaceDir,
      source: "arxiv",
      canonicalId: arxiv.canonicalId
    });

    await writeFile(pdfPath, arxiv.pdfBytes);

    const recordPath = await writePaperRecord({
      workspaceDir: options.workspaceDir,
      record: {
        source: "arxiv",
        canonicalId: arxiv.canonicalId,
        articleUrl: arxiv.articleUrl,
        pdfUrl: arxiv.finalPdfUrl,
        downloadPath: pdfPath,
        recordedAt: now(),
        handlingMethod: "direct_http",
        status: "downloaded"
      }
    });

    return {
      status: "downloaded",
      source: "arxiv",
      canonicalId: arxiv.canonicalId,
      articleUrl: arxiv.articleUrl,
      finalPdfUrl: arxiv.finalPdfUrl,
      path: pdfPath,
      recordPath
    };
  }

  const classified = classifyUrl(options.url!);

  if (classified.source === "external") {
    const openExternalUrlImpl = options.openExternalUrlImpl ?? openPageInSystemChrome;
    const opened = await openExternalUrlImpl({
      workspaceDir: options.workspaceDir,
      url: options.url!
    });

    const recordPath = await writePaperRecord({
      workspaceDir: options.workspaceDir,
      record: {
        source: "external",
        articleUrl: options.url!,
        openedUrl: opened.openedUrl,
        recordedAt: now(),
        handlingMethod: "system_browser_open",
        status: "external_opened"
      }
    });

    return {
      status: "external_opened",
      source: "external",
      articleUrl: options.url!,
      openedUrl: opened.openedUrl,
      recordPath,
      executablePath: opened.executablePath
    };
  }

  const downloadPublisherPaperImpl = options.downloadPublisherPaperImpl ?? (async (input) => {
    throw new Error(`Inject publisher downloads through tools.ts: ${input.url}`);
  });
  const openPublisherForLoginImpl = options.openPublisherForLoginImpl ?? (async (input) => {
    throw new Error(`Inject publisher manual open through tools.ts: ${input.url}`);
  });

  try {
    const downloaded = await downloadPublisherPaperImpl({
      workspaceDir: options.workspaceDir,
      url: options.url!
    });
    const recordPath = await writePaperRecord({
      workspaceDir: options.workspaceDir,
      record: {
        source: downloaded.publisher,
        canonicalId: downloaded.canonicalId,
        articleUrl: downloaded.articleUrl,
        pdfUrl: downloaded.finalPdfUrl,
        downloadPath: downloaded.path,
        recordedAt: now(),
        handlingMethod: "browser_session",
        status: "downloaded"
      }
    });

    return {
      status: "downloaded",
      source: downloaded.publisher,
      canonicalId: downloaded.canonicalId,
      articleUrl: downloaded.articleUrl,
      finalPdfUrl: downloaded.finalPdfUrl,
      path: downloaded.path,
      recordPath
    };
  } catch (error) {
    if (!isFallbackEligiblePublisherError(error)) {
      throw error;
    }

    const opened = await openPublisherForLoginImpl({
      workspaceDir: options.workspaceDir,
      url: options.url!
    });
    const recordPath = await writePaperRecord({
      workspaceDir: options.workspaceDir,
      record: {
        source: classified.source as "science" | "nature" | "aps",
        canonicalId: resolvePublisherCanonicalIdFromArticleUrl({
          publisher: classified.source as "science" | "nature" | "aps",
          articleUrl: options.url!
        }),
        articleUrl: options.url!,
        openedUrl: opened.openedUrl,
        recordedAt: now(),
        handlingMethod: "browser_session",
        status: "manual_fallback_opened",
        failure: {
          code: error.code,
          message: error.message
        }
      }
    });

    return {
      status: "manual_fallback_opened",
      source: classified.source as "science" | "nature" | "aps",
      canonicalId: resolvePublisherCanonicalIdFromArticleUrl({
        publisher: classified.source as "science" | "nature" | "aps",
        articleUrl: options.url!
      }),
      articleUrl: options.url!,
      fallbackUrl: opened.openedUrl,
      recordPath,
      failure: {
        code: error.code,
        message: error.message
      },
      profileDir: opened.profileDir,
      executablePath: opened.executablePath
    };
  }
}
```

- [ ] **Step 6: Run the targeted paper-manager test file and verify it passes**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/paper-manager.test.js`

Expected: PASS for search, arXiv download, publisher fallback, and external-open tests.

- [ ] **Step 7: Commit**

```bash
git add src/agent/paper-manager.ts src/agent/paper-download.ts src/agent/browser-session.ts test/agent/paper-manager.test.ts
git commit -m "feat: add unified paper download routing"
```

## Task 5: Replace The Tool Surface With `search_papers` And `download_paper`

**Files:**
- Modify: `src/agent/tools.ts`
- Modify: `test/agent/tools.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing unified tool tests**

Add to `test/agent/tools.test.ts`:

```ts
test("createTools exposes the unified paper tool set", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "get_time",
        "read_file",
        "web_search",
        "fetch_url",
        "search_papers",
        "download_paper",
        "open_paper_page_for_login",
      ],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search_papers delegates to the injected paper manager", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace, {
      searchPapers: async () => [
        {
          title: "Agent Memory for Tools",
          authors: ["Ada Lovelace"],
          summary: "Merged result",
          primarySource: "nature",
          primaryAction: "authorized_download",
          sources: [
            {
              source: "nature",
              articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
              action: "authorized_download",
            },
          ],
        },
      ],
    } as any);

    const tool = tools.find((candidate) => candidate.name === "search_papers");
    assert.ok(tool);
    const result = await tool.execute!("tool-call-1", { query: "agent memory", maxResults: 3 }, undefined);

    assert.equal(result.details?.count, 1);
    assert.match(String(result.content?.[0]?.text), /Agent Memory for Tools/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper delegates ids and URLs to the injected paper manager", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace, {
      downloadPaper: async () => ({
        status: "external_opened",
        source: "external",
        articleUrl: "https://example.com/paper",
        openedUrl: "https://example.com/paper",
        recordPath: path.join(workspace, "downloads", "papers", "index", "external-example.com-1a2b3c4d.json"),
      }),
    } as any);

    const tool = tools.find((candidate) => candidate.name === "download_paper");
    assert.ok(tool);
    const result = await tool.execute!("tool-call-2", { url: "https://example.com/paper" }, undefined);

    assert.equal((result.details as any).status, "external_opened");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the targeted tools test file and verify it fails**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/tools.test.js`

Expected: FAIL because `search_papers` and `download_paper` do not exist yet.

- [ ] **Step 3: Replace the old tool parameters and dependencies**

Modify `src/agent/tools.ts`:

```ts
import type { PaperDownloadResult, PaperSearchResult } from "./paper-types.js";
import { downloadPaper, searchPapers } from "./paper-manager.js";

const searchPapersParameters = Type.Object({
  query: Type.String({ description: "Search query string for papers." }),
  maxResults: Type.Optional(
    Type.Integer({ description: "Maximum number of merged paper results to return.", minimum: 1 })
  )
});

const downloadPaperParameters = Type.Object({
  id: Type.Optional(Type.String({ description: "Paper identifier, currently used for arXiv ids." })),
  url: Type.Optional(Type.String({ description: "Paper article URL." }))
});

type SearchPapersTool = AgentTool<
  typeof searchPapersParameters,
  { query: string; maxResults: number; count: number }
>;

type DownloadPaperTool = AgentTool<typeof downloadPaperParameters, PaperDownloadResult>;

export interface ToolDependencies {
  searchWeb?: typeof searchWeb;
  fetchWebPage?: typeof fetchWebPage;
  searchArxiv?: typeof searchArxiv;
  searchPapers?: typeof searchPapers;
  downloadPaper?: typeof downloadPaper;
  openPaperPageForLogin?: OpenPaperPageForLoginDependency;
  browserSessionFactory?: ReturnType<typeof resolveDefaultPaperBrowserSessionFactory>;
  paperBrowserManagerClient?: PaperBrowserManagerClient;
}
```

- [ ] **Step 4: Add the unified tool implementations and remove the old ones**

Modify `src/agent/tools.ts`:

```ts
const searchPapersImpl = dependencies.searchPapers ?? (async (options) =>
  searchPapers({
    ...options,
    searchArxivImpl,
    searchWebImpl
  }));

const downloadPaperImpl = dependencies.downloadPaper ?? (async (options) =>
  downloadPaper({
    ...options,
    downloadPublisherPaperImpl: (input) => paperBrowserManagerClient.downloadPaperPdf(input),
    openPublisherForLoginImpl: (input) => paperBrowserManagerClient.openArticle({ url: input.url }),
  }));

const searchPapersTool = {
  name: "search_papers",
  label: "Search Papers",
  description: "Searches arXiv first, expands with web search, and returns merged paper results.",
  parameters: searchPapersParameters,
  execute: async (_toolCallId: string, args: { query: string; maxResults?: number }) => {
    const results = await searchPapersImpl(args);
    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
      details: { query: args.query, maxResults: args.maxResults ?? 5, count: results.length }
    };
  }
};

const downloadPaperTool = {
  name: "download_paper",
  label: "Download Paper",
  description: "Downloads supported papers into the workspace or opens unsupported sources for user continuation.",
  parameters: downloadPaperParameters,
  executionMode: "sequential",
  execute: async (_toolCallId: string, args: { id?: string; url?: string }) => {
    const result = await downloadPaperImpl({
      workspaceDir: resolvedWorkspaceDir,
      id: args.id,
      url: args.url
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result
    };
  }
};
```

- [ ] **Step 5: Update the tool tuple and exports**

Modify `src/agent/tools.ts` and `src/index.ts`:

```ts
export type AgentTools = [
  GetTimeTool,
  ReadFileTool,
  WebSearchTool,
  FetchUrlTool,
  SearchPapersTool,
  DownloadPaperTool,
  OpenPaperPageForLoginTool
] & ToolSetMetadata;
```

```ts
export * from "./agent/paper-manager.js";
```

- [ ] **Step 6: Run the targeted tools test file and verify it passes**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/tools.test.js`

Expected: PASS for the unified paper tool tests and the unchanged utility-tool tests.

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools.ts src/index.ts test/agent/tools.test.ts
git commit -m "feat: expose unified paper tools"
```

## Task 6: Update README And Run Full Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the old paper tool documentation in README**

Modify `README.md`:

```md
## Built-in Tools

- `get_time`: returns the current time, optionally for a given timezone
- `read_file`: reads a UTF-8 text file from inside the current workspace
- `web_search`: searches the configured provider and returns JSON text for matching results
- `fetch_url`: fetches an HTML page and returns JSON text for the extracted content
- `search_papers`: searches arXiv first, then reuses the configured web search provider and returns merged paper results
- `download_paper`: downloads arXiv and supported publisher papers into `downloads/papers/`, or opens unsupported external URLs for manual continuation
- `open_paper_page_for_login`: opens a supported publisher page in the managed browser session for manual login review without downloading anything

For `search_papers`, the search flow queries arXiv first and then expands through `web_search`. When the same paper appears in multiple sources, the agent returns one merged result instead of duplicate entries.
```

- [ ] **Step 2: Replace the old prompt examples**

Modify `README.md`:

```md
Example prompts:

- `Search papers about retrieval-augmented generation from the last few years.`
- `Download paper 2401.01234.`
- `Download this paper: https://www.nature.com/articles/s41586-019-1666-5`
- `Open this paper page with open_paper_page_for_login: https://www.science.org/doi/10.1126/science.adz8659`
```

- [ ] **Step 3: Run the build and the focused paper test suite**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/paper-store.test.js dist/test/agent/arxiv.test.js dist/test/agent/paper-manager.test.js dist/test/agent/tools.test.js`

Expected: PASS across the paper store, arXiv, paper manager, and tools tests.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`

Expected: PASS for the full repository test suite, including unchanged browser-manager and fetch/search tests.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe unified paper workflow"
```
