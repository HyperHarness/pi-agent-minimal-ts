import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadPaper } from "../../src/agent/paper/acquisition/paper-manager.js";
import { PaperDownloadError } from "../../src/agent/paper/acquisition/paper-download.js";
import {
  createPaperExtensionJob,
  createQueuedPaperExtensionBridge
} from "../../src/agent/paper/extension/paper-extension-bridge.js";
import { appendPaperDownloadJobEvent } from "../../src/agent/paper/extension/paper-download-jobs.js";
import {
  resolveExternalPaperPdfPath,
  resolvePaperPdfPath,
  resolvePaperRecordPath
} from "../../src/agent/paper/storage/paper-store.js";

function expectedJobId(source: string, articleUrl: string): string {
  return `paper-${source}-${createHash("sha1").update(`${source}:${articleUrl}`).digest("hex").slice(0, 12)}`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
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
        source: "science",
        purpose: "download_and_webpage"
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

test("downloadPaper derives publisher title and falls back to exact arXiv preprint when publisher download is restricted", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.abb2823";
  const title = "A blueprint for demonstrating quantum supremacy with superconducting qubits";
  const arxivId = "1709.06678";
  const searchedTitles: string[] = [];
  const fetchedUrls: string[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      extensionBridge: {
        async submitJob() {
          throw new Error("Science download requires publisher login.");
        }
      },
      searchArxivImpl: async (options) => {
        searchedTitles.push(options.query);
        return [
          {
            id: arxivId,
            title,
            authors: ["A. Author"],
            summary: "Preprint summary",
            absUrl: `https://arxiv.org/abs/${arxivId}`,
            pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`
          }
        ];
      },
      fetchImpl: async (input) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url === articleUrl) {
          return new Response(
            `<html><head><meta name="citation_title" content="${title} | Science"></head></html>`,
            {
              status: 200,
              headers: { "content-type": "text/html" }
            }
          );
        }

        return new Response("%PDF-science-arxiv", {
          status: 200,
          headers: { "content-type": "application/pdf" }
        });
      }
    });

    assert.deepEqual(searchedTitles, [title]);
    assert.deepEqual(fetchedUrls, [
      articleUrl,
      `https://arxiv.org/pdf/${arxivId}.pdf`
    ]);
    assert.equal(result.status, "downloaded");
    assert.equal(result.source, "arxiv");
    assert.equal(result.canonicalId, arxivId);
    assert.equal(result.publisherFallback?.source, "science");
    assert.equal(result.publisherFallback?.articleUrl, articleUrl);

    const scienceRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "science",
      canonicalId: "10.1126/science.abb2823",
      articleUrl
    });
    const scienceRecord = JSON.parse(await readFile(scienceRecordPath, "utf8")) as {
      source?: string;
      status?: string;
      handlingMethod?: string;
      title?: string;
      preprint?: { source?: string; canonicalId?: string };
      failure?: { code?: string };
    };
    assert.equal(scienceRecord.source, "science");
    assert.equal(scienceRecord.status, "preprint_fallback");
    assert.equal(scienceRecord.handlingMethod, "arxiv_preprint_fallback");
    assert.equal(scienceRecord.title, title);
    assert.equal(scienceRecord.preprint?.source, "arxiv");
    assert.equal(scienceRecord.preprint?.canonicalId, arxivId);
    assert.equal(scienceRecord.failure?.code, "publisher_version_not_available");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper resolves APS accepted papers through exact-title arXiv fallback", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://journals.aps.org/prapplied/accepted/10.1103/k3d5-v43c";
  const title = "Superconducting qubits in the millions: The potential and limitations of modularity";
  const arxivId = "2601.01234";
  const searchedTitles: string[] = [];
  const fetchedUrls: string[] = [];
  const submittedJobs: unknown[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title,
      extensionBridge: {
        async submitJob(job) {
          submittedJobs.push(job);
          throw new Error("Accepted papers should not be queued before arXiv fallback is tried.");
        }
      },
      searchArxivImpl: async (options) => {
        searchedTitles.push(options.query);
        return [
          {
            id: arxivId,
            title,
            authors: ["A. Author"],
            summary: "Preprint summary",
            absUrl: `https://arxiv.org/abs/${arxivId}`,
            pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`
          }
        ];
      },
      fetchImpl: async (input) => {
        fetchedUrls.push(String(input));
        return new Response("%PDF-accepted-arxiv", {
          status: 200,
          headers: { "content-type": "application/pdf" }
        });
      }
    });

    assert.deepEqual(submittedJobs, []);
    assert.deepEqual(searchedTitles, [title]);
    assert.deepEqual(fetchedUrls, [`https://arxiv.org/pdf/${arxivId}.pdf`]);
    assert.equal(result.status, "downloaded");
    assert.equal(result.source, "arxiv");
    assert.equal(result.canonicalId, arxivId);
    assert.equal(result.publisherFallback?.source, "aps");
    assert.equal(result.publisherFallback?.canonicalId, "10.1103/k3d5-v43c");
    assert.equal(result.publisherFallback?.articleUrl, articleUrl);

    const arxivRecord = JSON.parse(await readFile(result.recordPath, "utf8")) as Record<string, unknown>;
    assert.equal(arxivRecord.source, "arxiv");
    assert.equal(arxivRecord.status, "downloaded");

    const apsRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "aps",
      canonicalId: "10.1103/k3d5-v43c",
      articleUrl
    });
    const apsRecord = JSON.parse(await readFile(apsRecordPath, "utf8")) as {
      source?: string;
      status?: string;
      handlingMethod?: string;
      title?: string;
      preprint?: { source?: string; canonicalId?: string; recordPath?: string; downloadPath?: string };
      failure?: { code?: string; message?: string };
    };
    assert.equal(apsRecord.source, "aps");
    assert.equal(apsRecord.status, "preprint_fallback");
    assert.equal(apsRecord.handlingMethod, "arxiv_preprint_fallback");
    assert.equal(apsRecord.title, title);
    assert.equal(apsRecord.preprint?.source, "arxiv");
    assert.equal(apsRecord.preprint?.canonicalId, arxivId);
    assert.equal(apsRecord.preprint?.recordPath, result.recordPath);
    assert.equal(apsRecord.preprint?.downloadPath, result.path);
    assert.equal(apsRecord.failure?.code, "publisher_version_not_available");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper records APS accepted papers as pending when no exact arXiv fallback exists", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://journals.aps.org/prapplied/accepted/10.1103/rp4w-3n7l";
  const title = "Design and application of N[3]CZ: A controlled-Z gate between next-nearest-neighbor superconducting qubits";
  const submittedJobs: unknown[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title,
      extensionBridge: {
        async submitJob(job) {
          submittedJobs.push(job);
          throw new Error("Accepted papers without arXiv fallback should not be queued.");
        }
      },
      searchArxivImpl: async () => [
        {
          id: "2401.00001",
          title: "Different paper title",
          authors: ["A. Author"],
          summary: "Preprint summary",
          absUrl: "https://arxiv.org/abs/2401.00001",
          pdfUrl: "https://arxiv.org/pdf/2401.00001.pdf"
        }
      ],
      fetchImpl: async () => {
        throw new Error("PDF download should not run without an exact arXiv title match.");
      }
    });

    assert.deepEqual(submittedJobs, []);
    assert.equal(result.status, "publisher_pending");
    assert.equal(result.source, "aps");
    assert.equal(result.canonicalId, "10.1103/rp4w-3n7l");
    assert.equal(result.articleUrl, articleUrl);
    assert.equal(result.title, title);
    assert.equal(result.failure.code, "publisher_version_not_available");

    const record = JSON.parse(await readFile(result.recordPath, "utf8")) as {
      source?: string;
      status?: string;
      handlingMethod?: string;
      title?: string;
      failure?: { code?: string; message?: string };
    };
    assert.equal(record.source, "aps");
    assert.equal(record.status, "publisher_pending");
    assert.equal(record.handlingMethod, "accepted_paper");
    assert.equal(record.title, title);
    assert.equal(record.failure?.code, "publisher_version_not_available");
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
        message: "Paper extension bridge is not configured, and no direct PDF or exact-title open fallback was available."
      }
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper uses a local exact-title arXiv preprint before live arXiv search", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.aao4309";
  const title = "A blueprint for demonstrating quantum supremacy with superconducting qubits";
  const arxivPdfPath = path.join(workspaceDir, "knowledge-base", "raw", "pdfs", "arxiv-1709.06678.pdf");

  try {
    await mkdir(path.dirname(arxivPdfPath), { recursive: true });
    await writeFile(arxivPdfPath, "%PDF-1.4\nexample\n%%EOF\n", "utf8");
    await writeJson(path.join(workspaceDir, "knowledge-base", "wiki", "sources", "arxiv-1709.06678", "acquisition.json"), {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/1709.06678",
      recordedAt: "2026-05-03T01:35:27.669Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "1709.06678",
      pdfUrl: "https://arxiv.org/pdf/1709.06678",
      downloadPath: arxivPdfPath
    });
    await writeText(
      path.join(workspaceDir, "knowledge-base", "wiki", "sources", "arxiv-1709.06678.md"),
      [
        "---",
        `title: "${title}"`,
        "---",
        "",
        `# ${title}`
      ].join("\n")
    );

    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title,
      usePlaywrightFallback: true,
      searchArxivImpl: async () => {
        throw new Error("live arXiv search should not be needed");
      },
      downloadPublisherPaperImpl: async () => {
        throw new Error("browser fallback should not be needed");
      }
    });

    assert.equal(result.status, "already_downloaded");
    assert.equal(result.source, "arxiv");
    assert.equal(result.canonicalId, "1709.06678");
    assert.equal(result.publisherFallback?.source, "science");
    assert.equal(result.publisherFallback?.canonicalId, "10.1126/science.aao4309");

    const scienceRecord = JSON.parse(
      await readFile(path.join(workspaceDir, "knowledge-base", "wiki", "sources", "science-10.1126-science.aao4309", "acquisition.json"), "utf8")
    ) as { status?: string; preprint?: { canonicalId?: string } };
    assert.equal(scienceRecord.status, "preprint_fallback");
    assert.equal(scienceRecord.preprint?.canonicalId, "1709.06678");
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
        message: "Paper extension bridge is not configured, and no direct PDF or exact-title open fallback was available."
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

test("downloadPaper preserves prior publisher license-denied failures from extension jobs", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.ado6285";
  const message =
    "Science reports that the current license does not permit this publication to be downloaded. The article webpage may still be readable, but the publisher PDF cannot be downloaded with the current account or institutional license.";

  try {
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "job-science-license",
        recordedAt: "2026-05-06T05:00:00.000Z",
        status: "automatic_download_failed",
        articleUrl,
        source: "science",
        failureCode: "publisher_license_not_permitted",
        message
      }
    });

    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title: "Beyond-classical computation in quantum simulation",
      searchArxivImpl: async () => []
    });

    assert.deepEqual(result, {
      status: "extension_unavailable",
      source: "science",
      articleUrl,
      failure: {
        code: "publisher_license_not_permitted",
        message
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

test("downloadPaper forceManualOpen bypasses the extension bridge for supported publisher URLs", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601";
  const bridgeCalls: unknown[] = [];
  const fallbackCalls: string[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      forceManualOpen: {
        code: "recent_cloudflare_block",
        message: "Skipping automatic APS download because Cloudflare recently blocked APS access."
      },
      extensionBridge: {
        async submitJob(job) {
          bridgeCalls.push(job);
          return {
            status: "extension_job_queued",
            source: job.source,
            articleUrl: job.articleUrl,
            jobId: job.jobId,
            message: "This should not be queued when manual fallback is forced."
          };
        }
      },
      downloadPublisherPaperImpl: async () => {
        fallbackCalls.push("download");
        throw new Error("automatic fallback should not run when manual fallback is forced");
      },
      openPublisherForLoginImpl: async (openOptions) => {
        fallbackCalls.push(`open:${openOptions.url}`);
        return {
          openedUrl: `${openOptions.url}?manual=1`,
          profileDir: path.join(workspaceDir, ".browser-profile", "paper-access")
        };
      }
    });

    assert.deepEqual(bridgeCalls, []);
    assert.deepEqual(fallbackCalls, [`open:${articleUrl}`]);
    assert.deepEqual(result, {
      status: "manual_fallback_opened",
      source: "aps",
      canonicalId: "10.1103/PhysRevLett.134.090601",
      articleUrl,
      fallbackUrl: `${articleUrl}?manual=1`,
      recordPath: path.join(workspaceDir, "knowledge-base", "wiki", "sources", "aps-10.1103-PhysRevLett.134.090601", "acquisition.json"),
      failure: {
        code: "recent_cloudflare_block",
        message: "Skipping automatic APS download because Cloudflare recently blocked APS access."
      },
      profileDir: path.join(workspaceDir, ".browser-profile", "paper-access"),
      executablePath: undefined
    });
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
        pdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
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
      finalPdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
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
    assert.match(result.jobId, new RegExp(`^${expectedJobId("aps", articleUrl)}-[a-z0-9]+-[a-z0-9]+$`));

    assert.deepEqual(result, {
      status: "extension_job_queued",
      source: "aps",
      articleUrl,
      jobId: result.jobId,
      message: "Paper download job queued for the browser extension."
    });
    assert.equal(
      await readFile(jobsPath, "utf8"),
      `${JSON.stringify({
        jobId: result.jobId,
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

test("createQueuedPaperExtensionBridge gives repeated URL submissions distinct job ids", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-extension-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";

  try {
    const job = createPaperExtensionJob({
      articleUrl,
      source: "science"
    });
    const bridge = createQueuedPaperExtensionBridge({
      workspaceDir,
      now: () => new Date("2026-04-25T04:00:00.000Z")
    });

    const first = await bridge.submitJob(job);
    const second = await bridge.submitJob(job);

    assert.notEqual(first.jobId, second.jobId);
    assert.ok(first.jobId.startsWith(`${expectedJobId("science", articleUrl)}-`));
    assert.ok(second.jobId.startsWith(`${expectedJobId("science", articleUrl)}-`));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
