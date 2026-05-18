import {
  listWikiEvidenceItems,
  type WikiEvidenceItem,
  type WikiEvidenceKind
} from "./retrieval-contract.js";
import type { WikiSourceKind } from "./manifest-store.js";
import type {
  WikiClaimKind,
  WikiEvidenceContract,
  WikiKnowledgeState,
  WikiPageType
} from "./page-schema.js";

export type WikiEvidenceSearchStatus = "ready" | "insufficient_evidence";
export type WikiEvidenceMatchReason =
  | "title"
  | "alias"
  | "tag"
  | "source_ref"
  | "body"
  | "source_kind"
  | "claim"
  | "typed_relation"
  | "reviewer_critique";
export type WikiEvidenceSearchWarning =
  | "stale_evidence"
  | "unknown_freshness"
  | "speculative"
  | "promising_unverified"
  | "disputed"
  | "low_confidence_claim"
  | "unresolved_contradiction"
  | "weak_evidence_contract";

export interface WikiEvidenceSearchResult {
  item: WikiEvidenceItem;
  score: number;
  matchReasons: WikiEvidenceMatchReason[];
  warnings: WikiEvidenceSearchWarning[];
}

export interface WikiEvidenceSearchResponse {
  status: WikiEvidenceSearchStatus;
  query: string;
  results: WikiEvidenceSearchResult[];
  insufficientReason?: string;
}

export interface SearchWikiEvidenceOptions {
  workspaceDir: string;
  query: string;
  preferredKinds?: WikiEvidenceKind[];
  maxResults?: number;
  itemFilter?: (item: WikiEvidenceItem) => boolean;
  sourceKinds?: WikiSourceKind[];
  pageTypes?: WikiPageType[];
  claimKinds?: WikiClaimKind[];
  knowledgeStates?: WikiKnowledgeState[];
  evidenceContracts?: WikiEvidenceContract[];
  maxEvidenceAgeDays?: number;
  now?: Date;
}

const DEFAULT_MAX_RESULTS = 8;
const MAX_BODY_MATCH_SCORE = 6;
const ENGLISH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with"
]);

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[_/]+/g, " ")
    .replace(/-/g, " ")
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function queryNeedles(query: string): string[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }
  const terms = normalizedQuery
    .split(" ")
    .filter((term) => term && !ENGLISH_STOPWORDS.has(term));
  return [...new Set([normalizedQuery, ...terms])];
}

function matchesNeedle(normalized: string, needle: string): boolean {
  if (needle.includes(" ") || /[\u4e00-\u9fff]/u.test(needle)) {
    return normalized.includes(needle);
  }
  return normalized.split(" ").includes(needle);
}

function matchesAnyNeedle(value: string, needles: string[]): boolean {
  const normalized = normalizeSearchText(value);
  return normalized !== "" && needles.some((needle) => matchesNeedle(normalized, needle));
}

function countBodyOccurrences(value: string, needles: string[]): number {
  const normalized = normalizeSearchText(value);
  let count = 0;
  for (const needle of needles) {
    if (needle.includes(" ") || /[\u4e00-\u9fff]/u.test(needle)) {
      let index = normalized.indexOf(needle);
      while (index >= 0 && count < MAX_BODY_MATCH_SCORE) {
        count += 1;
        index = normalized.indexOf(needle, index + needle.length);
      }
    } else {
      for (const token of normalized.split(" ")) {
        if (token === needle) {
          count += 1;
        }
        if (count >= MAX_BODY_MATCH_SCORE) {
          break;
        }
      }
    }
    if (count >= MAX_BODY_MATCH_SCORE) {
      break;
    }
  }
  return count;
}

