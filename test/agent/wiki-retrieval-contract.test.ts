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
import { searchPaperWiki } from "../../src/agent/wiki/content.js";
import { getKnowledgeSourceMetadataPath } from "../../src/agent/wiki/source-metadata-store.js";
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

function generalizedSourceManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    sourceKind: "material-database",
    sourceKey: "material-sapphire-permittivity",
    title: "Sapphire permittivity values",
    status: "needs_review",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    summaryPath: "knowledge-base/sources/material-sapphire-permittivity/summary.md",
    provenance: {
      url: "https://example.invalid/materials/sapphire",
      retrievedAt: "2026-05-14T00:00:00.000Z"
    },
    artifacts: [{
      kind: "table",
      path: "knowledge-base/sources/material-sapphire-permittivity/tables/parameters.json"
    }],
    tags: ["materials", "sapphire"],
    relatedSourceKeys: [],
    synthesisPageKeys: ["substrate-and-film-material-parameters"],
    ...overrides
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

test("searchWikiEvidence ranks qLDPC implementation evidence above broad superconducting lexical matches", async () => {
  await withWorkspace("wiki-structured-search-qldpc-implementation-", async (workspaceDir) => {
    await writeLegacySourceWithManifest({
      workspace: workspaceDir,
      paperKey: "aaa-broad-superconducting-readout",
      title: "Superconducting qubit readout implementation bottlenecks",
      summaryMarkdown: [
        "# Superconducting qubit readout implementation bottlenecks",
        "",
        "This broad source mentions superconducting chips and implementation bottlenecks, but it is about readout calibration rather than error-correction layouts."
      ].join("\n"),
      tags: ["superconducting-qubits"]
    });
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "finding",
          key: "qldpc-superconducting-layout-bottlenecks",
          title: "qLDPC layout bottlenecks on superconducting chips",
          aliases: [],
          tags: ["qldpc", "hardware-layout"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2404.17676", "arxiv-2507.09690"],
          claims: [{
            claimId: "claim-qldpc-layout",
            kind: "qualitative",
            statement: "qLDPC implementation on superconducting chips is bottlenecked by non-local checks, routing overhead, coupler pressure, and syndrome extraction.",
            sourceRefs: ["arxiv-2404.17676", "arxiv-2507.09690"],
            evidence: [{ paperKey: "arxiv-2404.17676", sectionId: "2d-local-routing" }],
            confidence: "medium"
          }],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: [
          "# qLDPC layout bottlenecks on superconducting chips",
          "",
          "Relevant evidence discusses non-local checks, routing, coupler overhead, syndrome extraction, bilayer layouts, flip-chip connectivity, long-range links, and modular architecture."
        ].join("\n")
      }
    });

    const result = await searchWikiEvidence({
      workspaceDir,
      query: "qLDPC superconducting chips implementation bottlenecks",
      maxResults: 2
    });

    assert.equal(result.status, "ready");
    assert.equal(result.results[0].item.key, "qldpc-superconducting-layout-bottlenecks");
    assert.ok(result.results[0].matchReasons.includes("semantic_expansion"));
  });
});

test("searchWikiEvidence warns when evidence is summary-only or lacks claim provenance", async () => {
  await withWorkspace("wiki-structured-search-provenance-warnings-", async (workspaceDir) => {
    await writeLegacySourceWithManifest({
      workspace: workspaceDir,
      paperKey: "arxiv-summary-layer",
      title: "qLDPC hardware summary",
      summaryMarkdown: "# qLDPC hardware summary\n\nSummary-only evidence for qLDPC routing.",
      tags: ["qldpc"]
    });
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "qldpc-page-without-claim-provenance",
          title: "qLDPC page without claim provenance",
          aliases: [],
          tags: ["qldpc"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-summary-layer"],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# qLDPC page without claim provenance\n\nqLDPC routing evidence."
      }
    });

    const result = await searchWikiEvidence({
      workspaceDir,
      query: "qLDPC routing",
      maxResults: 5
    });

    const warningsByKey = new Map(result.results.map((item) => [item.item.key, item.warnings]));
    assert.ok(warningsByKey.get("arxiv-summary-layer")?.includes("summary_only_evidence"));
    assert.ok(warningsByKey.get("qldpc-page-without-claim-provenance")?.includes("missing_claim_provenance"));
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
    assert.equal(result.item?.sourceKind, "paper");
    assert.equal(result.item?.sourceKey, paperKey);
    assert.deepEqual(result.item?.sourceRefs, [paperKey]);
    assert.equal(result.item?.evidenceContract, "mixed");
    assert.match(result.item?.body ?? "", /durable evidence text/);
    assert.equal(result.item?.relativePath, `knowledge-base/sources/${paperKey}/summary.md`);
    assert.equal(
      getKnowledgeSourceMetadataPath(workspaceDir, paperKey),
      path.join(workspaceDir, "knowledge-base", "sources", paperKey, "metadata.json")
    );
  });
});

