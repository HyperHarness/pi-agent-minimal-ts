# Wiki Evidence Audit v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the deterministic v0 evidence-audit substrate for claim provenance, typed relations, experiment references, and reviewer critique diagnostics inside the existing wiki layer.

**Architecture:** Extend the existing schema-first wiki page contract first, then expose the new structured fields through the retrieval contract, then add lint checks and graph-data support. Keep worker prompt/tool generation changes out of this first implementation pass so the data contract can be verified without changing LLM behavior.

**Tech Stack:** TypeScript, Node.js built-in test runner, existing wiki modules under `src/agent/wiki/**`, local graph script `scripts/wiki-web.mjs`.

---

## File Structure

- Modify `src/agent/wiki/page-schema.ts`: define new evidence-audit types, parse optional JSON frontmatter fields, validate quantitative claims and experiment paths, serialize the new fields.
- Modify `test/agent/wiki-page-schema.test.ts`: add red/green schema tests for claims, relations, experiments, critique, and invalid quantitative provenance.
- Modify `src/agent/wiki/retrieval-contract.ts`: include the structured fields in `WikiEvidenceItem` for typed pages.
- Modify `test/agent/wiki-retrieval-contract.test.ts`: verify downstream evidence reads claim/relation/experiment fields.
- Modify `src/agent/wiki/lint.ts`: add deterministic issue kinds for missing provenance, unresolved contradictions, missing typed relations, broken experiment refs, and code-backed pages without experiments.
- Modify `test/agent/wiki-maintenance.test.ts`: add lint tests using temporary typed wiki pages.
- Modify `scripts/wiki-web.mjs`: make `/graph-data.json` prefer `typed_relations` edge types and fall back to `related_pages`.
- Create `test/scripts/wiki-web-graph.test.mjs`: script-level test for typed graph edges using exported helpers from `scripts/wiki-web.mjs`, if the script is made import-safe.
- Modify `docs/superpowers/specs/2026-05-11-wiki-evidence-audit-v0-design.md` only if implementation choices differ from the approved spec.

## Task 1: Page Schema Contract

**Files:**
- Modify: `test/agent/wiki-page-schema.test.ts`
- Modify: `src/agent/wiki/page-schema.ts`

- [ ] **Step 1: Write the failing schema parse/serialize test**

Append this test to `test/agent/wiki-page-schema.test.ts`:

```ts
test("parseWikiPageMarkdown accepts evidence audit metadata", () => {
  const markdown = [
    "---",
    "schema_version: 1",
    'type: "concept"',
    'key: "logical-error-rate"',
    'title: "Logical error rate"',
    "aliases: []",
    "tags: []",
    'evidence_contract: "mixed"',
    "source_refs:",
    '  - "arxiv-2406.06015"',
    'claims: [{"claimId":"claim-1","kind":"quantitative","statement":"The fitted threshold is 0.016.","sourceRefs":["arxiv-2406.06015"],"evidence":[{"paperKey":"arxiv-2406.06015","page":1,"figure":"16","elementId":"el-00555","quote":"fit parameters"}],"confidence":"high"}]',
    'typed_relations: [{"type":"supports","target":"surface-code","targetKind":"page","evidenceRefs":["claim-1"],"status":"confirmed","note":"Uses surface-code scaling."}]',
    'experiment_refs: [{"experimentId":"exp-1","title":"Scaling fit reproduction","scriptPath":"experiments/scaling-fit/run.ts","resultPath":"experiments/scaling-fit/result.json","status":"planned"}]',
    'reviewer_critique: [{"id":"critique-1","severity":"medium","target":"claim-1","reason":"Fit assumptions need checking.","suggestedFix":"Link the simulation configuration."}]',
    'created_at: "2026-05-10T00:00:00.000Z"',
    'updated_at: "2026-05-10T00:00:00.000Z"',
    "---",
    "",
    "# Logical error rate"
  ].join("\n");

  const parsed = parseWikiPageMarkdown(markdown, "knowledge-base/pages/logical-error-rate.md");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.page?.metadata.claims?.[0].claimId, "claim-1");
  assert.equal(parsed.page?.metadata.typed_relations?.[0].type, "supports");
  assert.equal(parsed.page?.metadata.experiment_refs?.[0].scriptPath, "experiments/scaling-fit/run.ts");
  assert.equal(parsed.page?.metadata.reviewer_critique?.[0].severity, "medium");

  const serialized = serializeWikiPageMarkdown({
    metadata: parsed.page!.metadata,
    body: parsed.page!.body
  });
  assert.match(serialized, /claims: \[/);
  assert.match(serialized, /typed_relations: \[/);
  assert.match(serialized, /experiment_refs: \[/);
  assert.match(serialized, /reviewer_critique: \[/);
});
```

