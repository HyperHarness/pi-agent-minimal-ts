import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getPublisherAdapter } from "./publisher-adapters/index.js";
import type { PaperBrowserSession } from "./browser-session.js";

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
  }
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

  const articlePage = await options.browserSession.openArticlePage(options.url);

  if (!articlePage.authorized) {
    throw new PaperDownloadError(
      "manual_login_required",
      "The browser session is not authorized for this publisher."
    );
  }

  const pdfPath = adapter.resolvePdfPathFromHtml(articlePage.html);
  if (!pdfPath) {
    throw new PaperDownloadError(
      "pdf_not_found",
      "pdf_not_found: The article page loaded but no PDF link was found."
    );
  }

  const finalPdfUrl = new URL(pdfPath, articlePage.finalArticleUrl).toString();
  const outputDir = path.join(options.workspaceDir, "downloads", "papers");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "downloaded-paper.pdf");
  await options.browserSession.downloadPdf(finalPdfUrl, outputPath);

  return {
    path: outputPath,
    publisher: adapter.id,
    articleUrl: options.url,
    finalArticleUrl: articlePage.finalArticleUrl,
    finalPdfUrl
  };
}
