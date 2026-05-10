import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  listWikiEvidenceItems,
  readWikiEvidenceItem
} from "../../src/agent/wiki/retrieval-contract.js";
import { searchWikiEvidence } from "../../src/agent/wiki/retrieval-search.js";
import { writeTypedWikiPage } from "../../src/agent/wiki/typed-store.js";

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

function sourceManifest(paperKey: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "paper-source",
    paperKey,
    title: "Frequency allocation for superconducting qubits",
    status: "ready",
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
    sourceSummaryPath: `knowledge-base/sources/${paperKey}/summary.md`,
    provenance: {
      articleUrl: "https://arxiv.org/abs/2601.00003"
    },
    parse: {
      engine: "fixture",
      markdownPath: "",
      jsonPath: "",
      qualityPath: ""
    },
    tags: ["superconducting-qubits"],
    relatedPaperKeys: [],
    synthesisPageKeys: []
  };
}

async function writeLegacySourceWithManifest(input: {
  workspace: string;
  paperKey: string;
  title: string;
  summaryMarkdown: string;
  tags: string[];
}): Promise<void> {
  await writeWorkspaceFile(
    input.workspace,
    `knowledge-base/sources/${input.paperKey}/summary.md`,
    input.summaryMarkdown
  );
  await writeWorkspaceFile(
    input.workspace,
    `knowledge-base/manifests/${input.paperKey}.json`,
    `${JSON.stringify({
      ...sourceManifest(input.paperKey),
      title: input.title,
      tags: input.tags
    }, null, 2)}\n`
  );
}

test("searchWikiEvidence returns match reasons and insufficient evidence status", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-structured-search-"));
  try {
    const empty = await searchWikiEvidence({
      workspaceDir: workspace,
      query: "frequency allocation",
      preferredKinds: ["source"],
      maxResults: 5
    });
    assert.equal(empty.status, "insufficient_evidence");
    assert.equal(empty.results.length, 0);

    // Write fixture evidence directly; this contract test must not depend on parsing or downloading.
    await writeLegacySourceWithManifest({
      workspace,
      paperKey: "arxiv-2601.00003",
      title: "Frequency allocation in qubits",
      summaryMarkdown: "# Frequency allocation in qubits\n\nKey findings mention frequency collisions.",
      tags: ["frequency-allocation"]
    });

    const result = await searchWikiEvidence({
      workspaceDir: workspace,
      query: "frequency allocation",
      preferredKinds: ["source"],
      maxResults: 5
    });

    assert.equal(result.status, "ready");
    assert.equal(result.results[0].item.key, "arxiv-2601.00003");
    assert.ok(result.results[0].matchReasons.includes("title"));
    assert.ok(result.results[0].matchReasons.includes("tag"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("searchWikiEvidence uses preferredKinds for sorting without filtering page evidence", async () => {
  await withWorkspace("wiki-structured-search-preference-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "frequency-allocation",
          title: "Frequency allocation",
          aliases: [],
          tags: ["control-stack"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00003"],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Frequency allocation\n\nPage-only evidence."
      }
    });

    const result = await searchWikiEvidence({
      workspaceDir,
      query: "frequency allocation",
      preferredKinds: ["source"],
      maxResults: 5
    });

    assert.equal(result.status, "ready");
    assert.equal(result.results[0].item.kind, "page");
    assert.equal(result.results[0].item.key, "frequency-allocation");
  });
});

test("searchWikiEvidence ranks stronger score before preferred evidence kind", async () => {
  await withWorkspace("wiki-structured-search-score-first-", async (workspaceDir) => {
    await writeLegacySourceWithManifest({
      workspace: workspaceDir,
      paperKey: "arxiv-weak-source",
      title: "Weak source",
      summaryMarkdown: "# Weak source\n\nFrequency appears once in a broad source body.",
      tags: []
    });
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "frequency-allocation",
          title: "Frequency allocation",
          aliases: [],
          tags: [],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00003"],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Frequency allocation\n\nPage body."
      }
    });

    const result = await searchWikiEvidence({
      workspaceDir,
      query: "frequency allocation",
      preferredKinds: ["source"],
      maxResults: 2
    });

    assert.equal(result.status, "ready");
    assert.equal(result.results[0].item.kind, "page");
    assert.equal(result.results[0].item.key, "frequency-allocation");
  });
});

test("searchWikiEvidence includes two-letter query terms", async () => {
  await withWorkspace("wiki-structured-search-short-term-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "model-governance",
          title: "Model governance",
          aliases: [],
          tags: ["AI"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00010"],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Model governance\n\nControls for frontier model deployment."
      }
    });

    const result = await searchWikiEvidence({
      workspaceDir,
      query: "AI safety",
      maxResults: 5
    });

    assert.equal(result.status, "ready");
    assert.equal(result.results[0].item.key, "model-governance");
    assert.ok(result.results[0].matchReasons.includes("tag"));
  });
});