- [ ] **Step 2: Write the failing validation test**

Append this test to `test/agent/wiki-page-schema.test.ts`:

```ts
test("validateWikiPageMetadata rejects quantitative claims without concrete provenance", () => {
  const result = validateWikiPageMetadata(validMetadata({
    claims: [{
      claimId: "claim-1",
      kind: "quantitative",
      statement: "The threshold is 0.016.",
      sourceRefs: ["arxiv-2406.06015"],
      evidence: [{
        paperKey: "arxiv-2406.06015",
        quote: "fit parameters"
      }],
      confidence: "high"
    }]
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["invalid_claim_provenance"]);
});
```

- [ ] **Step 3: Run focused schema tests and verify RED**

Run: `npm test -- test/agent/wiki-page-schema.test.ts`

Expected: build fails with TypeScript errors for missing metadata fields or the tests fail because `claims`, `typed_relations`, `experiment_refs`, and `reviewer_critique` are not parsed/validated.

- [ ] **Step 4: Implement minimal schema support**

In `src/agent/wiki/page-schema.ts`, add these exported types near the existing `WikiEvidenceContract` type:

```ts
export type WikiClaimKind = "quantitative" | "qualitative" | "assumption" | "limitation";
export type WikiClaimConfidence = "high" | "medium" | "low";
export type WikiRelationType =
  | "supports"
  | "contradicts"
  | "extends"
  | "uses"
  | "baseline_of"
  | "open_problem_for"
  | "implementation_of";
export type WikiRelationTargetKind = "page" | "source" | "experiment" | "code";
export type WikiRelationStatus = "confirmed" | "candidate" | "rejected";
export type WikiExperimentStatus = "planned" | "ran" | "failed" | "blocked";
export type WikiReviewerCritiqueSeverity = "high" | "medium" | "low";

export interface WikiClaimEvidence {
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
}

export interface WikiClaimProvenance {
  claimId: string;
  kind: WikiClaimKind;
  statement: string;
  sourceRefs: string[];
  evidence: WikiClaimEvidence[];
  confidence: WikiClaimConfidence;
}

export interface WikiTypedRelation {
  type: WikiRelationType;
  target: string;
  targetKind: WikiRelationTargetKind;
  evidenceRefs: string[];
  status: WikiRelationStatus;
  note?: string;
}

export interface WikiExperimentRef {
  experimentId: string;
  title: string;
  scriptPath?: string;
  command?: string;
  resultPath?: string;
  logPath?: string;
  artifactPaths?: string[];
  status: WikiExperimentStatus;
  createdAt?: string;
  updatedAt?: string;
  note?: string;
}

export interface WikiReviewerCritiqueItem {
  id: string;
  severity: WikiReviewerCritiqueSeverity;
  target?: string;
  reason: string;
  suggestedFix: string;
}
```

Extend `WikiPageMetadata`:

```ts
claims?: WikiClaimProvenance[];
typed_relations?: WikiTypedRelation[];
experiment_refs?: WikiExperimentRef[];
reviewer_critique?: WikiReviewerCritiqueItem[];
```

Extend `WikiPageSchemaError["code"]` with:

```ts
| "invalid_claim_provenance"
| "invalid_typed_relation"
| "invalid_experiment_ref"
| "invalid_reviewer_critique"
```

Update `parseScalarValue()` so inline JSON arrays/objects are parsed:

```ts
if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
```

Add small runtime validators for the four new fields. Keep them permissive but shape-aware. Quantitative claims must have one evidence entry with at least one of `page`, `figure`, `table`, `elementId`, `chunkId`, or `codeOutputPath`.

In `validateWikiPageMetadata()`, clean and validate the new arrays, add errors on bad shapes, and return them only when non-empty.

In `serializeWikiPageMarkdown()`, output optional non-empty arrays with single-line JSON:

