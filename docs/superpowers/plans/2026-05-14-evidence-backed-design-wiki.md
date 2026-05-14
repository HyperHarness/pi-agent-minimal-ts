# Evidence-Backed Design Wiki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the wiki evidence layer so papers, material parameters, software docs, lab notes, design artifacts, and code outputs can all ground superconducting chip design pages.

**Architecture:** Keep the existing schema-first wiki core. Add a V2 generalized source manifest and map legacy paper manifests into the same runtime shape, then expose both through the existing retrieval contract and wiki lint surfaces. Page generation remains under current wiki tools; non-paper behavior is introduced through source-kind-aware helpers and deterministic tests before any worker prompt expansion.

**Tech Stack:** TypeScript, Node test runner, existing `src/agent/wiki/**` modules, Markdown frontmatter, JSON source manifests, repository `npm test`.

---

## File Structure

- Modify `src/agent/wiki/manifest-store.ts`: define V2 source manifest types, validation helpers, read/write helpers, and legacy V1-to-V2 normalization.
- Modify `src/agent/wiki/retrieval-contract.ts`: expose `sourceKind`, `sourceKey`, generalized provenance, and artifacts on source evidence items while preserving old fields.
- Modify `src/agent/wiki/lint.ts`: add deterministic non-paper source and design-page diagnostics.
- Create `src/agent/wiki/page-templates.ts`: keep page-template section rules out of `tools.ts` and `lint.ts`.
- Modify `src/agent/wiki/index.ts`: export new manifest and page-template helpers.
- Modify `src/agent/wiki/tools.ts`: select page template guidance for `build_wiki_page` without changing the public tool name.
- Create `test/agent/wiki-manifest-store.test.ts`: V2 manifest read/write and V1 compatibility tests.
- Modify `test/agent/wiki-retrieval-contract.test.ts`: non-paper source evidence fixtures.
- Modify `test/agent/wiki-maintenance.test.ts`: lint diagnostics for material datasets, software docs, methods, findings, and design records.
- Create `test/agent/wiki-page-templates.test.ts`: deterministic page template selection and section validation tests.
- Modify `test/agent/tools.test.ts`: prove existing paper tool wrappers still work and `build_wiki_page` receives template guidance.

## Task 1: Generalized Source Manifest Contract

**Files:**
- Modify: `src/agent/wiki/manifest-store.ts`
- Create: `test/agent/wiki-manifest-store.test.ts`

- [ ] **Step 1: Write the failing V2 manifest tests**

