import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type {
  ManualFallbackPaperResult,
  PaperRecord,
  PaperSearchResult,
  PaperSearchSource,
  PaperSource
} from "../../src/agent/paper-types.js";
import {
  resolvePaperPdfPath,
  resolvePaperRecordPath,
  writePaperRecord
} from "../../src/agent/paper-store.js";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const supportedSearchSource = {
  source: "science",
  canonicalId: "10.1126/science.adz8659",
  articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
  pdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
  action: "authorized_download"
} satisfies PaperSearchSource;

const externalSearchSource = {
  source: "external",
  articleUrl: "https://example.com/paper",
  action: "open_url_only"
} satisfies PaperSearchSource;

const invalidExternalSearchSource = {
  source: "external",
  canonicalId: "2401.01234",
  articleUrl: "https://example.com/paper",
  action: "open_url_only"
  // @ts-expect-error external search sources must not expose supported-source identifiers
} satisfies PaperSearchSource;

const manualFallbackPaperRecord = {
  source: "science",
  canonicalId: "10.1126/science.adz8659",
  articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
  openedUrl: "https://www.science.org/doi/10.1126/science.adz8659",
  recordedAt: "2026-04-23T14:00:00.000Z",
  handlingMethod: "browser_session",
  status: "manual_fallback_opened",
  failure: {
    code: "PAYWALL",
    message: "Browser session required."
  }
} satisfies PaperRecord;

const invalidDownloadedPaperRecord = {
  source: "science",
  canonicalId: "10.1126/science.adz8659",
  articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
  recordedAt: "2026-04-23T14:00:00.000Z",
  handlingMethod: "browser_session",
  status: "downloaded"
  // @ts-expect-error downloaded records require a downloadPath and pdfUrl
} satisfies PaperRecord;

const invalidExternalPaperRecord = {
  source: "external",
  articleUrl: "https://example.com/paper",
  openedUrl: "https://example.com/paper",
  downloadPath: "downloads/papers/external.pdf",
  recordedAt: "2026-04-23T14:00:00.000Z",
  handlingMethod: "system_browser_open",
  status: "external_opened"
  // @ts-expect-error external-opened records must not carry download metadata
} satisfies PaperRecord;

const manualFallbackResult = {
  status: "manual_fallback_opened",
  source: "science",
  canonicalId: "10.1126/science.adz8659",
  articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
  fallbackUrl: "https://www.science.org/doi/10.1126/science.adz8659",
  recordPath: "downloads/papers/index/science-10.1126-science.adz8659.json",
  failure: {
    code: "PAYWALL",
    message: "Opened article in browser."
  }
} satisfies ManualFallbackPaperResult;

const invalidPrimarySearchResult = {
  title: "Agent Memory for Tools",
  authors: ["Ada Lovelace"],
  summary: "Merged result",
  primarySource: "external",
  primaryAction: "direct_download",
  sources: [externalSearchSource, supportedSearchSource]
  // @ts-expect-error primaryAction must align with primarySource
} satisfies PaperSearchResult;

type _PaperSearchResultPrimarySourceIsPaperSource = Assert<
  IsEqual<PaperSearchResult["primarySource"], PaperSource>
>;

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

    assert.equal(
      resolvePaperPdfPath({
        workspaceDir,
        source: "nature",
        canonicalId: "s41586-019-1666-5"
      }),
      path.join(workspaceDir, "downloads", "papers", "nature-s41586-019-1666-5.pdf")
    );

    assert.equal(
      resolvePaperPdfPath({
        workspaceDir,
        source: "aps",
        canonicalId: "10.1103/PhysRevLett.133.123456"
      }),
      path.join(
        workspaceDir,
        "downloads",
        "papers",
        "aps-10.1103-PhysRevLett.133.123456.pdf"
      )
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("resolvePaperPdfPath rejects canonical ids that sanitize to an empty filename", () => {
  assert.throws(
    () =>
      resolvePaperPdfPath({
        workspaceDir: "C:\\workspace",
        source: "science",
        canonicalId: "   "
      }),
    /canonicalId/i
  );
});

test("resolvePaperRecordPath uses canonical ids for supported sources and hostname hashes for external records", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));

  try {
    assert.equal(
      resolvePaperRecordPath({
        workspaceDir,
        source: "science",
        canonicalId: "10.1126/science.adz8659",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659"
      }),
      path.join(
        workspaceDir,
        "downloads",
        "papers",
        "index",
        "science-10.1126-science.adz8659.json"
      )
    );

    const externalRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "external",
      articleUrl: "https://example.com/paper"
    });

    assert.equal(
      externalRecordPath.startsWith(path.join(workspaceDir, "downloads", "papers", "index")),
      true
    );
    assert.equal(path.basename(externalRecordPath).startsWith("external-example.com-"), true);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("resolvePaperRecordPath rejects canonical ids that sanitize to an empty filename", () => {
  assert.throws(
    () =>
      resolvePaperRecordPath({
        workspaceDir: "C:\\workspace",
        source: "science",
        canonicalId: "   ",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659"
      }),
    /canonicalId/i
  );
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

test("writePaperRecord persists supported source records with pretty-printed failure objects", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));

  try {
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: manualFallbackPaperRecord
    });

    const saved = await readFile(recordPath, "utf8");

    assert.equal(
      recordPath,
      path.join(
        workspaceDir,
        "downloads",
        "papers",
        "index",
        "science-10.1126-science.adz8659.json"
      )
    );
    assert.match(saved, /\n  "failure": \{\n    "code": "PAYWALL",\n    "message": "Browser session required\."\n  \}\n/);
    assert.deepEqual(JSON.parse(saved), manualFallbackPaperRecord);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

void supportedSearchSource;
void externalSearchSource;
void invalidExternalSearchSource;
void invalidDownloadedPaperRecord;
void invalidExternalPaperRecord;
void invalidPrimarySearchResult;
void manualFallbackResult;