test("retrieval contract reads source evidence by key from legacy summary and manifest", async () => {
  await withWorkspace("wiki-retrieval-source-", async (workspaceDir) => {
    const paperKey = "arxiv-2601.00003";
    await writeWorkspaceFile(workspaceDir, `knowledge-base/sources/${paperKey}/summary.md`, [
      "---",
      'type: "paper-source-summary"',
      `paper_key: "${paperKey}"`,
      "---",
      "",
      "# Legacy source summary",
      "",
      "This summary body is durable evidence text."
    ].join("\n"));
    await writeWorkspaceFile(
      workspaceDir,
      `knowledge-base/manifests/${paperKey}.json`,
      `${JSON.stringify(sourceManifest(paperKey), null, 2)}\n`
    );

    const result = await readWikiEvidenceItem({
      workspaceDir,
      kind: "source",
      key: paperKey
    });

    assert.equal(result.status, "ready");
    assert.equal(result.item?.kind, "source");
    assert.equal(result.item?.key, paperKey);
    assert.equal(result.item?.manifest?.status, "ready");
    assert.match(result.item?.body ?? "", /durable evidence text/);
    assert.equal(result.item?.relativePath, `knowledge-base/sources/${paperKey}/summary.md`);
  });
});

test("retrieval contract lists typed pages by tag and evidence contract", async () => {
  await withWorkspace("wiki-retrieval-pages-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "frequency-allocation",
          title: "Frequency allocation",
          aliases: ["frequency planning"],
          tags: ["superconducting-qubits"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00003"],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Frequency allocation\n\nPage body."
      }
    });

    const result = await listWikiEvidenceItems({
      workspaceDir,
      kinds: ["page"],
      tags: ["superconducting-qubits"],
      evidenceContracts: ["paper-backed"]
    });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, "page");
    assert.equal(result.items[0].key, "frequency-allocation");
    assert.equal(result.items[0].relativePath, "knowledge-base/pages/frequency-allocation.md");
  });
});

test("retrieval contract returns diagnostics for source summaries missing manifests", async () => {
  await withWorkspace("wiki-retrieval-missing-manifest-", async (workspaceDir) => {
    const paperKey = "arxiv-2601.00004";
    await writeWorkspaceFile(workspaceDir, `knowledge-base/sources/${paperKey}/summary.md`, [
      "# Source without manifest",
      "",
      "Body exists even though the manifest has not been written."
    ].join("\n"));

    const result = await readWikiEvidenceItem({
      workspaceDir,
      kind: "source",
      key: paperKey
    });

    assert.ok(result.status === "ready" || result.status === "malformed");
    assert.equal(result.item?.kind, "source");
    assert.match(result.item?.body ?? "", /manifest has not been written/);
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.toLowerCase().includes("missing manifest")),
      `expected missing manifest diagnostic, got ${JSON.stringify(result.diagnostics)}`
    );
  });
});

test("retrieval contract returns malformed diagnostics for invalid source and page keys", async () => {
  await withWorkspace("wiki-retrieval-invalid-key-", async (workspaceDir) => {
    const sourceResult = await readWikiEvidenceItem({
      workspaceDir,
      kind: "source",
      key: "///"
    });
    const pageResult = await readWikiEvidenceItem({
      workspaceDir,
      kind: "page",
      key: "///"
    });

    assert.equal(sourceResult.status, "malformed");
    assert.equal(sourceResult.item, undefined);
    assert.ok(sourceResult.diagnostics.some((diagnostic) => diagnostic.includes("key")));
    assert.equal(pageResult.status, "malformed");
    assert.equal(pageResult.item, undefined);
    assert.ok(pageResult.diagnostics.some((diagnostic) => diagnostic.includes("key")));
  });
});

test("retrieval contract reports invalid JSON source manifests as malformed", async () => {
  await withWorkspace("wiki-retrieval-invalid-json-manifest-", async (workspaceDir) => {
    const paperKey = "arxiv-2601.00005";
    await writeWorkspaceFile(
      workspaceDir,
      `knowledge-base/sources/${paperKey}/summary.md`,
      "# Source summary\n\nBody remains readable."
    );
    await writeWorkspaceFile(
      workspaceDir,
      `knowledge-base/manifests/${paperKey}.json`,
      "{not valid json"
    );

    const result = await readWikiEvidenceItem({
      workspaceDir,
      kind: "source",
      key: paperKey
    });

    assert.equal(result.status, "malformed");
    assert.equal(result.item?.key, paperKey);
    assert.equal(result.item?.title, paperKey);
    assert.equal(result.item?.manifest, undefined);
    assert.match(result.item?.body ?? "", /Body remains readable/);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.toLowerCase().includes("malformed manifest")));
  });
});

