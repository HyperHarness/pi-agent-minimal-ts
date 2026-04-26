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
} from "../../src/agent/paper-download-jobs.js";
import {
  encodeNativeMessage,
  handleExtensionHostMessage,
  readNativeMessagesFromBuffer,
  resolveDownloadPathCandidates,
  runPaperExtensionNativeHost,
  writeNativeHostManifest
} from "../../src/agent/paper-extension-host.js";
import {
  findDownloadedPaperRecord,
  resolveExternalPaperPdfPath,
  resolvePaperPdfPath,
  resolvePaperRecordPath,
  writePaperRecord
} from "../../src/agent/paper-store.js";
import type { ExtensionHostResponse } from "../../src/agent/paper-extension-protocol.js";

async function createWorkspaceDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "paper-extension-host-"));
}

async function writePdf(filePath: string, contents = "%PDF-1.7\nmock pdf\n%%EOF\n"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
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
    assert.deepEqual(JSON.parse(await readFile(expectedRecordPath, "utf8")), {
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
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage registers supported publisher PDFs using canonical publisher records", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://www.nature.com/articles/s41586-019-1666-5";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "nature.pdf");

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\nnature pdf\n");

    const response = await handleExtensionHostMessage({
      workspaceDir,
      now: () => new Date("2026-04-25T10:30:00.000Z"),
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
      canonicalId: "s41586-019-1666-5"
    });
    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "nature",
      canonicalId: "s41586-019-1666-5",
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
    assert.deepEqual(JSON.parse(await readFile(expectedRecordPath, "utf8")), {
      source: "nature",
      articleUrl,
      recordedAt: "2026-04-25T10:30:00.000Z",
      handlingMethod: "browser_session",
      status: "downloaded",
      canonicalId: "s41586-019-1666-5",
      pdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf",
      downloadPath: expectedDownloadPath
    });
    const events = await readPaperDownloadJobEvents({ workspaceDir });
    assert.equal(events.at(-1)?.status, "downloaded");
    assert.equal(events.at(-1)?.recordPath, expectedRecordPath);
    assert.equal(events.at(-1)?.fileSha256, expectedSha256);
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
        pdfUrl: "https://cdn.example.org/science.adz8659.pdf",
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
      "https://cdn.example.org/science.adz8659.pdf"
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

test("handleExtensionHostMessage returns pdf_url_not_found when publisher PDF URL cannot be determined", async () => {
  const workspaceDir = await createWorkspaceDir();
  const articleUrl = "https://journals.aps.org/doi/10.1103/PhysRevApplied.24.034057";
  const sourcePdfPath = path.join(workspaceDir, "inbox", "aps.pdf");

  try {
    await writePdf(sourcePdfPath, "%PDF-1.7\naps pdf\n");

    assert.deepEqual(
      await handleExtensionHostMessage({
        workspaceDir,
        message: {
          type: "register_download",
          jobId: "job-no-pdf-url",
          articleUrl,
          source: "aps",
          downloadPath: sourcePdfPath
        }
      }),
      {
        type: "error",
        jobId: "job-no-pdf-url",
        code: "pdf_url_not_found",
        message: "Unable to determine a PDF URL for this publisher article."
      }
    );
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
        autoClose: true
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
            autoClose: true
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
