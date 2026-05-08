import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PaperExtensionBridge } from "../../src/agent/paper-extension-bridge.js";
import type { createTools as CreateToolsFunction } from "../../src/agent/tools.js";

const agentModulePrefix = import.meta.url.includes("/dist/test/")
  ? "../../src/agent"
  : "../../dist/src/agent";
const { PaperDownloadError } = await import(
  `${agentModulePrefix}/paper-download.js`
) as typeof import("../../src/agent/paper-download.js");
const { createTools } = await import(`${agentModulePrefix}/tools.js`) as {
  createTools: typeof CreateToolsFunction;
};

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

type WikiHealthFixTool = {
  execute: (
    toolCallId: string,
    args: { issueKinds?: string[] },
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

function getWikiHealthFixTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): WikiHealthFixTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: WikiHealthFixTool["execute"];
  }>;
  const wikiHealthFixTool = tools.find((tool) => tool.name === "wiki_health_fix");
  assert.ok(wikiHealthFixTool);
  assert.equal(typeof wikiHealthFixTool.execute, "function");
  return wikiHealthFixTool as WikiHealthFixTool;
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
        message: "Paper extension bridge is not configured, and no direct PDF or exact-title open fallback was available.",
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
    assert.deepEqual(submittedJobs[0], {
      jobId: (submittedJobs[0] as { jobId: string }).jobId,
      articleUrl,
      source: "nature",
      purpose: "download_and_webpage",
    });
    assert.deepEqual(result.details, {
      status: "extension_job_queued",
      source: "nature",
      articleUrl,
      jobId: (submittedJobs[0] as { jobId: string }).jobId,
      message: "Queued by injected extension bridge.",
      reading: {
        status: "queued",
        strategy: "webpage",
        jobId: (submittedJobs[0] as { jobId: string }).jobId,
        message:
          "Browser extension will first capture and parse the publisher webpage. PDF download starts only if the webpage markdown quality is good; otherwise the job waits for user login or access verification.",
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki_health_fix routes download repairs through the injected extension bridge", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-extension-"));
  const articleUrl = "https://www.science.org/doi/10.1126/sciadv.adp6388";
  const submittedJobs: unknown[] = [];
  const extensionBridge: PaperExtensionBridge = {
    async submitJob(job) {
      submittedJobs.push(job);
      return {
        status: "extension_job_queued",
        source: job.source,
        articleUrl: job.articleUrl,
        jobId: job.jobId,
        message: "Queued by wiki health repair.",
      };
    },
  };

  try {
    const tool = getWikiHealthFixTool(workspace, {
      extensionBridge,
      fixWikiHealth: async (options) => {
        assert.equal(typeof options.downloadPaperImpl, "function");
        const download = await options.downloadPaperImpl?.({
          workspaceDir: options.workspaceDir,
          url: articleUrl,
          title: "High-performance fault-tolerant quantum computing with many-hypercube codes",
        });
        return {
          checked: {
            totalPapers: 1,
            issueCount: 1,
            summary: {
              needs_download: 1,
              needs_authorization: 0,
              queued: 0,
              parse_missing: 0,
              parse_failed: 0,
              low_quality: 0,
              summary_missing: 0,
              missing_artifact: 0,
              download_blocked: 0,
              citation_incomplete: 0,
            },
            issues: [
              {
                kind: "needs_download",
                severity: "medium",
                paperKey: "science-10.1126-sciadv.adp6388",
                source: "science",
                title: "High-performance fault-tolerant quantum computing with many-hypercube codes",
                articleUrl,
                reason: "Publisher webpage parsing artifacts exist, but no local PDF file has been downloaded.",
              },
            ],
            actions: ["Retry downloads."],
          },
          attempted: 1,
          fixed: 0,
          queued: download?.status === "extension_job_queued" ? 1 : 0,
          skipped: 0,
          failed: 0,
          results: [
            {
              issue: {
                kind: "needs_download",
                severity: "medium",
                paperKey: "science-10.1126-sciadv.adp6388",
                source: "science",
                title: "High-performance fault-tolerant quantum computing with many-hypercube codes",
                articleUrl,
                reason: "Publisher webpage parsing artifacts exist, but no local PDF file has been downloaded.",
              },
              status: "queued",
              action: "download",
              message: "Browser extension job was queued.",
              details: download,
            },
          ],
        };
      },
    });

    const result = await tool.execute("wiki-health-extension", { issueKinds: ["needs_download"] }, undefined);

    assert.equal(submittedJobs.length, 1);
    assert.deepEqual(submittedJobs[0], {
      jobId: (submittedJobs[0] as { jobId: string }).jobId,
      articleUrl,
      source: "science",
      title: "High-performance fault-tolerant quantum computing with many-hypercube codes",
      purpose: "download_and_webpage",
    });
    assert.equal((result.details as { queued?: number }).queued, 1);
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
      recordPath: path.join(workspace, "knowledge-base", "wiki", "sources", "aps-10.1103-PhysRevLett.134.090601", "acquisition.json"),
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
