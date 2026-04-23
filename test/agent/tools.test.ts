import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PaperDownloadError } from "../../src/agent/paper-download.js";
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

type SearchArxivTool = {
  execute: (
    toolCallId: string,
    args: { query: string; maxResults?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type DownloadArxivPdfTool = {
  execute: (
    toolCallId: string,
    args: { id: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type DownloadPaperPdfTool = {
  execute: (
    toolCallId: string,
    args: { url: string },
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

function getSearchArxivTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): SearchArxivTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: SearchArxivTool["execute"];
  }>;
  const searchArxivTool = tools.find((tool) => tool.name === "search_arxiv");
  assert.ok(searchArxivTool);
  assert.equal(typeof searchArxivTool.execute, "function");
  return searchArxivTool as SearchArxivTool;
}

function getDownloadArxivPdfTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): DownloadArxivPdfTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: DownloadArxivPdfTool["execute"];
  }>;
  const downloadArxivPdfTool = tools.find((tool) => tool.name === "download_arxiv_pdf");
  assert.ok(downloadArxivPdfTool);
  assert.equal(typeof downloadArxivPdfTool.execute, "function");
  return downloadArxivPdfTool as DownloadArxivPdfTool;
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
  const expectedContent = "hello from workspace: 你好, café, Привет";
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

test("createTools exposes the full built-in tool set", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace);
    const toolNames = tools.map((tool) => tool.name);
    assert.deepEqual(toolNames, [
      "get_time",
      "read_file",
      "web_search",
      "fetch_url",
      "search_arxiv",
      "download_arxiv_pdf",
      "open_paper_page_for_login",
      "download_paper_pdf",
    ]);

    const webSearchTool = tools.find((tool) => tool.name === "web_search");
    const searchArxivTool = tools.find((tool) => tool.name === "search_arxiv");
    assert.ok(webSearchTool);
    assert.ok(searchArxivTool);
    const webSearchMaxResults = (webSearchTool.parameters as {
      properties?: { maxResults?: { type?: string; description?: string; minimum?: number } };
    }).properties?.maxResults;
    const searchArxivMaxResults = (searchArxivTool.parameters as {
      properties?: { maxResults?: { type?: string; description?: string; minimum?: number } };
    }).properties?.maxResults;
    assert.equal(webSearchMaxResults?.type, "integer");
    assert.equal(webSearchMaxResults?.description, "Maximum number of results to return.");
    assert.equal(webSearchMaxResults?.minimum, 1);
    assert.equal(searchArxivMaxResults?.type, "integer");
    assert.equal(searchArxivMaxResults?.description, "Maximum number of results to return.");
    assert.equal(searchArxivMaxResults?.minimum, 1);
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

test("search_arxiv delegates to the injected arXiv client and returns JSON text with details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{ query: string; maxResults?: number }> = [];

  try {
    const searchArxivTool = getSearchArxivTool(workspace, {
      searchArxiv: async (options) => {
        capturedCalls.push(options);
        return [
          {
            id: "2401.01234",
            title: "Test Paper",
            authors: ["Ada Lovelace"],
            summary: "Paper summary",
            absUrl: "https://arxiv.org/abs/2401.01234",
            pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
          },
        ];
      },
    });

    const result = await searchArxivTool.execute(
      "call-8",
      { query: "tool adapters", maxResults: 3 },
      undefined,
    );

    assert.deepEqual(capturedCalls, [{ query: "tool adapters", maxResults: 3 }]);
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: JSON.stringify([
          {
            id: "2401.01234",
            title: "Test Paper",
            authors: ["Ada Lovelace"],
            summary: "Paper summary",
            absUrl: "https://arxiv.org/abs/2401.01234",
            pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
          },
        ]),
      },
    ]);
    assert.deepEqual(result.details, {
      query: "tool adapters",
      maxResults: 3,
      count: 1,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_arxiv_pdf returns the canonical PDF URL", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const downloadArxivPdfTool = getDownloadArxivPdfTool(workspace);

    const result = await downloadArxivPdfTool.execute(
      "call-9",
      { id: "2401.01234v2" },
      undefined,
    );

    assert.deepEqual(result.content, [
      {
        type: "text",
        text: "https://arxiv.org/pdf/2401.01234.pdf",
      },
    ]);
    assert.deepEqual(result.details, {
      id: "2401.01234v2",
      pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf delegates to the injected paper download service", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{ url: string; workspaceDir: string }> = [];
  const pdfPath = path.join(workspace, "downloads", "papers", "paper.pdf");

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, Buffer.from("%PDF-delegated"));

    const tools = createTools(workspace, {
      downloadPaperPdf: async (
        options: Parameters<NonNullable<CreateToolsDependencies["downloadPaperPdf"]>>[0],
      ) => {
        capturedCalls.push({ url: options.url, workspaceDir: options.workspaceDir });
        return {
          path: pdfPath,
          publisher: "science",
          articleUrl: options.url,
          finalArticleUrl: options.url,
          finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
        };
      },
    }) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);
    assert.equal(typeof execute, "function");

    const result = await execute(
      "tool-call-1",
      {
        url: "https://www.science.org/doi/10.1126/science.adz8659",
      },
      undefined,
    );

    assert.deepEqual(capturedCalls, [
      {
        url: "https://www.science.org/doi/10.1126/science.adz8659",
        workspaceDir: workspace,
      },
    ]);
    assert.deepEqual(JSON.parse(String(result.content?.[0]?.text)), {
      status: "downloaded",
      path: pdfPath,
      publisher: "science",
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      finalArticleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf returns downloaded status for a valid PDF result", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const pdfPath = path.join(workspace, "downloads", "papers", "downloaded-paper.pdf");

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, Buffer.from("%PDF-test"));

    const tools = createTools(workspace, {
      downloadPaperPdf: async (
        options: Parameters<NonNullable<CreateToolsDependencies["downloadPaperPdf"]>>[0],
      ) => ({
        path: pdfPath,
        publisher: "science",
        articleUrl: options.url,
        finalArticleUrl: options.url,
        finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
      }),
      openPaperPageForLogin: async () => {
        throw new Error("manual fallback should not run for valid PDFs");
      },
    } as unknown as CreateToolsDependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    const result = await execute(
      "tool-call-fallback-1",
      { url: "https://www.science.org/doi/10.1126/science.adz8659" },
      undefined,
    );

    assert.deepEqual(JSON.parse(String(result.content?.[0]?.text)), {
      status: "downloaded",
      path: pdfPath,
      publisher: "science",
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      finalArticleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf opens manual fallback and returns non-error details for fallback-eligible failures", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const opened: Array<{ url: string; workspaceDir: string }> = [];

  try {
    const tools = createTools(workspace, {
      downloadPaperPdf: async (): Promise<never> => {
        throw new PaperDownloadError(
          "manual_login_required",
          "The browser session needs manual login or verification for this publisher.",
        );
      },
      openPaperPageForLogin: async (options: { url: string; workspaceDir: string }) => {
        opened.push(options);
        return {
          url: options.url,
          openedUrl: options.url,
          profileDir: path.join(options.workspaceDir, ".browser-profile", "paper-access"),
          executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        };
      },
    } as unknown as CreateToolsDependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    const result = await execute(
      "tool-call-fallback-2",
      { url: "https://www.science.org/doi/10.1126/science.adz8659" },
      undefined,
    );

    assert.deepEqual(opened, [
      {
        url: "https://www.science.org/doi/10.1126/science.adz8659",
        workspaceDir: workspace,
      },
    ]);
    assert.deepEqual(JSON.parse(String(result.content?.[0]?.text)), {
      status: "manual_fallback_opened",
      fallbackRequired: true,
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      fallbackUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      failure: {
        code: "manual_login_required",
        message: "The browser session needs manual login or verification for this publisher.",
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf disposes the cached default browser session before opening manual fallback", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const events: string[] = [];

  try {
    const tools = createTools(workspace, {
      browserSessionFactory: async () => ({
        async openArticlePage(url: string) {
          events.push(`openArticlePage:${url}`);
          return {
            finalArticleUrl: url,
            html: "<html></html>",
            authorized: false,
          };
        },
        async openPageForManualLogin(url: string) {
          events.push(`sessionManualLogin:${url}`);
          return {
            openedUrl: url,
          };
        },
        async downloadPdf() {
          throw new Error("downloadPdf should not run when authorization fails");
        },
        async dispose() {
          events.push("dispose");
        },
      }),
      openPaperPageForLogin: async (options: { url: string; workspaceDir: string }) => {
        events.push(`fallbackOpen:${options.url}`);
        return {
          url: options.url,
          openedUrl: options.url,
          profileDir: path.join(options.workspaceDir, ".browser-profile", "paper-access"),
          executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        };
      },
    } as unknown as CreateToolsDependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    const result = await execute(
      "tool-call-fallback-dispose",
      { url: "https://www.science.org/doi/10.1126/science.adz8659" },
      undefined,
    );

    assert.equal(
      (result.details as { status?: string }).status,
      "manual_fallback_opened",
    );
    assert.deepEqual(events, [
      "openArticlePage:https://www.science.org/doi/10.1126/science.adz8659",
      "dispose",
      "fallbackOpen:https://www.science.org/doi/10.1126/science.adz8659",
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf opens manual fallback when the downloaded file is not a PDF", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const fakePdfPath = path.join(workspace, "downloads", "papers", "downloaded-paper.pdf");
  const opened: Array<{ url: string; workspaceDir: string }> = [];

  try {
    await mkdir(path.dirname(fakePdfPath), { recursive: true });
    await writeFile(fakePdfPath, "<!doctype html>", "utf8");

    const tools = createTools(workspace, {
      downloadPaperPdf: async (
        options: Parameters<NonNullable<CreateToolsDependencies["downloadPaperPdf"]>>[0],
      ) => ({
        path: fakePdfPath,
        publisher: "nature",
        articleUrl: options.url,
        finalArticleUrl: options.url,
        finalPdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf",
      }),
      openPaperPageForLogin: async (options: { url: string; workspaceDir: string }) => {
        opened.push(options);
        return {
          url: options.url,
          openedUrl: options.url,
          profileDir: path.join(options.workspaceDir, ".browser-profile", "paper-access"),
          executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        };
      },
    } as unknown as CreateToolsDependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    const result = await execute(
      "tool-call-fallback-3",
      { url: "https://www.nature.com/articles/s41586-019-1666-5" },
      undefined,
    );

    assert.deepEqual(opened, [
      {
        url: "https://www.nature.com/articles/s41586-019-1666-5",
        workspaceDir: workspace,
      },
    ]);
    assert.deepEqual(JSON.parse(String(result.content?.[0]?.text)), {
      status: "manual_fallback_opened",
      fallbackRequired: true,
      articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
      fallbackUrl: "https://www.nature.com/articles/s41586-019-1666-5",
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      failure: {
        code: "download_failed",
        message: `Downloaded file is not a valid PDF: ${fakePdfPath}`,
      },
    });
    assert.deepEqual(result.details, {
      status: "manual_fallback_opened",
      fallbackRequired: true,
      articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
      fallbackUrl: "https://www.nature.com/articles/s41586-019-1666-5",
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      failure: {
        code: "download_failed",
        message: `Downloaded file is not a valid PDF: ${fakePdfPath}`,
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf still rejects when manual fallback cannot be opened", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace, {
      downloadPaperPdf: async (): Promise<never> => {
        throw new PaperDownloadError("download_failed", "Timed out waiting for PDF download.");
      },
      openPaperPageForLogin: async (): Promise<never> => {
        throw new Error("local browser launch failed");
      },
    } as unknown as CreateToolsDependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    await assert.rejects(
      () =>
        execute(
          "tool-call-fallback-4",
          { url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601" },
          undefined,
        ),
      /local browser launch failed/i,
    );
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

test("download_paper_pdf returns downloaded status for a valid PDF result", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const pdfPath = path.join(workspace, "downloads", "papers", "downloaded-paper.pdf");

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, Buffer.from("%PDF-test"));

    const tools = createTools(workspace, {
      downloadPaperPdf: async (
        options: Parameters<NonNullable<CreateToolsDependencies["downloadPaperPdf"]>>[0],
      ) => ({
        path: pdfPath,
        publisher: "science",
        articleUrl: options.url,
        finalArticleUrl: options.url,
        finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
      }),
      openPaperPageForLogin: async () => {
        throw new Error("manual fallback should not run for valid PDFs");
      },
    } as unknown as CreateToolsDependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    const result = await execute(
      "tool-call-fallback-1",
      { url: "https://www.science.org/doi/10.1126/science.adz8659" },
      undefined,
    );

    assert.deepEqual(JSON.parse(String(result.content?.[0]?.text)), {
      status: "downloaded",
      path: pdfPath,
      publisher: "science",
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      finalArticleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf opens manual fallback and returns non-error details for fallback-eligible failures", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const opened: Array<{ url: string; workspaceDir: string }> = [];

  try {
    const tools = createTools(workspace, {
      downloadPaperPdf: async (): Promise<never> => {
        throw new PaperDownloadError(
          "manual_login_required",
          "The browser session needs manual login or verification for this publisher.",
        );
      },
      openPaperPageForLogin: async (options: { url: string; workspaceDir: string }) => {
        opened.push(options);
        return {
          url: options.url,
          openedUrl: options.url,
          profileDir: path.join(options.workspaceDir, ".browser-profile", "paper-access"),
          executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        };
      },
    } as unknown as CreateToolsDependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    const result = await execute(
      "tool-call-fallback-2",
      { url: "https://www.science.org/doi/10.1126/science.adz8659" },
      undefined,
    );

    assert.deepEqual(opened, [
      {
        url: "https://www.science.org/doi/10.1126/science.adz8659",
        workspaceDir: workspace,
      },
    ]);
    assert.deepEqual(JSON.parse(String(result.content?.[0]?.text)), {
      status: "manual_fallback_opened",
      fallbackRequired: true,
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      fallbackUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      failure: {
        code: "manual_login_required",
        message: "The browser session needs manual login or verification for this publisher.",
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf opens manual fallback when the downloaded file is not a PDF", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const fakePdfPath = path.join(workspace, "downloads", "papers", "downloaded-paper.pdf");
  const opened: Array<{ url: string; workspaceDir: string }> = [];

  try {
    await mkdir(path.dirname(fakePdfPath), { recursive: true });
    await writeFile(fakePdfPath, "<!doctype html>", "utf8");

    const tools = createTools(workspace, {
      downloadPaperPdf: async (
        options: Parameters<NonNullable<CreateToolsDependencies["downloadPaperPdf"]>>[0],
      ) => ({
        path: fakePdfPath,
        publisher: "nature",
        articleUrl: options.url,
        finalArticleUrl: options.url,
        finalPdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf",
      }),
      openPaperPageForLogin: async (options: { url: string; workspaceDir: string }) => {
        opened.push(options);
        return {
          url: options.url,
          openedUrl: options.url,
          profileDir: path.join(options.workspaceDir, ".browser-profile", "paper-access"),
          executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        };
      },
    } as unknown as CreateToolsDependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    const result = await execute(
      "tool-call-fallback-3",
      { url: "https://www.nature.com/articles/s41586-019-1666-5" },
      undefined,
    );

    assert.deepEqual(opened, [
      {
        url: "https://www.nature.com/articles/s41586-019-1666-5",
        workspaceDir: workspace,
      },
    ]);
    assert.deepEqual(JSON.parse(String(result.content?.[0]?.text)), {
      status: "manual_fallback_opened",
      fallbackRequired: true,
      articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
      fallbackUrl: "https://www.nature.com/articles/s41586-019-1666-5",
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      failure: {
        code: "download_failed",
        message: "Downloaded file is not a valid PDF: " + fakePdfPath,
      },
    });
    assert.deepEqual(result.details, {
      status: "manual_fallback_opened",
      fallbackRequired: true,
      articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
      fallbackUrl: "https://www.nature.com/articles/s41586-019-1666-5",
      profileDir: path.join(workspace, ".browser-profile", "paper-access"),
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      failure: {
        code: "download_failed",
        message: "Downloaded file is not a valid PDF: " + fakePdfPath,
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf still rejects when manual fallback cannot be opened", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace, {
      downloadPaperPdf: async (): Promise<never> => {
        throw new PaperDownloadError("download_failed", "Timed out waiting for PDF download.");
      },
      openPaperPageForLogin: async (): Promise<never> => {
        throw new Error("local browser launch failed");
      },
    } as unknown as CreateToolsDependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    await assert.rejects(
      () =>
        execute(
          "tool-call-fallback-4",
          { url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601" },
          undefined,
        ),
      /local browser launch failed/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf uses the default browser-backed paper download path when not injected", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{ url: string; destinationPath: string }> = [];

  try {
    const dependencies: CreateToolsDependencies = {
      browserSessionFactory: async () => ({
        async openArticlePage(url: string) {
          return {
            finalArticleUrl: url,
            html: '<html><body><a href="/doi/pdf/10.1126/science.adz8659">PDF</a></body></html>',
            authorized: true,
          };
        },
        async openPageForManualLogin(url: string) {
          return {
            openedUrl: url,
          };
        },
        async downloadPdf(url: string, destinationPath: string) {
          capturedCalls.push({ url, destinationPath });
          await writeFile(destinationPath, Buffer.from("%PDF-default"));
        },
      }),
    };

    const tools = createTools(workspace, dependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);
    assert.equal(typeof execute, "function");

    const result = await execute(
      "tool-call-2",
      {
        url: "https://www.science.org/doi/10.1126/science.adz8659",
      },
      undefined,
    );

    assert.deepEqual(capturedCalls, [
      {
        url: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
        destinationPath: path.join(workspace, "downloads", "papers", "downloaded-paper.pdf"),
      },
    ]);
    assert.deepEqual(JSON.parse(String(result.content?.[0]?.text)), {
      status: "downloaded",
      path: path.join(workspace, "downloads", "papers", "downloaded-paper.pdf"),
      publisher: "science",
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      finalArticleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper_pdf reuses the default browser session for repeated executions", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const factoryCalls: number[] = [];
  const downloadCalls: Array<{ url: string; destinationPath: string }> = [];

  try {
    const dependencies: CreateToolsDependencies = {
      browserSessionFactory: async () => {
        factoryCalls.push(1);
        return {
          async openArticlePage(url: string) {
            return {
              finalArticleUrl: url,
              html: '<html><body><a href="/doi/pdf/10.1126/science.adz8659">PDF</a></body></html>',
              authorized: true,
            };
          },
          async openPageForManualLogin(url: string) {
            return {
              openedUrl: url,
            };
          },
          async downloadPdf(url: string, destinationPath: string) {
            downloadCalls.push({ url, destinationPath });
            await writeFile(destinationPath, Buffer.from("%PDF-reused"));
          },
        };
      },
    };

    const tools = createTools(workspace, dependencies) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    await execute(
      "tool-call-3",
      { url: "https://www.science.org/doi/10.1126/science.adz8659" },
      undefined,
    );
    await execute(
      "tool-call-4",
      { url: "https://www.science.org/doi/10.1126/science.adz8659" },
      undefined,
    );

    assert.deepEqual(factoryCalls, [1]);
    assert.deepEqual(downloadCalls, [
      {
        url: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
        destinationPath: path.join(workspace, "downloads", "papers", "downloaded-paper.pdf"),
      },
      {
        url: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
        destinationPath: path.join(workspace, "downloads", "papers", "downloaded-paper.pdf"),
      },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createTools cleanup closes a lazily created default browser session exactly once", async () => {
  const cleanupTools = (
    agentTools as {
      cleanupTools?: (tools: ReturnType<typeof createTools>) => Promise<void>;
    }
  ).cleanupTools;
  assert.equal(typeof cleanupTools, "function");

  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const factoryCalls: number[] = [];
  const disposeCalls: number[] = [];

  try {
    const tools = createTools(workspace, {
      browserSessionFactory: async () => {
        factoryCalls.push(1);
        return {
          async openArticlePage(url: string) {
            return {
              finalArticleUrl: url,
              html: '<html><body><a href="/doi/pdf/10.1126/science.adz8659">PDF</a></body></html>',
              authorized: true,
            };
          },
          async openPageForManualLogin(url: string) {
            return {
              openedUrl: url,
            };
          },
          async downloadPdf(_url: string, destinationPath: string) {
            await writeFile(destinationPath, Buffer.from("%PDF-cleanup"));
          },
          async dispose() {
            disposeCalls.push(1);
          },
        };
      },
    }) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    await execute(
      "tool-call-5",
      { url: "https://www.science.org/doi/10.1126/science.adz8659" },
      undefined,
    );

    await cleanupTools!(tools as ReturnType<typeof createTools>);
    await cleanupTools!(tools as ReturnType<typeof createTools>);

    assert.deepEqual(factoryCalls, [1]);
    assert.deepEqual(disposeCalls, [1]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createTools cleanup ignores a previously rejected browser session factory", async () => {
  const cleanupTools = (
    agentTools as {
      cleanupTools?: (tools: ReturnType<typeof createTools>) => Promise<void>;
    }
  ).cleanupTools;
  assert.equal(typeof cleanupTools, "function");

  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const launchError = new Error("browser launch failed");

  try {
    const tools = createTools(workspace, {
      browserSessionFactory: async () => {
        throw launchError;
      },
    }) as ReadonlyArray<{
      name: string;
      execute?: DownloadPaperPdfTool["execute"];
    }>;

    const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
    assert.ok(tool);
    const execute = tool.execute;
    assert.ok(execute);

    await assert.rejects(
      () =>
        execute(
          "tool-call-6",
          { url: "https://www.science.org/doi/10.1126/science.adz8659" },
          undefined,
        ),
      /browser launch failed/,
    );

    await assert.doesNotReject(() => cleanupTools!(tools as ReturnType<typeof createTools>));
    await assert.doesNotReject(() => cleanupTools!(tools as ReturnType<typeof createTools>));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
