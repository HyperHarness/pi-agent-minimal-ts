import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PaperDownloadError } from "../../src/agent/paper/acquisition/paper-download.js";
import type {
  PaperDownloadResult,
  PaperSearchResult
} from "../../src/agent/paper/types.js";
import * as agentTools from "../../src/agent/tools.js";
import { createTools, createToolsForBoundary, getToolBoundaryToolNames } from "../../src/agent/tools.js";
import {
  getToolBoundaryToolNames as getToolBoundaryToolNamesFromBoundaryModule,
  TOOL_BOUNDARY_NAMES as TOOL_BOUNDARY_NAMES_FROM_BOUNDARY_MODULE
} from "../../src/agent/tool-types.js";
import {
  resolvePaperPdfPath,
  updatePaperRecordParseManifest,
  writePaperRecord
} from "../../src/agent/paper/storage/paper-store.js";
import { writeTypedWikiPage } from "../../src/agent/wiki/typed-store.js";
import type { PaperWikiPageWorkerInput } from "../../src/agent/wiki/types.js";

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
    args: { path: string; offsetBytes?: number; maxBytes?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type LoadPaperWritingSkillTool = {
  execute: (
    toolCallId: string,
    args: { skillName?: string },
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

type WriteFileTool = {
  execute: (
    toolCallId: string,
    args: { path: string; content: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type WriteDesignArtifactTool = {
  execute: (
    toolCallId: string,
    args: {
      artifactType: "design_record" | "verification_report" | "failure_record" | "benchmark_case";
      title: string;
      artifactKey?: string;
      status?: "proposed" | "source-supported" | "tool-verified" | "expert-approved" | "assumed" | "unsupported" | "failed";
      contentMarkdown: string;
      relatedWikiPages?: string[];
      sourceKeys?: string[];
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type RunDesignScriptTool = {
  execute: (
    toolCallId: string,
    args: {
      scriptPath: string;
      runner?: "auto" | "python" | "klayout";
      outputPaths?: string[];
      maxOutputChars?: number;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type SyncDesignEnvironmentTool = {
  execute: (
    toolCallId: string,
    args: { projectPath: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type ReplaceFileTextTool = {
  execute: (
    toolCallId: string,
    args: { path: string; search: string; replacement: string; replaceAll?: boolean },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type DeleteFileTool = {
  execute: (
    toolCallId: string,
    args: { path: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type CompileLatexTool = {
  execute: (
    toolCallId: string,
    args: { texPath: string; runBibtex?: boolean; maxOutputChars?: number },
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
    args: {
      query: string;
      maxResults?: number;
      sourceKinds?: string[];
      pageTypes?: string[];
      claimKinds?: string[];
      knowledgeStates?: string[];
      evidenceContracts?: string[];
      maxEvidenceAgeDays?: number;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type WikiReviewPageTool = {
  execute: (
    toolCallId: string,
    args: { pageKey: string; maxEvidenceAgeDays?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type WikiLintTool = {
  execute: (
    toolCallId: string,
    args: {
      maxItems?: number;
      goal?: string;
      focus?: string[];
      includeCoverage?: boolean;
      includeQualityAudit?: boolean;
      includeAliasCandidates?: boolean;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type WikiStructurePlanTool = {
  execute: (
    toolCallId: string,
    args: {
      maxItems?: number;
      includeMediumRisk?: boolean;
      goal?: string;
      focus?: string[];
      includeGrowthActions?: boolean;
      budget?: {
        maxPagesToBuild?: number;
        maxAliasesToCreate?: number;
        maxScopeNotes?: number;
      };
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type WikiApplyStructurePlanTool = {
  execute: (
    toolCallId: string,
    args: { actions: unknown[]; dryRun?: boolean; requireLowRisk?: boolean; maxActions?: number; runVerification?: boolean },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type AnswerPaperWikiQuestionTool = {
  execute: (
    toolCallId: string,
    args: { query: string; maxResults?: number; maxEvidenceAgeDays?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type AnswerResearchQuestionTool = {
  execute: (
    toolCallId: string,
    args: {
      query: string;
      maxLocalResults?: number;
      maxEvidenceAgeDays?: number;
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
      evidenceContract?: "paper-backed" | "design-backed" | "code-backed" | "mixed";
      minSources?: number;
      requiredSourceKeys?: string[];
      forbidExternalEvidence?: boolean;
      verifyAfterWrite?: boolean;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type MergeWikiAliasesTool = {
  execute: (
    toolCallId: string,
    args: {
      aliases: Array<{
        alias: string;
        canonical: string;
        title?: string;
        note?: string;
      }>;
      replaceExisting?: boolean;
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
        | "download_blocked"
        | "citation_incomplete"
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

function getLoadPaperWritingSkillTool(workspace: string): LoadPaperWritingSkillTool {
  const tools = createTools(workspace, { toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: LoadPaperWritingSkillTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "load_paper_writing_skill");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as LoadPaperWritingSkillTool;
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

function getWriteFileTool(workspace: string): WriteFileTool {
  const tools = createTools(workspace) as ReadonlyArray<{
    name: string;
    execute?: WriteFileTool["execute"];
  }>;
  const writeFileTool = tools.find((tool) => tool.name === "write_file");
  assert.ok(writeFileTool);
  assert.equal(typeof writeFileTool.execute, "function");
  return writeFileTool as WriteFileTool;
}

function getWriteDesignArtifactTool(workspace: string): WriteDesignArtifactTool {
  const tools = createTools(workspace, { toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: WriteDesignArtifactTool["execute"];
  }>;
  const writeDesignArtifactTool = tools.find((tool) => tool.name === "write_design_artifact");
  assert.ok(writeDesignArtifactTool);
  assert.equal(typeof writeDesignArtifactTool.execute, "function");
  return writeDesignArtifactTool as WriteDesignArtifactTool;
}

function getRunDesignScriptTool(workspace: string): RunDesignScriptTool {
  const tools = createTools(workspace, { toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: RunDesignScriptTool["execute"];
  }>;
  const runDesignScriptTool = tools.find((tool) => tool.name === "run_design_script");
  assert.ok(runDesignScriptTool);
  assert.equal(typeof runDesignScriptTool.execute, "function");
  return runDesignScriptTool as RunDesignScriptTool;
}

function getSyncDesignEnvironmentTool(workspace: string): SyncDesignEnvironmentTool {
  const tools = createTools(workspace, { toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: SyncDesignEnvironmentTool["execute"];
  }>;
  const syncDesignEnvironmentTool = tools.find((tool) => tool.name === "sync_design_environment");
  assert.ok(syncDesignEnvironmentTool);
  assert.equal(typeof syncDesignEnvironmentTool.execute, "function");
  return syncDesignEnvironmentTool as SyncDesignEnvironmentTool;
}

function getUpdateDesignDependencyTool(workspaceDir: string) {
  const tool = createTools(workspaceDir, { toolProfile: "full" }).find(
    (candidate) => candidate.name === "update_design_dependency",
  );
  assert.ok(tool);
  return tool;
}

function getReplaceFileTextTool(workspace: string): ReplaceFileTextTool {
  const tools = createTools(workspace) as ReadonlyArray<{
    name: string;
    execute?: ReplaceFileTextTool["execute"];
  }>;
  const replaceFileTextTool = tools.find((tool) => tool.name === "replace_file_text");
  assert.ok(replaceFileTextTool);
  assert.equal(typeof replaceFileTextTool.execute, "function");
  return replaceFileTextTool as ReplaceFileTextTool;
}

function getDeleteFileTool(workspace: string): DeleteFileTool {
  const tools = createTools(workspace) as ReadonlyArray<{
    name: string;
    execute?: DeleteFileTool["execute"];
  }>;
  const deleteFileTool = tools.find((tool) => tool.name === "delete_file");
  assert.ok(deleteFileTool);
  assert.equal(typeof deleteFileTool.execute, "function");
  return deleteFileTool as DeleteFileTool;
}

function getCompileLatexTool(workspace: string): CompileLatexTool {
  const tools = createTools(workspace) as ReadonlyArray<{
    name: string;
    execute?: CompileLatexTool["execute"];
  }>;
  const compileLatexTool = tools.find((tool) => tool.name === "compile_latex");
  assert.ok(compileLatexTool);
  assert.equal(typeof compileLatexTool.execute, "function");
  return compileLatexTool as CompileLatexTool;
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

function getWikiReviewPageTool(
  workspace: string,
  dependencies?: Parameters<typeof createTools>[1],
): WikiReviewPageTool {
  const tools = createTools(workspace, { ...dependencies, toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: WikiReviewPageTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "wiki_review_page");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as WikiReviewPageTool;
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

function getWikiStructurePlanTool(
  workspace: string,
  dependencies: agentTools.ToolDependencies = {},
): WikiStructurePlanTool {
  const tool = createTools(workspace, dependencies).find((candidate) => candidate.name === "wiki_structure_plan");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as WikiStructurePlanTool;
}

function getWikiApplyStructurePlanTool(
  workspace: string,
  dependencies: agentTools.ToolDependencies = {},
): WikiApplyStructurePlanTool {
  const tool = createTools(workspace, dependencies).find((candidate) => candidate.name === "wiki_apply_structure_plan");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as WikiApplyStructurePlanTool;
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

function getMergeWikiAliasesTool(workspace: string): MergeWikiAliasesTool {
  const tools = createTools(workspace) as ReadonlyArray<{
    name: string;
    execute?: MergeWikiAliasesTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "merge_wiki_aliases");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as MergeWikiAliasesTool;
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

test("read_file returns bounded metadata for small files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const nested = path.join(workspace, "notes.txt");
  const expectedContent = "bounded read";
  await writeFile(nested, expectedContent, "utf8");

  try {
    const readFileTool = getReadFileTool(workspace);
    const result = await readFileTool.execute("call-small", { path: "notes.txt" }, undefined);
    assert.equal(result.content?.[0]?.text, expectedContent);
    assert.deepEqual(result.details, {
      path: "notes.txt",
      sizeBytes: Buffer.byteLength(expectedContent, "utf8"),
      offsetBytes: 0,
      requestedMaxBytes: 256 * 1024,
      maxBytes: 256 * 1024,
      returnedBytes: Buffer.byteLength(expectedContent, "utf8"),
      truncated: false
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file truncates large files by default and reports the next byte offset", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const nested = path.join(workspace, "large.txt");
  const content = "a".repeat(256 * 1024 + 17);
  await writeFile(nested, content, "utf8");

  try {
    const readFileTool = getReadFileTool(workspace);
    const result = await readFileTool.execute("call-large", { path: "large.txt" }, undefined);
    assert.equal(result.content?.[0]?.text, content.slice(0, 256 * 1024));
    assert.deepEqual(result.details, {
      path: "large.txt",
      sizeBytes: content.length,
      offsetBytes: 0,
      requestedMaxBytes: 256 * 1024,
      maxBytes: 256 * 1024,
      returnedBytes: 256 * 1024,
      truncated: true,
      nextOffsetBytes: 256 * 1024
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file reads an explicit byte range", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const nested = path.join(workspace, "range.txt");
  const content = "0123456789abcdef";
  await writeFile(nested, content, "utf8");

  try {
    const readFileTool = getReadFileTool(workspace);
    const result = await readFileTool.execute(
      "call-range",
      { path: "range.txt", offsetBytes: 4, maxBytes: 6 },
      undefined,
    );
    assert.equal(result.content?.[0]?.text, "456789");
    assert.deepEqual(result.details, {
      path: "range.txt",
      sizeBytes: content.length,
      offsetBytes: 4,
      requestedMaxBytes: 6,
      maxBytes: 6,
      returnedBytes: 6,
      truncated: true,
      nextOffsetBytes: 10
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_file clamps oversized maxBytes requests", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const nested = path.join(workspace, "huge.txt");
  const content = "b".repeat(1024 * 1024 + 11);
  await writeFile(nested, content, "utf8");

  try {
    const readFileTool = getReadFileTool(workspace);
    const result = await readFileTool.execute(
      "call-clamp",
      { path: "huge.txt", maxBytes: 2 * 1024 * 1024 },
      undefined,
    );
    assert.equal(result.content?.[0]?.text?.length, 1024 * 1024);
    assert.deepEqual(result.details, {
      path: "huge.txt",
      sizeBytes: content.length,
      offsetBytes: 0,
      requestedMaxBytes: 2 * 1024 * 1024,
      maxBytes: 1024 * 1024,
      returnedBytes: 1024 * 1024,
      truncated: true,
      nextOffsetBytes: 1024 * 1024
    });
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

test("load_paper_writing_skill loads a root worker-scoped prompt module", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const skillDir = path.join(workspace, "skills", "paper-writing-worker", "sciwrite");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "prompt.md"), "# SciWrite\n\nReview manuscript clarity.", "utf8");
  await writeFile(path.join(skillDir, "ATTRIBUTION.md"), "Adapted from SciWrite.", "utf8");

  try {
    const tool = getLoadPaperWritingSkillTool(workspace);
    const result = await tool.execute("call-skill", {}, undefined);
    assert.equal(result.content?.[0]?.text, "# SciWrite\n\nReview manuscript clarity.");
    assert.deepEqual(result.details, {
      skillName: "sciwrite",
      promptPath: "skills/paper-writing-worker/sciwrite/prompt.md",
      attributionPath: "skills/paper-writing-worker/sciwrite/ATTRIBUTION.md",
      bytes: Buffer.byteLength("# SciWrite\n\nReview manuscript clarity.", "utf8")
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("load_paper_writing_skill rejects unsafe skill names", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getLoadPaperWritingSkillTool(workspace);
    await assert.rejects(
      () => tool.execute("call-skill-unsafe", { skillName: "../sciwrite" }, undefined),
      /skill name/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("write_file creates and overwrites workspace text files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const writeFileTool = getWriteFileTool(workspace);
    const result = await writeFileTool.execute(
      "call-write-1",
      { path: "paper-projects/current/abstract.md", content: "# Abstract\nUpdated draft.\n" },
      undefined,
    );

    assert.equal(await readFile(path.join(workspace, "paper-projects/current/abstract.md"), "utf8"), "# Abstract\nUpdated draft.\n");
    assert.deepEqual(result.details, {
      path: "paper-projects/current/abstract.md",
      bytes: Buffer.byteLength("# Abstract\nUpdated draft.\n", "utf8"),
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("write_file rejects absolute paths outside the workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-outside-"));

  try {
    const writeFileTool = getWriteFileTool(workspace);
    await assert.rejects(
      () => writeFileTool.execute("call-write-2", { path: path.join(outside, "secret.txt"), content: "secret" }, undefined),
      /outside the workspace/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("write_file rejects synthesis wiki page writes", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const writeFileTool = getWriteFileTool(workspace);
    await assert.rejects(
      () => writeFileTool.execute(
        "call-write-wiki-page",
        { path: "knowledge-base/pages/eda.md", content: "# EDA\n" },
        undefined,
      ),
      /cannot create or overwrite synthesis wiki pages/i,
    );
    await assert.rejects(
      () => writeFileTool.execute(
        "call-write-wiki-page-absolute",
        { path: path.join(workspace, "knowledge-base/pages/eda.md"), content: "# EDA\n" },
        undefined,
      ),
      /cannot create or overwrite synthesis wiki pages/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("write_design_artifact writes design subagent records under knowledge-base/design-records", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const writeDesignArtifactTool = getWriteDesignArtifactTool(workspace);
    const result = await writeDesignArtifactTool.execute(
      "call-write-design-artifact",
      {
        artifactType: "failure_record",
        title: "Frequency Collision Attempt",
        artifactKey: "freq collision attempt",
        status: "failed",
        contentMarkdown:
          "## Design Goal\nAvoid fixed-frequency transmon collisions.\n\n## Reusable Lesson\nEscalate unresolved spectator collisions to solver-backed planning.\n",
        relatedWikiPages: ["frequency-allocation"],
        sourceKeys: ["aps-10.1103-PhysRevResearch.4.023079"],
      },
      undefined,
    );

    const expectedPath = "knowledge-base/design-records/failures/freq-collision-attempt.md";
    const artifact = await readFile(path.join(workspace, expectedPath), "utf8");
    assert.match(artifact, /^---\ntype: failure_record\n/m);
    assert.match(artifact, /status: failed/);
    assert.match(artifact, /related_wiki_pages:\n  - "frequency-allocation"/);
    assert.match(artifact, /source_keys:\n  - "aps-10\.1103-PhysRevResearch\.4\.023079"/);
    assert.match(artifact, /# Frequency Collision Attempt/);
    assert.match(artifact, /Escalate unresolved spectator collisions/);
    assert.deepEqual(result.details, {
      artifactType: "failure_record",
      path: expectedPath,
      bytes: Buffer.byteLength(artifact, "utf8"),
      title: "Frequency Collision Attempt",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("run_design_script executes a workspace Python design script and reports generated GDS outputs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    await writeFile(
      path.join(workspace, "single_xmon_concept_klayout.py"),
      [
        "from pathlib import Path",
        "Path('single_xmon_concept.gds').write_bytes(b'GDSII placeholder')",
        "print('wrote single_xmon_concept.gds')",
        ""
      ].join("\n"),
      "utf8",
    );

    const runDesignScriptTool = getRunDesignScriptTool(workspace);
    const result = await runDesignScriptTool.execute(
      "call-run-design-script",
      {
        scriptPath: "single_xmon_concept_klayout.py",
        runner: "python",
        outputPaths: ["single_xmon_concept.gds"],
      },
      undefined,
    );

    assert.deepEqual(result.details, {
      status: "completed",
      runner: "python",
      scriptPath: "single_xmon_concept_klayout.py",
      command: "python3 single_xmon_concept_klayout.py",
      exitCode: 0,
      stdout: "wrote single_xmon_concept.gds\n",
      stderr: "",
      outputs: [
        {
          path: "single_xmon_concept.gds",
          bytes: Buffer.byteLength("GDSII placeholder"),
        },
      ],
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("run_design_script uses the parent root venv Python and ignores nested design-code venvs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const projectDir = path.join(workspace, "knowledge-base", "design-code");
  const scriptDir = path.join(projectDir, "scripts");
  const rootVenvBinDir = path.join(workspace, ".venv", "bin");
  const nestedVenvBinDir = path.join(projectDir, ".venv", "bin");

  try {
    await mkdir(scriptDir, { recursive: true });
    await mkdir(rootVenvBinDir, { recursive: true });
    await mkdir(nestedVenvBinDir, { recursive: true });

    const rootVenvPython = path.join(rootVenvBinDir, "python");
    await writeFile(
      rootVenvPython,
      [
        "#!/bin/sh",
        "echo root-venv-python-used >&2",
        "exec python3 \"$@\"",
        ""
      ].join("\n"),
      "utf8",
    );
    await chmod(rootVenvPython, 0o755);

    const nestedVenvPython = path.join(nestedVenvBinDir, "python");
    await writeFile(
      nestedVenvPython,
      [
        "#!/bin/sh",
        "echo nested-venv-python-used >&2",
        "exec python3 \"$@\"",
        ""
      ].join("\n"),
      "utf8",
    );
    await chmod(nestedVenvPython, 0o755);

    await writeFile(
      path.join(scriptDir, "generate_gds.py"),
      [
        "from pathlib import Path",
        "Path('../outputs').mkdir(exist_ok=True)",
        "Path('../outputs/from-root-venv.gds').write_bytes(b'root venv gds')",
        "print('script complete')",
        ""
      ].join("\n"),
      "utf8",
    );

    const runDesignScriptTool = getRunDesignScriptTool(workspace);
    const result = await runDesignScriptTool.execute(
      "call-run-design-script-root-venv",
      {
        scriptPath: "knowledge-base/design-code/scripts/generate_gds.py",
        runner: "python",
        outputPaths: ["knowledge-base/design-code/outputs/from-root-venv.gds"],
      },
      undefined,
    );

    assert.deepEqual(result.details, {
      status: "completed",
      runner: "python",
      scriptPath: "knowledge-base/design-code/scripts/generate_gds.py",
      command: "../../../.venv/bin/python generate_gds.py",
      exitCode: 0,
      stdout: "script complete\n",
      stderr: "root-venv-python-used\n",
      outputs: [
        {
          path: "knowledge-base/design-code/outputs/from-root-venv.gds",
          bytes: Buffer.byteLength("root venv gds"),
        },
      ],
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sync_design_environment runs uv sync for knowledge-base design-code into the root venv", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");
  const fakeBinDir = path.join(workspace, "fake-bin");
  const callsPath = path.join(workspace, "uv-calls.jsonl");
  const originalPath = process.env.PATH;
  const originalUvCallsPath = process.env.PI_TEST_UV_CALLS_PATH;

  try {
    await mkdir(designCodeDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(
      path.join(designCodeDir, "pyproject.toml"),
      [
        "[project]",
        "name = \"pi-chip-design\"",
        "version = \"0.1.0\"",
        "requires-python = \">=3.11\"",
        "dependencies = [\"gdsfactory>=8\"]",
        ""
      ].join("\n"),
      "utf8",
    );

    const fakeUv = path.join(fakeBinDir, "uv");
    await writeFile(
      fakeUv,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const callsPath = process.env.PI_TEST_UV_CALLS_PATH;",
        "fs.appendFileSync(callsPath, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "  env: process.env.UV_PROJECT_ENVIRONMENT",
        "}) + '\\n');",
        "fs.mkdirSync(path.join(process.env.UV_PROJECT_ENVIRONMENT, 'bin'), { recursive: true });",
        "fs.writeFileSync(path.join(process.env.UV_PROJECT_ENVIRONMENT, 'bin', 'python'), '#!/bin/sh\\necho synced-python\\n');",
        "console.log('uv sync complete');",
        ""
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeUv, 0o755);

    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.PI_TEST_UV_CALLS_PATH = callsPath;

    const syncDesignEnvironmentTool = getSyncDesignEnvironmentTool(workspace);
    const result = await syncDesignEnvironmentTool.execute(
      "call-sync-design-environment",
      {
        projectPath: "knowledge-base/design-code",
      },
      undefined,
    );

    const details = result.details as Record<string, unknown>;
    assert.equal(details.status, "synced");
    assert.equal(details.projectPath, "knowledge-base/design-code");
    assert.equal(details.environmentPath, ".venv");
    assert.equal(details.pythonPath, ".venv/bin/python");
    assert.equal(details.command, "uv sync --project knowledge-base/design-code --extra dev");
    assert.equal(details.exitCode, 0);
    assert.equal(details.stderr, "");
    assert.equal(typeof details.stdout, "string");

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; env: string });
    assert.deepEqual(calls, [
      {
        argv: ["sync", "--project", designCodeDir, "--extra", "dev"],
        cwd: workspace,
        env: path.join(workspace, ".venv"),
      },
    ]);
  } finally {
    process.env.PATH = originalPath;
    if (originalUvCallsPath === undefined) {
      delete process.env.PI_TEST_UV_CALLS_PATH;
    } else {
      process.env.PI_TEST_UV_CALLS_PATH = originalUvCallsPath;
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

test("update_design_dependency adds a main dependency to design-code pyproject", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");
  const pyprojectPath = path.join(designCodeDir, "pyproject.toml");

  try {
    await mkdir(designCodeDir, { recursive: true });
    await writeFile(
      pyprojectPath,
      [
        "[project]",
        "name = \"pi-chip-design\"",
        "version = \"0.1.0\"",
        "requires-python = \">=3.11\"",
        "dependencies = [",
        "  \"gdsfactory>=8\",",
        "]",
        "",
      ].join("\n"),
      "utf8",
    );

    const updateDesignDependencyTool = getUpdateDesignDependencyTool(workspace);
    const result = await updateDesignDependencyTool.execute(
      "call-update-design-dependency-main",
      {
        name: "klayout",
        specifier: ">=0.29",
        group: "main",
      },
      undefined,
    );

    assert.deepEqual(result.details, {
      status: "updated",
      path: "knowledge-base/design-code/pyproject.toml",
      group: "main",
      dependency: "klayout>=0.29",
      changed: true,
    });
    assert.match(await readFile(pyprojectPath, "utf8"), /"klayout>=0\.29"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("update_design_dependency rejects invalid dependency names", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");

  try {
    await mkdir(designCodeDir, { recursive: true });
    await writeFile(
      path.join(designCodeDir, "pyproject.toml"),
      [
        "[project]",
        "name = \"pi-chip-design\"",
        "version = \"0.1.0\"",
        "requires-python = \">=3.11\"",
        "dependencies = []",
        "",
      ].join("\n"),
      "utf8",
    );

    const updateDesignDependencyTool = getUpdateDesignDependencyTool(workspace);
    await assert.rejects(
      updateDesignDependencyTool.execute(
        "call-update-design-dependency-invalid-name",
        {
          name: "../bad",
          specifier: ">=0.29",
          group: "main",
        },
        undefined,
      ),
      /Invalid Python dependency name/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("update_design_dependency preserves dependency extras in multiline arrays", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");
  const pyprojectPath = path.join(designCodeDir, "pyproject.toml");

  try {
    await mkdir(designCodeDir, { recursive: true });
    await writeFile(
      pyprojectPath,
      [
        "[project] # package metadata",
        "name = \"pi-chip-design\"",
        "version = \"0.1.0\"",
        "requires-python = \">=3.11\"",
        "dependencies = [",
        "  \"gdsfactory[dev]>=8\",",
        "  \"numpy>=2\",",
        "]",
        "",
      ].join("\n"),
      "utf8",
    );

    const updateDesignDependencyTool = getUpdateDesignDependencyTool(workspace);
    await updateDesignDependencyTool.execute(
      "call-update-design-dependency-extras",
      {
        name: "gdsfactory",
        specifier: ">=9",
        group: "main",
      },
      undefined,
    );

    const updated = await readFile(pyprojectPath, "utf8");
    assert.equal([...updated.matchAll(/"gdsfactory(?:\[dev\])?>=\d+"/g)].length, 1);
    assert.match(updated, /"gdsfactory>=9"/);
    assert.match(updated, /"numpy>=2"/);
    assert.doesNotMatch(updated, /"gdsfactory\[dev\]>=8"/);
    assert.equal([...updated.matchAll(/^\]\s*$/gm)].length, 1);
    assert.equal([...updated.matchAll(/^\[project\]/gm)].length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("update_design_dependency ignores commented dependencies", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");
  const pyprojectPath = path.join(designCodeDir, "pyproject.toml");

  try {
    await mkdir(designCodeDir, { recursive: true });
    await writeFile(
      pyprojectPath,
      [
        "[project]",
        "name = \"pi-chip-design\"",
        "version = \"0.1.0\"",
        "dependencies = [",
        "  # \"klayout>=0.28\",",
        "  \"gdsfactory>=8\",",
        "]",
        "",
      ].join("\n"),
      "utf8",
    );

    const updateDesignDependencyTool = getUpdateDesignDependencyTool(workspace);
    await updateDesignDependencyTool.execute(
      "call-update-design-dependency-commented",
      {
        name: "klayout",
        specifier: ">=0.29",
        group: "main",
      },
      undefined,
    );

    const updated = await readFile(pyprojectPath, "utf8");
    assert.equal([...updated.matchAll(/"klayout>=0\.29"/g)].length, 1);
    assert.doesNotMatch(updated, /"klayout>=0\.28"/);
    assert.match(updated, /"gdsfactory>=8"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("update_design_dependency updates dev dependency group", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");
  const pyprojectPath = path.join(designCodeDir, "pyproject.toml");

  try {
    await mkdir(designCodeDir, { recursive: true });
    await writeFile(
      pyprojectPath,
      [
        "[project]",
        "name = \"pi-chip-design\"",
        "version = \"0.1.0\"",
        "dependencies = [",
        "  \"gdsfactory>=8\",",
        "]",
        "",
        "[project.optional-dependencies]",
        "dev = [",
        "  \"pytest>=8\",",
        "]",
        "",
      ].join("\n"),
      "utf8",
    );

    const updateDesignDependencyTool = getUpdateDesignDependencyTool(workspace);
    const result = await updateDesignDependencyTool.execute(
      "call-update-design-dependency-dev",
      {
        name: "ruff",
        specifier: ">=0.6",
        group: "dev",
      },
      undefined,
    );

    assert.equal((result.details as { group?: string }).group, "dev");
    const updated = await readFile(pyprojectPath, "utf8");
    assert.match(updated, /\[project\.optional-dependencies\]\ndev = \[\n(?:  "pytest>=8",\n)?  "ruff>=0\.6",/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("update_design_dependency is idempotent for existing dependency", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");
  const pyprojectPath = path.join(designCodeDir, "pyproject.toml");

  try {
    await mkdir(designCodeDir, { recursive: true });
    await writeFile(
      pyprojectPath,
      [
        "[project]",
        "name = \"pi-chip-design\"",
        "version = \"0.1.0\"",
        "dependencies = [",
        "  \"klayout>=0.29\",",
        "]",
        "",
      ].join("\n"),
      "utf8",
    );

    const updateDesignDependencyTool = getUpdateDesignDependencyTool(workspace);
    await updateDesignDependencyTool.execute(
      "call-update-design-dependency-idempotent-1",
      {
        name: "klayout",
        specifier: ">=0.29",
        group: "main",
      },
      undefined,
    );
    const second = await updateDesignDependencyTool.execute(
      "call-update-design-dependency-idempotent-2",
      {
        name: "klayout",
        specifier: ">=0.29",
        group: "main",
      },
      undefined,
    );

    assert.equal((second.details as { changed?: boolean }).changed, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sync_design_environment rejects projects outside knowledge-base design-code", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const syncDesignEnvironmentTool = getSyncDesignEnvironmentTool(workspace);

    await assert.rejects(
      syncDesignEnvironmentTool.execute(
        "call-sync-design-environment-outside",
        {
          projectPath: "design-projects/superconducting-qubit-chip",
        },
        undefined,
      ),
      /sync_design_environment only runs for knowledge-base\/design-code/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sync_design_environment rejects symlinked knowledge-base design-code projects", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const knowledgeBaseDir = path.join(workspace, "knowledge-base");
  const otherProjectDir = path.join(workspace, "other-design-code");

  try {
    await mkdir(knowledgeBaseDir, { recursive: true });
    await mkdir(otherProjectDir, { recursive: true });
    await writeFile(
      path.join(otherProjectDir, "pyproject.toml"),
      [
        "[project]",
        "name = \"other-design-code\"",
        "version = \"0.1.0\"",
        "requires-python = \">=3.11\"",
        ""
      ].join("\n"),
      "utf8",
    );
    await symlink(otherProjectDir, path.join(knowledgeBaseDir, "design-code"), "dir");

    const syncDesignEnvironmentTool = getSyncDesignEnvironmentTool(workspace);

    await assert.rejects(
      syncDesignEnvironmentTool.execute(
        "call-sync-design-environment-symlink",
        {
          projectPath: "knowledge-base/design-code",
        },
        undefined,
      ),
      /sync_design_environment requires knowledge-base\/design-code to be a real directory/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("replace_file_text replaces a unique exact block", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const target = path.join(workspace, "manuscript.tex");
  await writeFile(target, "Before\nOld focus\nAfter\n", "utf8");

  try {
    const replaceFileTextTool = getReplaceFileTextTool(workspace);
    const result = await replaceFileTextTool.execute(
      "call-replace-1",
      { path: "manuscript.tex", search: "Old focus", replacement: "New chip-design focus" },
      undefined,
    );

    assert.equal(await readFile(target, "utf8"), "Before\nNew chip-design focus\nAfter\n");
    assert.deepEqual(result.details, {
      path: "manuscript.tex",
      replacements: 1,
      bytes: Buffer.byteLength("Before\nNew chip-design focus\nAfter\n", "utf8"),
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("replace_file_text requires a unique block unless replaceAll is true", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const target = path.join(workspace, "outline.md");
  await writeFile(target, "roadmap\nroadmap\n", "utf8");

  try {
    const replaceFileTextTool = getReplaceFileTextTool(workspace);
    await assert.rejects(
      () => replaceFileTextTool.execute(
        "call-replace-2",
        { path: "outline.md", search: "roadmap", replacement: "layout" },
        undefined,
      ),
      /occurs 2 times/i,
    );

    await replaceFileTextTool.execute(
      "call-replace-3",
      { path: "outline.md", search: "roadmap", replacement: "layout", replaceAll: true },
      undefined,
    );
    assert.equal(await readFile(target, "utf8"), "layout\nlayout\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("delete_file deletes text and LaTeX files inside the workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const texPath = path.join(workspace, "paper-projects/current/obsolete.tex");
  const mdPath = path.join(workspace, "paper-projects/current/notes/old.md");
  const pyPath = path.join(workspace, "tmp_cleanup.py");
  await mkdir(path.dirname(texPath), { recursive: true });
  await mkdir(path.dirname(mdPath), { recursive: true });
  await writeFile(texPath, "\\section{Old}\n", "utf8");
  await writeFile(mdPath, "# Old note\n", "utf8");
  await writeFile(pyPath, "print('temporary cleanup draft')\n", "utf8");

  try {
    const deleteFileTool = getDeleteFileTool(workspace);
    const texResult = await deleteFileTool.execute(
      "call-delete-1",
      { path: "paper-projects/current/obsolete.tex" },
      undefined,
    );
    const mdResult = await deleteFileTool.execute(
      "call-delete-2",
      { path: path.join(workspace, "paper-projects/current/notes/old.md") },
      undefined,
    );
    const pyResult = await deleteFileTool.execute(
      "call-delete-3",
      { path: "tmp_cleanup.py" },
      undefined,
    );

    await assert.rejects(() => readFile(texPath, "utf8"), /ENOENT/);
    await assert.rejects(() => readFile(mdPath, "utf8"), /ENOENT/);
    await assert.rejects(() => readFile(pyPath, "utf8"), /ENOENT/);
    assert.deepEqual(texResult.details, {
      path: "paper-projects/current/obsolete.tex",
      bytes: Buffer.byteLength("\\section{Old}\n", "utf8"),
    });
    assert.deepEqual(mdResult.details, {
      path: "paper-projects/current/notes/old.md",
      bytes: Buffer.byteLength("# Old note\n", "utf8"),
    });
    assert.deepEqual(pyResult.details, {
      path: "tmp_cleanup.py",
      bytes: Buffer.byteLength("print('temporary cleanup draft')\n", "utf8"),
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("delete_file rejects directories, binary-looking files, and .git paths", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  await mkdir(path.join(workspace, "paper-projects/current"), { recursive: true });
  await mkdir(path.join(workspace, ".git/info"), { recursive: true });
  await writeFile(path.join(workspace, "paper-projects/current/figure.pdf"), "%PDF-1.7\n", "utf8");
  await writeFile(path.join(workspace, ".git/info/exclude"), "*.log\n", "utf8");

  try {
    const deleteFileTool = getDeleteFileTool(workspace);
    await assert.rejects(
      () => deleteFileTool.execute("call-delete-3", { path: "paper-projects/current" }, undefined),
      /only deletes files/i,
    );
    await assert.rejects(
      () => deleteFileTool.execute("call-delete-4", { path: "paper-projects/current/figure.pdf" }, undefined),
      /text or LaTeX-related files/i,
    );
    await assert.rejects(
      () => deleteFileTool.execute("call-delete-5", { path: ".git/info/exclude" }, undefined),
      /\.git paths/i,
    );
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

test("compile_latex runs the fixed manuscript build sequence inside the workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const binDir = path.join(workspace, "bin");
  const manuscriptDir = path.join(workspace, "paper-projects/current/manuscript");
  await mkdir(binDir);
  await mkdir(manuscriptDir, { recursive: true });
  await writeFile(path.join(manuscriptDir, "main.tex"), "\\documentclass{article}\\begin{document}Hi\\end{document}\n", "utf8");

  const pdflatexPath = path.join(binDir, "pdflatex");
  const bibtexPath = path.join(binDir, "bibtex");
  await writeFile(
    pdflatexPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const tex = process.argv[process.argv.length - 1];",
      "const base = path.basename(tex, path.extname(tex));",
      "fs.appendFileSync('calls.log', `pdflatex ${tex}\\n`);",
      "fs.writeFileSync(`${base}.aux`, '\\\\relax\\n');",
      "fs.writeFileSync(`${base}.pdf`, '%PDF-1.7\\nfake\\n');",
      "console.log(`compiled ${tex}`);",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    bibtexPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.appendFileSync('calls.log', `bibtex ${process.argv[2]}\\n`);",
      "fs.writeFileSync(`${process.argv[2]}.bbl`, 'fake bibliography\\n');",
      "console.log(`bibtex ${process.argv[2]}`);",
    ].join("\n"),
    "utf8",
  );
  await chmod(pdflatexPath, 0o755);
  await chmod(bibtexPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

  try {
    const compileLatexTool = getCompileLatexTool(workspace);
    const result = await compileLatexTool.execute(
      "call-latex-1",
      { texPath: "paper-projects/current/manuscript/main.tex", maxOutputChars: 4000 },
      undefined,
    );

    assert.equal(await readFile(path.join(manuscriptDir, "calls.log"), "utf8"), [
      "pdflatex main.tex",
      "bibtex main",
      "pdflatex main.tex",
      "pdflatex main.tex",
      "",
    ].join("\n"));
    assert.deepEqual(result.details, {
      status: "compiled",
      texPath: "paper-projects/current/manuscript/main.tex",
      pdfPath: "paper-projects/current/manuscript/main.pdf",
      commands: [
        "pdflatex -interaction=nonstopmode -halt-on-error main.tex",
        "bibtex main",
        "pdflatex -interaction=nonstopmode -halt-on-error main.tex",
        "pdflatex -interaction=nonstopmode -halt-on-error main.tex",
      ],
      output: (result.details as { output: string }).output,
    });
    assert.equal(await readFile(path.join(manuscriptDir, "main.pdf"), "utf8"), "%PDF-1.7\nfake\n");
  } finally {
    process.env.PATH = originalPath;
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

const EXPECTED_DEFAULT_TOOL_NAMES = [
  "list_files",
  "read_file",
  "write_file",
  "replace_file_text",
  "delete_file",
  "compile_latex",
  "web_search",
  "fetch_url",
  "search_papers",
  "download_paper",
  "block_paper_download",
  "inspect_paper",
  "read_paper_section",
  "search_paper_text",
  "answer_paper_wiki_question",
  "answer_research_question",
  "bootstrap_wiki_page_evidence",
  "build_wiki_page",
  "merge_wiki_aliases",
  "clarify_research_topic",
  "research_topic_bootstrap",
  "expand_research_topic",
  "wiki_review_page",
  "search_local_papers",
  "wiki_health",
  "wiki_lint",
  "wiki_structure_plan",
  "wiki_apply_structure_plan",
  "wiki_health_fix",
] as const;

const EXPECTED_FULL_ONLY_TOOL_NAMES = [
  "write_paper_wiki_source",
  "generate_paper_wiki_summary",
  "paper_wiki_relations",
  "search_paper_wiki",
  "write_design_artifact",
  "update_design_dependency",
  "sync_design_environment",
  "run_design_script",
  "paper_orchestra_prepare_workspace",
  "paper_orchestra_check_draft",
  "paper_orchestra_score_delta",
  "paper_orchestra_snapshot_provenance",
  "load_paper_writing_skill",
  "list_local_papers",
  "fetch_paper_webpage",
  "register_manual_paper_download",
  "open_paper_page_for_login",
  "parse_paper",
] as const;

const EXPECTED_FULL_TOOL_NAMES = [
  "get_time",
  ...EXPECTED_DEFAULT_TOOL_NAMES,
  ...EXPECTED_FULL_ONLY_TOOL_NAMES,
] as const;

test("createTools exposes the minimal default tool set", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace);
    const toolNames = tools.map((tool) => tool.name);
    assert.deepEqual(toolNames, [...EXPECTED_DEFAULT_TOOL_NAMES]);

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
    assert.deepEqual(toolNames, [...EXPECTED_FULL_TOOL_NAMES]);
    assert.ok(!tools.some((tool) => tool.name === "wiki_coverage_map"));
    assert.ok(!tools.some((tool) => tool.name === "wiki_concept_triage"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createToolsForBoundary exposes isolated wiki and worker tool surfaces", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const wikiAgentTools = createToolsForBoundary(workspace, "wiki-agent");
    assert.deepEqual(wikiAgentTools.map((tool) => tool.name), getToolBoundaryToolNames("wiki-agent"));
    assert.ok(wikiAgentTools.some((tool) => tool.name === "build_wiki_page"));
    assert.ok(wikiAgentTools.some((tool) => tool.name === "search_paper_wiki"));
    assert.ok(wikiAgentTools.some((tool) => tool.name === "wiki_structure_plan"));
    assert.ok(wikiAgentTools.some((tool) => tool.name === "wiki_apply_structure_plan"));
    assert.ok(!wikiAgentTools.some((tool) => tool.name === "download_paper"));
    assert.ok(!wikiAgentTools.some((tool) => tool.name === "generate_paper_wiki_summary"));
    assert.ok(!wikiAgentTools.some((tool) => tool.name === "web_search"));

    const downloadTools = createToolsForBoundary(workspace, "paper-download-subagent");
    assert.deepEqual(downloadTools.map((tool) => tool.name), getToolBoundaryToolNames("paper-download-subagent"));
    assert.ok(downloadTools.some((tool) => tool.name === "get_time"));
    assert.ok(downloadTools.some((tool) => tool.name === "download_paper"));
    assert.ok(downloadTools.some((tool) => tool.name === "parse_paper"));
    assert.ok(!downloadTools.some((tool) => tool.name === "build_wiki_page"));
    assert.ok(!downloadTools.some((tool) => tool.name === "wiki_structure_plan"));
    assert.ok(!downloadTools.some((tool) => tool.name === "wiki_apply_structure_plan"));
    assert.ok(!downloadTools.some((tool) => tool.name === "write_paper_wiki_source"));

    const evidenceTools = createToolsForBoundary(workspace, "wiki-evidence-worker");
    assert.deepEqual(evidenceTools.map((tool) => tool.name), getToolBoundaryToolNames("wiki-evidence-worker"));
    assert.ok(evidenceTools.some((tool) => tool.name === "generate_paper_wiki_summary"));
    assert.ok(evidenceTools.some((tool) => tool.name === "write_paper_wiki_source"));
    assert.ok(!evidenceTools.some((tool) => tool.name === "download_paper"));
    assert.ok(!evidenceTools.some((tool) => tool.name === "build_wiki_page"));
    assert.ok(!evidenceTools.some((tool) => tool.name === "wiki_structure_plan"));
    assert.ok(!evidenceTools.some((tool) => tool.name === "wiki_apply_structure_plan"));

    const designTools = createToolsForBoundary(workspace, "design-agent");
    assert.deepEqual(designTools.map((tool) => tool.name), getToolBoundaryToolNames("design-agent"));
    const legacyDesignTools = createToolsForBoundary(workspace, "design-subagent");
    assert.deepEqual(
      legacyDesignTools.map((tool) => tool.name),
      designTools.map((tool) => tool.name)
    );
    assert.ok(designTools.some((tool) => tool.name === "answer_paper_wiki_question"));
    assert.ok(designTools.some((tool) => tool.name === "search_paper_wiki"));
    assert.ok(designTools.some((tool) => tool.name === "write_design_artifact"));
    assert.ok(designTools.some((tool) => tool.name === "sync_design_environment"));
    assert.ok(designTools.some((tool) => tool.name === "run_design_script"));
    assert.ok(!designTools.some((tool) => tool.name === "download_paper"));
    assert.ok(!designTools.some((tool) => tool.name === "web_search"));
    assert.ok(!designTools.some((tool) => tool.name === "build_wiki_page"));
    assert.ok(!designTools.some((tool) => tool.name === "wiki_structure_plan"));
    assert.ok(!designTools.some((tool) => tool.name === "wiki_apply_structure_plan"));
    assert.ok(!designTools.some((tool) => tool.name === "write_paper_wiki_source"));

    const writingTools = createToolsForBoundary(workspace, "paper-writing-worker");
    assert.deepEqual(writingTools.map((tool) => tool.name), getToolBoundaryToolNames("paper-writing-worker"));
    assert.ok(writingTools.some((tool) => tool.name === "load_paper_writing_skill"));
    assert.ok(writingTools.some((tool) => tool.name === "write_file"));
    assert.ok(writingTools.some((tool) => tool.name === "compile_latex"));
    assert.ok(writingTools.some((tool) => tool.name === "answer_paper_wiki_question"));
    assert.ok(writingTools.some((tool) => tool.name === "search_paper_wiki"));
    assert.ok(!writingTools.some((tool) => tool.name === "download_paper"));
    assert.ok(!writingTools.some((tool) => tool.name === "web_search"));
    assert.ok(!writingTools.some((tool) => tool.name === "generate_paper_wiki_summary"));
    assert.ok(!writingTools.some((tool) => tool.name === "build_wiki_page"));
    assert.ok(!writingTools.some((tool) => tool.name === "wiki_structure_plan"));
    assert.ok(!writingTools.some((tool) => tool.name === "wiki_apply_structure_plan"));
    assert.ok(!writingTools.some((tool) => tool.name === "write_paper_wiki_source"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createToolsForBoundary keeps every boundary in declared order", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    for (const role of [
      "wiki-agent",
      "paper-download-subagent",
      "wiki-evidence-worker",
      "design-agent",
      "design-subagent",
      "paper-writing-worker",
    ] as const) {
      const tools = createToolsForBoundary(workspace, role);
      assert.deepEqual(tools.map((tool) => tool.name), getToolBoundaryToolNames(role));
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tools module re-exports tool boundary names from tool types", () => {
  assert.equal(agentTools.TOOL_BOUNDARY_NAMES, TOOL_BOUNDARY_NAMES_FROM_BOUNDARY_MODULE);

  for (const role of [
    "wiki-agent",
    "paper-download-subagent",
    "wiki-evidence-worker",
    "design-agent",
    "design-subagent",
    "paper-writing-worker",
  ] as const) {
    assert.deepEqual(getToolBoundaryToolNames(role), getToolBoundaryToolNamesFromBoundaryModule(role));
  }
});

test("build_wiki_page can disable external evidence acquisition for wiki boundaries", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  let pageWorkerCalled = false;

  try {
    const tool = getBuildWikiPageTool(workspace, {
      allowBuildWikiPageExternalEvidence: false,
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [],
      }),
      paperWikiPageWorker: async () => {
        pageWorkerCalled = true;
        return {
          title: "Should Not Run",
          pageMarkdown: "## Overview\n\nNo evidence.",
        };
      },
    });

    const result = await tool.execute("build-page-no-external", {
      topic: "unbacked topic",
      pageKey: "unbacked-topic",
    }, undefined);
    const details = result.details as {
      status?: string;
      message?: string;
      evidence?: unknown[];
    };

    assert.equal(details.status, "needs_evidence");
    assert.match(details.message ?? "", /external evidence acquisition is disabled/);
    assert.deepEqual(details.evidence, []);
    assert.equal(pageWorkerCalled, false);
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

test("fetch_paper_webpage saves full article text but returns compact JSON for model context", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: Array<{ url: string }> = [];
  const capturedSaves: Array<{ paperKey?: string; force?: boolean; markdown: string }> = [];
  const largeMarkdown = `# Paper title\n\n${"Full article text. ".repeat(500)}`;
  const largeAsset = Buffer.from("fake image bytes").toString("base64").repeat(500);

  try {
    const fetchPaperWebpageTool = getFetchPaperWebpageTool(workspace, {
      fetchPaperWebPage: async (options) => {
        capturedCalls.push(options);
        return {
          url: options.url,
          title: "Paper title",
          markdown: largeMarkdown,
          assets: [
            {
              url: "https://example.com/figure.png",
              dataBase64: largeAsset,
              mimeType: "image/png",
              alt: "Figure",
            },
          ],
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
            sourcePath: path.join(workspace, "knowledge-base/sources/example-paper/source.json"),
            parsePath: path.join(workspace, "knowledge-base/sources/example-paper/parses/webpage/parse.json"),
            markdownPath: path.join(workspace, "knowledge-base/sources/example-paper/parses/webpage/document.md"),
            qualityPath: path.join(workspace, "knowledge-base/sources/example-paper/parses/webpage/quality.json"),
            chunksPath: path.join(workspace, "knowledge-base/sources/example-paper/chunks/webpage.jsonl"),
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
      markdownPreview: `${largeMarkdown.slice(0, 1999).trimEnd()}...`,
      markdownChars: largeMarkdown.length,
      markdownOmitted: true,
      assets: {
        count: 1,
        omittedDataBase64: true,
      },
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
          sourcePath: path.join(workspace, "knowledge-base/sources/example-paper/source.json"),
          parsePath: path.join(workspace, "knowledge-base/sources/example-paper/parses/webpage/parse.json"),
          markdownPath: path.join(workspace, "knowledge-base/sources/example-paper/parses/webpage/document.md"),
          qualityPath: path.join(workspace, "knowledge-base/sources/example-paper/parses/webpage/quality.json"),
          chunksPath: path.join(workspace, "knowledge-base/sources/example-paper/chunks/webpage.jsonl"),
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
      nextSteps: [
        "Use savedParse.paperKey with read_paper_section or search_paper_text for targeted reading.",
        "Use savedParse.artifacts.markdownPath if you need the full saved markdown file.",
      ],
    };
    assert.deepEqual(capturedCalls, [{ url: "https://example.com/article" }]);
    assert.deepEqual(capturedSaves, [
      {
        paperKey: "example-paper",
        force: true,
        markdown: largeMarkdown,
      },
    ]);
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: JSON.stringify(expected),
      },
    ]);
    assert.deepEqual(result.details, expected);
    assert.ok(!result.content?.[0]?.text?.includes("dataBase64"));
    assert.ok(!result.content?.[0]?.text?.includes(largeMarkdown));
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
            sourcePath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/source.json"),
            parsePath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/webpage/parse.json"),
            markdownPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/webpage/document.md"),
            qualityPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/webpage/quality.json"),
            chunksPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/chunks/webpage.jsonl"),
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

test("download_paper refreshes arXiv webpage parsing when only a PDF parse exists", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const pdfPath = path.join(workspace, "papers", "arxiv-2603.11188.pdf");
  const calls: string[] = [];

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\nmock pdf\n", "utf8");
    const recordPath = await writePaperRecord({
      workspaceDir: workspace,
      record: {
        source: "arxiv",
        articleUrl: "https://arxiv.org/abs/2603.11188",
        recordedAt: "2026-05-20T02:17:55.737Z",
        handlingMethod: "direct_http",
        status: "downloaded",
        canonicalId: "2603.11188",
        pdfUrl: "https://arxiv.org/pdf/2603.11188.pdf",
        downloadPath: pdfPath,
      },
    });
    const managerResult: PaperDownloadResult = {
      status: "already_downloaded",
      source: "arxiv",
      canonicalId: "2603.11188",
      articleUrl: "https://arxiv.org/abs/2603.11188",
      finalPdfUrl: "https://arxiv.org/pdf/2603.11188.pdf",
      path: pdfPath,
      recordPath,
      recordedAt: "2026-05-20T02:17:55.737Z",
    };
    await updatePaperRecordParseManifest({
      workspaceDir: workspace,
      recordPath,
      strategy: "pdf_parse",
      status: "parsed",
      paperKey: "arxiv-2603.11188",
      engine: "opendataloader-local",
      sourceSha256: "pdf-hash",
      artifacts: {
        markdownPath: path.join(workspace, "knowledge-base/sources/arxiv-2603.11188/parses/opendataloader-local/document.md"),
        parsePath: path.join(workspace, "knowledge-base/sources/arxiv-2603.11188/parses/opendataloader-local/parse.json"),
        qualityPath: path.join(workspace, "knowledge-base/sources/arxiv-2603.11188/parses/opendataloader-local/quality.json"),
        chunksPath: path.join(workspace, "knowledge-base/sources/arxiv-2603.11188/chunks/opendataloader-local.jsonl"),
      },
      quality: {
        status: "good",
        score: 0.94,
        pages: 18,
        totalTextLength: 73026,
        warnings: [],
      },
    });

    const downloadPaperTool = getDownloadPaperTool(workspace, {
      downloadPaper: async () => managerResult,
      fetchPaperWebPage: async (options) => {
        calls.push(`fetch:${options.url}`);
        return {
          url: options.url,
          title: "Rhenium as a material platform for long-lived transmon qubits",
          markdown: "# Rhenium as a material platform for long-lived transmon qubits\n\nHTML full text.",
          metadata: {
            title: "Rhenium as a material platform for long-lived transmon qubits",
            authors: [],
          },
          access: {
            status: "full_text",
            signals: [],
          },
          stats: {
            chars: 86,
            wordsApprox: 12,
            navigationLinesRemoved: 0,
            extractedFrom: "article",
          },
        };
      },
      savePaperWebPageParse: async (options) => {
        calls.push(`save:${options.paperKey}`);
        return {
          status: "parsed",
          paperKey: options.paperKey ?? "arxiv-2603.11188",
          engine: "webpage",
          pdfSha256: "webpage-hash",
          artifacts: {
            sourcePath: path.join(workspace, "knowledge-base/sources/arxiv-2603.11188/source.json"),
            parsePath: path.join(workspace, "knowledge-base/sources/arxiv-2603.11188/parses/webpage/parse.json"),
            markdownPath: path.join(workspace, "knowledge-base/sources/arxiv-2603.11188/parses/webpage/document.md"),
            qualityPath: path.join(workspace, "knowledge-base/sources/arxiv-2603.11188/parses/webpage/quality.json"),
            chunksPath: path.join(workspace, "knowledge-base/sources/arxiv-2603.11188/chunks/webpage.jsonl"),
          },
          quality: {
            status: "good",
            score: 1,
            pages: 1,
            totalTextLength: 2048,
            emptyPageCount: 0,
            headingCount: 5,
            tableCount: 0,
            figureOrCaptionCount: 2,
            warnings: [],
          },
          sections: [],
        };
      },
      parsePaper: async () => {
        throw new Error("PDF parsing should not run when arXiv webpage refresh succeeds");
      },
    });

    const result = await downloadPaperTool.execute(
      "call-arxiv-webpage-refresh",
      { url: "https://arxiv.org/abs/2603.11188" },
      undefined,
    );

    assert.deepEqual(calls, [
      "fetch:https://arxiv.org/html/2603.11188",
      "save:arxiv-2603.11188",
    ]);
    assert.equal((result.details as { reading?: { status?: string } }).reading?.status, "parsed");
    assert.equal((result.details as { reading?: { strategy?: string } }).reading?.strategy, "webpage");
    assert.equal((result.details as { reading?: { engine?: string } }).reading?.engine, "webpage");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper falls back from arxiv.org HTML to ar5iv labs HTML before TeX parsing", async () => {
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
        if (options.url === "https://arxiv.org/html/2601.00425") {
          throw new Error("arxiv.org HTML unavailable");
        }
        return {
          url: options.url,
          title: "Arxiv mirror HTML Paper",
          markdown: "# Arxiv mirror HTML Paper\n\nFull article text from ar5iv labs HTML.",
          metadata: {
            title: "Arxiv mirror HTML Paper",
            authors: [],
          },
          access: {
            status: "full_text",
            signals: [],
          },
          stats: {
            chars: 60,
            wordsApprox: 10,
            navigationLinesRemoved: 0,
            extractedFrom: "article",
          },
        };
      },
      savePaperWebPageParse: async (options) => {
        calls.push(`save:${options.extraction.url}`);
        return {
          status: "parsed",
          paperKey: options.paperKey ?? "arxiv-2601.00425",
          engine: "webpage",
          pdfSha256: "webpage-hash",
          artifacts: {
            sourcePath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/source.json"),
            parsePath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/webpage/parse.json"),
            markdownPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/webpage/document.md"),
            qualityPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/webpage/quality.json"),
            chunksPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/chunks/webpage.jsonl"),
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
        throw new Error("TeX source should not be parsed when ar5iv fallback HTML succeeds");
      },
    });

    const result = await downloadPaperTool.execute(
      "call-arxiv-html-mirror-fallback",
      { id: "2601.00425" },
      undefined,
    );

    assert.deepEqual(calls, [
      "fetch:https://arxiv.org/html/2601.00425",
      "fetch:https://ar5iv.labs.arxiv.org/html/2601.00425",
      "save:https://ar5iv.labs.arxiv.org/html/2601.00425",
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
            sourcePath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/source.json"),
            parsePath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/tex-source/parse.json"),
            markdownPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/tex-source/document.md"),
            qualityPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/tex-source/quality.json"),
            chunksPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/chunks/tex-source.jsonl"),
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
      "fetch:https://ar5iv.labs.arxiv.org/html/2601.00425",
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
        markdownPath: path.join(workspace, "knowledge-base/sources/nature-s41586-019-1666-5/parses/webpage/document.md"),
        parsePath: path.join(workspace, "knowledge-base/sources/nature-s41586-019-1666-5/parses/webpage/parse.json"),
        qualityPath: path.join(workspace, "knowledge-base/sources/nature-s41586-019-1666-5/parses/webpage/quality.json"),
        chunksPath: path.join(workspace, "knowledge-base/sources/nature-s41586-019-1666-5/chunks/webpage.jsonl")
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
      "knowledge-base/sources/nature-s41586-019-1666-5/parses/webpage/document.md"
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
      recordPath: path.join(workspace, "knowledge-base", "sources", "science-10.1126-science.adz8659", "acquisition.json"),
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
      recordPath: path.join(workspace, "knowledge-base", "sources", "science-10.1126-science.adz8659", "acquisition.json"),
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
      recordPath: path.join(workspace, "knowledge-base", "sources", "aps-10.1103-PhysRevLett.134.090601", "acquisition.json"),
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
      recordPath: path.join(workspace, "knowledge-base", "sources", `science-${fallbackCanonicalId}`, "acquisition.json"),
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
          sourcePath: path.join(options.workspaceDir, "knowledge-base/sources/arxiv-2406.06015/source.json"),
          parsePath: path.join(options.workspaceDir, "knowledge-base/sources/arxiv-2406.06015/parses/plain-text-baseline/parse.json"),
          markdownPath: path.join(options.workspaceDir, "knowledge-base/sources/arxiv-2406.06015/parses/plain-text-baseline/document.md"),
          qualityPath: path.join(options.workspaceDir, "knowledge-base/sources/arxiv-2406.06015/parses/plain-text-baseline/quality.json"),
          chunksPath: path.join(options.workspaceDir, "knowledge-base/sources/arxiv-2406.06015/chunks/plain-text-baseline.jsonl"),
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
          sourcePath: "knowledge-base/sources/arxiv-2406.06015/summary.md",
          manifestPath: "knowledge-base/manifests/arxiv-2406.06015.json",
          operationId: "write_source_summary-test",
          operationJournalPath: "knowledge-base/state/wiki-operations.jsonl",
          indexPath: "knowledge-base/index.md",
          logPath: "knowledge-base/log.md",
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
    assert.equal((result.details as { sourcePath?: string }).sourcePath, "knowledge-base/sources/arxiv-2406.06015/summary.md");
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
            sourcePath: "knowledge-base/sources/aps-target/summary.md",
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
            path: "knowledge-base/sources/arxiv-2406.06015/summary.md",
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

test("search_paper_wiki forwards structured evidence filters to the wiki search dependency", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: unknown[] = [];
  try {
    const tool = getSearchPaperWikiTool(workspace, {
      searchPaperWiki: async (options) => {
        capturedCalls.push(options);
        return {
          query: options.query,
          results: [],
        };
      },
    });

    await tool.execute("search-wiki-call", {
      query: "qldpc hardware embedding",
      maxResults: 3,
      sourceKinds: ["paper", "code-output"],
      pageTypes: ["finding"],
      claimKinds: ["quantitative", "limitation"],
      knowledgeStates: ["promising_unverified", "disputed"],
      evidenceContracts: ["paper-backed", "code-backed"],
      maxEvidenceAgeDays: 30,
    }, undefined);

    assert.deepEqual(capturedCalls, [
      {
        workspaceDir: workspace,
        query: "qldpc hardware embedding",
        maxResults: 3,
        sourceKinds: ["paper", "code-output"],
        pageTypes: ["finding"],
        claimKinds: ["quantitative", "limitation"],
        knowledgeStates: ["promising_unverified", "disputed"],
        evidenceContracts: ["paper-backed", "code-backed"],
        maxEvidenceAgeDays: 30,
      },
    ]);
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
            source_without_synthesis_coverage: 0,
            source_derived_page_key: 0,
            orphan_page: 0,
            concept_gap: 1,
            high_value_concept_gap: 0,
            evidence_contract_gap: 0,
            semantic_alias_candidate: 0,
            scope_drift: 0,
            duplicate_page_title: 0,
            near_duplicate_page: 0,
            duplicate_section: 0,
            weak_evidence_contract: 0,
            weak_synthesis_page: 0,
            missing_claim_provenance: 0,
            unresolved_contradiction: 0,
            missing_typed_relation: 0,
            missing_experiment_ref: 0,
            code_backed_without_experiment: 0,
            rendered_wiki_link: 0,
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
          reports: {
            conceptTriage: {
              rankedConcepts: [
                {
                  concept: "qldpc",
                  sourceCount: 2,
                  sourcePaperKeys: ["source-a", "source-b"],
                  priority: "high",
                  score: 7,
                  evidenceReadiness: "ready",
                  recommendedAction: "build_page",
                  representativeSources: [],
                  rationale: "2 sources mention qldpc; goal overlap 2.",
                },
              ],
            },
          },
        };
      },
    });

    const result = await tool.execute("wiki-lint-call", {
      maxItems: 5,
      goal: "superconducting qLDPC design",
      focus: ["decoder hardware", "fault tolerance"],
      includeCoverage: true,
      includeQualityAudit: true,
      includeAliasCandidates: true,
    }, undefined);

    assert.deepEqual(capturedCalls, [{
      workspaceDir: workspace,
      maxItems: 5,
      goal: "superconducting qLDPC design",
      focus: ["decoder hardware", "fault tolerance"],
      includeCoverage: true,
      includeQualityAudit: true,
      includeAliasCandidates: true,
    }]);
    assert.equal((result.details as { issueCount?: number }).issueCount, 1);
    assert.deepEqual(
      (result.details as { reports?: { conceptTriage?: { rankedConcepts?: Array<{ concept?: string }> } } }).reports?.conceptTriage?.rankedConcepts?.map((item) => item.concept),
      ["qldpc"]
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki_review_page returns deterministic findings for a speculative mixed page", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    await writeTypedWikiPage({
      workspaceDir: workspace,
      page: {
        metadata: {
          schema_version: 1,
          type: "finding",
          key: "qldpc-hardware-embedding",
          title: "qLDPC hardware embedding",
          aliases: [],
          tags: ["qldpc"],
          evidence_contract: "mixed",
          source_refs: ["arxiv-2406.06015"],
          knowledge_state: "speculative",
          last_reviewed_at: "2000-01-01T00:00:00.000Z",
          claims: [{
            claimId: "claim-1",
            kind: "quantitative",
            statement: "The design has 1e-3 logical error rate according to author claims.",
            sourceRefs: ["arxiv-2406.06015"],
            evidence: [{ paperKey: "arxiv-2406.06015", page: 3 }],
            confidence: "low",
          }],
          typed_relations: [{
            type: "contradicts",
            target: "surface-code-baseline",
            targetKind: "page",
            evidenceRefs: ["claim-1"],
            status: "candidate",
          }],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z",
        },
        body: "# qLDPC hardware embedding\n\nClaim\n\nNo caveat heading here.",
      },
    });

    const tool = getWikiReviewPageTool(workspace);
    const result = await tool.execute("wiki-review-call", {
      pageKey: "qldpc-hardware-embedding",
      maxEvidenceAgeDays: 30,
    }, undefined);
    const details = result.details as {
      status?: string;
      pageKey?: string;
      relativePath?: string;
      findings?: Array<{ kind?: string; severity?: string; target?: string }>;
    };

    assert.equal(details.status, "ready");
    assert.equal(details.pageKey, "qldpc-hardware-embedding");
    assert.equal(details.relativePath, "knowledge-base/pages/qldpc-hardware-embedding.md");
    assert.deepEqual(details.findings?.map((finding) => finding.kind), [
      "speculative_knowledge_state",
      "stale_evidence",
      "low_confidence_claim",
      "author_claim_not_validated",
      "unresolved_contradiction",
      "missing_caveat",
      "missing_experiment_ref",
    ]);
    assert.deepEqual(details.findings?.map((finding) => finding.severity), [
      "medium",
      "medium",
      "medium",
      "medium",
      "medium",
      "medium",
      "medium",
    ]);
    assert.equal(details.findings?.find((finding) => finding.kind === "low_confidence_claim")?.target, "claim-1");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki_structure_plan delegates to the injected planner and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: unknown[] = [];

  try {
    const tool = getWikiStructurePlanTool(workspace, {
      planWikiStructure: async (options) => {
        capturedCalls.push(options);
        return {
          status: "planned",
          lintSummary: {
            stale_index: 0,
            broken_wiki_link: 0,
            missing_source_citation: 0,
            source_without_synthesis_coverage: 0,
            source_derived_page_key: 0,
            orphan_page: 0,
            concept_gap: 0,
            high_value_concept_gap: 0,
            evidence_contract_gap: 0,
            semantic_alias_candidate: 0,
            scope_drift: 0,
            duplicate_page_title: 0,
            near_duplicate_page: 0,
            duplicate_section: 1,
            weak_evidence_contract: 0,
            weak_synthesis_page: 0,
            missing_claim_provenance: 0,
            unresolved_contradiction: 0,
            missing_typed_relation: 0,
            missing_experiment_ref: 0,
            code_backed_without_experiment: 0,
            rendered_wiki_link: 0,
          },
          actionCount: 1,
          actions: [
            {
              id: "wiki-structure-001",
              type: "fix_duplicate_section",
              priority: "medium",
              risk: "low",
              issueKind: "duplicate_section",
              owner: "wiki-agent",
              path: "knowledge-base/pages/example.md",
              reason: "Section appears twice.",
              recommendedTool: "replace_file_text",
            },
          ],
          warnings: ["This tool only plans structural changes."],
        };
      },
    });

    const result = await tool.execute("wiki-structure-plan-call", {
      maxItems: 5,
      includeMediumRisk: true,
    }, undefined);

    assert.deepEqual(capturedCalls, [{
      workspaceDir: workspace,
      maxItems: 5,
      includeMediumRisk: true,
    }]);
    assert.equal((result.details as { actionCount?: number }).actionCount, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki_structure_plan schema exposes goal-aware growth and budget options", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = createTools(workspace).find((candidate) => candidate.name === "wiki_structure_plan");
    assert.ok(tool);
    const parameters = tool.parameters as {
      properties?: {
        goal?: { type?: string };
        focus?: { type?: string; items?: { type?: string } };
        includeGrowthActions?: { type?: string };
        budget?: {
          type?: string;
          properties?: {
            maxPagesToBuild?: { type?: string; minimum?: number };
            maxAliasesToCreate?: { type?: string; minimum?: number };
            maxScopeNotes?: { type?: string; minimum?: number };
          };
        };
      };
    };

    assert.equal(parameters.properties?.goal?.type, "string");
    assert.equal(parameters.properties?.focus?.type, "array");
    assert.equal(parameters.properties?.focus?.items?.type, "string");
    assert.equal(parameters.properties?.includeGrowthActions?.type, "boolean");
    assert.equal(parameters.properties?.budget?.type, "object");
    assert.equal(parameters.properties?.budget?.properties?.maxPagesToBuild?.type, "integer");
    assert.equal(parameters.properties?.budget?.properties?.maxPagesToBuild?.minimum, 0);
    assert.equal(parameters.properties?.budget?.properties?.maxAliasesToCreate?.type, "integer");
    assert.equal(parameters.properties?.budget?.properties?.maxAliasesToCreate?.minimum, 0);
    assert.equal(parameters.properties?.budget?.properties?.maxScopeNotes?.type, "integer");
    assert.equal(parameters.properties?.budget?.properties?.maxScopeNotes?.minimum, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki_structure_plan passes goal, focus, growth, and budget options", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: unknown[] = [];

  try {
    const tool = getWikiStructurePlanTool(workspace, {
      planWikiStructure: async (options) => {
        capturedCalls.push(options);
        return {
          status: "planned",
          lintSummary: {
            stale_index: 0,
            broken_wiki_link: 0,
            missing_source_citation: 0,
            source_without_synthesis_coverage: 0,
            source_derived_page_key: 0,
            orphan_page: 0,
            concept_gap: 0,
            high_value_concept_gap: 0,
            evidence_contract_gap: 0,
            semantic_alias_candidate: 0,
            scope_drift: 0,
            duplicate_page_title: 0,
            near_duplicate_page: 0,
            duplicate_section: 0,
            weak_evidence_contract: 0,
            weak_synthesis_page: 0,
            missing_claim_provenance: 0,
            unresolved_contradiction: 0,
            missing_typed_relation: 0,
            missing_experiment_ref: 0,
            code_backed_without_experiment: 0,
            rendered_wiki_link: 0,
          },
          actionCount: 0,
          actions: [],
          warnings: [],
        };
      },
    });

    await tool.execute("wiki-structure-plan-call", {
      maxItems: 5,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "superconducting chip design",
      focus: ["tunable coupler"],
      budget: { maxPagesToBuild: 1, maxAliasesToCreate: 2, maxScopeNotes: 1 },
    }, undefined);

    assert.deepEqual(capturedCalls, [{
      workspaceDir: workspace,
      maxItems: 5,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "superconducting chip design",
      focus: ["tunable coupler"],
      budget: { maxPagesToBuild: 1, maxAliasesToCreate: 2, maxScopeNotes: 1 },
    }]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki_apply_structure_plan delegates to the injected applier and returns details", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: unknown[] = [];

  try {
    const tool = getWikiApplyStructurePlanTool(workspace, {
      applyWikiStructurePlan: async (options) => {
        capturedCalls.push(options);
        return {
          status: "dry_run",
          applied: [],
          skipped: [],
          changedFiles: [],
        };
      },
    });
    const actions = [
      {
        id: "wiki-structure-001",
        type: "fix_duplicate_section",
        priority: "medium",
        risk: "low",
        issueKind: "duplicate_section",
        path: "knowledge-base/pages/example.md",
        target: "Open Questions",
        reason: "Section appears twice.",
        recommendedTool: "wiki_apply_structure_plan",
      },
    ];

    const result = await tool.execute("wiki-apply-structure-plan-call", {
      actions,
      dryRun: true,
      requireLowRisk: true,
      maxActions: 3,
      runVerification: true,
    }, undefined);

    assert.deepEqual(capturedCalls, [{
      workspaceDir: workspace,
      actions,
      dryRun: true,
      requireLowRisk: true,
      maxActions: 3,
      runVerification: true,
    }]);
    assert.equal((result.details as { status?: string }).status, "dry_run");
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
              path: "knowledge-base/sources/arxiv-2406.06015/summary.md",
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
    assert.equal(details.evidence?.[0]?.citation, "arxiv-2406.06015 (knowledge-base/sources/arxiv-2406.06015/summary.md)");
    assert.equal(details.evidence?.[0]?.path, "knowledge-base/sources/arxiv-2406.06015/summary.md");
    assert.deepEqual(details.fallbackMatches, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("answer_paper_wiki_question preserves evidence warnings when maxEvidenceAgeDays is passed", async () => {
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
              kind: "page",
              key: "qldpc-hardware-embedding",
              pageKey: "qldpc-hardware-embedding",
              title: "qLDPC hardware embedding",
              path: "knowledge-base/pages/qldpc-hardware-embedding.md",
              snippet: "qLDPC hardware embedding evidence",
              warnings: ["speculative", "stale_evidence"],
              matchReasons: ["title", "tag"],
              knowledgeState: "speculative",
              lastReviewedAt: "2000-01-01T00:00:00.000Z",
            },
          ],
        };
      },
    });

    const result = await tool.execute("answer-wiki-warnings-call", {
      query: "qldpc hardware embedding",
      maxResults: 2,
      maxEvidenceAgeDays: 30,
    }, undefined);
    const details = result.details as {
      answerPolicy?: string[];
      evidence?: Array<{
        warnings?: string[];
        matchReasons?: string[];
        knowledgeState?: string;
        lastReviewedAt?: string;
      }>;
    };

    assert.deepEqual(capturedCalls, [{
      workspaceDir: workspace,
      query: "qldpc hardware embedding",
      maxResults: 2,
      maxEvidenceAgeDays: 30,
    }]);
    assert.deepEqual(details.evidence?.[0]?.warnings, ["speculative", "stale_evidence"]);
    assert.deepEqual(details.evidence?.[0]?.matchReasons, ["title", "tag"]);
    assert.equal(details.evidence?.[0]?.knowledgeState, "speculative");
    assert.equal(details.evidence?.[0]?.lastReviewedAt, "2000-01-01T00:00:00.000Z");
    assert.ok(details.answerPolicy?.includes(
      "Report evidence warnings such as stale, speculative, disputed, or low-confidence status before drawing conclusions."
    ));
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
                path: "knowledge-base/sources/aps-target/parses/opendataloader-local/document.md",
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
            path: "knowledge-base/sources/arxiv-local/summary.md",
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
      evidenceStatus?: string;
      localEvidenceItems?: unknown[];
      newEvidence?: unknown[];
      externalCandidates?: unknown[];
      coordination?: {
        decision?: string;
        steps: Array<{ action?: string }>;
      };
    };

    assert.equal(details.status, "answered_from_wiki");
    assert.equal(details.localEvidence?.evidence?.length, 1);
    assert.equal(details.evidenceStatus, "local_evidence");
    assert.equal(details.localEvidenceItems?.length, 1);
    assert.deepEqual(details.newEvidence, []);
    assert.deepEqual(details.externalCandidates, []);
    assert.equal(details.coordination?.decision, "answer_from_local_wiki");
    assert.deepEqual(details.coordination?.steps.map((step) => step.action), [
      "search_local_evidence",
      "read_selected_evidence",
      "answer_with_citations",
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("answer_research_question can download, parse, summarize, and refresh wiki evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const recordPath = path.join(workspace, "knowledge-base", "sources", "arxiv-2601.00425", "acquisition.json");
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
                  path: "knowledge-base/sources/arxiv-2601.00425/summary.md",
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
          sourcePath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/source.json"),
          parsePath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/tex-source/parse.json"),
          markdownPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/tex-source/document.md"),
          qualityPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/parses/tex-source/quality.json"),
          chunksPath: path.join(workspace, "knowledge-base/sources/arxiv-2601.00425/chunks/tex-source.jsonl"),
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
          sourcePath: "knowledge-base/sources/arxiv-2601.00425/summary.md",
          manifestPath: "knowledge-base/manifests/arxiv-2601.00425.json",
          operationId: "write_source_summary-test",
          operationJournalPath: "knowledge-base/state/wiki-operations.jsonl",
          indexPath: "knowledge-base/index.md",
          logPath: "knowledge-base/log.md",
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
      evidenceStatus?: string;
      downloaded?: Array<{ paperKey?: string; readingStatus?: string }>;
      summariesWritten?: Array<{ paperKey?: string; status?: string }>;
      refreshedEvidence?: { evidence?: unknown[] };
      newEvidence?: unknown[];
      coordination?: {
        decision?: string;
        steps: Array<{ owner?: string; action?: string }>;
      };
    };

    assert.equal(details.status, "expanded_with_new_sources");
    assert.equal(details.evidenceStatus, "newly_acquired_evidence");
    assert.equal(details.downloaded?.[0]?.paperKey, "arxiv-2601.00425");
    assert.equal(details.downloaded?.[0]?.readingStatus, "parsed");
    assert.equal(details.summariesWritten?.[0]?.status, "written");
    assert.equal(details.refreshedEvidence?.evidence?.length, 1);
    assert.ok((details.newEvidence?.length ?? 0) >= 1);
    assert.equal(details.coordination?.decision, "acquire_then_summarize");
    assert.ok(details.coordination?.steps.some((step) => step.owner === "paper-download-subagent"));
    assert.ok(details.coordination?.steps.some((step) => step.owner === "wiki-evidence-worker"));
    assert.ok(!details.coordination?.steps.some((step) =>
      step.owner === "wiki-agent" && step.action === "download_candidate_papers"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("answer_research_question reports insufficient evidence when auto download is disabled", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getAnswerResearchQuestionTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [],
      }),
      searchLocalPapers: async (options) => ({
        query: options.query,
        count: 0,
        results: [],
      }),
      searchPapers: async () => [
        {
          title: "Candidate only paper",
          authors: ["A. Author"],
          summary: "Candidate summary",
          primarySource: "arxiv",
          primaryAction: "direct_download",
          sources: [
            {
              source: "arxiv",
              action: "direct_download",
              canonicalId: "2601.00426",
              articleUrl: "https://arxiv.org/abs/2601.00426",
              pdfUrl: "https://arxiv.org/pdf/2601.00426.pdf",
            },
          ],
        },
      ],
      downloadPaper: async () => {
        throw new Error("download should not run when autoDownload is false");
      },
    });

    const result = await tool.execute("research-call", {
      query: "candidate only topic",
      autoDownload: false,
      maxDownloads: 1,
    }, undefined);
    const details = result.details as {
      status?: string;
      evidenceStatus?: string;
      localEvidenceItems?: unknown[];
      newEvidence?: unknown[];
      limitations?: string[];
      externalCandidates?: unknown[];
      downloaded?: unknown[];
      coordination?: {
        decision?: string;
        steps?: Array<{ action?: string }>;
      };
    };

    assert.equal(details.status, "insufficient_evidence");
    assert.equal(details.evidenceStatus, "insufficient_evidence");
    assert.equal(details.localEvidenceItems?.length, 0);
    assert.equal(details.newEvidence?.length, 0);
    assert.equal(details.externalCandidates?.length, 1);
    assert.deepEqual(details.downloaded, []);
    assert.ok(details.limitations?.some((item) => /local wiki/i.test(item) || /insufficient/i.test(item)));
    assert.equal(details.coordination?.decision, "report_blocked_or_insufficient");
    assert.deepEqual(details.coordination?.steps?.map((step) => step.action), [
      "search_local_evidence",
      "search_external_candidates",
      "summarize_remaining_risks",
    ]);
    assert.ok(!details.coordination?.steps?.some((step) => step.action === "download_candidate_papers"));
    assert.ok(!details.coordination?.steps?.some((step) => step.action === "generate_source_summaries"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("answer_research_question reports blocked acquisition when download fails", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getAnswerResearchQuestionTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [],
      }),
      searchLocalPapers: async (options) => ({
        query: options.query,
        count: 0,
        results: [],
      }),
      searchPapers: async () => [
        {
          title: "Blocked candidate paper",
          authors: ["A. Author"],
          summary: "Candidate summary",
          primarySource: "arxiv",
          primaryAction: "direct_download",
          sources: [
            {
              source: "arxiv",
              action: "direct_download",
              canonicalId: "2601.00427",
              articleUrl: "https://arxiv.org/abs/2601.00427",
              pdfUrl: "https://arxiv.org/pdf/2601.00427.pdf",
            },
          ],
        },
      ],
      downloadPaper: async () => {
        throw new Error("publisher denied access");
      },
    });

    const result = await tool.execute("research-call", {
      query: "blocked topic",
      maxDownloads: 1,
    }, undefined);
    const details = result.details as {
      status?: string;
      evidenceStatus?: string;
      blocked?: unknown[];
      limitations?: string[];
    };

    assert.equal(details.status, "needs_user_action");
    assert.equal(details.evidenceStatus, "blocked_acquisition");
    assert.ok((details.blocked?.length ?? 0) >= 1);
    assert.ok((details.limitations?.length ?? 0) >= 1);
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
                  path: "knowledge-base/sources/arxiv-2507.09690/summary.md",
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
              path: "knowledge-base/sources/arxiv-2507.09690/parses/tex-source/document.md",
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
            sourcePath: "knowledge-base/sources/arxiv-2507.09690/summary.md",
            manifestPath: "knowledge-base/manifests/arxiv-2507.09690.json",
            operationId: "write_source_summary-test",
            operationJournalPath: "knowledge-base/state/wiki-operations.jsonl",
            indexPath: "knowledge-base/index.md",
            logPath: "knowledge-base/log.md",
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
      coordination?: {
        intent?: string;
        decision?: string;
      };
    };

    assert.equal(details.status, "ready");
    assert.deepEqual(generatedSummaries, ["arxiv-2507.09690"]);
    assert.equal(details.summariesWritten?.[0]?.status, "written");
    assert.equal(details.sourceEvidence?.length, 1);
    assert.equal(details.coordination?.intent, "build_topic_page");
    assert.equal(details.coordination?.decision, "build_from_fixed_evidence");
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
            path: "knowledge-base/sources/nature-s41586-024-08449-y/summary.md",
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
            path: "knowledge-base/sources/science-10.1126-science.1231930/summary.md",
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
            path: "knowledge-base/pages/superconducting-quantum-computing.md",
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
            path: "knowledge-base/sources/arxiv-2507.09690/summary.md",
            snippet: "LDPC implementation evidence",
          },
        ],
      }),
      paperWikiPageWorker: async (input) => ({
        title: "qLDPC on Superconducting Chips",
        pageMarkdown: [
          "## Overview",
          "",
          `${input.topic} depends on long-range couplers [arxiv-2507.09690].`,
          "",
          "## Key Concepts",
          "",
          "Connectivity, crosstalk, and routing constraints shape implementation.",
          "",
          "## Evidence",
          "",
          "The source evidence describes LDPC implementation constraints.",
          "",
          "## Open Questions",
          "",
          "How much crosstalk is tolerable?",
          "",
          "## Related Pages",
          "",
          "No related pages yet."
        ].join("\n"),
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
      coordination?: {
        intent?: string;
        steps: Array<{ action?: string; owner?: string }>;
      };
    };

    assert.equal(details.status, "written");
    assert.equal(details.page?.pagePath, "knowledge-base/pages/qldpc-superconducting-chips.md");
    assert.equal(details.page?.sourceCount, 1);
    assert.equal(details.evidence?.length, 1);
    assert.equal(details.coordination?.intent, "build_topic_page");
    assert.ok(details.coordination?.steps.some((step) =>
      step.action === "write_synthesis_page" && step.owner === "wiki-synthesis-worker"
    ));
    const compactItem = result.content?.[0];
    assert.equal(compactItem?.type, "text");
    const compact = JSON.parse((compactItem as { type: "text"; text: string }).text) as {
      coordination?: {
        decision?: string;
        intent?: string;
        steps?: Array<{ action?: string; owner?: string }>;
      };
    };
    assert.equal(compact.coordination?.decision, "build_from_fixed_evidence");
    assert.equal(compact.coordination?.intent, "build_topic_page");
    assert.ok(compact.coordination?.steps?.some((step) =>
      step.action === "write_synthesis_page" && step.owner === "wiki-synthesis-worker"
    ));

    const page = await readFile(path.join(workspace, "knowledge-base/pages/qldpc-superconducting-chips.md"), "utf8");
    assert.match(page, /type: "wiki-synthesis-page"/);
    assert.match(page, /qLDPC on Superconducting Chips/);
    assert.match(page, /arxiv-2507\.09690/);

    const index = await readFile(path.join(workspace, "knowledge-base/index.md"), "utf8");
    assert.match(index, /## Knowledge Entries/);
    assert.match(index, /\[qLDPC on Superconducting Chips\]\(pages\/qldpc-superconducting-chips\.md\)/);
    assert.match(index, /qldpc-superconducting-chips/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page accepts concept drafts with structured open questions and related pages", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [
          {
            paperKey: "arxiv-2507.09690",
            title: "Small Quantum LDPC Codes",
            path: "knowledge-base/sources/arxiv-2507.09690/summary.md",
            snippet: "LDPC implementation evidence.",
          },
        ],
      }),
      paperWikiPageWorker: async () => ({
        title: "qLDPC Concept Page",
        pageMarkdown: [
          "## Overview",
          "",
          "qLDPC implementation needs grounded chip-design evidence [arxiv-2507.09690].",
          "",
          "## Key Concepts",
          "",
          "Connectivity and decoding assumptions shape the hardware implications.",
          "",
          "## Evidence",
          "",
          "The local source summary is the evidence anchor."
        ].join("\n"),
        tags: ["qldpc", "superconducting-qubits"],
        openQuestions: ["Which connectivity assumptions remain unverified?"],
        relatedPageKeys: ["superconducting-chip-design"],
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-concept-structured-sections", {
      topic: "qLDPC concept page",
      pageKey: "qldpc-concept-page",
      forbidExternalEvidence: true,
    }, undefined);
    const details = result.details as { status?: string; page?: { pagePath?: string } };

    assert.equal(details.status, "written");
    assert.equal(details.page?.pagePath, "knowledge-base/pages/qldpc-concept-page.md");
    const page = await readFile(path.join(workspace, "knowledge-base/pages/qldpc-concept-page.md"), "utf8");
    assert.match(page, /## Open Questions/);
    assert.match(page, /Which connectivity assumptions remain unverified\?/);
    assert.match(page, /## Related Pages/);
    assert.match(page, /\[\[superconducting-chip-design\]\]/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page sends evidence pack with raw chunks, provenance, and contradictions to page worker", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const sourceKey = "arxiv-2601.01010";
    const sourceDir = path.join(workspace, "knowledge-base/sources", sourceKey);
    await mkdir(path.join(sourceDir, "chunks"), { recursive: true });
    await mkdir(path.join(workspace, "knowledge-base/manifests"), { recursive: true });
    await writeFile(path.join(sourceDir, "summary.md"), [
      "---",
      `title: "qLDPC Hardware Evidence"`,
      "---",
      "",
      "# qLDPC Hardware Evidence",
      "",
      "Summary: qLDPC layouts need non-local couplers and routing care.",
      "",
      "## Evidence Anchors",
      "",
      "- qLDPC implementation depends on non-local connectivity.",
      "  - Quote: \"non-local couplers dominate the hardware routing overhead\"",
      "  - Locator: paper=arxiv-2601.01010; section=hardware; page=7; chunk=chunk-0002"
    ].join("\n"), "utf8");
    await writeFile(path.join(sourceDir, "chunks", "webpage.jsonl"), [
      JSON.stringify({
        id: "chunk-0001",
        paperKey: sourceKey,
        engine: "webpage",
        text: "Background material about qLDPC code families.",
        pageFrom: 1,
        pageTo: 1,
        elementIds: ["e1"]
      }),
      JSON.stringify({
        id: "chunk-0002",
        paperKey: sourceKey,
        engine: "webpage",
        text: "The non-local couplers dominate the hardware routing overhead for qLDPC layouts on superconducting chips.",
        pageFrom: 7,
        pageTo: 8,
        sectionId: "hardware",
        elementIds: ["e2"]
      })
    ].join("\n") + "\n", "utf8");
    await writeFile(path.join(workspace, "knowledge-base/manifests", `${sourceKey}.json`), `${JSON.stringify({
      schemaVersion: 2,
      sourceKind: "paper",
      sourceKey,
      title: "qLDPC Hardware Evidence",
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${sourceKey}/summary.md`,
      provenance: {},
      artifacts: [{
        kind: "parse",
        path: `knowledge-base/sources/${sourceKey}/parses/webpage/document.md`,
        engine: "webpage",
        markdownPath: `knowledge-base/sources/${sourceKey}/parses/webpage/document.md`
      }],
      tags: ["qldpc", "superconducting-chips"],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    }, null, 2)}\n`, "utf8");
    await writeTypedWikiPage({
      workspaceDir: workspace,
      page: {
        metadata: {
          schema_version: 1,
          type: "finding",
          key: "qldpc-routing-risk",
          title: "qLDPC routing risk",
          aliases: [],
          tags: ["qldpc"],
          evidence_contract: "paper-backed",
          source_refs: [sourceKey],
          claims: [{
            claimId: "claim-routing",
            kind: "qualitative",
            statement: "qLDPC routing overhead is a hardware bottleneck.",
            sourceRefs: [sourceKey],
            evidence: [{
              paperKey: sourceKey,
              chunkId: "chunk-0002",
              quote: "non-local couplers dominate the hardware routing overhead"
            }],
            confidence: "medium"
          }],
          typed_relations: [{
            type: "contradicts",
            target: "local-coupler-only-qldpc",
            targetKind: "page",
            evidenceRefs: [sourceKey],
            status: "candidate",
            note: "Some summaries assume local couplers are sufficient."
          }],
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        },
        body: "# qLDPC routing risk\n\nA prior page marks qLDPC routing as unresolved."
      }
    });

    let capturedInput: PaperWikiPageWorkerInput | undefined;
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [
          {
            kind: "source",
            key: sourceKey,
            paperKey: sourceKey,
            title: "qLDPC Hardware Evidence",
            path: `knowledge-base/sources/${sourceKey}/summary.md`,
            snippet: "qLDPC implementation needs non-local couplers.",
          },
          {
            kind: "page",
            key: "qldpc-routing-risk",
            pageKey: "qldpc-routing-risk",
            title: "qLDPC routing risk",
            path: "knowledge-base/pages/qldpc-routing-risk.md",
            snippet: "A prior page marks qLDPC routing as unresolved.",
          },
        ],
      }),
      paperWikiPageWorker: async (input) => {
        capturedInput = input;
        return {
          title: "qLDPC Hardware Synthesis",
          pageMarkdown: [
            "## Overview",
            "",
            "qLDPC routing depends on non-local couplers [arxiv-2601.01010].",
            "",
            "## Key Concepts",
            "",
            "Connectivity and routing overhead shape chip feasibility.",
            "",
            "## Evidence",
            "",
            "The selected chunk supports the routing-overhead claim.",
            "",
            "## Open Questions",
            "",
            "Which coupler topology is practical?",
            "",
            "## Related Pages",
            "",
            "[[qldpc-routing-risk]]"
          ].join("\n"),
          confidence: "high",
        };
      },
    });

    const result = await tool.execute("build-page-evidence-pack", {
      topic: "qLDPC hardware synthesis",
      question: "哪些 source chunk 支撑 qLDPC 在超导芯片上的实现瓶颈？",
      pageKey: "qldpc-hardware-synthesis",
      forbidExternalEvidence: true,
    }, undefined);

    assert.equal((result.details as { status?: string }).status, "written");
    assert.equal(capturedInput?.evidencePack?.candidateSummaries[0]?.sourceKey, sourceKey);
    assert.equal(capturedInput?.evidencePack?.selectedRawChunks[0]?.chunkId, "chunk-0002");
    assert.match(capturedInput?.evidencePack?.selectedRawChunks[0]?.text ?? "", /non-local couplers/);
    assert.equal(capturedInput?.evidencePack?.claimProvenance[0]?.sourceKey, sourceKey);
    assert.equal(capturedInput?.evidencePack?.contradictionNotes[0]?.pageKey, "qldpc-routing-risk");
    assert.match(capturedInput?.evidencePack?.contradictionNotes[0]?.note ?? "", /local couplers/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page avoids source-derived page keys", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [
          {
            paperKey: "arxiv-2407.02467",
            title: "Error mitigation with stabilized noise in superconducting quantum processors",
            path: "knowledge-base/sources/arxiv-2407.02467/summary.md",
            snippet: "Stabilized noise evidence",
          },
        ],
      }),
      paperWikiPageWorker: async () => ({
        title: "Noise Stabilization for Error Mitigation in Superconducting Quantum Processors",
        pageMarkdown: [
          "## Overview",
          "",
          "Stabilized noise can support mitigation [arxiv-2407.02467].",
          "",
          "## Key Concepts",
          "",
          "The page tracks stability assumptions for processor noise.",
          "",
          "## Evidence",
          "",
          "The cited source is the local evidence anchor.",
          "",
          "## Open Questions",
          "",
          "What calibration cadence is required?",
          "",
          "## Related Pages",
          "",
          "No related pages yet."
        ].join("\n"),
        tags: ["noise-stabilization", "superconducting-qubits"],
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-source-coverage-page", {
      topic: "arxiv-2407.02467 source coverage synthesis",
      pageKey: "arxiv-2407-02467-source-coverage",
    }, undefined);
    const details = result.details as {
      status?: string;
      page?: { pageKey?: string; pagePath?: string };
    };

    assert.equal(details.status, "written");
    assert.equal(
      details.page?.pageKey,
      "noise-stabilization-for-error-mitigation-in-superconducting-quantum-processors"
    );
    assert.equal(
      details.page?.pagePath,
      "knowledge-base/pages/noise-stabilization-for-error-mitigation-in-superconducting-quantum-processors.md"
    );
    await assert.rejects(
      readFile(path.join(workspace, "knowledge-base/pages/arxiv-2407-02467-source-coverage.md"), "utf8"),
      /ENOENT/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page guides material evidence pages from default retrieval with required template sections", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  let capturedInput: {
    question?: string;
    templateGuidance?: string;
    evidence?: Array<{ sourceKind?: string }>;
  } | undefined;

  try {
    const sourceKey = "material-sapphire-permittivity";
    const sourceDir = path.join(workspace, "knowledge-base/sources", sourceKey);
    await mkdir(sourceDir, { recursive: true });
    await mkdir(path.join(workspace, "knowledge-base/manifests"), { recursive: true });
    await writeFile(path.join(sourceDir, "summary.md"), `---
title: "Sapphire Permittivity Dataset"
tags:
  - "sapphire"
  - "permittivity"
---

# Sapphire Permittivity Dataset

Permittivity and loss tangent parameters for sapphire substrates used in superconducting microwave design.
`, "utf8");
    await writeFile(path.join(workspace, "knowledge-base/manifests", `${sourceKey}.json`), `${JSON.stringify({
      schemaVersion: 2,
      sourceKind: "material-database",
      sourceKey,
      title: "Sapphire Permittivity Dataset",
      status: "ready",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${sourceKey}/summary.md`,
      provenance: {
        url: "https://example.test/materials/sapphire"
      },
      artifacts: [],
      tags: ["sapphire", "permittivity"],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    }, null, 2)}\n`, "utf8");

    const tool = getBuildWikiPageTool(workspace, {
      paperWikiPageWorker: async (input) => {
        capturedInput = input;
        return {
          title: "Sapphire Substrate Parameters",
          pageMarkdown: [
            "## Parameter Table",
            "",
            "Sapphire parameters [material-sapphire-permittivity].",
            "",
            "## Applicability",
            "",
            "Use for superconducting microwave substrate estimates.",
            "",
            "## Design Implications",
            "",
            "Permittivity and loss tangent change resonator geometry and Q estimates.",
            "",
            "## Known Uncertainty",
            "",
            "Cryogenic condition coverage must be reviewed before signoff.",
            "",
            "## Related Pages",
            "",
            "No related pages yet."
          ].join("\n"),
          confidence: "high",
        };
      },
    });

    const result = await tool.execute("build-material-page", {
      topic: "sapphire substrate material parameters",
      question: "请整理蓝宝石衬底的介电常数和损耗角正切参数",
      pageKey: "sapphire-substrate-material-parameters",
    }, undefined);
    const details = result.details as { status?: string };

    assert.equal(details.status, "written");
    assert.equal(capturedInput?.question, "请整理蓝宝石衬底的介电常数和损耗角正切参数");
    assert.match(capturedInput?.templateGuidance ?? "", /Required sections/);
    assert.match(capturedInput?.templateGuidance ?? "", /Parameter Table/);
    assert.ok(capturedInput?.evidence?.some((item) => item.sourceKind === "material-database"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page refuses to write incomplete material template drafts", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const sourceKey = "material-sapphire-permittivity";
    const sourceDir = path.join(workspace, "knowledge-base/sources", sourceKey);
    await mkdir(sourceDir, { recursive: true });
    await mkdir(path.join(workspace, "knowledge-base/manifests"), { recursive: true });
    await writeFile(path.join(sourceDir, "summary.md"), "# Sapphire Permittivity Dataset\n\nMaterial parameter evidence.", "utf8");
    await writeFile(path.join(workspace, "knowledge-base/manifests", `${sourceKey}.json`), `${JSON.stringify({
      schemaVersion: 2,
      sourceKind: "material-database",
      sourceKey,
      title: "Sapphire Permittivity Dataset",
      status: "ready",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${sourceKey}/summary.md`,
      provenance: {
        url: "https://example.test/materials/sapphire"
      },
      artifacts: [],
      tags: ["sapphire", "permittivity"],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    }, null, 2)}\n`, "utf8");

    const tool = getBuildWikiPageTool(workspace, {
      paperWikiPageWorker: async () => ({
        title: "Sapphire Substrate Parameters",
        pageMarkdown: "## Parameter Table\n\nSapphire parameters [material-sapphire-permittivity].",
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-incomplete-material-page", {
      topic: "sapphire substrate material parameters",
      question: "请整理蓝宝石衬底的介电常数和损耗角正切参数",
      pageKey: "sapphire-substrate-material-parameters",
    }, undefined);
    const details = result.details as {
      status?: string;
      message?: string;
      draft?: { title?: string };
      coordination?: { handoff?: { missingTemplateSections?: string[] } };
    };

    assert.equal(details.status, "needs_worker");
    assert.match(details.message ?? "", /missing required dataset sections/i);
    assert.equal(details.draft?.title, "Sapphire Substrate Parameters");
    assert.deepEqual(details.coordination?.handoff?.missingTemplateSections, [
      "Applicability",
      "Design Implications",
      "Known Uncertainty",
      "Related Pages"
    ]);
    await assert.rejects(
      readFile(path.join(workspace, "knowledge-base/pages/sapphire-substrate-material-parameters.md"), "utf8"),
      /ENOENT/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page refuses write mode when minSources is not met", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [{
          paperKey: "paper-a",
          title: "Single Evidence",
          path: "knowledge-base/sources/paper-a/summary.md",
          snippet: "single source",
        }],
      }),
      paperWikiPageWorker: async () => ({
        title: "Tunable Coupler",
        pageMarkdown: "## Overview\n\nOne-source draft.",
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-page-min-sources", {
      topic: "tunable coupler",
      pageKey: "tunable-coupler",
      minSources: 2,
    }, undefined);
    const details = result.details as {
      status?: string;
      message?: string;
      coordination?: {
        steps?: Array<{ action?: string }>;
      };
    };

    assert.equal(details.status, "needs_evidence");
    assert.match(details.message ?? "", /minimum source count/i);
    assert.ok(!details.coordination?.steps?.some((step) => step.action === "write_synthesis_page"));
    const compactItem = result.content?.[0];
    assert.equal(compactItem?.type, "text");
    const compact = JSON.parse((compactItem as { type: "text"; text: string }).text) as {
      coordination?: {
        steps?: Array<{ action?: string }>;
      };
    };
    assert.ok(!compact.coordination?.steps?.some((step) => step.action === "write_synthesis_page"));
    await assert.rejects(readFile(path.join(workspace, "knowledge-base/pages/tunable-coupler.md"), "utf8"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page reports missing page worker without write coordination", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [{
          paperKey: "paper-a",
          title: "Worker Evidence",
          path: "knowledge-base/sources/paper-a/summary.md",
          snippet: "worker evidence",
        }],
      }),
    });

    const result = await tool.execute("build-page-missing-worker", {
      topic: "missing worker topic",
      pageKey: "missing-worker-topic",
    }, undefined);
    const details = result.details as {
      status?: string;
      message?: string;
      coordination?: {
        steps?: Array<{ action?: string }>;
      };
    };

    assert.equal(details.status, "needs_worker");
    assert.match(details.message ?? "", /worker is not configured/i);
    assert.ok(!details.coordination?.steps?.some((step) => step.action === "write_synthesis_page"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page does not let non-paper contracts bypass minSources", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [{
          paperKey: "paper-a",
          title: "Single Evidence",
          path: "knowledge-base/sources/paper-a/summary.md",
          snippet: "single source",
        }],
      }),
      paperWikiPageWorker: async () => ({
        title: "Design Backed Page",
        pageMarkdown: "## Overview\n\nOne-source draft.",
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-page-contract-min-sources", {
      topic: "design backed topic",
      pageKey: "design-backed-topic",
      evidenceContract: "design-backed",
      minSources: 2,
    }, undefined);
    const details = result.details as { status?: string; message?: string };

    assert.equal(details.status, "needs_evidence");
    assert.match(details.message ?? "", /minimum source count/i);
    await assert.rejects(readFile(path.join(workspace, "knowledge-base/pages/design-backed-topic.md"), "utf8"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page counts unique source paper keys for minSources", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [
          {
            paperKey: "paper-a",
            title: "Evidence A",
            path: "knowledge-base/sources/paper-a/summary.md",
            snippet: "source A",
          },
          {
            paperKey: "Paper-A",
            title: "Evidence A Duplicate",
            path: "knowledge-base/sources/paper-a-duplicate/summary.md",
            snippet: "duplicate source A",
          },
        ],
      }),
      paperWikiPageWorker: async () => ({
        title: "Duplicate Evidence Page",
        pageMarkdown: "## Overview\n\nDuplicate-source draft.",
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-page-duplicate-min-sources", {
      topic: "duplicate evidence topic",
      pageKey: "duplicate-evidence-topic",
      minSources: 2,
    }, undefined);
    const details = result.details as { status?: string; message?: string };

    assert.equal(details.status, "needs_evidence");
    assert.match(details.message ?? "", /minimum source count 2 is not met; found 1/i);
    await assert.rejects(readFile(path.join(workspace, "knowledge-base/pages/duplicate-evidence-topic.md"), "utf8"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page writes evidence contract and verifies after write", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [
          {
            paperKey: "paper-a",
            title: "Evidence A",
            path: "knowledge-base/sources/paper-a/summary.md",
            snippet: "source A",
          },
          {
            paperKey: "paper-b",
            title: "Evidence B",
            path: "knowledge-base/sources/paper-b/summary.md",
            snippet: "source B",
          },
        ],
      }),
      paperWikiPageWorker: async () => ({
        title: "Tunable Coupler",
        pageMarkdown: [
          "## Overview",
          "",
          "Two-source synthesis.",
          "",
          "## Key Concepts",
          "",
          "The coupler page records reusable chip-design concepts.",
          "",
          "## Evidence",
          "",
          "Evidence A and Evidence B support the synthesis.",
          "",
          "## Open Questions",
          "",
          "No open questions recorded.",
          "",
          "## Related Pages",
          "",
          "No related pages yet."
        ].join("\n"),
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-page-contract", {
      topic: "tunable coupler",
      pageKey: "tunable-coupler",
      minSources: 2,
      requiredSourceKeys: ["paper-a"],
      evidenceContract: "paper-backed",
      forbidExternalEvidence: true,
      verifyAfterWrite: true,
    }, undefined);
    const details = result.details as { status?: string; verification?: { lintAfter?: { issueCount?: number } } };

    assert.equal(details.status, "written");
    assert.equal(typeof details.verification?.lintAfter?.issueCount, "number");
    const page = await readFile(path.join(workspace, "knowledge-base/pages/tunable-coupler.md"), "utf8");
    assert.match(page, /evidence_contract: "paper-backed"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("merge_wiki_aliases writes alias pages and refreshes the wiki index", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const pagesDir = path.join(workspace, "knowledge-base/pages");
  const sourcesDir = path.join(workspace, "knowledge-base/sources");
  await mkdir(pagesDir, { recursive: true });
  await mkdir(path.join(sourcesDir, "eda-source"), { recursive: true });
  await writeFile(path.join(sourcesDir, "eda-source", "summary.md"), "# EDA Source\n\nSource-backed evidence.", "utf8");
  await writeFile(path.join(pagesDir, "electronic-design-automation.md"), `---
type: "wiki-synthesis-page"
page_key: "electronic-design-automation"
title: "Electronic Design Automation"
tags: []
sources:
  - paper_key: "eda-source"
    title: "EDA Source"
    path: "knowledge-base/sources/eda-source/summary.md"
related_pages: []
---

# Electronic Design Automation

Canonical content.
`, "utf8");

  try {
    const tool = getMergeWikiAliasesTool(workspace);
    const result = await tool.execute("merge-aliases", {
      aliases: [
        {
          alias: "eda",
          canonical: "electronic-design-automation",
          title: "EDA",
          note: "Common acronym."
        },
      ],
    }, undefined);
    const details = result.details as {
      status?: string;
      aliases?: Array<{ aliasPageKey?: string; canonicalPageKey?: string; status?: string; pagePath?: string }>;
    };

    assert.equal(details.status, "written");
    assert.deepEqual(details.aliases?.map((alias) => ({
      aliasPageKey: alias.aliasPageKey,
      canonicalPageKey: alias.canonicalPageKey,
      status: alias.status,
      pagePath: alias.pagePath,
    })), [
      {
        aliasPageKey: "eda",
        canonicalPageKey: "electronic-design-automation",
        status: "written",
        pagePath: "knowledge-base/pages/eda.md",
      },
    ]);

    const aliasPage = await readFile(path.join(pagesDir, "eda.md"), "utf8");
    assert.match(aliasPage, /type: "wiki-alias-page"/);
    assert.match(aliasPage, /canonical_page: "electronic-design-automation"/);
    assert.match(aliasPage, /\[Electronic Design Automation\]\(knowledge-base\/pages\/electronic-design-automation\.md\)/);

    const index = await readFile(path.join(workspace, "knowledge-base/index.md"), "utf8");
    assert.match(index, /\[EDA\]\(pages\/eda\.md\)/);
    assert.match(index, /\[Electronic Design Automation\]\(pages\/electronic-design-automation\.md\)/);

    const lint = await getWikiLintTool(workspace).execute("lint-aliases", { maxItems: 10 }, undefined);
    assert.deepEqual((lint.details as { summary?: Record<string, number> }).summary, {
      stale_index: 0,
      broken_wiki_link: 0,
      missing_source_citation: 0,
      source_without_synthesis_coverage: 0,
      source_derived_page_key: 0,
      orphan_page: 0,
      concept_gap: 0,
      high_value_concept_gap: 0,
      evidence_contract_gap: 0,
      semantic_alias_candidate: 0,
      scope_drift: 0,
      duplicate_page_title: 0,
      near_duplicate_page: 0,
      duplicate_section: 0,
      weak_evidence_contract: 0,
      weak_synthesis_page: 0,
      missing_claim_provenance: 0,
      unresolved_contradiction: 0,
      missing_typed_relation: 0,
      missing_experiment_ref: 0,
      code_backed_without_experiment: 0,
      material_parameter_missing_unit: 0,
      material_parameter_missing_condition: 0,
      missing_template_section: 0,
      design_record_without_uses_relation: 0,
      software_doc_version_missing: 0,
      rendered_wiki_link: 0,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("merge_wiki_aliases refuses to replace existing synthesis pages unless requested", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const pagesDir = path.join(workspace, "knowledge-base/pages");
  await mkdir(pagesDir, { recursive: true });
  await writeFile(path.join(pagesDir, "surface-code.md"), `---
type: "wiki-synthesis-page"
page_key: "surface-code"
title: "Surface Code"
tags: []
sources: []
related_pages: []
---

# Surface Code

Canonical content.
`, "utf8");
  await writeFile(path.join(pagesDir, "surface-codes.md"), `---
type: "wiki-synthesis-page"
page_key: "surface-codes"
title: "Surface Codes"
tags: []
sources: []
related_pages: []
---

# Surface Codes

Duplicate but still substantive content.
`, "utf8");

  try {
    const tool = getMergeWikiAliasesTool(workspace);
    const blocked = await tool.execute("merge-alias-blocked", {
      aliases: [{ alias: "surface-codes", canonical: "surface-code" }],
    }, undefined);
    const blockedDetails = blocked.details as {
      status?: string;
      aliases?: Array<{ status?: string; reason?: string }>;
    };

    assert.equal(blockedDetails.status, "blocked");
    assert.equal(blockedDetails.aliases?.[0]?.status, "skipped");
    assert.match(blockedDetails.aliases?.[0]?.reason ?? "", /already exists as a synthesis page/);
    assert.match(await readFile(path.join(pagesDir, "surface-codes.md"), "utf8"), /Duplicate but still substantive content/);

    const replaced = await tool.execute("merge-alias-replace", {
      aliases: [{ alias: "surface-codes", canonical: "surface-code" }],
      replaceExisting: true,
    }, undefined);
    assert.equal((replaced.details as { status?: string }).status, "written");
    const aliasPage = await readFile(path.join(pagesDir, "surface-codes.md"), "utf8");
    assert.match(aliasPage, /type: "wiki-alias-page"/);
    assert.match(aliasPage, /canonical_page: "surface-code"/);
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
            path: "knowledge-base/sources/arxiv-local/summary.md",
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
          source_manifest_missing: 0,
          missing_artifact: 0,
          download_blocked: 0,
          citation_incomplete: 0,
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
            source_manifest_missing: 0,
            missing_artifact: 0,
            download_blocked: 0,
            citation_incomplete: 0,
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
