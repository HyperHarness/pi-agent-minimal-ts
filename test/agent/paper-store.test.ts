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

const supportedPaperRecord = {
  source: "science",
  canonicalId: "10.1126/science.adz8659",
  articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
  pdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
  downloadPath: "downloads/papers/science-10.1126-science.adz8659.pdf",
  recordedAt: "2026-04-23T14:00:00.000Z",
  handlingMethod: "browser_session",
  status: "manual_fallback_opened",
  failure: {
    code: "PAYWALL",
    message: "Browser session required."
  }
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
      record: supportedPaperRecord
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
    assert.deepEqual(JSON.parse(saved), supportedPaperRecord);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

void supportedSearchSource;
void manualFallbackResult;