Create `test/agent/wiki-manifest-store.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  normalizeWikiSourceManifest,
  readNormalizedWikiSourceManifest,
  writeWikiSourceManifestV2,
  type WikiSourceManifestV2
} from "../../src/agent/wiki/manifest-store.js";

async function withWorkspace(run: (workspaceDir: string) => Promise<void>): Promise<void> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "wiki-manifest-store-"));
  try {
    await run(workspaceDir);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

test("writeWikiSourceManifestV2 writes a generalized software-doc manifest", async () => {
  await withWorkspace(async (workspaceDir) => {
    const manifest: WikiSourceManifestV2 = {
      schemaVersion: 2,
      sourceKind: "software-doc",
      sourceKey: "software-doc-hfss-eigenmode",
      title: "HFSS Eigenmode Solver Documentation",
      status: "ready",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      summaryPath: "knowledge-base/sources/software-doc-hfss-eigenmode/summary.md",
      provenance: {
        url: "https://example.invalid/hfss/eigenmode",
        retrievedAt: "2026-05-14T00:00:00.000Z",
        softwareName: "Ansys HFSS",
        softwareVersion: "2025 R2"
      },
      artifacts: [{
        kind: "snapshot",
        path: "knowledge-base/sources/software-doc-hfss-eigenmode/raw/snapshot.html"
      }],
      tags: ["hfss", "em-simulation", "package-modes"],
      relatedSourceKeys: [],
      synthesisPageKeys: ["hfss-eigenmode-simulation-workflow"]
    };

    const relativePath = await writeWikiSourceManifestV2({ workspaceDir, manifest });
    assert.equal(relativePath, "knowledge-base/manifests/software-doc-hfss-eigenmode.json");

    const raw = JSON.parse(await readFile(path.join(workspaceDir, relativePath), "utf8")) as WikiSourceManifestV2;
    assert.equal(raw.schemaVersion, 2);
    assert.equal(raw.sourceKind, "software-doc");
    assert.equal(raw.sourceKey, "software-doc-hfss-eigenmode");
    assert.equal(raw.provenance.softwareName, "Ansys HFSS");
  });
});

test("normalizeWikiSourceManifest maps legacy paper manifests into the generalized shape", () => {
  const normalized = normalizeWikiSourceManifest({
    schemaVersion: 1,
    kind: "paper-source",
    paperKey: "arxiv-2601.00003",
    title: "Frequency allocation",
    status: "ready",
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
    sourceSummaryPath: "knowledge-base/sources/arxiv-2601.00003/summary.md",
    provenance: {
      articleUrl: "https://arxiv.org/abs/2601.00003",
      rawPdfPath: "knowledge-base/raw/pdfs/arxiv-2601.00003.pdf"
    },
    parse: {
      engine: "fixture",
      markdownPath: "knowledge-base/sources/arxiv-2601.00003/parses/fixture/document.md",
      jsonPath: "knowledge-base/sources/arxiv-2601.00003/parses/fixture/parse.json",
      qualityPath: "knowledge-base/sources/arxiv-2601.00003/parses/fixture/quality.json"
    },
    tags: ["frequency-allocation"],
    relatedPaperKeys: ["arxiv-2601.00004"],
    synthesisPageKeys: ["frequency-allocation"]
  });

  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.sourceKind, "paper");
  assert.equal(normalized.sourceKey, "arxiv-2601.00003");
  assert.equal(normalized.summaryPath, "knowledge-base/sources/arxiv-2601.00003/summary.md");
  assert.equal(normalized.provenance.url, "https://arxiv.org/abs/2601.00003");
  assert.equal(normalized.provenance.rawPath, "knowledge-base/raw/pdfs/arxiv-2601.00003.pdf");
  assert.deepEqual(normalized.relatedSourceKeys, ["arxiv-2601.00004"]);
  assert.ok(normalized.artifacts.some((artifact) => artifact.kind === "parse" && artifact.engine === "fixture"));
});

test("readNormalizedWikiSourceManifest reads V2 manifests by source key", async () => {
  await withWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, "knowledge-base", "manifests"), { recursive: true });
    await writeFile(path.join(workspaceDir, "knowledge-base", "manifests", "material-sapphire-permittivity.json"), JSON.stringify({
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
      synthesisPageKeys: []
    }, null, 2), "utf8");

    const manifest = await readNormalizedWikiSourceManifest({ workspaceDir, sourceKey: "material-sapphire-permittivity" });
    assert.equal(manifest?.sourceKind, "material-database");
    assert.equal(manifest?.sourceKey, "material-sapphire-permittivity");
    assert.equal(manifest?.status, "needs_review");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run build && node --test dist/test/agent/wiki-manifest-store.test.js
```

Expected: TypeScript compile fails because `normalizeWikiSourceManifest`, `readNormalizedWikiSourceManifest`, `writeWikiSourceManifestV2`, and `WikiSourceManifestV2` do not exist.

- [ ] **Step 3: Add V2 types and normalization helpers**

In `src/agent/wiki/manifest-store.ts`, add these exports near the existing `WikiSourceManifest` definitions:

```ts
export type WikiSourceKind =
  | "paper"
  | "material-database"
  | "software-doc"
  | "vendor-note"
  | "standard"
  | "lab-note"
  | "code-output"
  | "design-artifact"
  | "webpage"
  | "manual";

export type WikiSourceManifestV2Status =
  | WikiSourceManifestStatus
  | "version_unknown"
  | "needs_review";

export type WikiSourceArtifactKind =
  | "raw"
  | "parse"
  | "table"
  | "figure"
  | "script"
  | "result"
  | "log"
  | "snapshot";

export interface WikiSourceArtifact {
  kind: WikiSourceArtifactKind;
  path: string;
  engine?: string;
  qualityPath?: string;
  note?: string;
}

export interface WikiSourceManifestV2 {
  schemaVersion: 2;
  sourceKind: WikiSourceKind;
  sourceKey: string;
  title: string;
  status: WikiSourceManifestV2Status;
  createdAt: string;
  updatedAt: string;
  summaryPath: string;
  provenance: {
    url?: string;
    doi?: string;
    arxivId?: string;
    recordPath?: string;
    rawPath?: string;
    rawSha256?: string;
    retrievedAt?: string;
    version?: string;
    softwareName?: string;
    softwareVersion?: string;
    vendor?: string;
    license?: string;
  };
  artifacts: WikiSourceArtifact[];
  tags: string[];
  relatedSourceKeys: string[];
  synthesisPageKeys: string[];
}

type AnyWikiSourceManifest = WikiSourceManifest | WikiSourceManifestV2;
```

