import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  appendPaperDownloadJobEvent,
  readPaperDownloadJobEvents,
  resolvePaperDownloadJobsPath
} from "../../src/agent/paper/extension/paper-download-jobs.js";
import {
  encodeNativeMessage,
  handleExtensionHostMessage,
  readNativeMessagesFromBuffer,
  resolveDownloadPathCandidates,
  runPaperExtensionNativeHost,
  writeNativeHostManifest
} from "../../src/agent/paper/extension/paper-extension-host.js";
import {
  findDownloadedPaperRecord,
  resolveExternalPaperPdfPath,
  resolvePaperPdfPath,
  resolvePaperRecordPath,
  writePaperRecord
} from "../../src/agent/paper/storage/paper-store.js";
import type { ExtensionHostResponse } from "../../src/agent/paper/extension/paper-extension-protocol.js";

async function createWorkspaceDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "paper-extension-host-"));
}

async function writePdf(filePath: string, contents = "%PDF-1.7\nmock pdf\n%%EOF\n"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

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

function decodeFirstFrame(buffer: Buffer): unknown {
  const messages = readNativeMessagesFromBuffer(buffer);
  assert.equal(messages.length, 1);
  return messages[0];
}

function encodeNativeInput(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

function waitForNativeMessages(stdout: PassThrough, expectedCount: number): Promise<unknown[]> {
  let buffered = Buffer.alloc(0);

  return new Promise((resolve) => {
    stdout.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const messages = readNativeMessagesFromBuffer(buffered);
      if (messages.length >= expectedCount) {
        resolve(messages.slice(0, expectedCount));
      }
    });
  });
}

test("native message framing roundtrips complete frames and ignores trailing partial frames", () => {
  const response: ExtensionHostResponse = {
    type: "status_ack",
    jobId: "job-123",
    status: "downloaded"
  };

  const encoded = encodeNativeMessage(response);
  const partialNextFrame = Buffer.from([10, 0, 0, 0, 123]);

  assert.deepEqual(readNativeMessagesFromBuffer(Buffer.concat([encoded, partialNextFrame])), [
    response
  ]);
});

test("resolveDownloadPathCandidates maps Windows browser paths for WSL native hosts", () => {
  assert.deepEqual(resolveDownloadPathCandidates("C:\\Users\\alice\\Downloads\\paper.pdf"), [
    "C:\\Users\\alice\\Downloads\\paper.pdf",
    "/mnt/c/Users/alice/Downloads/paper.pdf"
  ]);
  assert.deepEqual(
    resolveDownloadPathCandidates(
      "\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo\\downloads\\inbox\\paper.pdf"
    ),
    [
      "\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo\\downloads\\inbox\\paper.pdf",
      "/home/alice/repo/downloads/inbox/paper.pdf"
    ]
  );
});

