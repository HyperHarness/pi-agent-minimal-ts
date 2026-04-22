import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PaperBrowserSessionError } from "../../src/agent/browser-session.js";
import { PaperDownloadError, downloadPaperPdf } from "../../src/agent/paper-download.js";

function assertPaperDownloadError(error: unknown): asserts error is PaperDownloadError {
  assert.ok(error instanceof PaperDownloadError);
}

async function captureRejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  assert.fail("Expected promise to reject.");
}

test("downloadPaperPdf rejects unsupported publishers before launching the browser", async () => {
  const error = await captureRejection(() =>
    downloadPaperPdf({
      workspaceDir: process.cwd(),
      url: "https://example.com/paper",
      browserSession: {} as never
    })
  );

  assertPaperDownloadError(error);
  assert.equal(error.code, "unsupported_publisher");
  assert.match(error.message, /Unsupported publisher/i);
});

test("downloadPaperPdf classifies a missing PDF path as pdf_not_found", async () => {
  const error = await captureRejection(() =>
    downloadPaperPdf({
      workspaceDir: process.cwd(),
      url: "https://www.science.org/doi/10.1126/science.adz8659",
      browserSession: {
        openArticlePage: async () => ({
          finalArticleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
          html: "<html><body>No PDF here</body></html>",
          authorized: true
        })
      } as never
    })
  );

  assertPaperDownloadError(error);
  assert.equal(error.code, "pdf_not_found");
  assert.match(error.message, /pdf_not_found/i);
});

test("downloadPaperPdf wraps article page launch failures as browser_session_unavailable", async () => {
  const error = await captureRejection(() =>
    downloadPaperPdf({
      workspaceDir: process.cwd(),
      url: "https://www.science.org/doi/10.1126/science.adz8659",
      browserSession: {
        openArticlePage: async () => {
          throw new Error("browser crashed");
        }
      } as never
    })
  );

  assertPaperDownloadError(error);
  assert.equal(error.code, "browser_session_unavailable");
});

test("downloadPaperPdf wraps article authorization failures as authorization_failed", async () => {
  const error = await captureRejection(() =>
    downloadPaperPdf({
      workspaceDir: process.cwd(),
      url: "https://www.science.org/doi/10.1126/science.adz8659",
      browserSession: {
        openArticlePage: async () => {
          throw new PaperBrowserSessionError(
            "authorization_failed",
            "Publisher authorization failed."
          );
        }
      } as never
    })
  );

  assertPaperDownloadError(error);
  assert.equal(error.code, "authorization_failed");
});

test("downloadPaperPdf classifies an unauthorized page as manual_login_required", async () => {
  const error = await captureRejection(() =>
    downloadPaperPdf({
      workspaceDir: process.cwd(),
      url: "https://www.science.org/doi/10.1126/science.adz8659",
      browserSession: {
        openArticlePage: async () => ({
          finalArticleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
          html: "<html><body>Login required</body></html>",
          authorized: false
        })
      } as never
    })
  );

  assertPaperDownloadError(error);
  assert.equal(error.code, "manual_login_required");
  assert.match(error.message, /login or verification/i);
});

test("downloadPaperPdf wraps output directory creation failures as download_failed", async () => {
  const error = await captureRejection(() =>
    downloadPaperPdf({
      workspaceDir: path.join(process.cwd(), "package.json"),
      url: "https://www.science.org/doi/10.1126/science.adz8659",
      browserSession: {
        openArticlePage: async () => ({
          finalArticleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
          html: '<html><body><a href="/doi/pdf/10.1126/science.adz8659">PDF</a></body></html>',
          authorized: true
        }),
        downloadPdf: async () => {}
      } as never
    })
  );

  assertPaperDownloadError(error);
  assert.equal(error.code, "download_failed");
});

test("downloadPaperPdf wraps PDF download failures as download_failed", async () => {
  const error = await captureRejection(() =>
    downloadPaperPdf({
      workspaceDir: process.cwd(),
      url: "https://www.science.org/doi/10.1126/science.adz8659",
      browserSession: {
        openArticlePage: async () => ({
          finalArticleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
          html: '<html><body><a href="/doi/pdf/10.1126/science.adz8659">PDF</a></body></html>',
          authorized: true
        }),
        downloadPdf: async () => {
          throw new Error("download interrupted");
        }
      } as never
    })
  );

  assertPaperDownloadError(error);
  assert.equal(error.code, "download_failed");
});

test("downloadPaperPdf classifies PDF-stage verification blocks as manual_login_required", async () => {
  const error = await captureRejection(() =>
    downloadPaperPdf({
      workspaceDir: process.cwd(),
      url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
      browserSession: {
        openArticlePage: async () => ({
          finalArticleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
          html: "<html><body>No direct PDF link in the article HTML.</body></html>",
          authorized: true
        }),
        downloadPdf: async () => {
          throw new PaperBrowserSessionError(
            "authorization_failed",
            "Cloudflare verification blocked the PDF request."
          );
        }
      }
    })
  );

  assertPaperDownloadError(error);
  assert.equal(error.code, "manual_login_required");
  assert.match(error.message, /cloudflare|verification/i);
});

test("downloadPaperPdf returns output metadata for a successful download", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-download-"));
  let downloadedUrl: string | undefined;
  let downloadedPath: string | undefined;

  const result = await downloadPaperPdf({
    workspaceDir,
    url: "https://www.science.org/doi/10.1126/science.adz8659",
    browserSession: {
      openArticlePage: async () => ({
        finalArticleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        html: '<html><body><a href="/doi/pdf/10.1126/science.adz8659">PDF</a></body></html>',
        authorized: true
      }),
      downloadPdf: async (url, destinationPath) => {
        downloadedUrl = url;
        downloadedPath = destinationPath;
      }
    }
  });

  const expectedPath = path.join(workspaceDir, "downloads", "papers", "downloaded-paper.pdf");
  assert.equal(result.path, expectedPath);
  assert.equal(result.publisher, "science");
  assert.equal(result.articleUrl, "https://www.science.org/doi/10.1126/science.adz8659");
  assert.equal(result.finalArticleUrl, "https://www.science.org/doi/10.1126/science.adz8659");
  assert.equal(result.finalPdfUrl, "https://www.science.org/doi/pdf/10.1126/science.adz8659");
  assert.equal(downloadedUrl, result.finalPdfUrl);
  assert.equal(downloadedPath, expectedPath);
});

test("downloadPaperPdf derives the APS canonical PDF URL when the article page has no PDF link", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-download-"));
  let downloadedUrl: string | undefined;

  const result = await downloadPaperPdf({
    workspaceDir,
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
    browserSession: {
      openArticlePage: async () => ({
        finalArticleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
        html: "<html><body>No direct PDF link in the article HTML.</body></html>",
        authorized: true
      }),
      downloadPdf: async (url) => {
        downloadedUrl = url;
      }
    }
  });

  assert.equal(
    result.finalPdfUrl,
    "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.134.090601"
  );
  assert.equal(downloadedUrl, result.finalPdfUrl);
});
