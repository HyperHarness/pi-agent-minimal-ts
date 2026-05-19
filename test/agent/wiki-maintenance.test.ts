import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { lintPaperWiki } from "../../src/agent/wiki/lint.js";
import { planWikiStructure } from "../../src/agent/wiki/structure-plan.js";
import {
  auditPageEvidenceContracts,
  auditScopeDrift,
  buildWikiCoverageMap,
  rankConceptGaps,
  readWikiMaintenanceDocuments,
  suggestSemanticAliases
} from "../../src/agent/wiki/maintenance.js";

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pi-wiki-maintenance-"));
}

async function writeMarkdown(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${content.trim()}\n`, "utf8");
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeSource(workspaceDir: string, paperKey: string, content: string): Promise<void> {
  await writeMarkdown(path.join(workspaceDir, "knowledge-base", "sources", paperKey, "summary.md"), content);
}

async function writePage(workspaceDir: string, pageKey: string, content: string): Promise<void> {
  await writeMarkdown(path.join(workspaceDir, "knowledge-base", "pages", `${pageKey}.md`), content);
}

async function writeReadySourceManifest(workspaceDir: string, paperKey: string, tags: string[] = []): Promise<void> {
  await writeJson(path.join(workspaceDir, "knowledge-base", "manifests", `${paperKey}.json`), {
    schemaVersion: 1,
    kind: "paper-source",
    paperKey,
    title: `${paperKey} Evidence`,
    status: "ready",
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
    sourceSummaryPath: `knowledge-base/sources/${paperKey}/summary.md`,
    provenance: {},
    parse: {
      engine: "plain-text-baseline",
      markdownPath: `knowledge-base/sources/${paperKey}/parses/plain-text-baseline/document.md`,
      jsonPath: `knowledge-base/sources/${paperKey}/parses/plain-text-baseline/parse.json`,
      qualityPath: `knowledge-base/sources/${paperKey}/parses/plain-text-baseline/quality.json`
    },
    tags,
    relatedPaperKeys: [],
    synthesisPageKeys: []
  });
}

async function createMaintenanceFixture(): Promise<string> {
  const workspace = await createWorkspace();

  await writeSource(
    workspace,
    "paper-a",
    `
---
paper_key: paper-a
title: Frequency Planning for Tunable Coupler Processors
tags:
  - tunable coupler
  - fixed frequency transmons
  - superconducting chip design
  - frequency planning
related_papers:
  - paper-c
---

Tunable coupler frequency planning for superconducting chip design.
`
  );

  await writeSource(
    workspace,
    "paper-b",
    `
---
paper_key: paper-b
title: Uncovered Tunable Coupler Layout Constraints
tags:
  - tunable coupler
  - fixed frequency transmons
  - superconducting chip design
  - frequency planning
---

This source is intentionally not cited by a page.
`
  );

  await writeSource(
    workspace,
    "paper-c",
    `
---
paper_key: paper-c
title: Qubit Calibration Drift Study
tags:
  - qubit calibration
  - tuneup workflow
---

Calibration procedures for qubit tuneup workflows.
`
  );

  await writeSource(
    workspace,
    "paper-d",
    `
---
paper_key: paper-d
title: Autonomous Quantum EDA Agents
tags:
  - agentic chip design
  - quantum EDA
---

Autonomous agents for quantum EDA planning.
`
  );

  await writePage(
    workspace,
    "qubit-calibration",
    `
---
title: Qubit Calibration
tags:
  - qubit calibration
sources:
  - paper_key: paper-c
    title: Qubit Calibration Drift Study
    path: knowledge-base/sources/paper-c/summary.md
---

# Qubit Calibration

This page cites one source.
`
  );

  await writePage(
    workspace,
    "tunable-coupler",
    `
---
title: Tunable Coupler
tags:
  - tunable coupler
sources:
  - paper_key: paper-a
    title: Frequency Planning for Tunable Coupler Processors
    path: knowledge-base/sources/paper-a/summary.md
---

# Tunable Coupler

This paper-backed page already has citations.
`
  );

  await writePage(
    workspace,
    "agentic-chip-design",
    `
---
title: Agentic Chip Design
tags:
  - agentic chip design
---

# Agentic Chip Design

Million-qubit systems need an agent workflow and infrastructure design methodology for chip planning.

## Later Details

The design page intentionally has no source citations.
`
  );

  await writePage(
    workspace,
    "history-of-quantum-computing",
    `
---
title: History of Quantum Computing
---

# History of Quantum Computing

This page gives a historical overview of quantum computing milestones.

## Later Speculation

Million-qubit roadmaps were mentioned by later superconducting roadmaps.
`
  );

  await writePage(
    workspace,
    "agentic-autonomous-quantum-eda",
    `
---
title: Agentic Autonomous Quantum EDA for Superconducting Processor Design
tags:
  - agentic chip design
sources:
  - paper_key: paper-d
    title: Autonomous Quantum EDA Agents
    path: knowledge-base/sources/paper-d/summary.md
---

# Agentic Autonomous Quantum EDA

Agents coordinate quantum EDA planning.
`
  );

  await writePage(
    workspace,
    "autonomous-agentic-quantum-eda",
    `
---
title: Autonomous Agentic Quantum EDA for Superconducting Chip Design
tags:
  - quantum EDA
sources:
  - paper_key: paper-d
    title: Autonomous Quantum EDA Agents
    path: knowledge-base/sources/paper-d/summary.md
---

# Autonomous Agentic Quantum EDA

Autonomous chip design agents coordinate quantum EDA planning.
`
  );

  return workspace;
}

test("buildWikiCoverageMap reports source coverage, tag clusters, and weak pages", async () => {
  const workspace = await createMaintenanceFixture();

  try {
    await writeSource(
      workspace,
      "paper-empty-list",
      [
        "---",
        "paper_key: paper-empty-list",
        "title: Empty List Fixture",
        "tags: []",
        "related_papers: []",
        "---",
        "",
        "This source should not create a bogus [] tag."
      ].join("\r\n")
    );
    const documents = await readWikiMaintenanceDocuments(workspace);
    assert.deepEqual(documents.sources.find((source) => source.paperKey === "paper-a")?.relatedPaperKeys, ["paper-c"]);
    assert.deepEqual(documents.sources.find((source) => source.paperKey === "paper-empty-list")?.tags, []);
    assert.deepEqual(documents.sources.find((source) => source.paperKey === "paper-empty-list")?.relatedPaperKeys, []);

    const coverage = await buildWikiCoverageMap({ workspaceDir: workspace });

    assert.equal(coverage.sourceCount, 5);
    assert.equal(coverage.pageCount, 6);
    assert.equal(coverage.coveredSourceCount, 3);
    assert.deepEqual(
      coverage.uncoveredSources.map((source) => source.paperKey),
      ["paper-b", "paper-empty-list"]
    );
    assert.ok(!coverage.tagClusters.some((cluster) => cluster.tag === "[]"));
    assert.equal(coverage.uncoveredSources[0]?.reason, "not_cited_by_any_page");
    assert.deepEqual(coverage.uncoveredSources[0]?.candidatePageKeys, ["tunable-coupler"]);
    assert.ok(
      coverage.tagClusters.some(
        (cluster) => cluster.tag === "qubit-calibration" && cluster.sourceCount === 1 && cluster.existingPageKey === "qubit-calibration"
      )
    );
    assert.ok(
      coverage.weaklyCoveredPages.some(
        (page) => page.pageKey === "qubit-calibration" && page.sourceCount === 1
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("readWikiMaintenanceDocuments uses typed key instead of page filename", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "different-file",
      `
---
schema_version: 1
type: "synthesis"
key: "typed-canonical-key"
title: "Typed Canonical Key"
aliases: []
tags: []
evidence_contract: "none"
source_refs: []
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Typed Canonical Key
`
    );

    const documents = await readWikiMaintenanceDocuments(workspace);
    const page = documents.pages.find((candidate) => candidate.path === "knowledge-base/pages/different-file.md");

    assert.equal(page?.pageKey, "typed-canonical-key");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("readWikiMaintenanceDocuments recognizes typed alias canonical page", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "typed-alias",
      `
---
schema_version: 1
type: "alias"
key: "typed-alias"
title: "Typed Alias"
aliases: []
tags: []
evidence_contract: "none"
source_refs: []
canonical_page: "typed-canonical-key"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Typed Alias
`
    );

    const documents = await readWikiMaintenanceDocuments(workspace);
    const alias = documents.pages.find((page) => page.pageKey === "typed-alias");

    assert.equal(alias?.isAlias, true);
    assert.equal(alias?.canonicalPageKey, "typed-canonical-key");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rankConceptGaps prioritizes ready high-value concepts and defers existing pages", async () => {
  const workspace = await createMaintenanceFixture();

  try {
    const result = await rankConceptGaps({
      workspaceDir: workspace,
      goal: "superconducting chip design",
      focus: ["frequency planning", "fixed frequency transmons"]
    });
    const gaps = result.rankedConcepts;

    assert.equal(gaps[0]?.concept, "fixed-frequency-transmons");
    assert.equal(gaps[0]?.priority, "high");
    assert.equal(gaps[0]?.evidenceReadiness, "ready");
    assert.ok(gaps[0]?.score);
    assert.equal(gaps[0]?.recommendedAction, "build_page");
    assert.equal(gaps[0]?.candidateCanonicalPage, undefined);
    assert.deepEqual(
      gaps[0]?.representativeSources.map((source) => source.paperKey),
      ["paper-a", "paper-b"]
    );
    assert.match(gaps[0]?.rationale ?? "", /2 source/);

    const calibration = gaps.find((gap) => gap.concept === "qubit-calibration");
    assert.equal(calibration?.recommendedAction, "defer");
    assert.equal(calibration?.candidateCanonicalPage, "qubit-calibration");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("auditPageEvidenceContracts reports uncited design-backed pages but not paper-backed pages", async () => {
  const workspace = await createMaintenanceFixture();

  try {
    const result = await auditPageEvidenceContracts({ workspaceDir: workspace });
    const issues = result.evidenceContractGaps;

    const designIssue = issues.find((issue) => issue.pageKey === "agentic-chip-design");
    assert.equal(designIssue?.inferredContract, "design-backed");
    assert.equal(designIssue?.sourceCount, 0);
    assert.ok(!issues.some((issue) => issue.pageKey === "tunable-coupler"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("suggestSemanticAliases reports strong near duplicates with shared source evidence", async () => {
  const workspace = await createMaintenanceFixture();

  try {
    const result = await suggestSemanticAliases({ workspaceDir: workspace, minScore: 0.45 });
    const aliases = result.suggestions;

    assert.equal(aliases.length, 1);
    assert.equal(aliases[0]?.canonicalPageKey, "agentic-autonomous-quantum-eda");
    assert.equal(aliases[0]?.aliasPageKey, "autonomous-agentic-quantum-eda");
    assert.equal(aliases[0]?.risk, "low");
    assert.ok(aliases[0]?.score >= 0.45);
    assert.ok(aliases[0]?.evidence.some((entry) => entry.includes("paper-d")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("suggestSemanticAliases ignores related pages that only share broad domain vocabulary", async () => {
  const workspace = await createWorkspace();

  try {
    for (const page of [
      {
        key: "decoding",
        title: "Decoding in Fault-Tolerant Quantum Computing",
        refs: ["paper-ftqc-a", "paper-ftqc-b", "paper-ftqc-c"]
      },
      {
        key: "logical-gates",
        title: "Logical Gates in Fault-Tolerant Quantum Computing",
        refs: ["paper-ftqc-a", "paper-ftqc-b", "paper-ftqc-c"]
      },
      {
        key: "frequency-allocation",
        title: "Frequency Allocation in Superconducting Quantum Processors",
        refs: ["paper-frequency-a", "paper-frequency-b"]
      },
      {
        key: "frequency-collisions",
        title: "Frequency Collisions in Superconducting Quantum Processors",
        refs: ["paper-frequency-a", "paper-frequency-b"]
      },
      {
        key: "high-level-synthesis",
        title: "High-Level Synthesis in LLM4EDA and Automated Chip Design",
        refs: ["paper-eda-a", "paper-eda-b"]
      },
      {
        key: "verilog",
        title: "Verilog in LLM4EDA, Hardware Design Automation, and High-Level Synthesis",
        refs: ["paper-eda-a", "paper-eda-b"]
      }
    ]) {
      await writePage(
        workspace,
        page.key,
        `
---
schema_version: 1
type: "concept"
key: "${page.key}"
title: "${page.title}"
aliases: []
tags: []
evidence_contract: "paper-backed"
source_refs:
${page.refs.map((ref) => `  - "${ref}"`).join("\n")}
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# ${page.title}

Shared source evidence in the same broad topic area.
`
      );
    }

    const result = await suggestSemanticAliases({ workspaceDir: workspace });

    assert.deepEqual(result.suggestions, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("suggestSemanticAliases keeps versioned specification aliases when the canonical page is otherwise narrower", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "minimal-superconducting-qldpc-chip",
      `
---
schema_version: 1
type: "concept"
key: "minimal-superconducting-qldpc-chip"
title: "Minimal Superconducting qLDPC Chip Design"
aliases: []
tags: []
evidence_contract: "paper-backed"
source_refs:
  - "paper-qldpc-a"
  - "paper-qldpc-b"
  - "paper-qldpc-c"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Minimal Superconducting qLDPC Chip Design
`
    );
    await writePage(
      workspace,
      "minimal-superconducting-qldpc-chip-v0-1-spec",
      `
---
schema_version: 1
type: "concept"
key: "minimal-superconducting-qldpc-chip-v0-1-spec"
title: "Minimal Superconducting qLDPC Flip-Chip Processor v0.1 Specification"
aliases: []
tags: []
evidence_contract: "paper-backed"
source_refs:
  - "paper-qldpc-a"
  - "paper-qldpc-b"
  - "paper-qldpc-c"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Minimal Superconducting qLDPC Flip-Chip Processor v0.1 Specification
`
    );

    const result = await suggestSemanticAliases({ workspaceDir: workspace });

    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0]?.canonicalPageKey, "minimal-superconducting-qldpc-chip");
    assert.equal(result.suggestions[0]?.aliasPageKey, "minimal-superconducting-qldpc-chip-v0-1-spec");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("auditScopeDrift reports stale central framing only in scoped page regions", async () => {
  const workspace = await createMaintenanceFixture();

  try {
    const result = await auditScopeDrift({
      workspaceDir: workspace,
      staleTerms: ["million-qubit"],
      preferredFraming: "agentic chip design"
    });
    const drift = result.findings;

    assert.deepEqual(
      drift.map((issue) => issue.pageKey),
      ["agentic-chip-design"]
    );
    assert.equal(drift[0]?.kind, "scope_drift");
    assert.equal(drift[0]?.severity, "medium");
    assert.ok(drift[0]?.evidence.some((entry) => entry.includes("million-qubit")));
    assert.match(drift[0]?.suggestedScopeNote ?? "", /agentic chip design/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki emits rich maintenance issues and optional reports", async () => {
  const workspace = await createMaintenanceFixture();

  try {
    const result = await lintPaperWiki({
      workspaceDir: workspace,
      goal: "superconducting chip design",
      focus: ["frequency planning", "fixed frequency transmons"],
      includeCoverage: true,
      includeQualityAudit: true,
      includeAliasCandidates: true,
      maxItems: 50
    });

    const highValueGap = result.issues.find(
      (issue) => issue.kind === "high_value_concept_gap" && issue.concept === "fixed-frequency-transmons"
    );
    assert.equal(highValueGap?.severity, "medium");
    assert.equal(highValueGap?.count, 2);
    assert.equal(highValueGap?.sourceCount, 2);
    assert.ok((highValueGap?.score ?? 0) >= 8);
    assert.match(highValueGap?.target ?? "", /knowledge-base\/pages\/fixed-frequency-transmons\.md$/);
    assert.match(highValueGap?.reason ?? "", /2 sources mention fixed-frequency-transmons/);

    const evidenceGap = result.issues.find(
      (issue) => issue.kind === "evidence_contract_gap" && issue.target === "agentic-chip-design"
    );
    assert.equal(evidenceGap?.severity, "low");
    assert.match(evidenceGap?.reason ?? "", /no source citations/);
    const aliasCandidate = result.issues.find((issue) => issue.kind === "semantic_alias_candidate");
    assert.equal(aliasCandidate?.path, "knowledge-base/pages/autonomous-agentic-quantum-eda.md");
    assert.equal(aliasCandidate?.target, "agentic-autonomous-quantum-eda");
    const scopeDrift = result.issues.find((issue) => issue.kind === "scope_drift" && issue.target === "agentic-chip-design");
    assert.equal(scopeDrift?.severity, "medium");
    assert.match(scopeDrift?.reason ?? "", /central framing contains stale term: million-qubit/);

    assert.equal(result.reports?.conceptTriage?.rankedConcepts[0]?.concept, "fixed-frequency-transmons");
    assert.equal(result.reports?.coverage?.sourceCount, 4);
    assert.ok(result.reports?.pageQuality?.evidenceContractGaps.some((issue) => issue.pageKey === "agentic-chip-design"));
    assert.equal(result.reports?.aliasCandidates?.suggestions[0]?.aliasPageKey, "autonomous-agentic-quantum-eda");
    assert.equal(result.reports?.scopeDrift?.findings[0]?.pageKey, "agentic-chip-design");

    const defaultResult = await lintPaperWiki({
      workspaceDir: workspace,
      goal: "",
      focus: [],
      maxItems: 50
    });
    assert.equal(defaultResult.summary.high_value_concept_gap, 0);
    assert.ok(!defaultResult.issues.some((issue) => issue.kind === "high_value_concept_gap"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki reports source_without_synthesis_coverage for ready sources", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "paper-uncovered";
    await writeReadySourceManifest(workspace, paperKey, ["uncovered-topic"]);
    await writeSource(
      workspace,
      paperKey,
      `
---
paper_key: ${paperKey}
title: Uncovered Source
tags:
  - uncovered-topic
---

No synthesis page cites this source.
`
    );

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeCoverage: true,
      maxItems: 50
    });

    assert.equal(result.summary.source_without_synthesis_coverage, 1);
    assert.ok(result.issues.some((issue) =>
      issue.kind === "source_without_synthesis_coverage" &&
      issue.target === paperKey
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki treats inline paper-key citations as synthesis evidence", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "aps-10.1103-PhysRevLett.127.080505";
    await writeReadySourceManifest(workspace, paperKey, ["agentic-chip-design"]);
    await writeSource(
      workspace,
      paperKey,
      `
---
paper_key: ${paperKey}
title: Tunable Coupler Evidence
tags:
  - agentic-chip-design
---

Source-backed evidence for a chip-design page.
`
    );
    await writePage(
      workspace,
      "agentic-chip-design",
      `
---
type: "wiki-synthesis-page"
page_key: "agentic-chip-design"
title: "Agentic Chip Design"
related_pages: []
---

# Agentic Chip Design

The page cites an existing source in the body [${paperKey}], but it has no legacy frontmatter sources list.
`
    );

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeCoverage: true,
      includeQualityAudit: true,
      maxItems: 50
    });

    assert.equal(result.summary.evidence_contract_gap, 0);
    assert.equal(result.summary.source_without_synthesis_coverage, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki does not require synthesis coverage for needs_review V2 sources", async () => {
  const workspace = await createWorkspace();

  try {
    const sourceKey = "design-artifact-single-xmon-concept";
    await writeSource(
      workspace,
      sourceKey,
      `
# Single Xmon Concept Layout

Local design artifact awaiting review.
`
    );
    await writeJson(path.join(workspace, "knowledge-base", "manifests", `${sourceKey}.json`), {
      schemaVersion: 2,
      sourceKind: "design-artifact",
      sourceKey,
      title: "Single Xmon Concept Layout",
      status: "needs_review",
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:00:00.000Z",
      summaryPath: `knowledge-base/sources/${sourceKey}/summary.md`,
      provenance: {},
      artifacts: [],
      tags: ["design-artifact"],
      relatedSourceKeys: [],
      synthesisPageKeys: []
    });

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeCoverage: true,
      maxItems: 50
    });

    assert.equal(result.summary.source_without_synthesis_coverage, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki skips manifest-only sources with unsafe sourceSummaryPath", async () => {
  const workspace = await createWorkspace();
  const outside = await createWorkspace();

  try {
    const paperKey = "paper-unsafe-manifest-path";
    const outsideSummaryPath = path.join(outside, "summary.md");
    await writeText(outsideSummaryPath, "outside summary exists");
    await writeJson(path.join(workspace, "knowledge-base", "manifests", `${paperKey}.json`), {
      schemaVersion: 1,
      kind: "paper-source",
      paperKey,
      title: "Unsafe Manifest Source",
      status: "ready",
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      sourceSummaryPath: outsideSummaryPath,
      provenance: {},
      parse: {
        engine: "plain-text-baseline",
        markdownPath: `knowledge-base/sources/${paperKey}/parses/plain-text-baseline/document.md`,
        jsonPath: `knowledge-base/sources/${paperKey}/parses/plain-text-baseline/parse.json`,
        qualityPath: `knowledge-base/sources/${paperKey}/parses/plain-text-baseline/quality.json`
      },
      tags: ["unsafe-manifest-path"],
      relatedPaperKeys: [],
      synthesisPageKeys: []
    });

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeCoverage: true,
      maxItems: 50
    });

    assert.ok(!result.issues.some((issue) =>
      issue.kind === "source_without_synthesis_coverage" &&
      issue.target === paperKey
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("typed source_refs mark sources as covered in coverage diagnostics", async () => {
  const workspace = await createWorkspace();

  try {
    const paperKey = "paper-covered";
    await writeReadySourceManifest(workspace, paperKey, ["covered-topic"]);
    await writeSource(
      workspace,
      paperKey,
      `
---
paper_key: ${paperKey}
title: Covered Source
tags:
  - covered-topic
---

Typed pages cite this source by source_refs.
`
    );
    await writePage(
      workspace,
      "typed-covered-page",
      `
---
schema_version: 1
type: "synthesis"
key: "typed-covered-page"
title: "Typed Covered Page"
aliases: []
tags: []
evidence_contract: "paper-backed"
source_refs:
  - "${paperKey}"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Typed Covered Page

This page cites a ready source by typed source refs.
`
    );

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeCoverage: true,
      maxItems: 50
    });

    assert.ok(!result.issues.some((issue) =>
      issue.kind === "source_without_synthesis_coverage" &&
      issue.target === paperKey
    ));
    assert.equal(result.reports?.coverage?.coveredSourceCount, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki reports pages with missing source refs for paper-backed contracts", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "pages", "weak.md"), [
      "---",
      "schema_version: 1",
      'type: "synthesis"',
      'key: "weak"',
      'title: "Weak Evidence"',
      "aliases: []",
      "tags: []",
      'evidence_contract: "paper-backed"',
      "source_refs: []",
      'created_at: "2026-05-10T00:00:00.000Z"',
      'updated_at: "2026-05-10T00:00:00.000Z"',
      "---",
      "",
      "# Weak Evidence"
    ].join("\n"));

    const result = await lintPaperWiki({ workspaceDir: workspace, includeQualityAudit: true });

    assert.ok(result.issues.some((issue) =>
      issue.kind === "weak_evidence_contract" &&
      issue.path === "knowledge-base/pages/weak.md"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki initializes weak evidence contract summary count", async () => {
  const workspace = await createWorkspace();
  try {
    const result = await lintPaperWiki({ workspaceDir: workspace, includeQualityAudit: true });

    assert.equal(result.summary.weak_evidence_contract, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki reports evidence audit gaps for typed pages", async () => {
  const workspace = await createWorkspace();
  try {
    await writePage(workspace, "invalid-claim-page", `
---
schema_version: 1
type: concept
key: invalid-claim-page
title: Invalid Claim Page
aliases: []
tags: []
evidence_contract: mixed
source_refs:
  - "arxiv-2406.06015"
claims: [{"claimId":"claim-1","kind":"quantitative","statement":"The threshold is 0.016.","sourceRefs":["arxiv-2406.06015"],"evidence":[{"paperKey":"arxiv-2406.06015","quote":"fit"}],"confidence":"high"}]
created_at: 2026-05-10T00:00:00.000Z
updated_at: 2026-05-10T00:00:00.000Z
---

# Invalid Claim Page
`);
    await writePage(workspace, "typed-relation-gap", `
---
schema_version: 1
type: concept
key: typed-relation-gap
title: Typed Relation Gap
aliases: []
tags: []
evidence_contract: paper-backed
source_refs:
  - "arxiv-2406.06015"
related_pages:
  - "surface-code"
created_at: 2026-05-10T00:00:00.000Z
updated_at: 2026-05-10T00:00:00.000Z
---

# Typed Relation Gap
`);
    await writePage(workspace, "contradiction-and-experiment-gap", `
---
schema_version: 1
type: concept
key: contradiction-and-experiment-gap
title: Contradiction And Experiment Gap
aliases: []
tags: []
evidence_contract: mixed
source_refs:
  - "arxiv-2406.06015"
claims: [{"claimId":"claim-2","kind":"quantitative","statement":"The threshold is 0.016.","sourceRefs":["arxiv-2406.06015"],"evidence":[{"paperKey":"arxiv-2406.06015","page":1}],"confidence":"high"}]
typed_relations: [{"type":"contradicts","target":"other-paper","targetKind":"source","evidenceRefs":["claim-2"],"status":"candidate"}]
experiment_refs: [{"experimentId":"exp-1","title":"Missing log","logPath":"experiments/missing.log","status":"ran"}]
created_at: 2026-05-10T00:00:00.000Z
updated_at: 2026-05-10T00:00:00.000Z
---

# Contradiction And Experiment Gap
`);

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 40
    });

    const kinds = result.issues.map((issue) => issue.kind);
    assert.ok(kinds.includes("missing_claim_provenance"));
    assert.ok(kinds.includes("unresolved_contradiction"));
    assert.ok(kinds.includes("missing_typed_relation"));
    assert.ok(kinds.includes("missing_experiment_ref"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki_lint quality audit reports missing knowledge state and review date", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-lint-knowledge-state-"));
  try {
    await writeMarkdown(path.join(workspace, "knowledge-base/pages/unreviewed-finding.md"), [
      "---",
      "schema_version: 1",
      "type: finding",
      "key: unreviewed-finding",
      "title: Unreviewed finding",
      "aliases: []",
      "tags: []",
      "evidence_contract: paper-backed",
      "source_refs:",
      '  - "arxiv-2406.06015"',
      "created_at: 2026-05-10T00:00:00.000Z",
      "updated_at: 2026-05-10T00:00:00.000Z",
      "---",
      "",
      "# Unreviewed finding",
      "",
      "Claim text."
    ].join("\n"));
    await writeMarkdown(path.join(workspace, "knowledge-base/pages/disputed-without-relation.md"), [
      "---",
      "schema_version: 1",
      "type: finding",
      "key: disputed-without-relation",
      "title: Disputed without relation",
      "aliases: []",
      "tags: []",
      "evidence_contract: paper-backed",
      "source_refs:",
      '  - "arxiv-2406.06016"',
      "knowledge_state: disputed",
      "last_reviewed_at: 2026-05-01T00:00:00.000Z",
      "created_at: 2026-05-10T00:00:00.000Z",
      "updated_at: 2026-05-10T00:00:00.000Z",
      "---",
      "",
      "# Disputed without relation"
    ].join("\n"));

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 20
    });

    const kinds = result.issues.map((issue) => issue.kind);
    assert.ok(kinds.includes("missing_knowledge_state"));
    assert.ok(kinds.includes("missing_last_reviewed_at"));
    assert.ok(kinds.includes("disputed_without_contradiction"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki reports code-backed pages without experiment refs", async () => {
  const workspace = await createWorkspace();
  try {
    await writePage(workspace, "code-backed-page", `
---
schema_version: 1
type: concept
key: code-backed-page
title: Code Backed Page
aliases: []
tags: []
evidence_contract: code-backed
source_refs:
  - "local-helper"
created_at: 2026-05-10T00:00:00.000Z
updated_at: 2026-05-10T00:00:00.000Z
---

# Code Backed Page
`);

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 20
    });

    assert.ok(result.issues.some((issue) => issue.kind === "code_backed_without_experiment"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki treats typed source refs as paper-backed citations", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "pages", "typed-paper-backed.md"), [
      "---",
      "schema_version: 1",
      'type: "synthesis"',
      'key: "typed-paper-backed"',
      'title: "Typed Paper Backed"',
      "aliases: []",
      "tags: []",
      'evidence_contract: "paper-backed"',
      "source_refs:",
      '  - "paper-a"',
      'created_at: "2026-05-10T00:00:00.000Z"',
      'updated_at: "2026-05-10T00:00:00.000Z"',
      "---",
      "",
      "# Typed Paper Backed",
      "",
      "This short typed page is grounded by source_refs."
    ].join("\n"));

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 50
    });

    assert.ok(!result.issues.some((issue) =>
      (issue.kind === "weak_evidence_contract" ||
        issue.kind === "missing_source_citation" ||
        issue.kind === "evidence_contract_gap") &&
      issue.path === "knowledge-base/pages/typed-paper-backed.md"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki does not classify mixed typed diagnostics as weak evidence", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base", "pages", "mixed.md"), [
      "---",
      "schema_version: 1",
      'type: "synthesis"',
      'key: ""',
      'title: "Mixed"',
      "aliases: []",
      "tags: []",
      'evidence_contract: "paper-backed"',
      "source_refs: []",
      'created_at: "2026-05-10T00:00:00.000Z"',
      'updated_at: "2026-05-10T00:00:00.000Z"',
      "---",
      "",
      "# Mixed"
    ].join("\n"));

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 50
    });

    assert.ok(!result.issues.some((issue) =>
      issue.kind === "weak_evidence_contract" &&
      issue.path === "knowledge-base/pages/mixed.md"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki reports material dataset rows without units or conditions", async () => {
  const workspace = await createWorkspace();
  try {
    await writePage(workspace, "substrate-material-parameters", `
---
schema_version: 1
type: dataset
key: substrate-material-parameters
title: Substrate Material Parameters
aliases: []
tags: []
evidence_contract: mixed
source_refs:
  - "material-sapphire-permittivity"
created_at: 2026-05-10T00:00:00.000Z
updated_at: 2026-05-10T00:00:00.000Z
---

# Substrate Material Parameters

## Parameter Table

| Parameter | Value | Unit | Conditions | Source |
| --- | --- | --- | --- | --- |
| Sapphire relative permittivity | 9.4 |  |  | material-sapphire-permittivity |

## Applicability

Applies to substrate-level superconducting chip simulations.

## Design Implications

Use this value to seed electromagnetic design sweeps.

## Known Uncertainty

Temperature and frequency dependence still need source-level checks.

## Related Pages

- [[hfss-eigenmode-simulation]]
`);

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 50
    });

    const kinds = result.issues.map((issue) => issue.kind);
    assert.ok(kinds.includes("material_parameter_missing_unit"));
    assert.ok(kinds.includes("material_parameter_missing_condition"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki accepts singular material parameter condition header", async () => {
  const workspace = await createWorkspace();
  try {
    await writePage(workspace, "substrate-material-conditions", `
---
schema_version: 1
type: dataset
key: substrate-material-conditions
title: Substrate Material Conditions
aliases: []
tags: []
evidence_contract: mixed
source_refs:
  - "material-sapphire-permittivity"
created_at: 2026-05-10T00:00:00.000Z
updated_at: 2026-05-10T00:00:00.000Z
---

# Substrate Material Conditions

## Parameter Table

| Parameter | Value | Unit | Condition | Source |
| --- | --- | --- | --- | --- |
| Sapphire relative permittivity | 9.4 | dimensionless | 10 GHz, cryogenic | material-sapphire-permittivity |

## Applicability

Applies to substrate-level superconducting chip simulations.

## Design Implications

Use this value to seed electromagnetic design sweeps.

## Known Uncertainty

Temperature and frequency dependence still need source-level checks.

## Related Pages

- [[hfss-eigenmode-simulation]]
`);

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 50
    });

    assert.ok(!result.issues.some((issue) =>
      issue.kind === "material_parameter_missing_condition" &&
      issue.target === "Sapphire relative permittivity"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki does not require units for nonnumeric material parameter values", async () => {
  const workspace = await createWorkspace();
  try {
    await writePage(workspace, "substrate-material-qualitative-values", `
---
schema_version: 1
type: dataset
key: substrate-material-qualitative-values
title: Substrate Material Qualitative Values
aliases: []
tags: []
evidence_contract: mixed
source_refs:
  - "material-sapphire-permittivity"
created_at: 2026-05-10T00:00:00.000Z
updated_at: 2026-05-10T00:00:00.000Z
---

# Substrate Material Qualitative Values

## Parameter Table

| Parameter | Value | Unit | Conditions | Source |
| --- | --- | --- | --- | --- |
| Process readiness | TBD |  | pending supplier data | material-sapphire-permittivity |

## Applicability

Applies to substrate-level superconducting chip simulations.

## Design Implications

Use this value to track incomplete material records.

## Known Uncertainty

The quantitative value has not been selected.

## Related Pages

- [[hfss-eigenmode-simulation]]
`);

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 50
    });

    assert.ok(!result.issues.some((issue) =>
      issue.kind === "material_parameter_missing_unit" &&
      issue.target === "Process readiness"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki reports method pages missing required template sections", async () => {
  const workspace = await createWorkspace();
  try {
    await writePage(workspace, "hfss-eigenmode-simulation", `
---
schema_version: 1
type: method
key: hfss-eigenmode-simulation
title: HFSS Eigenmode Simulation
aliases: []
tags: []
evidence_contract: mixed
source_refs:
  - "software-doc-hfss"
created_at: 2026-05-10T00:00:00.000Z
updated_at: 2026-05-10T00:00:00.000Z
---

# HFSS Eigenmode Simulation

## Goal

Estimate resonant frequencies for a candidate chip layout.

## Procedure

Create the model, assign boundaries, mesh, and solve.
`);

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 50
    });

    const missingTargets = result.issues
      .filter((issue) => issue.kind === "missing_template_section")
      .map((issue) => issue.target);
    assert.ok(missingTargets.includes("Inputs"));
    assert.ok(missingTargets.includes("Outputs"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki reports design records without uses relations", async () => {
  const workspace = await createWorkspace();
  try {
    await writePage(workspace, "sapphire-substrate-selection", `
---
schema_version: 1
type: design-record
key: sapphire-substrate-selection
title: Sapphire Substrate Selection
aliases: []
tags: []
evidence_contract: mixed
source_refs:
  - "material-sapphire-permittivity"
typed_relations: []
created_at: 2026-05-10T00:00:00.000Z
updated_at: 2026-05-10T00:00:00.000Z
---

# Sapphire Substrate Selection

## Decision

Use sapphire as the baseline substrate for this design pass.

## Context

Substrate dielectric properties constrain resonator and qubit geometry.

## Evidence Used

The material parameter page records the permittivity source.

## Alternatives Considered

Silicon remains an alternative pending loss analysis.

## Verification Plan

Run an eigenmode sweep against the material dataset.

## Status

Candidate decision.
`);

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 50
    });

    assert.ok(result.issues.some((issue) => issue.kind === "design_record_without_uses_relation"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("planWikiStructure emits budgeted tool-call-shaped growth and verification actions", async () => {
  const workspace = await createWorkspace();

  try {
    await writeSource(
      workspace,
      "paper-a",
      `
---
paper_key: paper-a
title: Tunable Coupler Evidence
tags:
  - tunable-coupler
---

Tunable coupler evidence for superconducting chip design.
`
    );
    await writeSource(
      workspace,
      "paper-b",
      `
---
paper_key: paper-b
title: Coupler Calibration Evidence
tags:
  - tunable-coupler
---

Tunable coupler calibration evidence.
`
    );

    const result = await planWikiStructure({
      workspaceDir: workspace,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "superconducting chip design",
      focus: ["tunable coupler"],
      budget: { maxPagesToBuild: 1, maxAliasesToCreate: 0, maxScopeNotes: 0 }
    });

    const promote = result.actions.find((action) => action.type === "promote_concept");
    assert.equal(promote?.concept, "tunable-coupler");
    assert.equal(promote?.owner, "wiki-agent");
    assert.equal(promote?.recommendedTool, "build_wiki_page");
    assert.deepEqual(promote?.recommendedArgs, {
      topic: "tunable-coupler",
      pageKey: "tunable-coupler",
      mode: "draft",
      maxLocalResults: 8
    });
    assert.ok(promote?.verification?.some((check) => check.tool === "wiki_lint"));
    assert.ok(result.actions.some((action) => action.type === "verify" && action.recommendedTool === "wiki_lint"));
    assert.equal(result.actions.filter((action) => action.type === "promote_concept").length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("planWikiStructure promotes concepts from repeated typed source tags", async () => {
  const workspace = await createWorkspace();

  try {
    await writeReadySourceManifest(workspace, "typed-source-a", ["cryogenic-routing"]);
    await writeReadySourceManifest(workspace, "typed-source-b", ["cryogenic-routing"]);

    const result = await planWikiStructure({
      workspaceDir: workspace,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "superconducting chip design",
      focus: ["cryogenic routing"],
      budget: { maxPagesToBuild: 1, maxAliasesToCreate: 0, maxScopeNotes: 0 }
    });

    assert.ok(result.actions.some((action) =>
      action.type === "promote_concept" &&
      action.concept === "cryogenic-routing"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("planWikiStructure does not request high-value concept gaps unless growth actions are enabled", async () => {
  const workspace = await createWorkspace();

  try {
    await writeSource(
      workspace,
      "paper-a",
      `
---
paper_key: paper-a
title: Tunable Coupler Evidence
tags:
  - tunable-coupler
---

Tunable coupler evidence for superconducting chip design.
`
    );
    await writeSource(
      workspace,
      "paper-b",
      `
---
paper_key: paper-b
title: Coupler Calibration Evidence
tags:
  - tunable-coupler
---

Tunable coupler calibration evidence.
`
    );

    const result = await planWikiStructure({
      workspaceDir: workspace,
      includeMediumRisk: true,
      goal: "superconducting chip design",
      focus: ["tunable coupler"]
    });

    assert.equal(result.lintSummary.high_value_concept_gap, 0);
    assert.ok(!result.actions.some((action) => action.type === "promote_concept"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("planWikiStructure applies default and explicit concept promotion budgets", async () => {
  const workspace = await createWorkspace();

  try {
    for (const concept of ["alpha-concept", "beta-concept", "delta-concept", "gamma-concept"]) {
      await writeSource(
        workspace,
        `${concept}-a`,
        `
---
paper_key: ${concept}-a
title: ${concept} Evidence A
tags:
  - ${concept}
---

${concept} evidence for superconducting design.
`
      );
      await writeSource(
        workspace,
        `${concept}-b`,
        `
---
paper_key: ${concept}-b
title: ${concept} Evidence B
tags:
  - ${concept}
---

Additional ${concept} evidence for superconducting design.
`
      );
    }

    const defaultBudget = await planWikiStructure({
      workspaceDir: workspace,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "superconducting design",
      focus: ["concept"]
    });
    assert.equal(defaultBudget.actions.filter((action) => action.type === "promote_concept").length, 3);

    const zeroBudget = await planWikiStructure({
      workspaceDir: workspace,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "superconducting design",
      focus: ["concept"],
      budget: { maxPagesToBuild: 0 }
    });
    assert.equal(zeroBudget.actions.filter((action) => action.type === "promote_concept").length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("planWikiStructure maps and budgets semantic alias and scope drift growth actions", async () => {
  const workspace = await createMaintenanceFixture();

  try {
    const suppressed = await planWikiStructure({
      workspaceDir: workspace,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "agentic chip design",
      budget: { maxPagesToBuild: 0, maxAliasesToCreate: 0, maxScopeNotes: 0 }
    });
    assert.equal(suppressed.actions.filter((action) => action.type === "create_alias").length, 0);
    assert.equal(suppressed.actions.filter((action) => action.type === "update_scope_note").length, 0);

    const allowed = await planWikiStructure({
      workspaceDir: workspace,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "agentic chip design",
      budget: { maxPagesToBuild: 0, maxAliasesToCreate: 1, maxScopeNotes: 1 }
    });

    const alias = allowed.actions.find((action) => action.type === "create_alias");
    assert.equal(alias?.issueKind, "semantic_alias_candidate");
    assert.equal(alias?.risk, "medium");
    assert.equal(alias?.owner, "wiki-agent");
    assert.equal(alias?.recommendedTool, "merge_wiki_aliases");
    assert.deepEqual(alias?.recommendedArgs, {
      aliases: [{
        alias: "autonomous-agentic-quantum-eda",
        canonical: "agentic-autonomous-quantum-eda",
        note: "shared sources: paper-d; overlapping tokens: agentic, autonomous, eda"
      }]
    });

    const scope = allowed.actions.find((action) => action.type === "update_scope_note");
    assert.equal(scope?.issueKind, "scope_drift");
    assert.equal(scope?.risk, "low");
    assert.equal(scope?.owner, "wiki-agent");
    assert.equal(scope?.recommendedTool, "wiki_apply_structure_plan");
    assert.deepEqual(scope?.recommendedArgs, {
      pagePath: "knowledge-base/pages/agentic-chip-design.md",
      scopeNote: "Scope note: Reframe this page around agentic chip design and keep stale roadmap language as context."
    });

    const capped = await planWikiStructure({
      workspaceDir: workspace,
      maxItems: 6,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "agentic chip design",
      budget: { maxPagesToBuild: 0, maxAliasesToCreate: 1, maxScopeNotes: 0 }
    });
    assert.ok(capped.actions.some((action) => action.type === "create_alias"));
    assert.ok(capped.actions.filter((action) => action.type !== "verify").length <= 6);
    assert.ok(capped.actions.some((action) => action.type === "verify"));

    const tinyCap = await planWikiStructure({
      workspaceDir: workspace,
      maxItems: 1,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "agentic chip design",
      budget: { maxPagesToBuild: 0, maxAliasesToCreate: 1, maxScopeNotes: 0 }
    });
    assert.ok(tinyCap.actions.filter((action) => action.type !== "verify").length <= 1);
    assert.ok(tinyCap.actions.some((action) => action.recommendedTool && action.recommendedTool !== "wiki_lint" && action.recommendedTool !== "wiki_health"));
    assert.ok(tinyCap.actions.some((action) => action.type === "verify"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("planWikiStructure creates aliases from typed pages with shared source_refs", async () => {
  const workspace = await createWorkspace();

  try {
    await writeReadySourceManifest(workspace, "paper-alias", ["surface-code-routing"]);
    await writePage(
      workspace,
      "surface-code-routing",
      `
---
schema_version: 1
type: "concept"
key: "surface-code-routing"
title: "Surface Code Routing"
aliases: []
tags:
  - "surface-code-routing"
evidence_contract: "paper-backed"
source_refs:
  - "paper-alias"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Surface Code Routing

Shared source evidence.
`
    );
    await writePage(
      workspace,
      "routing-for-surface-codes",
      `
---
schema_version: 1
type: "concept"
key: "routing-for-surface-codes"
title: "Routing for Surface Codes"
aliases: []
tags:
  - "surface-code-routing"
evidence_contract: "paper-backed"
source_refs:
  - "paper-alias"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Routing for Surface Codes

Shared source evidence.
`
    );

    const result = await planWikiStructure({
      workspaceDir: workspace,
      includeMediumRisk: true,
      includeGrowthActions: true,
      budget: { maxPagesToBuild: 0, maxAliasesToCreate: 1, maxScopeNotes: 0 }
    });

    assert.ok(result.actions.some((action) =>
      action.type === "create_alias" &&
      action.issueKind === "semantic_alias_candidate"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("planWikiStructure plans low-risk duplicate page merges for singular plural concept pages", async () => {
  const workspace = await createWorkspace();

  try {
    await writeReadySourceManifest(workspace, "paper-surface", ["surface-code"]);
    await writePage(
      workspace,
      "surface-code",
      `
---
schema_version: 1
type: "concept"
key: "surface-code"
title: "Surface Code"
aliases: []
tags:
  - "surface-code"
evidence_contract: "paper-backed"
source_refs:
  - "paper-surface"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Surface Code

Surface code is the canonical synthesis page with maintained evidence, decoding context,
layout constraints, and fault-tolerant quantum computing notes.
`
    );
    await writePage(
      workspace,
      "surface-codes",
      `
---
schema_version: 1
type: "concept"
key: "surface-codes"
title: "Surface Codes"
aliases: []
tags:
  - "surface-code"
evidence_contract: "paper-backed"
source_refs:
  - "paper-surface"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Surface Codes

Plural duplicate.
`
    );

    const lint = await lintPaperWiki({
      workspaceDir: workspace,
      maxItems: 20
    });
    const lintMergeCandidate = lint.issues.find((issue) =>
      issue.kind === "near_duplicate_page" &&
      issue.path === "knowledge-base/pages/surface-codes.md"
    );
    assert.equal(lintMergeCandidate?.severity, "low");
    assert.equal(lintMergeCandidate?.target, "surface-code");
    assert.match(lintMergeCandidate?.reason ?? "", /shared source evidence match canonical page surface-code/);

    const result = await planWikiStructure({
      workspaceDir: workspace,
      maxItems: 10
    });

    const merge = result.actions.find((action) => action.type === "merge_duplicate_pages");
    assert.equal(merge?.risk, "low");
    assert.equal(merge?.recommendedTool, "wiki_apply_structure_plan");
    assert.deepEqual(merge?.recommendedArgs, {
      canonical: "surface-code",
      redundant: "surface-codes",
      alias: "surface-codes",
      note: "Low-risk duplicate concept page: normalized title and shared source evidence match canonical page surface-code."
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki recognizes singular plural duplicates even when the redundant page has no citations", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "surface-code",
      `
---
schema_version: 1
type: "concept"
key: "surface-code"
title: "Surface Code"
aliases: []
tags:
  - "surface-code"
evidence_contract: "paper-backed"
source_refs:
  - "paper-surface"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Surface Code

Surface code is the canonical synthesis page with maintained evidence and fault-tolerant context.
`
    );
    await writePage(
      workspace,
      "surface-codes",
      `
---
schema_version: 1
type: "concept"
key: "surface-codes"
title: "Surface Codes"
aliases: []
tags:
  - "surface-code"
evidence_contract: "none"
source_refs: []
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Surface Codes

Plural duplicate without direct source citations.
`
    );

    const lint = await lintPaperWiki({ workspaceDir: workspace, maxItems: 20 });
    const duplicate = lint.issues.find((issue) =>
      issue.kind === "near_duplicate_page" &&
      issue.path === "knowledge-base/pages/surface-codes.md"
    );

    assert.equal(duplicate?.severity, "low");
    assert.equal(duplicate?.target, "surface-code");
    assert.match(duplicate?.reason ?? "", /singular\/plural title match canonical page surface-code/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki recognizes source-backed contained concept duplicates", async () => {
  const workspace = await createWorkspace();

  try {
    await writeSource(workspace, "paper-allocation", "# Allocation Evidence\n");
    await writeSource(workspace, "paper-collision", "# Collision Evidence\n");
    await writeSource(workspace, "paper-fabrication", "# Fabrication Evidence\n");
    await writePage(
      workspace,
      "frequency-allocation",
      `
---
schema_version: 1
type: "concept"
key: "frequency-allocation"
title: "Frequency Allocation in Superconducting Quantum Processors"
aliases: []
tags:
  - "frequency-allocation"
  - "frequency-collisions"
  - "fixed-frequency-transmons"
evidence_contract: "paper-backed"
sources:
  - paper_key: "paper-allocation"
    title: "Allocation Evidence"
    path: "knowledge-base/sources/paper-allocation/summary.md"
  - paper_key: "paper-collision"
    title: "Collision Evidence"
    path: "knowledge-base/sources/paper-collision/summary.md"
  - paper_key: "paper-fabrication"
    title: "Fabrication Evidence"
    path: "knowledge-base/sources/paper-fabrication/summary.md"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Frequency Allocation in Superconducting Quantum Processors

Frequency allocation assigns target frequencies while avoiding frequency collisions in fixed-frequency
transmon chips. This broader page covers collision mitigation, fabrication uncertainty, and processor yield.
`
    );
    await writePage(
      workspace,
      "frequency-collisions",
      `
---
schema_version: 1
type: "concept"
key: "frequency-collisions"
title: "Frequency Collisions in Superconducting Quantum Processors"
aliases: []
tags:
  - "frequency-allocation"
  - "frequency-collisions"
  - "fixed-frequency-transmons"
evidence_contract: "paper-backed"
sources:
  - paper_key: "paper-collision"
    title: "Collision Evidence"
    path: "knowledge-base/sources/paper-collision/summary.md"
  - paper_key: "paper-fabrication"
    title: "Fabrication Evidence"
    path: "knowledge-base/sources/paper-fabrication/summary.md"
related_pages:
  - "frequency-allocation"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Frequency Collisions in Superconducting Quantum Processors

Frequency collisions are a subproblem of frequency allocation under fabrication uncertainty.
`
    );

    const lint = await lintPaperWiki({ workspaceDir: workspace, maxItems: 20 });
    const contained = lint.issues.find((issue) =>
      issue.kind === "near_duplicate_page" &&
      issue.path === "knowledge-base/pages/frequency-collisions.md"
    );

    assert.equal(contained?.severity, "medium");
    assert.equal(contained?.target, "frequency-allocation");
    assert.match(contained?.reason ?? "", /Source-backed contained concept page/);

    const plan = await planWikiStructure({
      workspaceDir: workspace,
      includeMediumRisk: true,
      maxItems: 10
    });
    const merge = plan.actions.find((action) =>
      action.type === "merge_duplicate_pages" &&
      action.path === "knowledge-base/pages/frequency-collisions.md"
    );

    assert.equal(merge?.risk, "medium");
    assert.equal(merge?.target, "frequency-allocation");
    assert.equal(merge?.recommendedTool, "wiki_apply_structure_plan");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki recognizes compact spelling duplicates as deleteable page duplicates", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "su-2",
      `
---
schema_version: 1
type: "concept"
key: "su-2"
title: "SU(2)"
aliases: []
tags:
  - "su-2"
evidence_contract: "none"
source_refs: []
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# SU(2)

Canonical compact group notation page.
`
    );
    await writePage(
      workspace,
      "su2",
      `
---
schema_version: 1
type: "concept"
key: "su2"
title: "SU2"
aliases: []
tags:
  - "su-2"
evidence_contract: "none"
source_refs: []
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# SU2

Redundant compact spelling page.
`
    );

    const lint = await lintPaperWiki({ workspaceDir: workspace, maxItems: 20 });
    const duplicate = lint.issues.find((issue) =>
      issue.kind === "near_duplicate_page" &&
      issue.path === "knowledge-base/pages/su2.md"
    );

    assert.equal(duplicate?.severity, "low");
    assert.equal(duplicate?.target, "su-2");
    assert.match(duplicate?.reason ?? "", /simple alias key match canonical page su-2/);

    const plan = await planWikiStructure({
      workspaceDir: workspace,
      maxItems: 10
    });
    const merge = plan.actions.find((action) =>
      action.type === "merge_duplicate_pages" &&
      action.path === "knowledge-base/pages/su2.md"
    );

    assert.equal(merge?.risk, "low");
    assert.equal(merge?.recommendedTool, "wiki_apply_structure_plan");
    assert.deepEqual(merge?.recommendedArgs, {
      canonical: "su-2",
      redundant: "su2",
      alias: "su2",
      note: "Low-risk duplicate concept page: simple alias key match canonical page su-2."
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki lint default display quotas keep duplicate pages visible amid many concept gaps", async () => {
  const workspace = await createWorkspace();

  try {
    const manyGapTags = Array.from({ length: 35 }, (_, index) => `gap-topic-${String(index + 1).padStart(2, "0")}`);
    await writeSource(
      workspace,
      "gap-source-a",
      `---
paper_key: gap-source-a
title: Gap Source A
tags:
${manyGapTags.map((tag) => `  - ${tag}`).join("\n")}
---

Gap evidence A.
`
    );
    await writeSource(
      workspace,
      "gap-source-b",
      `---
paper_key: gap-source-b
title: Gap Source B
tags:
${manyGapTags.map((tag) => `  - ${tag}`).join("\n")}
---

Gap evidence B.
`
    );
    await writePage(
      workspace,
      "cross-resonance-gate",
      `
---
schema_version: 1
type: "concept"
key: "cross-resonance-gate"
title: "Cross-Resonance Gate"
aliases: []
tags:
  - "cross-resonance-gate"
evidence_contract: "none"
source_refs: []
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Cross-Resonance Gate

Canonical cross-resonance gate page.
`
    );
    await writePage(
      workspace,
      "cross-resonance-gates",
      `
---
type: "wiki-alias-page"
page_key: "cross-resonance-gates"
title: "Cross-Resonance Gates"
canonical_page: "cross-resonance-gate"
related_pages:
  - "cross-resonance-gate"
---

# Cross-Resonance Gates

Plural alias page.
`
    );
    await writePage(
      workspace,
      "surface-code",
      `
---
schema_version: 1
type: "concept"
key: "surface-code"
title: "Surface Code"
aliases: []
tags:
  - "surface-code"
evidence_contract: "none"
source_refs: []
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Surface Code

Canonical surface code page.
`
    );
    await writePage(
      workspace,
      "surface-codes",
      `
---
type: "wiki-alias-page"
page_key: "surface-codes"
title: "Surface Codes"
canonical_page: "surface-code"
related_pages:
  - "surface-code"
---

# Surface Codes

Plural alias page.
`
    );
    await writePage(
      workspace,
      "su-2",
      `
---
schema_version: 1
type: "concept"
key: "su-2"
title: "SU(2)"
aliases: []
tags:
  - "su-2"
evidence_contract: "none"
source_refs: []
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# SU(2)

Canonical compact group notation page.
`
    );
    await writePage(
      workspace,
      "su2",
      `
---
type: "wiki-alias-page"
page_key: "su2"
title: "SU2"
canonical_page: "su-2"
related_pages:
  - "su-2"
---

# SU2

Compact alias page.
`
    );

    const lint = await lintPaperWiki({ workspaceDir: workspace });

    assert.equal(lint.summary.concept_gap, 35);
    assert.ok(lint.issues.some((issue) =>
      issue.kind === "near_duplicate_page" &&
      issue.path === "knowledge-base/pages/surface-codes.md" &&
      issue.target === "surface-code"
    ));
    assert.ok(lint.issues.some((issue) =>
      issue.kind === "near_duplicate_page" &&
      issue.path === "knowledge-base/pages/su2.md" &&
      issue.target === "su-2"
    ));

    const plan = await planWikiStructure({ workspaceDir: workspace, maxItems: 3 });
    assert.ok(plan.actions.some((action) =>
      action.type === "merge_duplicate_pages" &&
      action.path === "knowledge-base/pages/cross-resonance-gates.md" &&
      action.target === "cross-resonance-gate"
    ));
    assert.ok(plan.actions.some((action) =>
      action.type === "merge_duplicate_pages" &&
      action.path === "knowledge-base/pages/surface-codes.md" &&
      action.target === "surface-code"
    ));
    assert.ok(plan.actions.some((action) =>
      action.type === "merge_duplicate_pages" &&
      action.path === "knowledge-base/pages/su2.md" &&
      action.target === "su-2"
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("wiki structure repair deletes existing simple alias pages instead of keeping alias stubs", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "surface-code",
      `
---
schema_version: 1
type: "concept"
key: "surface-code"
title: "Surface Code"
aliases: []
tags:
  - "surface-code"
evidence_contract: "none"
source_refs: []
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Surface Code

Canonical page.
`
    );
    await writePage(
      workspace,
      "surface-codes",
      `
---
schema_version: 1
type: "wiki-alias-page"
key: "surface-codes"
title: "Surface Codes"
canonical_page: "surface-code"
aliases: []
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Surface Codes

Alias of [Surface Code](knowledge-base/pages/surface-code.md).
`
    );

    const plan = await planWikiStructure({
      workspaceDir: workspace,
      maxItems: 10
    });
    const merge = plan.actions.find((action) =>
      action.type === "merge_duplicate_pages" &&
      action.path === "knowledge-base/pages/surface-codes.md"
    );

    assert.equal(merge?.risk, "low");
    assert.equal(merge?.target, "surface-code");
    assert.equal(merge?.recommendedTool, "wiki_apply_structure_plan");

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    const result = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: false,
      runVerification: false,
      actions: merge ? [merge] : []
    });

    assert.equal(result.status, "applied");
    await assert.rejects(readFile(path.join(workspace, "knowledge-base/pages/surface-codes.md"), "utf8"));
    const canonical = await readFile(path.join(workspace, "knowledge-base/pages/surface-code.md"), "utf8");
    assert.match(canonical, /aliases:\n\s+- "surface-codes"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan merges duplicate pages, rewrites inbound links, and deletes the redundant page", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "surface-code",
      `
---
schema_version: 1
type: "concept"
key: "surface-code"
title: "Surface Code"
aliases: []
tags:
  - "surface-code"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Surface Code

Canonical content.
`
    );
    await writePage(
      workspace,
      "surface-codes",
      `
---
schema_version: 1
type: "concept"
key: "surface-codes"
title: "Surface Codes"
aliases: []
tags:
  - "surface-code"
created_at: "2026-05-10T00:00:00.000Z"
updated_at: "2026-05-10T00:00:00.000Z"
---

# Surface Codes

Redundant plural content.
`
    );
    await writePage(
      workspace,
      "fault-tolerance",
      `
---
title: "Fault Tolerance"
aliases: []
---

# Fault Tolerance

See [Surface Codes](knowledge-base/pages/surface-codes.md) for the code family.
`
    );

    const action = {
      id: "wiki-structure-001",
      type: "merge_duplicate_pages" as const,
      priority: "medium" as const,
      risk: "low" as const,
      issueKind: "near_duplicate_page" as const,
      owner: "wiki-agent" as const,
      path: "knowledge-base/pages/surface-codes.md",
      target: "surface-code",
      reason: "Plural duplicate.",
      recommendedTool: "wiki_apply_structure_plan" as const,
      recommendedArgs: {
        canonical: "surface-code",
        redundant: "surface-codes",
        alias: "surface-codes",
        note: "Plural duplicate."
      }
    };
    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");

    const dryRun = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: true,
      runVerification: false,
      actions: [action]
    });
    assert.equal(dryRun.status, "dry_run");
    assert.deepEqual(dryRun.changedFiles, []);
    assert.ok(dryRun.applied[0]?.changedFiles.includes("knowledge-base/pages/surface-code.md"));
    assert.ok(dryRun.applied[0]?.changedFiles.includes("knowledge-base/pages/surface-codes.md"));
    assert.ok(dryRun.applied[0]?.changedFiles.includes("knowledge-base/pages/fault-tolerance.md"));

    const applied = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: false,
      runVerification: false,
      actions: [action]
    });

    assert.equal(applied.status, "applied");
    assert.ok(applied.changedFiles.includes("knowledge-base/pages/surface-code.md"));
    assert.ok(applied.changedFiles.includes("knowledge-base/pages/surface-codes.md"));
    assert.ok(applied.changedFiles.includes("knowledge-base/pages/fault-tolerance.md"));
    await assert.rejects(readFile(path.join(workspace, "knowledge-base/pages/surface-codes.md"), "utf8"));
    const canonical = await readFile(path.join(workspace, "knowledge-base/pages/surface-code.md"), "utf8");
    assert.match(canonical, /aliases:\n\s+- "surface-codes"/);
    const inbound = await readFile(path.join(workspace, "knowledge-base/pages/fault-tolerance.md"), "utf8");
    assert.match(inbound, /knowledge-base\/pages\/surface-code\.md/);
    assert.doesNotMatch(inbound, /knowledge-base\/pages\/surface-codes\.md/);
    const log = await readFile(path.join(workspace, "knowledge-base/log.md"), "utf8");
    assert.match(log, /merged duplicate pages/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan dry-runs safe alias and scope note actions", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "tunable-coupler",
      `
---
title: Tunable Coupler
sources:
  - paper_key: paper-a
    title: Evidence
    path: knowledge-base/sources/paper-a/summary.md
---

# Tunable Coupler

Coupler page.

## Sources

- \`paper-a\` - Evidence (knowledge-base/sources/paper-a/summary.md)
`
    );

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    const result = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: true,
      runVerification: false,
      actions: [
        {
          id: "wiki-structure-001",
          type: "create_alias",
          priority: "medium",
          risk: "low",
          issueKind: "semantic_alias_candidate",
          owner: "wiki-agent",
          path: "knowledge-base/pages/tunable-couplers.md",
          target: "tunable-coupler",
          reason: "Plural alias.",
          recommendedTool: "merge_wiki_aliases",
          recommendedArgs: {
            aliases: [{ alias: "tunable-couplers", canonical: "tunable-coupler", note: "Plural alias." }]
          }
        },
        {
          id: "wiki-structure-002",
          type: "update_scope_note",
          priority: "medium",
          risk: "low",
          issueKind: "scope_drift",
          owner: "wiki-agent",
          path: "knowledge-base/pages/tunable-coupler.md",
          reason: "Add scope note.",
          recommendedTool: "wiki_apply_structure_plan",
          recommendedArgs: {
            pagePath: "knowledge-base/pages/tunable-coupler.md",
            scopeNote: "This page focuses on tunable couplers for superconducting chip design."
          }
        }
      ]
    });

    assert.equal(result.status, "dry_run");
    assert.equal(result.applied.length, 2);
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(result.applied[0]?.changedFiles, [
      "knowledge-base/pages/tunable-couplers.md",
      "knowledge-base/index.md",
      "knowledge-base/log.md"
    ]);
    await assert.rejects(readFile(path.join(workspace, "knowledge-base/pages/tunable-couplers.md"), "utf8"));
    const canonical = await readFile(path.join(workspace, "knowledge-base/pages/tunable-coupler.md"), "utf8");
    assert.doesNotMatch(canonical, /## Scope Note/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan writes safe alias and scope note actions", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "tunable-coupler",
      `
---
title: Tunable Coupler
sources:
  - paper_key: paper-a
    title: Evidence
    path: knowledge-base/sources/paper-a/summary.md
---

# Tunable Coupler

Coupler page.

## Sources

- \`paper-a\` - Evidence (knowledge-base/sources/paper-a/summary.md)
`
    );

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    const result = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: false,
      runVerification: false,
      actions: [
        {
          id: "wiki-structure-001",
          type: "create_alias",
          priority: "medium",
          risk: "low",
          issueKind: "semantic_alias_candidate",
          owner: "wiki-agent",
          path: "knowledge-base/pages/tunable-couplers.md",
          target: "tunable-coupler",
          reason: "Plural alias.",
          recommendedTool: "merge_wiki_aliases",
          recommendedArgs: {
            aliases: [{ alias: "tunable-couplers", canonical: "tunable-coupler", note: "Plural alias." }]
          }
        },
        {
          id: "wiki-structure-002",
          type: "update_scope_note",
          priority: "medium",
          risk: "low",
          issueKind: "scope_drift",
          owner: "wiki-agent",
          path: "knowledge-base/pages/tunable-coupler.md",
          reason: "Add scope note.",
          recommendedTool: "wiki_apply_structure_plan",
          recommendedArgs: {
            pagePath: "knowledge-base/pages/tunable-coupler.md",
            scopeNote: "This page focuses on tunable couplers for superconducting chip design."
          }
        }
      ]
    });

    assert.equal(result.status, "applied");
    assert.equal(result.operationJournalPath, "knowledge-base/state/wiki-operations.jsonl");
    assert.ok(result.changedFiles.includes("knowledge-base/pages/tunable-couplers.md"));
    assert.ok(result.changedFiles.includes("knowledge-base/pages/tunable-coupler.md"));
    assert.ok(result.changedFiles.includes("knowledge-base/index.md"));
    assert.ok(result.changedFiles.includes("knowledge-base/log.md"));
    const alias = await readFile(path.join(workspace, "knowledge-base/pages/tunable-couplers.md"), "utf8");
    assert.match(alias, /canonical_page: "tunable-coupler"/);
    const canonical = await readFile(path.join(workspace, "knowledge-base/pages/tunable-coupler.md"), "utf8");
    assert.match(canonical, /## Scope Note/);
    assert.match(canonical, /superconducting chip design/);
    assert.match(canonical, /## Sources/);
    const journal = (await readFile(path.join(workspace, result.operationJournalPath), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const begin = journal.find((event) => event.phase === "begin" && event.operationId === result.operationId);
    const complete = journal.find((event) => event.phase === "complete" && event.operationId === result.operationId);
    assert.equal(begin?.intent, "apply_structure_plan");
    assert.equal(complete?.operationId, result.operationId);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan rejects page actions that escape wiki pages directory", async () => {
  const workspace = await createWorkspace();

  try {
    await writeMarkdown(path.join(workspace, "README.md"), "# Workspace Readme");

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    await assert.rejects(
      applyWikiStructurePlan({
        workspaceDir: workspace,
        dryRun: true,
        runVerification: false,
        actions: [{
          id: "wiki-structure-001",
          type: "update_scope_note",
          priority: "medium",
          risk: "low",
          issueKind: "scope_drift",
          owner: "wiki-agent",
          path: "knowledge-base/pages/../../../README.md",
          reason: "Escaping path.",
          recommendedTool: "wiki_apply_structure_plan",
          recommendedArgs: {
            pagePath: "knowledge-base/pages/../../../README.md",
            scopeNote: "Should not write outside wiki pages."
          }
        }]
      }),
      /target wiki synthesis pages/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan refuses to write wiki pages through symlinks", async () => {
  const workspace = await createWorkspace();
  const outside = await mkdtemp(path.join(tmpdir(), "pi-wiki-outside-"));

  try {
    const outsideTarget = path.join(outside, "outside.md");
    await writeMarkdown(outsideTarget, "# Outside");
    await mkdir(path.join(workspace, "knowledge-base/pages"), { recursive: true });
    await symlink(outsideTarget, path.join(workspace, "knowledge-base/pages/symlink-page.md"));

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    await assert.rejects(
      applyWikiStructurePlan({
        workspaceDir: workspace,
        dryRun: false,
        runVerification: false,
        actions: [{
          id: "wiki-structure-001",
          type: "update_scope_note",
          priority: "medium",
          risk: "low",
          issueKind: "scope_drift",
          owner: "wiki-agent",
          path: "knowledge-base/pages/symlink-page.md",
          reason: "Symlinked page.",
          recommendedTool: "wiki_apply_structure_plan",
          recommendedArgs: {
            pagePath: "knowledge-base/pages/symlink-page.md",
            scopeNote: "Should not write outside wiki pages."
          }
        }]
      }),
      /symlink/
    );

    const outsideMarkdown = await readFile(outsideTarget, "utf8");
    assert.doesNotMatch(outsideMarkdown, /Scope Note/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan refuses wiki roots that resolve outside the workspace", async () => {
  const workspace = await createWorkspace();
  const outside = await mkdtemp(path.join(tmpdir(), "pi-wiki-outside-"));

  try {
    await mkdir(path.join(outside, "knowledge-base/pages"), { recursive: true });
    await writeMarkdown(
      path.join(outside, "knowledge-base/pages/external-page.md"),
      `
---
title: External Page
---

# External Page
`
    );
    await symlink(path.join(outside, "knowledge-base"), path.join(workspace, "knowledge-base"));

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    await assert.rejects(
      applyWikiStructurePlan({
        workspaceDir: workspace,
        dryRun: false,
        runVerification: false,
        actions: [{
          id: "wiki-structure-001",
          type: "update_scope_note",
          priority: "medium",
          risk: "low",
          issueKind: "scope_drift",
          owner: "wiki-agent",
          path: "knowledge-base/pages/external-page.md",
          reason: "Symlinked wiki root.",
          recommendedTool: "wiki_apply_structure_plan",
          recommendedArgs: {
            pagePath: "knowledge-base/pages/external-page.md",
            scopeNote: "Should not write outside workspace."
          }
        }]
      }),
      /escapes the workspace/
    );

    const outsideMarkdown = await readFile(path.join(outside, "knowledge-base/pages/external-page.md"), "utf8");
    assert.doesNotMatch(outsideMarkdown, /Scope Note/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan dry-run skips aliases that real alias merge would not write", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "canonical",
      `
---
title: Canonical
---

# Canonical
`
    );
    await writePage(
      workspace,
      "existing-synthesis",
      `
---
title: Existing Synthesis
---

# Existing Synthesis
`
    );

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    const result = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: true,
      runVerification: false,
      actions: [
        {
          id: "wiki-structure-001",
          type: "create_alias",
          priority: "medium",
          risk: "low",
          issueKind: "semantic_alias_candidate",
          owner: "wiki-agent",
          path: "knowledge-base/pages/missing-canonical-alias.md",
          target: "missing-canonical",
          reason: "Missing canonical.",
          recommendedTool: "merge_wiki_aliases",
          recommendedArgs: {
            aliases: [{ alias: "missing-canonical-alias", canonical: "missing-canonical" }]
          }
        },
        {
          id: "wiki-structure-002",
          type: "create_alias",
          priority: "medium",
          risk: "low",
          issueKind: "semantic_alias_candidate",
          owner: "wiki-agent",
          path: "knowledge-base/pages/canonical.md",
          target: "canonical",
          reason: "Self alias.",
          recommendedTool: "merge_wiki_aliases",
          recommendedArgs: {
            aliases: [{ alias: "canonical", canonical: "canonical" }]
          }
        },
        {
          id: "wiki-structure-004",
          type: "create_alias",
          priority: "medium",
          risk: "low",
          issueKind: "semantic_alias_candidate",
          owner: "wiki-agent",
          path: "knowledge-base/pages/existing-synthesis.md",
          target: "canonical",
          reason: "Existing synthesis.",
          recommendedTool: "merge_wiki_aliases",
          recommendedArgs: {
            aliases: [{ alias: "existing-synthesis", canonical: "canonical" }]
          }
        }
      ]
    });

    assert.equal(result.status, "dry_run");
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 3);
    assert.deepEqual(result.changedFiles, []);
    assert.ok(result.skipped.some((item) => /Canonical wiki page does not exist/.test(item.reason)));
    assert.ok(result.skipped.some((item) => /identical/.test(item.reason)));
    assert.ok(result.skipped.some((item) => /already exists as a synthesis page/.test(item.reason)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan dry-run mirrors partial alias merge writes", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "canonical",
      `
---
title: Canonical
---

# Canonical
`
    );
    await writePage(
      workspace,
      "existing-synthesis",
      `
---
title: Existing Synthesis
---

# Existing Synthesis
`
    );

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    const result = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: true,
      runVerification: false,
      actions: [{
        id: "wiki-structure-001",
        type: "create_alias",
        priority: "medium",
        risk: "low",
        issueKind: "semantic_alias_candidate",
        owner: "wiki-agent",
        path: "knowledge-base/pages/good-alias.md",
        target: "canonical",
        reason: "Mixed alias batch.",
        recommendedTool: "merge_wiki_aliases",
        recommendedArgs: {
          aliases: [
            { alias: "good-alias", canonical: "canonical" },
            { alias: "good-alias", canonical: "canonical" },
            { alias: "missing-canonical-alias", canonical: "missing-canonical" },
            { alias: "existing-synthesis", canonical: "canonical" }
          ]
        }
      }]
    });

    assert.equal(result.status, "dry_run");
    assert.equal(result.applied.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(result.applied[0]?.changedFiles, [
      "knowledge-base/pages/good-alias.md",
      "knowledge-base/index.md",
      "knowledge-base/log.md"
    ]);
    await assert.rejects(readFile(path.join(workspace, "knowledge-base/pages/good-alias.md"), "utf8"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan blocks alias writes before touching pages when index is unsafe", async () => {
  const workspace = await createWorkspace();
  const outside = await mkdtemp(path.join(tmpdir(), "pi-wiki-outside-"));

  try {
    await writePage(
      workspace,
      "canonical",
      `
---
title: Canonical
---

# Canonical
`
    );
    const outsideTarget = path.join(outside, "index.md");
    await writeMarkdown(outsideTarget, "# Outside Index");
    await writeMarkdown(path.join(workspace, "knowledge-base/log.md"), "# Log");
    await rm(path.join(workspace, "knowledge-base/index.md"), { force: true });
    await symlink(outsideTarget, path.join(workspace, "knowledge-base/index.md"));

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    const result = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: false,
      runVerification: false,
      actions: [{
        id: "wiki-structure-001",
        type: "create_alias",
        priority: "medium",
        risk: "low",
        issueKind: "semantic_alias_candidate",
        owner: "wiki-agent",
        path: "knowledge-base/pages/good-alias.md",
        target: "canonical",
        reason: "Alias with unsafe index.",
        recommendedTool: "merge_wiki_aliases",
        recommendedArgs: {
          aliases: [{ alias: "good-alias", canonical: "canonical" }]
        }
      }]
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.applied.length, 0);
    assert.match(result.skipped[0]?.reason ?? "", /symlink/);
    await assert.rejects(readFile(path.join(workspace, "knowledge-base/pages/good-alias.md"), "utf8"));
    const outsideMarkdown = await readFile(outsideTarget, "utf8");
    assert.equal(outsideMarkdown.trim(), "# Outside Index");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("mergePaperWikiAliases preflights all alias targets before writing any page", async () => {
  const workspace = await createWorkspace();
  const outside = await mkdtemp(path.join(tmpdir(), "pi-wiki-outside-"));

  try {
    await writePage(
      workspace,
      "canonical",
      `
---
title: Canonical
---

# Canonical
`
    );
    const outsideTarget = path.join(outside, "unsafe-alias.md");
    await writeMarkdown(outsideTarget, "# Outside Alias");
    await symlink(outsideTarget, path.join(workspace, "knowledge-base/pages/unsafe-alias.md"));

    const { mergePaperWikiAliases } = await import("../../src/agent/wiki/content.js");
    await assert.rejects(
      mergePaperWikiAliases({
        workspaceDir: workspace,
        aliases: [
          { alias: "safe-alias", canonical: "canonical" },
          { alias: "unsafe-alias", canonical: "canonical" }
        ]
      }),
      /symlink/
    );

    await assert.rejects(readFile(path.join(workspace, "knowledge-base/pages/safe-alias.md"), "utf8"));
    const outsideMarkdown = await readFile(outsideTarget, "utf8");
    assert.equal(outsideMarkdown.trim(), "# Outside Alias");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan replaces the full existing Scope Note section", async () => {
  const workspace = await createWorkspace();

  try {
    await writePage(
      workspace,
      "scoped-page",
      `
---
title: Scoped Page
---

# Scoped Page

Intro.

## Scope Note

Old paragraph one.

- stale bullet
- stale second bullet

Old paragraph two.

## Sources

- \`paper-a\`
`
    );

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    const result = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: false,
      runVerification: false,
      actions: [{
        id: "wiki-structure-001",
        type: "update_scope_note",
        priority: "medium",
        risk: "low",
        issueKind: "scope_drift",
        owner: "wiki-agent",
        path: "knowledge-base/pages/scoped-page.md",
        reason: "Replace stale scope note.",
        recommendedTool: "wiki_apply_structure_plan",
        recommendedArgs: {
          pagePath: "knowledge-base/pages/scoped-page.md",
          scopeNote: "New focused scope note."
        }
      }]
    });

    assert.equal(result.status, "applied");
    const page = await readFile(path.join(workspace, "knowledge-base/pages/scoped-page.md"), "utf8");
    assert.match(page, /## Scope Note\n\nNew focused scope note\.\n\n## Sources/);
    assert.doesNotMatch(page, /Old paragraph/);
    assert.doesNotMatch(page, /stale bullet/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan rebuild_index rewrites the wiki index", async () => {
  const workspace = await createWorkspace();

  try {
    await writeSource(
      workspace,
      "paper-a",
      `
---
paper_key: paper-a
title: Evidence
---

Evidence summary.
`
    );
    await writePage(
      workspace,
      "tunable-coupler",
      `
---
title: Tunable Coupler
sources:
  - paper_key: paper-a
    title: Evidence
    path: knowledge-base/sources/paper-a/summary.md
---

# Tunable Coupler

Coupler page.
`
    );
    await writeMarkdown(path.join(workspace, "knowledge-base/index.md"), "# Stale Index");

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    const result = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: false,
      runVerification: false,
      actions: [{
        id: "wiki-structure-001",
        type: "rebuild_index",
        priority: "low",
        risk: "low",
        issueKind: "stale_index",
        owner: "wiki-agent",
        path: "knowledge-base/index.md",
        reason: "Index is stale.",
        recommendedTool: "wiki_apply_structure_plan"
      }]
    });

    assert.equal(result.status, "applied");
    assert.deepEqual(result.changedFiles, ["knowledge-base/index.md"]);
    const index = await readFile(path.join(workspace, "knowledge-base/index.md"), "utf8");
    assert.match(index, /# Paper LLM Wiki Index/);
    assert.match(index, /\[Tunable Coupler\]\(pages\/tunable-coupler\.md\)/);
    assert.match(index, /Source summaries: 1/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan refuses to rebuild a symlinked wiki index", async () => {
  const workspace = await createWorkspace();
  const outside = await mkdtemp(path.join(tmpdir(), "pi-wiki-outside-"));

  try {
    await writeSource(
      workspace,
      "paper-a",
      `
---
paper_key: paper-a
title: Evidence
---

Evidence summary.
`
    );
    await writePage(
      workspace,
      "tunable-coupler",
      `
---
title: Tunable Coupler
---

# Tunable Coupler
`
    );

    const outsideTarget = path.join(outside, "index.md");
    await writeMarkdown(outsideTarget, "# Outside Index");
    await rm(path.join(workspace, "knowledge-base/index.md"), { force: true });
    await symlink(outsideTarget, path.join(workspace, "knowledge-base/index.md"));

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    await assert.rejects(
      applyWikiStructurePlan({
        workspaceDir: workspace,
        dryRun: false,
        runVerification: false,
        actions: [{
          id: "wiki-structure-001",
          type: "rebuild_index",
          priority: "low",
          risk: "low",
          issueKind: "stale_index",
          owner: "wiki-agent",
          path: "knowledge-base/index.md",
          reason: "Index is stale.",
          recommendedTool: "wiki_apply_structure_plan"
        }]
      }),
      /symlink/
    );

    const outsideMarkdown = await readFile(outsideTarget, "utf8");
    assert.equal(outsideMarkdown.trim(), "# Outside Index");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan dry-run refuses to rebuild a symlinked wiki index", async () => {
  const workspace = await createWorkspace();
  const outside = await mkdtemp(path.join(tmpdir(), "pi-wiki-outside-"));

  try {
    await writeSource(
      workspace,
      "paper-a",
      `
---
paper_key: paper-a
title: Evidence
---

Evidence summary.
`
    );
    const outsideTarget = path.join(outside, "index.md");
    await writeMarkdown(outsideTarget, "# Outside Index");
    await rm(path.join(workspace, "knowledge-base/index.md"), { force: true });
    await symlink(outsideTarget, path.join(workspace, "knowledge-base/index.md"));

    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    await assert.rejects(
      applyWikiStructurePlan({
        workspaceDir: workspace,
        dryRun: true,
        runVerification: false,
        actions: [{
          id: "wiki-structure-001",
          type: "rebuild_index",
          priority: "low",
          risk: "low",
          issueKind: "stale_index",
          owner: "wiki-agent",
          path: "knowledge-base/index.md",
          reason: "Index is stale.",
          recommendedTool: "wiki_apply_structure_plan"
        }]
      }),
      /symlink/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
