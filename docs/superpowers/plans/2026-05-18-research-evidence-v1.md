# Research Evidence v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen wiki research evidence retrieval with structured metadata, freshness warnings, and deterministic adversarial page review.

**Architecture:** Extend the existing schema-first wiki core rather than adding a new agent. Typed page metadata records knowledge state and review date; retrieval ranks structured claim/relation/review fields and emits warnings; a new `review.ts` module produces adversarial findings consumed by a `wiki_review_page` tool and lint quality audit.

**Tech Stack:** TypeScript ESM, Node test runner, `@mariozechner/pi-ai` Type schemas for tools, existing wiki modules under `src/agent/wiki/`.

---

## File Structure

- Modify `src/agent/wiki/page-schema.ts`: add `WikiKnowledgeState`, `knowledge_state`, `last_reviewed_at`, validation, parse, and serialization support.
- Modify `src/agent/wiki/retrieval-contract.ts`: expose page type, knowledge state, last reviewed date, source manifest date, and source kind on `WikiEvidenceItem`.
- Modify `src/agent/wiki/retrieval-search.ts`: add structured filters, field-specific match reasons, deterministic warnings, and freshness handling.
- Modify `src/agent/wiki/types.ts`: extend `PaperWikiSearchOptions` and `PaperWikiSearchResult` with structured filter fields and warnings.
- Modify `src/agent/wiki/content.ts`: pass structured options into `searchWikiEvidence` and preserve warnings in search results.
- Create `src/agent/wiki/review.ts`: deterministic adversarial review function for one typed page.
- Modify `src/agent/wiki/tools.ts`: add tool parameters for structured search/freshness, preserve warnings in answer packages, and expose `wiki_review_page`.
- Modify `src/agent/tool-types.ts`: add `wiki_review_page` to the tool names and wiki-capable boundaries.
- Modify `src/agent/wiki/lint.ts`: add quality-audit issue kinds for missing knowledge state, missing review date, disputed page without contradiction relation, and reviewer findings.
- Test `test/agent/wiki-page-schema.test.ts`: metadata parsing/validation/serialization.
- Test `test/agent/wiki-retrieval-contract.test.ts`: retrieval fields, filters, structured match reasons, and warnings.
- Test `test/agent/wiki-review.test.ts`: adversarial review findings.
- Test `test/agent/wiki-maintenance.test.ts`: lint quality-audit additions.
- Test `test/agent/tools.test.ts`: tool wiring, `wiki_review_page`, search parameters, and answer evidence warnings.

---

### Task 1: Page Metadata for Knowledge State and Freshness

**Files:**
- Modify: `src/agent/wiki/page-schema.ts`
- Test: `test/agent/wiki-page-schema.test.ts`

- [ ] **Step 1: Write the failing schema parse and serialize test**

Append to `test/agent/wiki-page-schema.test.ts`:

```ts
test("parseWikiPageMarkdown accepts knowledge state and last reviewed metadata", () => {
  const markdown = [
    "---",
    "schema_version: 1",
    "type: concept",
    "key: qldpc-connectivity",
    "title: qLDPC connectivity",
    "aliases: []",
    'tags:',
    '  - "qldpc"',
    "evidence_contract: paper-backed",
    "source_refs:",
    '  - "arxiv-2601.00003"',
    "knowledge_state: promising_unverified",
    "last_reviewed_at: 2026-05-01T00:00:00.000Z",
    "created_at: 2026-05-10T00:00:00.000Z",
    "updated_at: 2026-05-10T00:00:00.000Z",
    "---",
    "",
    "# qLDPC connectivity"
  ].join("\n");

  const parsed = parseWikiPageMarkdown(markdown, "knowledge-base/pages/qldpc-connectivity.md");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.page?.metadata.knowledge_state, "promising_unverified");
  assert.equal(parsed.page?.metadata.last_reviewed_at, "2026-05-01T00:00:00.000Z");

  const serialized = serializeWikiPageMarkdown({
    metadata: parsed.page!.metadata,
    body: parsed.page!.body
  });

  assert.match(serialized, /knowledge_state: "promising_unverified"/);
  assert.match(serialized, /last_reviewed_at: "2026-05-01T00:00:00.000Z"/);
});
```

- [ ] **Step 2: Write the failing validation test**

Append to `test/agent/wiki-page-schema.test.ts`:

```ts
test("validateWikiPageMetadata rejects invalid knowledge state and last reviewed date", () => {
  const result = validateWikiPageMetadata(validMetadata({
    knowledge_state: "settled",
    last_reviewed_at: "not-a-date"
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), [
    "invalid_knowledge_state",
    "invalid_last_reviewed_at"
  ]);
});
```

- [ ] **Step 3: Run schema tests to verify RED**

Run: `npm test -- --test-name-pattern="knowledge state|last reviewed"`

Expected: FAIL because `knowledge_state` is not parsed or serialized and `WikiPageSchemaError["code"]` does not include the new error codes.

