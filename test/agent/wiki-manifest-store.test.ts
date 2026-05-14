import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  normalizeWikiSourceManifest,
  readNormalizedWikiSourceManifest,
  writeWikiSourceManifestV2,
  type WikiSourceManifestV2
} from "../../src/agent/wiki/manifest-store.js";

async function withWorkspace(
  name: string,
  run: (workspaceDir: string) => Promise<void>
): Promise<void> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), name));
  try {
    await run(workspaceDir);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function writeWorkspaceFile(
  workspaceDir: string,
  relativePath: string,
  content: string
): Promise<void> {
  const filePath = path.join(workspaceDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("writeWikiSourceManifestV2 writes a generalized software-doc manifest", async () => {
  await withWorkspace("wiki-manifest-v2-write-", async (workspaceDir) => {
    const timestamp = "2026-05-14T00:00:00.000Z";
    const manifest = {
      schemaVersion: 2,
      sourceKind: "software-doc",
      sourceKey: "software-doc-hfss-eigenmode",
      title: "HFSS Eigenmode Solver Documentation",
      status: "ready",
      createdAt: timestamp,
      updatedAt: timestamp,
      summaryPath: "knowledge-base/sources/software-doc-hfss-eigenmode/summary.md",
      provenance: {
        url: "https://example.invalid/hfss/eigenmode",
        retrievedAt: timestamp,
        softwareName: "Ansys HFSS",
        softwareVersion: "2025 R2"
      },
      artifacts: [
        {
          kind: "snapshot",
          path: "knowledge-base/sources/software-doc-hfss-eigenmode/raw/snapshot.html"
        }
      ],
      tags: ["hfss", "em-simulation", "package-modes"],
      relatedSourceKeys: [],
      synthesisPageKeys: ["hfss-eigenmode-simulation-workflow"]
    } satisfies WikiSourceManifestV2;

    const relativePath = await writeWikiSourceManifestV2({ workspaceDir, manifest });

    assert.equal(relativePath, "knowledge-base/manifests/software-doc-hfss-eigenmode.json");
    const persisted = JSON.parse(
      await readFile(path.join(workspaceDir, relativePath), "utf8")
    ) as WikiSourceManifestV2;
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.sourceKind, "software-doc");
    assert.equal(persisted.sourceKey, "software-doc-hfss-eigenmode");
    assert.equal(persisted.provenance.softwareName, "Ansys HFSS");
  });
});

test("normalizeWikiSourceManifest maps legacy paper manifests into generalized shape", () => {
  const timestamp = "2026-05-10T00:00:00.000Z";
  const normalized = normalizeWikiSourceManifest({
    schemaVersion: 1,
    kind: "paper-source",
    paperKey: "arxiv-2601.00003",
    title: "Frequency allocation",
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceSummaryPath: "knowledge-base/sources/arxiv-2601.00003/summary.md",
    provenance: {
      articleUrl: "https://arxiv.org/abs/2601.00003",
      rawPdfPath: "knowledge-base/raw/pdfs/arxiv-2601.00003.pdf"
    },
    parse: {
      engine: "fixture",
      markdownPath: "knowledge-base/sources/arxiv-2601.00003/parses/fixture/parse.md",
      jsonPath: "knowledge-base/sources/arxiv-2601.00003/parses/fixture/parse.json",
      qualityPath: "knowledge-base/sources/arxiv-2601.00003/parses/fixture/quality.json"
    },
    tags: ["frequency-allocation"],
    relatedPaperKeys: ["arxiv-2601.00004"],
    synthesisPageKeys: ["frequency-allocation"]
  });

  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.sourceKind, "paper");
  assert.equal(normalized.sourceKey, "arxiv-2601.00003");
  assert.equal(normalized.summaryPath, "knowledge-base/sources/arxiv-2601.00003/summary.md");
  assert.equal(normalized.provenance.url, "https://arxiv.org/abs/2601.00003");
  assert.equal(normalized.provenance.rawPath, "knowledge-base/raw/pdfs/arxiv-2601.00003.pdf");
  assert.deepEqual(normalized.relatedSourceKeys, ["arxiv-2601.00004"]);
  assert.ok(normalized.artifacts.some((artifact) => artifact.kind === "parse" && artifact.engine === "fixture"));
});

test("readNormalizedWikiSourceManifest reads V2 manifests by source key", async () => {
  await withWorkspace("wiki-manifest-v2-read-", async (workspaceDir) => {
    const timestamp = "2026-05-14T00:00:00.000Z";
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/manifests/material-sapphire-permittivity.json",
      `${JSON.stringify({
        schemaVersion: 2,
        sourceKind: "material-database",
        sourceKey: "material-sapphire-permittivity",
        title: "Sapphire permittivity values",
        status: "needs_review",
        createdAt: timestamp,
        updatedAt: timestamp,
        summaryPath: "knowledge-base/sources/material-sapphire-permittivity/summary.md",
        provenance: {
          url: "https://example.invalid/materials/sapphire",
          retrievedAt: timestamp
        },
        artifacts: [
          {
            kind: "table",
            path: "knowledge-base/sources/material-sapphire-permittivity/tables/parameters.json"
          }
        ],
        tags: ["materials", "sapphire"],
        relatedSourceKeys: [],
        synthesisPageKeys: []
      }, null, 2)}\n`
    );

    const manifest = await readNormalizedWikiSourceManifest({
      workspaceDir,
      sourceKey: "material-sapphire-permittivity"
    });

    assert.equal(manifest?.sourceKind, "material-database");
    assert.equal(manifest?.sourceKey, "material-sapphire-permittivity");
    assert.equal(manifest?.status, "needs_review");
  });
});
