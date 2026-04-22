import test from "node:test";
import assert from "node:assert/strict";
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
          throw new Error("authorization failed");
        }
      } as never
    })
  );

  assertPaperDownloadError(error);
  assert.equal(error.code, "authorization_failed");
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
