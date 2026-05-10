import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  listTypedWikiPages,
  readTypedWikiPage,
  writeTypedWikiPage
} from "../../src/agent/wiki/typed-store.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("typed store lists valid pages and reports malformed pages", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-typed-store-"));
  try {
    await mkdir(path.join(workspace, "knowledge-base", "pages"), { recursive: true });
    await writeFile(path.join(workspace, "knowledge-base", "pages", "valid.md"), [
      "---",
      "schema_version: 1",
      'type: "concept"',
      'key: "valid"',
      'title: "Valid Page"',
      "aliases: []",
      "tags: []",
      'evidence_contract: "paper-backed"',
      "source_refs:",
      '  - "arxiv-2601.00003"',
      'created_at: "2026-05-10T00:00:00.000Z"',
      'updated_at: "2026-05-10T00:00:00.000Z"',
      "---",
      "",
      "# Valid Page"
    ].join("\n"), "utf8");
    await writeFile(path.join(workspace, "knowledge-base", "pages", "broken.md"), "# Broken\n", "utf8");

    const result = await listTypedWikiPages({ workspaceDir: workspace, includeSources: false, includePages: true });

    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].metadata.key, "valid");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].errors[0].code, "missing_frontmatter");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("writeTypedWikiPage writes normalized metadata and preserves body", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-typed-write-"));
  try {
    const result = await writeTypedWikiPage({
      workspaceDir: workspace,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "frequency-crowding",
          title: "Frequency crowding",
          aliases: [],
          tags: ["superconducting-qubits"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00003"],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Frequency crowding\n\nBody."
      }
    });

    assert.equal(result.relativePath, "knowledge-base/pages/frequency-crowding.md");
    const page = await readTypedWikiPage({ workspaceDir: workspace, key: "frequency-crowding" });
    assert.equal(page.page?.metadata.type, "concept");
    assert.equal(page.page?.body.trim(), "# Frequency crowding\n\nBody.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("typed store defaults to sources and pages and applies conjunctive filters", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-typed-filter-"));
  try {
    await mkdir(path.join(workspace, "knowledge-base", "sources", "arxiv-2601.00003"), { recursive: true });
    await mkdir(path.join(workspace, "knowledge-base", "pages"), { recursive: true });
    const timestamp = "2026-05-10T00:00:00.000Z";
    await writeFile(path.join(workspace, "knowledge-base", "sources", "arxiv-2601.00003", "summary.md"), [
      "---",
      "schema_version: 1",
      'type: "paper-source"',
      'key: "arxiv-2601.00003"',
      'title: "Source Page"',
      "aliases: []",
      'tags:',
      '  - "superconducting-qubits"',
      'evidence_contract: "paper-backed"',
      "source_refs:",
      '  - "arxiv-2601.00003"',
      `created_at: "${timestamp}"`,
      `updated_at: "${timestamp}"`,
      "---",
      "",
      "# Source Page"
    ].join("\n"), "utf8");
    await writeFile(path.join(workspace, "knowledge-base", "pages", "concept.md"), [
      "---",
      "schema_version: 1",
      'type: "concept"',
      'key: "concept"',
      'title: "Concept Page"',
      "aliases: []",
      'tags:',
      '  - "superconducting-qubits"',
      'evidence_contract: "paper-backed"',
      "source_refs:",
      '  - "arxiv-2601.00003"',
      `created_at: "${timestamp}"`,
      `updated_at: "${timestamp}"`,
      "---",
      "",
      "# Concept Page"
    ].join("\n"), "utf8");

    const allPages = await listTypedWikiPages({ workspaceDir: workspace });
    const filteredPages = await listTypedWikiPages({
      workspaceDir: workspace,
      types: ["concept"],
      tags: ["superconducting-qubits"],
      sourceRefs: ["arxiv-2601.00003"],
      evidenceContracts: ["paper-backed"]
    });

    assert.deepEqual(allPages.pages.map((page) => page.metadata.type), ["paper-source", "concept"]);
    assert.deepEqual(filteredPages.pages.map((page) => page.metadata.key), ["concept"]);
    await assert.rejects(
      () => writeTypedWikiPage({
        workspaceDir: workspace,
        page: {
          metadata: {
            schema_version: 1,
            type: "paper-source",
            key: "arxiv-2601.00003",
            title: "Source Page",
            aliases: [],
            tags: ["superconducting-qubits"],
            evidence_contract: "paper-backed",
            source_refs: ["arxiv-2601.00003"],
            created_at: timestamp,
            updated_at: timestamp
          },
          body: "# Source Page"
        }
      }),
      /paper-source/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("readTypedWikiPage returns diagnostics instead of throwing for missing pages", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-typed-missing-"));
  try {
    const result = await readTypedWikiPage({ workspaceDir: workspace, key: "missing-page" });

    assert.equal(result.page, undefined);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].relativePath, "knowledge-base/pages/missing-page.md");
    assert.equal(result.diagnostics[0].errors[0].code, "missing_frontmatter");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("writeTypedWikiPage rejects paper-source pages without creating scaffold files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-typed-reject-"));
  try {
    const timestamp = "2026-05-10T00:00:00.000Z";

    await assert.rejects(
      () => writeTypedWikiPage({
        workspaceDir: workspace,
        page: {
          metadata: {
            schema_version: 1,
            type: "paper-source",
            key: "arxiv-2601.00003",
            title: "Source Page",
            aliases: [],
            tags: ["superconducting-qubits"],
            evidence_contract: "paper-backed",
            source_refs: ["arxiv-2601.00003"],
            created_at: timestamp,
            updated_at: timestamp
          },
          body: "# Source Page"
        }
      }),
      /paper-source/
    );

    assert.equal(await pathExists(path.join(workspace, "knowledge-base", "index.md")), false);
    assert.equal(await pathExists(path.join(workspace, "knowledge-base", "log.md")), false);
    assert.equal(await pathExists(path.join(workspace, "knowledge-base", "sources")), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
