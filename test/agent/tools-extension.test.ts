import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PaperDownloadError } from "../../src/agent/paper-download.js";
import type { PaperExtensionBridge } from "../../src/agent/paper-extension-bridge.js";
import { createTools } from "../../src/agent/tools.js";

type ToolContentItem = {
  type?: string;
  text?: string;
};

type ToolResult = {
  content?: ToolContentItem[];
  details?: unknown;
};

type DownloadPaperTool = {
  execute: (
    toolCallId: string,
    args: { id?: string; url?: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type DownloadLatestApsPapersTool = {
  execute: (
    toolCallId: string,
    args: { query: string; maxResults?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type CreateToolsDependencies = NonNullable<Parameters<typeof createTools>[1]>;

function getDownloadPaperTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): DownloadPaperTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: DownloadPaperTool["execute"];
  }>;
  const downloadPaperTool = tools.find((tool) => tool.name === "download_paper");
  assert.ok(downloadPaperTool);
  assert.equal(typeof downloadPaperTool.execute, "function");
  return downloadPaperTool as DownloadPaperTool;
}

function getDownloadLatestApsPapersTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): DownloadLatestApsPapersTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: DownloadLatestApsPapersTool["execute"];
  }>;
  const downloadLatestApsPapersTool = tools.find(
    (tool) => tool.name === "download_latest_aps_papers",
  );
  assert.ok(downloadLatestApsPapersTool);
  assert.equal(typeof downloadLatestApsPapersTool.execute, "function");
  return downloadLatestApsPapersTool as DownloadLatestApsPapersTool;
}

