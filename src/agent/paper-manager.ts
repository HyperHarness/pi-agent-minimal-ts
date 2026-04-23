import { searchArxiv, type ArxivSearchResult } from "./arxiv.js";
import { searchWeb, type WebSearchResult } from "./web-search.js";
import type {
  PaperAction,
  PaperSearchResult,
  PaperSearchSource,
  PaperSource,
  SupportedPaperSource
} from "./paper-types.js";

export interface SearchPapersOptions {
  query: string;
  maxResults?: number;
  searchArxivImpl?: typeof searchArxiv;
  searchWebImpl?: typeof searchWeb;
}

type RankedSearchSource = PaperSearchSource & {
  rank: number;
  order: number;
};

type RankedArxivSearchSource = Extract<PaperSearchSource, { source: "arxiv" }> & {
  rank: number;
  order: number;
};

type RankedSupportedSearchSource = Extract<
  PaperSearchSource,
  { source: SupportedPaperSource }
> & {
  rank: number;
  order: number;
};

type RankedExternalSearchSource = Extract<PaperSearchSource, { source: "external" }> & {
  rank: number;
  order: number;
};

type ClassifiedPaperUrl =
  | {
      source: "arxiv";
      canonicalId: string;
      articleUrl: string;
      pdfUrl: string;
      action: "direct_download";
    }
  | {
      source: SupportedPaperSource;
      canonicalId: string;
      articleUrl: string;
      action: "authorized_download";
    }
  | {
      source: "external";
      articleUrl: string;
      action: "open_url_only";
    };

type SearchCandidate = {
  title: string;
  titleKey: string;
  authors: string[];
  summary: string;
  sources: RankedSearchSource[];
  order: number;
};

const SUPPORTED_SOURCE_PRIORITY: Record<SupportedPaperSource, number> = {
  science: 0,
  nature: 0,
  aps: 0
};

const PAPER_SOURCE_PRIORITY: Record<PaperSource, number> = {
  science: 0,
  nature: 0,
  aps: 0,
  arxiv: 1,
  external: 2
};

function normalizeTitle(title: string): string {
  const normalized = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || title.trim().toLowerCase();
}

function formatTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

function getTitleKey(title: string): string {
  return normalizeTitle(title);
}

function sortSearchSource(left: RankedSearchSource, right: RankedSearchSource): number {
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }

  return left.order - right.order;
}

function sortCandidate(left: SearchCandidate, right: SearchCandidate): number {
  const leftBestRank = left.sources[0]?.rank ?? Number.POSITIVE_INFINITY;
  const rightBestRank = right.sources[0]?.rank ?? Number.POSITIVE_INFINITY;
  if (leftBestRank !== rightBestRank) {
    return leftBestRank - rightBestRank;
  }

  return left.order - right.order;
}

function classifyArxivSearchResult(result: ArxivSearchResult, order: number): RankedArxivSearchSource {
  return {
    source: "arxiv",
    action: "direct_download",
    canonicalId: result.id,
    articleUrl: result.absUrl,
    pdfUrl: result.pdfUrl,
    rank: PAPER_SOURCE_PRIORITY.arxiv,
    order
  };
}

function extractSupportedCanonicalId(source: SupportedPaperSource, url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);

  if (source === "science") {
    if (parts[0] !== "doi" || parts.length < 2) {
      return null;
    }

    return decodeURIComponent(parts.slice(1).join("/").replace(/\.pdf$/i, ""));
  }

  if (source === "nature") {
    if (parts[0] !== "articles" || parts.length < 2) {
      return null;
    }

    return decodeURIComponent(parts.slice(1).join("/").replace(/\.pdf$/i, ""));
  }

  if (parts.length < 2) {
    return null;
  }

  const abstractIndex = parts.indexOf("abstract");
  if (abstractIndex >= 0 && abstractIndex + 1 < parts.length) {
    return decodeURIComponent(parts.slice(abstractIndex + 1).join("/").replace(/\.pdf$/i, ""));
  }

  const pdfIndex = parts.indexOf("pdf");
  if (pdfIndex >= 0 && pdfIndex + 1 < parts.length) {
    return decodeURIComponent(parts.slice(pdfIndex + 1).join("/").replace(/\.pdf$/i, ""));
  }

  return null;
}

function classifyPaperUrl(
  input: string
): ClassifiedPaperUrl {
  try {
    const url = new URL(input);

    if (url.hostname === "arxiv.org") {
      const path = url.pathname.replace(/\/+$/, "");
      if (path.startsWith("/abs/")) {
        const canonicalId = decodeURIComponent(path.slice("/abs/".length).replace(/\.pdf$/i, ""));
        return {
          source: "arxiv",
          canonicalId,
          articleUrl: `https://arxiv.org/abs/${canonicalId}`,
          pdfUrl: `https://arxiv.org/pdf/${canonicalId}.pdf`,
          action: "direct_download"
        };
      }

      if (path.startsWith("/pdf/")) {
        const canonicalId = decodeURIComponent(path.slice("/pdf/".length).replace(/\.pdf$/i, ""));
        return {
          source: "arxiv",
          canonicalId,
          articleUrl: `https://arxiv.org/abs/${canonicalId}`,
          pdfUrl: `https://arxiv.org/pdf/${canonicalId}.pdf`,
          action: "direct_download"
        };
      }
    }

    const supportedSource = classifySupportedSource(url);
    if (supportedSource) {
      return supportedSource;
    }
  } catch {
    // Fall through to external.
  }

  return {
    source: "external",
    articleUrl: input,
    action: "open_url_only"
  };
}

