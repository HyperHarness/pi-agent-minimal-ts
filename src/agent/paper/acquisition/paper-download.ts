import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getPublisherAdapter } from "./publisher-adapters/index.js";
import { PaperBrowserSessionError, type PaperBrowserSession } from "../browser/browser-session.js";
import { resolvePaperLibraryPaths } from "../../knowledge-base.js";
import type { SupportedPaperSource } from "../types.js";

export class PaperDownloadError extends Error {
  constructor(
    readonly code:
      | "unsupported_publisher"
      | "browser_session_unavailable"
      | "manual_login_required"
      | "authorization_failed"
      | "pdf_not_found"
      | "download_failed",
    message: string
  ) {
    super(message);
    this.name = "PaperDownloadError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function sanitizeFilenameComponent(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "");
}

function decodePublisherPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractNatureArticleId(urlString: string): string | null {
  const match = new URL(urlString).pathname.match(/^\/articles\/([^/?#]+?)(?:_reference)?(?:\.pdf)?$/i);
  return match?.[1] ? decodePublisherPathSegment(match[1]) : null;
}

function extractScienceDoi(urlString: string): string | null {
  const match = new URL(urlString).pathname.match(/^\/doi\/(?:(?:pdf|full|abs|epdf)\/)?(.+)$/i);
  return match?.[1] ? decodePublisherPathSegment(match[1]).replace(/\.pdf$/i, "") : null;
}

const APS_CANONICAL_DOI_PREFIXES = new Map<string, string>([
  ["physreva", "PhysRevA"],
  ["physrevb", "PhysRevB"],
  ["physrevc", "PhysRevC"],
  ["physrevd", "PhysRevD"],
  ["physreve", "PhysRevE"],
  ["physrevlett", "PhysRevLett"],
  ["physrevapplied", "PhysRevApplied"],
  ["physrevresearch", "PhysRevResearch"],
  ["physrevmaterials", "PhysRevMaterials"],
  ["physrevfluids", "PhysRevFluids"],
  ["physrevx", "PhysRevX"],
  ["prxquantum", "PRXQuantum"],
  ["revmodphys", "RevModPhys"]
]);

export function canonicalizeApsDoi(doi: string): string {
  const trimmed = doi.trim();
  const match = trimmed.match(/^10\.1103\/([^.\/]+)(\..+)$/i);
  if (!match?.[1] || !match[2]) {
    return trimmed;
  }

  const canonicalPrefix = APS_CANONICAL_DOI_PREFIXES.get(match[1].toLowerCase());
  return canonicalPrefix ? `10.1103/${canonicalPrefix}${match[2]}` : trimmed;
}

function extractApsDoi(urlString: string): string | null {
  const path = new URL(urlString).pathname;
  const directDoiMatch = path.match(/^\/doi\/(?:pdf\/)?(.+)$/i);
  if (directDoiMatch?.[1]) {
    return canonicalizeApsDoi(decodePublisherPathSegment(directDoiMatch[1]).replace(/\.pdf$/i, ""));
  }

  const journalMatch = path.match(/^\/[^/]+\/(?:abstract|pdf|accepted)\/(.+)$/i);
  return journalMatch?.[1]
    ? canonicalizeApsDoi(decodePublisherPathSegment(journalMatch[1]).replace(/\.pdf$/i, ""))
    : null;
}

export function resolvePublisherCanonicalId(options: {
  publisher: SupportedPaperSource;
  url: string;
}): string | null {
  if (options.publisher === "nature") {
    return extractNatureArticleId(options.url);
  }

  if (options.publisher === "science") {
    return extractScienceDoi(options.url);
  }

  return extractApsDoi(options.url);
}

export function resolvePublisherCanonicalIdFromArticleUrl(options: {
  publisher: SupportedPaperSource;
  articleUrl: string;
}): string | null {
  return resolvePublisherCanonicalId({
    publisher: options.publisher,
    url: options.articleUrl
  });
}

function resolveFormattedPaperFilename(input: {
  publisherId: "science" | "nature" | "aps";
  finalArticleUrl: string;
  finalPdfUrl: string;
}): string | null {
  const identifier =
    input.publisherId === "nature"
      ? extractNatureArticleId(input.finalArticleUrl) ?? extractNatureArticleId(input.finalPdfUrl)
      : input.publisherId === "science"
        ? extractScienceDoi(input.finalArticleUrl) ?? extractScienceDoi(input.finalPdfUrl)
        : extractApsDoi(input.finalArticleUrl) ?? extractApsDoi(input.finalPdfUrl);
  const sanitizedIdentifier = identifier ? sanitizeFilenameComponent(identifier) : "";
  if (!sanitizedIdentifier) {
    return null;
  }

  return `${input.publisherId}-${sanitizedIdentifier}.pdf`;
}

function resolveOriginalPdfFilename(finalPdfUrl: string): string | null {
  const parsedUrl = new URL(finalPdfUrl);
  const rawBasename = path.posix.basename(parsedUrl.pathname);
  if (!rawBasename) {
    return null;
  }

  const sanitizedBasename = sanitizeFilenameComponent(decodeURIComponent(rawBasename));
  return sanitizedBasename.toLowerCase().endsWith(".pdf") ? sanitizedBasename : null;
}

function resolveFallbackPdfPath(input: {
  publisherId: "science" | "nature" | "aps";
  finalArticleUrl: string;
}): string | null {
  if (input.publisherId === "science") {
    const doi = extractScienceDoi(input.finalArticleUrl);
    return doi ? `/doi/pdf/${doi}?download=true` : null;
  }

  if (input.publisherId !== "aps") {
    return null;
  }

  const finalArticleUrl = new URL(input.finalArticleUrl);
  const doiMatch = finalArticleUrl.pathname.match(/^\/doi\/(?:pdf\/)?(.+)$/i);
  if (doiMatch?.[1]) {
    return `/doi/pdf/${doiMatch[1]}`;
  }

  const match = finalArticleUrl.pathname.match(/^\/([^/]+)\/abstract\/(.+)$/i);
  if (!match) {
    return null;
  }

  const [, journalSlug, doi] = match;
  return `/${journalSlug}/pdf/${doi}`;
}

export async function downloadPaperPdf(options: {
  workspaceDir: string;
  url: string;
  browserSession: PaperBrowserSession;
}) {
  let adapter;
  try {
    adapter = getPublisherAdapter(options.url);
  } catch (error) {
    throw new PaperDownloadError(
      "unsupported_publisher",
      error instanceof Error ? error.message : "Unsupported publisher."
    );
  }

  let articlePage;
  try {
    articlePage = await options.browserSession.openArticlePage(options.url);
  } catch (error) {
    if (error instanceof PaperBrowserSessionError) {
      throw new PaperDownloadError(error.code, error.message);
    }

    throw new PaperDownloadError(
      "browser_session_unavailable",
      error instanceof Error ? error.message : "Unable to open the article page."
    );
  }

  if (!articlePage.authorized) {
    throw new PaperDownloadError(
      "manual_login_required",
      "The browser session needs manual login or verification for this publisher."
    );
  }

  const pdfPath =
    adapter.resolvePdfPathFromHtml(articlePage.html) ??
    resolveFallbackPdfPath({
      publisherId: adapter.id,
      finalArticleUrl: articlePage.finalArticleUrl
    });
  if (!pdfPath) {
    throw new PaperDownloadError(
      "pdf_not_found",
      "pdf_not_found: The article page loaded but no PDF link was found."
    );
  }

  const finalPdfUrl = new URL(pdfPath, articlePage.finalArticleUrl).toString();
  const outputFilename =
    resolveFormattedPaperFilename({
      publisherId: adapter.id,
      finalArticleUrl: articlePage.finalArticleUrl,
      finalPdfUrl
    }) ??
    resolveOriginalPdfFilename(finalPdfUrl) ??
    "downloaded-paper.pdf";
  const outputDir = resolvePaperLibraryPaths(options.workspaceDir).rawPdfRoot;
  try {
    await mkdir(outputDir, { recursive: true });
  } catch (error) {
    throw new PaperDownloadError(
      "download_failed",
      error instanceof Error ? error.message : "Failed to prepare the download destination."
    );
  }
  const outputPath = path.join(outputDir, outputFilename);
  try {
    await options.browserSession.downloadPdf(finalPdfUrl, outputPath);
  } catch (error) {
    if (error instanceof PaperBrowserSessionError) {
      throw new PaperDownloadError(
        error.code === "authorization_failed" ? "manual_login_required" : error.code,
        error.message
      );
    }

    throw new PaperDownloadError(
      "download_failed",
      error instanceof Error ? error.message : "Failed to download the PDF."
    );
  }

  return {
    path: outputPath,
    publisher: adapter.id,
    articleUrl: options.url,
    finalArticleUrl: articlePage.finalArticleUrl,
    finalPdfUrl
  };
}

export async function downloadPublisherPaper(options: {
  workspaceDir: string;
  url: string;
  browserSession: PaperBrowserSession;
}) {
  const result = await downloadPaperPdf(options);
  const canonicalId =
    resolvePublisherCanonicalIdFromArticleUrl({
      publisher: result.publisher,
      articleUrl: result.finalArticleUrl
    }) ??
    resolvePublisherCanonicalId({
      publisher: result.publisher,
      url: result.finalPdfUrl
    }) ??
    resolvePublisherCanonicalId({
      publisher: result.publisher,
      url: options.url
    });

  if (!canonicalId) {
    throw new PaperDownloadError(
      "download_failed",
      "Unable to resolve a canonical paper identifier from the publisher article URL."
    );
  }

  return {
    ...result,
    canonicalId
  };
}
