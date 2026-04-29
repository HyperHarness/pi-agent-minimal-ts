export interface PaperWikiSourceInput {
  workspaceDir: string;
  paperKey: string;
  summaryMarkdown: string;
  engine?: "opendataloader-local" | "opendataloader-hybrid" | "docling" | "tex-source" | "plain-text-baseline" | "webpage";
  title?: string;
  tags?: string[];
  keyFindings?: string[];
  limitations?: string[];
  openQuestions?: string[];
  relatedPaperKeys?: string[];
}

export interface PaperWikiSourceResult {
  paperKey: string;
  title: string;
  sourcePath: string;
  indexPath: string;
  logPath: string;
  schemaPath: string;
}

export interface PaperWikiSearchOptions {
  workspaceDir: string;
  query: string;
  maxResults?: number;
}

export type PaperWikiSearchResultKind = "source" | "page";

export interface PaperWikiSearchResult {
  query: string;
  results: Array<{
    kind?: PaperWikiSearchResultKind;
    key?: string;
    paperKey?: string;
    pageKey?: string;
    title: string;
    path: string;
    snippet: string;
  }>;
}

export interface PaperWikiPageSourceCitation {
  paperKey: string;
  title?: string;
  path: string;
}

export interface PaperWikiPageInput {
  workspaceDir: string;
  topic: string;
  pageMarkdown: string;
  pageKey?: string;
  title?: string;
  tags?: string[];
  sourceCitations: PaperWikiPageSourceCitation[];
  openQuestions?: string[];
  relatedPageKeys?: string[];
}

export interface PaperWikiPageResult {
  pageKey: string;
  title: string;
  pagePath: string;
  indexPath: string;
  logPath: string;
  schemaPath: string;
  sourceCount: number;
}

export interface PaperWikiPageWorkerInput {
  topic: string;
  question?: string;
  evidence: Array<{
    kind?: "source" | "page";
    key?: string;
    paperKey?: string;
    pageKey?: string;
    title: string;
    path: string;
    snippet: string;
  }>;
}

export interface PaperWikiPageWorkerOutput {
  title: string;
  pageMarkdown: string;
  tags?: string[];
  openQuestions?: string[];
  relatedPageKeys?: string[];
  confidence?: "high" | "medium" | "low";
  groundingWarnings?: string[];
}

export type PaperWikiPageWorker = (
  input: PaperWikiPageWorkerInput
) => Promise<PaperWikiPageWorkerOutput>;
