# Research Evidence v1 Design

## Context

The wiki layer already has the first evidence-audit backbone: typed pages, source manifests, claim provenance, typed relations, experiment references, reviewer critique metadata, generalized source kinds, and deterministic lint for several evidence gaps. The next limitation is that research answers still rely on shallow search and soft prompt discipline more than explicit research-grade evidence selection and review.

This design strengthens the existing wiki path without adding a standalone agent, background crawler, or external vector database. The first implementation should be deterministic, local, and testable. It should make the current evidence model easier to retrieve, rank, and audit before later adding embeddings or domain-specific executable checkers.

## Goals

1. Upgrade wiki retrieval from plain text matching to local hybrid evidence ranking that uses lexical matches plus structured fields.
2. Add explicit knowledge-state and freshness metadata to typed wiki pages.
3. Make stale or uncertain evidence visible in retrieval and answer evidence packages.
4. Add an adversarial review surface that reports unsupported claims, unresolved contradictions, stale evidence, missing caveats, and unverified knowledge states.
5. Preserve current paper/wiki tools and existing pages. Legacy pages must remain readable.
6. Keep the first version offline and deterministic so it can be fully covered by unit tests and `npm test`.

## Non-Goals

- No external embedding provider or dense-vector store in v1.
- No background freshness scheduler.
- No automatic live SOTA claim.
- No automatic execution of third-party research code.
- No claim that reviewer output proves truthfulness.
- No forced migration of all existing wiki pages.
- No domain-specific qLDPC or superconducting physics simulator in this patch.

## Recommended Approach

Implement a local research-evidence layer on top of the existing schema-first wiki core.

The first version should combine:

- lexical search over title, aliases, tags, source refs, source kind, body, claims, typed relations, and reviewer critique;
- structured filters for source kind, claim kind, knowledge state, freshness, evidence contract, and page type;
- deterministic warnings for stale, speculative, disputed, low-confidence, or weakly grounded results;
- a reusable adversarial page review function exposed through wiki tools.

This gives the agent a stronger evidence package immediately while keeping a future path open for BM25, embeddings, citation graph ranking, and executable domain checkers.

Rejected alternatives:

- Add embeddings first. This improves semantic recall but introduces provider/config complexity and still would not solve freshness, knowledge state, or adversarial review.
- Build a separate paper-review agent. The current architecture already has wiki tools, typed pages, and paper-writing worker boundaries; a new agent would duplicate state and routing.
- Start with qLDPC calculators. They are valuable, but retrieval and evidence-state problems affect every domain and should be made explicit first.

## Data Model

Extend typed page metadata with two optional fields:

```ts
type WikiKnowledgeState =
  | "established"
  | "promising_unverified"
  | "speculative"
  | "disputed";

interface WikiPageMetadata {
  knowledge_state?: WikiKnowledgeState;
  last_reviewed_at?: string;
}
```

Semantics:

- `established`: multiple sources or durable implementation evidence agree, and the claim is not known to be disputed.
- `promising_unverified`: a paper, method, or design looks useful but lacks reproduction, independent confirmation, or local validation.
- `speculative`: roadmap, extrapolation, design hypothesis, or weakly grounded synthesis.
- `disputed`: contradicted or materially contested evidence exists.

`last_reviewed_at` records when a page was last manually or tool-reviewed against available evidence. It is not the page edit time. Missing `last_reviewed_at` should be treated as unknown freshness, not a parse error.

## Retrieval

Extend `searchWikiEvidence` options with structured controls:

```ts
interface SearchWikiEvidenceOptions {
  sourceKinds?: WikiSourceKind[];
  pageTypes?: WikiPageType[];
  claimKinds?: WikiClaimKind[];
  knowledgeStates?: WikiKnowledgeState[];
  maxEvidenceAgeDays?: number;
  includeWarnings?: boolean;
}
```

Extend match reasons beyond the current `title`, `alias`, `tag`, `source_ref`, and `body`:

```ts
type WikiEvidenceMatchReason =
  | "title"
  | "alias"
  | "tag"
  | "source_ref"
  | "source_kind"
  | "claim"
  | "typed_relation"
  | "reviewer_critique"
  | "body";
```

Ranking should stay deterministic:

- title and alias matches remain strong;
- tag, source kind, and page type matches help domain recall;
- claim statement and claim evidence matches outrank generic body hits;
- typed relations help comparison and contradiction queries;
- reviewer critique matches help review/risk queries;
- stale, speculative, disputed, low-confidence, or missing-review items get warnings, not silent removal;
- explicit filters remove nonmatching items before ranking.

