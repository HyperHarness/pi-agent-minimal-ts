# Wiki Self-Optimization Tools Design

## Goal

Upgrade the existing wiki maintenance surface so `wiki-agent` can diagnose, prioritize, plan, and safely apply knowledge-base improvements without adding a large number of public tools.

The design keeps the current worker boundaries intact:

- `wiki-agent` coordinates durable wiki growth and structure.
- `wiki-evidence-worker` owns source-summary construction.
- `paper-download-subagent` owns acquisition, parsing, and citation metadata repair.
- `paper-writing-worker` consumes wiki evidence but does not restructure the wiki.

## Current Code Reality

The current public wiki maintenance surface is already close to the right shape:

- `wiki_lint` reports structure issues and repeated tags.
- `wiki_structure_plan` turns lint issues into reviewable actions.
- `wiki_apply_structure_plan` applies only low-risk supported actions.
- `build_wiki_page` creates durable synthesis pages through evidence-first bootstrap.
- `merge_wiki_aliases` creates explicit alias pages.

The main gaps are capability depth rather than missing tool names:

- `wiki_lint` treats repeated source tags as uniform low-priority `concept_gap` issues.
- `wiki_structure_plan` maps lint findings mechanically and does not account for research goals, evidence readiness, or action budgets.
- `wiki_apply_structure_plan` currently supports only deterministic duplicate-section cleanup.
- `build_wiki_page` requires at least one source citation, but it does not expose page-level evidence contract controls such as minimum source count or write-after verification.

## Design Choice

Use the existing tool names as the stable public interface and add one internal maintenance module.

Rejected alternatives:

- Add many public tools such as `wiki_coverage_map`, `wiki_concept_triage`, `wiki_page_quality_audit`, `wiki_alias_merge_candidates`, and `wiki_maintenance_session`. This makes each capability clear, but it increases tool-selection complexity for the agent.
- Put every new capability directly inside `wiki_lint`. This keeps the public surface small, but it mixes diagnosis, planning, and execution concerns.

Chosen approach:

- Add internal helpers in `src/agent/wiki/maintenance.ts`.
- Expose their results through enhanced `wiki_lint` and `wiki_structure_plan`.
- Keep writes inside `wiki_apply_structure_plan`, `build_wiki_page`, and `merge_wiki_aliases`.

## Internal Module

Create `src/agent/wiki/maintenance.ts` with pure, deterministic helpers:

- `buildWikiCoverageMap(options)`
- `rankConceptGaps(options)`
- `auditPageEvidenceContracts(options)`
- `suggestSemanticAliases(options)`
- `auditScopeDrift(options)`
- `buildWikiMaintenancePlan(options)`

These helpers should read wiki pages and source summaries, but they should not write files.

Shared parsing helpers should support:

- frontmatter string and list extraction;
- page title, page key, alias status, related pages, source citations;
- source summary tags, related papers, open questions, key findings, and body text;
- normalized token sets for slug/title similarity.

## Enhanced `wiki_lint`

Extend the input schema:

```ts
{
  maxItems?: number;
  goal?: string;
  focus?: string[];
  includeCoverage?: boolean;
  includeQualityAudit?: boolean;
  includeAliasCandidates?: boolean;
}
```

Keep the existing `issues`, `summary`, and `actions` fields. Add these issue kinds:

```ts
| "high_value_concept_gap"
| "evidence_contract_gap"
| "semantic_alias_candidate"
| "scope_drift"
```

Default lint must keep existing structural repair behavior stable. `conceptTriage`
can be returned as a report, but `high_value_concept_gap` should only be emitted
as an issue when the caller supplies `goal` or `focus`.

Add optional machine-readable reports:

