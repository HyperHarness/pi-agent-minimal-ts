import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  downloadArxivPdf,
  parseArxivLocator,
  searchArxiv,
  type ArxivSearchResult
} from "./arxiv.js";
import { searchApsPapers, type SearchApsPapersOptions } from "./aps-search.js";
import {
  openPageInSystemChrome,
  resolveDefaultPaperBrowserSessionFactory,
  type OpenSystemChromePageResult,
  type PaperBrowserSession
} from "./browser-session.js";
import {
  canonicalizeApsDoi,
  PaperDownloadError,
  downloadPublisherPaper,
  resolvePublisherCanonicalId,
  resolvePublisherCanonicalIdFromArticleUrl
} from "./paper-download.js";
import {
  createPaperExtensionJob,
  type PaperExtensionBridge
} from "./paper-extension-bridge.js";
import {
  readPaperDownloadJobEvents,
  summarizePaperDownloadJobs
} from "./paper-download-jobs.js";
import {
  findDownloadedPaperRecord,
  readPaperRecord,
  resolveExternalPaperPdfPath,
  resolvePaperPdfPath,
  writePaperRecord,
  type DownloadedPaperRecordMatch
} from "./paper-store.js";
import { resolvePaperLibraryPaths } from "./knowledge-base.js";
import {
  DEFAULT_CLOUDFLARE_COOLDOWN_MS,
  getRecentCloudflareBlock,
  readPublisherAccessState,
  setCloudflareBlock,
  writePublisherAccessState,
  type PublisherAccessState
} from "./publisher-access-state.js";
import { searchWeb, type WebSearchResult } from "./web-search.js";
import { listLocalPapers } from "./local-paper-library.js";
import {
  derivePaperKeyForBlocklist,
  findBlockedPaperDownload,
  type PaperBlocklistEntry,
  type PaperBlocklistLookup
} from "./paper-blocklist.js";
import type {
  PaperDownloadResult,
  PaperFailure,
  PaperAction,
  RegisteredManualPaperDownloadResult,
  PaperSearchResult,
  PaperSearchSource,
  PaperSource,
  PublisherPreprintFallbackResult,
  SupportedPaperSource
} from "./paper-types.js";

const execFileAsync = promisify(execFile);

