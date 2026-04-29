import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePaper } from "../../src/agent/paper-reader/paper-reader.js";
import {
  buildPaperSummaryEvidence,
  generatePaperWikiSummary
} from "../../src/agent/paper-summary.js";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-paper-summary-"));
  await mkdir(path.join(workspace, "knowledge-base", "records"), { recursive: true });
  return workspace;
}

async function writePdf(workspace: string, filename: string, text: string): Promise<string> {
  const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", filename);
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, `%PDF-1.4\n${text}\n%%EOF\n`, "utf8");
  return pdfPath;
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("buildPaperSummaryEvidence returns bounded parsed markdown for a clean summary worker", async () => {
  const workspace = await createWorkspace();

  try {
    const pdfPath = await writePdf(
      workspace,
      "arxiv-2601.01001.pdf",
      "Neutral atom arrays implement programmable quantum simulation with local control. ".repeat(40)
    );
    const parsed = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });

    const evidence = await buildPaperSummaryEvidence({
      workspaceDir: workspace,
      paperKey: parsed.paperKey,
      maxEvidenceChars: 1000
    });

    assert.equal(evidence.paperKey, "arxiv-2601.01001");
    assert.equal(evidence.engine, "plain-text-baseline");
    assert.equal(evidence.markdown.length, 1000);
    assert.equal(evidence.truncated, true);
    assert.equal(evidence.paths.parseMarkdown, "knowledge-base/wiki/sources/arxiv-2601.01001/parses/plain-text-baseline/document.md");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("generatePaperWikiSummary writes a wiki source through an injected summary worker", async () => {
  const workspace = await createWorkspace();
  const receivedEvidence: string[] = [];
  const progressStages: string[] = [];

  try {
    const pdfPath = await writePdf(
      workspace,
      "arxiv-2601.01002.pdf",
      "A quantum processor uses repeated stabilizer measurements to detect correlated errors."
    );
    const parsed = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });

    const result = await generatePaperWikiSummary({
      workspaceDir: workspace,
      paperKey: parsed.paperKey,
      mode: "write",
      force: true,
      onProgress: (progress) => {
        progressStages.push(progress.stage);
      },
      summaryWorker: async ({ evidence }) => {
        receivedEvidence.push(evidence.markdown);
        return {
          summaryMarkdown:
            "This paper summary is grounded in parsed text about repeated stabilizer measurements.",
          tags: ["quantum-error-correction"],
          keyFindings: ["Repeated stabilizer measurements are used to detect correlated errors."],
          confidence: "high"
        };
      }
    });

    assert.equal(result.status, "written");
    assert.equal(receivedEvidence.length, 1);
    assert.match(receivedEvidence[0], /stabilizer measurements/);
    assert.equal(result.source?.sourcePath, "knowledge-base/wiki/sources/arxiv-2601.01002.md");
    const markdown = await readFile(path.join(workspace, result.source!.sourcePath), "utf8");
    assert.match(markdown, /paper-source-summary/);
    assert.match(markdown, /Repeated stabilizer measurements/);
    assert.deepEqual(progressStages, [
      "building_evidence",
      "evidence_ready",
      "summary_worker_start",
      "summary_worker_done",
      "writing_summary",
      "summary_written"
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("generatePaperWikiSummary reports a missing worker without writing content", async () => {
  const workspace = await createWorkspace();

  try {
    const pdfPath = await writePdf(
      workspace,
      "arxiv-2601.01003.pdf",
      "Programmable optical tweezers rearrange atoms into defect-free arrays."
    );
    const parsed = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });

    const result = await generatePaperWikiSummary({
      workspaceDir: workspace,
      paperKey: parsed.paperKey,
      force: true
    });

    assert.equal(result.status, "needs_worker");
    assert.match(result.message, /Summary worker is not configured/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("generatePaperWikiSummary can include related-paper candidates in worker evidence", async () => {
  const workspace = await createWorkspace();
  const receivedRelatedKeys: string[][] = [];

  try {
    const targetPdfPath = await writePdf(
      workspace,
      "arxiv-2601.01004.pdf",
      "Remote superconducting qubits use Bell self-testing for device-independent certification."
    );
    const relatedPdfPath = await writePdf(
      workspace,
      "arxiv-2601.01005.pdf",
      "Superconducting qubit networks use Bell correlations for distributed quantum processors."
    );
    const target = await parsePaper({
      workspaceDir: workspace,
      path: targetPdfPath,
      engine: "plain-text-baseline"
    });
    await parsePaper({
      workspaceDir: workspace,
      path: relatedPdfPath,
      engine: "plain-text-baseline"
    });

    const result = await generatePaperWikiSummary({
      workspaceDir: workspace,
      paperKey: target.paperKey,
      force: true,
      includeRelatedCandidates: true,
      maxRelatedCandidates: 3,
      summaryWorker: async ({ evidence }) => {
        receivedRelatedKeys.push((evidence.relatedCandidates ?? []).map((candidate) => candidate.paperKey));
        return {
          summaryMarkdown: "A grounded summary with related-paper candidates.",
          relatedPaperKeys: [evidence.relatedCandidates?.[0]?.paperKey ?? ""],
          confidence: "high"
        };
      }
    });

    assert.equal(result.status, "drafted");
    assert.ok(receivedRelatedKeys[0]?.includes("arxiv-2601.01005"));
    assert.deepEqual(result.draft?.relatedPaperKeys, ["arxiv-2601.01005"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("generatePaperWikiSummary prefers a good parse over a low-quality webpage parse", async () => {
  const workspace = await createWorkspace();
  const paperKey = "aps-10.1103-example-summary";
  const sourceRoot = path.join(workspace, "knowledge-base", "wiki", "sources", paperKey);
  const webpageDir = path.join(sourceRoot, "parses", "webpage");
  const localDir = path.join(sourceRoot, "parses", "opendataloader-local");
  const receivedEngines: string[] = [];

  try {
    await writeJson(path.join(sourceRoot, "source.json"), {
      paperKey,
      source: "aps",
      canonicalId: "10.1103/example-summary",
      articleUrl: "https://journals.aps.org/prl/abstract/10.1103/example-summary"
    });
    await writeText(path.join(webpageDir, "document.md"), "# Abstract\n\nAccess-limited publisher preview.");
    await writeJson(path.join(webpageDir, "parse.json"), {
      paperKey,
      engine: "webpage",
      sections: []
    });
    await writeJson(path.join(webpageDir, "quality.json"), {
      status: "needs_hybrid",
      score: 0.45,
      pages: 1,
      totalTextLength: 2000,
      emptyPageCount: 0,
      headingCount: 1,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: ["Publisher access wall detected. Prefer PDF parsing."]
    });
    await writeText(path.join(localDir, "document.md"), "# Paper\n\nFull PDF-derived article body suitable for summary.");
    await writeJson(path.join(localDir, "parse.json"), {
      paperKey,
      engine: "opendataloader-local",
      sections: []
    });
    await writeJson(path.join(localDir, "quality.json"), {
      status: "good",
      score: 1,
      pages: 4,
      totalTextLength: 20000,
      emptyPageCount: 0,
      headingCount: 4,
      tableCount: 0,
      figureOrCaptionCount: 1,
      warnings: []
    });

    const result = await generatePaperWikiSummary({
      workspaceDir: workspace,
      paperKey,
      summaryWorker: async ({ evidence }) => {
        receivedEngines.push(evidence.engine);
        return {
          summaryMarkdown: "A grounded summary from the good parse.",
          confidence: "high"
        };
      }
    });

    assert.equal(result.status, "drafted");
    assert.equal(result.engine, "opendataloader-local");
    assert.deepEqual(receivedEngines, ["opendataloader-local"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