test("handleExtensionHostMessage registers external PDF downloads with manual import record shape", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://example.com/paper";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "manual.pdf");

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\nexternal pdf\n");
    await writePaperRecord({
      workspaceDir,
      record: {
        source: "external",
        articleUrl,
        openedUrl: `${articleUrl}?opened=1`,
        recordedAt: "2026-04-25T09:59:00.000Z",
        handlingMethod: "system_browser_open",
        status: "external_opened"
      }
    });

    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-04-25T10:00:00.000Z"),
      message: {
        type: "register_download",
        jobId: "job-external",
        articleUrl,
        source: "external",
        downloadPath: sourcePdfPath,
        title: " External Paper "
      }
    });

    const expectedDownloadPath = resolveExternalPaperPdfPath({ workspaceDir, articleUrl });
    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "external",
      articleUrl
    });
    const expectedSha256 = createHash("sha256")
      .update(Buffer.from("%PDF-1.7\nexternal pdf\n", "utf8"))
      .digest("hex");

    assert.deepEqual(response, {
      type: "registered",
      jobId: "job-external",
      articleUrl,
      downloadPath: expectedDownloadPath,
      recordPath: expectedRecordPath,
      fileSha256: expectedSha256,
      title: "External Paper"
    });
    assert.equal(await readFile(expectedDownloadPath, "utf8"), "%PDF-1.7\nexternal pdf\n");
    const savedRecord = JSON.parse(await readFile(expectedRecordPath, "utf8"));
    assert.deepEqual(stripRecordManifest(savedRecord), {
      source: "external",
      articleUrl,
      openedUrl: `${articleUrl}?opened=1`,
      recordedAt: "2026-04-25T10:00:00.000Z",
      handlingMethod: "manual_file_import",
      status: "downloaded",
      downloadPath: expectedDownloadPath,
      fileSha256: expectedSha256,
      title: "External Paper"
    });
    assert.equal(savedRecord.download.status, "downloaded");
    assert.equal(savedRecord.reading.status, "not_ready");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage registers supported publisher PDFs using canonical publisher records", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://www.nature.com/articles/s41586-024-08449-y";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "nature.pdf");

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\nnature pdf\n");

    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-04-25T10:30:00.000Z"),
      citationMetadataFetchImpl: async (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        assert.equal(url.hostname, "api.crossref.org");
        assert.equal(url.pathname, "/works/10.1038%2Fs41586-024-08449-y");
        return new Response(JSON.stringify({
          message: {
            DOI: "10.1038/s41586-024-08449-y",
            title: ["Quantum error correction below the surface code threshold"],
            author: [
              { given: "Google", family: "Quantum AI" },
              { given: "A.", family: "Researcher" }
            ],
            published: { "date-parts": [[2025, 1, 1]] },
            "container-title": ["Nature"]
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      },
      message: {
        type: "register_download",
        jobId: "job-nature",
        articleUrl,
        source: "nature",
        downloadPath: sourcePdfPath,
        title: "Nature Paper"
      }
    });

    const expectedDownloadPath = resolvePaperPdfPath({
      workspaceDir,
      source: "nature",
      canonicalId: "s41586-024-08449-y"
    });
    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "nature",
      canonicalId: "s41586-024-08449-y",
      articleUrl
    });
    const expectedSha256 = createHash("sha256")
      .update(Buffer.from("%PDF-1.7\nnature pdf\n", "utf8"))
      .digest("hex");

    assert.deepEqual(response, {
      type: "registered",
      jobId: "job-nature",
      articleUrl,
      downloadPath: expectedDownloadPath,
      recordPath: expectedRecordPath,
      fileSha256: expectedSha256,
      title: "Nature Paper"
    });
    const savedRecord = JSON.parse(await readFile(expectedRecordPath, "utf8"));
    assert.deepEqual(stripRecordManifest(savedRecord), {
      source: "nature",
      articleUrl,
      recordedAt: "2026-04-25T10:30:00.000Z",
      handlingMethod: "browser_session",
      status: "downloaded",
      canonicalId: "s41586-024-08449-y",
      pdfUrl: "https://www.nature.com/articles/s41586-024-08449-y.pdf",
      downloadPath: expectedDownloadPath
    });
    assert.equal(savedRecord.download.status, "downloaded");
    assert.equal(savedRecord.reading.status, "not_ready");
    const metadata = JSON.parse(await readFile(path.join(path.dirname(expectedRecordPath), "metadata.json"), "utf8"));
    assert.equal(metadata.title, "Quantum error correction below the surface code threshold");
    assert.deepEqual(metadata.citation.authors, ["Google Quantum AI", "A. Researcher"]);
    assert.equal(metadata.citation.year, 2025);
    assert.equal(metadata.citation.venue, "Nature");
    assert.equal(metadata.citation.citationStatus, "complete");
    assert.equal(metadata.status, "missing_artifact");
    assert.deepEqual(metadata.citation.missingFields, []);
    const events = await readPaperDownloadJobEvents({ workspaceDir });
    assert.equal(events.at(-1)?.status, "downloaded");
    assert.equal(events.at(-1)?.recordPath, expectedRecordPath);
    assert.equal(events.at(-1)?.fileSha256, expectedSha256);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage registers PDF bytes fetched by the extension background worker", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://www.nature.com/articles/s41586-019-1666-5";
  const pdfText = "%PDF-1.7\nnature bytes\n";

  try {
    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-04-25T10:31:00.000Z"),
      message: {
        type: "register_download_bytes",
        jobId: "job-nature-bytes",
        articleUrl,
        source: "nature",
        pdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf",
        pdfFileName: "nature-s41586-019-1666-5.pdf",
        pdfBase64: Buffer.from(pdfText, "utf8").toString("base64"),
        title: "Nature Paper"
      }
    });

    const expectedDownloadPath = resolvePaperPdfPath({
      workspaceDir,
      source: "nature",
      canonicalId: "s41586-019-1666-5"
    });
    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "nature",
      canonicalId: "s41586-019-1666-5",
      articleUrl
    });
    const expectedSha256 = createHash("sha256").update(Buffer.from(pdfText, "utf8")).digest("hex");

    assert.deepEqual(response, {
      type: "registered",
      jobId: "job-nature-bytes",
      articleUrl,
      downloadPath: expectedDownloadPath,
      recordPath: expectedRecordPath,
      fileSha256: expectedSha256,
      title: "Nature Paper"
    });
    assert.equal(await readFile(expectedDownloadPath, "utf8"), pdfText);
    const events = await readPaperDownloadJobEvents({ workspaceDir });
    assert.equal(events.at(-1)?.status, "downloaded");
    assert.equal(events.at(-1)?.downloadPath, expectedDownloadPath);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage restores prior webpage reading artifacts when PDF registration follows snapshot", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://www.nature.com/articles/s41567-025-03102-5";
  const paperKey = "nature-s41567-025-03102-5";
  const sourceRoot = path.join(workspaceDir, "knowledge-base", "sources", paperKey);
  const markdownPath = path.join(sourceRoot, "parses", "webpage", "document.md");
  const parsePath = path.join(sourceRoot, "parses", "webpage", "parse.json");
  const qualityPath = path.join(sourceRoot, "parses", "webpage", "quality.json");
  const chunksPath = path.join(sourceRoot, "chunks", "webpage.jsonl");
  const pdfText = "%PDF-1.7\nshort pdf\n";

  try {
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await mkdir(path.dirname(chunksPath), { recursive: true });
    await writeFile(markdownPath, "# Nature webpage\n\nParsed body.", "utf8");
    await writeFile(
      parsePath,
      JSON.stringify({
        paperKey,
        engine: "webpage",
        pdfSha256: "webpage-sha",
        pages: 1,
        elements: []
      }),
      "utf8"
    );
    await writeFile(
      qualityPath,
      JSON.stringify({
        status: "good",
        score: 1,
        pages: 1,
        totalTextLength: 1200,
        warnings: []
      }),
      "utf8"
    );
    await writeFile(chunksPath, "", "utf8");
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "job-nature-webpage-then-pdf",
        recordedAt: "2026-05-06T02:51:32.000Z",
        status: "webpage_snapshot_ready",
        articleUrl,
        source: "nature",
        purpose: "webpage",
        paperKey,
        markdownPath,
        parsePath,
        qualityPath,
        chunksPath
      }
    });

    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-05-06T02:51:40.000Z"),
      message: {
        type: "register_download_bytes",
        jobId: "job-nature-webpage-then-pdf",
        articleUrl,
        source: "nature",
        pdfUrl: `${articleUrl}.pdf`,
        pdfBase64: Buffer.from(pdfText, "utf8").toString("base64")
      }
    });

    assert.equal(response.type, "registered");
    const recordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "nature",
      canonicalId: "s41567-025-03102-5",
      articleUrl
    });
    const savedRecord = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(savedRecord.webpage.status, "parsed");
    assert.equal(savedRecord.webpage.paperKey, paperKey);
    assert.equal(savedRecord.reading.status, "ready");
    assert.equal(savedRecord.reading.preferredSource, "webpage");
    assert.equal(savedRecord.reading.paperKey, paperKey);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage replaces compatible publisher fallback records with derived PDF URLs", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://www.nature.com/articles/s41586-019-1666-5";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "nature.pdf");

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\nnature pdf\n");
    await writePaperRecord({
      workspaceDir,
      record: {
        source: "nature",
        articleUrl,
        openedUrl: `${articleUrl}?manual=1`,
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "browser_session",
        status: "manual_fallback_opened",
        canonicalId: "s41586-019-1666-5",
        failure: {
          code: "pdf_not_found",
          message: "No PDF link was found."
        }
      }
    });

    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-04-25T10:30:00.000Z"),
      message: {
        type: "register_download",
        jobId: "job-compatible-fallback",
        articleUrl,
        source: "nature",
        downloadPath: sourcePdfPath
      }
    });

    assert.equal(response.type, "registered");
    const match = await findDownloadedPaperRecord({
      workspaceDir,
      source: "nature",
      canonicalId: "s41586-019-1666-5",
      articleUrl
    });

    assert.equal(match?.record.status, "downloaded");
    assert.equal(match?.record.pdfUrl, "https://www.nature.com/articles/s41586-019-1666-5.pdf");
    assert.equal(match?.record.downloadPath, response.downloadPath);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage derives Science direct PDF download URLs", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://www.science.org/doi/10.1126/sciadv.adp6388";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "science-advances.pdf");

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\nscience advances pdf\n");

    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-05-06T10:30:00.000Z"),
      message: {
        type: "register_download",
        jobId: "job-science-advances-manual",
        articleUrl,
        source: "science",
        downloadPath: sourcePdfPath
      }
    });

    assert.equal(response.type, "registered");
    const match = await findDownloadedPaperRecord({
      workspaceDir,
      source: "science",
      canonicalId: "10.1126/sciadv.adp6388",
      articleUrl
    });

    assert.equal(match?.record.status, "downloaded");
    assert.equal(
      match?.record.pdfUrl,
      "https://www.science.org/doi/pdf/10.1126/sciadv.adp6388?download=true"
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage reuses compatible downloaded publisher PDF URLs when the message omits one", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "science.pdf");
  const existingPdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "science",
    canonicalId: "10.1126/science.adz8659"
  });

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\nscience replacement pdf\n");
    await writePdf(existingPdfPath, "%PDF-1.7\nscience old pdf\n");
    await writePaperRecord({
      workspaceDir,
      record: {
        source: "science",
        articleUrl,
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: "10.1126/science.adz8659",
        pdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
        downloadPath: existingPdfPath
      }
    });

    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-04-25T10:30:00.000Z"),
      message: {
        type: "register_download",
        jobId: "job-compatible-downloaded",
        articleUrl,
        source: "science",
        downloadPath: sourcePdfPath
      }
    });

    assert.equal(response.type, "registered");
    const recordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl
    });
    assert.equal(
      JSON.parse(await readFile(recordPath, "utf8")).pdfUrl,
      "https://www.science.org/doi/epdf/10.1126/science.adz8659"
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage rejects Science supplementary material PDFs", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "science.adz8659_sm.pdf");

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\nscience supplement pdf\n");

    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-04-25T10:30:00.000Z"),
      message: {
        type: "register_download",
        jobId: "job-science-sm",
        articleUrl,
        source: "science",
        downloadPath: sourcePdfPath,
        pdfUrl:
          "https://www.science.org/doi/suppl/10.1126/science.adz8659/suppl_file/science.adz8659_sm.pdf"
      }
    });

    assert.equal(response.type, "error");
    assert.equal(response.code, "supplement_not_article");
    assert.equal(
      await findDownloadedPaperRecord({
        workspaceDir,
        source: "science",
        canonicalId: "10.1126/science.adz8659",
        articleUrl
      }),
      null
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage registers APS supplemental material on the publisher record", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502";
  const materialUrl = "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf";
  const expectedSupplementalPath = path.join(
    workspaceDir,
    "knowledge-base",
    "raw",
    "pdfs",
    "aps-10.1103-PhysRevLett.111.080502-supplemental-SM.pdf"
  );

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
    assert.equal(response.path, expectedSupplementalPath);

    const recordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "aps",
      canonicalId: "10.1103/PhysRevLett.111.080502",
      articleUrl
    });
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(record.status, "publisher_pending");
    assert.equal(record.supplementalMaterials[0].url, materialUrl);
    assert.equal(record.supplementalMaterials[0].path, response.path);
    assert.equal(await readFile(response.path, "utf8"), "%PDF-1.7\nsupplement pdf\n");

    const events = await readPaperDownloadJobEvents({ workspaceDir });
    assert.equal(events.at(-1)?.status, "supplemental_material_downloaded");
    assert.equal(events.at(-1)?.downloadPath, response.path);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage completes legacy Nature metadata after supplemental material is registered first", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://www.nature.com/articles/nature14270";
  const paperKey = "nature-nature14270";
  const jobId = "job-nature-legacy";
  const sourceDir = path.join(workspaceDir, "knowledge-base", "sources", paperKey);
  const parseDir = path.join(sourceDir, "parses", "webpage");
  const chunksPath = path.join(sourceDir, "chunks", "webpage.jsonl");
  const parsePath = path.join(parseDir, "parse.json");
  const qualityPath = path.join(parseDir, "quality.json");
  const markdownPath = path.join(parseDir, "document.md");
  const fetchedUrls: string[] = [];

  try {
    await mkdir(path.dirname(chunksPath), { recursive: true });
    await mkdir(parseDir, { recursive: true });
    await writeFile(markdownPath, "# State preservation by repetitive error detection\n", "utf8");
    await writeFile(chunksPath, "", "utf8");
    await writeFile(
      parsePath,
      `${JSON.stringify({
        paperKey,
        engine: "webpage",
        pdfSha256: "webpage",
        title: "State preservation by repetitive error detection in a superconducting quantum circuit",
        pages: 1,
        elements: [
          {
            id: "webpage-00001",
            type: "paragraph",
            text: "State preservation by repetitive error detection in a superconducting quantum circuit",
            page: 1
          }
        ]
      }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      qualityPath,
      `${JSON.stringify({
        status: "good",
        score: 1,
        pages: 1,
        totalTextLength: 12000,
        warnings: []
      }, null, 2)}\n`,
      "utf8"
    );
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId,
        recordedAt: "2026-05-26T17:09:59.192Z",
        status: "webpage_snapshot_ready",
        articleUrl,
        source: "nature",
        paperKey,
        markdownPath,
        parsePath,
        qualityPath,
        chunksPath
      }
    });

    const supplementalResponse = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-05-26T17:10:08.552Z"),
      message: {
        type: "register_supplemental_material",
        jobId,
        articleUrl,
        source: "nature",
        materialUrl: "https://www.nature.com/articles/nature14270.pdf",
        materialBase64: Buffer.from("%PDF-1.7\nsupplement pdf\n").toString("base64"),
        filename: "nature14270.pdf",
        mimeType: "application/pdf",
        title: "Download PDF"
      }
    });
    assert.equal(supplementalResponse.type, "supplemental_registered");

    const metadataPath = path.join(sourceDir, "metadata.json");
    const staleMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(
      metadataPath,
      `${JSON.stringify({
        ...staleMetadata,
        title: "Zertifikatswortschatz Italienisch",
        status: "citation_incomplete",
        summaryPath: path.join(sourceDir, "summary.md"),
        citation: {
          ...staleMetadata.citation,
          citationStatus: "incomplete",
          missingFields: ["venue"],
          authors: ["Oliver Sparisci"],
          doi: "10.37307/b.978-3-19-895321-1",
          year: 2011
        },
        provenance: {
          ...staleMetadata.provenance,
          doi: "10.37307/b.978-3-19-895321-1",
          recordPath: path.join(sourceDir, "acquisition.json"),
          acquisitionPath: path.join(sourceDir, "acquisition.json")
        },
        artifacts: staleMetadata.artifacts.map((artifact: { path: string }) => ({
          ...artifact,
          path: path.join(workspaceDir, artifact.path)
        }))
      }, null, 2)}\n`,
      "utf8"
    );

    const response = await handleExtensionHostMessage({
      workspaceDir,
      citationMetadataFetchImpl: async (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        fetchedUrls.push(url.toString());
        if (url.pathname === "/works/10.1038%2Fnature14270") {
          return new Response(JSON.stringify({
            message: {
              DOI: "10.1038/nature14270",
              title: ["State preservation by repetitive error detection in a superconducting quantum circuit"],
              author: [
                { given: "J.", family: "Kelly" },
                { given: "R.", family: "Barends" }
              ],
              published: { "date-parts": [[2015, 3, 4]] },
              "container-title": ["Nature"]
            }
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(JSON.stringify({
          message: {
            items: [{
              DOI: "10.37307/b.978-3-19-895321-1",
              title: ["Zertifikatswortschatz Italienisch"],
              author: [{ given: "Oliver", family: "Sparisci" }],
              published: { "date-parts": [[2011]] },
              publisher: "Springer Nature"
            }]
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      },
      now: () => new Date("2026-05-26T17:10:14.196Z"),
      message: {
        type: "register_download_bytes",
        jobId,
        articleUrl,
        source: "nature",
        pdfUrl: "https://www.nature.com/articles/nature14270.pdf",
        pdfBase64: Buffer.from("%PDF-1.7\nmain pdf\n").toString("base64")
      }
    });

    assert.equal(response.type, "registered");
    assert.deepEqual(fetchedUrls, ["https://api.crossref.org/works/10.1038%2Fnature14270"]);

    const recordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "nature",
      canonicalId: "nature14270",
      articleUrl
    });
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(record.reading.status, "ready");
    assert.equal(record.reading.preferredSource, "webpage");
    assert.equal(record.webpage.markdownPath, `knowledge-base/sources/${paperKey}/parses/webpage/document.md`);

    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.equal(metadata.title, "State preservation by repetitive error detection in a superconducting quantum circuit");
    assert.deepEqual(metadata.citation.authors, ["J. Kelly", "R. Barends"]);
    assert.equal(metadata.citation.year, 2015);
    assert.equal(metadata.citation.venue, "Nature");
    assert.equal(metadata.citation.doi, "10.1038/nature14270");
    assert.equal(metadata.citation.citationStatus, "complete");
    assert.deepEqual(metadata.citation.missingFields, []);
    assert.equal(metadata.status, "ready");
    assert.equal(metadata.summaryPath, `knowledge-base/sources/${paperKey}/summary.md`);
    assert.equal(metadata.provenance.acquisitionPath, `knowledge-base/sources/${paperKey}/acquisition.json`);
    assert.equal("recordPath" in metadata.provenance, false);
    assert.equal("rawPath" in metadata.provenance, false);
    assert.ok(metadata.artifacts.every((artifact: { path: string }) =>
      !path.isAbsolute(artifact.path) && !artifact.path.startsWith("\\\\")
    ));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage rejects supplemental webpage snapshots as standalone sources", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502";
  const supplementalUrl = "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502";

  try {
    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-05-26T10:35:00.000Z"),
      message: {
        type: "register_webpage_snapshot",
        jobId: "job-aps-supplement-webpage",
        articleUrl,
        finalUrl: supplementalUrl,
        source: "aps",
        html: "<html><head><title>Supplemental Material</title></head><body>Supplemental PDF listing</body></html>",
        title: "Supplemental Material"
      }
    });

    assert.equal(response.type, "error");
    assert.equal(response.code, "supplemental_webpage_snapshot_unsupported");
    assert.equal(
      await findDownloadedPaperRecord({
        workspaceDir,
        source: "aps",
        canonicalId: "10.1103/PhysRevLett.111.080502",
        articleUrl
      }),
      null
    );
    await assert.rejects(
      readFile(path.join(workspaceDir, "knowledge-base", "sources", "doi-10.1103-PhysRevLett.111.080502", "metadata.json"), "utf8"),
      { code: "ENOENT" }
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage rejects non-PDF supplemental material bytes", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502";

  try {
    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-05-26T10:40:00.000Z"),
      message: {
        type: "register_supplemental_material",
        jobId: "job-aps-supplement-html",
        articleUrl,
        source: "aps",
        materialUrl: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502",
        materialBase64: Buffer.from("<html>Supplemental listing</html>").toString("base64"),
        filename: "supplemental.html",
        mimeType: "text/html",
        title: "Supplemental Material"
      }
    });

    assert.equal(response.type, "error");
    assert.equal(response.code, "supplement_not_pdf");
    await assert.rejects(
      readFile(
        path.join(
          workspaceDir,
          "knowledge-base",
          "sources",
          "aps-10.1103-PhysRevLett.111.080502",
          "supplemental",
          "supplemental.html"
        ),
        "utf8"
      ),
      { code: "ENOENT" }
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage rejects publisher record conflicts without overwriting", async () => {
  const workspaceDir = await createWorkspaceDir();
  const existingArticleUrl = "https://www.nature.com/articles/s41586-019-1666-5";
  const conflictingArticleUrl = "https://www.nature.com/articles/s41586-019-1666-5?via=mirror";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "nature.pdf");
  const existingPdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "nature",
    canonicalId: "s41586-019-1666-5"
  });

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\nnature pdf\n");
    await writePdf(existingPdfPath, "%PDF-1.7\nexisting nature pdf\n");
    await writePaperRecord({
      workspaceDir,
      record: {
        source: "nature",
        articleUrl: existingArticleUrl,
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: "s41586-019-1666-5",
        pdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf",
        downloadPath: existingPdfPath
      }
    });

    assert.deepEqual(
      await handleExtensionHostMessage({
        workspaceDir,
        message: {
          type: "register_download",
          jobId: "job-conflict",
          articleUrl: conflictingArticleUrl,
          source: "nature",
          downloadPath: sourcePdfPath
        }
      }),
      {
        type: "error",
        jobId: "job-conflict",
        code: "record_conflict",
        message: "A different article URL is already indexed for this publisher record."
      }
    );

    const recordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "nature",
      canonicalId: "s41586-019-1666-5",
      articleUrl: existingArticleUrl
    });
    assert.equal(JSON.parse(await readFile(recordPath, "utf8")).articleUrl, existingArticleUrl);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage stores message-provided publisher PDF URLs instead of article URLs", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://journals.aps.org/prapplied/abstract/10.1103/PhysRevApplied.24.034057";
  const pdfUrl = "https://download.example.org/aps-paper.pdf";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "aps.pdf");

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\naps pdf\n");

    const response = await handleExtensionHostMessage({
      workspaceDir,
      message: {
        type: "register_download",
        jobId: "job-aps-pdf-url",
        articleUrl,
        source: "aps",
        downloadPath: sourcePdfPath,
        pdfUrl
      }
    });

    assert.equal(response.type, "registered");
    const recordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "aps",
      canonicalId: "10.1103/PhysRevApplied.24.034057",
      articleUrl
    });
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(record.pdfUrl, pdfUrl);
    assert.notEqual(record.pdfUrl, articleUrl);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage derives APS DOI resolver PDF URLs", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://journals.aps.org/doi/10.1103/PhysRevApplied.24.034057";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "aps.pdf");

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\naps pdf\n");

    const response = await handleExtensionHostMessage({
      workspaceDir,
      message: {
        type: "register_download",
        jobId: "job-aps-doi-url",
        articleUrl,
        source: "aps",
        downloadPath: sourcePdfPath
      }
    });

    assert.equal(response.type, "registered");
    const recordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "aps",
      canonicalId: "10.1103/PhysRevApplied.24.034057",
      articleUrl
    });
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(record.pdfUrl, "https://journals.aps.org/doi/pdf/10.1103/PhysRevApplied.24.034057");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage appends job status handoffs and acknowledges them", async () => {
  const workspaceDir = await createWorkspaceDir();

  try {
    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-04-25T11:00:00.000Z"),
      message: {
        type: "job_status",
        jobId: "job-status",
        status: "pdf_candidate_found",
        articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
        source: "nature",
        message: "PDF link detected."
      }
    });

    assert.deepEqual(response, {
      type: "status_ack",
      jobId: "job-status",
      status: "pdf_candidate_found"
    });
    assert.deepEqual(await readPaperDownloadJobEvents({ workspaceDir }), [
      {
        jobId: "job-status",
        recordedAt: "2026-04-25T11:00:00.000Z",
        status: "pdf_candidate_found",
        articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
        source: "nature",
        message: "PDF link detected."
      }
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage registers webpage snapshots as parsed wiki artifacts", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";

  try {
    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-04-25T11:30:00.000Z"),
      message: {
        type: "register_webpage_snapshot",
        jobId: "job-webpage",
        articleUrl,
        finalUrl: `${articleUrl}?browser=1`,
        source: "science",
        title: "Science webpage",
        html: `
          <html>
            <head>
              <meta name="citation_title" content="Science webpage title">
              <meta name="citation_doi" content="10.1126/science.adz8659">
            </head>
            <body>
              <main>
                <h1>Science webpage title</h1>
                <section><h2>Abstract</h2><p>Browser extension captured this Science article.</p></section>
                <section><h2>References</h2><p>1. Reference.</p></section>
              </main>
            </body>
          </html>
        `
      }
    });

    assert.equal(response.type, "webpage_registered");
    assert.equal(response.jobId, "job-webpage");
    assert.equal(response.articleUrl, articleUrl);
    assert.equal(response.paperKey, "science-10.1126-science.adz8659");
    assert.match(response.markdownPath, /knowledge-base\/sources\/science-10\.1126-science\.adz8659\/parses\/webpage\/document\.md$/);
    assert.match(response.parsePath, /knowledge-base\/sources\/science-10\.1126-science\.adz8659\/parses\/webpage\/parse\.json$/);
    assert.match(response.qualityPath, /knowledge-base\/sources\/science-10\.1126-science\.adz8659\/parses\/webpage\/quality\.json$/);
    assert.match(response.chunksPath, /knowledge-base\/sources\/science-10\.1126-science\.adz8659\/chunks\/webpage\.jsonl$/);
    assert.ok(response.quality);
    assert.equal(response.quality.status, "poor");
    assert.ok(response.quality.score < 0.7);

    const markdown = await readFile(response.markdownPath, "utf8");
    assert.match(markdown, /Browser extension captured this Science article/);
    const events = await readPaperDownloadJobEvents({ workspaceDir });
    assert.equal(events.at(-1)?.status, "webpage_snapshot_ready");
    assert.equal(events.at(-1)?.purpose, "webpage");
    assert.equal(events.at(-1)?.paperKey, "science-10.1126-science.adz8659");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage poll_jobs returns latest queued jobs with sources", async () => {
  const workspaceDir = await createWorkspaceDir();

  try {
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "queued-with-source",
        recordedAt: "2026-04-25T12:00:00.000Z",
        status: "queued",
        articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
        source: "nature",
        title: "Queued Nature",
        autoClose: true,
        purpose: "webpage"
      }
    });
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "finished",
        recordedAt: "2026-04-25T12:01:00.000Z",
        status: "queued",
        articleUrl: "https://example.com/finished",
        source: "external"
      }
    });
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "finished",
        recordedAt: "2026-04-25T12:02:00.000Z",
        status: "downloaded",
        articleUrl: "https://example.com/finished"
      }
    });
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "queued-without-source",
        recordedAt: "2026-04-25T12:03:00.000Z",
        status: "queued",
        articleUrl: "https://example.com/no-source"
      }
    });

    assert.deepEqual(
      await handleExtensionHostMessage({
        workspaceDir,
        message: {
          type: "poll_jobs",
          extensionInstanceId: "extension-1"
        }
      }),
      {
        type: "jobs",
        jobs: [
          {
            jobId: "queued-with-source",
            articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
            source: "nature",
            title: "Queued Nature",
            autoClose: true,
            purpose: "webpage"
          }
        ]
      }
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage returns structured not_pdf errors for non-PDF registrations", async () => {
  const workspaceDir = await createWorkspaceDir();
  const textPath = path.join(workspaceDir, "inbox", "not-pdf.txt");

  try {
    await mkdir(path.dirname(textPath), { recursive: true });
    await writeFile(textPath, "not a pdf", "utf8");

    assert.deepEqual(
      await handleExtensionHostMessage({
        workspaceDir,
        message: {
          type: "register_download",
          jobId: "job-not-pdf",
          articleUrl: "https://example.com/paper",
          source: "external",
          downloadPath: textPath
        }
      }),
      {
        type: "error",
        jobId: "job-not-pdf",
        code: "not_pdf",
        message: "Downloaded file is not a valid PDF."
      }
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage classifies publisher HTML downloads as manual login required", async () => {
  const workspaceDir = await createWorkspaceDir();
  const htmlPath = path.join(workspaceDir, "inbox", "aps-10.1103-k3d5-v43c.htm");

  try {
    await mkdir(path.dirname(htmlPath), { recursive: true });
    await writeFile(htmlPath, "<!doctype html><html><body>Authorization Required</body></html>", "utf8");

    assert.deepEqual(
      await handleExtensionHostMessage({
        workspaceDir,
        message: {
          type: "register_download",
          jobId: "job-aps-html",
          articleUrl: "https://journals.aps.org/prapplied/abstract/10.1103/k3d5-v43c",
          source: "aps",
          downloadPath: htmlPath
        }
      }),
      {
        type: "error",
        jobId: "job-aps-html",
        code: "manual_login_required",
        message:
          "APS returned an HTML page instead of the article PDF. Log in or complete publisher verification in the browser extension tab, then retry the download."
      }
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage classifies Science license-denied HTML downloads explicitly", async () => {
  const workspaceDir = await createWorkspaceDir();
  const htmlPath = path.join(workspaceDir, "inbox", "science.ado6285.htm");

  try {
    await mkdir(path.dirname(htmlPath), { recursive: true });
    await writeFile(
      htmlPath,
      "<!doctype html><html><body>Your license does not permit this publication to be downloaded.</body></html>",
      "utf8"
    );

    assert.deepEqual(
      await handleExtensionHostMessage({
        workspaceDir,
        message: {
          type: "register_download",
          jobId: "job-science-license",
          articleUrl: "https://www.science.org/doi/10.1126/science.ado6285",
          source: "science",
          downloadPath: htmlPath
        }
      }),
      {
        type: "error",
        jobId: "job-science-license",
        code: "publisher_license_not_permitted",
        message:
          "Science reports that the current license does not permit this publication to be downloaded. The article webpage may still be readable, but the publisher PDF cannot be downloaded with the current account or institutional license."
      }
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage returns structured errors for post-read registration failures", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://example.com/unwritable-paper";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "manual.pdf");
  const expectedDownloadPath = resolveExternalPaperPdfPath({ workspaceDir, articleUrl });

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\nexternal pdf\n");
    await mkdir(expectedDownloadPath, { recursive: true });

    const response = await handleExtensionHostMessage({
      workspaceDir,
      message: {
        type: "register_download",
        jobId: "job-write-failure",
        articleUrl,
        source: "external",
        downloadPath: sourcePdfPath
      }
    });

    assert.equal(response.type, "error");
    assert.equal(response.jobId, "job-write-failure");
    assert.equal(response.code, "registration_failed");
    assert.equal(typeof response.message, "string");
    assert.notEqual(response.message.trim(), "");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("runPaperExtensionNativeHost responds to a complete frame before stdin closes", async () => {
  const workspaceDir = await createWorkspaceDir();
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  try {
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "job-stream",
        recordedAt: "2026-04-25T13:00:00.000Z",
        status: "queued",
        articleUrl: "https://example.com/paper",
        source: "external"
      }
    });

    const runPromise = runPaperExtensionNativeHost({ workspaceDir, stdin, stdout });
    const responsePromise = new Promise<unknown>((resolve) => {
      stdout.once("data", (chunk: Buffer) => {
        resolve(decodeFirstFrame(chunk));
      });
    });

    stdin.write(encodeNativeInput({ type: "poll_jobs", extensionInstanceId: "extension-1" }));

    assert.deepEqual(await responsePromise, {
      type: "jobs",
      jobs: [
        {
          jobId: "job-stream",
          articleUrl: "https://example.com/paper",
          source: "external"
        }
      ]
    });

    stdin.end();
    await runPromise;
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("runPaperExtensionNativeHost frames handler failures and continues processing later frames", async () => {
  const workspaceDir = await createWorkspaceDir();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const jobsPath = resolvePaperDownloadJobsPath({ workspaceDir });

  try {
    await mkdir(jobsPath, { recursive: true });
    const runPromise = runPaperExtensionNativeHost({ workspaceDir, stdin, stdout });
    const firstResponsePromise = waitForNativeMessages(stdout, 1);

    stdin.write(encodeNativeInput({ type: "poll_jobs", extensionInstanceId: "extension-1" }));
    const firstResponses = await firstResponsePromise;
    assert.equal((firstResponses[0] as { type?: string }).type, "error");
    assert.equal((firstResponses[0] as { code?: string }).code, "handler_failed");
    assert.equal(typeof (firstResponses[0] as { message?: unknown }).message, "string");
    assert.notEqual(((firstResponses[0] as { message: string }).message).trim(), "");

    await rm(jobsPath, { recursive: true, force: true });
    const secondResponsePromise = waitForNativeMessages(stdout, 1);
    stdin.write(encodeNativeInput({ type: "poll_jobs", extensionInstanceId: "extension-1" }));

    assert.deepEqual((await secondResponsePromise)[0], {
      type: "jobs",
      jobs: []
    });

    stdin.end();
    await runPromise;
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("writeNativeHostManifest writes the Chrome native host manifest", async () => {
  const workspaceDir = await createWorkspaceDir();
  const manifestPath = path.join(workspaceDir, "manifest.json");
  const hostPath = path.join(workspaceDir, "dist", "src", "paper-extension-host.js");

  try {
    await writeNativeHostManifest({
      manifestPath,
      hostPath,
      extensionId: "abcdefghijklmnopabcdefghijklmnop"
    });

    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), {
      name: "com.pi_agent.paper_downloader",
      description: "Pi Agent paper downloader native host",
      path: hostPath,
      type: "stdio",
      allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
