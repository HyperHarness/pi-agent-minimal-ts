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
  | "reviewer_critique"
  | "semantic_expansion";
export type WikiEvidenceSearchWarning =
  | "stale_evidence"
  | "unknown_freshness"
  | "speculative"
  | "promising_unverified"
  | "disputed"
  | "low_confidence_claim"
  | "unresolved_contradiction"
  | "weak_evidence_contract"
  | "summary_only_evidence"
  | "missing_claim_provenance";

export interface WikiEvidenceSearchResult {
  item: WikiEvidenceItem;
  score: number;
  matchReasons: WikiEvidenceMatchReason[];
  warnings: string[];
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
const MAX_BODY_MATCH_SCORE = 10;
const GENERIC_DOMAIN_TERMS = new Set([
  "architecture",
  "architectures",
  "chip",
  "chips",
  "computing",
  "design",
  "hardware",
  "implementation",
  "implementations",
  "implemented",
  "implementing",
  "processor",
  "processors",
  "quantum",
  "qubit",
  "qubits",
  "superconducting"
]);
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

interface SearchNeedle {
  text: string;
  weight: number;
  semanticExpansion: boolean;
}

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

function isGenericDomainTerm(term: string): boolean {
  return GENERIC_DOMAIN_TERMS.has(term);
}

function addNeedle(needles: Map<string, SearchNeedle>, needle: SearchNeedle): void {
  if (!needle.text) {
    return;
  }
  const existing = needles.get(needle.text);
  if (!existing || existing.weight < needle.weight) {
    needles.set(needle.text, needle);
    return;
  }
  if (needle.semanticExpansion && !existing.semanticExpansion) {
    needles.set(needle.text, {
      ...existing,
      semanticExpansion: true
    });
  }
}

function domainSemanticExpansions(normalizedQuery: string, terms: string[]): string[] {
  const termSet = new Set(terms);
  const mentionsQldpc = /\bqldpc\b/.test(normalizedQuery) ||
    (termSet.has("quantum") && termSet.has("ldpc")) ||
    /\bldpc\b/.test(normalizedQuery);
  const asksImplementation = [
    "bottleneck",
    "bottlenecks",
    "constraint",
    "constraints",
    "hardware",
    "implementation",
    "implementations",
    "implementing",
    "layout",
    "layouts",
    "mapping",
    "overhead",
    "route",
    "routing"
  ].some((term) => termSet.has(term));
  const mentionsChipHardware = [
    "architecture",
    "architectures",
    "chip",
    "chips",
    "coupler",
    "couplers",
    "hardware",
    "layout",
    "layouts",
    "superconducting"
  ].some((term) => termSet.has(term));
  if (!mentionsQldpc || (!asksImplementation && !mentionsChipHardware)) {
    return [];
  }
  return [
    "2d local",
    "bilayer",
    "bilayer architecture",
    "connectivity",
    "coupler",
    "couplers",
    "decoding overhead",
    "decoder",
    "detector error",
    "flip chip",
    "flip-chip",
    "hardware layout",
    "layout",
    "long range",
    "long-range",
    "modular",
    "non local",
    "non-local",
    "nonlocal",
    "routing",
    "routing overhead",
    "syndrome extraction"
  ];
}

function queryNeedles(query: string): SearchNeedle[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }
  const terms = normalizedQuery
    .split(" ")
    .filter((term) => term && !ENGLISH_STOPWORDS.has(term));
  const needles = new Map<string, SearchNeedle>();
  if (terms.length > 1) {
    addNeedle(needles, {
      text: normalizedQuery,
      weight: 3,
      semanticExpansion: false
    });
  }
  for (const term of terms) {
    addNeedle(needles, {
      text: term,
      weight: isGenericDomainTerm(term) ? 0.25 : 1,
      semanticExpansion: false
    });
  }
  for (const expansion of domainSemanticExpansions(normalizedQuery, terms)) {
    addNeedle(needles, {
      text: normalizeSearchText(expansion),
      weight: 1.25,
      semanticExpansion: true
    });
  }
  return [...needles.values()];
}

