import type { WikiSourceKind } from "./source-metadata-store.js";
import type {
  WikiClaimKind,
  WikiEvidenceContract,
  WikiKnowledgeState,
  WikiPageType
} from "./page-schema.js";

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
  evidenceAnchors?: PaperWikiSourceEvidenceAnchor[];
}

export interface PaperWikiSourceEvidenceAnchor {
  summary: string;
  quote: string;
  paperKey?: string;
  sectionId?: string;
  page?: number;
  figure?: string;
  table?: string;
  chunkId?: string;
  elementId?: string;
}

export interface PaperWikiSourceResult {
  paperKey: string;
  title: string;
  sourcePath: string;
  metadataPath: string;
  operationId: string;
  operationJournalPath: string;
  indexPath: string;
  logPath: string;
}

export interface PaperWikiSearchOptions {
  workspaceDir: string;
  query: string;
  maxResults?: number;
  sourceKinds?: WikiSourceKind[];
  pageTypes?: WikiPageType[];
  claimKinds?: WikiClaimKind[];
  knowledgeStates?: WikiKnowledgeState[];
  evidenceContracts?: WikiEvidenceContract[];
  maxEvidenceAgeDays?: number;
  now?: Date;
}

export type PaperWikiSearchResultKind = "source" | "page";

export interface PaperWikiSearchResult {
  query: string;
  results: Array<{
    kind?: PaperWikiSearchResultKind;
    key?: string;
    paperKey?: string;
    pageKey?: string;
    sourceKind?: WikiSourceKind;
    title: string;
    path: string;
    snippet: string;
    warnings?: string[];
    matchReasons?: string[];
    knowledgeState?: string;
    lastReviewedAt?: string;
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
  sourceKind?: WikiSourceKind;
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
  allowSourceDerivedPageKey?: boolean;
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
  templateGuidance?: string;
  evidence: Array<{
    kind?: "source" | "page";
    key?: string;
    paperKey?: string;
    pageKey?: string;
    sourceKind?: WikiSourceKind;
    title: string;
    path: string;
    snippet: string;
  }>;
  evidencePack?: PaperWikiPageEvidencePack;
}

export interface PaperWikiPageEvidencePack {
  candidateSummaries: Array<{
    sourceKey: string;
    title: string;
    path: string;
    summary: string;
    tags?: string[];
    sourceKind?: WikiSourceKind;
  }>;
  selectedRawChunks: Array<{
    sourceKey: string;
    chunkId: string;
    path: string;
    text: string;
    pageFrom?: number;
    pageTo?: number;
    sectionId?: string;
    matchedBy: "anchor" | "query";
  }>;
  claimProvenance: Array<{
    sourceKey?: string;
    pageKey?: string;
    claimId?: string;
    statement: string;
    confidence?: string;
    sourceRefs: string[];
    evidence: Array<{
      paperKey?: string;
      sourcePath?: string;
      parsePath?: string;
      chunkId?: string;
      elementId?: string;
      sectionId?: string;
      page?: number;
      figure?: string;
      table?: string;
      codeOutputPath?: string;
      quote?: string;
      note?: string;
    }>;
  }>;
  contradictionNotes: Array<{
    pageKey: string;
    target: string;
    status: string;
    evidenceRefs: string[];
    note?: string;
  }>;
  diagnostics: string[];
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
