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
