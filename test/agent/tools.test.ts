import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

type DownloadArxivPdfTool = {
  execute: (
    toolCallId: string,
    args: { id: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

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
    const toolNames = createTools(workspace).map((tool) => tool.name);
    assert.deepEqual(toolNames, [
      "get_time",
      "read_file",
      "web_search",
      "fetch_url",
      "search_arxiv",
      "download_arxiv_pdf",
    ]);
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

test("download_arxiv_pdf returns the canonical PDF URL", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const downloadArxivPdfTool = getDownloadArxivPdfTool(workspace);

    const result = await downloadArxivPdfTool.execute(
      "call-7",
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