```ts
reports?: {
  coverage?: {
    sourceCount: number;
    pageCount: number;
    coveredSourceCount: number;
    uncoveredSources: Array<{
      paperKey: string;
      title: string;
      tags: string[];
      candidatePageKeys: string[];
      reason: string;
    }>;
    weaklyCoveredPages: Array<{
      pageKey: string;
      sourceCount: number;
      reason: string;
    }>;
    tagClusters: Array<{
      tag: string;
      sourceCount: number;
      existingPageKey?: string;
      uncoveredSourceCount: number;
    }>;
  };
  conceptTriage?: {
    rankedConcepts: Array<{
      concept: string;
      sourceCount: number;
      priority: "high" | "medium" | "low";
      score: number;
      evidenceReadiness: "ready" | "needs_summary" | "needs_acquisition";
      recommendedAction: "build_page" | "alias_to_existing" | "defer";
      candidateCanonicalPage?: string;
      representativeSources: Array<{
        paperKey: string;
        title: string;
        path: string;
      }>;
      rationale: string;
    }>;
  };
  pageQuality?: {
    evidenceContractGaps: Array<{
      pageKey: string;
      path: string;
      inferredContract: "paper-backed" | "design-backed" | "code-backed" | "mixed" | "unverified";
      sourceCount: number;
      reason: string;
    }>;
  };
  aliasCandidates?: {
    suggestions: Array<{
      canonicalPageKey: string;
      aliasPageKey: string;
      score: number;
      risk: "low" | "medium";
      evidence: string[];
    }>;
  };
}
```

Concept triage scoring should combine:

- source tag count;
- match against `goal` and `focus`;
- overlap with existing core page titles, tags, and related pages;
- whether representative source summaries already exist;
- whether a close canonical page already exists;
- whether the concept is too broad to promote directly.

`scope_drift` should be conservative. It should only fire when a stale framing term appears in a title, H1, overview paragraph, or explicit scope section. It must not treat every historical mention as stale.

## Enhanced `wiki_structure_plan`

Extend the input schema:

```ts
{
  maxItems?: number;
  includeMediumRisk?: boolean;
  goal?: string;
  focus?: string[];
  includeGrowthActions?: boolean;
  budget?: {
    maxPagesToBuild?: number;
    maxAliasesToCreate?: number;
    maxScopeNotes?: number;
  };
}
```

Keep the current `status`, `lintSummary`, `actionCount`, `actions`, and `warnings` shape, but enrich each action:

```ts
{
  id: string;
  type:
    | "promote_concept"
    | "create_alias"
    | "update_scope_note"
    | "fix_duplicate_section"
    | "fix_rendered_wiki_link"
    | "rebuild_weak_page"
    | "rebuild_index"
    | "verify";
  priority: "high" | "medium" | "low";
  risk: "low" | "medium" | "high";
  issueKind: PaperWikiLintIssue["kind"];
  owner: "wiki-agent" | "paper-download-subagent" | "wiki-evidence-worker";
  path?: string;
  target?: string;
  concept?: string;
  reason: string;
  recommendedTool:
    | "build_wiki_page"
    | "merge_wiki_aliases"
    | "wiki_apply_structure_plan"
    | "wiki_lint"
    | "wiki_health"
    | "wiki_health_fix"
    | "replace_file_text";
  recommendedArgs?: unknown;
  verification?: Array<{
    tool: "wiki_lint" | "wiki_health" | "search_paper_wiki" | "answer_paper_wiki_question";
    args: unknown;
    expected: string;
  }>;
}
```

Planning rules:

- `promote_concept` is medium risk by default and should produce `build_wiki_page` arguments with `mode: "draft"` unless the caller explicitly accepts write-mode actions.
- `create_alias` is low risk only when the canonical page exists and the alias page does not already exist as a synthesis page.
- `update_scope_note` is low risk only when it is limited to a `## Scope Note` section and the proposed note is generated as a draft action.
- acquisition and authorization issues stay owned by `paper-download-subagent`; the wiki planner may surface them, but it must not retry blocked downloads itself.
- the plan should always include verification actions when it proposes writes.

Budgets must cap generated actions before sorting spillover can create a large to-do list. Default budgets:

- `maxPagesToBuild: 3`
- `maxAliasesToCreate: 10`
- `maxScopeNotes: 3`

## Enhanced `wiki_apply_structure_plan`

Keep `dryRun` defaulting to true and `requireLowRisk` defaulting to true.

Supported write actions:

- `fix_duplicate_section`
- `create_alias`, implemented by delegating to the same alias-writing logic as `merge_wiki_aliases`
- `rebuild_index`, using the existing deterministic index rewrite behavior
- `update_scope_note`, limited to adding or replacing exactly one `## Scope Note` section in `knowledge-base/pages/*.md`