```ts
...(metadata.claims ? [`claims: ${JSON.stringify(metadata.claims)}`] : []),
...(metadata.typed_relations ? [`typed_relations: ${JSON.stringify(metadata.typed_relations)}`] : []),
...(metadata.experiment_refs ? [`experiment_refs: ${JSON.stringify(metadata.experiment_refs)}`] : []),
...(metadata.reviewer_critique ? [`reviewer_critique: ${JSON.stringify(metadata.reviewer_critique)}`] : []),
```

- [ ] **Step 5: Run focused schema tests and verify GREEN**

Run: `npm test -- test/agent/wiki-page-schema.test.ts`

Expected: schema tests pass.

- [ ] **Step 6: Commit schema contract**

```bash
git add src/agent/wiki/page-schema.ts test/agent/wiki-page-schema.test.ts
git commit -m "Add wiki evidence audit schema"
```

## Task 2: Retrieval Contract Exposure

**Files:**
- Modify: `test/agent/wiki-retrieval-contract.test.ts`
- Modify: `src/agent/wiki/retrieval-contract.ts`

- [ ] **Step 1: Write the failing retrieval test**

Append this test to `test/agent/wiki-retrieval-contract.test.ts`:

```ts
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
```

- [ ] **Step 2: Run focused retrieval tests and verify RED**

Run: `npm test -- test/agent/wiki-retrieval-contract.test.ts`

Expected: TypeScript fails because `WikiEvidenceItem` does not expose `claims`, `typedRelations`, or `experimentRefs`.

- [ ] **Step 3: Implement retrieval mapping**

In `src/agent/wiki/retrieval-contract.ts`, import the new types:

```ts
type WikiClaimProvenance,
type WikiTypedRelation,
type WikiExperimentRef,
type WikiReviewerCritiqueItem
```

Extend `WikiEvidenceItem`:

```ts
claims?: WikiClaimProvenance[];
typedRelations?: WikiTypedRelation[];
experimentRefs?: WikiExperimentRef[];
reviewerCritique?: WikiReviewerCritiqueItem[];
```

In `mapTypedPageToEvidenceItem()`, copy optional metadata fields:

```ts
...(page.metadata.claims ? { claims: page.metadata.claims } : {}),
...(page.metadata.typed_relations ? { typedRelations: page.metadata.typed_relations } : {}),
...(page.metadata.experiment_refs ? { experimentRefs: page.metadata.experiment_refs } : {}),
...(page.metadata.reviewer_critique ? { reviewerCritique: page.metadata.reviewer_critique } : {})
```

- [ ] **Step 4: Run focused retrieval tests and verify GREEN**

Run: `npm test -- test/agent/wiki-retrieval-contract.test.ts`

Expected: retrieval tests pass.

- [ ] **Step 5: Commit retrieval exposure**

```bash
git add src/agent/wiki/retrieval-contract.ts test/agent/wiki-retrieval-contract.test.ts
git commit -m "Expose wiki evidence audit metadata"
```

## Task 3: Deterministic Wiki Lint Audits

**Files:**
- Modify: `test/agent/wiki-maintenance.test.ts`
- Modify: `src/agent/wiki/lint.ts`

- [ ] **Step 1: Write failing lint tests**

Append these tests to `test/agent/wiki-maintenance.test.ts`:

```ts
test("lintPaperWiki reports evidence audit gaps for typed pages", async () => {
  const workspace = await createWorkspace();
  try {
    await writePage(workspace, "audit-page", `
---
schema_version: 1
type: concept
key: audit-page
title: Audit Page
aliases: []
tags: []
evidence_contract: mixed
source_refs:
  - "arxiv-2406.06015"
related_pages:
  - "surface-code"
claims: [{"claimId":"claim-1","kind":"quantitative","statement":"The threshold is 0.016.","sourceRefs":["arxiv-2406.06015"],"evidence":[{"paperKey":"arxiv-2406.06015","quote":"fit"}],"confidence":"high"}]
typed_relations: [{"type":"contradicts","target":"other-paper","targetKind":"source","evidenceRefs":["claim-1"],"status":"candidate"}]
experiment_refs: [{"experimentId":"exp-1","title":"Missing log","logPath":"experiments/missing.log","status":"ran"}]
created_at: 2026-05-10T00:00:00.000Z
updated_at: 2026-05-10T00:00:00.000Z
---