Add these helpers after `readWikiSourceManifest`:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isWikiSourceManifestV2(value: unknown): value is WikiSourceManifestV2 {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === 2 &&
    typeof value.sourceKind === "string" &&
    typeof value.sourceKey === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.summaryPath === "string" &&
    isRecord(value.provenance) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every((artifact) =>
      isRecord(artifact) &&
      typeof artifact.kind === "string" &&
      typeof artifact.path === "string" &&
      (artifact.engine === undefined || typeof artifact.engine === "string") &&
      (artifact.qualityPath === undefined || typeof artifact.qualityPath === "string") &&
      (artifact.note === undefined || typeof artifact.note === "string")
    ) &&
    isStringArray(value.tags) &&
    isStringArray(value.relatedSourceKeys) &&
    isStringArray(value.synthesisPageKeys)
  );
}

export function normalizeWikiSourceManifest(manifest: AnyWikiSourceManifest): WikiSourceManifestV2 {
  if (manifest.schemaVersion === 2) {
    return manifest;
  }

  const artifacts: WikiSourceArtifact[] = [];
  if (manifest.provenance.rawPdfPath) {
    artifacts.push({
      kind: "raw",
      path: manifest.provenance.rawPdfPath
    });
  }
  if (manifest.parse.markdownPath || manifest.parse.jsonPath || manifest.parse.qualityPath) {
    artifacts.push({
      kind: "parse",
      path: manifest.parse.markdownPath || manifest.parse.jsonPath || manifest.parse.qualityPath,
      engine: manifest.parse.engine,
      qualityPath: manifest.parse.qualityPath || undefined
    });
  }

  return {
    schemaVersion: 2,
    sourceKind: "paper",
    sourceKey: manifest.paperKey,
    title: manifest.title,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    summaryPath: manifest.sourceSummaryPath,
    provenance: {
      recordPath: manifest.provenance.recordPath,
      url: manifest.provenance.articleUrl,
      rawPath: manifest.provenance.rawPdfPath,
      rawSha256: manifest.provenance.pdfSha256
    },
    artifacts,
    tags: manifest.tags,
    relatedSourceKeys: manifest.relatedPaperKeys,
    synthesisPageKeys: manifest.synthesisPageKeys
  };
}

export async function writeWikiSourceManifestV2(input: {
  workspaceDir: string;
  manifest: WikiSourceManifestV2;
}): Promise<string> {
  const manifestPath = path.join(input.workspaceDir, "knowledge-base", "manifests", `${input.manifest.sourceKey}.json`);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(input.manifest, null, 2)}\n`, "utf8");
  return relativeToWorkspace(input.workspaceDir, manifestPath);
}

export async function readNormalizedWikiSourceManifest(input: {
  workspaceDir: string;
  sourceKey: string;
}): Promise<WikiSourceManifestV2 | undefined> {
  try {
    const raw = JSON.parse(await readFile(getWikiSourceManifestPath(input.workspaceDir, input.sourceKey), "utf8")) as unknown;
    if (isWikiSourceManifestV2(raw)) {
      return raw;
    }
    return normalizeWikiSourceManifest(raw as WikiSourceManifest);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the targeted manifest tests**

Run:

```bash
npm run build && node --test dist/test/agent/wiki-manifest-store.test.js
```

Expected: all tests in `wiki-manifest-store.test.js` pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/agent/wiki/manifest-store.ts test/agent/wiki-manifest-store.test.ts
git commit -m "feat: add generalized wiki source manifests"
```

## Task 2: Retrieval Contract for Non-Paper Sources

**Files:**
- Modify: `src/agent/wiki/retrieval-contract.ts`
- Modify: `test/agent/wiki-retrieval-contract.test.ts`

- [ ] **Step 1: Write the failing retrieval test**

Append this test to `test/agent/wiki-retrieval-contract.test.ts`:

```ts
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
      `${JSON.stringify({
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
        synthesisPageKeys: ["substrate-and-film-material-parameters"]
      }, null, 2)}\n`
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
```

- [ ] **Step 2: Run the retrieval test to verify it fails**

Run:

```bash
npm run build && node --test dist/test/agent/wiki-retrieval-contract.test.js
```

Expected: TypeScript compile fails because `WikiEvidenceItem` lacks `sourceKind` and `sourceKey`, or the test fails because V2 manifests are rejected.

- [ ] **Step 3: Extend retrieval source items**

In `src/agent/wiki/retrieval-contract.ts`, change the imports from `manifest-store.ts`:

```ts
import {
  getWikiSourceManifestPath,
  normalizeWikiSourceManifest,
  type WikiSourceKind,
  type WikiSourceManifest,
  type WikiSourceManifestStatus,
  type WikiSourceManifestV2
} from "./manifest-store.js";
```

Change `WikiEvidenceItem`:

```ts
export interface WikiEvidenceItem {
  kind: WikiEvidenceKind;
  key: string;
  title: string;
  body: string;
  relativePath: string;
  tags: string[];
  aliases: string[];
  evidenceContract: WikiEvidenceContract;
  sourceRefs: string[];
  sourceKind?: WikiSourceKind;
  sourceKey?: string;
  claims?: WikiClaimProvenance[];
  typedRelations?: WikiTypedRelation[];
  experimentRefs?: WikiExperimentRef[];
  reviewerCritique?: WikiReviewerCritiqueItem[];
  manifest?: WikiSourceManifestV2;
  diagnostics: string[];
}
```

Update `validateSourceManifest` so it accepts V1 or V2. Replace its return type and final validation with:

```ts
function validateSourceManifest(value: unknown): value is WikiSourceManifest | WikiSourceManifestV2 {
  if (!isObject(value)) {
    return false;
  }
  if (value.schemaVersion === 2) {
    return (
      typeof value.sourceKind === "string" &&
      typeof value.sourceKey === "string" &&
      typeof value.title === "string" &&
      typeof value.status === "string" &&
      typeof value.createdAt === "string" &&
      typeof value.updatedAt === "string" &&
      typeof value.summaryPath === "string" &&
      isObject(value.provenance) &&
      Array.isArray(value.artifacts) &&
      isStringArray(value.tags) &&
      isStringArray(value.relatedSourceKeys) &&
      isStringArray(value.synthesisPageKeys)
    );
  }
  return (
    value.schemaVersion === 1 &&
    value.kind === "paper-source" &&
    typeof value.paperKey === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    WIKI_SOURCE_MANIFEST_STATUSES.has(value.status as WikiSourceManifestStatus) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.sourceSummaryPath === "string" &&
    isObject(value.provenance) &&
    hasOnlyOptionalStringFields(value.provenance, ["recordPath", "articleUrl", "rawPdfPath", "pdfSha256"]) &&
    isObject(value.parse) &&
    typeof value.parse.engine === "string" &&
    typeof value.parse.markdownPath === "string" &&
    typeof value.parse.jsonPath === "string" &&
    typeof value.parse.qualityPath === "string" &&
    isStringArray(value.tags) &&
    isStringArray(value.relatedPaperKeys) &&
    isStringArray(value.synthesisPageKeys)
  );
}
```

In `readSourceEvidenceItem`, after reading the manifest result, normalize it:

```ts
  const rawManifest = manifestResult.manifest;
  const manifest = rawManifest ? normalizeWikiSourceManifest(rawManifest) : undefined;

  const sourceRefs = manifest?.sourceKey ? [manifest.sourceKey] : [];
  const item: WikiEvidenceItem = {
    kind: "source",
    key: manifest?.sourceKey ?? options.key,
    title: manifest?.title ?? options.key,
    body: stripLeadingFrontmatter(markdown).trim(),
    relativePath: relativeToWorkspace(options.workspaceDir, sourcePath),
    tags: manifest?.tags ?? [],
    aliases: [],
    evidenceContract: manifest ? "mixed" : "none",
    sourceRefs,
    sourceKind: manifest?.sourceKind,
    sourceKey: manifest?.sourceKey,
    manifest,
    diagnostics
  };
```

- [ ] **Step 4: Run retrieval tests**

Run:

```bash
npm run build && node --test dist/test/agent/wiki-retrieval-contract.test.js
```

Expected: all retrieval-contract tests pass, including legacy paper fixtures.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/agent/wiki/retrieval-contract.ts test/agent/wiki-retrieval-contract.test.ts
git commit -m "feat: expose non-paper wiki evidence"
```

## Task 3: Source-Kind-Aware Page Templates

**Files:**
- Create: `src/agent/wiki/page-templates.ts`
- Create: `test/agent/wiki-page-templates.test.ts`
- Modify: `src/agent/wiki/index.ts`

- [ ] **Step 1: Write page template tests**

Create `test/agent/wiki-page-templates.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  getWikiPageTemplate,
  inferWikiPageTypeForEvidence,
  validateRequiredTemplateSections
} from "../../src/agent/wiki/page-templates.js";

test("inferWikiPageTypeForEvidence maps material sources to dataset pages", () => {
  assert.equal(inferWikiPageTypeForEvidence({
    query: "sapphire substrate dielectric constant table",
    sourceKinds: ["material-database"]
  }), "dataset");
});

test("inferWikiPageTypeForEvidence maps software documentation to method pages", () => {
  assert.equal(inferWikiPageTypeForEvidence({
    query: "HFSS eigenmode simulation workflow for package modes",
    sourceKinds: ["software-doc"]
  }), "method");
});

test("getWikiPageTemplate returns concrete required sections", () => {
  const template = getWikiPageTemplate("design-record");
  assert.equal(template.pageType, "design-record");
  assert.deepEqual(template.requiredSections, [
    "Decision",
    "Context",
    "Evidence Used",
    "Alternatives Considered",
    "Verification Plan",
    "Status"
  ]);
  assert.match(template.guidance, /uses/);
});