- [ ] **Step 4: Add schema types and validation**

In `src/agent/wiki/page-schema.ts`, add the type and metadata fields near the existing wiki metadata types:

```ts
export type WikiKnowledgeState =
  | "established"
  | "promising_unverified"
  | "speculative"
  | "disputed";
```

Add to `WikiPageMetadata`:

```ts
  knowledge_state?: WikiKnowledgeState;
  last_reviewed_at?: string;
```

Add to `WikiPageSchemaError["code"]`:

```ts
    | "invalid_knowledge_state"
    | "invalid_last_reviewed_at"
```

Add constants near the other enum arrays:

```ts
const WIKI_KNOWLEDGE_STATES: readonly WikiKnowledgeState[] = [
  "established",
  "promising_unverified",
  "speculative",
  "disputed"
];
```

Add helper:

```ts
function isWikiKnowledgeState(value: unknown): value is WikiKnowledgeState {
  return typeof value === "string" && WIKI_KNOWLEDGE_STATES.includes(value as WikiKnowledgeState);
}
```

Inside `validateWikiPageMetadata`, compute:

```ts
  const knowledgeState = cleanOptionalString(metadata.knowledge_state);
  const lastReviewedAt = cleanOptionalString(metadata.last_reviewed_at);
```

Add validation after evidence contract validation:

```ts
  if (hasOwnField(metadata, "knowledge_state") && !isWikiKnowledgeState(knowledgeState)) {
    errors.push(schemaError("invalid_knowledge_state", "Wiki knowledge_state is invalid.", path));
  }

  if (hasOwnField(metadata, "last_reviewed_at") && !isValidIsoDate(lastReviewedAt)) {
    errors.push(schemaError("invalid_last_reviewed_at", "Wiki last_reviewed_at must be a valid date string.", path));
  }
```

Add to normalized metadata:

```ts
      ...(isWikiKnowledgeState(knowledgeState) ? { knowledge_state: knowledgeState } : {}),
      ...(lastReviewedAt ? { last_reviewed_at: lastReviewedAt } : {}),
```

Add to `serializeWikiPageMarkdown` before `canonical_page`:

```ts
    ...(metadata.knowledge_state ? [`knowledge_state: ${quoteYamlString(metadata.knowledge_state)}`] : []),
    ...(metadata.last_reviewed_at ? [`last_reviewed_at: ${quoteYamlString(metadata.last_reviewed_at)}`] : []),
```

- [ ] **Step 5: Run schema tests to verify GREEN**

Run: `npm test -- --test-name-pattern="knowledge state|last reviewed|WikiPageMetadata"`

Expected: PASS for the new schema tests and existing page schema tests.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/agent/wiki/page-schema.ts test/agent/wiki-page-schema.test.ts
git commit -m "feat: add wiki knowledge state metadata"
```

---

### Task 2: Structured Retrieval Fields, Filters, and Warnings

**Files:**
- Modify: `src/agent/wiki/retrieval-contract.ts`
- Modify: `src/agent/wiki/retrieval-search.ts`
- Modify: `src/agent/wiki/types.ts`
- Modify: `src/agent/wiki/content.ts`
- Test: `test/agent/wiki-retrieval-contract.test.ts`

- [ ] **Step 1: Write failing retrieval tests for structured fields and filters**

Append to `test/agent/wiki-retrieval-contract.test.ts`:

```ts
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
```

- [ ] **Step 2: Write failing freshness warning test**

Append to `test/agent/wiki-retrieval-contract.test.ts`:

```ts
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
```

- [ ] **Step 3: Run retrieval tests to verify RED**

Run: `npm test -- --test-name-pattern="searchWikiEvidence matches claim|freshness warnings"`

Expected: FAIL because `SearchWikiEvidenceOptions` lacks `claimKinds`, `knowledgeStates`, `maxEvidenceAgeDays`, and `now`, and match reason/warning values do not exist.

- [ ] **Step 4: Extend retrieval contract item fields**

In `src/agent/wiki/retrieval-contract.ts`, import `WikiPageType` and `WikiKnowledgeState` from `page-schema.js`. Add to `WikiEvidenceItem`:

```ts
  pageType?: WikiPageType;
  knowledgeState?: WikiKnowledgeState;
  lastReviewedAt?: string;
  updatedAt?: string;
```

In `readSourceEvidenceItem`, add:

```ts
    updatedAt: manifest?.updatedAt,
```

In `mapTypedPageToEvidenceItem`, add:

```ts
    pageType: page.metadata.type,
    ...(page.metadata.knowledge_state ? { knowledgeState: page.metadata.knowledge_state } : {}),
    ...(page.metadata.last_reviewed_at ? { lastReviewedAt: page.metadata.last_reviewed_at } : {}),
    updatedAt: page.metadata.updated_at,