# Audit Page
`);

    const result = await lintPaperWiki({
      workspaceDir: workspace,
      includeQualityAudit: true,
      maxItems: 20
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
```

- [ ] **Step 2: Run focused lint tests and verify RED**

Run: `npm test -- test/agent/wiki-maintenance.test.ts`

Expected: TypeScript fails because new lint issue kinds are not in `PaperWikiLintIssueKind`, or assertions fail because the issues are missing.

- [ ] **Step 3: Implement lint issue kinds and audit logic**

In `src/agent/wiki/lint.ts`, extend `PaperWikiLintIssueKind` and `ISSUE_KINDS`:

```ts
| "missing_claim_provenance"
| "unresolved_contradiction"
| "missing_typed_relation"
| "missing_experiment_ref"
| "code_backed_without_experiment"
```

Add action text in `summarizeActions()`:

```ts
["missing_claim_provenance", "Add concrete page, figure, table, element, chunk, or code-output provenance to quantitative claims."],
["unresolved_contradiction", "Review contradiction candidates and mark them confirmed or rejected."],
["missing_typed_relation", "Replace legacy related_pages with typed_relations."],
["missing_experiment_ref", "Fix experiment_refs paths or update the experiment status."],
["code_backed_without_experiment", "Attach local experiment_refs to code-backed or mixed pages when claims depend on code."]
```

Inside the existing `if (options.includeQualityAudit)` block, after typed pages are loaded, add checks for each typed page:

```ts
for (const page of typedPages.pages) {
  const relativePath = relativeToWorkspace(workspaceDir, page.path);
  for (const claim of page.metadata.claims ?? []) {
    if (claim.kind === "quantitative") {
      const hasConcrete = claim.evidence.some((item) =>
        item.page !== undefined ||
        Boolean(item.figure) ||
        Boolean(item.table) ||
        Boolean(item.elementId) ||
        Boolean(item.chunkId) ||
        Boolean(item.codeOutputPath)
      );
      if (!hasConcrete) {
        issues.push({
          kind: "missing_claim_provenance",
          severity: "high",
          path: relativePath,
          target: claim.claimId,
          reason: "Quantitative claim lacks concrete paper location or code output provenance."
        });
      }
    }
  }

  if ((page.metadata.related_pages?.length ?? 0) > 0 && (page.metadata.typed_relations?.length ?? 0) === 0) {
    issues.push({
      kind: "missing_typed_relation",
      severity: "medium",
      path: relativePath,
      reason: "Page still uses related_pages without typed_relations."
    });
  }

  for (const relation of page.metadata.typed_relations ?? []) {
    if (relation.type === "contradicts" && relation.status === "candidate") {
      issues.push({
        kind: "unresolved_contradiction",
        severity: "medium",
        path: relativePath,
        target: relation.target,
        reason: "Contradiction relation is still a candidate and needs review."
      });
    }
  }

  for (const experiment of page.metadata.experiment_refs ?? []) {
    for (const candidatePath of [
      experiment.scriptPath,
      experiment.resultPath,
      experiment.logPath,
      ...(experiment.artifactPaths ?? [])
    ]) {
      if (!candidatePath) {
        continue;
      }
      if (!(await pathExists(path.resolve(workspaceDir, candidatePath)))) {
        issues.push({
          kind: "missing_experiment_ref",
          severity: experiment.status === "planned" ? "low" : "medium",
          path: relativePath,
          target: candidatePath,
          reason: "Experiment reference points to a missing workspace-relative path."
        });
      }
    }
  }

  if (
    (page.metadata.evidence_contract === "code-backed" || page.metadata.evidence_contract === "mixed") &&
    (page.metadata.experiment_refs?.length ?? 0) === 0
  ) {
    issues.push({
      kind: "code_backed_without_experiment",
      severity: "medium",
      path: relativePath,
      reason: "Code-backed or mixed page has no experiment_refs."
    });
  }
}
```

- [ ] **Step 4: Run focused lint tests and verify GREEN**

Run: `npm test -- test/agent/wiki-maintenance.test.ts`

Expected: maintenance/lint tests pass.

- [ ] **Step 5: Commit lint audits**

```bash
git add src/agent/wiki/lint.ts test/agent/wiki-maintenance.test.ts
git commit -m "Add wiki evidence audit lint checks"
```

## Task 4: Typed Graph Data

