import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectPaper,
  parsePaper,
  readPaperSection,
  searchPaperText
} from "../../src/agent/paper-reader/paper-reader.js";
import {
  searchPaperWiki,
  writePaperWikiSource
} from "../../src/agent/paper-wiki/paper-wiki.js";
import { PaperReaderError } from "../../src/agent/paper-reader/types.js";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-paper-reader-"));
  await mkdir(path.join(workspace, "downloads", "papers", "index"), { recursive: true });
  return workspace;
}

async function writePdf(workspace: string, filename: string, text: string): Promise<string> {
  const pdfPath = path.join(workspace, "downloads", "papers", filename);
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, `%PDF-1.4\n${text}\n%%EOF\n`, "utf8");
  return pdfPath;
}

test("parsePaper writes reading artifacts and reuses a same-hash cache", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(
      workspace,
      "arxiv-2406.06015.pdf",
      "Abstract superconducting qubits introduction methods results conclusion"
    );

    const first = await parsePaper({
      workspaceDir: workspace,
      path: pdfPath,
      engine: "plain-text-baseline"
    });
    assert.equal(first.status, "parsed");
    assert.equal(first.paperKey, "arxiv-2406.06015");
    assert.equal(first.engine, "plain-text-baseline");
    assert.equal(first.sections[0]?.title, "arxiv-2406.06015");
    assert.match(first.artifacts.markdownPath, /downloads\/papers\/llm-wiki\/intermediate\/arxiv-2406\.06015\/parses\/plain-text-baseline\/document\.md$/);

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
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("writePaperWikiSource saves an LLM source summary and searchPaperWiki finds it", async () => {
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

    const source = await writePaperWikiSource({
      workspaceDir: workspace,
      paperKey: parsed.paperKey,
      summaryMarkdown:
        "This source summary says the paper studies programmable neutral atom arrays for simulation.",
      tags: ["quantum-simulation"],
      keyFindings: ["Neutral atom arrays are the central experimental platform."]
    });

    assert.equal(source.sourcePath, "downloads/papers/llm-wiki/sources/arxiv-2601.00003.md");
    assert.equal(source.indexPath, "downloads/papers/llm-wiki/index.md");
    const markdown = await readFile(path.join(workspace, source.sourcePath), "utf8");
    assert.match(markdown, /type: "paper-source-summary"/);
    assert.match(markdown, /parse_markdown: "downloads\/papers\/llm-wiki\/intermediate\/arxiv-2601\.00003\/parses\/plain-text-baseline\/document\.md"/);

    const search = await searchPaperWiki({
      workspaceDir: workspace,
      query: "neutral atom",
      maxResults: 3
    });
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0]?.paperKey, "arxiv-2601.00003");
    assert.match(search.results[0]?.snippet ?? "", /neutral atom/);
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
    const recordPath = path.join(workspace, "downloads", "papers", "index", "arxiv-2401.01234.json");
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
    assert.equal(inspection.parses.length, 1);
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

test("parsePaper rejects PDFs outside downloads/papers", async () => {
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
