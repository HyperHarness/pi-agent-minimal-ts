import {
  listWikiEvidenceItems,
  type WikiEvidenceItem,
  type WikiEvidenceKind
} from "./retrieval-contract.js";

export type WikiEvidenceSearchStatus = "ready" | "insufficient_evidence";
export type WikiEvidenceMatchReason = "title" | "alias" | "tag" | "source_ref" | "body";

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

function scoreItem(item: WikiEvidenceItem, needles: string[]): WikiEvidenceSearchResult {
  let score = 0;
  const matchReasons: WikiEvidenceMatchReason[] = [];

  if (matchesAnyNeedle(item.title, needles)) {
    score += 8;
    matchReasons.push("title");
  }
  if (item.aliases.some((alias) => matchesAnyNeedle(alias, needles))) {
    score += 6;
    matchReasons.push("alias");
  }
  if (item.tags.some((tag) => matchesAnyNeedle(tag, needles))) {
    score += 6;
    matchReasons.push("tag");
  }
  if (item.sourceRefs.some((sourceRef) => matchesAnyNeedle(sourceRef, needles))) {
    score += 4;
    matchReasons.push("source_ref");
  }

  const bodyScore = countBodyOccurrences(item.body, needles);
  if (bodyScore > 0) {
    score += bodyScore;
    matchReasons.push("body");
  }

  return {
    item,
    score,
    matchReasons,
    warnings: item.diagnostics
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
    .map((item) => scoreItem(item, needles))
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
