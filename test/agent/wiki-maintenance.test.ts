import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function writeSource(workspaceDir: string, paperKey: string, content: string): Promise<void> {
  await writeMarkdown(path.join(workspaceDir, "knowledge-base", "wiki", "sources", `${paperKey}.md`), content);
}

async function writePage(workspaceDir: string, pageKey: string, content: string): Promise<void> {
  await writeMarkdown(path.join(workspaceDir, "knowledge-base", "wiki", "pages", `${pageKey}.md`), content);
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
    path: knowledge-base/wiki/sources/paper-c.md
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
    path: knowledge-base/wiki/sources/paper-a.md
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
    path: knowledge-base/wiki/sources/paper-d.md
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
    path: knowledge-base/wiki/sources/paper-d.md
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
    assert.match(highValueGap?.target ?? "", /knowledge-base\/wiki\/pages\/fixed-frequency-transmons\.md$/);
    assert.match(highValueGap?.reason ?? "", /2 sources mention fixed-frequency-transmons/);

    const evidenceGap = result.issues.find(
      (issue) => issue.kind === "evidence_contract_gap" && issue.target === "agentic-chip-design"
    );
    assert.equal(evidenceGap?.severity, "low");
    assert.match(evidenceGap?.reason ?? "", /no source citations/);
    const aliasCandidate = result.issues.find((issue) => issue.kind === "semantic_alias_candidate");
    assert.equal(aliasCandidate?.path, "knowledge-base/wiki/pages/autonomous-agentic-quantum-eda.md");
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
        note: "shared sources: paper-d; overlapping tokens: agentic, autonomous, design, eda, quantum, superconducting"
      }]
    });

    const scope = allowed.actions.find((action) => action.type === "update_scope_note");
    assert.equal(scope?.issueKind, "scope_drift");
    assert.equal(scope?.risk, "low");
    assert.equal(scope?.owner, "wiki-agent");
    assert.equal(scope?.recommendedTool, "wiki_apply_structure_plan");
    assert.deepEqual(scope?.recommendedArgs, {
      pagePath: "knowledge-base/wiki/pages/agentic-chip-design.md",
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
    assert.ok(capped.actions.length <= 6);
    assert.ok(capped.actions.some((action) => action.type === "verify"));

    const tinyCap = await planWikiStructure({
      workspaceDir: workspace,
      maxItems: 1,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "agentic chip design",
      budget: { maxPagesToBuild: 0, maxAliasesToCreate: 1, maxScopeNotes: 0 }
    });
    assert.ok(tinyCap.actions.length <= 1);
    assert.ok(!tinyCap.actions.some((action) => action.recommendedTool && action.recommendedTool !== "wiki_lint" && action.recommendedTool !== "wiki_health"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