test("retrieval contract reports wrong-shape source manifests as malformed without using fields", async () => {
  await withWorkspace("wiki-retrieval-wrong-shape-manifest-", async (workspaceDir) => {
    const paperKey = "arxiv-2601.00006";
    await writeWorkspaceFile(
      workspaceDir,
      `knowledge-base/sources/${paperKey}/summary.md`,
      "# Source summary\n\nWrong-shape manifest should not provide metadata."
    );
    await writeWorkspaceFile(
      workspaceDir,
      `knowledge-base/manifests/${paperKey}.json`,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "paper-source",
        paperKey,
        title: 42,
        status: "ready",
        tags: ["should-not-be-used"]
      }, null, 2)}\n`
    );

    const result = await readWikiEvidenceItem({
      workspaceDir,
      kind: "source",
      key: paperKey
    });

    assert.equal(result.status, "malformed");
    assert.equal(result.item?.title, paperKey);
    assert.deepEqual(result.item?.tags, []);
    assert.equal(result.item?.manifest, undefined);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.toLowerCase().includes("malformed manifest")));
  });
});

test("retrieval contract rejects source manifests missing required fields", async () => {
  await withWorkspace("wiki-retrieval-missing-fields-manifest-", async (workspaceDir) => {
    const paperKey = "arxiv-2601.00009";
    await writeWorkspaceFile(
      workspaceDir,
      `knowledge-base/sources/${paperKey}/summary.md`,
      "# Source summary\n\nMissing required manifest fields should not be accepted."
    );
    await writeWorkspaceFile(
      workspaceDir,
      `knowledge-base/manifests/${paperKey}.json`,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "paper-source",
        paperKey,
        title: "Incomplete manifest",
        status: "ready",
        sourceSummaryPath: `knowledge-base/sources/${paperKey}/summary.md`,
        provenance: {
          articleUrl: 42
        },
        parse: {
          engine: "fixture",
          markdownPath: "",
          jsonPath: "",
          qualityPath: ""
        },
        tags: [],
        relatedPaperKeys: [],
        synthesisPageKeys: []
      }, null, 2)}\n`
    );

    const result = await readWikiEvidenceItem({
      workspaceDir,
      kind: "source",
      key: paperKey
    });

    assert.equal(result.status, "malformed");
    assert.equal(result.item?.manifest, undefined);
    assert.equal(result.item?.title, paperKey);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.toLowerCase().includes("malformed manifest")));
  });
});

test("retrieval contract returns blocked status with body for blocked source manifests", async () => {
  await withWorkspace("wiki-retrieval-blocked-manifest-", async (workspaceDir) => {
    const paperKey = "arxiv-2601.00007";
    await writeWorkspaceFile(
      workspaceDir,
      `knowledge-base/sources/${paperKey}/summary.md`,
      "# Blocked source\n\nBlocked source body."
    );
    await writeWorkspaceFile(
      workspaceDir,
      `knowledge-base/manifests/${paperKey}.json`,
      `${JSON.stringify({ ...sourceManifest(paperKey), status: "blocked" }, null, 2)}\n`
    );

    const result = await readWikiEvidenceItem({
      workspaceDir,
      kind: "source",
      key: paperKey
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.item?.manifest?.status, "blocked");
    assert.match(result.item?.body ?? "", /Blocked source body/);
  });
});

test("retrieval contract list filters are conjunctive with negative controls", async () => {
  await withWorkspace("wiki-retrieval-filter-negative-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "frequency-allocation",
          title: "Frequency allocation",
          aliases: [],
          tags: ["superconducting-qubits", "control-stack"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00003", "arxiv-2601.00008"],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Frequency allocation\n\nPage body."
      }
    });

    const matching = await listWikiEvidenceItems({
      workspaceDir,
      kinds: ["page"],
      keys: ["frequency-allocation"],
      tags: ["superconducting-qubits", "control-stack"],
      sourceRefs: ["arxiv-2601.00003", "arxiv-2601.00008"],
      evidenceContracts: ["paper-backed"]
    });
    const nonmatchingTag = await listWikiEvidenceItems({
      workspaceDir,
      kinds: ["page"],
      tags: ["superconducting-qubits", "missing-tag"]
    });
    const nonmatchingSourceRef = await listWikiEvidenceItems({
      workspaceDir,
      kinds: ["page"],
      sourceRefs: ["arxiv-2601.00003", "arxiv-missing"]
    });
    const nonmatchingEvidenceContract = await listWikiEvidenceItems({
      workspaceDir,
      kinds: ["page"],
      evidenceContracts: ["design-backed"]
    });
    const nonmatchingKey = await listWikiEvidenceItems({
      workspaceDir,
      kinds: ["page"],
      keys: ["missing-key"]
    });

    assert.deepEqual(matching.items.map((item) => item.key), ["frequency-allocation"]);
    assert.equal(nonmatchingTag.items.length, 0);
    assert.equal(nonmatchingSourceRef.items.length, 0);
    assert.equal(nonmatchingEvidenceContract.items.length, 0);
    assert.equal(nonmatchingKey.items.length, 0);
  });
});