test("validateRequiredTemplateSections reports missing method inputs and outputs", () => {
  const result = validateRequiredTemplateSections({
    pageType: "method",
    markdown: "# HFSS Eigenmode Simulation\n\n## Goal\n\nFind package modes.\n\n## Procedure\n\nRun eigenmode solve."
  });

  assert.deepEqual(result.missingSections, ["Inputs", "Outputs", "Failure Modes", "Design Use"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run build && node --test dist/test/agent/wiki-page-templates.test.js
```

Expected: TypeScript compile fails because `page-templates.ts` does not exist.

- [ ] **Step 3: Implement page template helpers**

Create `src/agent/wiki/page-templates.ts`:

```ts
import type { WikiPageType } from "./page-schema.js";
import type { WikiSourceKind } from "./manifest-store.js";

export interface WikiPageTemplate {
  pageType: Extract<WikiPageType, "concept" | "method" | "finding" | "dataset" | "design-record">;
  requiredSections: string[];
  guidance: string;
}

export interface InferWikiPageTypeInput {
  query: string;
  sourceKinds: WikiSourceKind[];
}

const TEMPLATE_BY_TYPE: Record<WikiPageTemplate["pageType"], WikiPageTemplate> = {
  concept: {
    pageType: "concept",
    requiredSections: ["Overview", "Key Concepts", "Evidence", "Open Questions", "Related Pages"],
    guidance: "Use concept pages for stable explanatory knowledge. Ground claims in source_refs and keep design implications explicit."
  },
  dataset: {
    pageType: "dataset",
    requiredSections: ["Parameter Table", "Applicability", "Design Implications", "Known Uncertainty", "Related Pages"],
    guidance: "Use dataset pages for material, device, process, and calibration parameter tables. Quantitative rows need units, conditions, confidence, and source references."
  },
  method: {
    pageType: "method",
    requiredSections: ["Goal", "Inputs", "Procedure", "Outputs", "Failure Modes", "Design Use"],
    guidance: "Use method pages for software documentation and repeatable workflows. Capture tool versions, inputs, outputs, and failure modes."
  },
  finding: {
    pageType: "finding",
    requiredSections: ["Claim", "Evidence", "Scope", "Confidence", "Implications", "Contradictions or Open Checks"],
    guidance: "Use finding pages for evidence-backed conclusions. Attach claim provenance and unresolved contradiction candidates."
  },
  "design-record": {
    pageType: "design-record",
    requiredSections: ["Decision", "Context", "Evidence Used", "Alternatives Considered", "Verification Plan", "Status"],
    guidance: "Use design records for maintained decisions. Add typed_relations such as uses, supports, implementation_of, and open_problem_for."
  }
};

export function getWikiPageTemplate(pageType: WikiPageTemplate["pageType"]): WikiPageTemplate {
  return TEMPLATE_BY_TYPE[pageType];
}

export function inferWikiPageTypeForEvidence(input: InferWikiPageTypeInput): WikiPageTemplate["pageType"] {
  const query = input.query.toLowerCase();
  if (input.sourceKinds.includes("material-database") || /\b(parameter|permittivity|loss tangent|material|substrate|film)\b/.test(query)) {
    return "dataset";
  }
  if (input.sourceKinds.includes("software-doc") || /\b(workflow|procedure|simulation|hfss|qiskit metal|pyepr|scqubits|manual)\b/.test(query)) {
    return "method";
  }
  if (/\b(decision|design record|selected|tradeoff|alternative)\b/.test(query)) {
    return "design-record";
  }
  if (/\b(risk|finding|conclusion|evidence shows|suspected)\b/.test(query)) {
    return "finding";
  }
  return "concept";
}

export function validateRequiredTemplateSections(input: {
  pageType: WikiPageTemplate["pageType"];
  markdown: string;
}): { missingSections: string[] } {
  const headings = new Set(
    [...input.markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value))
  );
  const template = getWikiPageTemplate(input.pageType);
  return {
    missingSections: template.requiredSections.filter((section) => !headings.has(section))
  };
}
```

In `src/agent/wiki/index.ts`, export it:

```ts
export * from "./page-templates.js";
```

- [ ] **Step 4: Run page template tests**

Run:

```bash
npm run build && node --test dist/test/agent/wiki-page-templates.test.js
```

Expected: all page-template tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/agent/wiki/page-templates.ts src/agent/wiki/index.ts test/agent/wiki-page-templates.test.ts
git commit -m "feat: add design wiki page templates"
```

## Task 4: Deterministic Lint for Non-Paper Sources and Design Pages

**Files:**
- Modify: `src/agent/wiki/lint.ts`
- Modify: `test/agent/wiki-maintenance.test.ts`

- [ ] **Step 1: Write failing lint tests**

Append these tests to `test/agent/wiki-maintenance.test.ts`:

```ts
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
tags:
  - materials
evidence_contract: mixed
source_refs:
  - material-sapphire-permittivity
created_at: 2026-05-14T00:00:00.000Z
updated_at: 2026-05-14T00:00:00.000Z
---

# Substrate Material Parameters

## Parameter Table
| Material | Parameter | Value | Unit | Conditions | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Sapphire | relative permittivity | 9.4 | | | medium | material-sapphire-permittivity |
`);

    const result = await lintPaperWiki(workspace);
    assert.ok(result.issues.some((issue) => issue.kind === "material_parameter_missing_unit"));
    assert.ok(result.issues.some((issue) => issue.kind === "material_parameter_missing_condition"));
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
tags:
  - hfss
evidence_contract: mixed
source_refs:
  - software-doc-hfss-eigenmode
created_at: 2026-05-14T00:00:00.000Z
updated_at: 2026-05-14T00:00:00.000Z
---

# HFSS Eigenmode Simulation

## Goal
Find package modes.

## Procedure
Run eigenmode solve.
`);

    const result = await lintPaperWiki(workspace);
    assert.ok(result.issues.some((issue) => issue.kind === "missing_template_section" && issue.target === "Inputs"));
    assert.ok(result.issues.some((issue) => issue.kind === "missing_template_section" && issue.target === "Outputs"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lintPaperWiki reports design records without uses relations", async () => {
  const workspace = await createWorkspace();
  try {
    await writePage(workspace, "package-v0-design-record", `
---
schema_version: 1
type: design-record
key: package-v0-design-record
title: Package v0 Design Record
aliases: []
tags:
  - package
evidence_contract: mixed
source_refs:
  - software-doc-hfss-eigenmode
created_at: 2026-05-14T00:00:00.000Z
updated_at: 2026-05-14T00:00:00.000Z
typed_relations: []
---

# Package v0 Design Record

## Decision
Use a baseline package.

## Context
Initial design.

## Evidence Used
HFSS docs.

## Alternatives Considered
None.

## Verification Plan
Run eigenmode simulation.

## Status
proposed
`);

    const result = await lintPaperWiki(workspace);
    assert.ok(result.issues.some((issue) => issue.kind === "design_record_without_uses_relation"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run lint tests to verify they fail**

Run:

```bash
npm run build && node --test dist/test/agent/wiki-maintenance.test.js
```

Expected: tests fail because the new issue kinds are not emitted.

- [ ] **Step 3: Extend lint issue kinds and summaries**

In `src/agent/wiki/lint.ts`, add issue kinds to the `WikiLintIssueKind` union:

```ts
  | "material_parameter_missing_unit"
  | "material_parameter_missing_condition"
  | "missing_template_section"
  | "design_record_without_uses_relation"
  | "software_doc_version_missing";
```

Add these kinds to any summary initializer and recommendation map in the same file:

```ts
material_parameter_missing_unit: 0,
material_parameter_missing_condition: 0,
missing_template_section: 0,
design_record_without_uses_relation: 0,
software_doc_version_missing: 0,
```

Use recommendation text:

```ts
["material_parameter_missing_unit", "Add units to quantitative material parameter rows."],
["material_parameter_missing_condition", "Add temperature, frequency, process, geometry, or other condition notes to material parameter rows."],
["missing_template_section", "Add the required section for the page type template."],
["design_record_without_uses_relation", "Add typed_relations with uses edges to the datasets, methods, findings, sources, or code artifacts used by this design record."],
["software_doc_version_missing", "Add softwareName/softwareVersion or version provenance to the software documentation source manifest."]
```

- [ ] **Step 4: Add deterministic page checks**

Import the template validator:

```ts
import { validateRequiredTemplateSections } from "./page-templates.js";
```

Add helper functions near existing audit helpers:

```ts
function extractMarkdownTableRows(markdown: string, heading: string): string[][] {
  const section = markdown.match(new RegExp(`^##\\\\s+${heading}\\\\s*$([\\\\s\\\\S]*?)(?=^##\\\\s+|\\\\z)`, "m"))?.[1] ?? "";
  return section
    .split("\n")
    .filter((line) => line.trim().startsWith("|") && !/^\|\s*-+/.test(line.trim()))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length > 0);
}

function materialParameterRowIssues(markdown: string): Array<{ kind: "material_parameter_missing_unit" | "material_parameter_missing_condition"; target: string; reason: string }> {
  const rows = extractMarkdownTableRows(markdown, "Parameter Table");
  const dataRows = rows.slice(1);
  const issues: Array<{ kind: "material_parameter_missing_unit" | "material_parameter_missing_condition"; target: string; reason: string }> = [];
  for (const [index, row] of dataRows.entries()) {
    const unit = row[3] ?? "";
    const conditions = row[4] ?? "";
    if (!unit) {
      issues.push({
        kind: "material_parameter_missing_unit",
        target: `Parameter Table row ${index + 1}`,
        reason: "Material parameter row has an empty Unit cell."
      });
    }
    if (!conditions) {
      issues.push({
        kind: "material_parameter_missing_condition",
        target: `Parameter Table row ${index + 1}`,
        reason: "Material parameter row has an empty Conditions cell."
      });
    }
  }
  return issues;
}
```

Inside the loop that audits typed pages, after existing page metadata checks, add:

```ts
      if (["dataset", "method", "finding", "design-record"].includes(page.metadata.type)) {
        const templateResult = validateRequiredTemplateSections({
          pageType: page.metadata.type as "dataset" | "method" | "finding" | "design-record",
          markdown: page.body
        });
        for (const missingSection of templateResult.missingSections) {
          issues.push({
            kind: "missing_template_section",
            severity: page.metadata.type === "design-record" ? "medium" : "low",
            path: page.path,
            target: missingSection,
            reason: `${page.metadata.type} page is missing required section "${missingSection}".`
          });
        }
      }

      if (page.metadata.type === "dataset") {
        for (const issue of materialParameterRowIssues(page.body)) {
          issues.push({
            kind: issue.kind,
            severity: "medium",
            path: page.path,
            target: issue.target,
            reason: issue.reason
          });
        }
      }

      if (page.metadata.type === "design-record") {
        const hasUsesRelation = (page.metadata.typed_relations ?? []).some((relation) => relation.type === "uses");
        if (!hasUsesRelation) {
          issues.push({
            kind: "design_record_without_uses_relation",
            severity: "medium",
            path: page.path,
            reason: "Design record has no typed_relations entry with type uses."
          });
        }
      }
```

- [ ] **Step 5: Run lint tests**

Run:

```bash
npm run build && node --test dist/test/agent/wiki-maintenance.test.js
```

Expected: all maintenance/lint tests pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/agent/wiki/lint.ts test/agent/wiki-maintenance.test.ts
git commit -m "feat: lint evidence-backed design wiki pages"
```

## Task 5: Existing Tool Integration Without New Public Tool Sprawl

**Files:**
- Modify: `src/agent/wiki/tools.ts`
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Write tool behavior tests**

In `test/agent/tools.test.ts`, add a test near existing `build_wiki_page` tests:

```ts
test("build_wiki_page includes source-kind-aware template guidance", async () => {
  const tools = createTools({
    workspaceDir: "/tmp/pi-agent-tools-template-guidance",
    wikiPageWorker: async (prompt) => {
      assert.match(prompt, /Required sections/);
      assert.match(prompt, /Parameter Table/);
      return {
        pageMarkdown: [
          "# Substrate Material Parameters",
          "",
          "## Parameter Table",
          "| Material | Parameter | Value | Unit | Conditions | Confidence | Source |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| Sapphire | relative permittivity | 9.4 | dimensionless | cryogenic review needed | medium | material-sapphire-permittivity |",
          "",
          "## Applicability",
          "Use for early EM simulation review.",
          "",
          "## Design Implications",
          "Permittivity affects package modes.",
          "",
          "## Known Uncertainty",
          "Cryogenic process dependence must be reviewed.",
          "",
          "## Related Pages",
          "- hfss-eigenmode-simulation"
        ].join("\n"),
        confidence: "medium",
        sourcesUsed: ["material-sapphire-permittivity"],
        relatedPages: ["hfss-eigenmode-simulation"]
      };
    },
    wikiBootstrapPageEvidence: async () => ({
      topic: "sapphire material parameter table",
      seedQueries: ["sapphire material parameter table"],
      sources: [{
        paperKey: "material-sapphire-permittivity",
        title: "Sapphire permittivity values",
        path: "knowledge-base/sources/material-sapphire-permittivity/summary.md",
        snippet: "Relative permittivity values require cryogenic-condition review.",
        tags: ["materials", "sapphire"],
        relatedPapers: []
      }],
      pages: [],
      parsedFallbacks: [],
      missingSummaries: [],
      diagnostics: []
    })
  });

  const tool = tools.find((candidate) => candidate.name === "build_wiki_page");
  assert.ok(tool);
  const result = await tool.execute("build-material-page", {
    topic: "sapphire material parameter table",
    pageKey: "substrate-material-parameters",
    mode: "draft"
  }, undefined);

  assert.equal(result.ok, true);
});
```

- [ ] **Step 2: Run the tool test to verify it fails**

Run:

```bash
npm run build && node --test dist/test/agent/tools.test.js --test-name-pattern "build_wiki_page includes source-kind-aware template guidance"
```

Expected: test fails because the build prompt does not include page template guidance.

- [ ] **Step 3: Add template guidance to build page prompt**

In `src/agent/wiki/tools.ts`, import:

```ts
import { getWikiPageTemplate, inferWikiPageTypeForEvidence } from "./page-templates.js";
```

Near the code that builds the page-worker prompt for `build_wiki_page`, compute:

```ts
      const sourceKinds = bootstrap.sources.map((source) =>
        source.paperKey.startsWith("material-") ? "material-database" :
        source.paperKey.startsWith("software-doc-") ? "software-doc" :
        "paper"
      );
      const inferredPageType = inferWikiPageTypeForEvidence({
        query: topic,
        sourceKinds
      });
      const pageTemplate = getWikiPageTemplate(inferredPageType);
      const templateGuidance = [
        `Recommended page type: ${pageTemplate.pageType}`,
        `Required sections: ${pageTemplate.requiredSections.join(", ")}`,
        pageTemplate.guidance
      ].join("\n");
```

Add `templateGuidance` into the worker prompt before asking for Markdown:

```ts
        "Page template guidance:",
        templateGuidance,
        "",
```

Keep the public tool name `build_wiki_page` unchanged.

- [ ] **Step 4: Run the targeted tool test**

Run:

```bash
npm run build && node --test dist/test/agent/tools.test.js --test-name-pattern "build_wiki_page includes source-kind-aware template guidance"
```

Expected: targeted test passes.

- [ ] **Step 5: Run broader wiki tool tests**

Run:

```bash
npm run build && node --test dist/test/agent/tools.test.js --test-name-pattern "wiki|build_wiki_page|search_paper_wiki"
```

Expected: matching tool tests pass.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/agent/wiki/tools.ts test/agent/tools.test.ts
git commit -m "feat: guide wiki page builds with evidence templates"
```

## Task 6: Full Verification and Documentation Review

**Files:**
- Review: `docs/superpowers/specs/2026-05-14-evidence-backed-design-wiki-design.md`
- Review: `docs/code-architecture.md`
- Review: changed source and test files from Tasks 1-5

- [ ] **Step 1: Run focused wiki tests**

Run:

```bash
npm run build && node --test \
  dist/test/agent/wiki-manifest-store.test.js \
  dist/test/agent/wiki-retrieval-contract.test.js \
  dist/test/agent/wiki-page-templates.test.js \
  dist/test/agent/wiki-maintenance.test.js
```

Expected: all listed test files pass.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: full repository test suite passes with zero failures.

- [ ] **Step 3: Check worktree diff**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only intended files changed; `git diff --check` exits 0.

- [ ] **Step 4: Update architecture docs only if needed**

If public behavior or file responsibilities changed enough that `docs/code-architecture.md` is stale, add a short wiki section update describing generalized source manifests and page templates. If the code change remains internal and the existing architecture doc still describes the schema-first core accurately, leave docs unchanged.

When editing docs, use:

```bash
git add docs/code-architecture.md
git commit -m "docs: describe evidence-backed wiki sources"
```

- [ ] **Step 5: Final commit if Task 6 changed docs**

If Task 6 made no code or doc changes, do not create an empty commit. If it did, commit only those files:

```bash
git status --short
git add docs/code-architecture.md
git commit -m "docs: update wiki source architecture"
```

## Self-Review

Spec coverage:

- Non-paper source kinds are covered by Tasks 1 and 2.
- Paper compatibility is covered by Task 1 normalization and Task 2 retrieval tests.
- Page templates for material datasets, software methods, findings, and design records are covered by Task 3.
- Deterministic lint for units, conditions, method sections, design-record grounding, and software-doc provenance is covered by Task 4.
- Existing tool enhancement without broad public tool sprawl is covered by Task 5.
- Full validation with `npm test` is covered by Task 6.

Implementation boundaries:

- Source manifest storage stays in `manifest-store.ts`.
- Evidence read shape stays in `retrieval-contract.ts`.
- Page template rules live in `page-templates.ts`.
- Lint diagnostics stay deterministic in `lint.ts`.
- Public tool names remain compatible in the first implementation.

Open implementation choices resolved for this plan:

- Keep compatibility wrappers and public tool names for one release.
- Use source-kind prefixes in fixture source keys.
- Store material parameter rows in Markdown tables first; structured JSON artifacts are represented through manifest `artifacts`.
- Keep software documentation freshness explicit through lint/health diagnostics, not background crawling.