test("retrieval contract returns generalized non-paper source evidence", async () => {
  await withWorkspace("wiki-retrieval-non-paper-source-", async (workspaceDir) => {
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/sources/material-sapphire-permittivity/summary.md",
      "# Sapphire permittivity\n\nRelative permittivity values require cryogenic-condition review."
    );
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/manifests/material-sapphire-permittivity.json",
      `${JSON.stringify(generalizedSourceManifest(), null, 2)}\n`
    );

    const result = await readWikiEvidenceItem({
      workspaceDir,
      kind: "source",
      key: "material-sapphire-permittivity"
    });

    assert.equal(result.status, "ready");
    assert.equal(result.item?.key, "material-sapphire-permittivity");
    assert.equal(result.item?.sourceKind, "material-database");
    assert.equal(result.item?.sourceKey, "material-sapphire-permittivity");
    assert.equal(result.item?.evidenceContract, "mixed");
    assert.deepEqual(result.item?.sourceRefs, ["material-sapphire-permittivity"]);
    assert.equal(result.item?.manifest?.schemaVersion, 2);
  });
});

test("retrieval contract rejects malformed generalized source manifests", async () => {
  const cases: Array<{ name: string; manifest: Record<string, unknown> }> = [
    {
      name: "invalid-artifact-kind",
      manifest: generalizedSourceManifest({
        artifacts: [{
          kind: "spreadsheet",
          path: "knowledge-base/sources/material-sapphire-permittivity/tables/parameters.json"
        }]
      })
    },
    {
      name: "invalid-artifact-optional-field",
      manifest: generalizedSourceManifest({
        artifacts: [{
          kind: "table",
          path: "knowledge-base/sources/material-sapphire-permittivity/tables/parameters.json",
          qualityPath: 42
        }]
      })
    },
    {
      name: "invalid-provenance-optional-field",
      manifest: generalizedSourceManifest({
        provenance: {
          url: 42,
          retrievedAt: "2026-05-14T00:00:00.000Z"
        }
      })
    }
  ];

  for (const item of cases) {
    await withWorkspace(`wiki-retrieval-v2-${item.name}-`, async (workspaceDir) => {
      await writeWorkspaceFile(
        workspaceDir,
        "knowledge-base/sources/material-sapphire-permittivity/summary.md",
        "# Sapphire permittivity\n\nMalformed manifest must not provide metadata."
      );
      await writeWorkspaceFile(
        workspaceDir,
        "knowledge-base/manifests/material-sapphire-permittivity.json",
        `${JSON.stringify(item.manifest, null, 2)}\n`
      );

      const result = await readWikiEvidenceItem({
        workspaceDir,
        kind: "source",
        key: "material-sapphire-permittivity"
      });

      assert.equal(result.status, "malformed", item.name);
      assert.equal(result.item?.manifest, undefined, item.name);
      assert.ok(
        result.diagnostics.some((diagnostic) => diagnostic.toLowerCase().includes("malformed manifest")),
        `${item.name}: expected malformed manifest diagnostic, got ${JSON.stringify(result.diagnostics)}`
      );
    });
  }
});

