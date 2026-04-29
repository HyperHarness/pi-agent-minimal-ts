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
