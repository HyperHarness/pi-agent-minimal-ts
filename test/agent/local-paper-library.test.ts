import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listLocalPapers,
  searchLocalPapers
} from "../../src/agent/local-paper-library.js";

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pi-local-paper-library-"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

test("listLocalPapers merges download records with parsed artifacts", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "nature-s41534-026-01233-y.pdf");
    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeJson(path.join(workspace, "knowledge-base", "records", "nature-s41534-026-01233-y.json"), {
      source: "nature",
      articleUrl: "https://www.nature.com/articles/s41534-026-01233-y",
      recordedAt: "2026-04-28T00:00:00.000Z",
      handlingMethod: "browser_session",
      status: "downloaded",
      canonicalId: "s41534-026-01233-y",
      pdfUrl: "https://www.nature.com/articles/s41534-026-01233-y.pdf",
      downloadPath: pdfPath
    });
    const paperDir = path.join(workspace, "knowledge-base", "wiki", "sources", "nature-s41534-026-01233-y");
    await writeJson(path.join(paperDir, "source.json"), {
      paperKey: "nature-s41534-026-01233-y",
      title: "Fusion-based implementation of qLDPC codes with quantum emitters",
      articleUrl: "https://www.nature.com/articles/s41534-026-01233-y",
      source: "nature",
      canonicalId: "s41534-026-01233-y",
      pdfPath
    });
    await writeText(path.join(paperDir, "parses", "opendataloader-local", "document.md"), "Full PDF text");
    await writeJson(path.join(paperDir, "parses", "opendataloader-local", "parse.json"), {
      paperKey: "nature-s41534-026-01233-y",
      engine: "opendataloader-local"
    });
    await writeJson(path.join(paperDir, "parses", "opendataloader-local", "quality.json"), {
      status: "good",
      score: 1,
      totalTextLength: 12000,
      warnings: []
    });

    const result = await listLocalPapers({
      workspaceDir: workspace,
      status: "parsed",
      query: "qLDPC"
    });

    assert.equal(result.total, 1);
    assert.equal(result.results[0]?.paperKey, "nature-s41534-026-01233-y");
    assert.equal(result.results[0]?.hasPdf, true);
    assert.equal(result.results[0]?.hasParsedArtifacts, true);
    assert.equal(result.results[0]?.parses[0]?.engine, "opendataloader-local");
    assert.equal(result.results[0]?.parses[0]?.status, "good");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("listLocalPapers merges slash canonical IDs using the record filename key", async () => {
  const workspace = await createWorkspace();
  try {
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "aps-10.1103-PhysRevLett.125.120504.pdf");
    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeJson(path.join(workspace, "knowledge-base", "records", "aps-10.1103-PhysRevLett.125.120504.json"), {
      source: "aps",
      articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.125.120504",
      recordedAt: "2026-04-28T00:00:00.000Z",
      handlingMethod: "browser_session",
      status: "downloaded",
      canonicalId: "10.1103/PhysRevLett.125.120504",
      pdfUrl: "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.125.120504",
      downloadPath: pdfPath
    });
    const paperDir = path.join(workspace, "knowledge-base", "wiki", "sources", "aps-10.1103-PhysRevLett.125.120504");
    await writeJson(path.join(paperDir, "source.json"), {
      paperKey: "aps-10.1103-PhysRevLett.125.120504",
      title: "Demonstrating a Continuous Set of Two-Qubit Gates",
      articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.125.120504",
      source: "aps",
      canonicalId: "10.1103/PhysRevLett.125.120504",
      pdfPath
    });
    await writeText(path.join(paperDir, "parses", "opendataloader-local", "document.md"), "Full PDF text");
    await writeJson(path.join(paperDir, "parses", "opendataloader-local", "quality.json"), {
      status: "good",
      score: 1,
      totalTextLength: 12000,
      warnings: []
    });

    const result = await listLocalPapers({ workspaceDir: workspace, status: "all" });

    assert.equal(result.total, 1);
    assert.equal(result.results[0]?.paperKey, "aps-10.1103-PhysRevLett.125.120504");
    assert.equal(result.results[0]?.canonicalId, "10.1103/PhysRevLett.125.120504");
    assert.equal(result.results[0]?.hasPdf, true);
    assert.equal(result.results[0]?.hasParsedArtifacts, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("listLocalPapers canonicalizes accepted APS webpage artifact directories", async () => {
  const workspace = await createWorkspace();
  try {
    await writeJson(path.join(workspace, "knowledge-base", "records", "aps-10.1103-k3d5-v43c.json"), {
      source: "aps",
      articleUrl: "https://journals.aps.org/prapplied/accepted/10.1103/k3d5-v43c",
      recordedAt: "2026-04-28T00:00:00.000Z",
      handlingMethod: "arxiv_preprint_fallback",
      status: "preprint_fallback",
      canonicalId: "10.1103/k3d5-v43c",
      title: "Superconducting qubits in the millions: The potential and limitations of modularity",
      preprint: {
        source: "arxiv",
        canonicalId: "2406.06015",
        articleUrl: "https://arxiv.org/abs/2406.06015",
        pdfUrl: "https://arxiv.org/pdf/2406.06015.pdf",
        recordPath: path.join(workspace, "knowledge-base", "records", "arxiv-2406.06015.json"),
        downloadPath: path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2406.06015.pdf"),
        status: "downloaded"
      },
      failure: {
        code: "publisher_version_not_available",
        message: "Using matching arXiv preprint until the publisher PDF is available."
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
      totalTextLength: 24,
      warnings: ["Accepted-paper page has no formal PDF yet."]
    });

    const result = await listLocalPapers({ workspaceDir: workspace, status: "all" });

    assert.equal(result.total, 1);
    assert.equal(result.results[0]?.paperKey, "aps-10.1103-k3d5-v43c");
    assert.equal(result.results[0]?.status, "preprint_fallback");
    assert.equal(result.results[0]?.hasParsedArtifacts, true);
    assert.equal(result.results[0]?.parses[0]?.engine, "webpage");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("searchLocalPapers searches metadata, wiki summaries, and parsed markdown", async () => {
  const workspace = await createWorkspace();
  try {
    const recordPath = path.join(workspace, "knowledge-base", "records", "arxiv-2406.06015.json");
    const pdfPath = path.join(workspace, "knowledge-base", "raw", "pdfs", "arxiv-2406.06015.pdf");
    await writeText(pdfPath, "%PDF-1.4\nexample\n%%EOF\n");
    await writeJson(recordPath, {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2406.06015",
      recordedAt: "2026-04-28T00:00:00.000Z",
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2406.06015",
      pdfUrl: "https://arxiv.org/pdf/2406.06015.pdf",
      downloadPath: pdfPath
    });
    const paperDir = path.join(workspace, "knowledge-base", "wiki", "sources", "arxiv-2406.06015");
    await writeJson(path.join(paperDir, "source.json"), {
      paperKey: "arxiv-2406.06015",
      title: "Quantum LDPC decoding with local statistics",
      articleUrl: "https://arxiv.org/abs/2406.06015",
      source: "arxiv",
      canonicalId: "2406.06015",
      pdfPath,
      recordPath
    });
    await writeText(
      path.join(paperDir, "parses", "plain-text-baseline", "document.md"),
      "The local paper parser extracts qLDPC decoder performance and syndrome data."
    );
    await writeJson(path.join(paperDir, "parses", "plain-text-baseline", "quality.json"), {
      status: "good",
      score: 0.9,
      totalTextLength: 9000,
      warnings: []
    });
    await writeText(
      path.join(workspace, "knowledge-base", "wiki", "sources", "arxiv-2406.06015.md"),
      [
        "---",
        'title: "Quantum LDPC decoding with local statistics"',
        "---",
        "# Quantum LDPC decoding with local statistics",
        "",
        "This source summary emphasizes qLDPC decoder hardware implications."
      ].join("\n")
    );

    const result = await searchLocalPapers({
      workspaceDir: workspace,
      query: "qLDPC",
      maxResults: 3
    });

    assert.equal(result.count, 1);
    assert.equal(result.results[0]?.paper.paperKey, "arxiv-2406.06015");
    assert.ok(result.results[0]?.score ?? 0);
    assert.ok(result.results[0]?.matches.some((match) => match.field === "wiki_summary"));
    assert.ok(result.results[0]?.matches.some((match) => match.field === "parsed_markdown"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
