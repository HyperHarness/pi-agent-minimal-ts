import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type {
  ManualFallbackPaperResult,
  PaperRecord,
  PaperSearchResult,
  PaperSearchSource,
  PaperSource
} from "../../src/agent/paper/types.js";
import {
  findDownloadedPaperRecord,
  readPaperRecordByPath,
  resolveExternalPaperPdfPath,
  resolvePaperPdfPath,
  resolvePaperSourcePath,
  resolvePaperRecordPath,
  updatePaperRecordParseManifest,
  updatePaperRecordQueuedReading,
  updatePaperRecordReadingFailure,
  writePaperSourceMetadataForRecord,
  writePaperRecord
} from "../../src/agent/paper/storage/paper-store.js";
import { resolvePaperLibraryPaths } from "../../src/agent/knowledge-base.js";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

function stripRecordManifest(record: Record<string, unknown>): Record<string, unknown> {
  const {
    updatedAt: _updatedAt,
    download: _download,
    parse: _parse,
    webpage: _webpage,
    reading: _reading,
    ...legacyRecord
  } = record;
  return legacyRecord;
}

const supportedSearchSource = {
  source: "science",
  canonicalId: "10.1126/science.adz8659",
  articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
  pdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
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
  downloadPath: "knowledge-base/raw/pdfs/external.pdf",
  recordedAt: "2026-04-23T14:00:00.000Z",
  handlingMethod: "system_browser_open",
  status: "external_opened"
  // @ts-expect-error external-opened records must not carry download metadata
} satisfies PaperRecord;

const externalDownloadedPaperRecord = {
  source: "external",
  articleUrl: "https://example.com/paper",
  openedUrl: "https://example.com/paper",
  recordedAt: "2026-04-25T10:00:00.000Z",
  handlingMethod: "manual_file_import",
  status: "downloaded",
  downloadPath: "knowledge-base/raw/pdfs/external-example.com-123456789abc.pdf",
  fileSha256: "abc123",
  title: "External Paper"
} satisfies PaperRecord;

const manualFallbackResult = {
  status: "manual_fallback_opened",
  source: "science",
  canonicalId: "10.1126/science.adz8659",
  articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
  fallbackUrl: "https://www.science.org/doi/10.1126/science.adz8659",
  recordPath: "knowledge-base/wiki/sources/science-10.1126-science.adz8659/acquisition.json",
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
      path.join(workspaceDir, "knowledge-base", "raw", "pdfs", "arxiv-2401.01234.pdf")
    );

    assert.equal(
      resolvePaperPdfPath({
        workspaceDir,
        source: "science",
        canonicalId: "10.1126/science.adz8659"
      }),
      path.join(workspaceDir, "knowledge-base", "raw", "pdfs", "science-10.1126-science.adz8659.pdf")
    );

    assert.equal(
      resolvePaperPdfPath({
        workspaceDir,
        source: "nature",
        canonicalId: "s41586-019-1666-5"
      }),
      path.join(workspaceDir, "knowledge-base", "raw", "pdfs", "nature-s41586-019-1666-5.pdf")
    );

    assert.equal(
      resolvePaperPdfPath({
        workspaceDir,
        source: "aps",
        canonicalId: "10.1103/PhysRevLett.133.123456"
      }),
      path.join(
        workspaceDir,
        "knowledge-base",
        "raw",
        "pdfs",
        "aps-10.1103-PhysRevLett.133.123456.pdf"
      )
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("knowledge base paths can be moved outside the code workspace", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), "knowledge-base-external-"));
  const previousLibraryDir = process.env.PI_KNOWLEDGE_BASE_DIR;

  try {
    process.env.PI_KNOWLEDGE_BASE_DIR = libraryDir;
    const paths = resolvePaperLibraryPaths(workspaceDir);

    assert.equal(paths.libraryRoot, libraryDir);
    assert.equal(
      resolvePaperPdfPath({
        workspaceDir,
        source: "arxiv",
        canonicalId: "2401.01234"
      }),
      path.join(libraryDir, "raw", "pdfs", "arxiv-2401.01234.pdf")
    );
    assert.equal(
      resolvePaperRecordPath({
        workspaceDir,
        source: "arxiv",
        canonicalId: "2401.01234",
        articleUrl: "https://arxiv.org/abs/2401.01234"
      }),
      path.join(libraryDir, "wiki", "sources", "arxiv-2401.01234", "acquisition.json")
    );
  } finally {
    if (previousLibraryDir === undefined) {
      delete process.env.PI_KNOWLEDGE_BASE_DIR;
    } else {
      process.env.PI_KNOWLEDGE_BASE_DIR = previousLibraryDir;
    }
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(libraryDir, { recursive: true, force: true });
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
      path.join(workspaceDir, "knowledge-base", "wiki", "sources", "science-10.1126-science.adz8659", "acquisition.json")
    );

    const externalRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "external",
      articleUrl: "https://example.com/paper"
    });

    assert.equal(
      externalRecordPath.startsWith(path.join(workspaceDir, "knowledge-base", "wiki", "sources")),
      true
    );
    assert.equal(path.basename(path.dirname(externalRecordPath)).startsWith("external-example.com-"), true);
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

