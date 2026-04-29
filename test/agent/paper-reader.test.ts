import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
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
import { parsePaperWebPageHtml } from "../../src/agent/paper-webpage-fetch.js";
import { savePaperWebPageParse } from "../../src/agent/paper-reader/engines/webpage.js";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-paper-reader-"));
  await mkdir(path.join(workspace, "knowledge-base", "records"), { recursive: true });
  return workspace;
}

async function writePdf(workspace: string, filename: string, text: string): Promise<string> {
  const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", filename);
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, `%PDF-1.4\n${text}\n%%EOF\n`, "utf8");
  return pdfPath;
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
    assert.match(first.artifacts.markdownPath, /knowledge-base\/wiki\/sources\/arxiv-2406\.06015\/parses\/plain-text-baseline\/document\.md$/);

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

    assert.equal(source.sourcePath, "knowledge-base/wiki/sources/arxiv-2601.00003.md");
    assert.equal(source.indexPath, "knowledge-base/wiki/index.md");
    const markdown = await readFile(path.join(workspace, source.sourcePath), "utf8");
    assert.match(markdown, /type: "paper-source-summary"/);
    assert.match(markdown, /parse_markdown: "knowledge-base\/wiki\/sources\/arxiv-2601\.00003\/parses\/plain-text-baseline\/document\.md"/);

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

test("searchPaperWiki expands Chinese domain questions into weighted paper evidence", async () => {
  const workspace = await createWorkspace();
  const sourcesDir = path.join(workspace, "knowledge-base", "wiki", "sources");

  try {
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(path.join(sourcesDir, "arxiv-2507.09690.md"), `---
type: "paper-source-summary"
paper_key: "arxiv-2507.09690"
title: "Small Quantum Low Density Parity Check Codes for Near-Term Experiments"
tags:
  - "quantum-LDPC-codes"
  - "superconducting-qubits"
  - "flip-chip"
---

# Small Quantum Low Density Parity Check Codes for Near-Term Experiments

This paper proposes small quantum LDPC codes for near-term experiments.
It discusses a superconducting flip-chip architecture, non-local connectivity,
long-range couplers, crosstalk, leakage, and measurement overhead as hardware challenges.
`, "utf8");
    await writeFile(path.join(sourcesDir, "aps-superconducting-control.md"), `---
type: "paper-source-summary"
paper_key: "aps-superconducting-control"
title: "Control of Superconducting Qubits"
tags:
  - "superconducting-qubits"
---

# Control of Superconducting Qubits

This paper studies microwave control of superconducting qubits.
`, "utf8");

    const search = await searchPaperWiki({
      workspaceDir: workspace,
      query: "请总结一下qLDPC码在超导量子芯片上实现的难点",
      maxResults: 2
    });

    assert.equal(search.results[0]?.paperKey, "arxiv-2507.09690");
    assert.match(search.results[0]?.snippet ?? "", /quantum LDPC|superconducting|long-range/i);
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
    const recordPath = path.join(workspace, "knowledge-base", "records", "arxiv-2401.01234.json");
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

test("parsePaper tex-source uses LaTeXML HTML followed by pandoc markdown", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = await writePdf(workspace, "arxiv-2507.09690.pdf", "tex source companion pdf");
    const recordPath = path.join(workspace, "knowledge-base", "records", "arxiv-2507.09690.json");
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
    const recordPath = path.join(workspace, "knowledge-base", "records", "nature-s41467-025-63214-7.json");
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
    const recordPath = path.join(workspace, "knowledge-base", "records", "nature-s41534-026-01233-y.json");
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
