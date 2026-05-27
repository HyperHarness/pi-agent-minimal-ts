import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
  inspectPaper,
  parsePaper,
  readPaperSection,
  searchPaperText
} from "../../src/agent/paper/reading/paper-reader.js";
import { savePaperWebPageParse } from "../../src/agent/paper/reading/engines/webpage.js";
import {
  writePaperWikiPage,
  writePaperWikiSource
} from "../../src/agent/wiki/content.js";
import { bootstrapPaperWikiPageEvidence } from "../../src/agent/wiki/bootstrap.js";
import {
  evaluateParseQuality,
  evaluateParseQualityWithMarkdown
} from "../../src/agent/paper/reading/quality.js";
import { PaperReaderError, type ParsedPaperDocument } from "../../src/agent/paper/reading/types.js";
import { parsePaperWebPageHtml } from "../../src/agent/paper/acquisition/paper-webpage-fetch.js";
import { appendPaperDownloadJobEvent } from "../../src/agent/paper/extension/paper-download-jobs.js";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-paper-reader-"));
  return workspace;
}

async function writePdf(workspace: string, filename: string, text: string): Promise<string> {
  const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", filename);
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, `%PDF-1.4\n${text}\n%%EOF\n`, "utf8");
  return pdfPath;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeSourceSummary(workspace: string, paperKey: string, markdown: string): Promise<void> {
  const summaryPath = path.join(workspace, "knowledge-base", "sources", paperKey, "summary.md");
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, markdown, "utf8");
}