function kindRank(kind: WikiEvidenceKind, preferredKinds: WikiEvidenceKind[] | undefined): number {
  const index = preferredKinds?.indexOf(kind) ?? -1;
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function uniquePush<T>(items: T[], value: T): void {
  if (!items.includes(value)) {
    items.push(value);
  }
}

function itemMatchesStructuredFilters(item: WikiEvidenceItem, options: SearchWikiEvidenceOptions): boolean {
  if (options.sourceKinds && (!item.sourceKind || !options.sourceKinds.includes(item.sourceKind))) {
    return false;
  }
  if (options.pageTypes && (!item.pageType || !options.pageTypes.includes(item.pageType))) {
    return false;
  }
  if (options.claimKinds && !item.claims?.some((claim) => options.claimKinds?.includes(claim.kind))) {
    return false;
  }
  if (options.knowledgeStates && (!item.knowledgeState || !options.knowledgeStates.includes(item.knowledgeState))) {
    return false;
  }
  if (options.evidenceContracts && !options.evidenceContracts.includes(item.evidenceContract)) {
    return false;
  }
  return true;
}

function claimText(item: WikiEvidenceItem): string {
  return (item.claims ?? [])
    .map((claim) => [
      claim.claimId,
      claim.kind,
      claim.statement,
      claim.sourceRefs.join(" "),
      claim.confidence,
      ...claim.evidence.flatMap((evidence) =>
        [
          evidence.paperKey,
          evidence.sourcePath,
          evidence.parsePath,
          evidence.chunkId,
          evidence.elementId,
          evidence.sectionId,
          evidence.figure,
          evidence.table,
          evidence.codeOutputPath,
          evidence.quote,
          evidence.note,
          evidence.page?.toString()
        ].filter((value): value is string => typeof value === "string")
      )
    ].join(" "))
    .join(" ");
}

function typedRelationText(item: WikiEvidenceItem): string {
  return (item.typedRelations ?? [])
    .map((relation) => [
      relation.type,
      relation.type === "contradicts" ? "contradiction" : "",
      relation.target,
      relation.targetKind,
      relation.evidenceRefs.join(" "),
      relation.status,
      relation.note ?? ""
    ].join(" "))
    .join(" ");
}

function reviewerCritiqueText(item: WikiEvidenceItem): string {
  return (item.reviewerCritique ?? [])
    .map((critique) => [
      critique.id,
      critique.severity,
      critique.target ?? "",
      critique.reason,
      critique.suggestedFix
    ].join(" "))
    .join(" ");
}

function ageWarning(reviewedAt: string | undefined, now: Date, maxAgeDays: number): WikiEvidenceSearchWarning | undefined {
  if (!reviewedAt) {
    return "unknown_freshness";
  }
  const reviewedTime = Date.parse(reviewedAt);
  if (!Number.isFinite(reviewedTime)) {
    return "unknown_freshness";
  }
  const ageMs = now.getTime() - reviewedTime;
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000 ? "stale_evidence" : undefined;
}

function itemWarnings(item: WikiEvidenceItem, options: SearchWikiEvidenceOptions): WikiEvidenceSearchWarning[] {
  const warnings: WikiEvidenceSearchWarning[] = [];
  if (options.maxEvidenceAgeDays !== undefined) {
    const reviewedAt = item.kind === "page" ? item.lastReviewedAt : item.updatedAt;
    const warning = ageWarning(reviewedAt, options.now ?? new Date(), options.maxEvidenceAgeDays);
    if (warning) {
      uniquePush(warnings, warning);
    }
  }
  if (item.knowledgeState === "promising_unverified") {
    uniquePush(warnings, "promising_unverified");
  }
  if (item.knowledgeState === "speculative") {
    uniquePush(warnings, "speculative");
  }
  if (item.knowledgeState === "disputed") {
    uniquePush(warnings, "disputed");
  }
  if (item.claims?.some((claim) => claim.confidence === "low")) {
    uniquePush(warnings, "low_confidence_claim");
  }
  if (item.typedRelations?.some((relation) => relation.type === "contradicts" && relation.status === "candidate")) {
    uniquePush(warnings, "unresolved_contradiction");
  }
  if (item.evidenceContract === "none") {
    uniquePush(warnings, "weak_evidence_contract");
  }
  return warnings;
}

function scoreItem(item: WikiEvidenceItem, needles: string[], options: SearchWikiEvidenceOptions): WikiEvidenceSearchResult {
  let score = 0;
  const matchReasons: WikiEvidenceMatchReason[] = [];

  if (matchesAnyNeedle(item.title, needles)) {
    score += 8;
    uniquePush(matchReasons, "title");
  }
  if (item.aliases.some((alias) => matchesAnyNeedle(alias, needles))) {
    score += 6;
    uniquePush(matchReasons, "alias");
  }
  if (item.tags.some((tag) => matchesAnyNeedle(tag, needles))) {
    score += 6;
    uniquePush(matchReasons, "tag");
  }
  if (item.sourceRefs.some((sourceRef) => matchesAnyNeedle(sourceRef, needles))) {
    score += 4;
    uniquePush(matchReasons, "source_ref");
  }
  if (item.sourceKind && matchesAnyNeedle(item.sourceKind, needles)) {
    score += 4;
    uniquePush(matchReasons, "source_kind");
  }

  const bodyScore = countBodyOccurrences(item.body, needles);
  if (bodyScore > 0) {
    score += bodyScore;
    uniquePush(matchReasons, "body");
  }
  if (matchesAnyNeedle(claimText(item), needles)) {
    score += 5;
    uniquePush(matchReasons, "claim");
  }
  if (matchesAnyNeedle(typedRelationText(item), needles)) {
    score += 5;
    uniquePush(matchReasons, "typed_relation");
  }
  if (matchesAnyNeedle(reviewerCritiqueText(item), needles)) {
    score += 4;
    uniquePush(matchReasons, "reviewer_critique");
  }

  return {
    item,
    score,
    matchReasons,
    warnings: itemWarnings(item, options)
  };
}

export async function searchWikiEvidence(options: SearchWikiEvidenceOptions): Promise<WikiEvidenceSearchResponse> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("query is required.");
  }

  const maxResults = Math.max(1, Math.trunc(options.maxResults ?? DEFAULT_MAX_RESULTS));
  const needles = queryNeedles(query);
  const { items, diagnostics } = await listWikiEvidenceItems({
    workspaceDir: options.workspaceDir
  });

  const results = items
    .filter((item) => options.itemFilter?.(item) ?? true)
    .filter((item) => itemMatchesStructuredFilters(item, options))
    .map((item) => scoreItem(item, needles, options))
    .filter((result) => result.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      const leftKindRank = kindRank(left.item.kind, options.preferredKinds);
      const rightKindRank = kindRank(right.item.kind, options.preferredKinds);
      if (leftKindRank !== rightKindRank) {
        return leftKindRank - rightKindRank;
      }
      return left.item.kind.localeCompare(right.item.kind) || left.item.key.localeCompare(right.item.key);
    })
    .slice(0, maxResults);

  if (results.length === 0) {
    return {
      status: "insufficient_evidence",
      query,
      results,
      insufficientReason: diagnostics.length > 0
        ? `No matching wiki evidence found. Diagnostics: ${diagnostics.join("; ")}`
        : "No matching wiki evidence found."
    };
  }

  return {
    status: "ready",
    query,
    results
  };
}