test("writePaperRecord persists external_opened records under the source acquisition file", async () => {
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

    assert.equal(recordPath.startsWith(path.join(workspaceDir, "knowledge-base", "wiki", "sources")), true);
    assert.equal(path.basename(path.dirname(recordPath)).startsWith("external-example.com-"), true);
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
      path.join(workspaceDir, "knowledge-base", "wiki", "sources", "science-10.1126-science.adz8659", "acquisition.json")
    );
    assert.match(saved, /\n  "failure": \{\n    "code": "PAYWALL",\n    "message": "Browser session required\."\n  \},\n/);
    const savedRecord = JSON.parse(saved);
    assert.deepEqual(stripRecordManifest(savedRecord), manualFallbackPaperRecord);
    assert.equal(savedRecord.download.status, "manual_fallback_opened");
    assert.equal(savedRecord.reading.status, "not_ready");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("writePaperRecord merges citation metadata into source.json next to acquisition state", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));

  try {
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "science",
        canonicalId: "10.1126/science.adz8659",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        openedUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        recordedAt: "2026-04-23T14:00:00.000Z",
        handlingMethod: "browser_session",
        status: "manual_fallback_opened",
        title: "A Science Paper",
        failure: {
          code: "PAYWALL",
          message: "Browser session required."
        }
      }
    });
    const sourcePath = resolvePaperSourcePath({
      workspaceDir,
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659"
    });
    const source = JSON.parse(await readFile(sourcePath, "utf8"));

    assert.equal(sourcePath, path.join(path.dirname(recordPath), "source.json"));
    assert.equal(source.schemaVersion, 2);
    assert.equal(source.paperKey, "science-10.1126-science.adz8659");
    assert.equal(source.source, "science");
    assert.equal(source.title, "A Science Paper");
    assert.equal(source.doi, "10.1126/science.adz8659");
    assert.equal(source.publisher, "American Association for the Advancement of Science");
    assert.equal(source.downloadStatus, "manual_fallback_opened");
    assert.equal(source.citationStatus, "incomplete");
    assert.deepEqual(source.missingFields, ["authors", "year", "venue"]);
    assert.equal(source.acquisitionPath, "knowledge-base/wiki/sources/science-10.1126-science.adz8659/acquisition.json");
    assert.equal(source.recordPath, "knowledge-base/wiki/sources/science-10.1126-science.adz8659/acquisition.json");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("paper source metadata derives arXiv ids and preserves manually enriched fields on record updates", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "arxiv",
    canonicalId: "2401.01234"
  });

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\npaper\n", "utf8");
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "arxiv",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "direct_http",
        status: "downloaded",
        canonicalId: "2401.01234",
        pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
        downloadPath: pdfPath
      }
    });
    const sourcePath = path.join(path.dirname(recordPath), "source.json");
    const initial = JSON.parse(await readFile(sourcePath, "utf8"));
    assert.equal(initial.arxivId, "2401.01234");
    assert.equal(initial.year, 2024);
    assert.equal(initial.venue, "arXiv");
    assert.deepEqual(initial.missingFields, ["title", "authors"]);

    await writeFile(sourcePath, `${JSON.stringify({
      ...initial,
      title: "Preserved Title",
      authors: ["Ada Lovelace"],
      venue: "arXiv"
    }, null, 2)}\n`, "utf8");

    await updatePaperRecordQueuedReading({
      workspaceDir,
      recordPath,
      strategy: "webpage",
      message: "Queued webpage parse.",
      updatedAt: "2026-04-25T10:01:00.000Z"
    });
    const updated = JSON.parse(await readFile(sourcePath, "utf8"));
    assert.equal(updated.title, "Preserved Title");
    assert.deepEqual(updated.authors, ["Ada Lovelace"]);
    assert.equal(updated.venue, "arXiv");
    assert.equal(updated.readingStatus, "queued");
    assert.equal(updated.citationStatus, "complete");
    assert.deepEqual(updated.missingFields, []);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("writePaperSourceMetadataForRecord falls back to Crossref bibliographic search for APS citation metadata", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));

  try {
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "aps",
        canonicalId: "10.1103/1rbn-c4xf",
        articleUrl: "https://journals.aps.org/prapplied/abstract/10.1103/1rbn-c4xf",
        recordedAt: "2026-05-07T14:41:39.609Z",
        handlingMethod: "arxiv_preprint_fallback",
        status: "preprint_fallback",
        title: "Energy-participation-ratio analysis for very anharmonic superconducting circuits",
        preprint: {
          source: "arxiv",
          canonicalId: "2411.15039",
          articleUrl: "https://arxiv.org/abs/2411.15039",
          pdfUrl: "https://arxiv.org/pdf/2411.15039",
          recordPath: path.join(workspaceDir, "knowledge-base/wiki/sources/arxiv-2411.15039/acquisition.json"),
          downloadPath: path.join(workspaceDir, "knowledge-base/raw/pdfs/arxiv-2411.15039.pdf"),
          status: "downloaded"
        },
        failure: {
          code: "publisher_version_not_available",
          message: "Using matching arXiv preprint."
        }
      }
    });

    const sourcePath = await writePaperSourceMetadataForRecord({
      workspaceDir,
      record: JSON.parse(await readFile(recordPath, "utf8")),
      recordPath,
      enrichCitationMetadata: true,
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/works/10.1103%2F1rbn-c4xf") {
          return new Response("missing", { status: 404 });
        }
        assert.equal(url.pathname, "/works");
        assert.equal(url.searchParams.get("query.bibliographic"), "10.1103/1rbn-c4xf");
        return new Response(JSON.stringify({
          message: {
            items: [
              {
                DOI: "10.1103/1rbn-c4xf",
                title: ["Energy-participation-ratio analysis for very anharmonic superconducting circuits"],
                author: [
                  { given: "Figen", family: "Yilmaz" },
                  { given: "Siddharth", family: "Singh" },
                  { given: "Martijn F.S.", family: "Zwanenburg" },
                  { given: "Jinlun", family: "Hu" },
                  { given: "Taryn V.", family: "Stefanski" },
                  { given: "Christian Kraglund", family: "Andersen" }
                ],
                published: { "date-parts": [[2026, 4, 1]] },
                "container-title": ["Physical Review Applied"]
              }
            ]
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    assert.deepEqual(source.authors, [
      "Figen Yilmaz",
      "Siddharth Singh",
      "Martijn F.S. Zwanenburg",
      "Jinlun Hu",
      "Taryn V. Stefanski",
      "Christian Kraglund Andersen"
    ]);
    assert.equal(source.year, 2026);
    assert.equal(source.venue, "Physical Review Applied");
    assert.equal(source.citationStatus, "complete");
    assert.deepEqual(source.missingFields, []);
    assert.equal(source.resolvedFrom, "crossref_search");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("updatePaperRecordParseManifest records ready markdown artifacts in the paper record", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "arxiv",
    canonicalId: "2401.01234"
  });

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\npaper\n", "utf8");
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "arxiv",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "direct_http",
        status: "downloaded",
        canonicalId: "2401.01234",
        pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
        downloadPath: pdfPath
      }
    });

    await updatePaperRecordParseManifest({
      workspaceDir,
      recordPath,
      strategy: "webpage",
      status: "parsed",
      paperKey: "arxiv-2401.01234",
      engine: "webpage",
      sourceSha256: "webpage-hash",
      artifacts: {
        markdownPath: path.join(workspaceDir, "knowledge-base/wiki/sources/arxiv-2401.01234/parses/webpage/document.md"),
        parsePath: path.join(workspaceDir, "knowledge-base/wiki/sources/arxiv-2401.01234/parses/webpage/parse.json"),
        qualityPath: path.join(workspaceDir, "knowledge-base/wiki/sources/arxiv-2401.01234/parses/webpage/quality.json"),
        chunksPath: path.join(workspaceDir, "knowledge-base/wiki/sources/arxiv-2401.01234/chunks/webpage.jsonl")
      },
      quality: {
        status: "good",
        score: 1,
        pages: 1,
        totalTextLength: 1200,
        warnings: []
      },
      updatedAt: "2026-04-25T10:01:00.000Z"
    });

    const saved = await readPaperRecordByPath({ workspaceDir, recordPath });
    assert.equal(saved?.record.webpage?.status, "parsed");
    assert.equal(saved?.record.webpage?.markdownPath, "knowledge-base/wiki/sources/arxiv-2401.01234/parses/webpage/document.md");
    assert.equal(saved?.record.reading?.status, "ready");
    assert.equal(saved?.record.reading?.preferredSource, "webpage");
    assert.equal(saved?.record.reading?.markdownPath, "knowledge-base/wiki/sources/arxiv-2401.01234/parses/webpage/document.md");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("updatePaperRecordParseManifest backfills citation metadata from local parse artifacts", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "aps",
    canonicalId: "10.1103/PhysRevA.111.012619"
  });
  const parsePath = path.join(
    workspaceDir,
    "knowledge-base/wiki/sources/aps-10.1103-PhysRevA.111.012619/parses/webpage/parse.json"
  );

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await mkdir(path.dirname(parsePath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\npaper\n", "utf8");
    await writeFile(parsePath, `${JSON.stringify({
      paperKey: "aps-10.1103-PhysRevA.111.012619",
      engine: "webpage",
      pdfSha256: "webpage-hash",
      createdAt: "2026-04-25T10:01:00.000Z",
      title: "Efficient frequency allocation for superconducting quantum processors using improved optimization techniques",
      pages: 1,
      elements: [
        {
          id: "webpage-00001",
          type: "heading",
          text: "Efficient frequency allocation for superconducting quantum processors using improved optimization techniques",
          page: 1,
          headingLevel: 1
        },
        {
          id: "webpage-00002",
          type: "paragraph",
          text: "Zewen Zhang ^1,2, Pranav Gokhale ^3, and Jeffrey M. Larson ^1",
          page: 1
        },
        {
          id: "webpage-00003",
          type: "paragraph",
          text: "Phys. Rev. A 111, 012619 - Published 17 January, 2025",
          page: 1
        },
        {
          id: "webpage-00004",
          type: "paragraph",
          text: "https://doi.org/10.1103/PhysRevA.111.012619",
          page: 1
        }
      ],
      sections: []
    }, null, 2)}\n`, "utf8");
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "aps",
        articleUrl: "https://link.aps.org/doi/10.1103/PhysRevA.111.012619",
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: "10.1103/PhysRevA.111.012619",
        pdfUrl: "https://journals.aps.org/pra/pdf/10.1103/PhysRevA.111.012619",
        downloadPath: pdfPath
      }
    });

    await updatePaperRecordParseManifest({
      workspaceDir,
      recordPath,
      strategy: "webpage",
      status: "parsed",
      paperKey: "aps-10.1103-PhysRevA.111.012619",
      engine: "webpage",
      sourceSha256: "webpage-hash",
      artifacts: {
        markdownPath: path.join(workspaceDir, "knowledge-base/wiki/sources/aps-10.1103-PhysRevA.111.012619/parses/webpage/document.md"),
        parsePath,
        qualityPath: path.join(workspaceDir, "knowledge-base/wiki/sources/aps-10.1103-PhysRevA.111.012619/parses/webpage/quality.json"),
        chunksPath: path.join(workspaceDir, "knowledge-base/wiki/sources/aps-10.1103-PhysRevA.111.012619/chunks/webpage.jsonl")
      },
      quality: {
        status: "good",
        score: 1,
        pages: 1,
        totalTextLength: 1200,
        warnings: []
      },
      updatedAt: "2026-04-25T10:01:00.000Z"
    });

    const sourcePath = path.join(path.dirname(recordPath), "source.json");
    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    assert.deepEqual(source.authors, ["Zewen Zhang", "Pranav Gokhale", "Jeffrey M. Larson"]);
    assert.equal(source.year, 2025);
    assert.equal(source.venue, "Phys. Rev. A");
    assert.equal(source.citationStatus, "complete");
    assert.deepEqual(source.missingFields, []);
    assert.equal(source.resolvedFrom, "local_parse");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("updatePaperRecordReadingFailure preserves an existing ready webpage reading source", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "nature",
    canonicalId: "s41567-025-03102-5"
  });

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\npaper\n", "utf8");
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "nature",
        articleUrl: "https://www.nature.com/articles/s41567-025-03102-5",
        recordedAt: "2026-05-06T02:51:32.000Z",
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: "s41567-025-03102-5",
        pdfUrl: "https://www.nature.com/articles/s41567-025-03102-5.pdf",
        downloadPath: pdfPath
      }
    });

    await updatePaperRecordParseManifest({
      workspaceDir,
      recordPath,
      strategy: "webpage",
      status: "parsed",
      paperKey: "nature-s41567-025-03102-5",
      engine: "webpage",
      sourceSha256: "webpage-hash",
      artifacts: {
        markdownPath: path.join(workspaceDir, "knowledge-base/wiki/sources/nature-s41567-025-03102-5/parses/webpage/document.md"),
        parsePath: path.join(workspaceDir, "knowledge-base/wiki/sources/nature-s41567-025-03102-5/parses/webpage/parse.json"),
        qualityPath: path.join(workspaceDir, "knowledge-base/wiki/sources/nature-s41567-025-03102-5/parses/webpage/quality.json"),
        chunksPath: path.join(workspaceDir, "knowledge-base/wiki/sources/nature-s41567-025-03102-5/chunks/webpage.jsonl")
      },
      quality: {
        status: "good",
        score: 1,
        pages: 1,
        totalTextLength: 1200,
        warnings: []
      },
      updatedAt: "2026-05-06T02:51:33.000Z"
    });

    await updatePaperRecordReadingFailure({
      workspaceDir,
      recordPath,
      strategy: "pdf_parse",
      message: "Requested path is outside the workspace or knowledge base.",
      updatedAt: "2026-05-06T02:51:40.000Z"
    });

    const saved = await readPaperRecordByPath({ workspaceDir, recordPath });
    assert.equal(saved?.record.parse?.status, "failed");
    assert.equal(saved?.record.reading?.status, "ready");
    assert.equal(saved?.record.reading?.preferredSource, "webpage");
    assert.equal(saved?.record.reading?.paperKey, "nature-s41567-025-03102-5");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("resolveExternalPaperPdfPath uses the same URL key as external records", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));

  try {
    const articleUrl = "https://example.com/paper";
    assert.equal(
      path.basename(resolveExternalPaperPdfPath({ workspaceDir, articleUrl })).replace(/\.pdf$/, ".json"),
      `${path.basename(path.dirname(resolvePaperRecordPath({ workspaceDir, source: "external", articleUrl })))}.json`
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("findDownloadedPaperRecord returns downloaded records only when the PDF still exists", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "arxiv",
    canonicalId: "2401.01234"
  });

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.4\nmock pdf\n", "utf8");
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "arxiv",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "direct_http",
        status: "downloaded",
        canonicalId: "2401.01234",
        pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
        downloadPath: pdfPath
      }
    });

    assert.deepEqual(
      await findDownloadedPaperRecord({
        workspaceDir,
        source: "arxiv",
        canonicalId: "2401.01234",
        articleUrl: "https://arxiv.org/abs/2401.01234"
      }),
      {
        record: {
          source: "arxiv",
          articleUrl: "https://arxiv.org/abs/2401.01234",
          recordedAt: "2026-04-25T10:00:00.000Z",
          handlingMethod: "direct_http",
          status: "downloaded",
          canonicalId: "2401.01234",
          pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
          downloadPath: pdfPath
        },
        recordPath,
        downloadPath: pdfPath
      }
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("findDownloadedPaperRecord resolves WSL UNC paths and reuses supported records by canonical id", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));
  const articleUrl = "https://journals.aps.org/prapplied/abstract/10.1103/4ssz-6ctb";
  const requestedPdfUrl = "https://journals.aps.org/prapplied/pdf/10.1103/4ssz-6ctb";
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "aps",
    canonicalId: "10.1103/4ssz-6ctb"
  });
  const uncDownloadPath = `\\\\wsl.localhost\\Ubuntu-24.04${pdfPath.replace(/\//g, "\\")}`;

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\naps pdf\n", "utf8");
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "aps",
        articleUrl,
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: "10.1103/4ssz-6ctb",
        pdfUrl: requestedPdfUrl,
        downloadPath: uncDownloadPath
      }
    });
    const savedRecord = JSON.parse(await readFile(recordPath, "utf8")) as PaperRecord;
    assert.equal(
      savedRecord.download?.pdfPath,
      path.join("knowledge-base", "raw", "pdfs", "aps-10.1103-4ssz-6ctb.pdf")
    );

    assert.deepEqual(
      await findDownloadedPaperRecord({
        workspaceDir,
        source: "aps",
        canonicalId: "10.1103/4ssz-6ctb",
        articleUrl: requestedPdfUrl
      }),
      {
        record: {
          source: "aps",
          articleUrl,
          recordedAt: "2026-04-25T10:00:00.000Z",
          handlingMethod: "browser_session",
          status: "downloaded",
          canonicalId: "10.1103/4ssz-6ctb",
          pdfUrl: requestedPdfUrl,
          downloadPath: uncDownloadPath
        },
        recordPath,
        downloadPath: pdfPath
      }
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("findDownloadedPaperRecord ignores manual fallback records and missing PDFs", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));
  const missingPdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "science",
    canonicalId: "10.1126/science.adz8659"
  });

  try {
    await writePaperRecord({
      workspaceDir,
      record: manualFallbackPaperRecord
    });

    assert.equal(
      await findDownloadedPaperRecord({
        workspaceDir,
        source: "science",
        canonicalId: "10.1126/science.adz8659",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659"
      }),
      null
    );

    await writePaperRecord({
      workspaceDir,
      record: {
        source: "science",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: "10.1126/science.adz8659",
        pdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
        downloadPath: missingPdfPath
      }
    });

    assert.equal(
      await findDownloadedPaperRecord({
        workspaceDir,
        source: "science",
        canonicalId: "10.1126/science.adz8659",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659"
      }),
      null
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("findDownloadedPaperRecord ignores Science supplement records for main article downloads", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "science",
    canonicalId: "10.1126/science.adz8659"
  });

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\nsupplement pdf\n", "utf8");
    await writePaperRecord({
      workspaceDir,
      record: {
        source: "science",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: "10.1126/science.adz8659",
        pdfUrl:
          "https://www.science.org/doi/suppl/10.1126/science.adz8659/suppl_file/science.adz8659_sm.pdf",
        downloadPath: pdfPath
      }
    });

    assert.equal(
      await findDownloadedPaperRecord({
        workspaceDir,
        source: "science",
        canonicalId: "10.1126/science.adz8659",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659"
      }),
      null
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("findDownloadedPaperRecord returns imported external PDF records by article URL", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-store-"));
  const articleUrl = "https://example.com/paper";
  const pdfPath = resolveExternalPaperPdfPath({ workspaceDir, articleUrl });

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.4\nexternal pdf\n", "utf8");
    const recordPath = await writePaperRecord({
      workspaceDir,
      record: {
        source: "external",
        articleUrl,
        openedUrl: articleUrl,
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "manual_file_import",
        status: "downloaded",
        downloadPath: pdfPath,
        fileSha256: "abc123",
        title: "External Paper"
      }
    });

    assert.deepEqual(
      await findDownloadedPaperRecord({
        workspaceDir,
        source: "external",
        articleUrl
      }),
      {
        record: {
          source: "external",
          articleUrl,
          openedUrl: articleUrl,
          recordedAt: "2026-04-25T10:00:00.000Z",
          handlingMethod: "manual_file_import",
          status: "downloaded",
          downloadPath: pdfPath,
          fileSha256: "abc123",
          title: "External Paper"
        },
        recordPath,
        downloadPath: pdfPath
      }
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

void supportedSearchSource;
void externalSearchSource;
void invalidExternalSearchSource;
void invalidDownloadedPaperRecord;
void invalidExternalPaperRecord;
void externalDownloadedPaperRecord;
void invalidPrimarySearchResult;
void manualFallbackResult;