function matchesNeedle(normalized: string, needle: SearchNeedle): boolean {
  if (needle.text.includes(" ") || /[\u4e00-\u9fff]/u.test(needle.text)) {
    return normalized.includes(needle.text);
  }
  return normalized.split(" ").includes(needle.text);
}

function matchedNeedles(value: string, needles: SearchNeedle[]): SearchNeedle[] {
  const normalized = normalizeSearchText(value);
  return normalized === "" ? [] : needles.filter((needle) => matchesNeedle(normalized, needle));
}

function scoreNeedleMatches(matches: SearchNeedle[], multiplier: number, maxScore: number): number {
  const score = matches.reduce((total, needle) => total + needle.weight * multiplier, 0);
  return Math.min(maxScore, score);
}

function scoreTextField(value: string, needles: SearchNeedle[], multiplier: number, maxScore: number): {
  score: number;
  semanticExpansion: boolean;
} {
  const matches = matchedNeedles(value, needles);
  return {
    score: scoreNeedleMatches(matches, multiplier, maxScore),
    semanticExpansion: matches.some((needle) => needle.semanticExpansion)
  };
}

function scoreTextList(values: string[], needles: SearchNeedle[], multiplier: number, maxScore: number): {
  score: number;
  semanticExpansion: boolean;
} {
  let score = 0;
  let semanticExpansion = false;
  for (const value of values) {
    const result = scoreTextField(value, needles, multiplier, maxScore);
    score += result.score;
    semanticExpansion ||= result.semanticExpansion;
    if (score >= maxScore) {
      return { score: maxScore, semanticExpansion };
    }
  }
  return { score, semanticExpansion };
}