```

- [ ] **Step 5: Extend retrieval-search types and warnings**

In `src/agent/wiki/retrieval-search.ts`, import:

```ts
import type { WikiClaimKind, WikiKnowledgeState, WikiPageType } from "./page-schema.js";
import type { WikiSourceKind } from "./manifest-store.js";
```

Change `WikiEvidenceMatchReason`:

```ts
export type WikiEvidenceMatchReason =
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

Add warning type:

```ts
export type WikiEvidenceSearchWarning =
  | "stale_evidence"
  | "unknown_freshness"
  | "speculative"
  | "promising_unverified"
  | "disputed"
  | "low_confidence_claim"
  | "unresolved_contradiction"
  | "weak_evidence_contract";
```

Change `warnings: string[]` to `warnings: WikiEvidenceSearchWarning[]`.

Add options:

```ts
  sourceKinds?: WikiSourceKind[];
  pageTypes?: WikiPageType[];
  claimKinds?: WikiClaimKind[];
  knowledgeStates?: WikiKnowledgeState[];
  evidenceContracts?: WikiEvidenceContract[];
  maxEvidenceAgeDays?: number;
  now?: Date;
```

Import `WikiEvidenceContract` from `page-schema.js` if it is not already available.

- [ ] **Step 6: Implement filter, field scoring, and warning helpers**

Add helpers in `src/agent/wiki/retrieval-search.ts`:

```ts
function includesFilter<T extends string>(allowed: readonly T[] | undefined, value: T | undefined): boolean {
  return !allowed || (value !== undefined && allowed.includes(value));
}

function hasClaimKind(item: WikiEvidenceItem, claimKinds: readonly WikiClaimKind[] | undefined): boolean {
  return !claimKinds || (item.claims ?? []).some((claim) => claimKinds.includes(claim.kind));
}

function itemPassesStructuredFilters(item: WikiEvidenceItem, options: SearchWikiEvidenceOptions): boolean {
  return includesFilter(options.sourceKinds, item.sourceKind) &&
    includesFilter(options.pageTypes, item.pageType) &&
    includesFilter(options.knowledgeStates, item.knowledgeState) &&
    includesFilter(options.evidenceContracts, item.evidenceContract) &&
    hasClaimKind(item, options.claimKinds);
}

function fieldTextForClaims(item: WikiEvidenceItem): string {
  return (item.claims ?? [])
    .map((claim) => [
      claim.kind,
      claim.statement,
      claim.sourceRefs.join(" "),
      claim.confidence,
      ...claim.evidence.map((entry) => [
        entry.paperKey,
        entry.sourcePath,
        entry.parsePath,
        entry.chunkId,
        entry.elementId,
        entry.sectionId,
        entry.figure,
        entry.table,
        entry.quote,
        entry.note
      ].filter(Boolean).join(" "))
    ].join(" "))
    .join(" ");
}

function fieldTextForTypedRelations(item: WikiEvidenceItem): string {
  return (item.typedRelations ?? [])
    .map((relation) => `${relation.type} ${relation.target} ${relation.targetKind} ${relation.status} ${relation.evidenceRefs.join(" ")} ${relation.note ?? ""}`)
    .join(" ");
}

function fieldTextForReviewerCritique(item: WikiEvidenceItem): string {
  return (item.reviewerCritique ?? [])
    .map((critique) => `${critique.severity} ${critique.target ?? ""} ${critique.reason} ${critique.suggestedFix}`)
    .join(" ");
}
```

Add warning helper:

```ts
function warningsForItem(item: WikiEvidenceItem, options: SearchWikiEvidenceOptions): WikiEvidenceSearchWarning[] {
  const warnings = new Set<WikiEvidenceSearchWarning>();
  if (item.evidenceContract === "none") {
    warnings.add("weak_evidence_contract");
  }
  if (item.knowledgeState === "promising_unverified") {
    warnings.add("promising_unverified");
  }
  if (item.knowledgeState === "speculative") {
    warnings.add("speculative");
  }
  if (item.knowledgeState === "disputed") {
    warnings.add("disputed");
  }
  if ((item.claims ?? []).some((claim) => claim.confidence === "low")) {
    warnings.add("low_confidence_claim");
  }
  if ((item.typedRelations ?? []).some((relation) => relation.type === "contradicts" && relation.status === "candidate")) {
    warnings.add("unresolved_contradiction");
  }
  if (options.maxEvidenceAgeDays !== undefined) {
    const freshnessDate = item.lastReviewedAt ?? item.updatedAt;
    if (!freshnessDate) {
      warnings.add("unknown_freshness");
    } else {
      const now = options.now ?? new Date();
      const ageMs = now.getTime() - Date.parse(freshnessDate);
      const maxAgeMs = options.maxEvidenceAgeDays * 24 * 60 * 60 * 1000;
      if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
        warnings.add("stale_evidence");
      }
    }
  }
  return [...warnings];
}
```

Update `scoreItem` to add field scores:

```ts
  if (item.sourceKind && matchesAnyNeedle(item.sourceKind, needles)) {
    score += 5;
    matchReasons.push("source_kind");
  }
  if (matchesAnyNeedle(fieldTextForClaims(item), needles)) {
    score += 7;
    matchReasons.push("claim");
  }
  if (matchesAnyNeedle(fieldTextForTypedRelations(item), needles)) {
    score += 5;
    matchReasons.push("typed_relation");
  }
  if (matchesAnyNeedle(fieldTextForReviewerCritique(item), needles)) {
    score += 5;
    matchReasons.push("reviewer_critique");
  }
```

Change returned warnings:

```ts
    warnings: warningsForItem(item, options)
```

Pass `options` into `scoreItem`.

Filter items before scoring:

```ts
    .filter((item) => itemPassesStructuredFilters(item, options))
```

- [ ] **Step 7: Extend public wiki search result types**

In `src/agent/wiki/types.ts`, extend `PaperWikiSearchOptions`:

```ts
  sourceKinds?: WikiSourceKind[];
  pageTypes?: string[];
  claimKinds?: string[];
  knowledgeStates?: string[];
  evidenceContracts?: string[];
  maxEvidenceAgeDays?: number;
```

Extend each `PaperWikiSearchResult.results` item:

```ts
    warnings?: string[];
    matchReasons?: string[];
    knowledgeState?: string;
    lastReviewedAt?: string;
```

- [ ] **Step 8: Wire search options through content**

In `src/agent/wiki/content.ts`, pass structured options into `searchWikiEvidence`:

```ts
    ...(options.sourceKinds !== undefined ? { sourceKinds: options.sourceKinds } : {}),
    ...(options.pageTypes !== undefined ? { pageTypes: options.pageTypes as any } : {}),
    ...(options.claimKinds !== undefined ? { claimKinds: options.claimKinds as any } : {}),
    ...(options.knowledgeStates !== undefined ? { knowledgeStates: options.knowledgeStates as any } : {}),
    ...(options.evidenceContracts !== undefined ? { evidenceContracts: options.evidenceContracts as any } : {}),
    ...(options.maxEvidenceAgeDays !== undefined ? { maxEvidenceAgeDays: options.maxEvidenceAgeDays } : {}),
```

Preserve warnings and reasons in mapped results:

```ts
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        ...(result.matchReasons.length > 0 ? { matchReasons: result.matchReasons } : {}),
        ...(result.item.knowledgeState ? { knowledgeState: result.item.knowledgeState } : {}),
        ...(result.item.lastReviewedAt ? { lastReviewedAt: result.item.lastReviewedAt } : {}),
```

- [ ] **Step 9: Run retrieval tests to verify GREEN**

Run: `npm test -- --test-name-pattern="searchWikiEvidence matches claim|freshness warnings"`

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add src/agent/wiki/retrieval-contract.ts src/agent/wiki/retrieval-search.ts src/agent/wiki/types.ts src/agent/wiki/content.ts test/agent/wiki-retrieval-contract.test.ts
git commit -m "feat: add structured wiki evidence retrieval"
```

---

### Task 3: Deterministic Adversarial Page Review

**Files:**
- Create: `src/agent/wiki/review.ts`
- Test: `test/agent/wiki-review.test.ts`

- [ ] **Step 1: Write failing review tests**

Create `test/agent/wiki-review.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeTypedWikiPage } from "../../src/agent/wiki/typed-store.js";
import { reviewWikiPageEvidence } from "../../src/agent/wiki/review.js";

async function withWorkspace(name: string, run: (workspaceDir: string) => Promise<void>): Promise<void> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), name));
  try {
    await run(workspaceDir);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

test("reviewWikiPageEvidence reports stale speculative low-confidence evidence gaps", async () => {
  await withWorkspace("wiki-review-page-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "finding",
          key: "qldpc-hardware-embedding",
          title: "qLDPC hardware embedding",
          aliases: [],
          tags: ["qldpc"],
          evidence_contract: "mixed",
          source_refs: ["arxiv-2406.06015"],
          knowledge_state: "speculative",
          last_reviewed_at: "2026-01-01T00:00:00.000Z",
          claims: [{
            claimId: "claim-1",
            kind: "quantitative",
            statement: "The design has 1e-3 logical error rate according to author claims.",
            sourceRefs: ["arxiv-2406.06015"],
            evidence: [{ paperKey: "arxiv-2406.06015", page: 3 }],
            confidence: "low"
          }],
          typed_relations: [{
            type: "contradicts",
            target: "surface-code-baseline",
            targetKind: "page",
            evidenceRefs: ["claim-1"],
            status: "candidate"
          }],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# qLDPC hardware embedding\n\nClaim\n\nNo caveat heading here."
      }
    });

    const result = await reviewWikiPageEvidence({
      workspaceDir,
      pageKey: "qldpc-hardware-embedding",
      maxEvidenceAgeDays: 30,
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    assert.equal(result.status, "ready");
    const kinds = result.findings.map((finding) => finding.kind);
    assert.ok(kinds.includes("speculative_knowledge_state"));
    assert.ok(kinds.includes("low_confidence_claim"));
    assert.ok(kinds.includes("unresolved_contradiction"));
    assert.ok(kinds.includes("stale_evidence"));
    assert.ok(kinds.includes("missing_caveat"));
    assert.ok(kinds.includes("missing_experiment_ref"));
    assert.ok(kinds.includes("author_claim_not_validated"));
  });
});
```

- [ ] **Step 2: Run review tests to verify RED**

Run: `npm test -- --test-name-pattern="reviewWikiPageEvidence"`

Expected: FAIL because `src/agent/wiki/review.ts` does not exist.

- [ ] **Step 3: Implement review module**

Create `src/agent/wiki/review.ts`:

```ts
import { readTypedWikiPage } from "./typed-store.js";
import { relativeToWorkspace } from "./store.js";
import type { WikiClaimProvenance, WikiTypedPage } from "./page-schema.js";