async function writeSourceMetadata(
  workspace: string,
  sourceKey: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await writeJson(
    path.join(workspace, "knowledge-base", "sources", sourceKey, "metadata.json"),
    {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey,
      title: sourceKey,
      status: "ready",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${sourceKey}/summary.md`,
      citation: {
        citationStatus: "incomplete",
        missingFields: []
      },
      provenance: {},
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: [],
      ...metadata
    }
  );
}

async function writePdfWithFlateTextStream(workspace: string, filename: string): Promise<string> {
  const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", filename);
  const content = "BT /F1 1 Tf [(Cosmic-ray-induced)-220(correlated)-220(errors)]TJ T* [(superconducting)-220(qubit)-220(array)]TJ ET";
  const compressed = deflateSync(Buffer.from(content, "latin1"));
  const pdf = Buffer.concat([
    Buffer.from([
      "%PDF-1.4",
      "1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj",
      "2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj",
      "3 0 obj <</Type/Page/Parent 2 0 R/Contents 4 0 R>> endobj",
      `4 0 obj <</Length ${compressed.length}/Filter/FlateDecode>>`,
      "stream",
      ""
    ].join("\n"), "latin1"),
    compressed,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")
  ]);
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, pdf);
  return pdfPath;
}

async function writeExecutableScript(dir: string, filename: string, source: string): Promise<string> {
  const scriptPath = path.join(dir, filename);
  await writeFile(scriptPath, source, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test("parse quality uses rich markdown length when structured elements are sparse", () => {
  const document: ParsedPaperDocument = {
    paperKey: "nature-s41534-026-01243-w",
    engine: "opendataloader-local",
    pdfSha256: "sha256",
    createdAt: "2026-04-30T00:00:00.000Z",
    title: "Sparse structured parse",
    pages: 15,
    elements: [
      {
        id: "e1",
        type: "heading",
        text: "Sparse structured parse",
        page: 1,
        headingLevel: 1,
        sectionId: "s1"
      },
      {
        id: "e2",
        type: "paragraph",
        text: "Short element text.",
        page: 1,
        sectionId: "s1"
      }
    ],
    sections: [
      {
        id: "s1",
        title: "Results",
        level: 1,
        pageFrom: 1,
        pageTo: 15,
        elementIds: ["e1", "e2"]
      }
    ]
  };
  const markdown = [
    "# Sparse structured parse",
    "",
    "This markdown contains the complete paper body extracted by the parser.",
    "superconducting qubit processor ".repeat(300)
  ].join("\n");

  const quality = evaluateParseQualityWithMarkdown(document, markdown);

  assert.ok(quality.totalTextLength > 8000);
  assert.equal(quality.status, "good");
  assert.equal(
    quality.warnings.includes("Extracted text is short for a scientific paper."),
    false
  );
});

test("parse quality treats rich publisher webpage text as complete even without canonical section titles", () => {
  const document: ParsedPaperDocument = {
    paperKey: "science-10.1126-science.aao4309",
    engine: "webpage",
    pdfSha256: "sha256",
    createdAt: "2026-05-03T00:00:00.000Z",
    title: "Science article webpage",
    pages: 1,
    elements: [
      {
        id: "e1",
        type: "heading",
        text: "Scaling up to supremacy",
        page: 1,
        headingLevel: 2,
        sectionId: "s1"
      },
      {
        id: "e2",
        type: "paragraph",
        text: "Quantum information scientists are getting closer to building a quantum computer. ".repeat(180),
        page: 1,
        sectionId: "s1"
      },
      {
        id: "e3",
        type: "heading",
        text: "Abstract",
        page: 1,
        headingLevel: 2,
        sectionId: "s2"
      },
      {
        id: "e4",
        type: "paragraph",
        text: "A key step toward demonstrating a quantum system that can address difficult problems. ".repeat(180),
        page: 1,
        sectionId: "s2"
      },
      {
        id: "e5",
        type: "heading",
        text: "Figure: Fig. 1 Device and experimental protocol.",
        page: 1,
        headingLevel: 2,
        sectionId: "s3"
      },
      {
        id: "e6",
        type: "caption",
        text: "Optical micrograph of the nine-qubit array. ".repeat(40),
        page: 1,
        sectionId: "s3"
      }
    ],
    sections: [
      {
        id: "s1",
        title: "Scaling up to supremacy",
        level: 2,
        pageFrom: 1,
        pageTo: 1,
        elementIds: ["e1", "e2"]
      },
      {
        id: "s2",
        title: "Abstract",
        level: 2,
        pageFrom: 1,
        pageTo: 1,
        elementIds: ["e3", "e4"]
      },
      {
        id: "s3",
        title: "Figure: Fig. 1 Device and experimental protocol.",
        level: 2,
        pageFrom: 1,
        pageTo: 1,
        elementIds: ["e5", "e6"]
      }
    ]
  };

  const quality = evaluateParseQuality(document);

  assert.equal(quality.status, "good");
  assert.ok(quality.score >= 0.7);
  assert.equal(
    quality.warnings.some((warning) => warning.includes("No main body sections were detected")),
    false
  );
});

test("parsePaper writes reading artifacts and reuses a same-hash cache", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(
      workspace,
      "arxiv-2406.06015.pdf",
      "Abstract superconducting qubits introduction methods results conclusion"
    );
    const metadataPath = path.join(workspace, "knowledge-base", "sources", "arxiv-2406.06015", "metadata.json");
    await writeJson(metadataPath, {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: "arxiv-2406.06015",
      title: "Preserved source metadata",
      status: "ready",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      summaryPath: "knowledge-base/sources/arxiv-2406.06015/summary.md",
      citation: {
        citationStatus: "complete",
        missingFields: [],
        authors: ["Ada Lovelace"],
        year: 2024,
        venue: "arXiv",
        arxivId: "2406.06015"
      },
      provenance: {
        url: "https://arxiv.org/abs/2406.06015",
        arxivId: "2406.06015",
        acquisitionPath: "knowledge-base/sources/arxiv-2406.06015/acquisition.json",
        recordPath: "knowledge-base/sources/arxiv-2406.06015/acquisition.json",
        rawPath: "knowledge-base/raw/pdfs/arxiv-2406.06015.pdf",
        downloadPath: "knowledge-base/raw/pdfs/arxiv-2406.06015.pdf",
        source: "arxiv",
        canonicalId: "2406.06015"
      },
      pdfPath,
      pdfSha256: "legacy-sha",
      recordPath: "knowledge-base/sources/arxiv-2406.06015/acquisition.json",
      source: "arxiv",
      canonicalId: "2406.06015",
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const first = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });
    assert.equal(first.status, "parsed");
    assert.equal(first.paperKey, "arxiv-2406.06015");
    assert.equal(first.engine, "plain-text-baseline");
    assert.equal(first.sections[0]?.title, "arxiv-2406.06015");
    assert.match(first.artifacts.markdownPath, /knowledge-base\/sources\/arxiv-2406\.06015\/parses\/plain-text-baseline\/document\.md$/);

    const second = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });
    assert.equal(second.status, "already_parsed");
    assert.equal(second.pdfSha256, first.pdfSha256);

    const parseJson = JSON.parse(await readFile(first.artifacts.parsePath, "utf8")) as {
      elements: Array<{ text: string }>;
    };
    assert.match(parseJson.elements.map((element) => element.text).join("\n"), /superconducting qubits/);
    assert.match(first.artifacts.metadataPath ?? "", /knowledge-base\/sources\/arxiv-2406\.06015\/metadata\.json$/);
    const metadataJson = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.deepEqual(metadataJson.citation.authors, ["Ada Lovelace"]);
    assert.equal(metadataJson.citation.citationStatus, "complete");
    for (const forbiddenField of ["pdfPath", "pdfSha256", "recordPath", "source", "canonicalId"]) {
      assert.equal(forbiddenField in metadataJson, false);
    }
    for (const forbiddenProvenanceField of ["recordPath", "rawPath", "downloadPath", "source", "canonicalId"]) {
      assert.equal(forbiddenProvenanceField in metadataJson.provenance, false);
    }
    const parseArtifact = metadataJson.artifacts.find((artifact: { kind?: string; engine?: string }) =>
      artifact.kind === "parse" && artifact.engine === "plain-text-baseline"
    );
    assert.ok(parseArtifact);
    assert.equal(parseArtifact.path, "knowledge-base/sources/arxiv-2406.06015/parses/plain-text-baseline/document.md");
    assert.equal(parseArtifact.markdownPath, "knowledge-base/sources/arxiv-2406.06015/parses/plain-text-baseline/document.md");
    assert.equal(parseArtifact.jsonPath, "knowledge-base/sources/arxiv-2406.06015/parses/plain-text-baseline/parse.json");
    assert.equal(parseArtifact.qualityPath, "knowledge-base/sources/arxiv-2406.06015/parses/plain-text-baseline/quality.json");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("plain-text-baseline extracts PDF content streams instead of raw object syntax", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdfWithFlateTextStream(workspace, "nature-s41467-025-59778-z.pdf");

    const result = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });

    assert.equal(result.status, "parsed");
    assert.equal(result.quality.pages, 1);
    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    assert.match(markdown, /Cosmic-ray-induced correlated errors/);
    assert.match(markdown, /superconducting qubit array/);
    assert.doesNotMatch(markdown, /endobj|endstream|xref/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parsePaper auto falls back to docling when OpenDataLoader fails", async () => {
  const workspace = await createWorkspace();
  const previousDoclingBin = process.env.PI_PAPER_READER_DOCLING_BIN;
  let binDir: string | undefined;
  try {
    const pdfPath = await writePdf(workspace, "nature-s41467-025-59778-z.pdf", "docling fallback paper");
    binDir = await mkdtemp(path.join(os.tmpdir(), "pi-paper-reader-bin-"));
    const failingOpenDataLoader = await writeExecutableScript(
      binDir,
      "opendataloader-fail",
      "#!/usr/bin/env sh\nprintf 'simulated OpenDataLoader failure' >&2\nexit 2\n"
    );
    const fakeDocling = await writeExecutableScript(
      binDir,
      "docling",
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const outputIndex = process.argv.indexOf("--output");
const outputDir = outputIndex >= 0 ? process.argv[outputIndex + 1] : process.cwd();
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "docling.json"), JSON.stringify({
  name: "docling-fallback",
  pages: { "1": {} },
  texts: [
    { label: "section_header", text: "Docling fallback title", level: 1, prov: [{ page_no: 1, bbox: { l: 1, t: 2, r: 3, b: 4 } }] },
    { label: "text", text: "Cosmic-ray-induced correlated errors were extracted by Docling.", prov: [{ page_no: 1 }] }
  ]
}));
`
    );
    process.env.PI_PAPER_READER_DOCLING_BIN = fakeDocling;

    const result = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "auto",
      opendataloaderBin: failingOpenDataLoader,
      force: true
    });

    assert.equal(result.status, "parsed");
    assert.equal(result.engine, "docling");
    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    assert.match(markdown, /Docling fallback title/);
    assert.match(markdown, /Cosmic-ray-induced correlated errors/);
  } finally {
    if (previousDoclingBin === undefined) {
      delete process.env.PI_PAPER_READER_DOCLING_BIN;
    } else {
      process.env.PI_PAPER_READER_DOCLING_BIN = previousDoclingBin;
    }
    await rm(workspace, { recursive: true, force: true });
    if (binDir) {
      await rm(binDir, { recursive: true, force: true });
    }
  }
});

