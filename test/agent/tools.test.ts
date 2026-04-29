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
import {
  resolvePaperPdfPath,
  updatePaperRecordParseManifest,
  writePaperRecord
} from "../../src/agent/paper-store.js";

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

type FetchPaperWebpageTool = {
  execute: (
    toolCallId: string,
    args: { url: string; paperKey?: string; save?: boolean; force?: boolean },
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

type RegisterManualPaperDownloadTool = {
  execute: (
    toolCallId: string,
    args: { url: string; path: string; title?: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type ParsePaperTool = {
  execute: (
    toolCallId: string,
    args: {
      path?: string;
      recordPath?: string;
      engine?: "auto" | "opendataloader-local" | "opendataloader-hybrid" | "docling" | "tex-source" | "plain-text-baseline";
      force?: boolean;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type InspectPaperTool = {
  execute: (
    toolCallId: string,
    args: { path?: string; recordPath?: string; paperKey?: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type ReadPaperSectionTool = {
  execute: (
    toolCallId: string,
    args: {
      paperKey: string;
      engine?: "opendataloader-local" | "opendataloader-hybrid" | "docling" | "tex-source" | "plain-text-baseline" | "webpage";
      sectionId?: string;
      pageFrom?: number;
      pageTo?: number;
      maxChars?: number;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type SearchPaperTextTool = {
  execute: (
    toolCallId: string,
    args: {
      paperKey: string;
      engine?: "opendataloader-local" | "opendataloader-hybrid" | "docling" | "tex-source" | "plain-text-baseline" | "webpage";
      query: string;
      maxResults?: number;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type WritePaperWikiSourceTool = {
  execute: (
    toolCallId: string,
    args: {
      paperKey: string;
      engine?: "opendataloader-local" | "opendataloader-hybrid" | "docling" | "tex-source" | "plain-text-baseline" | "webpage";
      title?: string;
      summaryMarkdown: string;
      tags?: string[];
      keyFindings?: string[];
      limitations?: string[];
      openQuestions?: string[];
      relatedPaperKeys?: string[];
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type SearchPaperWikiTool = {
  execute: (
    toolCallId: string,
    args: { query: string; maxResults?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type ListLocalPapersTool = {
  execute: (
    toolCallId: string,
    args: { query?: string; status?: "all" | "downloaded" | "parsed" | "summarized"; maxResults?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type SearchLocalPapersTool = {
  execute: (
    toolCallId: string,
    args: { query: string; maxResults?: number },
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

function getFetchPaperWebpageTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): FetchPaperWebpageTool {
  const tools = createTools(workspace, {
    ...dependencies,
    exposeAdvancedPaperTools: true,
  }) as ReadonlyArray<{
    name: string;
    execute?: FetchPaperWebpageTool["execute"];
  }>;
  const fetchPaperWebpageTool = tools.find((tool) => tool.name === "fetch_paper_webpage");
  assert.ok(fetchPaperWebpageTool);
  assert.equal(typeof fetchPaperWebpageTool.execute, "function");
  return fetchPaperWebpageTool as FetchPaperWebpageTool;
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
  const tools = createTools(workspace, {
    ...dependencies,
    exposeAdvancedPaperTools: true,
  }) as ReadonlyArray<{
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

function getRegisterManualPaperDownloadTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): RegisterManualPaperDownloadTool {
  const tools = createTools(workspace, {
    ...dependencies,
    exposeAdvancedPaperTools: true,
  }) as ReadonlyArray<{
    name: string;
    execute?: RegisterManualPaperDownloadTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "register_manual_paper_download");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as RegisterManualPaperDownloadTool;
}

function getParsePaperTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): ParsePaperTool {
  const tools = createTools(workspace, {
    ...dependencies,
    exposeAdvancedPaperTools: true,
  }) as ReadonlyArray<{
    name: string;
    execute?: ParsePaperTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "parse_paper");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as ParsePaperTool;
}

function getInspectPaperTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): InspectPaperTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: InspectPaperTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "inspect_paper");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as InspectPaperTool;
}

function getReadPaperSectionTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): ReadPaperSectionTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: ReadPaperSectionTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "read_paper_section");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as ReadPaperSectionTool;
}

function getSearchPaperTextTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): SearchPaperTextTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: SearchPaperTextTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "search_paper_text");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as SearchPaperTextTool;
}

function getWritePaperWikiSourceTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): WritePaperWikiSourceTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: WritePaperWikiSourceTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "write_paper_wiki_source");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as WritePaperWikiSourceTool;
}

function getSearchPaperWikiTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): SearchPaperWikiTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: SearchPaperWikiTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "search_paper_wiki");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as SearchPaperWikiTool;
}

function getListLocalPapersTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): ListLocalPapersTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: ListLocalPapersTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "list_local_papers");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as ListLocalPapersTool;
}

function getSearchLocalPapersTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): SearchLocalPapersTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: SearchLocalPapersTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "search_local_papers");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as SearchLocalPapersTool;
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

test("createTools exposes the streamlined built-in tool set by default", async () => {
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
      "inspect_paper",
      "read_paper_section",
      "search_paper_text",
      "write_paper_wiki_source",
      "search_paper_wiki",
      "list_local_papers",
      "search_local_papers",
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

test("createTools can expose advanced paper implementation tools for diagnostics", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace, { exposeAdvancedPaperTools: true });
    const toolNames = tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("fetch_paper_webpage"));
    assert.ok(toolNames.includes("register_manual_paper_download"));
    assert.ok(toolNames.includes("open_paper_page_for_login"));
    assert.ok(toolNames.includes("parse_paper"));
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
      results: [
        {
          title: "Result title",
          url: "https://example.com/result",
          summary: "Result snippet",
        },
      ],
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

test("fetch_paper_webpage delegates to the injected article webpage client and returns JSON text with details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{ url: string }> = [];
  const capturedSaves: Array<{ paperKey?: string; force?: boolean; markdown: string }> = [];

  try {
    const fetchPaperWebpageTool = getFetchPaperWebpageTool(workspace, {
      fetchPaperWebPage: async (options) => {
        capturedCalls.push(options);
        return {
          url: options.url,
          title: "Paper title",
          markdown: "# Paper title\n\nFull article text.",
          metadata: {
            title: "Paper title",
            doi: "10.1234/example",
            journal: "Example Journal",
            authors: ["A. Author"],
          },
          access: {
            status: "full_text",
            signals: [],
          },
          stats: {
            chars: 32,
            wordsApprox: 5,
            navigationLinesRemoved: 3,
            extractedFrom: "article",
          },
        };
      },
      savePaperWebPageParse: async (options) => {
        capturedSaves.push({
          ...(options.paperKey ? { paperKey: options.paperKey } : {}),
          ...(options.force !== undefined ? { force: options.force } : {}),
          markdown: options.extraction.markdown,
        });
        return {
          status: "parsed",
          paperKey: options.paperKey ?? "example-paper",
          engine: "webpage",
          pdfSha256: "web-sha",
          artifacts: {
            sourcePath: path.join(workspace, "knowledge-base/wiki/sources/example-paper/source.json"),
            parsePath: path.join(workspace, "knowledge-base/wiki/sources/example-paper/parses/webpage/parse.json"),
            markdownPath: path.join(workspace, "knowledge-base/wiki/sources/example-paper/parses/webpage/document.md"),
            qualityPath: path.join(workspace, "knowledge-base/wiki/sources/example-paper/parses/webpage/quality.json"),
            chunksPath: path.join(workspace, "knowledge-base/wiki/sources/example-paper/chunks/webpage.jsonl"),
          },
          quality: {
            status: "good",
            score: 1,
            pages: 1,
            totalTextLength: 32,
            emptyPageCount: 0,
            headingCount: 1,
            tableCount: 0,
            figureOrCaptionCount: 0,
            warnings: [],
          },
          sections: [],
        };
      },
    });

    const result = await fetchPaperWebpageTool.execute(
      "call-paper-webpage",
      { url: "https://example.com/article", paperKey: "example-paper", force: true },
      undefined,
    );

    const expected = {
      url: "https://example.com/article",
      title: "Paper title",
      markdown: "# Paper title\n\nFull article text.",
      metadata: {
        title: "Paper title",
        doi: "10.1234/example",
        journal: "Example Journal",
        authors: ["A. Author"],
      },
      access: {
        status: "full_text",
        signals: [],
      },
      stats: {
        chars: 32,
        wordsApprox: 5,
        navigationLinesRemoved: 3,
        extractedFrom: "article",
      },
      savedParse: {
        status: "parsed",
        paperKey: "example-paper",
        engine: "webpage",
        pdfSha256: "web-sha",
        artifacts: {
          sourcePath: path.join(workspace, "knowledge-base/wiki/sources/example-paper/source.json"),
          parsePath: path.join(workspace, "knowledge-base/wiki/sources/example-paper/parses/webpage/parse.json"),
          markdownPath: path.join(workspace, "knowledge-base/wiki/sources/example-paper/parses/webpage/document.md"),
          qualityPath: path.join(workspace, "knowledge-base/wiki/sources/example-paper/parses/webpage/quality.json"),
          chunksPath: path.join(workspace, "knowledge-base/wiki/sources/example-paper/chunks/webpage.jsonl"),
        },
        quality: {
          status: "good",
          score: 1,
          pages: 1,
          totalTextLength: 32,
          emptyPageCount: 0,
          headingCount: 1,
          tableCount: 0,
          figureOrCaptionCount: 0,
          warnings: [],
        },
        sections: [],
      },
    };
    assert.deepEqual(capturedCalls, [{ url: "https://example.com/article" }]);
    assert.deepEqual(capturedSaves, [
      {
        paperKey: "example-paper",
        force: true,
        markdown: "# Paper title\n\nFull article text.",
      },
    ]);
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: JSON.stringify(expected),
      },
    ]);
    assert.deepEqual(result.details, expected);
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
      results: [
        {
          title: "Unified Paper Search",
          url: "https://www.science.org/doi/10.1126/science.adz8659",
          summary: "Merged paper result.",
          source: "science",
          action: "authorized_download",
          canonicalId: "10.1126/science.adz8659",
        },
      ],
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

test("download_paper prefers arXiv HTML webpage markdown before TeX source and PDF parsing", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const recordPath = path.join(workspace, "papers", "arxiv-2601.00425.json");
  const pdfPath = path.join(workspace, "papers", "arxiv-2601.00425.pdf");
  const managerResult: PaperDownloadResult = {
    status: "downloaded",
    source: "arxiv",
    canonicalId: "2601.00425",
    articleUrl: "https://arxiv.org/abs/2601.00425",
    finalPdfUrl: "https://arxiv.org/pdf/2601.00425.pdf",
    path: pdfPath,
    recordPath,
  };
  const calls: string[] = [];

  try {
    const downloadPaperTool = getDownloadPaperTool(workspace, {
      downloadPaper: async () => managerResult,
      fetchPaperWebPage: async (options) => {
        calls.push(`fetch:${options.url}`);
        return {
          url: options.url,
          title: "Arxiv HTML Paper",
          markdown: "# Arxiv HTML Paper\n\nFull article text from arXiv HTML.",
          metadata: {
            title: "Arxiv HTML Paper",
            authors: [],
          },
          access: {
            status: "full_text",
            signals: [],
          },
          stats: {
            chars: 48,
            wordsApprox: 8,
            navigationLinesRemoved: 0,
            extractedFrom: "article",
          },
        };
      },
      savePaperWebPageParse: async (options) => {
        calls.push(`save:${options.paperKey}`);
        return {
          status: "parsed",
          paperKey: options.paperKey ?? "arxiv-2601.00425",
          engine: "webpage",
          pdfSha256: "webpage-hash",
          artifacts: {
            sourcePath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/source.json"),
            parsePath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/parses/webpage/parse.json"),
            markdownPath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/parses/webpage/document.md"),
            qualityPath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/parses/webpage/quality.json"),
            chunksPath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/chunks/webpage.jsonl"),
          },
          quality: {
            status: "good",
            score: 1,
            pages: 1,
            totalTextLength: 128,
            emptyPageCount: 0,
            headingCount: 2,
            tableCount: 0,
            figureOrCaptionCount: 0,
            warnings: [],
          },
          sections: [],
        };
      },
      parsePaper: async () => {
        throw new Error("TeX source should not be parsed when arXiv HTML succeeds");
      },
    });

    const result = await downloadPaperTool.execute(
      "call-arxiv-html-first",
      { id: "2601.00425" },
      undefined,
    );

    assert.deepEqual(calls, [
      "fetch:https://arxiv.org/html/2601.00425",
      "save:arxiv-2601.00425",
    ]);
    assert.equal((result.details as { reading?: { strategy?: string } }).reading?.strategy, "webpage");
    assert.equal((result.details as { reading?: { engine?: string } }).reading?.engine, "webpage");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper falls back to arXiv TeX source before PDF parsing when HTML fails", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const recordPath = path.join(workspace, "papers", "arxiv-2601.00425.json");
  const pdfPath = path.join(workspace, "papers", "arxiv-2601.00425.pdf");
  const managerResult: PaperDownloadResult = {
    status: "downloaded",
    source: "arxiv",
    canonicalId: "2601.00425",
    articleUrl: "https://arxiv.org/abs/2601.00425",
    finalPdfUrl: "https://arxiv.org/pdf/2601.00425.pdf",
    path: pdfPath,
    recordPath,
  };
  const calls: string[] = [];

  try {
    const downloadPaperTool = getDownloadPaperTool(workspace, {
      downloadPaper: async () => managerResult,
      fetchPaperWebPage: async (options) => {
        calls.push(`fetch:${options.url}`);
        throw new Error("arXiv HTML unavailable");
      },
      parsePaper: async (options) => {
        calls.push(`parse:${options.engine ?? "auto"}`);
        assert.equal(options.engine, "tex-source");
        assert.equal(options.recordPath, recordPath);
        return {
          status: "parsed",
          paperKey: "arxiv-2601.00425",
          engine: "tex-source",
          pdfSha256: "pdf-hash",
          artifacts: {
            sourcePath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/source.json"),
            parsePath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/parses/tex-source/parse.json"),
            markdownPath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/parses/tex-source/document.md"),
            qualityPath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/parses/tex-source/quality.json"),
            chunksPath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/chunks/tex-source.jsonl"),
          },
          quality: {
            status: "good",
            score: 1,
            pages: 1,
            totalTextLength: 48,
            emptyPageCount: 0,
            headingCount: 1,
            tableCount: 0,
            figureOrCaptionCount: 0,
            warnings: [],
          },
          sections: [],
        };
      },
    });

    const result = await downloadPaperTool.execute(
      "call-arxiv-tex-fallback",
      { id: "2601.00425" },
      undefined,
    );

    assert.deepEqual(calls, [
      "fetch:https://arxiv.org/html/2601.00425",
      "parse:tex-source",
    ]);
    assert.equal((result.details as { reading?: { strategy?: string } }).reading?.strategy, "pdf");
    assert.equal((result.details as { reading?: { engine?: string } }).reading?.engine, "tex-source");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper reuses ready record manifests without re-fetching publisher webpages", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const articleUrl = "https://www.nature.com/articles/s41586-019-1666-5";
  const pdfPath = resolvePaperPdfPath({
    workspaceDir: workspace,
    source: "nature",
    canonicalId: "s41586-019-1666-5"
  });

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\nnature pdf\n", "utf8");
    const recordPath = await writePaperRecord({
      workspaceDir: workspace,
      record: {
        source: "nature",
        articleUrl,
        recordedAt: "2026-04-25T10:00:00.000Z",
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: "s41586-019-1666-5",
        pdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf",
        downloadPath: pdfPath
      }
    });
    await updatePaperRecordParseManifest({
      workspaceDir: workspace,
      recordPath,
      strategy: "webpage",
      status: "parsed",
      paperKey: "nature-s41586-019-1666-5",
      engine: "webpage",
      sourceSha256: "webpage-hash",
      artifacts: {
        markdownPath: path.join(workspace, "knowledge-base/wiki/sources/nature-s41586-019-1666-5/parses/webpage/document.md"),
        parsePath: path.join(workspace, "knowledge-base/wiki/sources/nature-s41586-019-1666-5/parses/webpage/parse.json"),
        qualityPath: path.join(workspace, "knowledge-base/wiki/sources/nature-s41586-019-1666-5/parses/webpage/quality.json"),
        chunksPath: path.join(workspace, "knowledge-base/wiki/sources/nature-s41586-019-1666-5/chunks/webpage.jsonl")
      },
      quality: {
        status: "good",
        score: 1,
        pages: 1,
        totalTextLength: 2000,
        warnings: []
      }
    });

    const downloadPaperTool = getDownloadPaperTool(workspace, {
      downloadPaper: async () => ({
        status: "already_downloaded",
        source: "nature",
        canonicalId: "s41586-019-1666-5",
        articleUrl,
        finalPdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf",
        path: pdfPath,
        recordPath,
        recordedAt: "2026-04-25T10:00:00.000Z"
      }),
      extensionBridge: {
        async submitJob() {
          throw new Error("ready records should not queue webpage capture again");
        }
      },
      parsePaper: async () => {
        throw new Error("ready records should not be parsed again");
      }
    });

    const result = await downloadPaperTool.execute(
      "call-ready-record",
      { url: articleUrl },
      undefined
    );

    assert.equal((result.details as { reading?: { status?: string } }).reading?.status, "already_parsed");
    assert.equal((result.details as { reading?: { strategy?: string } }).reading?.strategy, "webpage");
    assert.equal(
      (result.details as { reading?: { markdownPath?: string } }).reading?.markdownPath,
      "knowledge-base/wiki/sources/nature-s41586-019-1666-5/parses/webpage/document.md"
    );
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
    finalPdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
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

test("register_manual_paper_download delegates resolved workspace PDF paths to the paper manager", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const pdfPath = path.join(workspace, "downloads", "inbox", "manual.pdf");
  const capturedCalls: Array<{
    workspaceDir: string;
    url: string;
    pdfPath: string;
    title?: string;
  }> = [];
  const managerResult = {
    status: "downloaded" as const,
    source: "external" as const,
    articleUrl: "https://example.com/paper",
    path: path.join(workspace, "downloads", "papers", "external-example.com-abc.pdf"),
    recordPath: path.join(workspace, "downloads", "papers", "index", "external-example.com-abc.json"),
    fileSha256: "abc123",
    title: "Manual External Paper",
  };

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\nmanual pdf\n", "utf8");
    const tool = getRegisterManualPaperDownloadTool(workspace, {
      registerManualPaperDownload: async (options) => {
        capturedCalls.push(options);
        return managerResult;
      },
    });

    const result = await tool.execute(
      "tool-call-register-manual",
      {
        url: "https://example.com/paper",
        path: "downloads/inbox/manual.pdf",
        title: "Manual External Paper",
      },
      undefined,
    );

    assert.deepEqual(capturedCalls, [
      {
        workspaceDir: workspace,
        url: "https://example.com/paper",
        pdfPath,
        title: "Manual External Paper",
      },
    ]);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(managerResult) }]);
    assert.deepEqual(result.details, managerResult);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("register_manual_paper_download rejects absolute or escaping PDF paths", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getRegisterManualPaperDownloadTool(workspace, {
      registerManualPaperDownload: async (): Promise<never> => {
        throw new Error("manager should not receive unsafe paths");
      },
    });

    await assert.rejects(
      () =>
        tool.execute(
          "tool-call-register-absolute",
          {
            url: "https://example.com/paper",
            path: path.join(workspace, "manual.pdf"),
          },
          undefined,
        ),
      /absolute paths are not allowed/i,
    );
    await assert.rejects(
      () =>
        tool.execute(
          "tool-call-register-escape",
          {
            url: "https://example.com/paper",
            path: "../manual.pdf",
          },
          undefined,
        ),
      /outside the workspace/i,
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
      usePlaywrightPaperFallback: true,
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
        "knowledge-base",
        "records",
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
      usePlaywrightPaperFallback: true,
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
            finalPdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
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
        "knowledge-base",
        "records",
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
        "knowledge-base",
        "records",
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
      usePlaywrightPaperFallback: true,
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
        "knowledge-base",
        "records",
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

test("parse_paper delegates to the injected paper reader dependency and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getParsePaperTool(workspace, {
      parsePaper: async (options) => ({
        status: "parsed" as const,
        paperKey: "arxiv-2406.06015",
        engine: options.engine === "plain-text-baseline" ? "plain-text-baseline" as const : "opendataloader-local" as const,
        pdfSha256: "abc123",
        artifacts: {
          sourcePath: path.join(options.workspaceDir, "knowledge-base/wiki/sources/arxiv-2406.06015/source.json"),
          parsePath: path.join(options.workspaceDir, "knowledge-base/wiki/sources/arxiv-2406.06015/parses/plain-text-baseline/parse.json"),
          markdownPath: path.join(options.workspaceDir, "knowledge-base/wiki/sources/arxiv-2406.06015/parses/plain-text-baseline/document.md"),
          qualityPath: path.join(options.workspaceDir, "knowledge-base/wiki/sources/arxiv-2406.06015/parses/plain-text-baseline/quality.json"),
          chunksPath: path.join(options.workspaceDir, "knowledge-base/wiki/sources/arxiv-2406.06015/chunks/plain-text-baseline.jsonl"),
        },
        quality: {
          status: "good" as const,
          score: 1,
          pages: 1,
          totalTextLength: 100,
          emptyPageCount: 0,
          headingCount: 1,
          tableCount: 0,
          figureOrCaptionCount: 0,
          warnings: [],
        },
        sections: [
          {
            id: "section-0001",
            title: "Abstract",
            level: 1,
            pageFrom: 1,
            pageTo: 1,
          },
        ],
      }),
    });

    const result = await tool.execute("parse-call", {
      path: "knowledge-base/raw/pdfs/arxiv-2406.06015.pdf",
      engine: "plain-text-baseline",
      force: true,
    }, undefined);

    assert.deepEqual(result.details, JSON.parse(result.content?.[0]?.text ?? ""));
    assert.equal((result.details as { paperKey?: string }).paperKey, "arxiv-2406.06015");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("inspect_paper delegates to the injected paper reader dependency and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getInspectPaperTool(workspace, {
      inspectPaper: async (options) => ({
        paperKey: options.paperKey ?? "arxiv-2406.06015",
        parses: [],
      }),
    });

    const result = await tool.execute("inspect-call", {
      paperKey: "arxiv-2406.06015",
    }, undefined);

    assert.deepEqual(result.details, {
      paperKey: "arxiv-2406.06015",
      parses: [],
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_paper_section delegates to the injected paper reader dependency and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getReadPaperSectionTool(workspace, {
      readPaperSection: async (options) => ({
        paperKey: options.paperKey,
        engine: options.engine ?? "plain-text-baseline",
        sectionId: options.sectionId,
        pageFrom: options.pageFrom,
        pageTo: options.pageTo,
        maxChars: options.maxChars ?? 6000,
        text: "[p.1] methods text",
        truncated: false,
        elements: [],
      }),
    });

    const result = await tool.execute("read-section-call", {
      paperKey: "arxiv-2406.06015",
      engine: "plain-text-baseline",
      sectionId: "section-0001",
      maxChars: 1000,
    }, undefined);

    assert.equal((result.details as { text?: string }).text, "[p.1] methods text");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search_paper_text delegates to the injected paper reader dependency and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getSearchPaperTextTool(workspace, {
      searchPaperText: async (options) => ({
        paperKey: options.paperKey,
        engine: options.engine ?? "plain-text-baseline",
        query: options.query,
        results: [
          {
            elementId: "el-0002",
            type: "paragraph" as const,
            page: 1,
            sectionId: "section-0001",
            snippet: "matched query",
          },
        ],
      }),
    });

    const result = await tool.execute("search-paper-call", {
      paperKey: "arxiv-2406.06015",
      query: "query",
      maxResults: 3,
    }, undefined);

    assert.equal((result.details as { results?: unknown[] }).results?.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("write_paper_wiki_source delegates to the injected wiki dependency and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{
    workspaceDir: string;
    paperKey: string;
    summaryMarkdown: string;
    tags?: string[];
  }> = [];

  try {
    const tool = getWritePaperWikiSourceTool(workspace, {
      writePaperWikiSource: async (options) => {
        capturedCalls.push(options);
        return {
          paperKey: options.paperKey,
          title: options.title ?? "Paper title",
          sourcePath: "knowledge-base/wiki/sources/arxiv-2406.06015.md",
          indexPath: "knowledge-base/wiki/index.md",
          logPath: "knowledge-base/wiki/log.md",
          schemaPath: "knowledge-base/wiki/schema.md",
        };
      },
    });

    const result = await tool.execute("write-wiki-call", {
      paperKey: "arxiv-2406.06015",
      summaryMarkdown: "Grounded retrieval summary.",
      tags: ["quantum"],
    }, undefined);

    assert.deepEqual(capturedCalls, [
      {
        workspaceDir: workspace,
        paperKey: "arxiv-2406.06015",
        summaryMarkdown: "Grounded retrieval summary.",
        tags: ["quantum"],
      },
    ]);
    assert.equal((result.details as { sourcePath?: string }).sourcePath, "knowledge-base/wiki/sources/arxiv-2406.06015.md");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search_paper_wiki delegates to the injected wiki search dependency and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getSearchPaperWikiTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [
          {
            paperKey: "arxiv-2406.06015",
            title: "Paper title",
            path: "knowledge-base/wiki/sources/arxiv-2406.06015.md",
            snippet: "query match",
          },
        ],
      }),
    });

    const result = await tool.execute("search-wiki-call", {
      query: "query",
      maxResults: 2,
    }, undefined);

    assert.equal((result.details as { results?: unknown[] }).results?.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("list_local_papers delegates to the injected local library dependency", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getListLocalPapersTool(workspace, {
      listLocalPapers: async (options) => ({
        total: 1,
        count: 1,
        results: [
          {
            paperKey: "nature-s41534-026-01233-y",
            title: options.query,
            status: options.status ?? "all",
            hasPdf: true,
            hasParsedArtifacts: true,
            hasWikiSummary: false,
            parses: [],
          },
        ],
      }),
    });

    const result = await tool.execute("list-local-call", {
      query: "qLDPC",
      status: "parsed",
      maxResults: 5,
    }, undefined);

    assert.equal((result.details as { total?: number }).total, 1);
    assert.equal((result.details as { results?: Array<{ title?: string }> }).results?.[0]?.title, "qLDPC");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search_local_papers delegates to the injected local library dependency", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getSearchLocalPapersTool(workspace, {
      searchLocalPapers: async (options) => ({
        query: options.query,
        count: 1,
        results: [
          {
            paper: {
              paperKey: "arxiv-2406.06015",
              hasPdf: true,
              hasParsedArtifacts: true,
              hasWikiSummary: true,
              parses: [],
            },
            score: options.maxResults ?? 0,
            matches: [{ field: "metadata", snippet: "query match" }],
          },
        ],
      }),
    });

    const result = await tool.execute("search-local-call", {
      query: "quantum",
      maxResults: 3,
    }, undefined);

    assert.equal((result.details as { count?: number }).count, 1);
    assert.equal((result.details as { results?: Array<{ score?: number }> }).results?.[0]?.score, 3);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