export interface SearchPapersOptions {
  query: string;
  maxResults?: number;
  searchArxivImpl?: typeof searchArxiv;
  searchApsPapersImpl?: typeof searchApsPapers;
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
  title?: string;
  forceManualOpen?: PaperFailure;
  fetchImpl?: typeof fetch;
  searchArxivImpl?: typeof searchArxiv;
  browserSessionFactory?: () => Promise<PaperBrowserSession>;
  downloadPublisherPaperImpl?: DownloadPublisherPaperImplementation;
  openPublisherForLoginImpl?: OpenPublisherForLoginImplementation;
  openPageInSystemChromeImpl?: typeof openPageInSystemChrome;
  extensionBridge?: PaperExtensionBridge;
  usePlaywrightFallback?: boolean;
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

export interface RegisterManualPaperDownloadOptions {
  workspaceDir: string;
  url: string;
  pdfPath: string;
  title?: string;
  now?: () => Date;
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

type ArxivDownloadedPaperResult = PaperDownloadResult & {
  status: "downloaded" | "already_downloaded";
  source: "arxiv";
  canonicalId: string;
  articleUrl: string;
  finalPdfUrl: string;
  path: string;
  recordPath: string;
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

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function formatTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

function getTitleKey(title: string): string {
  return normalizeTitle(title);
}

function getCompactTitleKey(title: string): string {
  return normalizeTitle(title).replace(/\s+/g, "");
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

function rankPaperSearchSource(source: PaperSearchSource, order: number): RankedSearchSource {
  if (source.source === "external") {
    return {
      ...source,
      rank: PAPER_SOURCE_PRIORITY.external,
      order
    };
  }

  if (source.source === "arxiv") {
    return {
      ...source,
      rank: PAPER_SOURCE_PRIORITY.arxiv,
      order
    };
  }

  return {
    ...source,
    rank: SUPPORTED_SOURCE_PRIORITY[source.source],
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

      if (path.startsWith("/html/")) {
        const canonicalId = decodeURIComponent(path.slice("/html/".length));
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
    url.hostname === "link.aps.org" ||
    url.hostname === "aps.org"
  ) {
    const articleUrl = normalizeApsArticleUrl(url);
    const canonicalId = resolvePublisherCanonicalId({
      publisher: "aps",
      url: articleUrl
    });
    return {
      source: "aps",
      action: "authorized_download",
      articleUrl,
      ...(canonicalId ? { canonicalId } : {})
    };
  }

  return null;
}

function normalizeApsArticleUrl(url: URL): string {
  if (url.hostname !== "journals.aps.org") {
    return url.toString();
  }

  const doiResolverPathMatch = url.pathname.match(/^\/doi\/(?!pdf\/)(.+)$/i);
  if (doiResolverPathMatch?.[1]) {
    const normalizedUrl = new URL(url);
    normalizedUrl.hostname = "link.aps.org";
    normalizedUrl.pathname = `/doi/${canonicalizeApsDoi(decodeURIComponent(doiResolverPathMatch[1]))}`;
    normalizedUrl.search = "";
    normalizedUrl.hash = "";
    return normalizedUrl.toString();
  }

  const journalPathMatch = url.pathname.match(/^\/([^/]+)\/(abstract|pdf|accepted)\/(.+)$/i);
  if (!journalPathMatch?.[1] || !journalPathMatch[2] || !journalPathMatch[3]) {
    return url.toString();
  }

  const normalizedUrl = new URL(url);
  normalizedUrl.pathname = `/${journalPathMatch[1]}/${journalPathMatch[2]}/${canonicalizeApsDoi(decodeURIComponent(journalPathMatch[3]))}`;
  return normalizedUrl.toString();
}

function isApsAcceptedPaperUrl(articleUrl: string): boolean {
  try {
    const url = new URL(articleUrl);
    return url.hostname === "journals.aps.org" && /^\/[^/]+\/accepted\/10\.1103\/.+/i.test(url.pathname);
  } catch {
    return false;
  }
}

function extractHtmlTitle(html: string): string | undefined {
  const metaTitle = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:title|citation_title)["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ??
    html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:title|citation_title)["'][^>]*>/i)?.[1];
  const rawTitle = metaTitle ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!rawTitle) {
    return undefined;
  }

  const title = decodeHtmlEntities(rawTitle)
    .replace(/\s+/g, " ")
    .replace(/^Physical Review [^-]+ - Accepted Paper:\s*/i, "")
    .replace(/\s*\|\s*APS\s*$/i, "")
    .replace(/\s*\|\s*Science\s*$/i, "")
    .replace(/\s*\|\s*AAAS\s*$/i, "")
    .replace(/\s*\|\s*Nature\s*$/i, "")
    .replace(/\s*-\s*Nature\s*$/i, "")
    .trim();
  return title || undefined;
}

async function resolvePublisherFallbackTitle(options: {
  articleUrl: string;
  title?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  const providedTitle = options.title?.trim();
  if (providedTitle) {
    return formatTitle(providedTitle);
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(options.articleUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml"
      }
    });
    if (!response.ok) {
      return undefined;
    }

    return extractHtmlTitle(await response.text());
  } catch {
    return undefined;
  }
}

async function resolveApsAcceptedPaperTitle(options: {
  articleUrl: string;
  title?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  const providedTitle = options.title?.trim();
  if (providedTitle) {
    return providedTitle;
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(options.articleUrl);
    if (!response.ok) {
      return undefined;
    }
    const html = await response.text();
    if (!/accepted paper/i.test(html)) {
      return undefined;
    }
    return extractHtmlTitle(html);
  } catch {
    return undefined;
  }
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
    rank: SUPPORTED_SOURCE_PRIORITY[classification.source] - 0.5,
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

function formatExtensionBridgeFailure(error: unknown): string {
  if (error === undefined) {
    return "Paper extension bridge is not configured, and no direct PDF or exact-title open fallback was available.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return `Paper extension bridge failed: ${String(error)}`;
}

function toExtensionUnavailablePaperResult(input: {
  source: SupportedPaperSource | "external";
  articleUrl: string;
  failureCode?: string;
  error?: unknown;
}): PaperDownloadResult {
  return {
    status: "extension_unavailable",
    source: input.source,
    articleUrl: input.articleUrl,
    failure: {
      code: input.failureCode ?? "extension_unavailable",
      message: formatExtensionBridgeFailure(input.error)
    }
  };
}

function toBlockedPaperDownloadResult(
  lookup: PaperBlocklistLookup,
  entry: PaperBlocklistEntry
): PaperDownloadResult {
  return {
    status: "blocked",
    ...(lookup.source ? { source: lookup.source } : entry.source ? { source: entry.source } : {}),
    ...(lookup.canonicalId ? { canonicalId: lookup.canonicalId } : entry.canonicalId ? { canonicalId: entry.canonicalId } : {}),
    ...(lookup.articleUrl ? { articleUrl: lookup.articleUrl } : entry.articleUrl ? { articleUrl: entry.articleUrl } : {}),
    ...(lookup.paperKey ? { paperKey: lookup.paperKey } : entry.paperKey ? { paperKey: entry.paperKey } : {}),
    ...(lookup.title ? { title: lookup.title } : entry.title ? { title: entry.title } : {}),
    failure: {
      code: `blocked_${entry.reasonCode}`,
      message: entry.note
        ? `Paper download is blocked by the local blocklist: ${entry.note}`
        : `Paper download is blocked by the local blocklist (${entry.reasonCode}).`
    }
  };
}

async function findBlockedDownloadForLookup(options: {
  workspaceDir: string;
  lookup: PaperBlocklistLookup;
}): Promise<PaperDownloadResult | undefined> {
  const blocked = await findBlockedPaperDownload(options);
  return blocked ? toBlockedPaperDownloadResult(options.lookup, blocked) : undefined;
}

async function submitPaperExtensionJob(input: {
  bridge: PaperExtensionBridge;
  articleUrl: string;
  source: SupportedPaperSource | "external";
  title?: string;
  purpose?: "download" | "webpage" | "download_and_webpage";
}): Promise<PaperDownloadResult> {
  return input.bridge.submitJob(
    createPaperExtensionJob({
      articleUrl: input.articleUrl,
      source: input.source,
      ...(input.title ? { title: input.title } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {})
    })
  );
}

async function findPriorExtensionDownloadFailure(options: {
  workspaceDir: string;
  articleUrl: string;
  source: SupportedPaperSource | "external";
}): Promise<PaperFailure | null> {
  try {
    const matchingJob = summarizePaperDownloadJobs(
      await readPaperDownloadJobEvents({ workspaceDir: options.workspaceDir })
    ).find((job) =>
      job.articleUrl === options.articleUrl &&
      job.source === options.source &&
      job.status === "automatic_download_failed"
    );
    if (!matchingJob) {
      return null;
    }

    return {
      code: matchingJob.failureCode ?? "extension_download_failed",
      message: matchingJob.message ?? "The browser extension downloaded a file that was not a valid PDF."
    };
  } catch {
    return null;
  }
}

async function findPriorNonPdfPublisherArtifact(options: {
  workspaceDir: string;
  source: SupportedPaperSource;
  canonicalId?: string;
}): Promise<PaperFailure | null> {
  if (!options.canonicalId) {
    return null;
  }

  const pdfPath = resolvePaperPdfPath({
    workspaceDir: options.workspaceDir,
    source: options.source,
    canonicalId: options.canonicalId
  });
  const parsedPath = path.parse(pdfPath);
  const candidates = [
    path.join(parsedPath.dir, `${parsedPath.name}.htm`),
    path.join(parsedPath.dir, `${parsedPath.name}.html`)
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return {
        code: "non_pdf_download_artifact",
        message: `A previous publisher download produced a non-PDF file at ${candidate}.`
      };
    } catch {
      // Try the next candidate.
    }
  }

  return null;
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

function createRecentCloudflareBlockFailure(blockedAt: string): PaperFailure {
  return {
    code: "recent_cloudflare_block",
    message: `Skipping automatic APS download because Cloudflare blocked APS access at ${blockedAt}. Complete the opened page manually, or retry automatic download after the cooldown window.`
  };
}

function createPendingApsExtensionJobFailure(): PaperFailure {
  return {
    code: "aps_extension_job_pending",
    message:
      "Skipping automatic APS download because an APS browser extension job is already queued. Complete the opened APS page manually, or retry after the extension reports the first APS result."
  };
}

function toPendingApsExtensionJobResult(articleUrl: string): PaperDownloadResult {
  return {
    status: "extension_unavailable",
    source: "aps",
    articleUrl,
    failure: createPendingApsExtensionJobFailure()
  };
}

function toAlreadyDownloadedPaperResult(match: DownloadedPaperRecordMatch): PaperDownloadResult {
  if (match.record.source === "external") {
    return {
      status: "already_downloaded",
      source: "external",
      articleUrl: match.record.articleUrl,
      path: match.downloadPath,
      recordPath: match.recordPath,
      recordedAt: match.record.recordedAt,
      fileSha256: match.record.fileSha256,
      ...(match.record.pdfUrl ? { finalPdfUrl: match.record.pdfUrl } : {}),
      ...(match.record.title ? { title: match.record.title } : {})
    };
  }

  return {
    status: "already_downloaded",
    source: match.record.source,
    canonicalId: match.record.canonicalId,
    articleUrl: match.record.articleUrl,
    finalPdfUrl: match.record.pdfUrl,
    path: match.downloadPath,
    recordPath: match.recordPath,
    recordedAt: match.record.recordedAt
  };
}

function assertPdfBytes(pdfBytes: Buffer): void {
  if (!pdfBytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("Manual paper download must be a valid PDF.");
  }
}

function resolveDirectExternalPdfUrlCandidates(articleUrl: string): string[] {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(articleUrl);
  } catch {
    return [];
  }

  const candidates = new Set<string>();
  const normalizedUrl = new URL(parsedUrl);
  normalizedUrl.hash = "";

  const normalizedPath = normalizedUrl.pathname.replace(/\/+$/, "");
  if (
    normalizedPath.toLowerCase().endsWith(".pdf") ||
    normalizedPath.toLowerCase().endsWith("/pdf")
  ) {
    candidates.add(normalizedUrl.toString());
  }

  if (
    normalizedUrl.hostname === "quantum-journal.org" ||
    normalizedUrl.hostname === "www.quantum-journal.org"
  ) {
    const paperPathMatch = normalizedPath.match(/^\/papers\/q-\d{4}-\d{2}-\d{2}-\d+$/i);
    if (paperPathMatch) {
      const pdfUrl = new URL(normalizedUrl);
      pdfUrl.pathname = `${normalizedPath}/pdf/`;
      pdfUrl.search = "";
      candidates.add(pdfUrl.toString());
    }
  }

  return [...candidates];
}

async function tryDownloadDirectExternalPaper(options: {
  workspaceDir: string;
  classification: Extract<ClassifiedPaperUrl, { source: "external" }>;
  title?: string;
  fetchImpl?: typeof fetch;
}): Promise<PaperDownloadResult | null> {
  const pdfUrlCandidates = resolveDirectExternalPdfUrlCandidates(options.classification.articleUrl);
  if (pdfUrlCandidates.length === 0) {
    return null;
  }

  for (const pdfUrl of pdfUrlCandidates) {
    try {
      const response = await (options.fetchImpl ?? fetch)(pdfUrl, { redirect: "follow" });
      if (!response.ok) {
        continue;
      }

      const pdfBytes = Buffer.from(await response.arrayBuffer());
      assertPdfBytes(pdfBytes);

      const pdfPath = resolveExternalPaperPdfPath({
        workspaceDir: options.workspaceDir,
        articleUrl: options.classification.articleUrl
      });
      await mkdir(path.dirname(pdfPath), { recursive: true });
      await writeFile(pdfPath, pdfBytes);

      const fileSha256 = createHash("sha256").update(pdfBytes).digest("hex");
      const title = options.title?.trim();
      const recordPath = await writePaperRecord({
        workspaceDir: options.workspaceDir,
        record: {
          source: "external",
          articleUrl: options.classification.articleUrl,
          recordedAt: new Date().toISOString(),
          handlingMethod: "direct_http",
          status: "downloaded",
          pdfUrl,
          downloadPath: pdfPath,
          fileSha256,
          ...(title ? { title } : {})
        }
      });

      return {
        status: "downloaded",
        source: "external",
        articleUrl: options.classification.articleUrl,
        finalPdfUrl: pdfUrl,
        path: pdfPath,
        recordPath,
        fileSha256,
        ...(title ? { title } : {})
      };
    } catch {
      // Try the next deterministic candidate before falling back to browser/manual handling.
    }
  }

  return null;
}

function resolveDirectPublisherPdfUrl(
  classification: Extract<ClassifiedPaperUrl, { source: SupportedPaperSource }>
): string | undefined {
  const directArticleUrl = new URL(classification.articleUrl);
  if (directArticleUrl.pathname.toLowerCase().endsWith(".pdf")) {
    directArticleUrl.search = "";
    directArticleUrl.hash = "";
    return directArticleUrl.toString();
  }

  if (classification.source !== "aps") {
    return undefined;
  }

  const articleUrl = new URL(classification.articleUrl);
  const doiPdfPathMatch = articleUrl.pathname.match(/^\/doi\/pdf\/(.+)$/i);
  if (doiPdfPathMatch?.[1]) {
    articleUrl.search = "";
    articleUrl.hash = "";
    return articleUrl.toString();
  }

  const doiPathMatch = articleUrl.pathname.match(/^\/doi\/(.+)$/i);
  if (doiPathMatch?.[1]) {
    articleUrl.pathname = `/doi/pdf/${doiPathMatch[1]}`;
    articleUrl.search = "";
    articleUrl.hash = "";
    return articleUrl.toString();
  }

  const pdfPathMatch = articleUrl.pathname.match(/^\/([^/]+)\/pdf\/(.+)$/i);
  if (pdfPathMatch) {
    articleUrl.search = "";
    articleUrl.hash = "";
    return articleUrl.toString();
  }

  const abstractPathMatch = articleUrl.pathname.match(/^\/([^/]+)\/abstract\/(.+)$/i);
  if (!abstractPathMatch?.[1] || !abstractPathMatch[2]) {
    return undefined;
  }

  articleUrl.pathname = `/${abstractPathMatch[1]}/pdf/${abstractPathMatch[2]}`;
  articleUrl.search = "";
  articleUrl.hash = "";
  return articleUrl.toString();
}

function isDirectPublisherPdfUrl(
  classification: Extract<ClassifiedPaperUrl, { source: SupportedPaperSource }>
): boolean {
  try {
    const parsedUrl = new URL(classification.articleUrl);
    return parsedUrl.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

async function tryDownloadDirectSupportedPublisherPaper(options: {
  workspaceDir: string;
  classification: Extract<ClassifiedPaperUrl, { source: SupportedPaperSource }>;
  fetchImpl?: typeof fetch;
}): Promise<PaperDownloadResult | null> {
  const pdfUrl = resolveDirectPublisherPdfUrl(options.classification);
  if (!pdfUrl) {
    return null;
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(pdfUrl);
    if (!response.ok) {
      return null;
    }

    const pdfBytes = Buffer.from(await response.arrayBuffer());
    assertPdfBytes(pdfBytes);

    const canonicalId =
      options.classification.canonicalId ??
      resolvePublisherCanonicalId({
        publisher: options.classification.source,
        url: pdfUrl
      });
    if (!canonicalId) {
      return null;
    }

    const pdfPath = resolvePaperPdfPath({
      workspaceDir: options.workspaceDir,
      source: options.classification.source,
      canonicalId
    });
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, pdfBytes);

    const recordPath = await writePaperRecord({
      workspaceDir: options.workspaceDir,
      record: {
        source: options.classification.source,
        articleUrl: options.classification.articleUrl,
        recordedAt: new Date().toISOString(),
        handlingMethod: "direct_http",
        status: "downloaded",
        canonicalId,
        pdfUrl,
        downloadPath: pdfPath
      }
    });

    return {
      status: "downloaded",
      source: options.classification.source,
      canonicalId,
      articleUrl: options.classification.articleUrl,
      finalPdfUrl: pdfUrl,
      path: pdfPath,
      recordPath
    };
  } catch {
    return null;
  }
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
  const locator = parseArxivLocator(options.input);
  const existingDownload = await findDownloadedPaperRecord({
    workspaceDir: options.workspaceDir,
    source: "arxiv",
    canonicalId: locator.id,
    articleUrl: locator.absUrl
  });
  if (existingDownload) {
    return toAlreadyDownloadedPaperResult(existingDownload);
  }

  const result = await downloadArxivPdf({
    input: locator.id,
    fetchImpl: options.fetchImpl
  });
  const pdfPath = resolvePaperPdfPath({
    workspaceDir: options.workspaceDir,
    source: "arxiv",
    canonicalId: result.canonicalId
  });

  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, result.pdfBytes);
  if (options.fetchImpl === undefined) {
    await tryDownloadArxivTexSource({
      workspaceDir: options.workspaceDir,
      canonicalId: result.canonicalId
    });
  }

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

async function tryDownloadArxivTexSource(options: {
  workspaceDir: string;
  canonicalId: string;
}): Promise<void> {
  const sourceUrl = `https://arxiv.org/e-print/${options.canonicalId}`;
  try {
    const response = await fetch(sourceUrl, {
      headers: {
        "user-agent": "pi-agent-minimal-ts/arxiv-source"
      }
    });
    if (!response.ok) {
      return;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      return;
    }

    const sourceDir = path.join(
      resolvePaperLibraryPaths(options.workspaceDir).rawRoot,
      "arxiv-sources",
      options.canonicalId
    );
    await mkdir(sourceDir, { recursive: true });
    const archivePath = path.join(sourceDir, "source.tar");
    await writeFile(archivePath, bytes);
    await execFileAsync("tar", ["-xzf", archivePath, "-C", sourceDir], {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024
    }).catch(() => undefined);
  } catch {
    // TeX source is an enhancement path; PDF download remains the durable baseline.
  }
}

async function tryDownloadArxivPreprintByTitle(options: {
  workspaceDir: string;
  title?: string;
  fetchImpl?: typeof fetch;
  searchArxivImpl?: typeof searchArxiv;
}): Promise<PaperDownloadResult | null> {
  const title = options.title?.trim();
  if (!title) {
    return null;
  }

  const titleKey = normalizeTitle(title);
  const compactTitleKey = getCompactTitleKey(title);
  const localPapers = await listLocalPapers({
    workspaceDir: options.workspaceDir,
    status: "downloaded",
    maxResults: Number.MAX_SAFE_INTEGER
  }).catch(() => undefined);
  const localMatch = localPapers?.results.find((paper) =>
    paper.source === "arxiv" &&
    paper.canonicalId &&
    paper.title &&
    (normalizeTitle(paper.title) === titleKey || getCompactTitleKey(paper.title) === compactTitleKey)
  );
  if (localMatch?.canonicalId) {
    try {
      return await downloadArxivPaper({
        workspaceDir: options.workspaceDir,
        input: localMatch.canonicalId,
        fetchImpl: options.fetchImpl
      });
    } catch {
      // Continue to live arXiv search below.
    }
  }

  const searchArxivImpl = options.searchArxivImpl ?? searchArxiv;
  let results: ArxivSearchResult[];
  try {
    results = await searchArxivImpl({ query: title, maxResults: 5 });
  } catch {
    return null;
  }

  const match = results.find((result) => {
    const resultTitleKey = normalizeTitle(result.title);
    return resultTitleKey === titleKey || resultTitleKey.replace(/\s+/g, "") === compactTitleKey;
  });
  if (!match) {
    return null;
  }

  try {
    return await downloadArxivPaper({
      workspaceDir: options.workspaceDir,
      input: match.id,
      fetchImpl: options.fetchImpl
    });
  } catch {
    return null;
  }
}

function createPublisherPreprintFallbackFailure(arxivId: string): PaperFailure {
  return {
    code: "publisher_version_not_available",
    message:
      `Publisher PDF was not downloaded automatically; using matching arXiv preprint ${arxivId}.`
  };
}

function createPublisherPendingFailure(): PaperFailure {
  return {
    code: "publisher_version_not_available",
    message:
      "Publisher page is an accepted paper without a formal PDF yet, and no exact-title arXiv preprint was found."
  };
}

async function writePublisherPendingRecord(options: {
  workspaceDir: string;
  classification: Extract<ClassifiedPaperUrl, { source: SupportedPaperSource }>;
  title?: string;
}): Promise<PaperDownloadResult> {
  const canonicalId = resolveFallbackCanonicalId({
    articleUrl: options.classification.articleUrl,
    canonicalId: options.classification.canonicalId
  });
  const failure = createPublisherPendingFailure();
  const recordPath = await writePaperRecord({
    workspaceDir: options.workspaceDir,
    record: {
      source: options.classification.source,
      articleUrl: options.classification.articleUrl,
      recordedAt: new Date().toISOString(),
      handlingMethod: "accepted_paper",
      status: "publisher_pending",
      canonicalId,
      ...(options.title ? { title: options.title } : {}),
      failure
    }
  });

  return {
    status: "publisher_pending",
    source: options.classification.source,
    canonicalId,
    articleUrl: options.classification.articleUrl,
    recordPath,
    failure,
    ...(options.title ? { title: options.title } : {})
  };
}

async function writePublisherPreprintFallbackRecord(options: {
  workspaceDir: string;
  classification: Extract<ClassifiedPaperUrl, { source: SupportedPaperSource }>;
  title?: string;
  arxivResult: ArxivDownloadedPaperResult;
}): Promise<PublisherPreprintFallbackResult> {
  const canonicalId = resolveFallbackCanonicalId({
    articleUrl: options.classification.articleUrl,
    canonicalId: options.classification.canonicalId
  });
  const reason =
    `Publisher PDF was not downloaded automatically; using matching arXiv preprint ${options.arxivResult.canonicalId}.`;
  const recordPath = await writePaperRecord({
    workspaceDir: options.workspaceDir,
    record: {
      source: options.classification.source,
      articleUrl: options.classification.articleUrl,
      recordedAt: new Date().toISOString(),
      handlingMethod: "arxiv_preprint_fallback",
      status: "preprint_fallback",
      canonicalId,
      ...(options.title ? { title: options.title } : {}),
      preprint: {
        source: "arxiv",
        canonicalId: options.arxivResult.canonicalId,
        articleUrl: options.arxivResult.articleUrl,
        pdfUrl: options.arxivResult.finalPdfUrl,
        recordPath: options.arxivResult.recordPath,
        downloadPath: options.arxivResult.path,
        status: options.arxivResult.status
      },
      failure: createPublisherPreprintFallbackFailure(options.arxivResult.canonicalId)
    }
  });

  return {
    source: options.classification.source,
    canonicalId,
    articleUrl: options.classification.articleUrl,
    recordPath,
    reason,
    ...(options.title ? { title: options.title } : {})
  };
}

async function tryDownloadArxivPreprintForPublisherFallback(options: {
  workspaceDir: string;
  classification: Extract<ClassifiedPaperUrl, { source: SupportedPaperSource }>;
  title?: string;
  fetchImpl?: typeof fetch;
  searchArxivImpl?: typeof searchArxiv;
}): Promise<PaperDownloadResult | null> {
  const arxivResult = await tryDownloadArxivPreprintByTitle({
    workspaceDir: options.workspaceDir,
    title: options.title,
    fetchImpl: options.fetchImpl,
    searchArxivImpl: options.searchArxivImpl
  });
  if (
    !arxivResult ||
    arxivResult.source !== "arxiv" ||
    (arxivResult.status !== "downloaded" && arxivResult.status !== "already_downloaded")
  ) {
    return null;
  }

  const arxivDownloadedResult = arxivResult as ArxivDownloadedPaperResult;
  const publisherFallback = await writePublisherPreprintFallbackRecord({
    workspaceDir: options.workspaceDir,
    classification: options.classification,
    title: options.title,
    arxivResult: arxivDownloadedResult
  });

  return {
    ...arxivDownloadedResult,
    publisherFallback
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
    const locator = parseArxivLocator(options.id);
    const blocked = await findBlockedDownloadForLookup({
      workspaceDir: options.workspaceDir,
      lookup: {
        source: "arxiv",
        canonicalId: locator.id,
        articleUrl: locator.absUrl,
        paperKey: derivePaperKeyForBlocklist({ source: "arxiv", canonicalId: locator.id }),
        ...(options.title ? { title: options.title } : {})
      }
    });
    if (blocked) {
      return blocked;
    }

    return downloadArxivPaper({
      workspaceDir: options.workspaceDir,
      input: locator.id,
      fetchImpl: options.fetchImpl
    });
  }

  const paperUrl = options.url as string;
  const classification = classifyPaperUrl(paperUrl);
  const blocked = await findBlockedDownloadForLookup({
    workspaceDir: options.workspaceDir,
    lookup: {
      source: classification.source,
      ...("canonicalId" in classification && classification.canonicalId
        ? { canonicalId: classification.canonicalId }
        : {}),
      articleUrl: classification.articleUrl,
      ...("canonicalId" in classification && classification.canonicalId
        ? {
            paperKey: derivePaperKeyForBlocklist({
              source: classification.source,
              canonicalId: classification.canonicalId
            })
          }
        : {}),
      ...(options.title ? { title: options.title } : {})
    }
  });
  if (blocked) {
    return blocked;
  }
  let publisherFallbackTitleResolved = false;
  let publisherFallbackTitle: string | undefined;

  if (classification.source === "arxiv") {
    return downloadArxivPaper({
      workspaceDir: options.workspaceDir,
      input: classification.canonicalId,
      fetchImpl: options.fetchImpl
    });
  }

  if (classification.source === "external") {
    const existingDownload = await findDownloadedPaperRecord({
      workspaceDir: options.workspaceDir,
      source: "external",
      articleUrl: classification.articleUrl
    });
    if (existingDownload) {
      return toAlreadyDownloadedPaperResult(existingDownload);
    }

    const directExternalDownload = await tryDownloadDirectExternalPaper({
      workspaceDir: options.workspaceDir,
      classification,
      title: options.title,
      fetchImpl: options.fetchImpl
    });
    if (directExternalDownload) {
      return directExternalDownload;
    }

    if (options.extensionBridge) {
      try {
        return await submitPaperExtensionJob({
          bridge: options.extensionBridge,
          articleUrl: classification.articleUrl,
          source: "external",
          title: options.title
        });
      } catch (error) {
        if (options.usePlaywrightFallback !== true) {
          return toExtensionUnavailablePaperResult({
            source: "external",
            articleUrl: classification.articleUrl,
            error
          });
        }
      }
    } else if (options.usePlaywrightFallback !== true) {
      return toExtensionUnavailablePaperResult({
        source: "external",
        articleUrl: classification.articleUrl
      });
    }

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

  const getPublisherFallbackTitle = async (): Promise<string | undefined> => {
    if (!publisherFallbackTitleResolved) {
      publisherFallbackTitleResolved = true;
      publisherFallbackTitle = await resolvePublisherFallbackTitle({
        articleUrl: classification.articleUrl,
        title: options.title,
        fetchImpl: options.fetchImpl
      });
    }

    return publisherFallbackTitle;
  };

  if (classification.canonicalId) {
    const existingDownload = await findDownloadedPaperRecord({
      workspaceDir: options.workspaceDir,
      source: classification.source,
      canonicalId: classification.canonicalId,
      articleUrl: classification.articleUrl
    });
    if (existingDownload) {
      return toAlreadyDownloadedPaperResult(existingDownload);
    }
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

  if (isDirectPublisherPdfUrl(classification)) {
    const directPublisherDownload = await tryDownloadDirectSupportedPublisherPaper({
      workspaceDir: options.workspaceDir,
      classification,
      fetchImpl: options.fetchImpl
    });
    if (directPublisherDownload) {
      return directPublisherDownload;
    }
  }

  if (classification.source === "aps" && isApsAcceptedPaperUrl(classification.articleUrl)) {
    const acceptedPaperTitle = await resolveApsAcceptedPaperTitle({
      articleUrl: classification.articleUrl,
      title: options.title,
      fetchImpl: options.fetchImpl
    });
    publisherFallbackTitleResolved = true;
    publisherFallbackTitle = acceptedPaperTitle;
    const arxivFallback = await tryDownloadArxivPreprintForPublisherFallback({
      workspaceDir: options.workspaceDir,
      classification,
      title: acceptedPaperTitle,
      fetchImpl: options.fetchImpl,
      searchArxivImpl: options.searchArxivImpl
    });
    if (arxivFallback) {
      return arxivFallback;
    }
    return writePublisherPendingRecord({
      workspaceDir: options.workspaceDir,
      classification,
      title: acceptedPaperTitle
    });
  }

  const priorNonPdfArtifact = await findPriorNonPdfPublisherArtifact({
    workspaceDir: options.workspaceDir,
    source: classification.source,
    canonicalId: classification.canonicalId
  });
  if (priorNonPdfArtifact) {
    const arxivFallback = await tryDownloadArxivPreprintForPublisherFallback({
      workspaceDir: options.workspaceDir,
      classification,
      title: await getPublisherFallbackTitle(),
      fetchImpl: options.fetchImpl,
      searchArxivImpl: options.searchArxivImpl
    });
    if (arxivFallback) {
      return arxivFallback;
    }

    return toExtensionUnavailablePaperResult({
      source: classification.source,
      articleUrl: classification.articleUrl,
      error: priorNonPdfArtifact.message
    });
  }

  const priorExtensionFailure = await findPriorExtensionDownloadFailure({
    workspaceDir: options.workspaceDir,
    articleUrl: classification.articleUrl,
    source: classification.source
  });
  if (priorExtensionFailure) {
    const arxivFallback = await tryDownloadArxivPreprintForPublisherFallback({
      workspaceDir: options.workspaceDir,
      classification,
      title: await getPublisherFallbackTitle(),
      fetchImpl: options.fetchImpl,
      searchArxivImpl: options.searchArxivImpl
    });
    if (arxivFallback) {
      return arxivFallback;
    }

    return toExtensionUnavailablePaperResult({
      source: classification.source,
      articleUrl: classification.articleUrl,
      failureCode: priorExtensionFailure.code,
      error: priorExtensionFailure.message
    });
  }

  if (options.extensionBridge) {
    try {
      return await submitPaperExtensionJob({
        bridge: options.extensionBridge,
        articleUrl: classification.articleUrl,
        source: classification.source,
        title: options.title,
        purpose: "download_and_webpage"
      });
    } catch (error) {
      if (options.usePlaywrightFallback !== true) {
        const arxivFallback = await tryDownloadArxivPreprintForPublisherFallback({
          workspaceDir: options.workspaceDir,
          classification,
          title: await getPublisherFallbackTitle(),
          fetchImpl: options.fetchImpl,
          searchArxivImpl: options.searchArxivImpl
        });
        if (arxivFallback) {
          return arxivFallback;
        }

        return toExtensionUnavailablePaperResult({
          source: classification.source,
          articleUrl: classification.articleUrl,
          error
        });
      }
    }
  } else if (options.usePlaywrightFallback !== true) {
    const arxivFallback = await tryDownloadArxivPreprintForPublisherFallback({
      workspaceDir: options.workspaceDir,
      classification,
      title: await getPublisherFallbackTitle(),
      fetchImpl: options.fetchImpl,
      searchArxivImpl: options.searchArxivImpl
    });
    if (arxivFallback) {
      return arxivFallback;
    }

    return toExtensionUnavailablePaperResult({
      source: classification.source,
      articleUrl: classification.articleUrl
    });
  }

  const directPublisherDownload = await tryDownloadDirectSupportedPublisherPaper({
    workspaceDir: options.workspaceDir,
    classification,
    fetchImpl: options.fetchImpl
  });
  if (directPublisherDownload) {
    return directPublisherDownload;
  }

  const arxivFallback = await tryDownloadArxivPreprintForPublisherFallback({
    workspaceDir: options.workspaceDir,
    classification,
    title: await getPublisherFallbackTitle(),
    fetchImpl: options.fetchImpl,
    searchArxivImpl: options.searchArxivImpl
  });
  if (arxivFallback) {
    return arxivFallback;
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

    const arxivFallback = await tryDownloadArxivPreprintForPublisherFallback({
      workspaceDir: options.workspaceDir,
      classification,
      title: await getPublisherFallbackTitle(),
      fetchImpl: options.fetchImpl,
      searchArxivImpl: options.searchArxivImpl
    });
    if (arxivFallback) {
      return arxivFallback;
    }

    return openSupportedPublisherForManualFallback({
      workspaceDir: options.workspaceDir,
      classification,
      failure: toPaperFailure(error),
      openPublisherForLoginImpl
    });
  }
}

export async function registerManualPaperDownload(
  options: RegisterManualPaperDownloadOptions
): Promise<RegisteredManualPaperDownloadResult> {
  const classification = classifyPaperUrl(options.url);
  if (classification.source !== "external") {
    throw new Error("registerManualPaperDownload only accepts external URLs.");
  }

  const pdfBytes = await readFile(options.pdfPath);
  assertPdfBytes(pdfBytes);

  const pdfPath = resolveExternalPaperPdfPath({
    workspaceDir: options.workspaceDir,
    articleUrl: classification.articleUrl
  });
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, pdfBytes);

  const fileSha256 = createHash("sha256").update(pdfBytes).digest("hex");
  const previousRecord = await readPaperRecord({
    workspaceDir: options.workspaceDir,
    source: "external",
    articleUrl: classification.articleUrl
  });
  const previousOpenedUrl =
    previousRecord?.record.source === "external" && "openedUrl" in previousRecord.record
      ? previousRecord.record.openedUrl
      : undefined;
  const recordPath = await writePaperRecord({
    workspaceDir: options.workspaceDir,
    record: {
      source: "external",
      articleUrl: classification.articleUrl,
      ...(previousOpenedUrl ? { openedUrl: previousOpenedUrl } : {}),
      recordedAt: (options.now ?? (() => new Date()))().toISOString(),
      handlingMethod: "manual_file_import",
      status: "downloaded",
      downloadPath: pdfPath,
      fileSha256,
      ...(options.title?.trim() ? { title: options.title.trim() } : {})
    }
  });

  return {
    status: "downloaded",
    source: "external",
    articleUrl: classification.articleUrl,
    path: pdfPath,
    recordPath,
    fileSha256,
    ...(options.title?.trim() ? { title: options.title.trim() } : {})
  };
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
  let forceManualOpenFailure = recentCloudflareBlockAt
    ? createRecentCloudflareBlockFailure(recentCloudflareBlockAt)
    : undefined;
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

    const download =
      forceManualOpenFailure?.code === "aps_extension_job_pending"
        ? toPendingApsExtensionJobResult(apsSource.articleUrl)
        : await downloadPaperImpl({
            workspaceDir: options.workspaceDir,
            url: apsSource.articleUrl,
            title: paper.title,
            ...(forceManualOpenFailure ? { forceManualOpen: forceManualOpenFailure } : {})
          });
    if (!forceManualOpenFailure && isLikelyCloudflareFallback(download)) {
      recentCloudflareBlockAt = now().toISOString();
      forceManualOpenFailure = createRecentCloudflareBlockFailure(recentCloudflareBlockAt);
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
    if (
      !forceManualOpenFailure &&
      download.status === "extension_job_queued" &&
      download.source === "aps"
    ) {
      forceManualOpenFailure = createPendingApsExtensionJobFailure();
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
  const searchApsPapersImpl = options.searchApsPapersImpl ?? searchApsPapers;
  const searchWebImpl = options.searchWebImpl ?? searchWeb;
  const query = options.query.trim();
  if (!query) {
    throw new Error("Query is required.");
  }

  const maxResults = options.maxResults ?? 5;
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error("maxResults must be a positive integer.");
  }

  const [arxivResults, apsResults, webResults] = await Promise.all([
    searchArxivImpl({ query, maxResults }).catch(() => []),
    searchApsPapersImpl({ query, maxResults }).catch(() => []),
    searchWebImpl({ query, maxResults }).catch(() => [])
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

  for (const result of apsResults) {
    for (const source of result.sources) {
      addCandidate(candidates, {
        title: result.title,
        authors: result.authors,
        summary: result.summary,
        order,
        source: rankPaperSearchSource(source, order)
      });
    }
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