The implementation should keep the existing lexical normalization. It may add field-specific scoring, but it should not introduce a heavyweight search dependency in v1.

## Freshness Policy

Use a deterministic default freshness model:

- `maxEvidenceAgeDays` compares against `last_reviewed_at` for pages and manifest `updatedAt` for sources.
- If no date is available, add an `unknown_freshness` warning.
- If the date is older than the requested threshold, add `stale_evidence`.
- Retrieval responses should expose warnings per result; answer tools should preserve these warnings in the evidence package.

Fast-moving topics are not hardcoded in v1. Instead, callers can pass `maxEvidenceAgeDays` for questions where freshness matters.

## Adversarial Review

Add a deterministic page-review function and expose it as a new wiki tool named `wiki_review_page`:

```ts
interface ReviewWikiPageEvidenceOptions {
  workspaceDir: string;
  pageKey: string;
  maxEvidenceAgeDays?: number;
}
```

The review returns structured findings:

```ts
type WikiReviewFindingKind =
  | "unsupported_claim"
  | "weak_quantitative_provenance"
  | "low_confidence_claim"
  | "unresolved_contradiction"
  | "speculative_knowledge_state"
  | "disputed_knowledge_state"
  | "stale_evidence"
  | "unknown_freshness"
  | "missing_caveat"
  | "missing_experiment_ref"
  | "author_claim_not_validated";
```

The first implementation should derive findings from existing metadata and page text:

- quantitative claim without concrete evidence is high severity;
- low-confidence claim is medium severity;
- contradiction candidate is medium severity;
- `speculative` and `disputed` knowledge states are visible findings;
- stale or unknown freshness is visible;
- code-backed or mixed pages without experiment refs remain visible;
- pages with claims but no limitation or caveat signal get a missing-caveat finding;
- claims whose evidence note or statement indicates author-only assertion can be flagged as author-claim-not-validated.

This review is an audit aid. It should never mark a claim as proven.

## Tooling

Keep existing tools and add minimal options:

- `search_paper_wiki`: keep the name for compatibility, but route to the enhanced structured search.
- `answer_paper_wiki_question`: include retrieval warnings in evidence items and answer policy.
- `answer_research_question`: when local wiki evidence is found, preserve warnings so the final answer can distinguish established from stale or speculative evidence.
- `wiki_lint`: add deterministic checks for missing `knowledge_state`, disputed pages without contradiction relations, and pages without `last_reviewed_at` when quality audit is requested.
- `wiki_review_page`: return the adversarial review report for one page.

The public tool descriptions should say the wiki can provide evidence packages and risk findings, not proof of truth.

## Testing Plan

Use TDD for implementation.

1. Page-schema tests for parsing and serializing `knowledge_state` and `last_reviewed_at`.
2. Page-schema validation test rejecting invalid knowledge states and invalid review dates.
3. Retrieval tests showing claim and typed-relation matches are found even when the query misses title/tag/body surface terms.
4. Retrieval filter tests for source kind, page type, claim kind, knowledge state, and freshness threshold.
5. Retrieval warning tests for stale evidence, unknown freshness, speculative state, disputed state, and low-confidence claims.
6. Review tests for unsupported quantitative claims, unresolved contradictions, stale pages, missing caveats, and missing experiment refs.
7. Tool tests showing answer evidence packages preserve warnings.
8. Full verification with `npm test` from the repository root.

## Implementation Order

1. Extend page schema and retrieval contract types.
2. Add failing tests for metadata parsing and retrieval warnings.
3. Implement metadata parsing/serialization and structured retrieval scoring.
4. Add review function and tests.
5. Wire tool options and evidence warnings.
6. Extend lint quality audit with knowledge-state and freshness checks.
7. Run targeted tests, then full `npm test`.

## Future Work

- Add BM25 or a small local index once the deterministic structured ranking stabilizes.
- Add embedding retrieval as an optional provider behind a local/offline-safe interface.
- Add citation-graph and page-relation graph ranking.
- Add domain checkers for qLDPC parameters, hardware connectivity, frequency allocation, transmon sanity checks, and fabrication assumptions.
- Add explicit freshness policies per topic family.
- Add source-summary extraction that records page, section, paragraph, figure, table, equation, exact quote, units, conditions, and caveats for quantitative claims.
