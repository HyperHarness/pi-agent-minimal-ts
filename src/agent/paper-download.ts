import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getPublisherAdapter } from "./publisher-adapters/index.js";
import { PaperBrowserSessionError, type PaperBrowserSession } from "./browser-session.js";

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

function resolveFallbackPdfPath(input: {
  publisherId: "science" | "nature" | "aps";
  finalArticleUrl: string;
}): string | null {
  if (input.publisherId !== "aps") {
    return null;
  }

  const match = new URL(input.finalArticleUrl).pathname.match(/^\/([^/]+)\/abstract\/(.+)$/i);
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
  const outputDir = path.join(options.workspaceDir, "downloads", "papers");
  try {
    await mkdir(outputDir, { recursive: true });
  } catch (error) {
    throw new PaperDownloadError(
      "download_failed",
      error instanceof Error ? error.message : "Failed to prepare the download destination."
    );
  }
  const outputPath = path.join(outputDir, "downloaded-paper.pdf");
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