export type WikiReviewFindingKind =
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

export type WikiReviewFindingSeverity = "high" | "medium" | "low";

export interface WikiReviewFinding {
  kind: WikiReviewFindingKind;
  severity: WikiReviewFindingSeverity;
  target?: string;
  reason: string;
  suggestedFix: string;
}

export interface ReviewWikiPageEvidenceOptions {
  workspaceDir: string;
  pageKey: string;
  maxEvidenceAgeDays?: number;
  now?: Date;
}

export interface ReviewWikiPageEvidenceResult {
  status: "ready" | "missing" | "malformed";
  pageKey: string;
  path?: string;
  findings: WikiReviewFinding[];
  diagnostics: string[];
}

function claimHasConcreteEvidence(claim: WikiClaimProvenance): boolean {
  return claim.evidence.some((entry) =>
    entry.page !== undefined ||
    Boolean(entry.figure) ||
    Boolean(entry.table) ||
    Boolean(entry.elementId) ||
    Boolean(entry.chunkId) ||
    Boolean(entry.codeOutputPath)
  );
}

function hasCaveatSignal(page: WikiTypedPage): boolean {
  return /(^|\n)##\s+(limitations?|caveats?|scope|known uncertainty|contradictions? or open checks)\b/i.test(page.body) ||
    (page.metadata.claims ?? []).some((claim) => claim.kind === "assumption" || claim.kind === "limitation");
}

function claimLooksAuthorOnly(claim: WikiClaimProvenance): boolean {
  const text = [
    claim.statement,
    ...claim.evidence.map((entry) => `${entry.quote ?? ""} ${entry.note ?? ""}`)
  ].join(" ").toLowerCase();
  return /\b(author|authors|paper|we)\s+(claim|claims|argue|suggest|propose|assume|report)\b/.test(text);
}

function addFinding(findings: WikiReviewFinding[], finding: WikiReviewFinding): void {
  findings.push(finding);
}

function addFreshnessFinding(input: {
  findings: WikiReviewFinding[];
  page: WikiTypedPage;
  maxEvidenceAgeDays?: number;
  now?: Date;
}): void {
  if (input.maxEvidenceAgeDays === undefined) {
    return;
  }
  const reviewedAt = input.page.metadata.last_reviewed_at;
  if (!reviewedAt) {
    addFinding(input.findings, {
      kind: "unknown_freshness",
      severity: "medium",
      reason: "Page has no last_reviewed_at metadata.",
      suggestedFix: "Review the page against current evidence and set last_reviewed_at."
    });
    return;
  }
  const ageMs = (input.now ?? new Date()).getTime() - Date.parse(reviewedAt);
  const maxAgeMs = input.maxEvidenceAgeDays * 24 * 60 * 60 * 1000;
  if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
    addFinding(input.findings, {
      kind: "stale_evidence",
      severity: "medium",
      reason: `Page was last reviewed at ${reviewedAt}, older than ${input.maxEvidenceAgeDays} days.`,
      suggestedFix: "Refresh the evidence review date after checking current source evidence."
    });
  }
}

