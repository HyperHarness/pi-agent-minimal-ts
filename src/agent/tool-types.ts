import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { resolveDefaultPaperBrowserSessionFactory } from "./paper/browser/browser-session.js";
import type { PaperBrowserManagerClient } from "./paper/browser/paper-browser-manager-client.js";
import type { PaperExtensionBridge } from "./paper/extension/paper-extension-bridge.js";
import type { registerManualPaperDownload, searchPapers, downloadPaper } from "./paper/acquisition/paper-manager.js";
import type { inspectPaper, parsePaper, readPaperSection, searchPaperText } from "./paper/reading/paper-reader.js";
import type { savePaperWebPageParse } from "./paper/reading/engines/webpage.js";
import type { bootstrapPaperWikiPageEvidence } from "./paper-wiki/bootstrap.js";
import type { lintPaperWiki } from "./paper-wiki/lint.js";
import type { mergePaperWikiAliases, searchPaperWiki, writePaperWikiPage, writePaperWikiSource } from "./paper-wiki/paper-wiki.js";
import type { PaperWikiPageWorker } from "./paper-wiki/types.js";
import type { paperWikiRelations } from "./paper-relations.js";
import type { generatePaperWikiSummary, PaperSummaryWorker } from "./paper-summary.js";
import type { checkWikiHealth, fixWikiHealth, PaperDownloadWorker } from "./wiki-health.js";
import type { searchApsPapers } from "./paper/acquisition/aps-search.js";
import type { fetchPaperWebPage } from "./paper/acquisition/paper-webpage-fetch.js";
import type { listLocalPapers, searchLocalPapers } from "./paper/storage/local-paper-library.js";
import type { ToolProfile } from "./tool-boundaries.js";
import type { fetchWebPage } from "./web-fetch.js";
import type { searchWeb } from "./web-search.js";

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