test("download_paper reports extension_unavailable when no bridge is configured", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-extension-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";
  const fallbackCalls: string[] = [];

  try {
    const tool = getDownloadPaperTool(workspace, {
      paperBrowserManagerClient: {
        async openArticle(request: { url: string }) {
          fallbackCalls.push(`openArticle:${request.url}`);
          throw new Error("legacy fallback should not open without explicit opt-in");
        },
        async downloadPaperPdf(request: { url: string }): Promise<never> {
          fallbackCalls.push(`downloadPaperPdf:${request.url}`);
          throw new Error("legacy fallback should not download without explicit opt-in");
        },
        async close() {},
      },
    } as unknown as CreateToolsDependencies);

    const result = await tool.execute("tool-extension-unavailable", { url: articleUrl }, undefined);

    assert.deepEqual(fallbackCalls, []);
    assert.deepEqual(result.details, {
      status: "extension_unavailable",
      source: "science",
      articleUrl,
      failure: {
        code: "extension_unavailable",
        message: "Paper extension bridge is not configured. Set usePlaywrightFallback to true to use browser fallback.",
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper uses injected extension bridge for publisher URLs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-extension-"));
  const articleUrl = "https://www.nature.com/articles/s41586-024-12345-6";
  const submittedJobs: unknown[] = [];
  const extensionBridge: PaperExtensionBridge = {
    async submitJob(job) {
      submittedJobs.push(job);
      return {
        status: "extension_job_queued",
        source: job.source,
        articleUrl: job.articleUrl,
        jobId: job.jobId,
        message: "Queued by injected extension bridge.",
      };
    },
  };

  try {
    const tool = getDownloadPaperTool(workspace, { extensionBridge });

    const result = await tool.execute("tool-extension-publisher", { url: articleUrl }, undefined);

    assert.equal(submittedJobs.length, 1);
    assert.deepEqual(result.details, {
      status: "extension_job_queued",
      source: "nature",
      articleUrl,
      jobId: (submittedJobs[0] as { jobId: string }).jobId,
      message: "Queued by injected extension bridge.",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper uses injected extension bridge for external URLs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-extension-"));
  const articleUrl = "https://example.com/research-paper";
  const submittedJobs: unknown[] = [];
  const extensionBridge: PaperExtensionBridge = {
    async submitJob(job) {
      submittedJobs.push(job);
      return {
        status: "opened_in_user_browser",
        source: job.source,
        articleUrl: job.articleUrl,
        jobId: job.jobId,
        message: "Opened by injected extension bridge.",
      };
    },
  };

  try {
    const tool = getDownloadPaperTool(workspace, { extensionBridge });

    const result = await tool.execute("tool-extension-external", { url: articleUrl }, undefined);

    assert.deepEqual(submittedJobs, [
      {
        jobId: (submittedJobs[0] as { jobId: string }).jobId,
        articleUrl,
        source: "external",
      },
    ]);
    assert.deepEqual(result.details, {
      status: "opened_in_user_browser",
      source: "external",
      articleUrl,
      jobId: (submittedJobs[0] as { jobId: string }).jobId,
      message: "Opened by injected extension bridge.",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper allows legacy fallback when usePlaywrightPaperFallback is explicit", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-extension-"));
  const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601";
  const events: string[] = [];

  try {
    const tool = getDownloadPaperTool(workspace, {
      usePlaywrightPaperFallback: true,
      paperBrowserManagerClient: {
        async openArticle(request: { url: string }) {
          events.push(`openArticle:${request.url}`);
          return {
            openedUrl: request.url,
            profileDir: path.join(workspace, ".browser-profile", "paper-access"),
          };
        },
        async downloadPaperPdf(request: { url: string }): Promise<never> {
          events.push(`downloadPaperPdf:${request.url}`);
          throw new PaperDownloadError("manual_login_required", "APS requires manual verification.");
        },
        async close() {},
      },
    } as unknown as CreateToolsDependencies);

    const result = await tool.execute("tool-extension-fallback", { url: articleUrl }, undefined);

    assert.deepEqual(events, [
      `downloadPaperPdf:${articleUrl}`,
      `openArticle:${articleUrl}`,
    ]);
    assert.deepEqual(result.details, {
      status: "manual_fallback_opened",
      source: "aps",
      canonicalId: "10.1103/PhysRevLett.134.090601",
      articleUrl,
      fallbackUrl: articleUrl,
      recordPath: path.join(
        workspace,
        "downloads",
        "papers",
        "index",
        "aps-10.1103-PhysRevLett.134.090601.json",
      ),
      failure: {
        code: "manual_login_required",
        message: "APS requires manual verification.",
      },
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: undefined,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_latest_aps_papers preserves cooldown manual-open fallback with an extension bridge", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-extension-"));
  const articleUrls = [
    "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
    "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090602",
  ];
  const bridgeCalls: string[] = [];
  const downloadAttempts: string[] = [];
  const opened: string[] = [];
  const extensionBridge: PaperExtensionBridge = {
    async submitJob(job) {
      bridgeCalls.push(job.articleUrl);
      if (job.articleUrl === articleUrls[0]) {
        throw new Error("extension unavailable for first APS paper");
      }

      return {
        status: "extension_job_queued",
        source: job.source,
        articleUrl: job.articleUrl,
        jobId: job.jobId,
        message: "This should not be queued during cooldown manual handoff.",
      };
    },
  };

  try {
    const tool = getDownloadLatestApsPapersTool(workspace, {
      usePlaywrightPaperFallback: true,
      extensionBridge,
      searchApsPapers: async () =>
        articleUrls.map((articleUrl, index) => ({
          title: `APS paper ${index + 1}`,
          authors: [],
          summary: "Published in Physical Review Letters.",
          primarySource: "aps" as const,
          primaryAction: "authorized_download" as const,
          sources: [
            {
              source: "aps" as const,
              action: "authorized_download" as const,
              canonicalId: articleUrl.slice(articleUrl.lastIndexOf("/") + 1),
              articleUrl,
            },
          ],
        })),
      paperBrowserManagerClient: {
        async openArticle(request: { url: string }) {
          opened.push(request.url);
          return {
            openedUrl:
              request.url === articleUrls[0]
                ? `${request.url}?__cf_chl_rt_tk=blocked`
                : `${request.url}?manual=1`,
            profileDir: path.join(workspace, ".browser-profile", "paper-access"),
          };
        },
        async downloadPaperPdf(request: { url: string }): Promise<never> {
          downloadAttempts.push(request.url);
          throw new PaperDownloadError("download_failed", "Timed out waiting for PDF download.");
        },
        async close() {},
      },
    } as unknown as CreateToolsDependencies);

    const result = await tool.execute(
      "tool-extension-latest-aps-cloudflare",
      { query: "superconducting quantum computing", maxResults: 2 },
      undefined,
    );

    assert.deepEqual(bridgeCalls, [articleUrls[0]]);
    assert.deepEqual(downloadAttempts, [articleUrls[0]]);
    assert.deepEqual(opened, articleUrls);
    const details = result.details as {
      results: Array<{ articleUrl: string; download: { status: string; failure?: { code: string } } }>;
    };
    assert.deepEqual(
      details.results.map((entry) => ({
        articleUrl: entry.articleUrl,
        status: entry.download.status,
        failureCode: entry.download.failure?.code,
      })),
      [
        {
          articleUrl: articleUrls[0],
          status: "manual_fallback_opened",
          failureCode: "download_failed",
        },
        {
          articleUrl: articleUrls[1],
          status: "manual_fallback_opened",
          failureCode: "recent_cloudflare_block",
        },
      ],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_latest_aps_papers queues only the first APS extension job per batch", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-extension-"));
  const articleUrls = [
    "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
    "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090602",
    "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090603",
  ];
  const bridgeCalls: string[] = [];
  const downloadAttempts: string[] = [];
  const opened: string[] = [];
  const extensionBridge: PaperExtensionBridge = {
    async submitJob(job) {
      bridgeCalls.push(job.articleUrl);
      return {
        status: "extension_job_queued",
        source: job.source,
        articleUrl: job.articleUrl,
        jobId: job.jobId,
        message: "Queued by extension bridge.",
      };
    },
  };

  try {
    const tool = getDownloadLatestApsPapersTool(workspace, {
      usePlaywrightPaperFallback: true,
      extensionBridge,
      searchApsPapers: async () =>
        articleUrls.map((articleUrl, index) => ({
          title: `APS paper ${index + 1}`,
          authors: [],
          summary: "Published in Physical Review Letters.",
          primarySource: "aps" as const,
          primaryAction: "authorized_download" as const,
          sources: [
            {
              source: "aps" as const,
              action: "authorized_download" as const,
              canonicalId: articleUrl.slice(articleUrl.lastIndexOf("/") + 1),
              articleUrl,
            },
          ],
        })),
      paperBrowserManagerClient: {
        async openArticle(request: { url: string }) {
          opened.push(request.url);
          return {
            openedUrl: `${request.url}?manual=1`,
            profileDir: path.join(workspace, ".browser-profile", "paper-access"),
          };
        },
        async downloadPaperPdf(request: { url: string }): Promise<never> {
          downloadAttempts.push(request.url);
          throw new Error("Playwright fallback should not attempt APS batch downloads after queueing.");
        },
        async close() {},
      },
    } as unknown as CreateToolsDependencies);

    const result = await tool.execute(
      "tool-extension-latest-aps-single-queue",
      { query: "superconducting quantum computing", maxResults: 3 },
      undefined,
    );

    assert.deepEqual(bridgeCalls, [articleUrls[0]]);
    assert.deepEqual(downloadAttempts, []);
    assert.deepEqual(opened, articleUrls.slice(1));
    const details = result.details as {
      results: Array<{ articleUrl: string; download: { status: string; failure?: { code: string } } }>;
    };
    assert.deepEqual(
      details.results.map((entry) => ({
        articleUrl: entry.articleUrl,
        status: entry.download.status,
        failureCode: entry.download.failure?.code,
      })),
      [
        {
          articleUrl: articleUrls[0],
          status: "extension_job_queued",
          failureCode: undefined,
        },
        {
          articleUrl: articleUrls[1],
          status: "manual_fallback_opened",
          failureCode: "aps_extension_job_pending",
        },
        {
          articleUrl: articleUrls[2],
          status: "manual_fallback_opened",
          failureCode: "aps_extension_job_pending",
        },
      ],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
