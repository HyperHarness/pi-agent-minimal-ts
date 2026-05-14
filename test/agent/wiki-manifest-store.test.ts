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
    const rawText = await readFile(path.join(workspaceDir, relativePath), "utf8");
    assert.ok(rawText.includes('\n  "schemaVersion": 2,\n'));
    assert.ok(rawText.endsWith("\n"));
    const persisted = JSON.parse(rawText) as WikiSourceManifestV2;
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

test("readNormalizedWikiSourceManifest rejects manifest sourceKey mismatches", async () => {
  await withWorkspace("wiki-manifest-v2-identity-", async (workspaceDir) => {
    const timestamp = "2026-05-14T00:00:00.000Z";
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/manifests/material-sapphire-permittivity.json",
      `${JSON.stringify({
        schemaVersion: 2,
        sourceKind: "material-database",
        sourceKey: "material-silicon-permittivity",
        title: "Mismatched material manifest",
        status: "ready",
        createdAt: timestamp,
        updatedAt: timestamp,
        summaryPath: "knowledge-base/sources/material-sapphire-permittivity/summary.md",
        provenance: {
          url: "https://example.invalid/materials/sapphire",
          retrievedAt: timestamp
        },
        artifacts: [],
        tags: ["materials"],
        relatedSourceKeys: [],
        synthesisPageKeys: []
      }, null, 2)}\n`
    );

    const manifest = await readNormalizedWikiSourceManifest({
      workspaceDir,
      sourceKey: "material-sapphire-permittivity"
    });

    assert.equal(manifest, undefined);
  });
});

test("readNormalizedWikiSourceManifest rejects malformed V2 manifests", async () => {
  await withWorkspace("wiki-manifest-v2-malformed-", async (workspaceDir) => {
    const timestamp = "2026-05-14T00:00:00.000Z";
    const validManifest = {
      schemaVersion: 2,
      sourceKind: "material-database",
      sourceKey: "malformed-v2",
      title: "Malformed V2",
      status: "needs_review",
      createdAt: timestamp,
      updatedAt: timestamp,
      summaryPath: "knowledge-base/sources/malformed-v2/summary.md",
      provenance: {
        url: "https://example.invalid/malformed",
        retrievedAt: timestamp
      },
      artifacts: [
        {
          kind: "table",
          path: "knowledge-base/sources/malformed-v2/tables/parameters.json"
        }
      ],
      tags: ["materials"],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    };
    const cases: Array<{
      name: string;
      manifest: Record<string, unknown>;
    }> = [
      {
        name: "invalid source kind",
        manifest: { ...validManifest, sourceKind: "spreadsheet" }
      },
      {
        name: "invalid status",
        manifest: { ...validManifest, status: "pending" }
      },
      {
        name: "artifact missing path",
        manifest: {
          ...validManifest,
          artifacts: [{ kind: "table" }]
        }
      },
      {
        name: "invalid optional artifact field type",
        manifest: {
          ...validManifest,
          artifacts: [
            {
              kind: "table",
              path: "knowledge-base/sources/malformed-v2/tables/parameters.json",
              qualityPath: 42
            }
          ]
        }
      },
      {
        name: "invalid optional provenance field type",
        manifest: {
          ...validManifest,
          provenance: {
            url: 42,
            retrievedAt: timestamp
          }
        }
      }
    ];

    for (const item of cases) {
      await writeWorkspaceFile(
        workspaceDir,
        "knowledge-base/manifests/malformed-v2.json",
        `${JSON.stringify(item.manifest, null, 2)}\n`
      );

      const manifest = await readNormalizedWikiSourceManifest({
        workspaceDir,
        sourceKey: "malformed-v2"
      });

      assert.equal(manifest, undefined, item.name);
    }
  });
});

test("readNormalizedWikiSourceManifest rejects malformed legacy V1 manifests", async () => {
  await withWorkspace("wiki-manifest-v1-malformed-", async (workspaceDir) => {
    const timestamp = "2026-05-14T00:00:00.000Z";
    const legacyManifest = {
      schemaVersion: 1,
      kind: "paper-source",
      paperKey: "arxiv-malformed-v1",
      title: "Malformed legacy manifest",
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceSummaryPath: "knowledge-base/sources/arxiv-malformed-v1/summary.md",
      provenance: {
        articleUrl: "https://arxiv.org/abs/2601.00003",
        rawPdfPath: "knowledge-base/raw/pdfs/arxiv-malformed-v1.pdf"
      },
      parse: {
        engine: "fixture",
        markdownPath: 42,
        jsonPath: "knowledge-base/sources/arxiv-malformed-v1/parses/fixture/parse.json",
        qualityPath: "knowledge-base/sources/arxiv-malformed-v1/parses/fixture/quality.json"
      },
      tags: ["frequency-allocation"],
      relatedPaperKeys: [],
      synthesisPageKeys: []
    };
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/manifests/arxiv-malformed-v1.json",
      `${JSON.stringify(legacyManifest, null, 2)}\n`
    );

    const manifest = await readNormalizedWikiSourceManifest({
      workspaceDir,
      sourceKey: "arxiv-malformed-v1"
    });

    assert.equal(manifest, undefined);
  });
});