function reviewPage(page: WikiTypedPage, options: ReviewWikiPageEvidenceOptions): WikiReviewFinding[] {
  const findings: WikiReviewFinding[] = [];
  if (page.metadata.knowledge_state === "speculative") {
    addFinding(findings, {
      kind: "speculative_knowledge_state",
      severity: "medium",
      reason: "Page knowledge_state is speculative.",
      suggestedFix: "Keep conclusions framed as hypotheses until stronger evidence is linked."
    });
  }
  if (page.metadata.knowledge_state === "disputed") {
    addFinding(findings, {
      kind: "disputed_knowledge_state",
      severity: "high",
      reason: "Page knowledge_state is disputed.",
      suggestedFix: "List the conflicting evidence and avoid presenting one side as established."
    });
  }
  addFreshnessFinding({ findings, page, maxEvidenceAgeDays: options.maxEvidenceAgeDays, now: options.now });
  for (const claim of page.metadata.claims ?? []) {
    if (claim.kind === "quantitative" && !claimHasConcreteEvidence(claim)) {
      addFinding(findings, {
        kind: "weak_quantitative_provenance",
        severity: "high",
        target: claim.claimId,
        reason: "Quantitative claim lacks concrete page, figure, table, element, chunk, or code-output provenance.",
        suggestedFix: "Add exact paper or artifact location with units and conditions."
      });
    }
    if (claim.confidence === "low") {
      addFinding(findings, {
        kind: "low_confidence_claim",
        severity: "medium",
        target: claim.claimId,
        reason: "Claim confidence is low.",
        suggestedFix: "Either gather stronger evidence or weaken the page conclusion."
      });
    }
    if (claimLooksAuthorOnly(claim)) {
      addFinding(findings, {
        kind: "author_claim_not_validated",
        severity: "medium",
        target: claim.claimId,
        reason: "Claim appears to rely on author assertion rather than independent validation.",
        suggestedFix: "Label it as author-reported or link independent reproduction evidence."
      });
    }
  }
  for (const relation of page.metadata.typed_relations ?? []) {
    if (relation.type === "contradicts" && relation.status === "candidate") {
      addFinding(findings, {
        kind: "unresolved_contradiction",
        severity: "medium",
        target: relation.target,
        reason: "Contradiction relation is still a candidate.",
        suggestedFix: "Review the conflicting sources and mark the relation confirmed or rejected."
      });
    }
  }
  if ((page.metadata.claims?.length ?? 0) > 0 && !hasCaveatSignal(page)) {
    addFinding(findings, {
      kind: "missing_caveat",
      severity: "medium",
      reason: "Page has claims but no caveat, limitation, scope, or uncertainty signal.",
      suggestedFix: "Add a limitations or scope section that records assumptions and boundaries."
    });
  }
  if (
    (page.metadata.evidence_contract === "code-backed" || page.metadata.evidence_contract === "mixed") &&
    (page.metadata.experiment_refs?.length ?? 0) === 0
  ) {
    addFinding(findings, {
      kind: "missing_experiment_ref",
      severity: "medium",
      reason: "Code-backed or mixed page has no experiment_refs.",
      suggestedFix: "Attach local scripts, logs, or result artifacts that support code-dependent claims."
    });
  }
  return findings;
}

export async function reviewWikiPageEvidence(
  options: ReviewWikiPageEvidenceOptions
): Promise<ReviewWikiPageEvidenceResult> {
  const result = await readTypedWikiPage({
    workspaceDir: options.workspaceDir,
    pageKey: options.pageKey
  });
  if (!result.page) {
    return {
      status: result.status === "missing" ? "missing" : "malformed",
      pageKey: options.pageKey,
      findings: [],
      diagnostics: result.diagnostics.flatMap((diagnostic) => diagnostic.errors.map((error) => error.message))
    };
  }
  return {
    status: "ready",
    pageKey: options.pageKey,
    path: relativeToWorkspace(options.workspaceDir, result.page.path),
    findings: reviewPage(result.page, options),
    diagnostics: []
  };
}
```

- [ ] **Step 4: Run review tests to verify GREEN**

Run: `npm test -- --test-name-pattern="reviewWikiPageEvidence"`

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/agent/wiki/review.ts test/agent/wiki-review.test.ts
git commit -m "feat: add wiki adversarial review"
```

---

### Task 4: Tool Wiring and Answer Evidence Warnings

**Files:**
- Modify: `src/agent/wiki/tools.ts`
- Modify: `src/agent/tool-types.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Write failing tool tests**

Append to `test/agent/tools.test.ts` near existing wiki tool tests:

```ts
test("wiki_review_page tool returns deterministic review findings", async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "wiki-review-tool-"));
  try {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "finding",
          key: "speculative-page",
          title: "Speculative page",
          aliases: [],
          tags: ["qldpc"],
          evidence_contract: "mixed",
          source_refs: ["arxiv-2406.06015"],
          knowledge_state: "speculative",
          claims: [{
            claimId: "claim-1",
            kind: "qualitative",
            statement: "The authors claim this design is promising.",
            sourceRefs: ["arxiv-2406.06015"],
            evidence: [{ paperKey: "arxiv-2406.06015", page: 1 }],
            confidence: "low"
          }],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Speculative page"
      }
    });
    const tools = createAgentTools({ workspaceDir });
    const tool = tools.find((candidate) => candidate.name === "wiki_review_page");
    assert.ok(tool);
    const result = await tool.execute("call-1", {
      pageKey: "speculative-page",
      maxEvidenceAgeDays: 30
    });
    const details = result.details as Awaited<ReturnType<typeof reviewWikiPageEvidence>>;
    assert.equal(details.status, "ready");
    assert.ok(details.findings.some((finding) => finding.kind === "speculative_knowledge_state"));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

Append an answer evidence warning test:

```ts
test("answer_paper_wiki_question preserves wiki evidence warnings", async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "wiki-answer-warnings-"));
  try {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "concept",
          key: "speculative-coupler",
          title: "Speculative coupler",
          aliases: [],
          tags: ["qldpc"],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2406.06015"],
          knowledge_state: "speculative",
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Speculative coupler\n\nNonlocal coupler pressure."
      }
    });
    const tools = createAgentTools({ workspaceDir });
    const tool = tools.find((candidate) => candidate.name === "answer_paper_wiki_question");
    assert.ok(tool);
    const result = await tool.execute("call-1", {
      query: "nonlocal coupler pressure",
      maxResults: 5,
      maxEvidenceAgeDays: 30
    });
    const details = result.details as any;
    assert.equal(details.status, "has_wiki_evidence");
    assert.ok(details.evidence[0].warnings.includes("speculative"));
    assert.ok(details.answerPolicy.some((line: string) => line.includes("warnings")));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

If `test/agent/tools.test.ts` does not currently import `mkdtemp`, `rm`, `tmpdir`, `writeTypedWikiPage`, or `reviewWikiPageEvidence`, add those imports at the top.

- [ ] **Step 2: Run tool tests to verify RED**

Run: `npm test -- --test-name-pattern="wiki_review_page|evidence warnings"`

Expected: FAIL because the tool name is missing and answer parameters do not accept `maxEvidenceAgeDays`.

- [ ] **Step 3: Add tool type boundary**

In `src/agent/tool-types.ts`, add `"wiki_review_page"` to `ToolName`.

Add it to `"wiki-agent"`:

```ts
    "wiki_review_page",
```

Add it to `"paper-writing-worker"` after `"wiki_lint"` so manuscript review can inspect wiki evidence:

```ts
    "wiki_review_page"
```

- [ ] **Step 4: Wire parameters and tool implementation**

In `src/agent/wiki/tools.ts`, import:

```ts
import { reviewWikiPageEvidence } from "./review.js";
```

Add parameter schema:

```ts
const wikiReviewPageParameters = Type.Object({
  pageKey: Type.String({ description: "Typed wiki page key to review." }),
  maxEvidenceAgeDays: Type.Optional(Type.Integer({
    description: "Warn when last_reviewed_at is older than this many days.",
    minimum: 1
  }))
});
type WikiReviewPageParameters = Static<typeof wikiReviewPageParameters>;
type WikiReviewPageTool = AgentTool<
  typeof wikiReviewPageParameters,
  Awaited<ReturnType<typeof reviewWikiPageEvidence>>
>;
```

Extend `searchPaperWikiParameters`, `answerPaperWikiQuestionParameters`, and `answerResearchQuestionParameters` with:

```ts
  maxEvidenceAgeDays: Type.Optional(Type.Integer({
    description: "Warn when matching evidence is older than this many days.",
    minimum: 1
  }))
```

Extend `AnswerPaperWikiQuestionDetails["evidence"][number]`:

```ts
    warnings?: string[];
    matchReasons?: string[];
    knowledgeState?: string;
    lastReviewedAt?: string;
```

In `buildPaperWikiQuestionEvidence`, pass:

```ts
    ...(input.maxEvidenceAgeDays !== undefined ? { maxEvidenceAgeDays: input.maxEvidenceAgeDays } : {})
```

into `searchPaperWikiImpl`, and add `maxEvidenceAgeDays?: number` to the input type.

When mapping evidence, add:

```ts
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.matchReasons ? { matchReasons: result.matchReasons } : {}),
      ...(result.knowledgeState ? { knowledgeState: result.knowledgeState } : {}),
      ...(result.lastReviewedAt ? { lastReviewedAt: result.lastReviewedAt } : {}),
```

Append answer policy line when any evidence has warnings:

```ts
      ...(evidence.some((item) => (item.warnings?.length ?? 0) > 0)
        ? ["Report evidence warnings such as stale, speculative, disputed, or low-confidence status before drawing conclusions."]
        : [])