test("writePaperWikiSource saves an LLM source summary with focused metadata", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(
      workspace,
      "raw/arxiv-2601.00003.pdf",
      "Abstract neutral atoms and programmable quantum simulation"
    );
    const parsed = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });
    const metadataPath = path.join(workspace, "knowledge-base", "sources", parsed.paperKey, "metadata.json");
    const seededMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeJson(metadataPath, {
      ...seededMetadata,
      pdfPath,
      pdfSha256: "legacy-sha",
      recordPath: "knowledge-base/sources/arxiv-2601.00003/acquisition.json",
      source: "arxiv",
      canonicalId: "2601.00003",
      artifacts: [
        {
          kind: "raw",
          path: "knowledge-base/raw/pdfs/arxiv-2601.00003.pdf",
          sha256: "legacy-raw-sha"
        },
        {
          kind: "parse",
          path: "knowledge-base/sources/arxiv-2601.00003/parses/docling/document.md",
          engine: "docling",
          markdownPath: "knowledge-base/sources/arxiv-2601.00003/parses/docling/document.md",
          jsonPath: "knowledge-base/sources/arxiv-2601.00003/parses/docling/parse.json",
          qualityPath: "knowledge-base/sources/arxiv-2601.00003/parses/docling/quality.json"
        }
      ]
    });

    const source = await writePaperWikiSource({
      workspaceDir: workspace,
      paperKey: parsed.paperKey,
      summaryMarkdown:
        "This source summary says the paper studies programmable neutral atom arrays for simulation.",
      tags: ["quantum-simulation"],
      keyFindings: ["Neutral atom arrays are the central experimental platform."]
    });

    const sourceDetails = source as typeof source & { metadataPath?: string };
    assert.equal(source.sourcePath, "knowledge-base/sources/arxiv-2601.00003/summary.md");
    assert.equal(sourceDetails.metadataPath, "knowledge-base/sources/arxiv-2601.00003/metadata.json");
    assert.equal(source.operationJournalPath, "knowledge-base/state/wiki-operations.jsonl");
    assert.equal(source.indexPath, "knowledge-base/index.md");
    const markdown = await readFile(path.join(workspace, source.sourcePath), "utf8");
    assert.ok(markdown.startsWith("# "));
    assert.doesNotMatch(markdown, /^---\n/);
    assert.doesNotMatch(markdown, /paper-source-summary|parse_markdown|paper_key:/);
    const metadata = JSON.parse(await readFile(path.join(workspace, sourceDetails.metadataPath), "utf8"));
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.sourceKind, "paper");
    assert.equal(metadata.sourceKey, "arxiv-2601.00003");
    assert.equal(metadata.status, "ready");
    assert.equal(metadata.summaryPath, "knowledge-base/sources/arxiv-2601.00003/summary.md");
    assert.equal(metadata.artifacts.every((artifact: { kind?: string }) => artifact.kind === "parse"), true);
    assert.equal(metadata.artifacts.some((artifact: { kind?: string }) => artifact.kind === "raw"), false);
    assert.equal(metadata.artifacts.some((artifact: { engine?: string }) => artifact.engine === "docling"), true);
    const summaryParseArtifact = metadata.artifacts.find((artifact: { engine?: string }) =>
      artifact.engine === "plain-text-baseline"
    );
    assert.ok(summaryParseArtifact);
    assert.equal(summaryParseArtifact.markdownPath, "knowledge-base/sources/arxiv-2601.00003/parses/plain-text-baseline/document.md");
    for (const forbiddenField of ["pdfPath", "pdfSha256", "recordPath", "source", "canonicalId"]) {
      assert.equal(forbiddenField in metadata, false);
    }
    assert.equal("rawSha256" in metadata.provenance, false);
    assert.equal("rawPath" in metadata.provenance, false);
    assert.equal("recordPath" in metadata.provenance, false);
    assert.deepEqual(metadata.tags, ["quantum-simulation"]);
    assert.deepEqual(metadata.relatedSourceKeys, []);
    await assert.rejects(
      readFile(path.join(workspace, "knowledge-base", "manifests", "arxiv-2601.00003.json"), "utf8"),
      { code: "ENOENT" }
    );
    const journalLines = (await readFile(path.join(workspace, source.operationJournalPath), "utf8")).trim().split("\n");
    const journalEvents = journalLines.map((line) => JSON.parse(line));
    assert.equal(journalEvents[0].phase, "begin");
    assert.equal(journalEvents[0].intent, "write_source_summary");
    assert.equal(journalEvents[0].owner, "wiki-agent");
    assert.ok(journalEvents[0].plannedFiles.includes("knowledge-base/sources/arxiv-2601.00003/metadata.json"));
    assert.equal(journalEvents.at(-1).phase, "complete");
    assert.equal(journalEvents.at(-1).operationId, journalEvents[0].operationId);
    const log = await readFile(path.join(workspace, source.logPath), "utf8");
    assert.doesNotMatch(log, /source \|/);
    assert.doesNotMatch(log, /arxiv-2601\.00003/);
    const index = await readFile(path.join(workspace, source.indexPath), "utf8");
    assert.match(index, /## Knowledge Entries/);
    assert.match(index, /Source summaries: 1/);
    assert.doesNotMatch(index, /programmable neutral atom arrays/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("writePaperWikiSource refuses symlinked targets before journaling", async () => {
  const workspace = await createWorkspace();
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-paper-reader-outside-"));
  try {
    const pdfPath = await writePdf(
      workspace,
      "raw/arxiv-2601.00004.pdf",
      "Abstract preflight source summary target"
    );
    const parsed = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });
    const outsideTarget = path.join(outside, "summary.md");
    await writeFile(outsideTarget, "# Outside Summary\n", "utf8");
    const summaryPath = path.join(workspace, "knowledge-base", "sources", parsed.paperKey, "summary.md");
    await mkdir(path.dirname(summaryPath), { recursive: true });
    await symlink(outsideTarget, summaryPath);

    await assert.rejects(
      writePaperWikiSource({
        workspaceDir: workspace,
        paperKey: parsed.paperKey,
        summaryMarkdown: "This write should be blocked before journaling."
      }),
      /symlink/
    );

    await assert.rejects(readFile(path.join(workspace, "knowledge-base/state/wiki-operations.jsonl"), "utf8"));
    assert.equal((await readFile(outsideTarget, "utf8")).trim(), "# Outside Summary");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("writePaperWikiPage saves a synthesis page and updates the wiki index", async () => {
  const workspace = await createWorkspace();
  try {
    const page = await writePaperWikiPage({
      workspaceDir: workspace,
      topic: "qLDPC on superconducting chips",
      pageKey: "qldpc-superconducting-chips",
      title: "qLDPC on Superconducting Chips",
      pageMarkdown: "## Overview\n\nImplementation needs non-local couplers [arxiv-2507.09690].",
      tags: ["qldpc", "superconducting-qubits"],
      sourceCitations: [
        {
          paperKey: "arxiv-2507.09690",
          title: "Small Quantum LDPC Codes",
          path: "knowledge-base/sources/arxiv-2507.09690/summary.md"
        }
      ]
    });

    assert.equal(page.pagePath, "knowledge-base/pages/qldpc-superconducting-chips.md");
    assert.equal(page.operationJournalPath, "knowledge-base/state/wiki-operations.jsonl");
    assert.equal(page.sourceCount, 1);
    const markdown = await readFile(path.join(workspace, page.pagePath), "utf8");
    assert.match(markdown, /type: "wiki-synthesis-page"/);
    assert.match(markdown, /sources:/);
    assert.match(markdown, /arxiv-2507\.09690/);

    const index = await readFile(path.join(workspace, page.indexPath), "utf8");
    assert.match(index, /## Knowledge Entries/);
    assert.match(index, /\[qLDPC on Superconducting Chips\]\(pages\/qldpc-superconducting-chips\.md\)/);
    assert.match(index, /qldpc-superconducting-chips/);
    const log = await readFile(path.join(workspace, page.logPath), "utf8");
    assert.match(log, /page \| qLDPC on Superconducting Chips/);
    assert.match(log, /knowledge-base\/pages\/qldpc-superconducting-chips\.md/);

    const journal = (await readFile(path.join(workspace, page.operationJournalPath), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const begin = journal.find((event) => event.phase === "begin" && event.operationId === page.operationId);
    const complete = journal.find((event) => event.phase === "complete" && event.operationId === page.operationId);
    assert.equal(begin?.intent, "write_synthesis_page");
    assert.deepEqual(begin?.plannedFiles, [
      "knowledge-base/pages/qldpc-superconducting-chips.md",
      "knowledge-base/index.md",
      "knowledge-base/log.md"
    ]);
    assert.equal(complete?.operationId, page.operationId);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("writePaperWikiPage derives semantic page keys instead of source coverage keys", async () => {
  const workspace = await createWorkspace();
  try {
    const page = await writePaperWikiPage({
      workspaceDir: workspace,
      topic: "arxiv-2407.02467 source coverage synthesis",
      title: "Noise Stabilization for Error Mitigation in Superconducting Quantum Processors",
      pageMarkdown: "## Overview\n\nStabilized noise can support mitigation [arxiv-2407.02467].",
      tags: ["noise-stabilization", "superconducting-qubits"],
      sourceCitations: [
        {
          paperKey: "arxiv-2407.02467",
          title: "Error mitigation with stabilized noise in superconducting quantum processors",
          path: "knowledge-base/sources/arxiv-2407.02467/summary.md"
        }
      ]
    });

    assert.equal(
      page.pageKey,
      "noise-stabilization-for-error-mitigation-in-superconducting-quantum-processors"
    );
    assert.equal(
      page.pagePath,
      "knowledge-base/pages/noise-stabilization-for-error-mitigation-in-superconducting-quantum-processors.md"
    );
    await assert.rejects(
      readFile(path.join(workspace, "knowledge-base/pages/arxiv-2407-02467-source-coverage-synthesis.md"), "utf8"),
      /ENOENT/
    );

    const markdown = await readFile(path.join(workspace, page.pagePath), "utf8");
    assert.match(markdown, /page_key: "noise-stabilization-for-error-mitigation-in-superconducting-quantum-processors"/);
    assert.match(markdown, /topic: "arxiv-2407\.02467 source coverage synthesis"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("writePaperWikiPage does not duplicate an existing open questions section", async () => {
  const workspace = await createWorkspace();
  try {
    const page = await writePaperWikiPage({
      workspaceDir: workspace,
      topic: "relativistic quantum computation",
      pageKey: "relativistic-quantum-computation",
      title: "Relativistic Quantum Computation",
      pageMarkdown: [
        "## Overview",
        "",
        "Relativistic motion can be treated as a computational resource [aps-relativistic].",
        "",
        "## Open Questions",
        "",
        "- Can the relativistic-motion architecture be implemented experimentally [aps-relativistic]?"
      ].join("\n"),
      openQuestions: [
        "What fault-tolerance strategy is compatible with relativistic-motion-based computation?"
      ],
      sourceCitations: [
        {
          paperKey: "aps-relativistic",
          title: "Universal Quantum Computer from Relativistic Motion",
          path: "knowledge-base/sources/aps-relativistic/summary.md"
        }
      ]
    });

    const markdown = await readFile(path.join(workspace, page.pagePath), "utf8");
    assert.equal([...markdown.matchAll(/^## Open Questions$/gm)].length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("writePaperWikiPage refuses symlinked targets before journaling", async () => {
  const workspace = await createWorkspace();
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-paper-reader-outside-"));
  try {
    const outsideTarget = path.join(outside, "page.md");
    await writeFile(outsideTarget, "# Outside Page\n", "utf8");
    const pagePath = path.join(workspace, "knowledge-base", "pages", "unsafe-page.md");
    await mkdir(path.dirname(pagePath), { recursive: true });
    await symlink(outsideTarget, pagePath);

    await assert.rejects(
      writePaperWikiPage({
        workspaceDir: workspace,
        topic: "Unsafe Page",
        pageKey: "unsafe-page",
        pageMarkdown: "## Overview\n\nThis should not write.",
        sourceCitations: [{
          paperKey: "paper-a",
          path: "knowledge-base/sources/paper-a/summary.md"
        }]
      }),
      /symlink/
    );

    await assert.rejects(readFile(path.join(workspace, "knowledge-base/state/wiki-operations.jsonl"), "utf8"));
    assert.equal((await readFile(outsideTarget, "utf8")).trim(), "# Outside Page");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("bootstrapPaperWikiPageEvidence searches sources, expands related papers, and reports missing summaries", async () => {
  const workspace = await createWorkspace();
  try {
    await writeSourceSummary(workspace, "arxiv-seed", `# Seed qLDPC Paper

This source summary discusses qLDPC implementation on superconducting chips.
`);
    await writeSourceMetadata(workspace, "arxiv-seed", {
      title: "Seed qLDPC Paper",
      tags: ["qldpc", "superconducting-qubits"],
      relatedSourceKeys: ["arxiv-related"]
    });
    await writeSourceSummary(workspace, "arxiv-related", `# Auxiliary Constraints

This source summary discusses auxiliary constraints.
`);
    await writeSourceMetadata(workspace, "arxiv-related", {
      title: "Auxiliary Constraints",
      tags: ["ancilla"]
    });

    const result = await bootstrapPaperWikiPageEvidence({
      workspaceDir: workspace,
      topic: "qLDPC on superconducting chips",
      question: "请总结一下qLDPC码在超导量子芯片上实现的难点",
      maxSources: 4
    }, {
      searchLocalPapersImpl: async () => ({
        query: "fallback",
        count: 1,
        results: [
          {
            paper: {
              paperKey: "arxiv-missing-summary",
              title: "Parsed Missing Summary",
              hasPdf: true,
              hasParsedArtifacts: true,
              hasWikiSummary: false,
              parses: [],
            },
            score: 2,
            matches: [
              {
                field: "parsed_markdown",
                path: "knowledge-base/sources/arxiv-missing-summary/parses/tex-source/document.md",
                engine: "tex-source",
                snippet: "qLDPC parsed fallback evidence",
              },
            ],
          },
        ],
      }),
    });

    assert.equal(result.status, "ready");
    assert.ok(result.seedQueries.some((query) => /qLDPC superconducting/i.test(query)));
    assert.equal(result.sourceEvidence[0]?.paperKey, "arxiv-seed");
    assert.ok(result.expandedSources.some((item) => item.paperKey === "arxiv-related"));
    assert.ok(result.missingSummaries.some((item) => item.paperKey === "arxiv-missing-summary"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parsePaper invalidates the cache when PDF bytes change", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(workspace, "arxiv-2501.00001.pdf", "first version");
    const first = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });

    await writePdf(workspace, "arxiv-2501.00001.pdf", "second version with new bytes");
    const second = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });

    assert.equal(second.status, "parsed");
    assert.notEqual(second.pdfSha256, first.pdfSha256);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parsePaper resolves downloaded paper records", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(workspace, "arxiv-2401.01234.pdf", "record backed paper");
    const recordPath = path.join(workspace, "knowledge-base", "sources", "arxiv-2401.01234", "acquisition.json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify({
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.01234",
      recordedAt: "2026-04-27T00:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.01234",
      pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
      downloadPath: pdfPath
    }, null, 2)}\n`, "utf8");

    const result = await parsePaper({
      workspaceDir: workspace,
      recordPath,
      engine: "plain-text-baseline"
    });

    assert.equal(result.paperKey, "arxiv-2401.01234");
    const inspection = await inspectPaper({ workspaceDir: workspace, paperKey: result.paperKey });
    assert.equal(inspection.source?.canonicalId, "2401.01234");
    assert.equal(inspection.localPdf.hasPdf, true);
    assert.equal(inspection.localPdf.path, pdfPath);
    assert.equal(inspection.parses.length, 1);
    assert.equal(inspection.parses[0]?.sourceKind, "pdf");
    assert.equal(inspection.parses[0]?.sourceSha256, result.pdfSha256);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parsePaper sanitizes legacy runtime provenance when writing parse metadata", async () => {
  const workspace = await createWorkspace();
  try {
    const paperKey = "arxiv-2401.09999";
    const pdfPath = await writePdf(workspace, `${paperKey}.pdf`, "legacy progressive metadata cleanup");
    const recordPath = path.join(workspace, "knowledge-base", "sources", paperKey, "acquisition.json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify({
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.09999",
      recordedAt: "2026-05-27T00:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.09999",
      pdfUrl: "https://arxiv.org/pdf/2401.09999.pdf",
      downloadPath: pdfPath
    }, null, 2)}\n`, "utf8");
    await writeSourceMetadata(workspace, paperKey, {
      status: "missing_artifact",
      provenance: {
        url: "https://arxiv.org/abs/2401.09999",
        acquisitionPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
        source: "arxiv",
        canonicalId: "2401.09999",
        recordPath: `knowledge-base/sources/${paperKey}/legacy-record.json`,
        pdfUrl: "https://arxiv.org/pdf/2401.09999.pdf",
        downloadStatus: "downloaded",
        readingStatus: "queued",
        downloadPath: "knowledge-base/raw/pdfs/legacy.pdf",
        rawPath: "knowledge-base/raw/pdfs/legacy.pdf",
        rawSha256: "legacy-sha"
      }
    });

    await parsePaper({
      workspaceDir: workspace,
      recordPath,
      engine: "plain-text-baseline"
    });

    const metadata = JSON.parse(
      await readFile(path.join(workspace, "knowledge-base", "sources", paperKey, "metadata.json"), "utf8")
    ) as Record<string, unknown>;
    const provenance = metadata.provenance as Record<string, unknown>;

    assert.equal(metadata.status, "ready");
    for (const field of [
      "source",
      "canonicalId",
      "recordPath",
      "pdfUrl",
      "downloadStatus",
      "readingStatus",
      "downloadPath",
      "rawPath",
      "rawSha256"
    ]) {
      assert.equal(field in provenance, false, `${field} should not be preserved in paper metadata provenance`);
    }
    assert.equal(provenance.url, "https://arxiv.org/abs/2401.09999");
    assert.equal(provenance.acquisitionPath, `knowledge-base/sources/${paperKey}/acquisition.json`);
    assert.ok(Array.isArray(metadata.artifacts));
    assert.equal((metadata.artifacts as unknown[]).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("inspectPaper distinguishes webpage parses from downloaded PDFs", async () => {
  const workspace = await createWorkspace();
  try {
    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction: {
        url: "https://www.science.org/doi/10.1126/sciadv.adp6388",
        title: "High-performance fault-tolerant quantum computing with many-hypercube codes",
        markdown: "# Abstract\n\nFull publisher webpage text.",
        metadata: {
          authors: []
        },
        access: {
          status: "full_text",
          signals: []
        },
        stats: {
          chars: 38,
          wordsApprox: 5,
          navigationLinesRemoved: 0,
          extractedFrom: "article"
        }
      }
    });

    const inspection = await inspectPaper({ workspaceDir: workspace, paperKey: result.paperKey });

    assert.equal(inspection.paperKey, "science-10.1126-sciadv.adp6388");
    assert.equal(inspection.localPdf.hasPdf, false);
    assert.equal(inspection.localPdf.path, undefined);
    assert.equal(inspection.parses[0]?.engine, "webpage");
    assert.equal(inspection.parses[0]?.sourceKind, "webpage");
    assert.equal(inspection.parses[0]?.sourceSha256, result.pdfSha256);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("inspectPaper reads progressive source metadata before stale legacy fields", async () => {
  const workspace = await createWorkspace();
  try {
    const paperKey = "nature-s41534-026-01234-y";
    const paperDir = path.join(workspace, "knowledge-base", "sources", paperKey);
    await writeJson(path.join(paperDir, "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: paperKey,
      title: "Progressive Reader Metadata",
      status: "ready",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${paperKey}/summary.md`,
      citation: {
        citationStatus: "complete",
        missingFields: [],
        doi: "10.1038/s41534-026-01234-y"
      },
      provenance: {
        url: "https://www.nature.com/articles/s41534-026-01234-y",
        acquisitionPath: `knowledge-base/sources/${paperKey}/acquisition.json`,
        source: "science",
        canonicalId: "10.1126/stale.legacy",
        recordPath: `knowledge-base/sources/${paperKey}/legacy-record.json`,
        rawPath: "knowledge-base/raw/pdfs/stale.pdf",
        downloadPath: "knowledge-base/raw/pdfs/stale.pdf"
      },
      pdfPath: "knowledge-base/raw/pdfs/top-level-stale.pdf",
      pdfSha256: "top-level-stale-sha",
      recordPath: `knowledge-base/sources/${paperKey}/top-level-record.json`,
      source: "science",
      canonicalId: "10.1126/top-level-stale",
      artifacts: [
        {
          kind: "parse",
          path: `knowledge-base/sources/${paperKey}/parses/webpage/document.md`,
          engine: "webpage",
          markdownPath: `knowledge-base/sources/${paperKey}/parses/webpage/document.md`,
          jsonPath: `knowledge-base/sources/${paperKey}/parses/webpage/parse.json`,
          qualityPath: `knowledge-base/sources/${paperKey}/parses/webpage/quality.json`
        }
      ],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });
    await writeJson(path.join(paperDir, "parses", "webpage", "parse.json"), {
      paperKey,
      engine: "webpage",
      pdfSha256: "webpage-sha",
      createdAt: "2026-05-27T00:00:00.000Z",
      title: "Progressive Reader Metadata",
      pages: 1,
      elements: [],
      sections: []
    });
    await writeJson(path.join(paperDir, "parses", "webpage", "quality.json"), {
      status: "good",
      score: 1,
      pages: 1,
      totalTextLength: 1000,
      emptyPageCount: 0,
      headingCount: 1,
      tableCount: 0,
      figureOrCaptionCount: 0,
      warnings: []
    });

    const inspection = await inspectPaper({ workspaceDir: workspace, paperKey });

    assert.equal(inspection.source?.paperKey, paperKey);
    assert.equal(inspection.source?.createdAt, "2026-05-27T00:00:00.000Z");
    assert.equal(inspection.source?.articleUrl, "https://www.nature.com/articles/s41534-026-01234-y");
    assert.equal(inspection.source?.source, "nature");
    assert.equal(inspection.source?.canonicalId, "s41534-026-01234-y");
    assert.equal(inspection.source?.recordPath, `knowledge-base/sources/${paperKey}/acquisition.json`);
    assert.equal(inspection.source?.title, "Progressive Reader Metadata");
    assert.equal("pdfPath" in (inspection.source ?? {}), false);
    assert.equal("pdfSha256" in (inspection.source ?? {}), false);
    assert.equal(inspection.localPdf.hasPdf, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("inspectPaper resolves extension job ids and finds PDFs registered after webpage parsing", async () => {
  const workspace = await createWorkspace();
  try {
    const webpage = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction: {
        url: "https://journals.aps.org/prl/abstract/10.1103/nv7d-k3wr#fulltext",
        title: "Complete Self-Testing of a System of Remote Superconducting Qubits",
        markdown: "# Abstract\n\nFull APS publisher webpage text.",
        metadata: {
          authors: []
        },
        access: {
          status: "full_text",
          signals: []
        },
        stats: {
          chars: 40,
          wordsApprox: 6,
          navigationLinesRemoved: 0,
          extractedFrom: "article"
        }
      }
    });
    const pdfPath = await writePdf(workspace, "aps-10.1103-nv7d-k3wr.pdf", "aps downloaded pdf");
    const uncPdfPath = `\\\\wsl.localhost\\Ubuntu-24.04\\${pdfPath.slice(1).split(path.sep).join("\\")}`;
    const recordPath = path.join(workspace, "knowledge-base", "sources", "aps-10.1103-nv7d-k3wr", "acquisition.json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify({
      source: "aps",
      articleUrl: "https://journals.aps.org/prl/abstract/10.1103/nv7d-k3wr",
      recordedAt: "2026-05-06T06:04:05.776Z",
      handlingMethod: "browser_session",
      status: "downloaded",
      canonicalId: "10.1103/nv7d-k3wr",
      pdfUrl: "https://journals.aps.org/prl/pdf/10.1103/nv7d-k3wr",
      downloadPath: uncPdfPath,
      download: {
        status: "downloaded",
        updatedAt: "2026-05-06T06:04:05.776Z",
        method: "browser_session",
        pdfPath,
        pdfUrl: "https://journals.aps.org/prl/pdf/10.1103/nv7d-k3wr"
      }
    }, null, 2)}\n`, "utf8");
    await appendPaperDownloadJobEvent({
      workspaceDir: workspace,
      event: {
        jobId: "paper-aps-5e77bca2f317-motnitfr-0",
        recordedAt: "2026-05-06T06:04:05.776Z",
        status: "downloaded",
        articleUrl: "https://journals.aps.org/prl/abstract/10.1103/nv7d-k3wr",
        source: "aps",
        paperKey: webpage.paperKey,
        recordPath,
        downloadPath: uncPdfPath
      }
    });

    const inspection = await inspectPaper({
      workspaceDir: workspace,
      paperKey: "paper-aps-5e77bca2f317-motnitfr-0"
    });

    assert.equal(inspection.paperKey, "aps-10.1103-nv7d-k3wr");
    assert.equal(inspection.localPdf.hasPdf, true);
    assert.equal(inspection.localPdf.path, pdfPath);
    assert.equal(inspection.source?.pdfPath, pdfPath);
    assert.equal(inspection.parses[0]?.engine, "webpage");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parsePaper tex-source uses LaTeXML HTML followed by pandoc markdown", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(workspace, "arxiv-2507.09690.pdf", "tex source companion pdf");
    const recordPath = path.join(workspace, "knowledge-base", "sources", "arxiv-2507.09690", "acquisition.json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify({
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2507.09690",
      recordedAt: "2026-04-28T00:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2507.09690",
      pdfUrl: "https://arxiv.org/pdf/2507.09690.pdf",
      downloadPath: pdfPath
    }, null, 2)}\n`, "utf8");
    const sourceDir = path.join(workspace, "knowledge-base", "raw", "arxiv-sources", "2507.09690");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "00README.json"), `${JSON.stringify({
      sources: [{ usage: "toplevel", filename: "main.tex" }]
    })}\n`, "utf8");
    await writeFile(path.join(sourceDir, "main.tex"), "\\title{TeX Source Paper}\\begin{document}Body\\end{document}\n", "utf8");
    await writeFile(path.join(sourceDir, "figure.png"), "fake image bytes", "utf8");
    const callsPath = path.join(workspace, "calls.log");
    const latexmlBin = await writeExecutableScript(workspace, "fake-latexmlc", `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(${JSON.stringify(callsPath)}, "latexmlc " + process.argv.slice(2).join(" ") + "\\n");
const dest = process.argv[process.argv.indexOf("--dest") + 1];
fs.writeFileSync(dest, "<html><body><h1>TeX Source Paper</h1><h2>Introduction</h2><p>Converted from LaTeXML HTML.</p></body></html>");
`);
    const pandocBin = await writeExecutableScript(workspace, "fake-pandoc", `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callsPath)}, "pandoc " + process.argv.slice(2).join(" ") + "\\n");
const output = process.argv[process.argv.indexOf("--output") + 1];
fs.writeFileSync(output, "# TeX Source Paper\\n\\n## Introduction\\n\\n![Diagram](figure.png)\\n\\nFigure 1: Converted from LaTeXML HTML.\\n");
`);

    const result = await parsePaper({
      workspaceDir: workspace,
      recordPath,
      engine: "tex-source",
      force: true,
      latexmlBin,
      pandocBin
    });

    assert.equal(result.engine, "tex-source");
    assert.equal(result.paperKey, "arxiv-2507.09690");
    assert.match(result.artifacts.markdownPath, /parses\/tex-source\/document\.md$/);
    assert.notEqual(result.quality.status, "poor");
    assert.deepEqual(result.sections.map((section) => section.title).slice(0, 2), [
      "TeX Source Paper",
      "Introduction"
    ]);
    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    assert.match(markdown, /!\[Diagram]\(assets\/figure\.png\)/);
    assert.match(markdown, /Converted from LaTeXML HTML/);
    assert.equal(
      await readFile(path.join(path.dirname(result.artifacts.markdownPath), "assets", "figure.png"), "utf8"),
      "fake image bytes"
    );
    const calls = await readFile(callsPath, "utf8");
    assert.match(calls, /latexmlc --dest .*document\.html .*main\.tex/);
    assert.match(calls, /pandoc --from html --to gfm --wrap=none --output .*document\.md .*document\.html/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("paper reading tools resolve bare publisher canonical ids to parsed paper keys", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(
      workspace,
      "nature-s41467-025-63214-7.pdf",
      "Abstract localized statistics decoding for quantum low-density parity-check codes"
    );
    const recordPath = path.join(workspace, "knowledge-base", "sources", "nature-s41467-025-63214-7", "acquisition.json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify({
      source: "nature",
      articleUrl: "https://www.nature.com/articles/s41467-025-63214-7",
      recordedAt: "2026-04-28T00:00:00.000Z",
      handlingMethod: "browser_extension",
      status: "downloaded",
      canonicalId: "s41467-025-63214-7",
      pdfUrl: "https://www.nature.com/articles/s41467-025-63214-7.pdf",
      downloadPath: pdfPath
    }, null, 2)}\n`, "utf8");

    const parsed = await parsePaper({
      workspaceDir: workspace,
      recordPath,
      engine: "plain-text-baseline"
    });
    assert.equal(parsed.paperKey, "nature-s41467-025-63214-7");

    const inspection = await inspectPaper({
      workspaceDir: workspace,
      paperKey: "s41467-025-63214-7"
    });
    assert.equal(inspection.paperKey, "nature-s41467-025-63214-7");
    assert.equal(inspection.parses.length, 1);

    const section = await readPaperSection({
      workspaceDir: workspace,
      paperKey: "s41467-025-63214-7",
      maxChars: 120
    });
    assert.equal(section.paperKey, "nature-s41467-025-63214-7");
    assert.match(section.text, /localized statistics decoding/i);

    const search = await searchPaperText({
      workspaceDir: workspace,
      paperKey: "s41467-025-63214-7",
      query: "quantum"
    });
    assert.equal(search.paperKey, "nature-s41467-025-63214-7");
    assert.equal(search.results.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("readPaperSection prefers a good PDF parse over an incomplete publisher webpage parse", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(
      workspace,
      "nature-s41534-026-01233-y.pdf",
      "Introduction PDF full text Methods Results Discussion Conclusion ".repeat(80)
    );
    const recordPath = path.join(workspace, "knowledge-base", "sources", "nature-s41534-026-01233-y", "acquisition.json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify({
      source: "nature",
      articleUrl: "https://www.nature.com/articles/s41534-026-01233-y",
      recordedAt: "2026-04-28T00:00:00.000Z",
      handlingMethod: "browser_extension",
      status: "downloaded",
      canonicalId: "s41534-026-01233-y",
      pdfUrl: "https://www.nature.com/articles/s41534-026-01233-y.pdf",
      downloadPath: pdfPath
    }, null, 2)}\n`, "utf8");
    const pdfParse = await parsePaper({
      workspaceDir: workspace,
      recordPath,
      engine: "plain-text-baseline"
    });

    const webpageExtraction = parsePaperWebPageHtml({
      url: "https://www.nature.com/articles/s41534-026-01233-y",
      html: `
        <html>
          <head>
            <meta name="citation_title" content="Fusion-based implementation of qLDPC codes with quantum emitters">
            <meta name="citation_doi" content="10.1038/s41534-026-01233-y">
          </head>
          <body>
            <article>
              <h1>Fusion-based implementation of qLDPC codes with quantum emitters</h1>
              <h2>Abstract</h2>
              <p>Publisher webpage abstract only.</p>
              <h2>Data availability</h2>
              <p>Data are available.</p>
              <h2>Code availability</h2>
              <p>Code is available.</p>
              <h2>References</h2>
              <p>${"Reference metadata ".repeat(180)}</p>
            </article>
          </body>
        </html>
      `
    });
    const webpageParse = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction: webpageExtraction
    });
    assert.ok(["poor", "needs_hybrid"].includes(webpageParse.quality.status));

    const section = await readPaperSection({
      workspaceDir: workspace,
      paperKey: "s41534-026-01233-y",
      maxChars: 200
    });

    assert.equal(pdfParse.quality.status, "good");
    assert.equal(section.paperKey, "nature-s41534-026-01233-y");
    assert.equal(section.engine, "plain-text-baseline");
    assert.match(section.text, /PDF full text Methods Results/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("readPaperSection returns bounded text with source metadata", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(
      workspace,
      "arxiv-2601.00001.pdf",
      "Abstract introduction methods results limitations conclusion"
    );
    const parsed = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });

    const result = await readPaperSection({
      workspaceDir: workspace,
      paperKey: parsed.paperKey,
      sectionId: "section-0001",
      maxChars: 40
    });

    assert.equal(result.engine, "plain-text-baseline");
    assert.equal(result.truncated, true);
    assert.match(result.text, /^\[p\.1\]/);
    assert.equal(result.elements.length, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("searchPaperText returns snippets with page and section metadata", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(
      workspace,
      "arxiv-2601.00002.pdf",
      "This paper studies superconducting qubits and modular architectures."
    );
    const parsed = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });

    const result = await searchPaperText({
      workspaceDir: workspace,
      paperKey: parsed.paperKey,
      query: "superconducting",
      maxResults: 2
    });

    assert.equal(result.engine, "plain-text-baseline");
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.page, 1);
    assert.equal(result.results[0]?.sectionId, "section-0001");
    assert.match(result.results[0]?.snippet ?? "", /superconducting/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parsePaper rejects PDFs outside knowledge-base/raw/pdfs", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = path.join(workspace, "outside.pdf");
    await writeFile(pdfPath, "%PDF-1.4\noutside\n%%EOF\n", "utf8");

    await assert.rejects(
      () => parsePaper({
        workspaceDir: workspace,
        path: pdfPath,
        engine: "plain-text-baseline"
      }),
      (error: unknown) =>
        error instanceof PaperReaderError && error.code === "pdf_outside_papers_dir"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