function countBodyOccurrences(value: string, needles: SearchNeedle[]): {
  score: number;
  semanticExpansion: boolean;
} {
  const normalized = normalizeSearchText(value);
  let score = 0;
  let semanticExpansion = false;
  for (const needle of needles) {
    if (needle.text.includes(" ") || /[\u4e00-\u9fff]/u.test(needle.text)) {
      let index = normalized.indexOf(needle.text);
      while (index >= 0 && score < MAX_BODY_MATCH_SCORE) {
        score += needle.weight;
        semanticExpansion ||= needle.semanticExpansion;
        index = normalized.indexOf(needle.text, index + needle.text.length);
      }
    } else {
      for (const token of normalized.split(" ")) {
        if (token === needle.text) {
          score += needle.weight;
          semanticExpansion ||= needle.semanticExpansion;
        }
        if (score >= MAX_BODY_MATCH_SCORE) {
          break;
        }
      }
    }
    if (score >= MAX_BODY_MATCH_SCORE) {
      break;
    }
  }
  return {
    score: Math.min(MAX_BODY_MATCH_SCORE, score),
    semanticExpansion
  };
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

function itemSearchableText(item: WikiEvidenceItem): string {
  return normalizeSearchText([
    item.title,
    item.aliases.join(" "),
    item.tags.join(" "),
    item.sourceRefs.join(" "),
    item.sourceKind ?? "",
    item.body,
    claimText(item),
    typedRelationText(item),
    reviewerCritiqueText(item)
  ].join(" "));
}

function queryMentionsQldpc(needles: SearchNeedle[]): boolean {
  return needles.some((needle) =>
    !needle.semanticExpansion &&
    (needle.text === "qldpc" || needle.text === "ldpc" || needle.text.includes("low density parity check"))
  );
}

function qldpcImplementationCoverageScore(item: WikiEvidenceItem, needles: SearchNeedle[]): number {
  if (!queryMentionsQldpc(needles)) {
    return 0;
  }
  const text = itemSearchableText(item);
  const hasQldpcAnchor = /\bqldpc\b|\bldpc\b|low density parity check|low density paritycheck/u.test(text);
  const hasSuperconductingHardwareAnchor =
    /superconducting|transmon|circuit qed|\bchip\b|\bchips\b|\bhardware\b|processor|processors/u.test(text);
  const hasImplementationAnchor =
    /2d local|bilayer|bottleneck|bottlenecks|connectivity|coupler|couplers|decoding overhead|flip chip|layout|layouts|long range|modular|non local|nonlocal|overhead|routing|syndrome extraction/u.test(text);
  if (hasQldpcAnchor && hasSuperconductingHardwareAnchor && hasImplementationAnchor) {
    return 5;
  }
  if (hasQldpcAnchor && hasImplementationAnchor) {
    return 3;
  }
  if (hasQldpcAnchor && hasSuperconductingHardwareAnchor) {
    return 2;
  }
  return hasQldpcAnchor ? 1 : -2;
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
  if (item.kind === "source") {
    uniquePush(warnings, "summary_only_evidence");
  }
  const hasClaimLevelProvenance = (item.claims?.length ?? 0) > 0 ||
    (item.typedRelations?.length ?? 0) > 0 ||
    (item.experimentRefs?.length ?? 0) > 0;
  if (item.kind === "page" && item.evidenceContract !== "none" && !hasClaimLevelProvenance) {
    uniquePush(warnings, "missing_claim_provenance");
  }
  return warnings;
}

function scoreItem(item: WikiEvidenceItem, needles: SearchNeedle[], options: SearchWikiEvidenceOptions): WikiEvidenceSearchResult {
  let score = 0;
  const matchReasons: WikiEvidenceMatchReason[] = [];

  const titleScore = scoreTextField(item.title, needles, 2.5, 8);
  if (titleScore.score > 0) {
    score += titleScore.score;
    uniquePush(matchReasons, "title");
    if (titleScore.semanticExpansion) {
      uniquePush(matchReasons, "semantic_expansion");
    }
  }
  const aliasScore = scoreTextList(item.aliases, needles, 2, 6);
  if (aliasScore.score > 0) {
    score += aliasScore.score;
    uniquePush(matchReasons, "alias");
    if (aliasScore.semanticExpansion) {
      uniquePush(matchReasons, "semantic_expansion");
    }
  }
  const tagScore = scoreTextList(item.tags, needles, 2, 6);
  if (tagScore.score > 0) {
    score += tagScore.score;
    uniquePush(matchReasons, "tag");
    if (tagScore.semanticExpansion) {
      uniquePush(matchReasons, "semantic_expansion");
    }
  }
  const sourceRefScore = scoreTextList(item.sourceRefs, needles, 1.5, 4);
  if (sourceRefScore.score > 0) {
    score += sourceRefScore.score;
    uniquePush(matchReasons, "source_ref");
  }
  const sourceKindScore = item.sourceKind ? scoreTextField(item.sourceKind, needles, 1.5, 4) : { score: 0, semanticExpansion: false };
  if (sourceKindScore.score > 0) {
    score += sourceKindScore.score;
    uniquePush(matchReasons, "source_kind");
  }

  const bodyScore = countBodyOccurrences(item.body, needles);
  if (bodyScore.score > 0) {
    score += bodyScore.score;
    uniquePush(matchReasons, "body");
    if (bodyScore.semanticExpansion) {
      uniquePush(matchReasons, "semantic_expansion");
    }
  }
  const claimScore = scoreTextField(claimText(item), needles, 2.5, 7);
  if (claimScore.score > 0) {
    score += claimScore.score;
    uniquePush(matchReasons, "claim");
    if (claimScore.semanticExpansion) {
      uniquePush(matchReasons, "semantic_expansion");
    }
  }
  const typedRelationScore = scoreTextField(typedRelationText(item), needles, 2.5, 7);
  if (typedRelationScore.score > 0) {
    score += typedRelationScore.score;
    uniquePush(matchReasons, "typed_relation");
    if (typedRelationScore.semanticExpansion) {
      uniquePush(matchReasons, "semantic_expansion");
    }
  }
  const reviewerCritiqueScore = scoreTextField(reviewerCritiqueText(item), needles, 2, 5);
  if (reviewerCritiqueScore.score > 0) {
    score += reviewerCritiqueScore.score;
    uniquePush(matchReasons, "reviewer_critique");
    if (reviewerCritiqueScore.semanticExpansion) {
      uniquePush(matchReasons, "semantic_expansion");
    }
  }
  score += qldpcImplementationCoverageScore(item, needles);

  return {
    item,
    score,
    matchReasons,
    warnings: [...item.diagnostics, ...itemWarnings(item, options)]
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
