import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  getKnowledgeSourceMetadataPath,
  isWikiSourceKind,
  readKnowledgeSourceMetadata,
  validateKnowledgeSourceMetadataIdentity,
  writeKnowledgeSourceMetadata,
  type KnowledgeSourceMetadata
} from "../../src/agent/wiki/source-metadata-store.js";

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

function metadata(overrides: Partial<KnowledgeSourceMetadata> = {}): KnowledgeSourceMetadata {
  const timestamp = "2026-05-26T00:00:00.000Z";
  return {
    schemaVersion: 1,
    sourceKind: "software-doc",
    sourceKey: "software-doc-hfss-eigenmode",
    title: "HFSS Eigenmode Solver Documentation",
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
    summaryPath: "knowledge-base/sources/software-doc-hfss-eigenmode/summary.md",
    citation: {
      citationStatus: "complete",
      missingFields: []
    },
    provenance: {
      url: "https://example.invalid/hfss/eigenmode",
      retrievedAt: timestamp,
      softwareName: "Ansys HFSS",
      softwareVersion: "2025 R2"
    },
    artifacts: [
      {
        kind: "snapshot",
        path: "knowledge-base/sources/software-doc-hfss-eigenmode/artifacts/snapshot.html"
      }
    ],
    tags: ["hfss", "em-simulation", "package-modes"],
    relatedSourceKeys: [],
    synthesisPageKeys: ["hfss-eigenmode-simulation-workflow"],
    ...overrides
  };
}

test("writeKnowledgeSourceMetadata writes per-source pretty JSON with trailing newline", async () => {
  await withWorkspace("source-metadata-write-", async (workspaceDir) => {
    const fixture = metadata();

    const relativePath = await writeKnowledgeSourceMetadata({ workspaceDir, metadata: fixture });

    assert.equal(
      relativePath,
      "knowledge-base/sources/software-doc-hfss-eigenmode/metadata.json"
    );
    const rawText = await readFile(path.join(workspaceDir, relativePath), "utf8");
    assert.ok(rawText.includes('\n  "schemaVersion": 1,\n'));
    assert.ok(rawText.endsWith("\n"));
    assert.deepEqual(JSON.parse(rawText), fixture);
  });
});

test("readKnowledgeSourceMetadata reads ready metadata by source key", async () => {
  await withWorkspace("source-metadata-read-", async (workspaceDir) => {
    const fixture = metadata();
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/sources/software-doc-hfss-eigenmode/metadata.json",
      `${JSON.stringify(fixture, null, 2)}\n`
    );

    const result = await readKnowledgeSourceMetadata({
      workspaceDir,
      sourceKey: "software-doc-hfss-eigenmode"
    });

    assert.equal(result.status, "ready");
    assert.deepEqual(result.metadata, fixture);
    assert.deepEqual(result.diagnostics, []);
  });
});

test("readKnowledgeSourceMetadata rejects sourceKey mismatches", async () => {
  await withWorkspace("source-metadata-mismatch-", async (workspaceDir) => {
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/sources/software-doc-hfss-eigenmode/metadata.json",
      `${JSON.stringify(metadata({ sourceKey: "software-doc-hfss-drivenmodal" }), null, 2)}\n`
    );

    const result = await readKnowledgeSourceMetadata({
      workspaceDir,
      sourceKey: "software-doc-hfss-eigenmode"
    });

    assert.equal(result.status, "malformed");
    assert.ok(result.diagnostics.some((diagnostic: string) => diagnostic.includes("sourceKey mismatch")));
  });
});

test("readKnowledgeSourceMetadata rejects malformed metadata shape", async () => {
  await withWorkspace("source-metadata-malformed-", async (workspaceDir) => {
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/sources/software-doc-hfss-eigenmode/metadata.json",
      `${JSON.stringify({
        ...metadata(),
        artifacts: [{ kind: "snapshot" }]
      }, null, 2)}\n`
    );

    const result = await readKnowledgeSourceMetadata({
      workspaceDir,
      sourceKey: "software-doc-hfss-eigenmode"
    });

    assert.equal(result.status, "malformed");
    assert.ok(result.diagnostics.includes("malformed metadata shape"));
  });
});

test("getKnowledgeSourceMetadataPath resolves metadata path inside source directory", () => {
  assert.equal(
    getKnowledgeSourceMetadataPath("/workspace", "arxiv-2601.00003"),
    path.join("/workspace", "knowledge-base/sources/arxiv-2601.00003/metadata.json")
  );
});

test("wiki source kinds exclude design artifacts owned by design-repo", () => {
  assert.equal(isWikiSourceKind("design-artifact"), false);
  assert.equal(isWikiSourceKind("code-output"), true);
});

test("validateKnowledgeSourceMetadataIdentity reports summary path mismatches", () => {
  const diagnostics = validateKnowledgeSourceMetadataIdentity({
    metadata: metadata(),
    sourceKey: "software-doc-hfss-eigenmode",
    summaryPath: "knowledge-base/sources/software-doc-hfss-eigenmode/other-summary.md"
  });

  assert.ok(diagnostics.some((diagnostic: string) => diagnostic.includes("summaryPath mismatch")));
});