Unsupported by apply:

- `promote_concept`
- `rebuild_weak_page`
- page merges that overwrite existing synthesis pages
- external acquisition, download, parse, or source summary generation

Every non-dry-run apply should rerun `wiki_lint` before and after when `runVerification` is true.

## Enhanced `build_wiki_page`

Extend the input schema:

```ts
{
  topic: string;
  question?: string;
  pageKey?: string;
  mode?: "draft" | "write";
  maxLocalResults?: number;
  maxExternalCandidates?: number;
  maxDownloads?: number;
  autoDownload?: boolean;
  autoSummarize?: boolean;
  evidenceContract?: "paper-backed" | "design-backed" | "code-backed" | "mixed";
  minSources?: number;
  requiredSourceKeys?: string[];
  forbidExternalEvidence?: boolean;
  verifyAfterWrite?: boolean;
}
```

Behavior:

- `minSources` applies to write mode. If the minimum is not met, return `needs_evidence` unless the evidence contract is explicitly `design-backed` or `code-backed`.
- `requiredSourceKeys` must all appear in selected source evidence before writing.
- `forbidExternalEvidence` should be respected even outside the `wiki-agent` boundary.
- `verifyAfterWrite` should run a page-scoped lint check or full `wiki_lint` and include the result summary.
- `evidenceContract` should be written into page frontmatter when provided.

This preserves the current evidence-first behavior while making the page quality contract explicit.

## Worker Boundary Rules

The public boundary remains:

- `wiki-agent`: `wiki_lint`, `wiki_structure_plan`, `wiki_apply_structure_plan`, `build_wiki_page`, `merge_wiki_aliases`, local search, and health checks.
- `paper-download-subagent`: `wiki_health_fix`, acquisition, parse, citation metadata repair.
- `wiki-evidence-worker`: source summaries and relations.
- `paper-writing-worker`: retrieval and writing only.

No worker should receive unrestricted raw writes to `knowledge-base/pages/`.

## Suggested Maintenance Loop

For a normal self-optimization pass:

```text
wiki_health
-> wiki_lint({ goal, focus, includeCoverage: true, includeQualityAudit: true, includeAliasCandidates: true })
-> wiki_structure_plan({ goal, focus, includeGrowthActions: true, budget })
-> wiki_apply_structure_plan({ dryRun: true, requireLowRisk: true })
-> user or main-agent approval for low-risk writes
-> wiki_apply_structure_plan({ dryRun: false, requireLowRisk: true })
-> build_wiki_page for top approved concept drafts
-> wiki_lint + wiki_health + search_paper_wiki smoke checks
```

For the current knowledge base, the first useful pass should prioritize high-value concept gaps related to superconducting chip design, calibration, EDA, frequency planning, fabrication, packaging, and cryogenic control before broad background tags.

## Implementation Slices

1. Add `maintenance.ts` with read-only coverage, concept ranking, page contract audit, and alias suggestion helpers.
2. Extend `wiki_lint` types, schema, and output reports.
3. Extend `wiki_structure_plan` to consume the richer lint result and emit budgeted, tool-call-shaped actions.
4. Extend `wiki_apply_structure_plan` with safe alias, index, and scope-note actions.
5. Extend `build_wiki_page` with evidence contract, minimum source, required source, external-evidence, and write verification options.
6. Update README tool descriptions and worker-boundary tests.

## Verification

Use focused tests for each slice and then the full repo suite:

- `npm test` for full validation.
- Tool boundary tests must confirm no new public maintenance tools are required by default.
- `wiki_lint` fixture tests must cover high-value concept gaps, uncovered source reports, evidence-contract gaps, and semantic alias candidates.
- `wiki_structure_plan` fixture tests must cover action budgets, recommended args, verification actions, and medium-risk filtering.
- `wiki_apply_structure_plan` fixture tests must cover dry-run behavior and refusal to overwrite synthesis pages.
- `build_wiki_page` tests must cover `minSources`, `requiredSourceKeys`, `forbidExternalEvidence`, and `verifyAfterWrite`.
