import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { resolveDefaultPaperBrowserSessionFactory } from "./paper/browser/browser-session.js";
import type { PaperBrowserManagerClient } from "./paper/browser/paper-browser-manager-client.js";
import type { PaperExtensionBridge } from "./paper/extension/paper-extension-bridge.js";
import type { registerManualPaperDownload, searchPapers, downloadPaper } from "./paper/acquisition/paper-manager.js";
import type { inspectPaper, parsePaper, readPaperSection, searchPaperText } from "./paper/reading/paper-reader.js";
import type { savePaperWebPageParse } from "./paper/reading/engines/webpage.js";
import type { bootstrapPaperWikiPageEvidence } from "./wiki/bootstrap.js";
import type { applyWikiStructurePlan } from "./wiki/structure-apply.js";
import type { lintPaperWiki } from "./wiki/lint.js";
import type { planWikiStructure } from "./wiki/structure-plan.js";
import type { mergePaperWikiAliases, searchPaperWiki, writePaperWikiPage, writePaperWikiSource } from "./wiki/content.js";
import type { PaperWikiPageWorker } from "./wiki/types.js";
import type { paperWikiRelations } from "./wiki/relations.js";
import type { generatePaperWikiSummary, PaperSummaryWorker } from "./wiki/summary.js";
import type { checkWikiHealth, fixWikiHealth, PaperDownloadWorker } from "./wiki/health.js";
import type { searchApsPapers } from "./paper/acquisition/aps-search.js";
import type { fetchPaperWebPage } from "./paper/acquisition/paper-webpage-fetch.js";
import type { listLocalPapers, searchLocalPapers } from "./paper/storage/local-paper-library.js";
import type { fetchWebPage } from "./web-fetch.js";
import type { searchWeb } from "./web-search.js";

export type ToolProfile = "default" | "full";

export type ToolBoundaryRole =
  | "wiki-agent"
  | "paper-download-subagent"
  | "wiki-evidence-worker"
  | "design-agent"
  | "design-subagent"
  | "paper-writing-worker";

type ToolName =
  | "answer_paper_wiki_question"
  | "answer_research_question"
  | "block_paper_download"
  | "bootstrap_wiki_page_evidence"
  | "build_wiki_page"
  | "clarify_research_topic"
  | "compile_latex"
  | "delete_file"
  | "download_paper"
  | "expand_research_topic"
  | "fetch_paper_webpage"
  | "fetch_url"
  | "generate_paper_wiki_summary"
  | "get_time"
  | "inspect_paper"
  | "list_files"
  | "list_local_papers"
  | "load_paper_writing_skill"
  | "merge_wiki_aliases"
  | "open_paper_page_for_login"
  | "paper_orchestra_check_draft"
  | "paper_orchestra_prepare_workspace"
  | "paper_orchestra_score_delta"
  | "paper_orchestra_snapshot_provenance"
  | "paper_wiki_relations"
  | "parse_paper"
  | "read_file"
  | "read_paper_section"
  | "register_manual_paper_download"
  | "replace_file_text"
  | "research_topic_bootstrap"
  | "sync_design_environment"
  | "run_design_script"
  | "search_local_papers"
  | "search_paper_text"
  | "search_paper_wiki"
  | "search_papers"
  | "web_search"
  | "wiki_health"
  | "wiki_health_fix"
  | "wiki_apply_structure_plan"
  | "wiki_lint"
  | "wiki_review_page"
  | "wiki_structure_plan"
  | "write_design_artifact"
  | "write_file"
  | "write_paper_wiki_source";

const DESIGN_AGENT_TOOL_NAMES = [
  "answer_paper_wiki_question",
  "search_paper_wiki",
  "search_local_papers",
  "list_local_papers",
  "sync_design_environment",
  "run_design_script",
  "write_design_artifact"
] as const satisfies readonly ToolName[];

