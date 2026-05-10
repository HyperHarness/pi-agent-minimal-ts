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
  manifestPath: string;
  operationId: string;
  operationJournalPath: string;
  indexPath: string;
  logPath: string;
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

export interface PaperWikiPageBootstrapEvidence {
  kind: "source" | "page";
  key: string;
  title: string;
  path: string;
  snippet: string;
  query?: string;
  origin: "seed_search" | "related_expansion" | "local_fallback";
  paperKey?: string;
  pageKey?: string;
  tags?: string[];
  relatedPaperKeys?: string[];
}

export interface PaperWikiPageBootstrapParsedFallback {
  paperKey: string;
  title?: string;
  field: string;
  path?: string;
  snippet: string;
}

export interface PaperWikiPageBootstrapMissingSummary {
  paperKey: string;
  title?: string;
  reason: string;
  matches: PaperWikiPageBootstrapParsedFallback[];
}

export interface PaperWikiPageBootstrapOptions {
  workspaceDir: string;
  topic: string;
  question?: string;
  maxSeedQueries?: number;
  maxSources?: number;
  includeParsedFallback?: boolean;
}

export interface PaperWikiPageBootstrapResult {
  status: "ready" | "needs_summary" | "insufficient_evidence";
  topic: string;
  question?: string;
  recommendedPageKey: string;
  seedQueries: string[];
  sourceEvidence: PaperWikiPageBootstrapEvidence[];
  pageContext: PaperWikiPageBootstrapEvidence[];
  expandedSources: PaperWikiPageBootstrapEvidence[];
  parsedFallbackMatches: PaperWikiPageBootstrapParsedFallback[];
  missingSummaries: PaperWikiPageBootstrapMissingSummary[];
  blocked: Array<{
    stage: "seed_search" | "related_expansion" | "parsed_fallback";
    reason: string;
  }>;
}

export interface PaperWikiPageSourceCitation {
  paperKey: string;
  title?: string;
  path: string;
}

export type PaperWikiEvidenceContract = "paper-backed" | "design-backed" | "code-backed" | "mixed";

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
  evidenceContract?: PaperWikiEvidenceContract;
}

export interface PaperWikiPageResult {
  pageKey: string;
  title: string;
  pagePath: string;
  operationId: string;
  operationJournalPath: string;
  indexPath: string;
  logPath: string;
  sourceCount: number;
}

export interface PaperWikiAliasInput {
  alias: string;
  canonical: string;
  title?: string;
  note?: string;
}

export interface PaperWikiAliasMergeInput {
  workspaceDir: string;
  aliases: PaperWikiAliasInput[];
  replaceExisting?: boolean;
}

export interface PaperWikiAliasMergeItem {
  aliasPageKey: string;
  canonicalPageKey: string;
  title: string;
  pagePath: string;
  status: "written" | "skipped";
  reason?: string;
}

export interface PaperWikiAliasMergeResult {
  status: "written" | "partial" | "blocked";
  aliases: PaperWikiAliasMergeItem[];
  operationId?: string;
  operationJournalPath?: string;
  indexPath: string;
  logPath: string;
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
