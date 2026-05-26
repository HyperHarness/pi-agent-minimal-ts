import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findPaperWikiRelations,
  paperWikiRelations,
  updatePaperWikiRelations
} from "../../src/agent/wiki/relations.js";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-paper-relations-"));
  await mkdir(path.join(workspace, "knowledge-base", "sources"), { recursive: true });
  return workspace;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

async function writeParsedPaper(workspace: string, input: {
  paperKey: string;
  title: string;
  text: string;
}): Promise<void> {
  const sourceRoot = path.join(workspace, "knowledge-base", "sources", input.paperKey);
  const parseRoot = path.join(sourceRoot, "parses", "webpage");
  await writeJson(path.join(sourceRoot, "metadata.json"), {
    schemaVersion: 1,
    sourceKind: "paper",
    sourceKey: input.paperKey,
    title: input.title,
    status: "ready",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    summaryPath: `knowledge-base/sources/${input.paperKey}/summary.md`,
    citation: {
      authors: ["Example Author"],
      year: 2026,
      venue: "Example Venue",
      doi: input.paperKey.replace(/^aps-/, ""),
      citationStatus: "complete",
      missingFields: []
    },
    provenance: {
      url: "https://example.invalid/paper",
      acquisitionPath: `knowledge-base/sources/${input.paperKey}/acquisition.json`
    },
    artifacts: [],
    tags: [],
    relatedSourceKeys: [],
    synthesisPageKeys: []
  });
  await writeText(path.join(parseRoot, "document.md"), `# ${input.title}\n\n${input.text}`);
  await writeJson(path.join(parseRoot, "quality.json"), {
    status: "good",
    score: 1,
    pages: 1,
    totalTextLength: input.text.length,
    emptyPageCount: 0,
    headingCount: 1,
    tableCount: 0,
    figureOrCaptionCount: 0,
    warnings: []
  });
}

test("findPaperWikiRelations suggests local papers with shared technical terms", async () => {
  const workspace = await createWorkspace();

  try {
    await writeParsedPaper(workspace, {
      paperKey: "aps-target",
      title: "Remote superconducting qubit self-testing",
      text: "A superconducting qubit network uses Bell self-testing and CHSH correlations for device-independent certification."
    });
    await writeParsedPaper(workspace, {
      paperKey: "aps-related",
      title: "High-fidelity remote superconducting processors",
      text: "Remote superconducting quantum processors are connected as a quantum network and benchmarked with Bell correlations."
    });
    await writeParsedPaper(workspace, {
      paperKey: "external-unrelated",
      title: "Protein folding microscopy",
      text: "This paper studies biological samples and microscopy workflows."
    });

    const result = await findPaperWikiRelations({
      workspaceDir: workspace,
      paperKey: "aps-target",
      maxCandidates: 2
    });

    assert.equal(result.paperKey, "aps-target");
    assert.equal(result.candidates[0]?.paperKey, "aps-related");
    assert.ok((result.candidates[0]?.score ?? 0) > 0);
    assert.ok(result.candidates[0]?.sharedTerms.includes("superconducting"));
    assert.ok(!result.candidates.some((candidate) => candidate.paperKey === "external-unrelated"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("updatePaperWikiRelations writes related_papers into an existing summary", async () => {
  const workspace = await createWorkspace();

  try {
    const summaryPath = path.join(workspace, "knowledge-base", "sources", "aps-target", "summary.md");
    await writeText(summaryPath, "# Target\n\nSummary.\n");
    await writeJson(path.join(workspace, "knowledge-base", "sources", "aps-target", "metadata.json"), {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey: "aps-target",
      title: "Target",
      status: "ready",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      summaryPath: "knowledge-base/sources/aps-target/summary.md",
      citation: {
        citationStatus: "complete",
        missingFields: []
      },
      provenance: {},
      artifacts: [],
      tags: [],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const result = await updatePaperWikiRelations({
      workspaceDir: workspace,
      paperKey: "aps-target",
      relatedPaperKeys: ["aps-related", "aps-second"],
      mode: "replace"
    });

    assert.deepEqual(result.previousRelatedPaperKeys, []);
    assert.deepEqual(result.relatedPaperKeys, ["aps-related", "aps-second"]);
    const markdown = await readFile(summaryPath, "utf8");
    assert.equal(markdown, "# Target\n\nSummary.\n");
    const metadata = JSON.parse(await readFile(
      path.join(workspace, "knowledge-base", "sources", "aps-target", "metadata.json"),
      "utf8"
    ));
    assert.deepEqual(metadata.relatedSourceKeys, ["aps-related", "aps-second"]);
    assert.notEqual(metadata.updatedAt, "2026-05-26T00:00:00.000Z");
    const log = await readFile(path.join(workspace, "knowledge-base", "log.md"), "utf8");
    assert.doesNotMatch(log, /relations \| aps-target/);
    assert.doesNotMatch(log, /aps-related/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("paperWikiRelations returns candidates and applies confirmed links when requested", async () => {
  const workspace = await createWorkspace();

  try {
    await writeParsedPaper(workspace, {
      paperKey: "aps-target",
      title: "Remote superconducting qubit self-testing",
      text: "Bell self-testing certifies remote superconducting qubit measurements."
    });
    await writeParsedPaper(workspace, {
      paperKey: "aps-related",
      title: "Superconducting Bell network",
      text: "A Bell network uses superconducting qubits and device-independent tests."
    });
    await writeText(path.join(workspace, "knowledge-base", "sources", "aps-target", "summary.md"), `---
paper_key: "aps-target"
related_papers: []
---

# Target
`);

    const result = await paperWikiRelations({
      workspaceDir: workspace,
      paperKey: "aps-target",
      relatedPaperKeys: ["aps-related"]
    });

    assert.equal(result.candidates[0]?.paperKey, "aps-related");
    assert.deepEqual(result.update?.relatedPaperKeys, ["aps-related"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
