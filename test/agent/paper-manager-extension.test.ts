import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadPaper } from "../../src/agent/paper-manager.js";
import { PaperDownloadError } from "../../src/agent/paper-download.js";
import {
  createPaperExtensionJob,
  createQueuedPaperExtensionBridge
} from "../../src/agent/paper-extension-bridge.js";
import {
  resolveExternalPaperPdfPath,
  resolvePaperPdfPath,
  resolvePaperRecordPath
} from "../../src/agent/paper-store.js";

function expectedJobId(source: string, articleUrl: string): string {
  return `paper-${source}-${createHash("sha1").update(`${source}:${articleUrl}`).digest("hex").slice(0, 12)}`;
}

test("downloadPaper routes supported publisher URLs through the extension bridge by default", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";
  const submittedJobs: unknown[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      extensionBridge: {
        async submitJob(job) {
          submittedJobs.push(job);
          return {
            status: "awaiting_user_manual_download",
            source: job.source,
            articleUrl: job.articleUrl,
            jobId: job.jobId,
            message: "Opened in the paper download extension."
          };
        }
      },
      downloadPublisherPaperImpl: async () => {
        throw new Error("Playwright fallback should not run by default");
      },
      openPageInSystemChromeImpl: async () => {
        throw new Error("system browser fallback should not run by default");
      }
    });

    assert.deepEqual(submittedJobs, [
      {
        jobId: expectedJobId("science", articleUrl),
        articleUrl,
        source: "science"
      }
    ]);
    assert.deepEqual(result, {
      status: "awaiting_user_manual_download",
      source: "science",
      articleUrl,
      jobId: expectedJobId("science", articleUrl),
      message: "Opened in the paper download extension."
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper returns extension_unavailable without launching fallback when no bridge is configured", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";
  const fallbackCalls: string[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      downloadPublisherPaperImpl: async () => {
        fallbackCalls.push("download");
        throw new Error("Playwright fallback should not run without explicit opt-in");
      },
      openPageInSystemChromeImpl: async () => {
        fallbackCalls.push("open");
        throw new Error("system browser fallback should not run without explicit opt-in");
      }
    });

    assert.deepEqual(fallbackCalls, []);
    assert.deepEqual(result, {
      status: "extension_unavailable",
      source: "science",
      articleUrl,
      failure: {
        code: "extension_unavailable",
        message: "Paper extension bridge is not configured. Set usePlaywrightFallback to true to use browser fallback."
      }
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper returns extension_unavailable for external URLs without launching fallback when no bridge is configured", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://example.com/paper";
  const fallbackCalls: string[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      openPageInSystemChromeImpl: async () => {
        fallbackCalls.push("open");
        throw new Error("system browser fallback should not run without explicit opt-in");
      }
    });

    assert.deepEqual(fallbackCalls, []);
    assert.deepEqual(result, {
      status: "extension_unavailable",
      source: "external",
      articleUrl,
      failure: {
        code: "extension_unavailable",
        message: "Paper extension bridge is not configured. Set usePlaywrightFallback to true to use browser fallback."
      }
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper returns extension_unavailable when the bridge fails and fallback is not explicit", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://www.nature.com/articles/s41586-024-12345-6";

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      extensionBridge: {
        async submitJob() {
          throw new Error("native host unavailable");
        }
      },
      downloadPublisherPaperImpl: async () => {
        throw new Error("Playwright fallback should not run by default");
      },
      openPageInSystemChromeImpl: async () => {
        throw new Error("system browser fallback should not run by default");
      }
    });

    assert.deepEqual(result, {
      status: "extension_unavailable",
      source: "nature",
      articleUrl,
      failure: {
        code: "extension_unavailable",
        message: "native host unavailable"
      }
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper runs legacy fallback when the bridge fails and fallback is explicit", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://www.nature.com/articles/s41586-024-12345-6";
  const fallbackUrl = `${articleUrl}?manual=1`;
  const fallbackCalls: string[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      usePlaywrightFallback: true,
      extensionBridge: {
        async submitJob() {
          throw new Error("native host unavailable");
        }
      },
      downloadPublisherPaperImpl: async () => {
        fallbackCalls.push("download");
        throw new PaperDownloadError("manual_login_required", "Nature requires manual sign-in.");
      },
      openPublisherForLoginImpl: async () => {
        fallbackCalls.push("open");
        return {
          openedUrl: fallbackUrl,
          profileDir: path.join(workspaceDir, ".browser-profile", "paper-access")
        };
      }
    });

    assert.deepEqual(fallbackCalls, ["download", "open"]);
    assert.equal(result.status, "manual_fallback_opened");
    assert.equal(result.source, "nature");
    assert.equal(result.articleUrl, articleUrl);
    assert.equal(result.fallbackUrl, fallbackUrl);
    assert.equal(result.failure.code, "manual_login_required");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper routes external URLs through the extension bridge by default", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://example.com/paper";
  const submittedJobs: unknown[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      extensionBridge: {
        async submitJob(job) {
          submittedJobs.push(job);
          return {
            status: "opened_in_user_browser",
            source: job.source,
            articleUrl: job.articleUrl,
            jobId: job.jobId,
            message: "Opened in the paper download extension."
          };
        }
      },
      openPageInSystemChromeImpl: async () => {
        throw new Error("system browser fallback should not run by default");
      }
    });

    assert.deepEqual(submittedJobs, [
      {
        jobId: expectedJobId("external", articleUrl),
        articleUrl,
        source: "external"
      }
    ]);
    assert.deepEqual(result, {
      status: "opened_in_user_browser",
      source: "external",
      articleUrl,
      jobId: expectedJobId("external", articleUrl),
      message: "Opened in the paper download extension."
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper keeps arXiv URLs on direct HTTP download even when a bridge is provided", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const pdfBytes = Buffer.from("%PDF-1.4\narxiv pdf\n", "utf8");
  let bridgeCalls = 0;

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: "https://arxiv.org/abs/2401.01234",
      extensionBridge: {
        async submitJob() {
          bridgeCalls += 1;
          throw new Error("bridge should not run for arXiv");
        }
      },
      fetchImpl: async () =>
        new Response(pdfBytes, {
          status: 200,
          headers: {
            "content-type": "application/pdf"
          }
        })
    });

    assert.equal(bridgeCalls, 0);
    assert.equal(result.status, "downloaded");
    assert.equal(result.source, "arxiv");
    assert.equal(result.canonicalId, "2401.01234");
    assert.equal(await readFile(result.path, "utf8"), pdfBytes.toString("utf8"));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper skips a provided bridge for existing downloaded publisher records", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "science",
    canonicalId: "10.1126/science.adz8659"
  });
  const recordPath = resolvePaperRecordPath({
    workspaceDir,
    source: "science",
    canonicalId: "10.1126/science.adz8659",
    articleUrl
  });
  let bridgeCalls = 0;

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.4\nexisting science pdf\n", "utf8");
    await writeFile(
      recordPath,
      `${JSON.stringify({
        source: "science",
        articleUrl,
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: "10.1126/science.adz8659",
        pdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
        downloadPath: pdfPath
      })}\n`,
      "utf8"
    );

    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      extensionBridge: {
        async submitJob() {
          bridgeCalls += 1;
          throw new Error("bridge should not run for existing publisher records");
        }
      }
    });

    assert.equal(bridgeCalls, 0);
    assert.deepEqual(result, {
      status: "already_downloaded",
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl,
      finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
      path: pdfPath,
      recordPath,
      recordedAt: "2026-04-25T10:00:00.000Z"
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper skips a provided bridge for existing downloaded external records", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://example.com/paper";
  const pdfPath = resolveExternalPaperPdfPath({ workspaceDir, articleUrl });
  const recordPath = resolvePaperRecordPath({
    workspaceDir,
    source: "external",
    articleUrl
  });
  let bridgeCalls = 0;

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\nexisting external pdf\n", "utf8");
    await writeFile(
      recordPath,
      `${JSON.stringify({
        source: "external",
        articleUrl,
        openedUrl: `${articleUrl}?opened=1`,
        recordedAt: "2026-04-25T10:30:00.000Z",
        handlingMethod: "manual_file_import",
        status: "downloaded",
        downloadPath: pdfPath,
        fileSha256: "abc123",
        title: "Existing External Paper"
      })}\n`,
      "utf8"
    );

    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      extensionBridge: {
        async submitJob() {
          bridgeCalls += 1;
          throw new Error("bridge should not run for existing external records");
        }
      }
    });

    assert.equal(bridgeCalls, 0);
    assert.deepEqual(result, {
      status: "already_downloaded",
      source: "external",
      articleUrl,
      path: pdfPath,
      recordPath,
      recordedAt: "2026-04-25T10:30:00.000Z",
      fileSha256: "abc123",
      title: "Existing External Paper"
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("createQueuedPaperExtensionBridge appends queued job events", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.135.030801";

  try {
    const job = createPaperExtensionJob({
      articleUrl,
      source: "aps",
      title: "APS paper",
      autoClose: true
    });
    const bridge = createQueuedPaperExtensionBridge({
      workspaceDir,
      now: () => new Date("2026-04-25T04:00:00.000Z")
    });

    const result = await bridge.submitJob(job);
    const jobsPath = path.join(workspaceDir, ".browser-profile", "paper-download-jobs.jsonl");

    assert.deepEqual(result, {
      status: "extension_job_queued",
      source: "aps",
      articleUrl,
      jobId: expectedJobId("aps", articleUrl),
      message: "Paper download job queued for the browser extension."
    });
    assert.equal(
      await readFile(jobsPath, "utf8"),
      `${JSON.stringify({
        jobId: expectedJobId("aps", articleUrl),
        recordedAt: "2026-04-25T04:00:00.000Z",
        status: "queued",
        articleUrl,
        source: "aps",
        title: "APS paper",
        autoClose: true,
        message: "Paper download job queued for the browser extension."
      })}\n`
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
