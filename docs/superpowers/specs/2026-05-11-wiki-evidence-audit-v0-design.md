# Wiki Evidence Audit v0 Design

## Context

The repository already has a schema-first wiki layer, parsed paper artifacts, source summaries, synthesis pages, relation suggestions, wiki lint, and a local graph viewer. The next useful step is not a new standalone agent. It is a stronger evidence contract inside the existing wiki pipeline so synthesis pages can be audited by claim, relationship, local experiment, and reviewer-risk surfaces.

This v0 deliberately excludes the two highest-risk expansions:

- No periodic or always-on latestness monitor. External freshness checks must remain explicit, low-frequency, and user-initiated in a later design.
- No automatic execution of external paper code. Paper-code audit is limited to local experiment references and reproducibility mappings in this v0.

## Goals

1. Record claim-level provenance for quantitative claims in wiki source summaries and synthesis pages.
2. Replace weak related-page semantics with typed relations.
3. Track source contradictions as explicit relation records, including unconfirmed contradiction candidates.
4. Let wiki pages reference local experiment scripts, commands, logs, and result artifacts.
5. Generate reviewer-mode critique points from evidence gaps, contradictions, stale mappings, and missing experiments.
6. Add deterministic lint checks so weak provenance and missing relation structure are visible without relying on LLM judgment.

## Non-Goals

- No background scheduler.
- No automatic arXiv, publisher, or GitHub polling.
- No dependency installation or execution of third-party research repositories.
- No claim that the system can fully verify paper-code consistency.
- No forced migration of all existing wiki pages in the first implementation.

## Proposed Data Model

### Claim Provenance

Add a wiki evidence type for individual claims:

```ts
type WikiClaimKind = "quantitative" | "qualitative" | "assumption" | "limitation";

interface WikiClaimProvenance {
  claimId: string;
  kind: WikiClaimKind;
  statement: string;
  sourceRefs: string[];
  evidence: Array<{
    paperKey?: string;
    sourcePath?: string;
    parsePath?: string;
    chunkId?: string;
    elementId?: string;
    sectionId?: string;
    page?: number;
    figure?: string;
    table?: string;
    codeOutputPath?: string;
    quote?: string;
    note?: string;
  }>;
  confidence: "high" | "medium" | "low";
}
```

Quantitative claims must include at least one concrete location: `page`, `figure`, `table`, `elementId`, `chunkId`, or `codeOutputPath`.

### Typed Relations

Keep legacy `related_pages` readable, but add a structured relation layer:

```ts
type WikiRelationType =
  | "supports"
  | "contradicts"
  | "extends"
  | "uses"
  | "baseline_of"
  | "open_problem_for"
  | "implementation_of";

interface WikiTypedRelation {
  type: WikiRelationType;
  target: string;
  targetKind: "page" | "source" | "experiment" | "code";
  evidenceRefs: string[];
  status: "confirmed" | "candidate" | "rejected";
  note?: string;
}
```

Contradictions should default to `candidate` unless a user or explicit review step confirms them. This avoids turning weak semantic mismatch into a durable contradiction.

### Experiment References

Add page-level experiment references:

```ts
interface WikiExperimentRef {
  experimentId: string;
  title: string;
  scriptPath?: string;
  command?: string;
  resultPath?: string;
  logPath?: string;
  artifactPaths?: string[];
  status: "planned" | "ran" | "failed" | "blocked";
  createdAt?: string;
  updatedAt?: string;
  note?: string;
}
```

All paths must be workspace-relative and must resolve inside the workspace.

### Reviewer Critique

Reviewer critique is generated as structured page metadata or a deterministic report, not as unsupported prose:

```ts
interface WikiReviewerCritiqueItem {
  id: string;
  severity: "high" | "medium" | "low";
  target?: string;
  reason: string;
  suggestedFix: string;
}
```

The first implementation should derive critique items from deterministic signals:

- quantitative claim without concrete provenance;
- contradiction candidate present but unresolved;
- page uses `related_pages` but lacks typed relations;
- code-backed or mixed page lacks experiment refs;
- experiment ref points to a missing path;
- claim cites only a synthesis page but no source summary or parsed-paper location.

## Storage Strategy

Use the existing schema-first wiki layer:

- Extend `src/agent/wiki/page-schema.ts` with optional `claims`, `typed_relations`, `experiment_refs`, and `reviewer_critique` fields.
- Keep old pages readable. Missing new fields should not make legacy pages malformed.
- Extend `src/agent/wiki/retrieval-contract.ts` so downstream workers can read structured claims and relations without scanning raw frontmatter.
- Extend `src/agent/wiki/lint.ts` or `maintenance.ts` with new issue kinds for provenance and relation audit.
- Update `scripts/wiki-web.mjs` graph data to prefer typed relations while preserving legacy `related_pages` fallback.

## Tooling Strategy

Expose this through existing wiki tools rather than a new agent:

- `build_wiki_page` should ask the page worker for claim provenance and typed relations when evidence is available.
- `write_paper_wiki_source` can accept optional claim provenance extracted from source summaries.
- `wiki_lint` should surface missing claim provenance, missing typed relations, unresolved contradictions, and broken experiment refs.
- A future `wiki_review_page` tool may be added if reviewer critique needs an explicit command, but v0 can start by returning critique diagnostics from lint and page generation.

## Testing Plan

Use TDD for implementation:

1. Page schema tests for parsing and serializing new optional fields.
2. Validation tests that quantitative claims require concrete provenance.
3. Retrieval contract tests that structured claim and relation data are available to downstream code.
4. Lint tests for missing quantitative provenance, unresolved contradiction candidates, and missing experiment paths.
5. Graph-data tests or script-level checks showing typed relations appear as edge types while old `related_pages` still work.
6. Tool tests showing `build_wiki_page` and/or `write_paper_wiki_source` preserve the new fields.

Full verification remains `npm test` from the repository root.

## Open Implementation Choices

The implementation plan should decide whether the first writable surface is:

- schema and lint only, with no worker prompt changes; or
- schema, lint, and worker output parsing in the same patch.

The recommended v0 is schema plus lint first, then worker/tool integration. That keeps the first patch deterministic and easy to verify.
