import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkWikiHealth, fixWikiHealth } from "../../src/agent/wiki-health.js";
import { appendPaperDownloadJobEvent } from "../../src/agent/paper-download-jobs.js";
import type { PaperParseResult } from "../../src/agent/paper-reader/types.js";

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
    assert.equal(result.summary.needs_download, 1);
    assert.equal(result.summary.low_quality, 1);
    assert.equal(result.summary.summary_missing, 0);
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

test("checkWikiHealth accepts ready webpage reading when PDF parsing failed later", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "nature-s41567-025-03102-5";
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", `${paperKey}.pdf`);
    const sourceDir = path.join(workspace, "knowledge-base", "wiki", "sources", paperKey);
    const parseDir = path.join(sourceDir, "parses", "webpage");
    const chunksPath = path.join(sourceDir, "chunks", "webpage.jsonl");
    const markdownPath = path.join(parseDir, "document.md");
    const parsePath = path.join(parseDir, "parse.json");
    const qualityPath = path.join(parseDir, "quality.json");

    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeText(markdownPath, "# Abstract\n\nFull Nature webpage text.");
    await writeJson(parsePath, {
      paperKey,
      engine: "webpage"
    });
    await writeJson(qualityPath, {
      status: "good",
      score: 1,
      pages: 1,
      totalTextLength: 39982,
      warnings: []
    });
    await writeText(chunksPath, "{\"id\":\"chunk-1\"}\n");
    await writeJson(path.join(sourceDir, "source.json"), {
      paperKey,
      source: "nature",
      canonicalId: "s41567-025-03102-5",
      articleUrl: "https://www.nature.com/articles/s41567-025-03102-5",
      pdfPath
    });
    await writeJson(path.join(workspace, "knowledge-base", "records", `${paperKey}.json`), {
      source: "nature",
      articleUrl: "https://www.nature.com/articles/s41567-025-03102-5",
      recordedAt: "2026-05-06T02:51:40.161Z",
      handlingMethod: "browser_extension",
      status: "downloaded",
      canonicalId: "s41567-025-03102-5",
      downloadPath: pdfPath,
      reading: {
        status: "ready",
        updatedAt: "2026-05-06T02:51:32.244Z",
        preferredSource: "webpage",
        paperKey,
        markdownPath,
        parsePath,
        qualityPath,
        chunksPath
      },
      webpage: {
        status: "parsed",
        updatedAt: "2026-05-06T02:51:32.244Z",
        paperKey,
        engine: "webpage",
        markdownPath,
        parsePath,
        qualityPath,
        chunksPath,
        quality: {
          status: "good",
          score: 1,
          pages: 1,
          totalTextLength: 39982,
          warnings: []
        }
      },
      parse: {
        status: "failed",
        updatedAt: "2026-05-06T02:51:40.177Z",
        message: "Requested path is outside the workspace or knowledge base."
      }
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.parse_failed, 0);
    assert.equal(result.summary.parse_missing, 0);
    assert.ok(!result.issues.some((issue) => issue.kind === "parse_failed" && issue.paperKey === paperKey));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports publisher webpage-only parses as not PDF-downloaded", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "science-10.1126-sciadv.adp6388";
    const paperDir = path.join(workspace, "knowledge-base", "wiki", "sources", paperKey);
    const parseDir = path.join(paperDir, "parses", "webpage");
    await writeJson(path.join(paperDir, "source.json"), {
      paperKey,
      source: "science",
      canonicalId: "10.1126/sciadv.adp6388",
      articleUrl: "https://www.science.org/doi/10.1126/sciadv.adp6388",
      title: "High-performance fault-tolerant quantum computing with many-hypercube codes"
    });
    await writeText(path.join(parseDir, "document.md"), "# Abstract\n\nFull Science Advances webpage text.");
    await writeJson(path.join(parseDir, "parse.json"), {
      paperKey,
      engine: "webpage",
      pdfSha256: "webpage-snapshot-sha"
    });
    await writeJson(path.join(parseDir, "quality.json"), {
      status: "good",
      score: 1,
      pages: 1,
      totalTextLength: 66597,
      emptyPageCount: 0,
      headingCount: 12,
      tableCount: 0,
      figureOrCaptionCount: 10,
      warnings: []
    });
    await writeText(path.join(paperDir, "chunks", "webpage.jsonl"), "{\"id\":\"chunk-1\"}\n");

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.needs_download, 1);
    assert.ok(result.issues.some((issue) =>
      issue.kind === "needs_download" &&
      issue.paperKey === paperKey &&
      issue.reason.includes("Webpage parsing is not a successful PDF download")
    ));
    assert.equal(result.summary.summary_missing, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports Cloudflare extension handoff as user authorization", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "aps-10.1103-nv7d-k3wr";
    const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/NV7D-K3WR";
    await writeJson(path.join(workspace, "knowledge-base", "wiki", "sources", paperKey, "source.json"), {
      paperKey,
      source: "aps",
      canonicalId: "10.1103/NV7D-K3WR",
      articleUrl,
      title: "Complete Self-Testing of a System of Remote Superconducting Qubits"
    });
    await appendPaperDownloadJobEvent({
      workspaceDir: workspace,
      event: {
        jobId: "paper-aps-cloudflare",
        recordedAt: "2026-05-06T04:00:00.000Z",
        status: "awaiting_user_verification",
        articleUrl,
        source: "aps",
        purpose: "download_and_webpage",
        paperKey,
        message: "Cloudflare verification is blocking this publisher page. Complete the Cloudflare check in the browser extension tab, then retry the download."
      }
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.needs_authorization, 1);
    assert.equal(result.summary.needs_download, 0);
    const issue = result.issues.find((candidate) =>
      candidate.kind === "needs_authorization" && candidate.articleUrl === articleUrl
    );
    assert.ok(issue);
    assert.match(issue.reason, /Cloudflare verification is blocking/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth does not report an old low-quality parse when a good parse is available", async () => {
  const workspace = await createWorkspace();

  try {
    const paperDir = path.join(workspace, "knowledge-base", "wiki", "sources", "arxiv-2401.00007");
    await writeJson(path.join(paperDir, "source.json"), {
      paperKey: "arxiv-2401.00007",
      source: "arxiv",
      canonicalId: "2401.00007",
      articleUrl: "https://arxiv.org/abs/2401.00007"
    });
    await writeText(path.join(paperDir, "parses", "webpage", "document.md"), "Short abstract.");
    await writeJson(path.join(paperDir, "parses", "webpage", "quality.json"), {
      status: "poor",
      score: 0.2,
      pages: 1,
      totalTextLength: 20,
      emptyPageCount: 0,
      headingCount: 0,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: ["Extracted text is short."]
    });
    await writeText(path.join(paperDir, "parses", "opendataloader-local", "document.md"), "Full PDF text.");
    await writeJson(path.join(paperDir, "parses", "opendataloader-local", "quality.json"), {
      status: "good",
      score: 1,
      pages: 5,
      totalTextLength: 12000,
      emptyPageCount: 0,
      headingCount: 8,
      tableCount: 0,
      figureOrCaptionCount: 1,
      warnings: []
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.low_quality, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth treats publisher accepted-paper arXiv fallback records as non-actionable", async () => {
  const workspace = await createWorkspace();

  try {
    const arxivPdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2601.01234.pdf");
    const arxivRecordPath = path.join(workspace, "knowledge-base", "records", "arxiv-2601.01234.json");
    await writeText(arxivPdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeJson(arxivRecordPath, {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2601.01234",
      recordedAt: "2026-04-28T04:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2601.01234",
      pdfUrl: "https://arxiv.org/pdf/2601.01234.pdf",
      downloadPath: arxivPdfPath
    });
    await writeJson(path.join(workspace, "knowledge-base", "records", "aps-10.1103-k3d5-v43c.json"), {
      source: "aps",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/k3d5-v43c",
      recordedAt: "2026-04-28T04:01:00.000Z",
      handlingMethod: "arxiv_preprint_fallback",
      status: "preprint_fallback",
      canonicalId: "10.1103/k3d5-v43c",
      title: "Superconducting qubits in the millions: The potential and limitations of modularity",
      preprint: {
        source: "arxiv",
        canonicalId: "2601.01234",
        articleUrl: "https://arxiv.org/abs/2601.01234",
        pdfUrl: "https://arxiv.org/pdf/2601.01234.pdf",
        recordPath: arxivRecordPath,
        downloadPath: arxivPdfPath,
        status: "downloaded"
      },
      failure: {
        code: "publisher_version_not_available",
        message: "Publisher page is an accepted paper without a formal PDF yet; using matching arXiv preprint 2601.01234."
      }
    });
    const legacyPaperDir = path.join(
      workspace,
      "knowledge-base",
      "wiki",
      "sources",
      "journals.aps.org-prapplied-accepted-10.1103-k3d5-v43c"
    );
    await writeJson(path.join(legacyPaperDir, "source.json"), {
      paperKey: "journals.aps.org-prapplied-accepted-10.1103-k3d5-v43c",
      title: "Superconducting qubits in the millions: The potential and limitations of modularity",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/k3d5-v43c",
      source: "aps",
      canonicalId: "10.1103/k3d5-v43c"
    });
    await writeText(path.join(legacyPaperDir, "parses", "webpage", "document.md"), "Accepted paper abstract.");
    await writeJson(path.join(legacyPaperDir, "parses", "webpage", "quality.json"), {
      status: "poor",
      score: 0.2,
      pages: 1,
      totalTextLength: 24,
      emptyPageCount: 0,
      headingCount: 0,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: ["Accepted-paper page has no formal PDF yet."]
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.needs_download, 0);
    assert.equal(result.summary.low_quality, 0);
    assert.equal(result.summary.summary_missing, 0);
    assert.ok(!result.issues.some((issue) => issue.paperKey === "aps-10.1103-k3d5-v43c"));
    assert.ok(!result.issues.some((issue) => issue.paperKey === "journals.aps.org-prapplied-accepted-10.1103-k3d5-v43c"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth treats accepted publisher-pending records as non-actionable", async () => {
  const workspace = await createWorkspace();

  try {
    await writeJson(path.join(workspace, "knowledge-base", "records", "aps-10.1103-rp4w-3n7l.json"), {
      source: "aps",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/rp4w-3n7l",
      recordedAt: "2026-04-28T04:01:00.000Z",
      handlingMethod: "accepted_paper",
      status: "publisher_pending",
      canonicalId: "10.1103/rp4w-3n7l",
      title: "Design and application of N[3]CZ: A controlled-Z gate between next-nearest-neighbor superconducting qubits",
      failure: {
        code: "publisher_version_not_available",
        message: "Publisher page is an accepted paper without a formal PDF yet, and no exact-title arXiv preprint was found."
      }
    });
    const legacyPaperDir = path.join(
      workspace,
      "knowledge-base",
      "wiki",
      "sources",
      "journals.aps.org-prapplied-accepted-10.1103-rp4w-3n7l"
    );
    await writeJson(path.join(legacyPaperDir, "source.json"), {
      paperKey: "journals.aps.org-prapplied-accepted-10.1103-rp4w-3n7l",
      title: "Design and application of N[3]CZ: A controlled-Z gate between next-nearest-neighbor superconducting qubits",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/rp4w-3n7l",
      source: "aps",
      canonicalId: "10.1103/rp4w-3n7l"
    });
    await writeText(path.join(legacyPaperDir, "parses", "webpage", "document.md"), "Accepted paper abstract.");
    await writeJson(path.join(legacyPaperDir, "parses", "webpage", "quality.json"), {
      status: "needs_hybrid",
      score: 0.55,
      pages: 1,
      totalTextLength: 3500,
      emptyPageCount: 0,
      headingCount: 2,
      tableCount: 0,
      figureOrCaptionCount: 1,
      warnings: ["Accepted-paper page has no formal PDF yet."]
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.needs_download, 0);
    assert.equal(result.summary.low_quality, 0);
    assert.equal(result.summary.summary_missing, 0);
    assert.ok(!result.issues.some((issue) => issue.paperKey === "aps-10.1103-rp4w-3n7l"));
    assert.ok(!result.issues.some((issue) => issue.paperKey === "journals.aps.org-prapplied-accepted-10.1103-rp4w-3n7l"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth treats a good webpage parse as readable but not PDF-downloaded", async () => {
  const workspace = await createWorkspace();

  try {
    await writeJson(path.join(workspace, "knowledge-base", "records", "nature-s41567-022-01591-2.json"), {
      source: "nature",
      articleUrl: "https://www.nature.com/articles/s41567-022-01591-2",
      openedUrl: "https://www.nature.com/articles/s41567-022-01591-2",
      recordedAt: "2026-04-29T06:12:09.364Z",
      handlingMethod: "browser_session",
      status: "manual_fallback_opened",
      canonicalId: "s41567-022-01591-2",
      failure: {
        code: "manual_login_required",
        message: "PDF download requires login."
      }
    });
    const parsedDir = path.join(
      workspace,
      "knowledge-base",
      "wiki",
      "sources",
      "nature-s41567-022-01591-2",
      "parses",
      "webpage"
    );
    await writeJson(path.join(workspace, "knowledge-base", "wiki", "sources", "nature-s41567-022-01591-2", "source.json"), {
      paperKey: "nature-s41567-022-01591-2",
      source: "nature",
      canonicalId: "s41567-022-01591-2",
      articleUrl: "https://www.nature.com/articles/s41567-022-01591-2"
    });
    await writeText(path.join(parsedDir, "document.md"), "# Title\n\n## Abstract\n\nFull abstract.\n\n## Main\n\nFull article body.");
    await writeJson(path.join(parsedDir, "quality.json"), {
      status: "good",
      score: 0.85,
      pages: 1,
      totalTextLength: 12000,
      emptyPageCount: 0,
      headingCount: 2,
      tableCount: 0,
      figureOrCaptionCount: 1,
      warnings: []
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.needs_authorization, 0);
    assert.equal(result.summary.needs_download, 1);
    assert.equal(result.summary.low_quality, 0);
    assert.equal(result.summary.summary_missing, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixWikiHealth parses missing downloaded records and updates the record manifest", async () => {
  const workspace = await createWorkspace();

  try {
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2401.00004.pdf");
    const recordPath = path.join(workspace, "knowledge-base", "records", "arxiv-2401.00004.json");
    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeJson(recordPath, {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.00004",
      recordedAt: "2026-04-28T04:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.00004",
      pdfUrl: "https://arxiv.org/pdf/2401.00004.pdf",
      downloadPath: pdfPath
    });

    const artifactRoot = path.join(
      workspace,
      "knowledge-base",
      "wiki",
      "sources",
      "arxiv-2401.00004",
      "parses",
      "plain-text-baseline"
    );
    const chunksPath = path.join(
      workspace,
      "knowledge-base",
      "wiki",
      "sources",
      "arxiv-2401.00004",
      "chunks",
      "plain-text-baseline.jsonl"
    );
    const parseResult: PaperParseResult = {
      status: "parsed",
      paperKey: "arxiv-2401.00004",
      engine: "plain-text-baseline",
      pdfSha256: "sha-test",
      artifacts: {
        sourcePath: path.join(workspace, "knowledge-base", "wiki", "sources", "arxiv-2401.00004", "source.json"),
        parsePath: path.join(artifactRoot, "parse.json"),
        markdownPath: path.join(artifactRoot, "document.md"),
        qualityPath: path.join(artifactRoot, "quality.json"),
        chunksPath
      },
      quality: {
        status: "good",
        score: 0.95,
        pages: 1,
        totalTextLength: 1200,
        emptyPageCount: 0,
        headingCount: 2,
        tableCount: 0,
        figureOrCaptionCount: 0,
        warnings: []
      },
      sections: [
        {
          id: "abstract",
          title: "Abstract",
          level: 1,
          pageFrom: 1,
          pageTo: 1
        }
      ]
    };

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["parse_missing"],
      parsePaperImpl: async (options) => {
        assert.equal(options.recordPath, "knowledge-base/records/arxiv-2401.00004.json");
        assert.equal(options.force, undefined);
        return parseResult;
      }
    });

    assert.equal(result.attempted, 1);
    assert.equal(result.fixed, 1);
    assert.equal(result.results[0]?.action, "parse");

    const updatedRecord = JSON.parse(await readFile(recordPath, "utf8")) as {
      reading?: { status?: string; preferredSource?: string; paperKey?: string };
      parse?: { status?: string; engine?: string; markdownPath?: string };
    };
    assert.equal(updatedRecord.reading?.status, "ready");
    assert.equal(updatedRecord.reading?.preferredSource, "pdf_parse");
    assert.equal(updatedRecord.reading?.paperKey, "arxiv-2401.00004");
    assert.equal(updatedRecord.parse?.status, "parsed");
    assert.equal(updatedRecord.parse?.engine, "plain-text-baseline");
    assert.equal(
      updatedRecord.parse?.markdownPath,
      "knowledge-base/wiki/sources/arxiv-2401.00004/parses/plain-text-baseline/document.md"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixWikiHealth does not enable browser fallback for missing publisher PDFs", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "science-10.1126-sciadv.adp6388";
    const paperDir = path.join(workspace, "knowledge-base", "wiki", "sources", paperKey);
    await writeJson(path.join(paperDir, "source.json"), {
      paperKey,
      source: "science",
      canonicalId: "10.1126/sciadv.adp6388",
      articleUrl: "https://www.science.org/doi/10.1126/sciadv.adp6388",
      title: "High-performance fault-tolerant quantum computing with many-hypercube codes"
    });
    await writeText(path.join(paperDir, "parses", "webpage", "document.md"), "# Abstract\n\nScience webpage text.");
    await writeJson(path.join(paperDir, "parses", "webpage", "quality.json"), {
      status: "good",
      score: 1,
      pages: 1,
      totalTextLength: 66597,
      emptyPageCount: 0,
      headingCount: 10,
      tableCount: 0,
      figureOrCaptionCount: 10,
      warnings: []
    });

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["needs_download"],
      downloadPaperImpl: async (options) => {
        assert.equal(options.url, "https://www.science.org/doi/10.1126/sciadv.adp6388");
        assert.equal(options.usePlaywrightFallback, undefined);
        return {
          status: "extension_unavailable",
          source: "science",
          articleUrl: options.url as string,
          failure: {
            code: "extension_unavailable",
            message: "Paper extension bridge is not configured."
          }
        };
      }
    });

    assert.equal(result.attempted, 1);
    assert.equal(result.fixed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.results[0]?.action, "download");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixWikiHealth skips user-authored or user-authorized repairs with explicit reasons", async () => {
  const workspace = await createWorkspace();

  try {
    await writeJson(path.join(workspace, "knowledge-base", "records", "nature-s41586-024-00005-y.json"), {
      source: "nature",
      articleUrl: "https://www.nature.com/articles/s41586-024-00005-y",
      openedUrl: "https://www.nature.com/articles/s41586-024-00005-y",
      recordedAt: "2026-04-28T05:00:00.000Z",
      handlingMethod: "browser_session",
      status: "manual_fallback_opened",
      canonicalId: "s41586-024-00005-y",
      failure: {
        code: "manual_login_required",
        message: "Manual login required."
      }
    });

    const parsedDir = path.join(
      workspace,
      "knowledge-base",
      "wiki",
      "sources",
      "arxiv-2401.00006",
      "parses",
      "plain-text-baseline"
    );
    await writeJson(path.join(workspace, "knowledge-base", "wiki", "sources", "arxiv-2401.00006", "source.json"), {
      paperKey: "arxiv-2401.00006",
      source: "arxiv",
      canonicalId: "2401.00006",
      articleUrl: "https://arxiv.org/abs/2401.00006"
    });
    await writeText(path.join(parsedDir, "document.md"), "A complete parsed paper body.");
    await writeJson(path.join(parsedDir, "parse.json"), {
      paperKey: "arxiv-2401.00006",
      engine: "plain-text-baseline"
    });
    await writeJson(path.join(parsedDir, "quality.json"), {
      status: "good",
      score: 0.95,
      pages: 1,
      totalTextLength: 1200,
      emptyPageCount: 0,
      headingCount: 2,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: []
    });
    await writeText(
      path.join(workspace, "knowledge-base", "wiki", "sources", "arxiv-2401.00006", "chunks", "plain-text-baseline.jsonl"),
      "{\"id\":\"chunk-1\"}\n"
    );

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["needs_authorization", "summary_missing"]
    });

    assert.equal(result.fixed, 0);
    assert.equal(result.skipped, 2);
    assert.ok(result.results.some((item) =>
      item.issue.kind === "needs_authorization" &&
      /login|authorization/i.test(item.message)
    ));
    assert.ok(result.results.some((item) =>
      item.issue.kind === "summary_missing" &&
      /Summary worker is not configured/i.test(item.message)
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixWikiHealth generates missing summaries when a summary worker is available", async () => {
  const workspace = await createWorkspace();
  const generated: string[] = [];
  const progressMessages: string[] = [];

  try {
    const parsedDir = path.join(
      workspace,
      "knowledge-base",
      "wiki",
      "sources",
      "arxiv-2401.00007",
      "parses",
      "plain-text-baseline"
    );
    await writeJson(path.join(workspace, "knowledge-base", "wiki", "sources", "arxiv-2401.00007", "source.json"), {
      paperKey: "arxiv-2401.00007",
      source: "arxiv",
      canonicalId: "2401.00007",
      articleUrl: "https://arxiv.org/abs/2401.00007"
    });
    await writeText(path.join(parsedDir, "document.md"), "# Paper\n\nThis parsed paper discusses clean-context summaries.");
    await writeJson(path.join(parsedDir, "parse.json"), {
      paperKey: "arxiv-2401.00007",
      engine: "plain-text-baseline",
      pdfSha256: "sha-summary",
      createdAt: "2026-04-29T00:00:00.000Z",
      pages: 1,
      elements: [],
      sections: []
    });
    await writeJson(path.join(parsedDir, "quality.json"), {
      status: "good",
      score: 0.95,
      pages: 1,
      totalTextLength: 1200,
      emptyPageCount: 0,
      headingCount: 1,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: []
    });
    await writeText(
      path.join(workspace, "knowledge-base", "wiki", "sources", "arxiv-2401.00007", "chunks", "plain-text-baseline.jsonl"),
      "{\"id\":\"chunk-1\"}\n"
    );

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["summary_missing"],
      onProgress: (progress) => {
        progressMessages.push(progress.message);
      },
      paperSummaryWorker: async ({ evidence }) => {
        generated.push(evidence.paperKey);
        return {
          summaryMarkdown: "A grounded summary produced from a clean summary worker.",
          confidence: "high"
        };
      }
    });

    assert.equal(generated[0], "arxiv-2401.00007");
    assert.equal(result.fixed, 1);
    assert.equal(result.results[0]?.action, "summary");
    assert.equal(result.results[0]?.status, "fixed");
    assert.ok(progressMessages.some((message) => message.includes("Checking wiki health")));
    assert.ok(progressMessages.some((message) => message.includes("Generating summary 1/1")));
    assert.ok(progressMessages.some((message) => message.includes("Summary 1/1: Running clean summary worker")));
    assert.ok(progressMessages.some((message) => message.includes("Finished summary 1/1")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
