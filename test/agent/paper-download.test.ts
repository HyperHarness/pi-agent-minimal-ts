import test from "node:test";
import assert from "node:assert/strict";
import { downloadPaperPdf } from "../../src/agent/paper-download.js";

test("downloadPaperPdf rejects unsupported publishers before launching the browser", async () => {
  await assert.rejects(
    () =>
      downloadPaperPdf({
        workspaceDir: process.cwd(),
        url: "https://example.com/paper",
        browserSession: {} as never
      }),
    /Unsupported publisher/i
  );
});

test("downloadPaperPdf classifies a missing PDF path as pdf_not_found", async () => {
  await assert.rejects(
    () =>
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
      }),
    /pdf_not_found/i
  );
});