```

Create the tool near `wikiLintTool`:

```ts
  const wikiReviewPageTool: WikiReviewPageTool = {
    name: "wiki_review_page",
    label: "Wiki Review Page",
    description:
      "Runs deterministic adversarial review on one typed wiki page, reporting stale evidence, speculative state, contradiction candidates, missing caveats, and weak claim grounding.",
    parameters: wikiReviewPageParameters,
    execute: async (_toolCallId: string, args: WikiReviewPageParameters) => {
      const result = await reviewWikiPageEvidence({
        workspaceDir: resolvedWorkspaceDir,
        pageKey: args.pageKey,
        ...(args.maxEvidenceAgeDays !== undefined ? { maxEvidenceAgeDays: args.maxEvidenceAgeDays } : {})
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };
```

Add `wikiReviewPageTool` to the returned tool array.

- [ ] **Step 5: Pass freshness option through research tools**

In `answerPaperWikiQuestionTool.execute`, pass `maxEvidenceAgeDays`.

In `answerResearchQuestionTool.execute`, pass `maxEvidenceAgeDays` to local evidence search.

When returning `answered_from_wiki`, add answer policy:

```ts
            "Preserve and report any local evidence warnings before presenting conclusions."
```

- [ ] **Step 6: Run tool tests to verify GREEN**

Run: `npm test -- --test-name-pattern="wiki_review_page|evidence warnings"`

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/agent/wiki/tools.ts src/agent/tool-types.ts test/agent/tools.test.ts
git commit -m "feat: expose wiki evidence review tool"
```

---

### Task 5: Lint Quality Audit for Knowledge State and Review Dates

**Files:**
- Modify: `src/agent/wiki/lint.ts`
- Test: `test/agent/wiki-maintenance.test.ts`

- [ ] **Step 1: Write failing lint test**

Append to `test/agent/wiki-maintenance.test.ts` near quality-audit tests:

```ts
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
```

- [ ] **Step 2: Run lint test to verify RED**

Run: `npm test -- --test-name-pattern="missing knowledge state"`

Expected: FAIL because the issue kinds do not exist.

- [ ] **Step 3: Extend lint issue kinds and actions**

In `src/agent/wiki/lint.ts`, add to `PaperWikiLintIssueKind` and `ISSUE_KINDS`:

```ts
  | "missing_knowledge_state"
  | "missing_last_reviewed_at"
  | "disputed_without_contradiction"
```

Add action text in `summarizeActions`:

```ts
    ["missing_knowledge_state", "Classify typed research pages as established, promising_unverified, speculative, or disputed."],
    ["missing_last_reviewed_at", "Review typed research pages and record last_reviewed_at."],
    ["disputed_without_contradiction", "Add typed contradiction relations to disputed pages."]
```

- [ ] **Step 4: Add lint checks inside quality audit page loop**

Inside `if (options.includeQualityAudit)`, in the typed page loop after `relativePath` is computed, add:

```ts
      if (
        page.metadata.type !== "alias" &&
        page.metadata.evidence_contract !== "none" &&
        !page.metadata.knowledge_state
      ) {
        issues.push({
          kind: "missing_knowledge_state",
          severity: "low",
          path: relativePath,
          reason: "Evidence-backed typed page has no knowledge_state."
        });
      }
      if (
        page.metadata.type !== "alias" &&
        page.metadata.evidence_contract !== "none" &&
        !page.metadata.last_reviewed_at
      ) {
        issues.push({
          kind: "missing_last_reviewed_at",
          severity: "low",
          path: relativePath,
          reason: "Evidence-backed typed page has no last_reviewed_at."
        });
      }
      if (
        page.metadata.knowledge_state === "disputed" &&
        !(page.metadata.typed_relations ?? []).some((relation) => relation.type === "contradicts")
      ) {
        issues.push({
          kind: "disputed_without_contradiction",
          severity: "medium",
          path: relativePath,
          reason: "Disputed page has no typed_relations entry with type contradicts."
        });
      }
```

- [ ] **Step 5: Run lint test to verify GREEN**

Run: `npm test -- --test-name-pattern="missing knowledge state"`

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/agent/wiki/lint.ts test/agent/wiki-maintenance.test.ts
git commit -m "feat: lint wiki knowledge state freshness"
```

---

### Task 6: Full Verification and Cleanup

**Files:**
- Review all files changed by Tasks 1-5.

- [ ] **Step 1: Run targeted wiki tests**

Run:

```bash
npm test -- --test-name-pattern="knowledge state|searchWikiEvidence matches claim|freshness warnings|reviewWikiPageEvidence|wiki_review_page|evidence warnings|missing knowledge state"
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: PASS. If tests fail because of unrelated sandbox loopback `listen EPERM 127.0.0.1`, record the exact failing test and rerun the relevant targeted tests. If tests fail for code changed by this plan, fix the regression before continuing.

- [ ] **Step 3: Inspect final diff**

Run: `git status --short`

Expected: no unstaged files except files intentionally changed by this plan before the final commit.

Run: `git log --oneline -6`

Expected: shows the task commits in order after `docs: design research evidence v1`.

- [ ] **Step 4: Final commit if cleanup changes were needed**

If Step 2 or Step 3 required cleanup edits, commit them:

```bash
git add src test
git commit -m "fix: stabilize research evidence v1"
```

Expected: commit succeeds or there are no cleanup edits to commit.

---

## Self-Review Notes

- Spec coverage: metadata, retrieval filters, warnings, freshness, adversarial review, tool wiring, lint quality audit, and full `npm test` are each covered by a task.
- Scope kept local and deterministic: no embedding provider, no background scheduler, no external paper-code execution, and no qLDPC simulator in this plan.
- Type consistency: the plan uses `knowledge_state`, `last_reviewed_at`, `WikiKnowledgeState`, `wiki_review_page`, `maxEvidenceAgeDays`, `warnings`, and `matchReasons` consistently across schema, retrieval, tools, and tests.
- Test-first discipline: each implementation task begins with a failing test and an explicit RED command before production edits.
