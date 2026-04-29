import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkWikiHealth } from "../../src/agent/wiki-health.js";

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pi-wiki-health-"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

test("checkWikiHealth reports records that need download, authorization, parsing, and summaries", async () => {
  const workspace = await createWorkspace();

  try {
    await writeJson(path.join(workspace, "knowledge-base", "records", "nature-s41586-024-00001-y.json"), {
      source: "nature",
      articleUrl: "https://www.nature.com/articles/s41586-024-00001-y",
      openedUrl: "https://www.nature.com/articles/s41586-024-00001-y",
      recordedAt: "2026-04-28T00:00:00.000Z",
      handlingMethod: "browser_session",
      status: "manual_fallback_opened",
      canonicalId: "s41586-024-00001-y",
      failure: {
        code: "authorization_failed",
        message: "Manual login required."
      }
    });

    const missingPdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2401.00001.pdf");
    await writeJson(path.join(workspace, "knowledge-base", "records", "arxiv-2401.00001.json"), {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.00001",
      recordedAt: "2026-04-28T01:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.00001",
      pdfUrl: "https://arxiv.org/pdf/2401.00001.pdf",
      downloadPath: missingPdfPath
    });

    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2401.00002.pdf");
    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeJson(path.join(workspace, "knowledge-base", "records", "arxiv-2401.00002.json"), {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.00002",
      recordedAt: "2026-04-28T02:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.00002",
      pdfUrl: "https://arxiv.org/pdf/2401.00002.pdf",
      downloadPath: pdfPath
    });

    const parsedDir = path.join(
      workspace,
      "knowledge-base",
      "wiki",
      "sources",
      "arxiv-2401.00002",
      "parses",
      "plain-text-baseline"
    );
    await writeJson(path.join(workspace, "knowledge-base", "wiki", "sources", "arxiv-2401.00002", "source.json"), {
      paperKey: "arxiv-2401.00002",
      source: "arxiv",
      canonicalId: "2401.00002",
      articleUrl: "https://arxiv.org/abs/2401.00002",
      pdfPath
    });
    await writeText(path.join(parsedDir, "document.md"), "Short parse.");
    await writeJson(path.join(parsedDir, "parse.json"), {
      paperKey: "arxiv-2401.00002",
      engine: "plain-text-baseline"
    });
    await writeJson(path.join(parsedDir, "quality.json"), {
      status: "poor",
      score: 0.2,
      pages: 1,
      totalTextLength: 25,
      emptyPageCount: 0,
      headingCount: 0,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: ["Very little text was extracted."]
    });
    await writeText(
      path.join(workspace, "knowledge-base", "wiki", "sources", "arxiv-2401.00002", "chunks", "plain-text-baseline.jsonl"),
      "{\"id\":\"chunk-1\"}\n"
    );

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.totalPapers, 3);
    assert.equal(result.summary.needs_authorization, 1);
    assert.equal(result.summary.needs_download, 2);
    assert.equal(result.summary.low_quality, 1);
    assert.equal(result.summary.summary_missing, 1);
    assert.equal(result.summary.missing_artifact, 1);
    assert.ok(result.issues.some((issue) => issue.kind === "needs_authorization" && issue.paperKey === "nature-s41586-024-00001-y"));
    assert.ok(result.issues.some((issue) => issue.kind === "missing_artifact" && issue.paperKey === "arxiv-2401.00001"));
    assert.ok(result.issues.some((issue) => issue.kind === "low_quality" && issue.quality?.engine === "plain-text-baseline"));
    assert.ok(result.actions.some((action) => action.includes("Open/login")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth resolves WSL UNC artifact paths before reporting missing files", async () => {
  const workspace = await createWorkspace();

  try {
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2401.00003.pdf");
    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    const uncPdfPath = `\\\\wsl.localhost\\Ubuntu-24.04\\${pdfPath.slice(1).split(path.sep).join("\\")}`;
    await writeJson(path.join(workspace, "knowledge-base", "records", "arxiv-2401.00003.json"), {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.00003",
      recordedAt: "2026-04-28T03:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.00003",
      pdfUrl: "https://arxiv.org/pdf/2401.00003.pdf",
      downloadPath: uncPdfPath
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.needs_download, 0);
    assert.equal(result.summary.missing_artifact, 0);
    assert.equal(result.summary.parse_missing, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
