import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkWikiHealth, fixWikiHealth } from "../../src/agent/wiki/health.js";
import { appendPaperDownloadJobEvent } from "../../src/agent/paper/extension/paper-download-jobs.js";
import { blockPaperDownload } from "../../src/agent/paper/acquisition/paper-blocklist.js";
import type { PaperParseResult } from "../../src/agent/paper/reading/types.js";

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

async function writePaperMetadata(filePath: string, value: Record<string, unknown>): Promise<void> {
  const paperKey = typeof value.paperKey === "string"
    ? value.paperKey
    : path.basename(path.dirname(filePath));
  const citation = {
    citationStatus: typeof value.citationStatus === "string" ? value.citationStatus : "complete",
    missingFields: Array.isArray(value.missingFields) ? value.missingFields : [],
    ...(Array.isArray(value.authors) ? { authors: value.authors } : {}),
    ...(typeof value.year === "number" ? { year: value.year } : {}),
    ...(typeof value.venue === "string" ? { venue: value.venue } : {}),
    ...(typeof value.publisher === "string" ? { publisher: value.publisher } : {}),
    ...(typeof value.doi === "string" ? { doi: value.doi } : {}),
    ...(typeof value.arxivId === "string" ? { arxivId: value.arxivId } : {}),
    ...(typeof value.resolvedFrom === "string" ? { resolvedFrom: value.resolvedFrom } : {}),
    ...(typeof value.sourceConfidence === "string" ? { sourceConfidence: value.sourceConfidence } : {})
  };
  const provenance = {
    ...(typeof value.articleUrl === "string" ? { url: value.articleUrl } : {}),
    ...(typeof value.source === "string" ? { source: value.source } : {}),
    ...(typeof value.canonicalId === "string" ? { canonicalId: value.canonicalId } : {}),
    ...(typeof value.acquisitionPath === "string" ? { acquisitionPath: value.acquisitionPath } : {}),
    ...(typeof value.recordPath === "string" ? { recordPath: value.recordPath } : {}),
    ...(typeof value.pdfPath === "string" ? { rawPath: value.pdfPath } : {}),
    ...(typeof value.downloadPath === "string" ? { rawPath: value.downloadPath } : {}),
    ...(typeof value.pdfSha256 === "string" ? { rawSha256: value.pdfSha256 } : {}),
    ...(typeof value.downloadStatus === "string" ? { downloadStatus: value.downloadStatus } : {}),
    ...(typeof value.readingStatus === "string" ? { readingStatus: value.readingStatus } : {}),
    ...(typeof value.recordedAt === "string" ? { recordedAt: value.recordedAt } : {})
  };
  await writeJson(filePath, {
    schemaVersion: 1,
    sourceKind: "paper",
    sourceKey: paperKey,
    title: typeof value.title === "string" ? value.title : paperKey,
    status: citation.missingFields.length === 0 ? "ready" : "citation_incomplete",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "2026-05-26T00:00:00.000Z",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "2026-05-26T00:00:00.000Z",
    summaryPath: typeof value.summaryPath === "string"
      ? value.summaryPath
      : `knowledge-base/sources/${paperKey}/summary.md`,
    citation,
    provenance,
    artifacts: [],
    tags: [],
    relatedSourceKeys: [],
    synthesisPageKeys: []
  });
}

