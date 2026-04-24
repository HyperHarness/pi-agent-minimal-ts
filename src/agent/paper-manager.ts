import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadArxivPdf, searchArxiv, type ArxivSearchResult } from "./arxiv.js";
import { searchApsPapers, type SearchApsPapersOptions } from "./aps-search.js";
import {
  openPageInSystemChrome,
  resolveDefaultPaperBrowserSessionFactory,
  type OpenSystemChromePageResult,
  type PaperBrowserSession
} from "./browser-session.js";
import {
  PaperDownloadError,
  downloadPublisherPaper,
  resolvePublisherCanonicalId,
  resolvePublisherCanonicalIdFromArticleUrl
} from "./paper-download.js";
import { resolvePaperPdfPath, writePaperRecord } from "./paper-store.js";
import {
  DEFAULT_CLOUDFLARE_COOLDOWN_MS,
  getRecentCloudflareBlock,
  readPublisherAccessState,
  setCloudflareBlock,
  writePublisherAccessState,
  type PublisherAccessState
} from "./publisher-access-state.js";
import { searchWeb, type WebSearchResult } from "./web-search.js";
import type {
  PaperDownloadResult,
  PaperFailure,
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

type DownloadPublisherPaperImplementation = (options: {
  workspaceDir: string;
  url: string;
}) => Promise<Awaited<ReturnType<typeof downloadPublisherPaper>>>;

type OpenPublisherForLoginImplementation = (
  options: {
    workspaceDir: string;
    url: string;
  }
) => Promise<{
  openedUrl: string;
  profileDir?: string;
  executablePath?: string;
}>;

export interface DownloadPaperOptions {
  workspaceDir: string;
  id?: string;
  url?: string;
  forceManualOpen?: PaperFailure;
  fetchImpl?: typeof fetch;
  browserSessionFactory?: () => Promise<PaperBrowserSession>;
  downloadPublisherPaperImpl?: DownloadPublisherPaperImplementation;
  openPublisherForLoginImpl?: OpenPublisherForLoginImplementation;
  openPageInSystemChromeImpl?: typeof openPageInSystemChrome;
}

export interface DownloadLatestApsPapersOptions {
  workspaceDir: string;
  query: string;
  maxResults?: number;
  cloudflareCooldownMs?: number;
  now?: () => Date;
  readPublisherAccessStateImpl?: typeof readPublisherAccessState;
  writePublisherAccessStateImpl?: typeof writePublisherAccessState;
  searchApsPapersImpl?: (options: SearchApsPapersOptions) => Promise<PaperSearchResult[]>;
  downloadPaperImpl?: typeof downloadPaper;
}

export interface DownloadLatestApsPapersResult {
  query: string;
  requested: number;
  results: Array<{
    title: string;
    articleUrl: string;
    download: PaperDownloadResult;
  }>;
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
      canonicalId?: string;
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
    const canonicalId = resolvePublisherCanonicalId({
      publisher: "science",
      url: url.toString()
    });
    return {
      source: "science",
      action: "authorized_download",
      articleUrl: url.toString(),
      ...(canonicalId ? { canonicalId } : {})
    };
  }

  if (url.hostname === "www.nature.com" || url.hostname === "nature.com") {
    const canonicalId = resolvePublisherCanonicalId({
      publisher: "nature",
      url: url.toString()
    });
    return {
      source: "nature",
      action: "authorized_download",
      articleUrl: url.toString(),
      ...(canonicalId ? { canonicalId } : {})
    };
  }

  if (
    url.hostname === "journals.aps.org" ||
    url.hostname === "aps.org"
  ) {
    const canonicalId = resolvePublisherCanonicalId({
      publisher: "aps",
      url: url.toString()
    });
    return {
      source: "aps",
      action: "authorized_download",
      articleUrl: url.toString(),
      ...(canonicalId ? { canonicalId } : {})
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
    articleUrl: classification.articleUrl,
    rank: SUPPORTED_SOURCE_PRIORITY[classification.source],
    order,
    ...(classification.canonicalId ? { canonicalId: classification.canonicalId } : {})
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
    if (candidate.authors.length > 0) {
      existing.authors = candidate.authors;
    }
    existing.summary = candidate.summary;
    existing.order = candidate.order;
  }

  if (candidateBestRank === previousBestRank && candidate.order < previousOrder) {
    existing.title = formatTitle(candidate.title);
    if (candidate.authors.length > 0) {
      existing.authors = candidate.authors;
    }
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

const FALLBACK_ELIGIBLE_DOWNLOAD_ERROR_CODES = new Set<PaperDownloadError["code"]>([
  "browser_session_unavailable",
  "manual_login_required",
  "authorization_failed",
  "pdf_not_found",
  "download_failed"
]);

function assertExactlyOnePaperLocator(options: Pick<DownloadPaperOptions, "id" | "url">): void {
  const providedCount = Number(Boolean(options.id)) + Number(Boolean(options.url));
  if (providedCount !== 1) {
    throw new Error("downloadPaper requires exactly one of id or url.");
  }
}

function toPaperFailure(error: PaperDownloadError): PaperFailure {
  return {
    code: error.code,
    message: error.message
  };
}

function resolveFallbackCanonicalId(input: {
  articleUrl: string;
  canonicalId?: string;
}): string {
  if (input.canonicalId) {
    return input.canonicalId;
  }

  const hostname = new URL(input.articleUrl).hostname.toLowerCase();
  const hash = createHash("sha1").update(input.articleUrl).digest("hex").slice(0, 12);
  return `${hostname}-${hash}`;
}

function isFallbackEligibleDownloadError(error: unknown): error is PaperDownloadError {
  return (
    error instanceof PaperDownloadError && FALLBACK_ELIGIBLE_DOWNLOAD_ERROR_CODES.has(error.code)
  );
}

function isLikelyCloudflareFallback(result: PaperDownloadResult): boolean {
  if (result.status !== "manual_fallback_opened") {
    return false;
  }

  const fallbackUrl = result.fallbackUrl.toLowerCase();
  const message = result.failure.message.toLowerCase();
  return (
    fallbackUrl.includes("__cf_chl") ||
    message.includes("cloudflare") ||
    message.includes("verification")
  );
}

async function openSupportedPublisherForManualFallback(input: {
  workspaceDir: string;
  classification: Extract<ClassifiedPaperUrl, { source: SupportedPaperSource }>;
  failure: PaperFailure;
  openPublisherForLoginImpl: OpenPublisherForLoginImplementation;
}): Promise<PaperDownloadResult> {
  const canonicalId = resolveFallbackCanonicalId({
    articleUrl: input.classification.articleUrl,
    canonicalId:
      resolvePublisherCanonicalIdFromArticleUrl({
        publisher: input.classification.source,
        articleUrl: input.classification.articleUrl
      }) ?? input.classification.canonicalId
  });
  const fallbackResult = await input.openPublisherForLoginImpl({
    workspaceDir: input.workspaceDir,
    url: input.classification.articleUrl
  });
  const recordPath = await writePaperRecord({
    workspaceDir: input.workspaceDir,
    record: {
      source: input.classification.source,
      articleUrl: input.classification.articleUrl,
      openedUrl: fallbackResult.openedUrl,
      recordedAt: new Date().toISOString(),
      handlingMethod: "browser_session",
      status: "manual_fallback_opened",
      canonicalId,
      failure: input.failure
    }
  });

  return {
    status: "manual_fallback_opened",
    source: input.classification.source,
    articleUrl: input.classification.articleUrl,
    fallbackUrl: fallbackResult.openedUrl,
    recordPath,
    canonicalId,
    failure: input.failure,
    profileDir: fallbackResult.profileDir,
    executablePath: fallbackResult.executablePath
  };
}

async function downloadArxivPaper(options: {
  workspaceDir: string;
  input: string;
  fetchImpl?: typeof fetch;
}): Promise<PaperDownloadResult> {
  const result = await downloadArxivPdf({
    input: options.input,
    fetchImpl: options.fetchImpl
  });
  const pdfPath = resolvePaperPdfPath({
    workspaceDir: options.workspaceDir,
    source: "arxiv",
    canonicalId: result.canonicalId
  });

  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, result.pdfBytes);

  const recordPath = await writePaperRecord({
    workspaceDir: options.workspaceDir,
    record: {
      source: "arxiv",
      articleUrl: result.articleUrl,
      recordedAt: new Date().toISOString(),
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: result.canonicalId,
      pdfUrl: result.finalPdfUrl,
      downloadPath: pdfPath
    }
  });

  return {
    status: "downloaded",
    source: "arxiv",
    canonicalId: result.canonicalId,
    articleUrl: result.articleUrl,
    finalPdfUrl: result.finalPdfUrl,
    path: pdfPath,
    recordPath
  };
}

async function withBrowserSession<T>(
  browserSessionFactory: () => Promise<PaperBrowserSession>,
  action: (browserSession: PaperBrowserSession) => Promise<T>
): Promise<T> {
  const browserSession = await browserSessionFactory();

  try {
    return await action(browserSession);
  } finally {
    await browserSession.dispose?.().catch(() => {});
  }
}

export async function downloadPaper(options: DownloadPaperOptions): Promise<PaperDownloadResult> {
  assertExactlyOnePaperLocator(options);

  if (options.id) {
    return downloadArxivPaper({
      workspaceDir: options.workspaceDir,
      input: options.id,
      fetchImpl: options.fetchImpl
    });
  }

  const paperUrl = options.url as string;
  const classification = classifyPaperUrl(paperUrl);

  if (classification.source === "arxiv") {
    return downloadArxivPaper({
      workspaceDir: options.workspaceDir,
      input: classification.canonicalId,
      fetchImpl: options.fetchImpl
    });
  }

  if (classification.source === "external") {
    const openPageInSystemChromeImpl = options.openPageInSystemChromeImpl ?? openPageInSystemChrome;
    const openResult = await openPageInSystemChromeImpl({
      workspaceDir: options.workspaceDir,
      url: classification.articleUrl
    });
    const recordPath = await writePaperRecord({
      workspaceDir: options.workspaceDir,
      record: {
        source: "external",
        articleUrl: classification.articleUrl,
        openedUrl: openResult.openedUrl,
        recordedAt: new Date().toISOString(),
        handlingMethod: "system_browser_open",
        status: "external_opened"
      }
    });

    return {
      status: "external_opened",
      source: "external",
      articleUrl: classification.articleUrl,
      openedUrl: openResult.openedUrl,
      recordPath,
      executablePath: openResult.executablePath
    };
  }

  const openPublisherForLoginImpl: OpenPublisherForLoginImplementation =
    options.openPublisherForLoginImpl ??
    ((openOptions) =>
      (options.openPageInSystemChromeImpl ?? openPageInSystemChrome)({
        workspaceDir: openOptions.workspaceDir,
        url: openOptions.url
      }).then(({ openedUrl, profileDir, executablePath }) => ({
        openedUrl,
        profileDir,
        executablePath
      })));

  if (options.forceManualOpen) {
    return openSupportedPublisherForManualFallback({
      workspaceDir: options.workspaceDir,
      classification,
      failure: options.forceManualOpen,
      openPublisherForLoginImpl
    });
  }

  const browserSessionFactory =
    options.browserSessionFactory ??
    resolveDefaultPaperBrowserSessionFactory({ workspaceDir: options.workspaceDir });
  const downloadPublisherPaperImpl: DownloadPublisherPaperImplementation =
    options.downloadPublisherPaperImpl ??
    ((downloadOptions) =>
      withBrowserSession(browserSessionFactory, (browserSession) =>
        downloadPublisherPaper({
          ...downloadOptions,
          browserSession
        })
      ));

  try {
    const result = await downloadPublisherPaperImpl({
      workspaceDir: options.workspaceDir,
      url: classification.articleUrl
    });
    const recordPath = await writePaperRecord({
      workspaceDir: options.workspaceDir,
      record: {
        source: result.publisher,
        articleUrl: result.articleUrl,
        recordedAt: new Date().toISOString(),
        handlingMethod: "browser_session",
        status: "downloaded",
        canonicalId: result.canonicalId,
        pdfUrl: result.finalPdfUrl,
        downloadPath: result.path
      }
    });

    return {
      status: "downloaded",
      source: result.publisher,
      canonicalId: result.canonicalId,
      articleUrl: result.articleUrl,
      finalPdfUrl: result.finalPdfUrl,
      path: result.path,
      recordPath
    };
  } catch (error) {
    if (!isFallbackEligibleDownloadError(error)) {
      throw error;
    }

    return openSupportedPublisherForManualFallback({
      workspaceDir: options.workspaceDir,
      classification,
      failure: toPaperFailure(error),
      openPublisherForLoginImpl
    });
  }
}

export async function downloadLatestApsPapers(
  options: DownloadLatestApsPapersOptions
): Promise<DownloadLatestApsPapersResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("Query is required.");
  }

  const maxResults = options.maxResults ?? 3;
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error("maxResults must be a positive integer.");
  }

  const searchApsPapersImpl = options.searchApsPapersImpl ?? searchApsPapers;
  const downloadPaperImpl = options.downloadPaperImpl ?? downloadPaper;
  const readPublisherAccessStateImpl =
    options.readPublisherAccessStateImpl ?? readPublisherAccessState;
  const writePublisherAccessStateImpl =
    options.writePublisherAccessStateImpl ?? writePublisherAccessState;
  const now = options.now ?? (() => new Date());
  const cloudflareCooldownMs =
    options.cloudflareCooldownMs ?? DEFAULT_CLOUDFLARE_COOLDOWN_MS;
  let publisherAccessState: PublisherAccessState = await readPublisherAccessStateImpl({
    workspaceDir: options.workspaceDir
  });
  let recentCloudflareBlockAt = getRecentCloudflareBlock({
    state: publisherAccessState,
    publisher: "aps",
    now: now(),
    cooldownMs: cloudflareCooldownMs
  });
  const papers = await searchApsPapersImpl({
    query,
    maxResults
  });
  const results: DownloadLatestApsPapersResult["results"] = [];

  for (const paper of papers.slice(0, maxResults)) {
    const apsSource = paper.sources.find((source) => source.source === "aps");
    if (!apsSource) {
      continue;
    }

    const download = await downloadPaperImpl({
      workspaceDir: options.workspaceDir,
      url: apsSource.articleUrl,
      ...(recentCloudflareBlockAt
        ? {
            forceManualOpen: {
              code: "recent_cloudflare_block",
              message: `Skipping automatic APS download because Cloudflare blocked APS access at ${recentCloudflareBlockAt}. Complete the opened page manually, or retry automatic download after the cooldown window.`
            }
          }
        : {})
    });
    if (!recentCloudflareBlockAt && isLikelyCloudflareFallback(download)) {
      recentCloudflareBlockAt = now().toISOString();
      publisherAccessState = setCloudflareBlock({
        state: publisherAccessState,
        publisher: "aps",
        blockedAt: recentCloudflareBlockAt
      });
      await writePublisherAccessStateImpl({
        workspaceDir: options.workspaceDir,
        state: publisherAccessState
      });
    }
    results.push({
      title: paper.title,
      articleUrl: apsSource.articleUrl,
      download
    });
  }

  return {
    query,
    requested: maxResults,
    results
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