test("retrieval contract rejects generalized source manifest identity mismatches", async () => {
  const cases: Array<{ name: string; manifest: Record<string, unknown>; expectedDiagnostic: RegExp }> = [
    {
      name: "source-key-mismatch",
      manifest: generalizedSourceManifest({
        sourceKey: "material-silicon-permittivity"
      }),
      expectedDiagnostic: /sourceKey .* does not match requested source key/i
    },
    {
      name: "summary-path-mismatch",
      manifest: generalizedSourceManifest({
        summaryPath: "knowledge-base/sources/material-silicon-permittivity/summary.md"
      }),
      expectedDiagnostic: /summaryPath .* does not match source summary path/i
    }
  ];

  for (const item of cases) {
    await withWorkspace(`wiki-retrieval-v2-identity-${item.name}-`, async (workspaceDir) => {
      await writeWorkspaceFile(
        workspaceDir,
        "knowledge-base/sources/material-sapphire-permittivity/summary.md",
        "# Sapphire permittivity\n\nIdentity mismatches must not provide manifest metadata."
      );
      await writeWorkspaceFile(
        workspaceDir,
        "knowledge-base/manifests/material-sapphire-permittivity.json",
        `${JSON.stringify(item.manifest, null, 2)}\n`
      );

      const result = await readWikiEvidenceItem({
        workspaceDir,
        kind: "source",
        key: "material-sapphire-permittivity"
      });

      assert.equal(result.status, "malformed", item.name);
      assert.equal(result.item?.key, "material-sapphire-permittivity", item.name);
      assert.equal(result.item?.manifest, undefined, item.name);
      assert.deepEqual(result.item?.sourceRefs, [], item.name);
      assert.ok(
        result.diagnostics.some((diagnostic) => item.expectedDiagnostic.test(diagnostic)),
        `${item.name}: expected identity diagnostic, got ${JSON.stringify(result.diagnostics)}`
      );
    });
  }
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

test("retrieval contract exposes page evidence audit metadata", async () => {
  await withWorkspace("wiki-retrieval-audit-fields-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "logical-error-rate",
          title: "Logical error rate",
          aliases: [],
          tags: ["surface-code"],
          evidence_contract: "mixed",
          source_refs: ["arxiv-2406.06015"],
          claims: [{
            claimId: "claim-1",
            kind: "quantitative",
            statement: "The fitted threshold is 0.016.",
            sourceRefs: ["arxiv-2406.06015"],
            evidence: [{ paperKey: "arxiv-2406.06015", page: 1, figure: "16" }],
            confidence: "high"
          }],
          typed_relations: [{
            type: "supports",
            target: "surface-code",
            targetKind: "page",
            evidenceRefs: ["claim-1"],
            status: "confirmed"
          }],
          experiment_refs: [{
            experimentId: "exp-1",
            title: "Scaling fit reproduction",
            scriptPath: "experiments/scaling-fit/run.ts",
            status: "planned"
          }],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Logical error rate"
      }
    });

    const result = await readWikiEvidenceItem({
      workspaceDir,
      kind: "page",
      key: "logical-error-rate"
    });

    assert.equal(result.status, "ready");
    assert.equal(result.item?.claims?.[0].claimId, "claim-1");
    assert.equal(result.item?.typedRelations?.[0].type, "supports");
    assert.equal(result.item?.experimentRefs?.[0].experimentId, "exp-1");
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

test("searchWikiEvidence matches claim and typed relation fields", async () => {
  await withWorkspace("wiki-structured-claim-search-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "finding",
          key: "bivariate-bicycle-embedding",
          title: "Hardware embedding comparison",
          aliases: [],
          tags: ["qldpc"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2406.06015"],
          knowledge_state: "promising_unverified",
          last_reviewed_at: "2026-05-01T00:00:00.000Z",
          claims: [{
            claimId: "claim-embedding",
            kind: "qualitative",
            statement: "Bivariate bicycle code layouts require checking nonlocal coupler pressure.",
            sourceRefs: ["arxiv-2406.06015"],
            evidence: [{ paperKey: "arxiv-2406.06015", sectionId: "hardware-layout" }],
            confidence: "medium"
          }],
          typed_relations: [{
            type: "contradicts",
            target: "hypergraph-product-code",
            targetKind: "page",
            evidenceRefs: ["claim-embedding"],
            status: "candidate"
          }],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Hardware embedding comparison\n\nNo body keyword for coupler pressure."
      }
    });

    const claimResult = await searchWikiEvidence({
      workspaceDir,
      query: "nonlocal coupler pressure",
      maxResults: 5,
      claimKinds: ["qualitative"],
      knowledgeStates: ["promising_unverified"]
    });

    assert.equal(claimResult.status, "ready");
    assert.equal(claimResult.results[0].item.key, "bivariate-bicycle-embedding");
    assert.ok(claimResult.results[0].matchReasons.includes("claim"));
    assert.ok(claimResult.results[0].warnings.includes("promising_unverified"));

    const relationResult = await searchWikiEvidence({
      workspaceDir,
      query: "hypergraph product contradiction",
      maxResults: 5
    });

    assert.equal(relationResult.status, "ready");
    assert.ok(relationResult.results[0].matchReasons.includes("typed_relation"));
    assert.ok(relationResult.results[0].warnings.includes("unresolved_contradiction"));
  });
});