test("checkWikiHealth reports records that need download, authorization, parsing, and summaries", async () => {
  const workspace = await createWorkspace();

  try {
    await writeJson(path.join(workspace, "knowledge-base", "sources", "nature-s41586-024-00001-y", "acquisition.json"), {
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
    await writeJson(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00001", "acquisition.json"), {
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
    await writeJson(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00002", "acquisition.json"), {
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
      "knowledge-base", "sources",
      "arxiv-2401.00002",
      "parses",
      "plain-text-baseline"
    );
    await writePaperMetadata(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00002", "metadata.json"), {
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
      path.join(parsedDir, "chunks.jsonl"),
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

test("checkWikiHealth excludes publisher news pages from paper parse health", async () => {
  const workspace = await createWorkspace();

  try {
    const newsSources = [
      {
        paperKey: "science-10.1126-science.adv4414",
        source: "science",
        canonicalId: "10.1126/science.adv4414",
        articleUrl: "https://www.science.org/doi/10.1126/science.adv4414",
        title: "Learning the language of life with AI"
      },
      {
        paperKey: "nature-d41586-025-01364-w",
        source: "nature",
        canonicalId: "d41586-025-01364-w",
        articleUrl: "https://www.nature.com/articles/d41586-025-01364-w",
        title: "AI scientist 'team' joins the search for extraterrestrial life"
      }
    ];

    for (const source of newsSources) {
      const sourceDir = path.join(workspace, "knowledge-base", "sources", source.paperKey);
      const parsedDir = path.join(sourceDir, "parses", "webpage");
      await writePaperMetadata(path.join(sourceDir, "metadata.json"), source);
      await writeText(path.join(sourceDir, "summary.md"), `---\ntitle: "${source.title}"\n---\n\n# ${source.title}\n`);
      await writeText(path.join(parsedDir, "document.md"), `${source.title}\n\nShort news page.`);
      await writeJson(path.join(parsedDir, "parse.json"), {
        paperKey: source.paperKey,
        engine: "webpage"
      });
      await writeJson(path.join(parsedDir, "quality.json"), {
        status: "needs_hybrid",
        score: 0.45,
        pages: 1,
        totalTextLength: 1200,
        warnings: ["No main body sections were detected."]
      });
      await writeText(
        path.join(parsedDir, "chunks.jsonl"),
        "{\"id\":\"chunk-1\"}\n"
      );
    }

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.totalPapers, 0);
    assert.equal(result.summary.low_quality, 0);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki_health_fix quarantines APS institution site license non-paper sources", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "journals.aps.org-aps-institution-site-license";
    const articleUrl = "https://journals.aps.org/aps-institution-site-license";
    const sourceDir = path.join(workspace, "knowledge-base", "sources", paperKey);
    const parseDir = path.join(sourceDir, "parses", "webpage");
    await writePaperMetadata(path.join(sourceDir, "metadata.json"), {
      paperKey,
      articleUrl,
      source: "aps",
      title: "APS Institution Site License",
      authors: [],
      year: 2017,
      publisher: "American Physical Society",
      citationStatus: "incomplete",
      missingFields: ["authors", "venue"]
    });
    await writeText(path.join(parseDir, "document.md"), "# APS Institution Site License\n\nPolicy text.");
    await writeJson(path.join(parseDir, "parse.json"), {
      paperKey,
      engine: "webpage"
    });
    await writeJson(path.join(parseDir, "quality.json"), {
      status: "good",
      score: 0.9,
      pages: 1,
      totalTextLength: 3000,
      warnings: []
    });
    await writeText(path.join(parseDir, "chunks.jsonl"), "{\"id\":\"chunk-1\"}\n");
    await writeText(path.join(sourceDir, "summary.md"), "---\ntype: \"paper-source-summary\"\n---\n\nPolicy summary.\n");

    const checked = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(checked.totalPapers, 0);
    assert.equal(checked.summary.non_paper_source, 1);
    assert.equal(checked.summary.citation_incomplete, 0);
    assert.equal(checked.summary.needs_download, 0);

    const fixed = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["non_paper_source"]
    });

    assert.equal(fixed.fixed, 1);
    await assert.rejects(readFile(path.join(sourceDir, "metadata.json"), "utf8"));
    const quarantinedSource = await readFile(
      path.join(workspace, "knowledge-base", "quarantine", "non-paper-sources", paperKey, "source", "metadata.json"),
      "utf8"
    );
    assert.match(quarantinedSource, /APS Institution Site License/);
    const blocklist = await readFile(path.join(workspace, "knowledge-base", "state", "paper-blocklist.jsonl"), "utf8");
    assert.match(blocklist, /"reasonCode":"not_a_paper"/);
    assert.match(blocklist, /aps-institution-site-license/);
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
    await writeJson(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00003", "acquisition.json"), {
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

test("checkWikiHealth ignores stale queued webpage work when PDF reading is ready", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "nature-s41586-026-10644-y";
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", `${paperKey}.pdf`);
    const parseRoot = path.join(workspace, "knowledge-base", "sources", paperKey, "parses", "opendataloader-local");
    const chunksPath = path.join(parseRoot, "chunks.jsonl");
    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeText(path.join(parseRoot, "document.md"), "# Introduction\n\nA complete PDF parse.");
    await writeJson(path.join(parseRoot, "parse.json"), {
      paperKey,
      engine: "opendataloader-local"
    });
    await writeJson(path.join(parseRoot, "quality.json"), {
      status: "good",
      score: 1,
      pages: 55,
      totalTextLength: 115795,
      emptyPageCount: 0,
      headingCount: 41,
      tableCount: 0,
      figureOrCaptionCount: 6,
      warnings: []
    });
    await writeText(chunksPath, "{\"id\":\"chunk-1\"}\n");
    await writePaperMetadata(path.join(workspace, "knowledge-base", "sources", paperKey, "metadata.json"), {
      paperKey,
      source: "nature",
      canonicalId: "s41586-026-10644-y",
      articleUrl: "https://www.nature.com/articles/s41586-026-10644-y",
      title: "Accelerating scientific discovery with Co-Scientist",
      pdfPath,
      pdfSha256: "sha-test",
      recordPath: `knowledge-base/sources/${paperKey}/acquisition.json`
    });
    await writeJson(path.join(workspace, "knowledge-base", "sources", paperKey, "acquisition.json"), {
      source: "nature",
      articleUrl: "https://www.nature.com/articles/s41586-026-10644-y",
      recordedAt: "2026-05-25T02:53:07.163Z",
      handlingMethod: "browser_session",
      status: "downloaded",
      canonicalId: "s41586-026-10644-y",
      pdfUrl: "https://www.nature.com/articles/s41586-026-10644-y_reference.pdf",
      downloadPath: pdfPath,
      reading: {
        status: "ready",
        preferredSource: "pdf_parse",
        paperKey,
        markdownPath: `knowledge-base/sources/${paperKey}/parses/opendataloader-local/document.md`,
        parsePath: `knowledge-base/sources/${paperKey}/parses/opendataloader-local/parse.json`,
        qualityPath: `knowledge-base/sources/${paperKey}/parses/opendataloader-local/quality.json`,
        chunksPath: `knowledge-base/sources/${paperKey}/parses/opendataloader-local/chunks.jsonl`,
        quality: {
          status: "good",
          score: 1,
          pages: 55,
          totalTextLength: 115795,
          warnings: []
        }
      },
      webpage: {
        status: "queued",
        jobId: "paper-nature-stale-webpage",
        message: "Publisher PDF is downloaded. Browser extension webpage capture was queued."
      }
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.queued, 0);
    assert.ok(!result.issues.some((issue) => issue.kind === "queued" && issue.paperKey === paperKey));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports incomplete source citation metadata", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "arxiv-2401.00008";
    await writeJson(path.join(workspace, "knowledge-base", "sources", paperKey, "acquisition.json"), {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.00008",
      recordedAt: "2026-04-28T03:30:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.00008",
      pdfUrl: "https://arxiv.org/pdf/2401.00008.pdf",
      downloadPath: path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2401.00008.pdf")
    });
    await writePaperMetadata(path.join(workspace, "knowledge-base", "sources", paperKey, "metadata.json"), {
      schemaVersion: 2,
      paperKey,
      source: "arxiv",
      canonicalId: "2401.00008",
      articleUrl: "https://arxiv.org/abs/2401.00008",
      authors: [],
      citationStatus: "incomplete",
      missingFields: ["title", "authors", "venue"],
      acquisitionPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
      recordPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
      downloadStatus: "downloaded",
      resolvedFrom: "acquisition",
      sourceConfidence: "medium",
      recordedAt: "2026-04-28T03:30:00.000Z",
      updatedAt: "2026-04-28T03:30:00.000Z"
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.citation_incomplete, 1);
    const issue = result.issues.find((candidate) => candidate.kind === "citation_incomplete");
    assert.equal(issue?.paperKey, paperKey);
    assert.deepEqual(issue?.metadata?.missingFields, ["title", "authors", "venue"]);
    assert.match(issue?.reason ?? "", /citation metadata is incomplete/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth ignores source json without metadata json", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "science-10.1126-science.ado6285";
    await writeJson(path.join(workspace, "knowledge-base", "sources", paperKey, "source.json"), {
      paperKey,
      source: "science",
      canonicalId: "10.1126/science.ado6285",
      articleUrl: "https://www.science.org/doi/10.1126/science.ado6285",
      title: "Beyond-classical computation in quantum simulation"
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.citation_incomplete, 0);
    assert.equal(
      result.issues.some((candidate) =>
        candidate.kind === "citation_incomplete" &&
        candidate.metadata?.sourcePath === `knowledge-base/sources/${paperKey}/metadata.json`
      ),
      false
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth excludes non-paper source metadata from paper repair issues", async () => {
  const workspace = await createWorkspace();

  try {
    const sourceKey = "code-output-single-xmon-concept";
    await writeText(
      path.join(workspace, "knowledge-base", "sources", sourceKey, "summary.md"),
      "# Single Xmon Concept Layout\n\nA local code-output summary.\n"
    );
    await writeText(
      path.join(workspace, "design-repo", "design-artifacts", "single-xmon-concept", "README.md"),
      "# Single Xmon Concept\n"
    );
    await writeText(
      path.join(workspace, "design-repo", "design-artifacts", "single-xmon-concept", "code", "layout.py"),
      "print('layout')\n"
    );
    await writeJson(path.join(workspace, "knowledge-base", "sources", sourceKey, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "code-output",
      sourceKey,
      title: "Single Xmon Concept Layout",
      status: "needs_review",
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${sourceKey}/summary.md`,
      provenance: {
        recordPath: "design-repo/design-artifacts/single-xmon-concept/README.md"
      },
      citation: {
        citationStatus: "complete",
        missingFields: []
      },
      artifacts: [{
        kind: "script",
        path: "design-repo/design-artifacts/single-xmon-concept/code/layout.py"
      }],
      tags: ["code-output"],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.totalPapers, 0);
    assert.equal(result.summary.needs_download, 0);
    assert.equal(result.summary.citation_incomplete, 0);
    assert.equal(result.summary.source_metadata_artifact_missing, 0);
    assert.ok(!result.issues.some((issue) => issue.paperKey === sourceKey));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth initializes typed wiki page summary counts", async () => {
  const workspace = await createWorkspace();
  try {
    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.source_metadata_artifact_missing, 0);
    assert.equal(result.summary.wiki_page_malformed, 0);
    assert.equal(result.summary.wiki_page_evidence_weak, 0);
    assert.equal(result.summary.wiki_operation_interrupted, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports interrupted wiki operations", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "state", "wiki-operations.jsonl"), JSON.stringify({
      schemaVersion: 1,
      phase: "begin",
      operationId: "wiki-op-test",
      intent: "write_synthesis_page",
      owner: "wiki-agent",
      startedAt: "2026-05-10T00:00:00.000Z",
      plannedFiles: ["knowledge-base/pages/test.md"],
      inputs: {}
    }) + "\n");

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.wiki_operation_interrupted, 1);
    assert.ok(result.issues.some((issue) => issue.kind === "wiki_operation_interrupted"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth ignores malformed journal events without hiding interrupted operations", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "state", "wiki-operations.jsonl"), [
      "not json",
      JSON.stringify({
        schemaVersion: 1,
        phase: "begin",
        operationId: "malformed-begin",
        intent: "write_synthesis_page",
        owner: "wiki-agent",
        startedAt: "2026-05-10T00:00:00.000Z",
        inputs: {}
      }),
      JSON.stringify({
        schemaVersion: 1,
        phase: "begin",
        operationId: "interrupted-op",
        intent: "write_synthesis_page",
        owner: "wiki-agent",
        startedAt: "2026-05-10T00:01:00.000Z",
        plannedFiles: ["knowledge-base/pages/interrupted.md"],
        inputs: {}
      }),
      JSON.stringify({
        schemaVersion: 1,
        phase: "complete",
        operationId: "interrupted-op",
        completedAt: "2026-05-10T00:02:00.000Z"
      })
    ].join("\n") + "\n");

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.wiki_operation_interrupted, 1);
    const issue = result.issues.find((candidate) => candidate.kind === "wiki_operation_interrupted");
    assert.equal(issue?.operationId, "interrupted-op");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});


test("checkWikiHealth reports malformed typed wiki pages", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "pages", "broken.md"), [
      "---",
      "schema_version: 1",
      'type: "synthesis"',
      'key: ""',
      'title: ""',
      "aliases: []",
      "tags: []",
      'evidence_contract: "none"',
      "source_refs: []",
      'created_at: "not-a-date"',
      'updated_at: "2026-05-10T00:00:00.000Z"',
      "---",
      "",
      "# Broken page"
    ].join("\n"));

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.wiki_page_malformed, 1);
    assert.ok(result.issues.some((issue) =>
      issue.kind === "wiki_page_malformed" &&
      issue.path === "knowledge-base/pages/broken.md"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth ignores legacy wiki page metadata when checking typed pages", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "pages", "legacy.md"), [
      "---",
      'type: "wiki-synthesis-page"',
      "page_key: legacy",
      "sources:",
      "  - paper_key: paper-a",
      "    title: Legacy Evidence",
      "    path: knowledge-base/sources/paper-a/summary.md",
      "---",
      "",
      "# Legacy"
    ].join("\n"));

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.wiki_page_malformed, 0);
    assert.ok(!result.issues.some((issue) =>
      issue.kind === "wiki_page_malformed" &&
      issue.path === "knowledge-base/pages/legacy.md"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports mixed typed diagnostics as malformed", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "pages", "mixed.md"), [
      "---",
      "schema_version: 1",
      'type: "synthesis"',
      'key: ""',
      'title: "Mixed"',
      "aliases: []",
      "tags: []",
      'evidence_contract: "paper-backed"',
      "source_refs: []",
      'created_at: "2026-05-10T00:00:00.000Z"',
      'updated_at: "2026-05-10T00:00:00.000Z"',
      "---",
      "",
      "# Mixed"
    ].join("\n"));

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.ok(result.issues.some((issue) =>
      issue.kind === "wiki_page_malformed" &&
      issue.path === "knowledge-base/pages/mixed.md"
    ));
    assert.ok(!result.issues.some((issue) =>
      issue.kind === "wiki_page_evidence_weak" &&
      issue.path === "knowledge-base/pages/mixed.md"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports source summaries without metadata", async () => {
  const workspace = await createWorkspace();

  try {
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2401.00999.pdf");
    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeJson(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00999", "acquisition.json"), {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.00999",
      recordedAt: "2026-05-10T00:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.00999",
      pdfUrl: "https://arxiv.org/pdf/2401.00999.pdf",
      downloadPath: pdfPath
    });
    const parsedDir = path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00999", "parses", "plain-text-baseline");
    await writeText(path.join(parsedDir, "document.md"), "A complete parse about wiki metadata.");
    await writeJson(path.join(parsedDir, "parse.json"), { paperKey: "arxiv-2401.00999", engine: "plain-text-baseline" });
    await writeJson(path.join(parsedDir, "quality.json"), {
      status: "good",
      score: 0.9,
      pages: 1,
      totalTextLength: 2000,
      emptyPageCount: 0,
      headingCount: 1,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: []
    });
    await writeText(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00999", "summary.md"), [
      "---",
      "type: \"paper-source-summary\"",
      "paper_key: \"arxiv-2401.00999\"",
      "title: \"Metadata gap\"",
      "---",
      "",
      "# Metadata gap",
      ""
    ].join("\n"));

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.source_metadata_missing, 1);
    const issue = result.issues.find((candidate) =>
      candidate.kind === "source_metadata_missing" &&
      candidate.paperKey === "arxiv-2401.00999"
    );
    assert.ok(issue);
    assert.equal(issue.path, "knowledge-base/sources/arxiv-2401.00999/metadata.json");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports source_metadata_malformed for invalid metadata json", async () => {
  const workspace = await createWorkspace();

  try {
    const sourceKey = "arxiv-2601.malformed";
    await writeText(path.join(workspace, "knowledge-base", "sources", sourceKey, "metadata.json"), "{not json");

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.source_metadata_malformed, 1);
    const issue = result.issues.find((candidate) =>
      candidate.kind === "source_metadata_malformed" &&
      candidate.paperKey === sourceKey
    );
    assert.ok(issue);
    assert.equal(issue.path, `knowledge-base/sources/${sourceKey}/metadata.json`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports source_metadata_artifact_missing for metadata paths", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "arxiv-2601.00042";
    await writeJson(path.join(workspace, "knowledge-base", "sources", paperKey, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: paperKey,
      title: "Missing manifest artifacts",
      status: "ready",
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${paperKey}/summary.md`,
      citation: {
        citationStatus: "complete",
        missingFields: []
      },
      provenance: {
        acquisitionPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
        rawPath: `knowledge-base/raw/pdfs/${paperKey}.pdf`
      },
      artifacts: [{
        kind: "parse",
        path: `knowledge-base/sources/${paperKey}/parses/plain-text-baseline/document.md`,
        markdownPath: `knowledge-base/sources/${paperKey}/parses/plain-text-baseline/document.md`,
        jsonPath: `knowledge-base/sources/${paperKey}/parses/plain-text-baseline/parse.json`,
        qualityPath: `knowledge-base/sources/${paperKey}/parses/plain-text-baseline/quality.json`
      }],
      tags: ["manifest-health"],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.source_metadata_artifact_missing, 1);
    assert.ok(result.issues.some((issue) =>
      issue.kind === "source_metadata_artifact_missing" &&
      issue.paperKey === paperKey
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth does not report source_metadata_artifact_missing for a missing planned summary", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "nature-nature14270";
    const rawPath = path.join(workspace, "knowledge-base", "raw", "pdfs", `${paperKey}.pdf`);
    await writeText(rawPath, "%PDF-1.7\nnature pdf\n");
    await writeJson(path.join(workspace, "knowledge-base", "sources", paperKey, "acquisition.json"), {
      source: "nature",
      articleUrl: "https://www.nature.com/articles/nature14270",
      recordedAt: "2026-05-26T17:10:14.196Z",
      handlingMethod: "browser_session",
      status: "downloaded",
      canonicalId: "nature14270",
      pdfUrl: "https://www.nature.com/articles/nature14270.pdf",
      downloadPath: rawPath,
      reading: {
        status: "ready",
        updatedAt: "2026-05-26T17:10:14.196Z",
        preferredSource: "webpage"
      }
    });
    await writeJson(path.join(workspace, "knowledge-base", "sources", paperKey, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: paperKey,
      title: "State preservation by repetitive error detection in a superconducting quantum circuit",
      status: "ready",
      createdAt: "2026-05-26T17:10:14.196Z",
      updatedAt: "2026-05-26T17:10:14.196Z",
      summaryPath: `knowledge-base/sources/${paperKey}/summary.md`,
      citation: {
        citationStatus: "complete",
        missingFields: [],
        doi: "10.1038/nature14270",
        authors: ["J. Kelly"],
        year: 2015,
        venue: "Nature"
      },
      provenance: {
        url: "https://www.nature.com/articles/nature14270",
        source: "nature",
        canonicalId: "nature14270",
        acquisitionPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
        recordPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
        rawPath: `knowledge-base/raw/pdfs/${paperKey}.pdf`
      },
      artifacts: [{
        kind: "raw",
        path: `knowledge-base/raw/pdfs/${paperKey}.pdf`
      }],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.source_metadata_artifact_missing, 0);
    assert.ok(!result.issues.some((issue) =>
      issue.kind === "source_metadata_artifact_missing" &&
      issue.paperKey === paperKey
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports source_metadata_artifact_missing for metadata artifact paths", async () => {
  const workspace = await createWorkspace();

  try {
    const sourceKey = "material-sapphire-permittivity";
    await writeText(
      path.join(workspace, "knowledge-base", "sources", sourceKey, "summary.md"),
      "# Sapphire permittivity\n\nMaterial parameter evidence."
    );
    await writeJson(path.join(workspace, "knowledge-base", "sources", sourceKey, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "material-database",
      sourceKey,
      title: "Sapphire permittivity values",
      status: "ready",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${sourceKey}/summary.md`,
      provenance: {
        acquisitionPath: `knowledge-base/records/${sourceKey}.json`,
        rawPath: `knowledge-base/sources/${sourceKey}/raw/snapshot.html`
      },
      citation: {
        citationStatus: "complete",
        missingFields: []
      },
      artifacts: [
        {
          kind: "table",
          path: `knowledge-base/sources/${sourceKey}/tables/parameters.json`,
          qualityPath: `knowledge-base/sources/${sourceKey}/tables/quality.json`
        }
      ],
      tags: ["materials", "sapphire"],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.source_metadata_artifact_missing, 1);
    const issue = result.issues.find((candidate) =>
      candidate.kind === "source_metadata_artifact_missing" &&
      candidate.paperKey === sourceKey
    );
    assert.ok(issue);
    assert.match(issue.reason, /knowledge-base\/records/);
    assert.match(issue.reason, /parameters\.json/);
    assert.match(issue.reason, /quality\.json/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports source_metadata_artifact_missing for missing metadata acquisitionPath", async () => {
  const workspace = await createWorkspace();

  try {
    const sourceKey = "arxiv-2601-record-missing";
    await writeText(
      path.join(workspace, "knowledge-base", "sources", sourceKey, "summary.md"),
      "# Missing record path\n\nMetadata points at a missing acquisition record."
    );
    await writeJson(path.join(workspace, "knowledge-base", "sources", sourceKey, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey,
      title: "Missing record path",
      status: "ready",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${sourceKey}/summary.md`,
      citation: {
        citationStatus: "complete",
        missingFields: []
      },
      provenance: {
        acquisitionPath: `knowledge-base/sources/${sourceKey}/acquisition.json`
      },
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.source_metadata_artifact_missing, 1);
    const issue = result.issues.find((candidate) =>
      candidate.kind === "source_metadata_artifact_missing" &&
      candidate.paperKey === sourceKey
    );
    assert.ok(issue);
    assert.match(issue.reason, /acquisition\.json/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports source_metadata_artifact_missing for unsafe metadata paths", async () => {
  const workspace = await createWorkspace();
  const outside = await createWorkspace();

  try {
    const absolutePaperKey = "arxiv-2601.absolute";
    const traversalPaperKey = "arxiv-2601-traversal";
    const outsideAbsolutePath = path.join(outside, "absolute-summary.md");
    const outsideTraversalPath = path.join(path.dirname(workspace), "outside-summary.md");
    await writeText(outsideAbsolutePath, "outside absolute file exists");
    await writeText(outsideTraversalPath, "outside traversal file exists");

    await writeJson(path.join(workspace, "knowledge-base", "sources", absolutePaperKey, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: absolutePaperKey,
      title: "Absolute manifest path",
      status: "ready",
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      summaryPath: outsideAbsolutePath,
      citation: { citationStatus: "complete", missingFields: [] },
      provenance: {},
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });
    await writeJson(path.join(workspace, "knowledge-base", "sources", traversalPaperKey, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: traversalPaperKey,
      title: "Traversal manifest path",
      status: "ready",
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      summaryPath: "../outside-summary.md",
      citation: { citationStatus: "complete", missingFields: [] },
      provenance: {},
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.ok(result.summary.source_metadata_artifact_missing >= 2);
    assert.ok(result.issues.some((issue) =>
      issue.kind === "source_metadata_artifact_missing" &&
      issue.paperKey === absolutePaperKey &&
      issue.reason.includes("workspace-relative")
    ));
    assert.ok(result.issues.some((issue) =>
      issue.kind === "source_metadata_artifact_missing" &&
      issue.paperKey === traversalPaperKey &&
      issue.reason.includes("workspace-relative")
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports source_metadata_artifact_missing for unsafe metadata acquisitionPath", async () => {
  const workspace = await createWorkspace();
  const outside = await createWorkspace();

  try {
    const absoluteSourceKey = "arxiv-2601-record-absolute";
    const traversalSourceKey = "arxiv-2601-record-traversal";
    const outsideRecordPath = path.join(outside, "acquisition.json");
    await writeText(outsideRecordPath, "{\"status\":\"outside\"}\n");
    await writeText(
      path.join(workspace, "knowledge-base", "sources", absoluteSourceKey, "summary.md"),
      "# Absolute record path\n"
    );
    await writeText(
      path.join(workspace, "knowledge-base", "sources", traversalSourceKey, "summary.md"),
      "# Traversal record path\n"
    );
    await writeJson(path.join(workspace, "knowledge-base", "sources", absoluteSourceKey, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: absoluteSourceKey,
      title: "Absolute record path",
      status: "ready",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${absoluteSourceKey}/summary.md`,
      citation: { citationStatus: "complete", missingFields: [] },
      provenance: {
        acquisitionPath: outsideRecordPath
      },
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });
    await writeJson(path.join(workspace, "knowledge-base", "sources", traversalSourceKey, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: traversalSourceKey,
      title: "Traversal record path",
      status: "ready",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${traversalSourceKey}/summary.md`,
      citation: { citationStatus: "complete", missingFields: [] },
      provenance: {
        acquisitionPath: "../outside-acquisition.json"
      },
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.ok(result.summary.source_metadata_artifact_missing >= 2);
    assert.ok(result.issues.some((issue) =>
      issue.kind === "source_metadata_artifact_missing" &&
      issue.paperKey === absoluteSourceKey &&
      issue.reason.includes("workspace-relative")
    ));
    assert.ok(result.issues.some((issue) =>
      issue.kind === "source_metadata_artifact_missing" &&
      issue.paperKey === traversalSourceKey &&
      issue.reason.includes("workspace-relative")
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("fixWikiHealth skips source metadata repair instead of backfilling from summaries", async () => {
  const workspace = await createWorkspace();

  try {
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2401.01000.pdf");
    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeJson(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.01000", "acquisition.json"), {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.01000",
      recordedAt: "2026-05-10T00:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.01000",
      pdfUrl: "https://arxiv.org/pdf/2401.01000.pdf",
      downloadPath: pdfPath
    });
    const parsedDir = path.join(workspace, "knowledge-base", "sources", "arxiv-2401.01000", "parses", "plain-text-baseline");
    await writeText(path.join(parsedDir, "document.md"), "A complete parse about metadata backfill.");
    await writeJson(path.join(parsedDir, "parse.json"), { paperKey: "arxiv-2401.01000", engine: "plain-text-baseline" });
    await writeJson(path.join(parsedDir, "quality.json"), {
      status: "good",
      score: 0.9,
      pages: 1,
      totalTextLength: 2000,
      emptyPageCount: 0,
      headingCount: 1,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: []
    });
    await writeText(
      path.join(workspace, "knowledge-base", "sources", "arxiv-2401.01000", "summary.md"),
      "# Metadata backfill\n\nSummary body only.\n"
    );

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["source_metadata_missing"]
    });

    assert.equal(result.fixed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.results[0]?.status, "skipped");
    assert.match(result.results[0]?.message ?? "", /metadata\.json .* must be regenerated from acquisition or source metadata/i);
    await assert.rejects(readFile(
      path.join(workspace, "knowledge-base", "sources", "arxiv-2401.01000", "metadata.json"),
      "utf8"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixWikiHealth does not create source metadata from summary-only source directories", async () => {
  const workspace = await createWorkspace();

  try {
    await writeText(
      path.join(workspace, "knowledge-base", "sources", "source-a", "summary.md"),
      "# Mismatched summary key\n\nSummary body only.\n"
    );

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["source_metadata_missing"]
    });

    assert.equal(result.fixed, 0);
    assert.equal(result.skipped, 1);
    await assert.rejects(readFile(
      path.join(workspace, "knowledge-base", "sources", "source-a", "metadata.json"),
      "utf8"
    ));
    await assert.rejects(readFile(
      path.join(workspace, "knowledge-base", "sources", "source-b", "metadata.json"),
      "utf8"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth accepts ready webpage reading when PDF parsing failed later", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "nature-s41567-025-03102-5";
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", `${paperKey}.pdf`);
    const sourceDir = path.join(workspace, "knowledge-base", "sources", paperKey);
    const parseDir = path.join(sourceDir, "parses", "webpage");
    const chunksPath = path.join(parseDir, "chunks.jsonl");
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
    await writePaperMetadata(path.join(sourceDir, "metadata.json"), {
      paperKey,
      source: "nature",
      canonicalId: "s41567-025-03102-5",
      articleUrl: "https://www.nature.com/articles/s41567-025-03102-5",
      pdfPath
    });
    await writeJson(path.join(workspace, "knowledge-base", "sources", paperKey, "acquisition.json"), {
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
    const paperDir = path.join(workspace, "knowledge-base", "sources", paperKey);
    const parseDir = path.join(paperDir, "parses", "webpage");
    await writePaperMetadata(path.join(paperDir, "metadata.json"), {
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
    await writeText(path.join(parseDir, "chunks.jsonl"), "{\"id\":\"chunk-1\"}\n");

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

test("checkWikiHealth preserves Science license failures from extension history when webpage parsing exists", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "science-10.1126-science.ado6285";
    const articleUrl = "https://www.science.org/doi/10.1126/science.ado6285";
    const paperDir = path.join(workspace, "knowledge-base", "sources", paperKey);
    const parseDir = path.join(paperDir, "parses", "webpage");
    await writePaperMetadata(path.join(paperDir, "metadata.json"), {
      paperKey,
      source: "science",
      canonicalId: "10.1126/science.ado6285",
      articleUrl,
      title: "Beyond-classical computation in quantum simulation"
    });
    await writeText(path.join(parseDir, "document.md"), "# Abstract\n\nFull Science webpage text.");
    await writeJson(path.join(parseDir, "parse.json"), {
      paperKey,
      engine: "webpage"
    });
    await writeJson(path.join(parseDir, "quality.json"), {
      status: "good",
      score: 1,
      pages: 1,
      totalTextLength: 65200,
      emptyPageCount: 0,
      headingCount: 16,
      tableCount: 0,
      figureOrCaptionCount: 5,
      warnings: []
    });
    await writeText(path.join(parseDir, "chunks.jsonl"), "{\"id\":\"chunk-1\"}\n");
    await appendPaperDownloadJobEvent({
      workspaceDir: workspace,
      event: {
        jobId: "paper-science-license",
        recordedAt: "2026-05-06T05:07:22.400Z",
        status: "automatic_download_failed",
        articleUrl,
        source: "science",
        failureCode: "publisher_license_not_permitted",
        message: "Science reports that the current license does not permit this publication to be downloaded. The article webpage may still be readable, but the publisher PDF cannot be downloaded with the current account or institutional license."
      }
    });
    await appendPaperDownloadJobEvent({
      workspaceDir: workspace,
      event: {
        jobId: "paper-science-retry",
        recordedAt: "2026-05-06T05:49:30.833Z",
        status: "awaiting_user_manual_download",
        articleUrl,
        source: "science",
        message: "Science returned an HTML page instead of the article PDF. Log in or complete publisher verification in the browser extension tab, then retry the download."
      }
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.needs_authorization, 1);
    assert.equal(result.summary.needs_download, 0);
    assert.equal(result.summary.summary_missing, 1);
    const issue = result.issues.find((candidate) =>
      candidate.kind === "needs_authorization" && candidate.paperKey === paperKey
    );
    assert.ok(issue);
    assert.equal(issue.severity, "medium");
    assert.match(issue.reason, /current license does not permit/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth treats APS automatic PDF fetch as queued instead of authorization failure", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "aps-10.1103-PhysRevLett.111.080502";
    const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502";
    const paperDir = path.join(workspace, "knowledge-base", "sources", paperKey);
    const parseDir = path.join(paperDir, "parses", "webpage");
    await writePaperMetadata(path.join(paperDir, "metadata.json"), {
      paperKey,
      source: "aps",
      canonicalId: "10.1103/PhysRevLett.111.080502",
      articleUrl,
      title: "Coherent Josephson Qubit Suitable for Scalable Quantum Integrated Circuits"
    });
    await writeText(path.join(parseDir, "document.md"), "# Abstract\n\nFull APS article text.\n\n## Article Text\n\nLong body.");
    await writeJson(path.join(parseDir, "parse.json"), {
      paperKey,
      engine: "webpage"
    });
    await writeJson(path.join(parseDir, "quality.json"), {
      status: "good",
      score: 1,
      pages: 1,
      totalTextLength: 25532,
      emptyPageCount: 0,
      headingCount: 6,
      tableCount: 0,
      figureOrCaptionCount: 4,
      warnings: []
    });
    await writeText(path.join(parseDir, "chunks.jsonl"), "{\"id\":\"chunk-1\"}\n");
    await appendPaperDownloadJobEvent({
      workspaceDir: workspace,
      event: {
        jobId: "paper-aps-fetch",
        recordedAt: "2026-05-26T08:57:53.864Z",
        status: "automatic_download_started",
        articleUrl,
        source: "aps",
        message: "Started automatic PDF fetch with browser credentials."
      }
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.needs_authorization, 0);
    assert.equal(result.summary.needs_download, 0);
    assert.equal(result.summary.queued, 1);
    assert.ok(result.issues.some((issue) => issue.kind === "queued" && issue.paperKey === paperKey));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth downgrades blocklisted download issues without hiding summary gaps", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "science-10.1126-science.ado6285";
    const articleUrl = "https://www.science.org/doi/10.1126/science.ado6285";
    const paperDir = path.join(workspace, "knowledge-base", "sources", paperKey);
    const parseDir = path.join(paperDir, "parses", "webpage");
    await writePaperMetadata(path.join(paperDir, "metadata.json"), {
      paperKey,
      source: "science",
      canonicalId: "10.1126/science.ado6285",
      articleUrl,
      title: "Beyond-classical computation in quantum simulation"
    });
    await writeText(path.join(parseDir, "document.md"), "# Abstract\n\nFull Science webpage text.");
    await writeJson(path.join(parseDir, "parse.json"), {
      paperKey,
      engine: "webpage"
    });
    await writeJson(path.join(parseDir, "quality.json"), {
      status: "good",
      score: 1,
      pages: 1,
      totalTextLength: 65200,
      emptyPageCount: 0,
      headingCount: 16,
      tableCount: 0,
      figureOrCaptionCount: 5,
      warnings: []
    });
    await writeText(path.join(parseDir, "chunks.jsonl"), "{\"id\":\"chunk-1\"}\n");
    await appendPaperDownloadJobEvent({
      workspaceDir: workspace,
      event: {
        jobId: "paper-science-license",
        recordedAt: "2026-05-06T05:07:22.400Z",
        status: "automatic_download_failed",
        articleUrl,
        source: "science",
        failureCode: "publisher_license_not_permitted",
        message: "Science reports that the current license does not permit this publication to be downloaded."
      }
    });
    await appendPaperDownloadJobEvent({
      workspaceDir: workspace,
      event: {
        jobId: "paper-science-stale-observed",
        recordedAt: "2026-05-06T05:49:30.833Z",
        status: "manual_download_observed",
        articleUrl,
        source: "science",
        message: "Observed a browser PDF download."
      }
    });
    await blockPaperDownload({
      workspaceDir: workspace,
      paperKey,
      source: "science",
      canonicalId: "10.1126/science.ado6285",
      articleUrl,
      title: "Beyond-classical computation in quantum simulation",
      reasonCode: "license_denied",
      note: "Science license does not permit PDF download.",
      createdAt: "2026-05-06T06:00:00.000Z"
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.needs_authorization, 0);
    assert.equal(result.summary.needs_download, 0);
    assert.equal(result.summary.queued, 0);
    assert.equal(result.summary.download_blocked, 1);
    assert.equal(result.summary.summary_missing, 1);
    const blockedIssue = result.issues.find((candidate) =>
      candidate.kind === "download_blocked" && candidate.paperKey === paperKey
    );
    assert.ok(blockedIssue);
    assert.equal(blockedIssue.severity, "low");
    assert.match(blockedIssue.reason, /local download blocklist/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports Cloudflare extension handoff as user authorization", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "aps-10.1103-nv7d-k3wr";
    const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/NV7D-K3WR";
    await writePaperMetadata(path.join(workspace, "knowledge-base", "sources", paperKey, "metadata.json"), {
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
    const paperDir = path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00007");
    await writePaperMetadata(path.join(paperDir, "metadata.json"), {
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
    const arxivRecordPath = path.join(workspace, "knowledge-base", "sources", "arxiv-2601.01234", "acquisition.json");
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
    await writeJson(path.join(workspace, "knowledge-base", "sources", "aps-10.1103-k3d5-v43c", "acquisition.json"), {
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
      "knowledge-base", "sources",
      "journals.aps.org-prapplied-accepted-10.1103-k3d5-v43c"
    );
    await writePaperMetadata(path.join(legacyPaperDir, "metadata.json"), {
      paperKey: "journals.aps.org-prapplied-accepted-10.1103-k3d5-v43c",
      title: "Superconducting qubits in the millions: The potential and limitations of modularity",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/k3d5-v43c",
      source: "aps",
      canonicalId: "10.1103/k3d5-v43c"
    });
    await writeJson(path.join(legacyPaperDir, "acquisition.json"), {
      source: "aps",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/k3d5-v43c",
      recordedAt: "2026-04-28T04:01:30.000Z",
      handlingMethod: "arxiv_preprint_fallback",
      status: "preprint_fallback",
      canonicalId: "10.1103/k3d5-v43c",
      title: "Superconducting qubits in the millions: The potential and limitations of modularity",
      preprint: {
        source: "arxiv",
        canonicalId: "2601.01234",
        articleUrl: "https://arxiv.org/abs/2601.01234",
        recordPath: arxivRecordPath,
        downloadPath: arxivPdfPath,
        status: "downloaded"
      }
    });
    await writeText(
      path.join(legacyPaperDir, "summary.md"),
      "---\ntitle: \"Superconducting qubits in the millions: The potential and limitations of modularity\"\n---\n\n# Superconducting qubits in the millions\n"
    );
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
    assert.ok(!result.issues.some((issue) => issue.kind !== "citation_incomplete" && issue.paperKey === "aps-10.1103-k3d5-v43c"));
    assert.ok(!result.issues.some((issue) => issue.kind !== "citation_incomplete" && issue.paperKey === "journals.aps.org-prapplied-accepted-10.1103-k3d5-v43c"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth ignores stale APS authorization jobs when arXiv fallback is parsed", async () => {
  const workspace = await createWorkspace();

  try {
    const articleUrl = "https://journals.aps.org/prapplied/accepted/10.1103/k3d5-v43c";
    const arxivPdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2406.06015.pdf");
    const arxivRecordPath = path.join(workspace, "knowledge-base", "sources", "arxiv-2406.06015", "acquisition.json");
    await writeText(arxivPdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeJson(arxivRecordPath, {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2406.06015",
      recordedAt: "2026-05-25T06:40:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2406.06015",
      pdfUrl: "https://arxiv.org/pdf/2406.06015",
      downloadPath: arxivPdfPath
    });
    await writePaperMetadata(path.join(workspace, "knowledge-base", "sources", "arxiv-2406.06015", "metadata.json"), {
      paperKey: "arxiv-2406.06015",
      source: "arxiv",
      canonicalId: "2406.06015",
      articleUrl: "https://arxiv.org/abs/2406.06015",
      title: "Superconducting qubits in the millions: the potential and limitations of modularity",
      pdfPath: arxivPdfPath
    });
    await writeText(
      path.join(workspace, "knowledge-base", "sources", "arxiv-2406.06015", "parses", "opendataloader-local", "document.md"),
      "Full parsed arXiv fallback text."
    );
    await writeJson(
      path.join(workspace, "knowledge-base", "sources", "arxiv-2406.06015", "parses", "opendataloader-local", "quality.json"),
      {
        status: "good",
        score: 0.99,
        pages: 34,
        totalTextLength: 127158,
        emptyPageCount: 0,
        headingCount: 20,
        tableCount: 3,
        figureOrCaptionCount: 18,
        warnings: []
      }
    );
    await writeJson(path.join(workspace, "knowledge-base", "sources", "aps-10.1103-k3d5-v43c", "acquisition.json"), {
      source: "aps",
      articleUrl,
      recordedAt: "2026-05-25T06:43:00.304Z",
      handlingMethod: "arxiv_preprint_fallback",
      status: "preprint_fallback",
      canonicalId: "10.1103/k3d5-v43c",
      title: "Superconducting qubits in the millions: The potential and limitations of modularity",
      preprint: {
        source: "arxiv",
        canonicalId: "2406.06015",
        articleUrl: "https://arxiv.org/abs/2406.06015",
        pdfUrl: "https://arxiv.org/pdf/2406.06015",
        recordPath: arxivRecordPath,
        downloadPath: arxivPdfPath,
        status: "already_downloaded"
      },
      failure: {
        code: "publisher_version_not_available",
        message: "Publisher PDF was not downloaded automatically; using matching arXiv preprint 2406.06015."
      },
      reading: {
        status: "not_ready",
        reason: "Publisher version is not available yet; using arXiv preprint 2406.06015."
      }
    });
    await writePaperMetadata(path.join(workspace, "knowledge-base", "sources", "aps-10.1103-k3d5-v43c", "metadata.json"), {
      paperKey: "aps-10.1103-k3d5-v43c",
      source: "aps",
      canonicalId: "10.1103/k3d5-v43c",
      articleUrl,
      title: "Superconducting qubits in the millions: The potential and limitations of modularity",
      citationStatus: "complete"
    });
    await writeText(
      path.join(workspace, "knowledge-base", "sources", "aps-10.1103-k3d5-v43c", "parses", "webpage", "document.md"),
      "Accepted paper abstract."
    );
    await writeJson(
      path.join(workspace, "knowledge-base", "sources", "aps-10.1103-k3d5-v43c", "parses", "webpage", "quality.json"),
      {
        status: "poor",
        score: 0.2,
        pages: 1,
        totalTextLength: 202,
        warnings: ["No main body sections were detected; prefer PDF parsing."]
      }
    );
    await appendPaperDownloadJobEvent({
      workspaceDir: workspace,
      event: {
        jobId: "paper-aps-k3d5",
        recordedAt: "2026-05-25T06:41:00.000Z",
        status: "webpage_snapshot_ready",
        articleUrl,
        source: "aps",
        purpose: "download_and_webpage",
        paperKey: "aps-10.1103-k3d5-v43c",
        message: "The webpage snapshot was captured but does not look complete enough to start PDF download. Log in or verify article access, refresh the page, then retry. Quality: needs_hybrid (score 0.55)."
      }
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });

    assert.equal(result.summary.needs_authorization, 0);
    assert.ok(!result.issues.some((issue) => issue.kind === "needs_authorization" && issue.paperKey === "aps-10.1103-k3d5-v43c"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth treats accepted publisher-pending records as non-actionable", async () => {
  const workspace = await createWorkspace();

  try {
    await writeJson(path.join(workspace, "knowledge-base", "sources", "aps-10.1103-rp4w-3n7l", "acquisition.json"), {
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
    await appendPaperDownloadJobEvent({
      workspaceDir: workspace,
      event: {
        jobId: "paper-aps-rp4w",
        recordedAt: "2026-05-26T07:42:00.000Z",
        status: "awaiting_user_verification",
        articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/rp4w-3n7l",
        source: "aps",
        message: "The webpage snapshot was captured but does not look complete enough to start PDF download. Log in or verify article access, refresh the page, then retry. Quality: needs_hybrid (score 0.55)."
      }
    });
    const legacyPaperDir = path.join(
      workspace,
      "knowledge-base", "sources",
      "journals.aps.org-prapplied-accepted-10.1103-rp4w-3n7l"
    );
    await writePaperMetadata(path.join(legacyPaperDir, "metadata.json"), {
      paperKey: "journals.aps.org-prapplied-accepted-10.1103-rp4w-3n7l",
      title: "Design and application of N[3]CZ: A controlled-Z gate between next-nearest-neighbor superconducting qubits",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/rp4w-3n7l",
      source: "aps",
      canonicalId: "10.1103/rp4w-3n7l"
    });
    await writeJson(path.join(legacyPaperDir, "acquisition.json"), {
      source: "aps",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/rp4w-3n7l",
      recordedAt: "2026-04-28T04:01:30.000Z",
      handlingMethod: "accepted_paper",
      status: "publisher_pending",
      canonicalId: "10.1103/rp4w-3n7l",
      title: "Design and application of N[3]CZ: A controlled-Z gate between next-nearest-neighbor superconducting qubits"
    });
    await writeText(
      path.join(legacyPaperDir, "summary.md"),
      "---\ntitle: \"Design and application of N[3]CZ: A controlled-Z gate between next-nearest-neighbor superconducting qubits\"\n---\n\n# Design and application of N3CZ\n"
    );
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
    assert.ok(!result.issues.some((issue) => issue.kind !== "citation_incomplete" && issue.paperKey === "aps-10.1103-rp4w-3n7l"));
    assert.ok(!result.issues.some((issue) => issue.kind !== "citation_incomplete" && issue.paperKey === "journals.aps.org-prapplied-accepted-10.1103-rp4w-3n7l"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth reports publisher-pending records with captured APS Not Found pages", async () => {
  const workspace = await createWorkspace();

  try {
    const sourceDir = path.join(workspace, "knowledge-base", "sources", "aps-10.1103-rp4w-3n7l");
    await writeJson(path.join(sourceDir, "acquisition.json"), {
      source: "aps",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/rp4w-3n7l",
      recordedAt: "2026-05-25T06:43:10.713Z",
      handlingMethod: "accepted_paper",
      status: "publisher_pending",
      canonicalId: "10.1103/rp4w-3n7l",
      title: "Design and application of N[3]CZ: A controlled-Z gate between next-nearest-neighbor superconducting qubits",
      failure: {
        code: "publisher_version_not_available",
        message: "Publisher page is an accepted paper without a formal PDF yet, and no exact-title arXiv preprint was found."
      }
    });
    await writePaperMetadata(path.join(sourceDir, "metadata.json"), {
      paperKey: "aps-10.1103-rp4w-3n7l",
      title: "Design and application of N[3]CZ: A controlled-Z gate between next-nearest-neighbor superconducting qubits",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/rp4w-3n7l",
      source: "aps",
      canonicalId: "10.1103/rp4w-3n7l"
    });
    await writeText(
      path.join(sourceDir, "parses", "webpage", "document.md"),
      "Not Found\n\nThe page you requested could not be found, please check the link and try again.\n\nArticle Lookup"
    );
    await writeJson(path.join(sourceDir, "parses", "webpage", "quality.json"), {
      status: "poor",
      score: 0.2,
      pages: 1,
      totalTextLength: 103,
      emptyPageCount: 0,
      headingCount: 2,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: [
        "Extracted text is short for a scientific paper.",
        "No main body sections were detected; prefer PDF parsing."
      ]
    });

    const result = await checkWikiHealth({ workspaceDir: workspace });
    const issue = result.issues.find((candidate) =>
      candidate.kind === "low_quality" &&
      candidate.paperKey === "aps-10.1103-rp4w-3n7l"
    );

    assert.equal(result.summary.low_quality, 1);
    assert.ok(issue);
    assert.equal(issue.quality?.status, "poor");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkWikiHealth treats a good webpage parse as readable but not PDF-downloaded", async () => {
  const workspace = await createWorkspace();

  try {
    await writeJson(path.join(workspace, "knowledge-base", "sources", "nature-s41567-022-01591-2", "acquisition.json"), {
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
      "knowledge-base", "sources",
      "nature-s41567-022-01591-2",
      "parses",
      "webpage"
    );
    await writePaperMetadata(path.join(workspace, "knowledge-base", "sources", "nature-s41567-022-01591-2", "metadata.json"), {
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
    const recordPath = path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00004", "acquisition.json");
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
      "knowledge-base", "sources",
      "arxiv-2401.00004",
      "parses",
      "plain-text-baseline"
    );
    const chunksPath = path.join(
      artifactRoot,
      "chunks.jsonl"
    );
    const parseResult: PaperParseResult = {
      status: "parsed",
      paperKey: "arxiv-2401.00004",
      engine: "plain-text-baseline",
      pdfSha256: "sha-test",
      artifacts: {
        metadataPath: path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00004", "metadata.json"),
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
        assert.equal(options.recordPath, "knowledge-base/sources/arxiv-2401.00004/acquisition.json");
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
      "knowledge-base/sources/arxiv-2401.00004/parses/plain-text-baseline/document.md"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixWikiHealth does not enable browser fallback for missing publisher PDFs", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "science-10.1126-sciadv.adp6388";
    const paperDir = path.join(workspace, "knowledge-base", "sources", paperKey);
    await writePaperMetadata(path.join(paperDir, "metadata.json"), {
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

test("fixWikiHealth delegates citation metadata refresh to the paper download worker", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "arxiv-2401.00009";
    const recordPath = path.join(workspace, "knowledge-base", "sources", paperKey, "acquisition.json");
    const metadataPath = path.join(workspace, "knowledge-base", "sources", paperKey, "metadata.json");
    const calls: Array<{ paperKey: string; recordPath?: string; sourcePath?: string }> = [];
    await writeJson(recordPath, {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.00009",
      recordedAt: "2026-04-28T04:30:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.00009",
      pdfUrl: "https://arxiv.org/pdf/2401.00009.pdf",
      downloadPath: path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2401.00009.pdf")
    });
    await writeJson(metadataPath, {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: paperKey,
      title: "A paper with incomplete citation metadata",
      status: "citation_incomplete",
      createdAt: "2026-04-28T04:30:00.000Z",
      updatedAt: "2026-04-28T04:30:00.000Z",
      summaryPath: `knowledge-base/sources/${paperKey}/summary.md`,
      citation: {
        citationStatus: "incomplete",
        missingFields: ["authors", "venue"],
        authors: [],
        arxivId: "2401.00009",
        resolvedFrom: "acquisition",
        sourceConfidence: "medium"
      },
      provenance: {
        url: "https://arxiv.org/abs/2401.00009",
        arxivId: "2401.00009",
        source: "arxiv",
        canonicalId: "2401.00009",
        acquisitionPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
        recordPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
        downloadStatus: "downloaded",
        recordedAt: "2026-04-28T04:30:00.000Z"
      },
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["citation_incomplete"],
      paperDownloadWorker: {
        downloadPaper: async () => {
          throw new Error("citation metadata refresh must not download the PDF");
        },
        refreshSourceMetadata: async (options) => {
          calls.push({
            paperKey: options.paperKey,
            recordPath: options.recordPath,
            sourcePath: options.sourcePath
          });
          return {
            status: "refreshed",
            sourcePath: options.sourcePath,
            citationStatus: "complete",
            missingFields: [],
            message: "Citation metadata refreshed by paper-download-subagent."
          };
        }
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.paperKey, paperKey);
    assert.equal(calls[0]?.recordPath, `knowledge-base/sources/${paperKey}/acquisition.json`);
    assert.equal(calls[0]?.sourcePath, `knowledge-base/sources/${paperKey}/metadata.json`);
    assert.equal(result.attempted, 1);
    assert.equal(result.fixed, 1);
    assert.equal(result.results[0]?.action, "metadata_refresh");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixWikiHealth refreshes metadata-only citation metadata through the default worker", async () => {
  const workspace = await createWorkspace();
  const originalFetch = globalThis.fetch;

  try {
    const paperKey = "science-10.1126-science.ado6285";
    await writeJson(path.join(workspace, "knowledge-base", "sources", paperKey, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: paperKey,
      title: "Beyond-classical computation in quantum simulation",
      status: "citation_incomplete",
      createdAt: "2026-05-06T04:45:58.636Z",
      updatedAt: "2026-05-06T04:45:58.636Z",
      summaryPath: `knowledge-base/sources/${paperKey}/summary.md`,
      citation: {
        citationStatus: "incomplete",
        missingFields: ["authors", "year", "venue"],
        doi: "10.1126/science.ado6285"
      },
      provenance: {
        url: "https://www.science.org/doi/10.1126/science.ado6285",
        source: "science",
        canonicalId: "10.1126/science.ado6285"
      },
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });
    globalThis.fetch = (async (input) => {
      const url = input.toString();
      if (url === "https://api.crossref.org/works/10.1126%2Fscience.ado6285") {
        return new Response(JSON.stringify({
          message: {
            DOI: "10.1126/science.ado6285",
            title: ["Beyond-classical computation in quantum simulation"]
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.startsWith("https://api.crossref.org/works?")) {
        return new Response(JSON.stringify({ message: { items: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      assert.equal(
        url,
        "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1126%2Fscience.ado6285?fields=title%2Cauthors%2Cyear%2Cvenue%2CpublicationVenue%2CexternalIds"
      );
      return new Response(JSON.stringify({
        title: "Beyond-classical computation in quantum simulation",
        authors: [
          { name: "Adam Smith" },
          { name: "Bao Nguyen" }
        ],
        year: 2025,
        venue: "Science",
        externalIds: { DOI: "10.1126/science.ado6285" }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["citation_incomplete"]
    });

    assert.equal(result.attempted, 1);
    assert.equal(result.fixed, 1);
    assert.equal(result.results[0]?.action, "metadata_refresh");
    const metadata = JSON.parse(await readFile(path.join(workspace, "knowledge-base", "sources", paperKey, "metadata.json"), "utf8"));
    assert.deepEqual(metadata.citation.authors, ["Adam Smith", "Bao Nguyen"]);
    assert.equal(metadata.citation.year, 2025);
    assert.equal(metadata.citation.venue, "Science");
    assert.equal(metadata.citation.citationStatus, "complete");
    assert.deepEqual(metadata.citation.missingFields, []);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixWikiHealth skips user-authored or user-authorized repairs with explicit reasons", async () => {
  const workspace = await createWorkspace();

  try {
    await writeJson(path.join(workspace, "knowledge-base", "sources", "nature-s41586-024-00005-y", "acquisition.json"), {
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
      "knowledge-base", "sources",
      "arxiv-2401.00006",
      "parses",
      "plain-text-baseline"
    );
    await writePaperMetadata(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00006", "metadata.json"), {
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
      path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00006", "parses", "plain-text-baseline", "chunks.jsonl"),
      "{\"id\":\"chunk-1\"}\n"
    );

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["needs_authorization", "summary_missing"],
      downloadPaperImpl: async (options) => ({
        status: "extension_unavailable",
        source: "nature",
        articleUrl: options.url as string,
        failure: {
          code: "extension_unavailable",
          message: "Paper extension bridge is not configured for this test."
        }
      })
    });

    assert.equal(result.fixed, 0);
    assert.equal(result.skipped, 2);
    assert.ok(result.results.some((item) =>
      item.issue.kind === "needs_authorization" &&
      /login|authorization/i.test(item.message)
    ));
    assert.ok(result.results.some((item) =>
      item.issue.kind === "summary_missing" &&
      /Wiki-evidence-worker summary pass is not configured/i.test(item.message)
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixWikiHealth queues browser extension jobs for authorization issues when an opener is configured", async () => {
  const workspace = await createWorkspace();

  try {
    await writeJson(path.join(workspace, "knowledge-base", "sources", "science-10.1126-sciadv.adp6388", "acquisition.json"), {
      source: "science",
      articleUrl: "https://www.science.org/doi/10.1126/sciadv.adp6388",
      openedUrl: "https://www.science.org/doi/10.1126/sciadv.adp6388",
      recordedAt: "2026-05-06T05:13:15.767Z",
      handlingMethod: "browser_extension",
      status: "manual_fallback_opened",
      canonicalId: "10.1126/sciadv.adp6388",
      title: "High-performance fault-tolerant quantum computing with many-hypercube codes",
      failure: {
        code: "manual_login_required",
        message: "Science requires publisher verification."
      }
    });

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      issueKinds: ["needs_authorization"],
      downloadPaperImpl: async (options) => {
        assert.equal(options.url, "https://www.science.org/doi/10.1126/sciadv.adp6388");
        assert.equal(options.title, "High-performance fault-tolerant quantum computing with many-hypercube codes");
        return {
          status: "extension_job_queued",
          source: "science",
          articleUrl: options.url as string,
          jobId: "paper-science-login",
          message: "Paper download and webpage snapshot job queued for the browser extension."
        };
      }
    });

    assert.equal(result.attempted, 1);
    assert.equal(result.queued, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.results[0]?.action, "authorize");
    assert.match(result.results[0]?.message ?? "", /Browser extension job was queued/);
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
      "knowledge-base", "sources",
      "arxiv-2401.00007",
      "parses",
      "plain-text-baseline"
    );
    await writePaperMetadata(path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00007", "metadata.json"), {
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
      path.join(workspace, "knowledge-base", "sources", "arxiv-2401.00007", "parses", "plain-text-baseline", "chunks.jsonl"),
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
    assert.ok(progressMessages.some((message) => message.includes("Summary 1/1: Running wiki-evidence-worker summary pass")));
    assert.ok(progressMessages.some((message) => message.includes("Finished summary 1/1")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixWikiHealth selects requested issue kinds beyond the health page cap", async () => {
  const workspace = await createWorkspace();
  const generated: string[] = [];

  try {
    for (let index = 0; index < 5; index += 1) {
      await writeJson(path.join(workspace, "knowledge-base", "sources", `missing-${index}`, "acquisition.json"), {
        source: "arxiv",
        articleUrl: `https://arxiv.org/abs/2501.0000${index}`,
        recordedAt: "2026-05-10T00:00:00.000Z",
        handlingMethod: "direct_http",
        status: "failed",
        canonicalId: `2501.0000${index}`
      });
    }

    for (const paperKey of ["arxiv-2501.99998", "arxiv-2501.99999"]) {
      const parsedDir = path.join(workspace, "knowledge-base", "sources", paperKey, "parses", "plain-text-baseline");
      await writePaperMetadata(path.join(workspace, "knowledge-base", "sources", paperKey, "metadata.json"), {
        paperKey,
        source: "arxiv",
        canonicalId: paperKey.replace("arxiv-", ""),
        articleUrl: `https://arxiv.org/abs/${paperKey.replace("arxiv-", "")}`
      });
      await writeText(path.join(parsedDir, "document.md"), "# Paper\n\nThis parsed paper needs a source summary.");
      await writeJson(path.join(parsedDir, "parse.json"), {
        paperKey,
        engine: "plain-text-baseline",
        pdfSha256: `sha-summary-cap-${paperKey}`,
        createdAt: "2026-05-10T00:00:00.000Z",
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
        path.join(workspace, "knowledge-base", "sources", paperKey, "parses", "plain-text-baseline", "chunks.jsonl"),
        "{\"id\":\"chunk-1\"}\n"
      );
    }

    const result = await fixWikiHealth({
      workspaceDir: workspace,
      maxItems: 1,
      issueKinds: ["summary_missing"],
      paperSummaryWorker: async ({ evidence }) => {
        generated.push(evidence.paperKey);
        return {
          summaryMarkdown: "A summary selected beyond the normal health page cap.",
          confidence: "high"
        };
      }
    });

    assert.deepEqual(generated, ["arxiv-2501.99998"]);
    assert.equal(result.attempted, 1);
    assert.equal(result.fixed, 1);
    assert.equal(result.checked.summary.summary_missing, 2);
    assert.equal(result.results[0]?.issue.kind, "summary_missing");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
