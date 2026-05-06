import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

type ListFilesTool = {
  execute: (
    toolCallId: string,
    args: { path: string; maxDepth?: number; maxEntries?: number },
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

type GeneratePaperWikiSummaryTool = {
  execute: (
    toolCallId: string,
    args: {
      paperKey: string;
      engine?: "opendataloader-local" | "opendataloader-hybrid" | "docling" | "tex-source" | "plain-text-baseline" | "webpage";
      mode?: "draft" | "write";
      maxEvidenceChars?: number;
      includeRelatedCandidates?: boolean;
      maxRelatedCandidates?: number;
      force?: boolean;
    },
    signal: undefined,
    onUpdate?: (partialResult: ToolResult) => void,
  ) => Promise<ToolResult>;
};

type PaperWikiRelationsTool = {
  execute: (
    toolCallId: string,
    args: {
      paperKey: string;
      maxCandidates?: number;
      maxTextChars?: number;
      relatedPaperKeys?: string[];
      mode?: "append" | "replace";
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

type WikiLintTool = {
  execute: (
    toolCallId: string,
    args: { maxItems?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type AnswerPaperWikiQuestionTool = {
  execute: (
    toolCallId: string,
    args: { query: string; maxResults?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type AnswerResearchQuestionTool = {
  execute: (
    toolCallId: string,
    args: {
      query: string;
      maxLocalResults?: number;
      maxExternalCandidates?: number;
      maxDownloads?: number;
      autoDownload?: boolean;
      autoSummarize?: boolean;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type BootstrapWikiPageEvidenceTool = {
  execute: (
    toolCallId: string,
    args: {
      topic: string;
      question?: string;
      maxSeedQueries?: number;
      maxSources?: number;
      includeParsedFallback?: boolean;
      autoSummarizeMissing?: boolean;
      maxSummariesToGenerate?: number;
    },
    signal: undefined,
    onUpdate?: (partialResult: ToolResult) => void,
  ) => Promise<ToolResult>;
};

type ClarifyResearchTopicTool = {
  execute: (
    toolCallId: string,
    args: {
      topic: string;
      userRequest?: string;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type ResearchTopicBootstrapTool = {
  execute: (
    toolCallId: string,
    args: {
      topic: string;
      question?: string;
      maxSeedQueries?: number;
      maxSources?: number;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type ExpandResearchTopicTool = {
  execute: (
    toolCallId: string,
    args: {
      topic: string;
      question?: string;
      mode?: "plan" | "search";
      maxSeedQueries?: number;
      maxSources?: number;
      maxExternalCandidates?: number;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type BuildWikiPageTool = {
  execute: (
    toolCallId: string,
    args: {
      topic: string;
      question?: string;
      pageKey?: string;
      mode?: "draft" | "write";
      maxLocalResults?: number;
      maxExternalCandidates?: number;
      maxDownloads?: number;
      autoDownload?: boolean;
      autoSummarize?: boolean;
    },
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

type WikiHealthTool = {
  execute: (
    toolCallId: string,
    args: { maxItems?: number; lowQualityScoreThreshold?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type WikiHealthFixTool = {
  execute: (
    toolCallId: string,
    args: {
      maxItems?: number;
      lowQualityScoreThreshold?: number;
      issueKinds?: Array<
        | "needs_download"
        | "needs_authorization"
        | "queued"
        | "parse_missing"
        | "parse_failed"
        | "low_quality"
        | "summary_missing"
        | "missing_artifact"
      >;
      dryRun?: boolean;
    },
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

function getListFilesTool(workspace: string): ListFilesTool {
  const tools = createTools(workspace) as ReadonlyArray<{
    name: string;
    execute?: ListFilesTool["execute"];
  }>;
  const listFilesTool = tools.find((tool) => tool.name === "list_files");
  assert.ok(listFilesTool);
  assert.equal(typeof listFilesTool.execute, "function");
  return listFilesTool as ListFilesTool;
}

function getGetTimeTool(workspace: string): GetTimeTool {
  const tools = createTools(workspace, { toolProfile: "full" }) as ReadonlyArray<{
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
    toolProfile: "full",
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
    toolProfile: "full",
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
    toolProfile: "full",
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
    toolProfile: "full",
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
  const tools = createTools(workspace, { ...dependencies, toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: WritePaperWikiSourceTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "write_paper_wiki_source");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as WritePaperWikiSourceTool;
}

function getGeneratePaperWikiSummaryTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): GeneratePaperWikiSummaryTool {
  const tools = createTools(workspace, { ...dependencies, toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: GeneratePaperWikiSummaryTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "generate_paper_wiki_summary");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as GeneratePaperWikiSummaryTool;
}

function getPaperWikiRelationsTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): PaperWikiRelationsTool {
  const tools = createTools(workspace, { ...dependencies, toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: PaperWikiRelationsTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "paper_wiki_relations");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as PaperWikiRelationsTool;
}

function getSearchPaperWikiTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): SearchPaperWikiTool {
  const tools = createTools(workspace, { ...dependencies, toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: SearchPaperWikiTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "search_paper_wiki");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as SearchPaperWikiTool;
}

function getWikiLintTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): WikiLintTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: WikiLintTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "wiki_lint");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as WikiLintTool;
}

function getAnswerPaperWikiQuestionTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): AnswerPaperWikiQuestionTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: AnswerPaperWikiQuestionTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "answer_paper_wiki_question");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as AnswerPaperWikiQuestionTool;
}

function getAnswerResearchQuestionTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): AnswerResearchQuestionTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: AnswerResearchQuestionTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "answer_research_question");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as AnswerResearchQuestionTool;
}

function getBuildWikiPageTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): BuildWikiPageTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: BuildWikiPageTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "build_wiki_page");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as BuildWikiPageTool;
}

function getBootstrapWikiPageEvidenceTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): BootstrapWikiPageEvidenceTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: BootstrapWikiPageEvidenceTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "bootstrap_wiki_page_evidence");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as BootstrapWikiPageEvidenceTool;
}

function getClarifyResearchTopicTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): ClarifyResearchTopicTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: ClarifyResearchTopicTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "clarify_research_topic");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as ClarifyResearchTopicTool;
}

function getResearchTopicBootstrapTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): ResearchTopicBootstrapTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: ResearchTopicBootstrapTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "research_topic_bootstrap");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as ResearchTopicBootstrapTool;
}

function getExpandResearchTopicTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): ExpandResearchTopicTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: ExpandResearchTopicTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "expand_research_topic");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as ExpandResearchTopicTool;
}

function getListLocalPapersTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): ListLocalPapersTool {
  const tools = createTools(workspace, { ...dependencies, toolProfile: "full" }) as ReadonlyArray<{
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

function getWikiHealthTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): WikiHealthTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: WikiHealthTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "wiki_health");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as WikiHealthTool;
}

function getWikiHealthFixTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): WikiHealthFixTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: WikiHealthFixTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "wiki_health_fix");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as WikiHealthFixTool;
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

test("read_file accepts workspace-absolute paths", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const absolutePath = path.join(workspace, "notes.txt");
  await writeFile(absolutePath, "absolute workspace note", "utf8");

  try {
    const readFileTool = getReadFileTool(workspace);
    const result = await readFileTool.execute("call-3", { path: absolutePath }, undefined);
    assert.match(result.content?.[0]?.text ?? "", /absolute workspace note/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file rejects absolute paths outside the workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-outside-"));
  const absolutePath = path.join(outside, "secret.txt");
  await writeFile(absolutePath, "outside secret", "utf8");

  try {
    const readFileTool = getReadFileTool(workspace);
    await assert.rejects(
      () => readFileTool.execute("call-3b", { path: absolutePath }, undefined),
      /outside the workspace/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("list_files lists workspace directories from an absolute path", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const projectDir = path.join(workspace, "paper-projects", "million-qubits");
  await mkdir(path.join(projectDir, "notes"), { recursive: true });
  await writeFile(path.join(projectDir, "outline.md"), "# Outline\n", "utf8");
  await writeFile(path.join(projectDir, "notes", "evidence.md"), "# Evidence\n", "utf8");

  try {
    const listFilesTool = getListFilesTool(workspace);
    const result = await listFilesTool.execute(
      "call-list-1",
      { path: path.join(workspace, "paper-projects"), maxDepth: 2 },
      undefined,
    );
    const details = result.details as {
      entries: Array<{ path: string; type: string }>;
      truncated: boolean;
    };

    assert.equal(details.truncated, false);
    assert.deepEqual(details.entries, [
      { path: "paper-projects/million-qubits", type: "directory" },
      { path: "paper-projects/million-qubits/notes", type: "directory" },
      { path: "paper-projects/million-qubits/notes/evidence.md", type: "file" },
      { path: "paper-projects/million-qubits/outline.md", type: "file" },
    ]);
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

test("createTools exposes the minimal default tool set", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace);
    const toolNames = tools.map((tool) => tool.name);
    assert.deepEqual(toolNames, [
      "list_files",
      "read_file",
      "web_search",
      "fetch_url",
      "search_papers",
      "download_paper",
      "inspect_paper",
      "read_paper_section",
      "search_paper_text",
      "answer_paper_wiki_question",
      "answer_research_question",
      "bootstrap_wiki_page_evidence",
      "build_wiki_page",
      "clarify_research_topic",
      "research_topic_bootstrap",
      "expand_research_topic",
      "search_local_papers",
      "wiki_health",
      "wiki_lint",
      "wiki_health_fix",
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

test("createTools full profile exposes every built-in tool", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace, { toolProfile: "full" });
    const toolNames = tools.map((tool) => tool.name);
    assert.deepEqual(toolNames, [
      "get_time",
      "list_files",
      "read_file",
      "web_search",
      "fetch_url",
      "search_papers",
      "download_paper",
      "inspect_paper",
      "read_paper_section",
      "search_paper_text",
      "answer_paper_wiki_question",
      "answer_research_question",
      "bootstrap_wiki_page_evidence",
      "build_wiki_page",
      "clarify_research_topic",
      "research_topic_bootstrap",
      "expand_research_topic",
      "search_local_papers",
      "wiki_health",
      "wiki_lint",
      "wiki_health_fix",
      "write_paper_wiki_source",
      "generate_paper_wiki_summary",
      "paper_wiki_relations",
      "search_paper_wiki",
      "list_local_papers",
      "fetch_paper_webpage",
      "register_manual_paper_download",
      "open_paper_page_for_login",
      "parse_paper",
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

test("register_manual_paper_download rejects escaping PDF paths", async () => {
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
        localPdf: {
          hasPdf: false,
        },
        parses: [],
      }),
    });

    const result = await tool.execute("inspect-call", {
      paperKey: "arxiv-2406.06015",
    }, undefined);

    assert.deepEqual(result.details, {
      paperKey: "arxiv-2406.06015",
      localPdf: {
        hasPdf: false,
      },
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

test("generate_paper_wiki_summary delegates to the injected summary dependency and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{
    workspaceDir: string;
    paperKey: string;
    mode?: string;
    maxEvidenceChars?: number;
    onProgress?: unknown;
  }> = [];

  try {
    const tool = getGeneratePaperWikiSummaryTool(workspace, {
      generatePaperWikiSummary: async (options) => {
        capturedCalls.push(options);
        return {
          status: "drafted" as const,
          paperKey: options.paperKey,
          engine: options.engine ?? "webpage",
          title: "Paper title",
          message: "Generated a draft.",
          evidence: {
            paperKey: options.paperKey,
            title: "Paper title",
            engine: options.engine ?? "webpage",
            pdfSha256: "sha",
            paths: {
              parseMarkdown: "document.md",
              parseJson: "parse.json",
              qualityJson: "quality.json",
            },
            sections: [],
            totalMarkdownChars: 10,
            truncated: false,
            markdownPreview: "preview",
          },
          draft: {
            summaryMarkdown: "Grounded draft.",
            confidence: "high",
          },
        };
      },
    });

    const result = await tool.execute("generate-summary-call", {
      paperKey: "aps-10.1103-nv7d-k3wr",
      mode: "draft",
      maxEvidenceChars: 4096,
    }, undefined);

    assert.deepEqual(capturedCalls, [
      {
        workspaceDir: workspace,
        paperKey: "aps-10.1103-nv7d-k3wr",
        mode: "draft",
        maxEvidenceChars: 4096,
        onProgress: capturedCalls[0]?.onProgress,
      },
    ]);
    assert.equal(typeof capturedCalls[0]?.onProgress, "function");
    assert.equal((result.details as { status?: string }).status, "drafted");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("generate_paper_wiki_summary streams progress updates", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const updates: unknown[] = [];

  try {
    const tool = getGeneratePaperWikiSummaryTool(workspace, {
      generatePaperWikiSummary: async (options) => {
        await options.onProgress?.({
          stage: "building_evidence",
          paperKey: options.paperKey,
          message: `Building summary evidence for ${options.paperKey}.`,
        });
        return {
          status: "drafted" as const,
          paperKey: options.paperKey,
          engine: "webpage",
          message: "Generated a draft.",
          evidence: {
            paperKey: options.paperKey,
            engine: "webpage",
            pdfSha256: "sha",
            paths: {
              parseMarkdown: "document.md",
              parseJson: "parse.json",
              qualityJson: "quality.json",
            },
            sections: [],
            totalMarkdownChars: 10,
            truncated: false,
            markdownPreview: "preview",
          },
          draft: {
            summaryMarkdown: "Grounded draft.",
          },
        };
      },
    });

    await tool.execute("generate-summary-progress-call", {
      paperKey: "aps-target",
    }, undefined, (partialResult) => {
      updates.push(partialResult.details);
    });

    assert.deepEqual(updates, [
      {
        progress: {
          stage: "building_evidence",
          paperKey: "aps-target",
          message: "Building summary evidence for aps-target.",
        },
      },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("paper_wiki_relations delegates to the injected relation dependency and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{
    workspaceDir: string;
    paperKey: string;
    maxCandidates?: number;
    relatedPaperKeys?: string[];
    mode?: string;
  }> = [];

  try {
    const tool = getPaperWikiRelationsTool(workspace, {
      paperWikiRelations: async (options) => {
        capturedCalls.push(options);
        return {
          paperKey: options.paperKey,
          candidates: [
            {
              paperKey: "aps-related",
              title: "Related paper",
              score: 12,
              sharedTerms: ["superconducting"],
              reasons: ["Shared title terms: superconducting."],
              hasWikiSummary: true,
              parseEngines: ["webpage"],
            },
          ],
          update: options.relatedPaperKeys ? {
            paperKey: options.paperKey,
            sourcePath: "knowledge-base/wiki/sources/aps-target.md",
            previousRelatedPaperKeys: [],
            relatedPaperKeys: options.relatedPaperKeys,
            mode: options.mode ?? "append",
          } : undefined,
        };
      },
    });

    const result = await tool.execute("relations-call", {
      paperKey: "aps-target",
      maxCandidates: 4,
      relatedPaperKeys: ["aps-related"],
      mode: "replace",
    }, undefined);

    assert.deepEqual(capturedCalls, [
      {
        workspaceDir: workspace,
        paperKey: "aps-target",
        maxCandidates: 4,
        relatedPaperKeys: ["aps-related"],
        mode: "replace",
      },
    ]);
    assert.equal((result.details as { update?: { relatedPaperKeys?: string[] } }).update?.relatedPaperKeys?.[0], "aps-related");
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

test("wiki_lint delegates to the injected wiki lint dependency and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: unknown[] = [];

  try {
    const tool = getWikiLintTool(workspace, {
      lintPaperWiki: async (options) => {
        capturedCalls.push(options);
        return {
          pageCount: 1,
          sourceCount: 2,
          issueCount: 1,
          summary: {
            stale_index: 0,
            broken_wiki_link: 0,
            missing_source_citation: 0,
            orphan_page: 0,
            concept_gap: 1,
          },
          issues: [
            {
              kind: "concept_gap",
              severity: "low",
              concept: "qldpc",
              count: 2,
              reason: "Repeated source tag has no durable synthesis page.",
            },
          ],
          actions: ["1: Promote repeated source tags into durable topic pages with build_wiki_page."],
        };
      },
    });

    const result = await tool.execute("wiki-lint-call", {
      maxItems: 5,
    }, undefined);

    assert.deepEqual(capturedCalls, [{
      workspaceDir: workspace,
      maxItems: 5,
    }]);
    assert.equal((result.details as { issueCount?: number }).issueCount, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("answer_paper_wiki_question builds a citeable wiki evidence package", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: unknown[] = [];

  try {
    const tool = getAnswerPaperWikiQuestionTool(workspace, {
      searchPaperWiki: async (options) => {
        capturedCalls.push(options);
        return {
          query: options.query,
          results: [
            {
              paperKey: "arxiv-2406.06015",
              title: "Paper title",
              path: "knowledge-base/wiki/sources/arxiv-2406.06015.md",
              snippet: "query match from the source summary",
            },
          ],
        };
      },
    });

    const result = await tool.execute("answer-wiki-call", {
      query: "What does the paper show?",
      maxResults: 2,
    }, undefined);
    const details = result.details as {
      status?: string;
      evidence?: Array<{ citation?: string; path?: string }>;
      fallbackMatches?: unknown[];
    };

    assert.deepEqual(capturedCalls, [{
      workspaceDir: workspace,
      query: "What does the paper show?",
      maxResults: 2,
    }]);
    assert.equal(details.status, "has_wiki_evidence");
    assert.equal(details.evidence?.[0]?.citation, "arxiv-2406.06015 (knowledge-base/wiki/sources/arxiv-2406.06015.md)");
    assert.equal(details.evidence?.[0]?.path, "knowledge-base/wiki/sources/arxiv-2406.06015.md");
    assert.deepEqual(details.fallbackMatches, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("answer_paper_wiki_question reports local fallback matches as non-wiki evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getAnswerPaperWikiQuestionTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [],
      }),
      searchLocalPapers: async (options) => ({
        query: options.query,
        count: 1,
        results: [
          {
            paper: {
              paperKey: "aps-target",
              title: "APS target",
              hasPdf: true,
              hasParsedArtifacts: true,
              hasWikiSummary: false,
              parses: [],
            },
            score: 2,
            matches: [
              {
                field: "parsed_markdown",
                path: "knowledge-base/wiki/sources/aps-target/parses/opendataloader-local/document.md",
                engine: "opendataloader-local",
                snippet: "raw parsed match",
              },
            ],
          },
        ],
      }),
    });

    const result = await tool.execute("answer-wiki-call", {
      query: "What does the paper show?",
    }, undefined);
    const details = result.details as {
      status?: string;
      evidence?: unknown[];
      fallbackMatches?: Array<{ paperKey?: string; path?: string; field?: string }>;
    };

    assert.equal(details.status, "no_wiki_evidence_but_local_matches");
    assert.deepEqual(details.evidence, []);
    assert.equal(details.fallbackMatches?.[0]?.paperKey, "aps-target");
    assert.equal(details.fallbackMatches?.[0]?.field, "parsed_markdown");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("answer_research_question stops after local wiki evidence is found", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getAnswerResearchQuestionTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [
          {
            paperKey: "arxiv-local",
            title: "Local evidence",
            path: "knowledge-base/wiki/sources/arxiv-local.md",
            snippet: "local wiki evidence",
          },
        ],
      }),
      searchPapers: async () => {
        throw new Error("external search should not run when wiki evidence exists");
      },
    });

    const result = await tool.execute("research-call", {
      query: "quantum LDPC",
    }, undefined);
    const details = result.details as {
      status?: string;
      localEvidence?: { evidence?: unknown[] };
      externalCandidates?: unknown[];
    };

    assert.equal(details.status, "answered_from_wiki");
    assert.equal(details.localEvidence?.evidence?.length, 1);
    assert.deepEqual(details.externalCandidates, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("answer_research_question can download, parse, summarize, and refresh wiki evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const recordPath = path.join(workspace, "knowledge-base", "records", "arxiv-2601.00425.json");
  const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2601.00425.pdf");
  let wikiSearchCalls = 0;

  try {
    const tool = getAnswerResearchQuestionTool(workspace, {
      searchPaperWiki: async (options) => {
        wikiSearchCalls += 1;
        return {
          query: options.query,
          results: wikiSearchCalls > 1
            ? [
                {
                  paperKey: "arxiv-2601.00425",
                  title: "Newly summarized paper",
                  path: "knowledge-base/wiki/sources/arxiv-2601.00425.md",
                  snippet: "newly written wiki evidence",
                },
              ]
            : [],
        };
      },
      searchLocalPapers: async (options) => ({
        query: options.query,
        count: 0,
        results: [],
      }),
      searchPapers: async () => [
        {
          title: "Newly summarized paper",
          authors: ["A. Author"],
          summary: "Candidate summary",
          primarySource: "arxiv",
          primaryAction: "direct_download",
          sources: [
            {
              source: "arxiv",
              action: "direct_download",
              canonicalId: "2601.00425",
              articleUrl: "https://arxiv.org/abs/2601.00425",
              pdfUrl: "https://arxiv.org/pdf/2601.00425.pdf",
            },
          ],
        },
      ],
      downloadPaper: async () => ({
        status: "downloaded",
        source: "arxiv",
        canonicalId: "2601.00425",
        articleUrl: "https://arxiv.org/abs/2601.00425",
        finalPdfUrl: "https://arxiv.org/pdf/2601.00425.pdf",
        path: pdfPath,
        recordPath,
      }),
      fetchPaperWebPage: async () => {
        throw new Error("HTML unavailable");
      },
      parsePaper: async () => ({
        status: "parsed" as const,
        paperKey: "arxiv-2601.00425",
        engine: "tex-source" as const,
        pdfSha256: "pdf-hash",
        artifacts: {
          sourcePath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/source.json"),
          parsePath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/parses/tex-source/parse.json"),
          markdownPath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/parses/tex-source/document.md"),
          qualityPath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/parses/tex-source/quality.json"),
          chunksPath: path.join(workspace, "knowledge-base/wiki/sources/arxiv-2601.00425/chunks/tex-source.jsonl"),
        },
        quality: {
          status: "good" as const,
          score: 1,
          pages: 1,
          totalTextLength: 128,
          emptyPageCount: 0,
          headingCount: 1,
          tableCount: 0,
          figureOrCaptionCount: 0,
          warnings: [],
        },
        sections: [],
      }),
      generatePaperWikiSummary: async (options) => ({
        status: "written",
        paperKey: options.paperKey,
        engine: "tex-source",
        message: "Wrote wiki source summary.",
        evidence: {
          paperKey: options.paperKey,
          engine: "tex-source",
          pdfSha256: "pdf-hash",
          paths: {
            parseMarkdown: "document.md",
            parseJson: "parse.json",
            qualityJson: "quality.json",
          },
          sections: [],
          totalMarkdownChars: 7,
          truncated: false,
          markdownPreview: "preview",
        },
        source: {
          paperKey: options.paperKey,
          title: "Newly summarized paper",
          sourcePath: "knowledge-base/wiki/sources/arxiv-2601.00425.md",
          indexPath: "knowledge-base/wiki/index.md",
          logPath: "knowledge-base/wiki/log.md",
        },
      }),
      paperSummaryWorker: async () => ({
        summaryMarkdown: "summary",
        confidence: "high",
      }),
    });

    const result = await tool.execute("research-call", {
      query: "new topic",
      maxDownloads: 1,
    }, undefined);
    const details = result.details as {
      status?: string;
      downloaded?: Array<{ paperKey?: string; readingStatus?: string }>;
      summariesWritten?: Array<{ paperKey?: string; status?: string }>;
      refreshedEvidence?: { evidence?: unknown[] };
    };

    assert.equal(details.status, "expanded_with_new_sources");
    assert.equal(details.downloaded?.[0]?.paperKey, "arxiv-2601.00425");
    assert.equal(details.downloaded?.[0]?.readingStatus, "parsed");
    assert.equal(details.summariesWritten?.[0]?.status, "written");
    assert.equal(details.refreshedEvidence?.evidence?.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bootstrap_wiki_page_evidence generates missing source summaries and refreshes evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  let bootstrapCalls = 0;
  const generatedSummaries: string[] = [];

  try {
    const tool = getBootstrapWikiPageEvidenceTool(workspace, {
      bootstrapPaperWikiPageEvidence: async (options) => {
        bootstrapCalls += 1;
        return {
          status: bootstrapCalls > 1 ? "ready" : "needs_summary",
          topic: options.topic,
          ...(options.question ? { question: options.question } : {}),
          recommendedPageKey: "qldpc-superconducting-chips",
          seedQueries: ["qLDPC superconducting chip implementation challenges"],
          sourceEvidence: bootstrapCalls > 1
            ? [
                {
                  kind: "source",
                  key: "arxiv-2507.09690",
                  paperKey: "arxiv-2507.09690",
                  title: "Small Quantum LDPC Codes",
                  path: "knowledge-base/wiki/sources/arxiv-2507.09690.md",
                  snippet: "source summary evidence",
                  origin: "seed_search",
                },
              ]
            : [],
          pageContext: [],
          expandedSources: [],
          parsedFallbackMatches: [
            {
              paperKey: "arxiv-2507.09690",
              title: "Small Quantum LDPC Codes",
              field: "parsed_markdown",
              path: "knowledge-base/wiki/sources/arxiv-2507.09690/parses/tex-source/document.md",
              snippet: "parsed qLDPC evidence",
            },
          ],
          missingSummaries: bootstrapCalls > 1
            ? []
            : [
                {
                  paperKey: "arxiv-2507.09690",
                  title: "Small Quantum LDPC Codes",
                  reason: "Parsed paper matched the topic but has no wiki source summary.",
                  matches: [],
                },
              ],
          blocked: [],
        };
      },
      generatePaperWikiSummary: async (options) => {
        generatedSummaries.push(options.paperKey);
        return {
          status: "written",
          paperKey: options.paperKey,
          engine: "tex-source",
          message: "Wrote wiki source summary.",
          evidence: {
            paperKey: options.paperKey,
            engine: "tex-source",
            pdfSha256: "sha",
            paths: {
              parseMarkdown: "document.md",
              parseJson: "parse.json",
              qualityJson: "quality.json",
            },
            sections: [],
            totalMarkdownChars: 7,
            truncated: false,
            markdownPreview: "preview",
          },
          source: {
            paperKey: options.paperKey,
            title: "Small Quantum LDPC Codes",
            sourcePath: "knowledge-base/wiki/sources/arxiv-2507.09690.md",
            indexPath: "knowledge-base/wiki/index.md",
            logPath: "knowledge-base/wiki/log.md",
          },
        };
      },
      paperSummaryWorker: async () => ({
        summaryMarkdown: "summary",
        confidence: "high",
      }),
    });

    const result = await tool.execute("bootstrap-call", {
      topic: "qLDPC on superconducting chips",
      question: "请总结一下qLDPC码在超导量子芯片上实现的难点",
    }, undefined);
    const details = result.details as {
      status?: string;
      sourceEvidence?: unknown[];
      summariesWritten?: Array<{ paperKey?: string; status?: string }>;
    };

    assert.equal(details.status, "ready");
    assert.deepEqual(generatedSummaries, ["arxiv-2507.09690"]);
    assert.equal(details.summariesWritten?.[0]?.status, "written");
    assert.equal(details.sourceEvidence?.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("clarify_research_topic asks for user steering before broad research programs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getClarifyResearchTopicTool(workspace);
    const result = await tool.execute("clarify-call", {
      topic: "superconducting quantum computing",
      userRequest: "系统研究超导量子计算",
    }, undefined);
    const details = result.details as {
      role?: string;
      userLeads?: boolean;
      status?: string;
      questions?: Array<{ id?: string; question?: string }>;
      defaultAssumptions?: string[];
      nextStep?: string;
    };

    assert.equal(details.role, "research_assistant");
    assert.equal(details.userLeads, true);
    assert.equal(details.status, "needs_user_focus");
    assert.ok(details.questions?.some((question) => question.id === "research_goal"));
    assert.ok(details.questions?.some((question) => question.id === "deliverable"));
    assert.match(details.nextStep ?? "", /等待用户/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("research_topic_bootstrap maps local evidence into gaps and suggested pages", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getResearchTopicBootstrapTool(workspace, {
      bootstrapPaperWikiPageEvidence: async (options) => ({
        status: "ready",
        topic: options.topic,
        ...(options.question ? { question: options.question } : {}),
        recommendedPageKey: "superconducting-quantum-computing",
        seedQueries: ["superconducting quantum computing surface code"],
        sourceEvidence: [
          {
            kind: "source",
            key: "nature-s41586-024-08449-y",
            paperKey: "nature-s41586-024-08449-y",
            title: "Quantum error correction below the surface code threshold",
            path: "knowledge-base/wiki/sources/nature-s41586-024-08449-y.md",
            snippet: "surface code threshold on superconducting processors",
            origin: "seed_search",
          },
        ],
        pageContext: [],
        expandedSources: [],
        parsedFallbackMatches: [],
        missingSummaries: [],
        blocked: [],
      }),
    });

    const result = await tool.execute("bootstrap-research-topic", {
      topic: "superconducting quantum computing",
      question: "map the direction",
    }, undefined);
    const details = result.details as {
      recommendedPageKey?: string;
      localEvidenceCount?: number;
      gaps?: Array<{ id?: string; seedQuery?: string }>;
      suggestedPages?: Array<{ pageKey?: string }>;
    };

    assert.equal(details.recommendedPageKey, "superconducting-quantum-computing");
    assert.equal(details.localEvidenceCount, 1);
    assert.ok(details.gaps?.some((gap) => gap.id === "surface-code"));
    assert.ok(details.suggestedPages?.some((page) => page.pageKey === "surface-code-on-superconducting-processors"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("expand_research_topic searches externally even when local wiki evidence exists", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const searchedQueries: string[] = [];

  try {
    const tool = getExpandResearchTopicTool(workspace, {
      bootstrapPaperWikiPageEvidence: async (options) => ({
        status: "ready",
        topic: options.topic,
        ...(options.question ? { question: options.question } : {}),
        recommendedPageKey: "superconducting-quantum-computing",
        seedQueries: ["superconducting quantum computing roadmap"],
        sourceEvidence: [
          {
            kind: "source",
            key: "science-10.1126-science.1231930",
            paperKey: "science-10.1126-science.1231930",
            title: "Superconducting Circuits for Quantum Information",
            path: "knowledge-base/wiki/sources/science-10.1126-science.1231930.md",
            snippet: "local evidence exists",
            origin: "seed_search",
          },
        ],
        pageContext: [
          {
            kind: "page",
            key: "superconducting-quantum-computing",
            pageKey: "superconducting-quantum-computing",
            title: "超导量子计算",
            path: "knowledge-base/wiki/pages/superconducting-quantum-computing.md",
            snippet: "existing synthesis page",
            origin: "seed_search",
          },
        ],
        expandedSources: [],
        parsedFallbackMatches: [],
        missingSummaries: [],
        blocked: [],
      }),
      searchPapers: async (options) => {
        searchedQueries.push(options.query);
        return [
          {
            title: "Cryogenic control electronics for scalable superconducting quantum computing",
            authors: ["A. Author"],
            summary: "Candidate about cryogenic controls.",
            primarySource: "arxiv",
            primaryAction: "direct_download",
            sources: [
              {
                source: "arxiv",
                action: "direct_download",
                canonicalId: "2601.00001",
                articleUrl: "https://arxiv.org/abs/2601.00001",
                pdfUrl: "https://arxiv.org/pdf/2601.00001.pdf",
              },
            ],
          },
        ];
      },
    });

    const result = await tool.execute("expand-topic", {
      topic: "superconducting quantum computing",
      mode: "search",
      maxSeedQueries: 2,
      maxExternalCandidates: 2,
    }, undefined);
    const details = result.details as {
      status?: string;
      localEvidenceCount?: number;
      externalCandidates?: unknown[];
      searchedQueries?: string[];
    };

    assert.equal(details.status, "searched");
    assert.equal(details.localEvidenceCount, 1);
    assert.ok(searchedQueries.length > 0);
    assert.equal(details.searchedQueries?.length, searchedQueries.length);
    assert.equal(details.externalCandidates?.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page writes a synthesis page from local wiki evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [
          {
            paperKey: "arxiv-2507.09690",
            title: "Small Quantum LDPC Codes",
            path: "knowledge-base/wiki/sources/arxiv-2507.09690.md",
            snippet: "LDPC implementation evidence",
          },
        ],
      }),
      paperWikiPageWorker: async (input) => ({
        title: "qLDPC on Superconducting Chips",
        pageMarkdown: `## Overview\n\n${input.topic} depends on long-range couplers [arxiv-2507.09690].`,
        tags: ["qldpc", "superconducting-qubits"],
        openQuestions: ["How much crosstalk is tolerable?"],
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-page-call", {
      topic: "qLDPC on superconducting chips",
      question: "请总结一下qLDPC码在超导量子芯片上实现的难点",
      pageKey: "qldpc-superconducting-chips",
    }, undefined);
    const details = result.details as {
      status?: string;
      page?: { pagePath?: string; sourceCount?: number };
      evidence?: unknown[];
    };

    assert.equal(details.status, "written");
    assert.equal(details.page?.pagePath, "knowledge-base/wiki/pages/qldpc-superconducting-chips.md");
    assert.equal(details.page?.sourceCount, 1);
    assert.equal(details.evidence?.length, 1);

    const page = await readFile(path.join(workspace, "knowledge-base/wiki/pages/qldpc-superconducting-chips.md"), "utf8");
    assert.match(page, /type: "wiki-synthesis-page"/);
    assert.match(page, /qLDPC on Superconducting Chips/);
    assert.match(page, /arxiv-2507\.09690/);

    const index = await readFile(path.join(workspace, "knowledge-base/wiki/index.md"), "utf8");
    assert.match(index, /## Knowledge Entries/);
    assert.match(index, /\[qLDPC on Superconducting Chips\]\(pages\/qldpc-superconducting-chips\.md\)/);
    assert.match(index, /qldpc-superconducting-chips/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page can return a draft without writing the page", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [
          {
            paperKey: "arxiv-local",
            title: "Local source",
            path: "knowledge-base/wiki/sources/arxiv-local.md",
            snippet: "local evidence",
          },
        ],
      }),
      paperWikiPageWorker: async () => ({
        title: "Draft Page",
        pageMarkdown: "## Overview\n\nDraft content [arxiv-local].",
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-page-draft-call", {
      topic: "draft topic",
      mode: "draft",
    }, undefined);
    const details = result.details as {
      status?: string;
      draft?: { title?: string };
      page?: unknown;
    };

    assert.equal(details.status, "drafted");
    assert.equal(details.draft?.title, "Draft Page");
    assert.equal(details.page, undefined);
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

test("wiki_health delegates to the injected health checker dependency", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getWikiHealthTool(workspace, {
      checkWikiHealth: async (options) => ({
        totalPapers: 2,
        issueCount: 1,
        summary: {
          needs_download: 0,
          needs_authorization: 1,
          queued: 0,
          parse_missing: 0,
          parse_failed: 0,
          low_quality: 0,
          summary_missing: 0,
          missing_artifact: 0,
        },
        issues: [
          {
            kind: "needs_authorization",
            severity: "high",
            paperKey: "nature-s41586-024-00001-y",
            reason: `threshold:${options.lowQualityScoreThreshold ?? 0}; max:${options.maxItems ?? 0}`,
          },
        ],
        actions: ["1: Open/login through the paper browser or extension, then retry the affected downloads."],
      }),
    });

    const result = await tool.execute("wiki-health-call", {
      maxItems: 7,
      lowQualityScoreThreshold: 0.5,
    }, undefined);

    assert.equal((result.details as { totalPapers?: number }).totalPapers, 2);
    assert.equal((result.details as { issues?: Array<{ reason?: string }> }).issues?.[0]?.reason, "threshold:0.5; max:7");
    assert.equal(
      JSON.parse(result.content?.[0]?.text ?? "{}").summary.needs_authorization,
      1,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki_health_fix delegates to the injected health fixer dependency", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getWikiHealthFixTool(workspace, {
      fixWikiHealth: async (options) => ({
        checked: {
          totalPapers: 1,
          issueCount: 1,
          summary: {
            needs_download: 0,
            needs_authorization: 0,
            queued: 0,
            parse_missing: 1,
            parse_failed: 0,
            low_quality: 0,
            summary_missing: 0,
            missing_artifact: 0,
          },
          issues: [
            {
              kind: "parse_missing",
              severity: "medium",
              paperKey: "arxiv-2401.00001",
              reason: `dry:${options.dryRun === true}; kinds:${options.issueKinds?.join(",") ?? "all"}; max:${options.maxItems ?? 0}`,
            },
          ],
          actions: ["1: Parse downloaded papers that do not yet have reading artifacts."],
        },
        attempted: 1,
        fixed: options.dryRun === true ? 0 : 1,
        queued: 0,
        skipped: options.dryRun === true ? 1 : 0,
        failed: 0,
        results: [
          {
            issue: {
              kind: "parse_missing",
              severity: "medium",
              paperKey: "arxiv-2401.00001",
              reason: "Downloaded paper has no parsed reading artifacts.",
            },
            status: options.dryRun === true ? "skipped" : "fixed",
            action: "parse",
            message: `dry:${options.dryRun === true}; threshold:${options.lowQualityScoreThreshold ?? 0}`,
            details: {
              status: "parsed",
              markdown: "x".repeat(20000),
            },
          },
        ],
      }),
    });

    const result = await tool.execute("wiki-health-fix-call", {
      maxItems: 3,
      lowQualityScoreThreshold: 0.6,
      issueKinds: ["parse_missing"],
      dryRun: true,
    }, undefined);

    assert.equal((result.details as { attempted?: number }).attempted, 1);
    assert.equal((result.details as { skipped?: number }).skipped, 1);
    assert.equal(
      JSON.parse(result.content?.[0]?.text ?? "{}").results[0].message,
      "dry:true; threshold:0.6",
    );
    assert.ok((result.content?.[0]?.text?.length ?? 0) < 5000);
    assert.doesNotMatch(result.content?.[0]?.text ?? "", /xxxxx/);
    assert.equal(
      (result.details as { checked?: { issues?: Array<{ reason?: string }> } }).checked?.issues?.[0]?.reason,
      "dry:true; kinds:parse_missing; max:3",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