function classifySupportedSource(url: URL): Extract<
  PaperSearchSource,
  { source: SupportedPaperSource; action: "authorized_download" }
> | null {
  if (url.hostname === "www.science.org" || url.hostname === "science.org") {
    const canonicalId = extractSupportedCanonicalId("science", url);
    if (!canonicalId) {
      return null;
    }

    return {
      source: "science",
      action: "authorized_download",
      canonicalId,
      articleUrl: url.toString()
    };
  }

  if (url.hostname === "www.nature.com" || url.hostname === "nature.com") {
    const canonicalId = extractSupportedCanonicalId("nature", url);
    if (!canonicalId) {
      return null;
    }

    return {
      source: "nature",
      action: "authorized_download",
      canonicalId,
      articleUrl: url.toString()
    };
  }

  if (url.hostname === "journals.aps.org" || url.hostname === "aps.org") {
    const canonicalId = extractSupportedCanonicalId("aps", url);
    if (!canonicalId) {
      return null;
    }

    return {
      source: "aps",
      action: "authorized_download",
      canonicalId,
      articleUrl: url.toString()
    };
  }

  return null;
}

function classifyWebSearchResult(
  result: WebSearchResult,
  order: number
): RankedArxivSearchSource | RankedSupportedSearchSource | RankedExternalSearchSource {
  const classification = classifyPaperUrl(result.url);
  if (classification.source === "external") {
    return {
      source: "external",
      action: "open_url_only",
      articleUrl: classification.articleUrl,
      rank: PAPER_SOURCE_PRIORITY.external,
      order
    };
  }

  if (classification.source === "arxiv") {
    return {
      source: "arxiv",
      action: "direct_download",
      canonicalId: classification.canonicalId,
      articleUrl: classification.articleUrl,
      pdfUrl: classification.pdfUrl,
      rank: PAPER_SOURCE_PRIORITY.arxiv,
      order
    };
  }

  return {
    source: classification.source,
    action: classification.action,
    canonicalId: classification.canonicalId,
    articleUrl: classification.articleUrl,
    rank: SUPPORTED_SOURCE_PRIORITY[classification.source],
    order
  };
}

function addCandidate(
  candidates: Map<string, SearchCandidate>,
  candidate: Omit<SearchCandidate, "titleKey" | "sources"> & {
    source: RankedSearchSource;
  }
): void {
  const titleKey = getTitleKey(candidate.title);
  const existing = candidates.get(titleKey);
  const rankedSource = candidate.source;

  if (!existing) {
    candidates.set(titleKey, {
      title: formatTitle(candidate.title),
      titleKey,
      authors: candidate.authors,
      summary: candidate.summary,
      sources: [rankedSource],
      order: candidate.order
    });
    return;
  }

  const previousBestRank = existing.sources[0]?.rank ?? Number.POSITIVE_INFINITY;
  const previousOrder = existing.order;
  existing.sources.push(rankedSource);
  existing.sources.sort(sortSearchSource);

  const candidateBestRank = rankedSource.rank;
  if (candidateBestRank < previousBestRank) {
    existing.title = formatTitle(candidate.title);
    existing.authors = candidate.authors;
    existing.summary = candidate.summary;
  }

  if (candidateBestRank === previousBestRank && candidate.order < previousOrder) {
    existing.title = formatTitle(candidate.title);
    existing.authors = candidate.authors;
    existing.summary = candidate.summary;
    existing.order = candidate.order;
  }
}

function toPaperSearchResult(candidate: SearchCandidate): PaperSearchResult {
  const sources = candidate.sources
    .slice()
    .sort(sortSearchSource)
    .map(({ rank: _rank, order: _order, ...source }) => source);

  const primarySource = sources[0];
  if (!primarySource) {
    throw new Error("A merged paper search result must contain at least one source.");
  }

  if (primarySource.source === "external") {
    return {
      title: candidate.title,
      authors: candidate.authors,
      summary: candidate.summary,
      primarySource: "external",
      primaryAction: "open_url_only",
      sources
    };
  }

  if (primarySource.source === "arxiv") {
    return {
      title: candidate.title,
      authors: candidate.authors,
      summary: candidate.summary,
      primarySource: "arxiv",
      primaryAction: "direct_download",
      sources
    };
  }

  return {
    title: candidate.title,
    authors: candidate.authors,
    summary: candidate.summary,
    primarySource: primarySource.source,
    primaryAction: "authorized_download",
    sources
  };
}

export async function searchPapers(options: SearchPapersOptions): Promise<PaperSearchResult[]> {
  const searchArxivImpl = options.searchArxivImpl ?? searchArxiv;
  const searchWebImpl = options.searchWebImpl ?? searchWeb;
  const maxResults = options.maxResults ?? 5;

  const [arxivResults, webResults] = await Promise.all([
    searchArxivImpl({ query: options.query, maxResults }),
    searchWebImpl({ query: options.query, maxResults })
  ]);

  const candidates = new Map<string, SearchCandidate>();
  let order = 0;

  for (const result of arxivResults) {
    addCandidate(candidates, {
      title: result.title,
      authors: result.authors,
      summary: result.summary,
      order,
      source: classifyArxivSearchResult(result, order)
    });
    order += 1;
  }

  for (const result of webResults) {
    addCandidate(candidates, {
      title: result.title,
      authors: [],
      summary: result.snippet,
      order,
      source: classifyWebSearchResult(result, order)
    });
    order += 1;
  }

  return Array.from(candidates.values())
    .sort(sortCandidate)
    .slice(0, maxResults)
    .map(toPaperSearchResult);
}