export const TOOL_BOUNDARY_NAMES: Record<ToolBoundaryRole, readonly ToolName[]> = {
  "wiki-agent": [
    "list_files",
    "read_file",
    "replace_file_text",
    "answer_paper_wiki_question",
    "bootstrap_wiki_page_evidence",
    "build_wiki_page",
    "merge_wiki_aliases",
    "clarify_research_topic",
    "research_topic_bootstrap",
    "expand_research_topic",
    "search_local_papers",
    "search_paper_wiki",
    "wiki_health",
    "wiki_lint",
    "wiki_review_page",
    "wiki_structure_plan",
    "wiki_apply_structure_plan"
  ],
  "paper-download-subagent": [
    "get_time",
    "web_search",
    "fetch_url",
    "search_papers",
    "download_paper",
    "block_paper_download",
    "inspect_paper",
    "read_paper_section",
    "search_paper_text",
    "search_local_papers",
    "list_local_papers",
    "fetch_paper_webpage",
    "register_manual_paper_download",
    "open_paper_page_for_login",
    "parse_paper",
    "wiki_health",
    "wiki_health_fix"
  ],
  "wiki-evidence-worker": [
    "inspect_paper",
    "read_paper_section",
    "search_paper_text",
    "search_local_papers",
    "list_local_papers",
    "write_paper_wiki_source",
    "generate_paper_wiki_summary",
    "paper_wiki_relations"
  ],
  "design-agent": DESIGN_AGENT_TOOL_NAMES,
  "design-subagent": DESIGN_AGENT_TOOL_NAMES,
  "paper-writing-worker": [
    "load_paper_writing_skill",
    "list_files",
    "read_file",
    "write_file",
    "replace_file_text",
    "paper_orchestra_prepare_workspace",
    "paper_orchestra_check_draft",
    "paper_orchestra_score_delta",
    "paper_orchestra_snapshot_provenance",
    "compile_latex",
    "answer_paper_wiki_question",
    "search_paper_wiki",
    "wiki_lint",
    "wiki_review_page"
  ]
};

export function getToolBoundaryToolNames(role: ToolBoundaryRole): string[] {
  return [...TOOL_BOUNDARY_NAMES[role]];
}

export type OpenPaperPageForLoginDependency = (input: {
  workspaceDir: string;
  url: string;
}) => Promise<{
  url?: string;
  openedUrl: string;
  profileDir?: string;
  executablePath?: string;
}>;

export interface ToolDependencies {
  searchWeb?: typeof searchWeb;
  fetchWebPage?: typeof fetchWebPage;
  fetchPaperWebPage?: typeof fetchPaperWebPage;
  savePaperWebPageParse?: typeof savePaperWebPageParse;
  searchPapers?: typeof searchPapers;
  searchApsPapers?: typeof searchApsPapers;
  downloadPaper?: typeof downloadPaper;
  registerManualPaperDownload?: typeof registerManualPaperDownload;
  parsePaper?: typeof parsePaper;
  inspectPaper?: typeof inspectPaper;
  readPaperSection?: typeof readPaperSection;
  searchPaperText?: typeof searchPaperText;
  writePaperWikiSource?: typeof writePaperWikiSource;
  writePaperWikiPage?: typeof writePaperWikiPage;
  generatePaperWikiSummary?: typeof generatePaperWikiSummary;
  paperWikiRelations?: typeof paperWikiRelations;
  bootstrapPaperWikiPageEvidence?: typeof bootstrapPaperWikiPageEvidence;
  lintPaperWiki?: typeof lintPaperWiki;
  planWikiStructure?: typeof planWikiStructure;
  applyWikiStructurePlan?: typeof applyWikiStructurePlan;
  paperSummaryWorker?: PaperSummaryWorker;
  paperWikiPageWorker?: PaperWikiPageWorker;
  searchPaperWiki?: typeof searchPaperWiki;
  listLocalPapers?: typeof listLocalPapers;
  searchLocalPapers?: typeof searchLocalPapers;
  checkWikiHealth?: typeof checkWikiHealth;
  fixWikiHealth?: typeof fixWikiHealth;
  paperDownloadWorker?: PaperDownloadWorker;
  openPaperPageForLogin?: OpenPaperPageForLoginDependency;
  browserSessionFactory?: ReturnType<typeof resolveDefaultPaperBrowserSessionFactory>;
  paperBrowserManagerClient?: PaperBrowserManagerClient;
  extensionBridge?: PaperExtensionBridge;
  usePlaywrightPaperFallback?: boolean;
  allowBuildWikiPageExternalEvidence?: boolean;
  toolProfile?: ToolProfile;
}

export interface ToolSetMetadata {
  cleanup: () => Promise<void>;
  workspaceDir: string;
}

export type AgentTools = AgentTool<any>[] & ToolSetMetadata;