test("searchWikiEvidence emits stale and unknown freshness warnings", async () => {
  await withWorkspace("wiki-structured-freshness-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "fixed-frequency-transmon-crowding",
          title: "Fixed-frequency transmon crowding",
          aliases: [],
          tags: ["superconducting-qubits"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00003"],
          knowledge_state: "established",
          last_reviewed_at: "2026-01-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        },
        body: "# Fixed-frequency transmon crowding\n\nFrequency collision risk."
      }
    });
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "unknown-review-page",
          title: "Unknown review page",
          aliases: [],
          tags: ["superconducting-qubits"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00004"],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Unknown review page\n\nFrequency collision risk."
      }
    });

    const result = await searchWikiEvidence({
      workspaceDir,
      query: "frequency collision",
      maxResults: 5,
      maxEvidenceAgeDays: 30,
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    const warningsByKey = new Map(result.results.map((item) => [item.item.key, item.warnings]));
    assert.ok(warningsByKey.get("fixed-frequency-transmon-crowding")?.includes("stale_evidence"));
    assert.ok(warningsByKey.get("unknown-review-page")?.includes("unknown_freshness"));
  });
});

test("searchPaperWiki preserves structured freshness warnings with caller clock", async () => {
  await withWorkspace("wiki-public-search-freshness-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "frequency-collision-public-warning",
          title: "Frequency collision public warning",
          aliases: [],
          tags: ["superconducting-qubits"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00003"],
          knowledge_state: "established",
          last_reviewed_at: "2026-01-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        },
        body: "# Frequency collision public warning\n\nFrequency collision risk."
      }
    });

    const result = await searchPaperWiki({
      workspaceDir,
      query: "frequency collision public warning",
      maxResults: 5,
      maxEvidenceAgeDays: 30,
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    assert.equal(result.results[0].pageKey, "frequency-collision-public-warning");
    assert.ok(result.results[0].warnings?.includes("stale_evidence"));
  });
});

test("searchPaperWiki honors structured filters without legacy fallback", async () => {
  await withWorkspace("wiki-public-search-filtered-fallback-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "concept-filter-leak",
          title: "Concept filter leak",
          aliases: [],
          tags: ["superconducting-qubits"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2601.00003"],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Concept filter leak\n\nDataset-only query phrase appears here."
      }
    });

    const result = await searchPaperWiki({
      workspaceDir,
      query: "dataset only query phrase",
      maxResults: 5,
      pageTypes: ["dataset"]
    });

    assert.deepEqual(result.results, []);
  });
});

test("searchPaperWiki treats now without freshness threshold as inert", async () => {
  await withWorkspace("wiki-public-search-now-inert-", async (workspaceDir) => {
    await writeLegacySourceWithManifest({
      workspace: workspaceDir,
      paperKey: "aaa-common-words",
      title: "Unrelated Common Words",
      summaryMarkdown: [
        "# Unrelated Common Words",
        "",
        "What are the ordinary words in this unrelated note."
      ].join("\n"),
      tags: []
    });
    await writeLegacySourceWithManifest({
      workspace: workspaceDir,
      paperKey: "source-b",
      title: "qLDPC Hardware Constraints",
      summaryMarkdown: [
        "# qLDPC Hardware Constraints",
        "",
        "This source discusses non-local connectivity, long-range couplers, crosstalk, leakage, and measurement overhead."
      ].join("\n"),
      tags: ["qldpc"]
    });

    const withoutNow = await searchPaperWiki({
      workspaceDir,
      query: "what are the implementation barriers",
      maxResults: 1
    });
    const withNow = await searchPaperWiki({
      workspaceDir,
      query: "what are the implementation barriers",
      maxResults: 1,
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    assert.deepEqual(withNow.results, withoutNow.results);
    assert.equal(withNow.results[0]?.paperKey, "source-b");
  });
});

test("searchWikiEvidence preserves diagnostic warnings", async () => {
  await withWorkspace("wiki-search-diagnostic-warnings-", async (workspaceDir) => {
    await writeWorkspaceFile(
      workspaceDir,
      "knowledge-base/sources/arxiv-2601.00004/summary.md",
      "# Diagnostic warning source\n\nDiagnostic keyword body."
    );

    const result = await searchWikiEvidence({
      workspaceDir,
      query: "diagnostic keyword",
      maxResults: 5
    });

    assert.equal(result.status, "ready");
    assert.equal(result.results[0].item.key, "arxiv-2601.00004");
    assert.ok(
      result.results[0].warnings.some((warning) => warning.toLowerCase().includes("missing manifest")),
      `expected missing manifest warning, got ${JSON.stringify(result.results[0].warnings)}`
    );
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
