import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PaperDownloadError } from "../../src/agent/paper-download.js";
import type {
  PaperDownloadResult,
  PaperSearchResult
} from "../../src/agent/paper-types.js";
import * as agentTools from "../../src/agent/tools.js";
import { createTools } from "../../src/agent/tools.js";

type ToolContentItem = {
  type?: string;
  text?: string;
};

type ToolResult = {
  content?: ToolContentItem[];
  details?: unknown;
};

type ReadFileTool = {
  execute: (
    toolCallId: string,
    args: { path: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type GetTimeTool = {
  execute: (
    toolCallId: string,
    args: { timezone?: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type WebSearchTool = {
  execute: (
    toolCallId: string,
    args: { query: string; maxResults?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type FetchUrlTool = {
  execute: (
    toolCallId: string,
    args: { url: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type SearchPapersTool = {
  execute: (
    toolCallId: string,
    args: { query: string; maxResults?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type DownloadPaperTool = {
  execute: (
    toolCallId: string,
    args: { id?: string; url?: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type OpenPaperPageForLoginTool = {
  execute: (
    toolCallId: string,
    args: { url: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type CreateToolsDependencies = NonNullable<Parameters<typeof createTools>[1]>;

function getReadFileTool(workspace: string): ReadFileTool {
  const tools = createTools(workspace) as ReadonlyArray<{
    name: string;
    execute?: ReadFileTool["execute"];
  }>;
  const readFileTool = tools.find((tool) => tool.name === "read_file");
  assert.ok(readFileTool);
  assert.equal(typeof readFileTool.execute, "function");
  return readFileTool as ReadFileTool;
}

function getGetTimeTool(workspace: string): GetTimeTool {
  const tools = createTools(workspace) as ReadonlyArray<{
    name: string;
    execute?: GetTimeTool["execute"];
  }>;
  const getTimeTool = tools.find((tool) => tool.name === "get_time");
  assert.ok(getTimeTool);
  assert.equal(typeof getTimeTool.execute, "function");
  return getTimeTool as GetTimeTool;
}

function getWebSearchTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): WebSearchTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: WebSearchTool["execute"];
  }>;
  const webSearchTool = tools.find((tool) => tool.name === "web_search");
  assert.ok(webSearchTool);
  assert.equal(typeof webSearchTool.execute, "function");
  return webSearchTool as WebSearchTool;
}

function getFetchUrlTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): FetchUrlTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: FetchUrlTool["execute"];
  }>;
  const fetchUrlTool = tools.find((tool) => tool.name === "fetch_url");
  assert.ok(fetchUrlTool);
  assert.equal(typeof fetchUrlTool.execute, "function");
  return fetchUrlTool as FetchUrlTool;
}

function getSearchPapersTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): SearchPapersTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: SearchPapersTool["execute"];
  }>;
  const searchPapersTool = tools.find((tool) => tool.name === "search_papers");
  assert.ok(searchPapersTool);
  assert.equal(typeof searchPapersTool.execute, "function");
  return searchPapersTool as SearchPapersTool;
}

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

function getOpenPaperPageForLoginTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): OpenPaperPageForLoginTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: OpenPaperPageForLoginTool["execute"];
  }>;
  const openPaperPageForLoginTool = tools.find(
    (tool) => tool.name === "open_paper_page_for_login",
  );
  assert.ok(openPaperPageForLoginTool);
  assert.equal(typeof openPaperPageForLoginTool.execute, "function");
  return openPaperPageForLoginTool as OpenPaperPageForLoginTool;
}

async function createDirectoryLink(targetDir: string, linkDir: string): Promise<void> {
  await symlink(targetDir, linkDir, process.platform === "win32" ? "junction" : "dir");
}

test("read_file reads a UTF-8 file inside the workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const nested = path.join(workspace, "notes.txt");
  const expectedContent = "hello from workspace: 你好, cafe, Привет";
  await writeFile(nested, expectedContent, "utf8");

  try {
    const readFileTool = getReadFileTool(workspace);
    const result = await readFileTool.execute("call-1", { path: "notes.txt" }, undefined);
    const textPayload = result.content?.find(
      (item): item is { type: string; text: string } =>
        item.type === "text" && typeof item.text === "string" && item.text.includes(expectedContent),
    );
    assert.ok(textPayload);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file rejects escaping the workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const readFileTool = getReadFileTool(workspace);
    await assert.rejects(
      () => readFileTool.execute("call-2", { path: "../secret.txt" }, undefined),
      /outside the workspace/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file rejects absolute paths", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const absolutePath = path.join(workspace, "notes.txt");

  try {
    const readFileTool = getReadFileTool(workspace);
    await assert.rejects(
      () => readFileTool.execute("call-3", { path: absolutePath }, undefined),
      /absolute paths are not allowed/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file rejects a workspace link that resolves outside the workspace", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-link-"));
  const workspace = path.join(baseDir, "workspace");
  const outsideDir = path.join(baseDir, "outside");
  const linkedDir = path.join(workspace, "linked");
  await mkdir(workspace);
  await mkdir(outsideDir);
  await writeFile(path.join(outsideDir, "secret.txt"), "outside secret", "utf8");
  await createDirectoryLink(outsideDir, linkedDir);

  try {
    const readFileTool = getReadFileTool(workspace);
    await assert.rejects(
      () => readFileTool.execute("call-4", { path: "linked/secret.txt" }, undefined),
      /outside the workspace/i,
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("get_time returns text content", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const getTimeTool = getGetTimeTool(workspace);
    const result = await getTimeTool.execute("call-5", { timezone: "UTC" }, undefined);
    const textPayload = result.content?.find(
      (item): item is { type: string; text: string } =>
        item.type === "text" && typeof item.text === "string" && item.text.length > 0,
    );
    assert.ok(textPayload);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createTools exposes the unified built-in tool set", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace);
    const toolNames = tools.map((tool) => tool.name);
    assert.deepEqual(toolNames, [
      "get_time",
      "read_file",
      "web_search",
      "fetch_url",
      "search_papers",
      "download_paper",
      "open_paper_page_for_login",
    ]);

    const webSearchTool = tools.find((tool) => tool.name === "web_search");
    const searchPapersTool = tools.find((tool) => tool.name === "search_papers");
    assert.ok(webSearchTool);
    assert.ok(searchPapersTool);
    const webSearchMaxResults = (webSearchTool.parameters as {
      properties?: { maxResults?: { type?: string; description?: string; minimum?: number } };
    }).properties?.maxResults;
    const searchPapersMaxResults = (searchPapersTool.parameters as {
      properties?: { maxResults?: { type?: string; description?: string; minimum?: number } };
    }).properties?.maxResults;
    assert.equal(webSearchMaxResults?.type, "integer");
    assert.equal(webSearchMaxResults?.description, "Maximum number of results to return.");
    assert.equal(webSearchMaxResults?.minimum, 1);
    assert.equal(searchPapersMaxResults?.type, "integer");
    assert.equal(searchPapersMaxResults?.description, "Maximum number of results to return.");
    assert.equal(searchPapersMaxResults?.minimum, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("web_search delegates to the injected search client and returns JSON text with details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{ query: string; maxResults?: number }> = [];

  try {
    const webSearchTool = getWebSearchTool(workspace, {
      searchWeb: async (options) => {
        capturedCalls.push(options);
        return [
          {
            title: "Result title",
            url: "https://example.com/result",
            snippet: "Result snippet",
          },
        ];
      },
    });

    const result = await webSearchTool.execute(
      "call-6",
      { query: "latest pi agent docs", maxResults: 2 },
      undefined,
    );

    assert.deepEqual(capturedCalls, [{ query: "latest pi agent docs", maxResults: 2 }]);
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: JSON.stringify([
          {
            title: "Result title",
            url: "https://example.com/result",
            snippet: "Result snippet",
          },
        ]),
      },
    ]);
    assert.deepEqual(result.details, {
      query: "latest pi agent docs",
      maxResults: 2,
      count: 1,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fetch_url delegates to the injected fetch client and returns JSON text with details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{ url: string }> = [];

  try {
    const fetchUrlTool = getFetchUrlTool(workspace, {
      fetchWebPage: async (options) => {
        capturedCalls.push(options);
        return "Fetched page text";
      },
    });

    const result = await fetchUrlTool.execute(
      "call-7",
      { url: "https://example.com/article" },
      undefined,
    );

    assert.deepEqual(capturedCalls, [{ url: "https://example.com/article" }]);
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: JSON.stringify("Fetched page text"),
      },
    ]);
    assert.deepEqual(result.details, {
      url: "https://example.com/article",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search_papers delegates to the injected paper manager dependency and returns JSON text with details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{ query: string; maxResults?: number }> = [];
  const papers: PaperSearchResult[] = [
    {
      title: "Unified Paper Search",
      authors: ["Ada Lovelace"],
      summary: "Merged paper result.",
      primarySource: "science",
      primaryAction: "authorized_download",
      sources: [
        {
          source: "science",
          action: "authorized_download",
          articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
          canonicalId: "10.1126/science.adz8659",
        },
      ],
    },
  ];

  try {
    const searchPapersTool = getSearchPapersTool(workspace, {
      searchPapers: async (options) => {
        capturedCalls.push(options);
        return papers;
      },
    });

    const result = await searchPapersTool.execute(
      "call-8",
      { query: "tool adapters", maxResults: 3 },
      undefined,
    );

    assert.deepEqual(capturedCalls, [{ query: "tool adapters", maxResults: 3 }]);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(papers) }]);
    assert.deepEqual(result.details, {
      query: "tool adapters",
      maxResults: 3,
      count: 1,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper delegates id inputs to the injected paper manager dependency and returns manager details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const recordPath = path.join(workspace, "papers", "arxiv-2401.01234.json");
  const pdfPath = path.join(workspace, "papers", "arxiv-2401.01234.pdf");
  const capturedCalls: Array<{ workspaceDir: string; id?: string; url?: string }> = [];
  const managerResult: PaperDownloadResult = {
    status: "downloaded",
    source: "arxiv",
    canonicalId: "2401.01234",
    articleUrl: "https://arxiv.org/abs/2401.01234",
    finalPdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
    path: pdfPath,
    recordPath,
  };

  try {
    const downloadPaperTool = getDownloadPaperTool(workspace, {
      downloadPaper: async (options) => {
        capturedCalls.push(options);
        return managerResult;
      },
    });

    const result = await downloadPaperTool.execute(
      "call-9",
      { id: "2401.01234" },
      undefined,
    );

    assert.deepEqual(capturedCalls, [{ workspaceDir: workspace, id: "2401.01234" }]);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(managerResult) }]);
    assert.deepEqual(result.details, managerResult);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper delegates url inputs to the injected paper manager dependency and returns manager details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const recordPath = path.join(workspace, "papers", "science-10.1126-science.adz8659.json");
  const pdfPath = path.join(workspace, "papers", "science-10.1126-science.adz8659.pdf");
  const capturedCalls: Array<{ workspaceDir: string; id?: string; url?: string }> = [];
  const managerResult: PaperDownloadResult = {
    status: "downloaded",
    source: "science",
    canonicalId: "10.1126/science.adz8659",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
    path: pdfPath,
    recordPath,
  };

  try {
    const downloadPaperTool = getDownloadPaperTool(workspace, {
      downloadPaper: async (options) => {
        capturedCalls.push(options);
        return managerResult;
      },
    });

    const result = await downloadPaperTool.execute(
      "call-10",
      { url: "https://www.science.org/doi/10.1126/science.adz8659" },
      undefined,
    );

    assert.deepEqual(capturedCalls, [
      {
        workspaceDir: workspace,
        url: "https://www.science.org/doi/10.1126/science.adz8659",
      },
    ]);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(managerResult) }]);
    assert.deepEqual(result.details, managerResult);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("open_paper_page_for_login rejects unsupported publisher URLs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const opened: string[] = [];

  try {
    const openPaperPageForLoginTool = getOpenPaperPageForLoginTool(workspace, {
      openPaperPageForLogin: async (options) => {
        opened.push(options.url);
        return {
          url: options.url,
          openedUrl: options.url,
          profileDir: path.join(options.workspaceDir, ".browser-profile", "paper-access"),
          executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        };
      },
    });

    await assert.rejects(
      () =>
        openPaperPageForLoginTool.execute(
          "tool-call-open-login-1",
          { url: "https://example.com/paper" },
          undefined,
        ),
      /unsupported publisher/i,
    );
    assert.deepEqual(opened, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("open_paper_page_for_login rejects non-http(s) URLs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const opened: string[] = [];

  try {
    const openPaperPageForLoginTool = getOpenPaperPageForLoginTool(workspace, {
      openPaperPageForLogin: async (options) => {
        opened.push(options.url);
        return {
          url: options.url,
          openedUrl: options.url,
          profileDir: path.join(options.workspaceDir, ".browser-profile", "paper-access"),
          executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        };
      },
    });

    await assert.rejects(
      () =>
        openPaperPageForLoginTool.execute(
          "tool-call-open-login-2",
          { url: "file:///tmp/paper.html" },
          undefined,
        ),
      /http\(s\)|http or https/i,
    );
    assert.deepEqual(opened, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("open_paper_page_for_login delegates to the injected paper manager client", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const calls: Array<{ url: string }> = [];

  try {
    const openPaperPageForLoginTool = getOpenPaperPageForLoginTool(workspace, {
      paperBrowserManagerClient: {
        async openArticle(request: { url: string }) {
          calls.push(request);
          return {
            openedUrl: request.url,
            profileDir: path.join(workspace, ".browser-profile", "paper-access"),
          };
        },
        async downloadPaperPdf(): Promise<never> {
          throw new Error("download should not be called");
        },
        async close() {},
      },
    } as unknown as CreateToolsDependencies);

    const result = await openPaperPageForLoginTool.execute(
      "tool-call-11",
      {
        url: "https://www.science.org/doi/10.1126/science.adz8659",
      },
      undefined,
    );

    assert.deepEqual(calls, [
      {
        url: "https://www.science.org/doi/10.1126/science.adz8659",
      },
    ]);
    assert.deepEqual(JSON.parse(String(result.content?.[0]?.text)), {
      openedUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
    });
    assert.deepEqual(result.details, {
      openedUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper uses the injected paper manager client for supported-publisher fallback without creating a browser session", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const events: string[] = [];

  try {
    const tools = createTools(workspace, {
      browserSessionFactory: async () => {
        throw new Error("browserSessionFactory should not be called");
      },
      paperBrowserManagerClient: {
        async openArticle(request: { url: string }) {
          events.push(`openArticle:${request.url}`);
          return {
            openedUrl: request.url,
            profileDir: path.join(workspace, ".browser-profile", "paper-access"),
          };
        },
        async downloadPaperPdf(): Promise<never> {
          throw new PaperDownloadError(
            "manual_login_required",
            "The browser session needs manual login or verification for this publisher.",
          );
        },
        async close() {
          events.push("close");
        },
      },
    } as unknown as CreateToolsDependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperTool["execute"];
    }>;
    const tool = tools.find((candidate) => candidate.name === "download_paper");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    const result = await execute(
      "tool-call-12",
      { url: "https://www.science.org/doi/10.1126/science.adz8659" },
      undefined,
    );

    assert.deepEqual(result.details, {
      status: "manual_fallback_opened",
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      fallbackUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      recordPath: path.join(
        workspace,
        "downloads",
        "papers",
        "index",
        "science-10.1126-science.adz8659.json",
      ),
      failure: {
        code: "manual_login_required",
        message: "The browser session needs manual login or verification for this publisher.",
      },
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: undefined,
    });
    assert.deepEqual(events, [
      "openArticle:https://www.science.org/doi/10.1126/science.adz8659",
    ]);

    await agentTools.cleanupTools(tools as ReturnType<typeof createTools>);
    assert.deepEqual(events, [
      "openArticle:https://www.science.org/doi/10.1126/science.adz8659",
      "close",
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper opens manual fallback when the manager client download is not a real PDF", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const downloadedPath = path.join(workspace, "downloads", "papers", "science-invalid.pdf");
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";
  const events: string[] = [];

  try {
    await mkdir(path.dirname(downloadedPath), { recursive: true });
    await writeFile(downloadedPath, "<html>not a pdf</html>", "utf8");

    const tool = getDownloadPaperTool(workspace, {
      paperBrowserManagerClient: {
        async openArticle(request: { url: string }) {
          events.push(`openArticle:${request.url}`);
          return {
            openedUrl: request.url,
            profileDir: path.join(workspace, ".browser-profile", "paper-access"),
          };
        },
        async downloadPaperPdf(request: { url: string }) {
          events.push(`downloadPaperPdf:${request.url}`);
          return {
            status: "downloaded" as const,
            publisher: "science" as const,
            articleUrl: request.url,
            finalArticleUrl: request.url,
            finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
            path: downloadedPath,
          };
        },
        async close() {},
      },
    } as unknown as CreateToolsDependencies);

    const result = await tool.execute("tool-call-invalid-pdf", { url: articleUrl }, undefined);

    assert.deepEqual(result.details, {
      status: "manual_fallback_opened",
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl,
      fallbackUrl: articleUrl,
      recordPath: path.join(
        workspace,
        "downloads",
        "papers",
        "index",
        "science-10.1126-science.adz8659.json",
      ),
      failure: {
        code: "download_failed",
        message: "Downloaded file is not a valid PDF.",
      },
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: undefined,
    });
    assert.deepEqual(events, [
      `downloadPaperPdf:${articleUrl}`,
      `openArticle:${articleUrl}`,
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper opens manual fallback when the manager client returns a coded download error", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601";
  const events: string[] = [];

  try {
    const tool = getDownloadPaperTool(workspace, {
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
          const error = new Error("Timed out waiting for PDF download.") as Error & {
            code: string;
          };
          error.code = "download_failed";
          throw error;
        },
        async close() {},
      },
    } as unknown as CreateToolsDependencies);

    const result = await tool.execute("tool-call-remote-download-failed", { url: articleUrl }, undefined);

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
        code: "download_failed",
        message: "Timed out waiting for PDF download.",
      },
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: undefined,
    });
    assert.deepEqual(events, [
      `downloadPaperPdf:${articleUrl}`,
      `openArticle:${articleUrl}`,
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper opens manual fallback when canonicalId cannot be derived from manager client URLs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const downloadedPath = path.join(workspace, "downloads", "papers", "science-derived.pdf");
  const articleUrl = "https://www.science.org/toc/science/current";
  const events: string[] = [];
  const fallbackCanonicalId = `www.science.org-${createHash("sha1").update(articleUrl).digest("hex").slice(0, 12)}`;

  try {
    await mkdir(path.dirname(downloadedPath), { recursive: true });
    await writeFile(downloadedPath, "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n", "utf8");

    const tool = getDownloadPaperTool(workspace, {
      paperBrowserManagerClient: {
        async openArticle(request: { url: string }) {
          events.push(`openArticle:${request.url}`);
          return {
            openedUrl: request.url,
            profileDir: path.join(workspace, ".browser-profile", "paper-access"),
          };
        },
        async downloadPaperPdf(request: { url: string }) {
          events.push(`downloadPaperPdf:${request.url}`);
          return {
            status: "downloaded" as const,
            publisher: "science" as const,
            articleUrl: request.url,
            finalArticleUrl: "https://www.science.org/toc/science/current",
            finalPdfUrl: "https://www.science.org/action/showPdf?pii=adz8659",
            path: downloadedPath,
          };
        },
        async close() {},
      },
    } as unknown as CreateToolsDependencies);

    const result = await tool.execute("tool-call-missing-canonical-id", { url: articleUrl }, undefined);

    assert.deepEqual(result.details, {
      status: "manual_fallback_opened",
      source: "science",
      canonicalId: fallbackCanonicalId,
      articleUrl,
      fallbackUrl: articleUrl,
      recordPath: path.join(
        workspace,
        "downloads",
        "papers",
        "index",
        `science-${fallbackCanonicalId}.json`,
      ),
      failure: {
        code: "download_failed",
        message: "Unable to resolve a canonical paper identifier from the publisher article URL.",
      },
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: undefined,
    });
    assert.deepEqual(events, [
      `downloadPaperPdf:${articleUrl}`,
      `openArticle:${articleUrl}`,
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createTools cleanup closes the injected paper manager client exactly once", async () => {
  const cleanupTools = (
    agentTools as {
      cleanupTools?: (tools: ReturnType<typeof createTools>) => Promise<void>;
    }
  ).cleanupTools;
  assert.equal(typeof cleanupTools, "function");

  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  let closeCalls = 0;

  try {
    const tools = createTools(workspace, {
      paperBrowserManagerClient: {
        async openArticle(): Promise<never> {
          throw new Error("open should not be called");
        },
        async downloadPaperPdf(): Promise<never> {
          throw new Error("download should not be called");
        },
        async close() {
          closeCalls += 1;
        },
      },
    } as unknown as CreateToolsDependencies);

    await cleanupTools!(tools as ReturnType<typeof createTools>);
    await cleanupTools!(tools as ReturnType<typeof createTools>);

    assert.equal(closeCalls, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