**Files:**
- Modify: `scripts/wiki-web.mjs`
- Create: `test/scripts/wiki-web-graph.test.mjs`
- Modify: `package.json` only if test discovery does not pick up `test/scripts/**/*.mjs`.

- [ ] **Step 1: Inspect graph helper boundaries**

Run: `rg -n "graph-data|related_pages|function .*Graph|nodes|links" scripts/wiki-web.mjs`

Expected: identify the current graph-data builder and whether helpers can be exported without starting the server.

- [ ] **Step 2: Make the script import-safe and write failing graph test**

If `scripts/wiki-web.mjs` starts the server unconditionally, first refactor only the entrypoint guard:

```js
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  server.listen(port, host, () => {
    console.log(`Wiki web viewer: http://${host}:${port}`);
    console.log(`Serving: ${wikiRoot}`);
  });
}
```

Export the graph builder function that the server already uses. Then create `test/scripts/wiki-web-graph.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildGraphData } from "../../scripts/wiki-web.mjs";

async function writePage(workspace, key, frontmatter) {
  const pagePath = path.join(workspace, "pages", `${key}.md`);
  await mkdir(path.dirname(pagePath), { recursive: true });
  await writeFile(pagePath, `${frontmatter}\n\n# ${key}\n`, "utf8");
}

test("wiki web graph uses typed relation edge types", async () => {
  const wikiRoot = await mkdtemp(path.join(tmpdir(), "wiki-web-graph-"));
  try {
    await writePage(wikiRoot, "surface-code", [
      "---",
      'title: "Surface Code"',
      "---"
    ].join("\n"));
    await writePage(wikiRoot, "logical-error-rate", [
      "---",
      'title: "Logical Error Rate"',
      'typed_relations: [{"type":"supports","target":"surface-code","targetKind":"page","evidenceRefs":["claim-1"],"status":"confirmed"}]',
      "---"
    ].join("\n"));

    const graph = await buildGraphData(wikiRoot);

    assert.equal(graph.links.length, 1);
    assert.equal(graph.links[0].type, "supports");
    assert.equal(graph.links[0].source, "logical-error-rate");
    assert.equal(graph.links[0].target, "surface-code");
  } finally {
    await rm(wikiRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run graph test and verify RED**

Run: `npm run build && node --test --experimental-test-isolation=none test/scripts/wiki-web-graph.test.mjs`

Expected: fail because `buildGraphData` is not exported or typed relations are not used.

- [ ] **Step 4: Implement typed relation graph extraction**

In `scripts/wiki-web.mjs`, parse `typed_relations` from frontmatter using JSON. When a typed relation has `targetKind: "page"` and the target page exists, add a link:

```js
{
  source: sourceNode.id,
  target: relation.target,
  type: relation.type,
  weight: relation.status === "confirmed" ? 3 : 1,
  status: relation.status
}
```

Keep existing `related_pages`, markdown link, and bracket-reference fallback behavior.

- [ ] **Step 5: Run graph test and verify GREEN**

Run: `npm run build && node --test --experimental-test-isolation=none test/scripts/wiki-web-graph.test.mjs`

Expected: graph script test passes.

- [ ] **Step 6: Commit graph support**

```bash
git add scripts/wiki-web.mjs test/scripts/wiki-web-graph.test.mjs package.json
git commit -m "Use typed wiki relations in graph data"
```

## Task 5: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run full test suite**

Run: `npm test`

Expected: build succeeds and Node test suite passes.

- [ ] **Step 2: Inspect git status and final diff**

Run: `git status --short --branch`

Expected: branch is ahead of origin with only intentional commits and no unstaged changes.

Run: `git log --oneline -5`

Expected: recent commits include the design, plan, schema, retrieval, lint, and graph commits.

- [ ] **Step 3: Commit plan document if not already committed**

If `docs/superpowers/plans/2026-05-11-wiki-evidence-audit-v0.md` is still uncommitted:

```bash
git add docs/superpowers/plans/2026-05-11-wiki-evidence-audit-v0.md
git commit -m "Add wiki evidence audit implementation plan"
```

- [ ] **Step 4: Final report**

Report changed files, verification command output, and any remaining limitations:

- latestness monitor is intentionally not implemented;
- automatic external paper-code execution is intentionally not implemented;
- worker/tool generation of claims may be a next patch if v0 only covers deterministic storage and audit.
