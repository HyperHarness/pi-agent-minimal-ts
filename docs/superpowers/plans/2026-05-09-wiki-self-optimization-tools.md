# Wiki Self-Optimization Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade wiki maintenance so the existing `wiki_lint`, `wiki_structure_plan`, `wiki_apply_structure_plan`, and `build_wiki_page` tools can diagnose, prioritize, plan, and safely apply wiki self-optimization without adding many public tools.

**Architecture:** Add one internal read-only maintenance helper module under `src/agent/wiki/maintenance.ts`, then expose its results through the existing wiki lint and structure-plan tools. Keep all writes inside existing write tools: `wiki_apply_structure_plan`, `build_wiki_page`, and `merge_wiki_aliases`.

**Tech Stack:** TypeScript, Node test runner, existing `@mariozechner/pi-ai` tool schemas, current wiki storage helpers under `src/agent/wiki/`.

---

## File Structure

- Create: `src/agent/wiki/maintenance.ts`
  - Read-only helper module for wiki document parsing, coverage mapping, concept ranking, evidence-contract audit, alias suggestions, and scope drift audit.
- Create: `test/agent/wiki-maintenance.test.ts`
  - Focused unit tests for read-only maintenance helpers.
- Modify: `src/agent/wiki/lint.ts`
  - Add issue kinds, option fields, report fields, and call maintenance helpers.
- Modify: `src/agent/wiki/structure-plan.ts`
  - Add goal/focus/budget options and enriched actions with owner, recommended args, and verification.
- Modify: `src/agent/wiki/structure-apply.ts`
  - Add low-risk support for alias creation, deterministic index rebuild, and scope-note section updates.
- Modify: `src/agent/wiki/content.ts`
  - Export or factor deterministic index rewrite so `structure-apply.ts` can call it without duplicating logic.
  - Add evidence-contract frontmatter support to `writePaperWikiPage`.
- Modify: `src/agent/wiki/types.ts`
  - Add `evidenceContract` to `PaperWikiPageInput`.
- Modify: `src/agent/wiki/tools.ts`
  - Extend schemas for `wiki_lint`, `wiki_structure_plan`, and `build_wiki_page`.
  - Pass new options into implementation functions.
- Modify: `src/agent/tool-types.ts`
  - Update type-only public tool result compatibility if needed. Do not add new public tool names.
- Modify: `src/agent/agent-prompts.ts`
  - Clarify that optimization should start with goal-aware `wiki_lint` and `wiki_structure_plan`.
- Modify: `README.md`
  - Update wiki maintenance tool descriptions.
- Modify: `test/agent/tools.test.ts`
  - Add tool schema/delegation coverage and `build_wiki_page` option behavior tests.
- Modify: `test/agent/tool-organization.test.ts`
  - Confirm no new public maintenance tools are exposed.
- Modify: `test/agent/wiki-domain-boundary.test.ts`
  - Export facade checks if `maintenance.ts` helpers are intentionally exported from `src/agent/wiki/index.ts`.

## Task 1: Add Read-Only Maintenance Helpers

**Files:**
- Create: `src/agent/wiki/maintenance.ts`
- Create: `test/agent/wiki-maintenance.test.ts`
- Optional modify: `src/agent/wiki/index.ts`

- [ ] **Step 1: Write failing tests for coverage, concept ranking, evidence contract, alias candidates, and scope drift**

Create `test/agent/wiki-maintenance.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  auditPageEvidenceContracts,
  auditScopeDrift,
  buildWikiCoverageMap,
  rankConceptGaps,
  suggestSemanticAliases
} from "../../src/agent/wiki/maintenance.js";

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pi-wiki-maintenance-"));
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

function sourceSummary(input: {
  paperKey: string;
  title: string;
  tags: string[];
  body: string;
  relatedPapers?: string[];
}): string {
  return `---
type: "paper-source-summary"
paper_key: "${input.paperKey}"
title: "${input.title}"
tags:
${input.tags.map((tag) => `  - "${tag}"`).join("\n")}
related_papers:
${(input.relatedPapers ?? []).map((paperKey) => `  - "${paperKey}"`).join("\n") || "  []"}
---

# ${input.title}

${input.body}

## Key Findings

- ${input.title} supports superconducting chip design evidence.

## Open Questions

- How should this evidence affect agentic EDA?
`;
}

function synthesisPage(input: {
  pageKey: string;
  title: string;
  sources?: Array<{ paperKey: string; title: string; path: string }>;
  body: string;
  type?: "wiki-synthesis-page" | "wiki-alias-page";
  canonicalPage?: string;
}): string {
  if (input.type === "wiki-alias-page") {
    return `---
type: "wiki-alias-page"
page_key: "${input.pageKey}"
title: "${input.title}"
canonical_page: "${input.canonicalPage}"
tags:
  - "alias"
related_pages:
  - "${input.canonicalPage}"
---

# ${input.title}

Alias page.
`;
  }

  return `---
type: "wiki-synthesis-page"
page_key: "${input.pageKey}"
title: "${input.title}"
tags: []
sources:
${(input.sources ?? []).map((source) => [
  `  - paper_key: "${source.paperKey}"`,
  `    title: "${source.title}"`,
  `    path: "${source.path}"`
].join("\n")).join("\n") || "  []"}
related_pages: []
---

# ${input.title}

${input.body}
`;
}

test("buildWikiCoverageMap reports covered sources, uncovered sources, weak pages, and tag clusters", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base/wiki/sources/paper-a.md"), sourceSummary({
      paperKey: "paper-a",
      title: "Tunable Coupler Evidence",
      tags: ["tunable-coupler", "qubit-calibration"],
      body: "Evidence about tunable couplers and calibration."
    }));
    await writeText(path.join(workspace, "knowledge-base/wiki/sources/paper-b.md"), sourceSummary({
      paperKey: "paper-b",
      title: "Fixed Frequency Transmon Evidence",
      tags: ["fixed-frequency-transmons", "qubit-calibration"],
      body: "Evidence about fixed-frequency transmons."
    }));
    await writeText(path.join(workspace, "knowledge-base/wiki/pages/qubit-calibration.md"), synthesisPage({
      pageKey: "qubit-calibration",
      title: "Qubit Calibration",
      sources: [{
        paperKey: "paper-a",
        title: "Tunable Coupler Evidence",
        path: "knowledge-base/wiki/sources/paper-a.md"
      }],
      body: "Calibration synthesis."
    }));

    const result = await buildWikiCoverageMap({ workspaceDir: workspace });

    assert.equal(result.sourceCount, 2);
    assert.equal(result.pageCount, 1);
    assert.equal(result.coveredSourceCount, 1);
    assert.deepEqual(result.uncoveredSources.map((source) => source.paperKey), ["paper-b"]);
    assert.ok(result.tagClusters.some((cluster) => cluster.tag === "qubit-calibration" && cluster.existingPageKey === "qubit-calibration"));
    assert.ok(result.weaklyCoveredPages.some((page) => page.pageKey === "qubit-calibration" && page.sourceCount === 1));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rankConceptGaps promotes goal-matching ready concepts before broad or existing concepts", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base/wiki/sources/paper-a.md"), sourceSummary({
      paperKey: "paper-a",
      title: "Tunable Coupler Evidence",
      tags: ["tunable-coupler", "neutral-atoms"],
      body: "Tunable coupler frequency planning for superconducting chip design."
    }));
    await writeText(path.join(workspace, "knowledge-base/wiki/sources/paper-b.md"), sourceSummary({
      paperKey: "paper-b",
      title: "Coupler Calibration Evidence",
      tags: ["tunable-coupler", "qubit-calibration"],
      body: "Coupler calibration evidence for superconducting EDA."
    }));
    await writeText(path.join(workspace, "knowledge-base/wiki/pages/qubit-calibration.md"), synthesisPage({
      pageKey: "qubit-calibration",
      title: "Qubit Calibration",
      sources: [{
        paperKey: "paper-b",
        title: "Coupler Calibration Evidence",
        path: "knowledge-base/wiki/sources/paper-b.md"
      }],
      body: "Existing calibration page."
    }));

    const result = await rankConceptGaps({
      workspaceDir: workspace,
      goal: "superconducting chip design frequency planning calibration EDA",
      focus: ["tunable coupler", "frequency planning"]
    });

    assert.equal(result.rankedConcepts[0]?.concept, "tunable-coupler");
    assert.equal(result.rankedConcepts[0]?.priority, "high");
    assert.equal(result.rankedConcepts[0]?.evidenceReadiness, "ready");
    assert.ok(result.rankedConcepts.some((concept) => concept.concept === "qubit-calibration" && concept.recommendedAction === "defer"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("auditPageEvidenceContracts distinguishes uncited synthesis pages from paper-backed pages", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base/wiki/pages/agentic-chip-design.md"), synthesisPage({
      pageKey: "agentic-chip-design",
      title: "Agentic Chip Design",
      body: "A long design-methodology page based on local tool observations and design records. ".repeat(20)
    }));
    await writeText(path.join(workspace, "knowledge-base/wiki/pages/tunable-coupler.md"), synthesisPage({
      pageKey: "tunable-coupler",
      title: "Tunable Coupler",
      sources: [{
        paperKey: "paper-a",
        title: "Tunable Coupler Evidence",
        path: "knowledge-base/wiki/sources/paper-a.md"
      }],
      body: "Paper-backed coupler synthesis."
    }));

    const result = await auditPageEvidenceContracts({ workspaceDir: workspace });

    assert.ok(result.evidenceContractGaps.some((gap) =>
      gap.pageKey === "agentic-chip-design" &&
      gap.inferredContract === "design-backed" &&
      gap.sourceCount === 0
    ));
    assert.ok(!result.evidenceContractGaps.some((gap) => gap.pageKey === "tunable-coupler"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("suggestSemanticAliases reports strong long-title near duplicates without writing files", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base/wiki/pages/agentic-quantum-eda-calibration-frequency-allocation-autonomous-discovery.md"), synthesisPage({
      pageKey: "agentic-quantum-eda-calibration-frequency-allocation-autonomous-discovery",
      title: "Agentic Quantum EDA Calibration and Frequency Allocation",
      sources: [{ paperKey: "paper-a", title: "EDA Evidence", path: "knowledge-base/wiki/sources/paper-a.md" }],
      body: "Agentic EDA page."
    }));
    await writeText(path.join(workspace, "knowledge-base/wiki/pages/autonomous-agent-quantum-eda-calibration-frequency-allocation-llm-chip-design.md"), synthesisPage({
      pageKey: "autonomous-agent-quantum-eda-calibration-frequency-allocation-llm-chip-design",
      title: "Autonomous Agent Quantum EDA Calibration Frequency Allocation and LLM Chip Design",
      sources: [{ paperKey: "paper-a", title: "EDA Evidence", path: "knowledge-base/wiki/sources/paper-a.md" }],
      body: "Overlapping agentic EDA page."
    }));

    const result = await suggestSemanticAliases({ workspaceDir: workspace, minScore: 0.45 });

    assert.equal(result.suggestions.length, 1);
    assert.match(result.suggestions[0]?.canonicalPageKey ?? "", /agentic|autonomous/);
    assert.match(result.suggestions[0]?.aliasPageKey ?? "", /agentic|autonomous/);
    assert.ok((result.suggestions[0]?.evidence.length ?? 0) >= 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("auditScopeDrift reports stale framing only in central page framing", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base/wiki/pages/agentic-chip-design.md"), synthesisPage({
      pageKey: "agentic-chip-design",
      title: "Million-Qubit Superconducting Systems",
      body: "Million-qubit framing is the central overview. The page should focus on chip-design infrastructure."
    }));
    await writeText(path.join(workspace, "knowledge-base/wiki/pages/history.md"), synthesisPage({
      pageKey: "history",
      title: "Superconducting Chip Design History",
      sources: [{ paperKey: "paper-a", title: "History Evidence", path: "knowledge-base/wiki/sources/paper-a.md" }],
      body: "Later work mentions million-qubit roadmaps as historical context in a lower section.\n\n## Background\n\nMillion-qubit systems are mentioned here."
    }));

    const result = await auditScopeDrift({
      workspaceDir: workspace,
      staleTerms: ["million-qubit"],
      preferredFraming: "superconducting quantum-chip design infrastructure"
    });

    assert.deepEqual(result.findings.map((finding) => finding.pageKey), ["agentic-chip-design"]);
    assert.equal(result.findings[0]?.kind, "scope_drift");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the new test and verify it fails because the module does not exist**

Run:

```bash
npm run build
node --test --experimental-test-isolation=none dist/test/agent/wiki-maintenance.test.js
```

Expected: build fails with `Cannot find module '../../src/agent/wiki/maintenance.js'` or TypeScript reports missing exported members.

- [ ] **Step 3: Implement `maintenance.ts` document parsing and coverage map**

Create `src/agent/wiki/maintenance.ts` with the shared types and these initial functions:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  listPaperWikiPageFiles,
  listPaperWikiSourceFiles,
  relativeToWorkspace,
  sanitizeWikiFilename
} from "./store.js";

export type WikiEvidenceContract = "paper-backed" | "design-backed" | "code-backed" | "mixed" | "unverified";
export type WikiMaintenancePriority = "high" | "medium" | "low";
export type WikiMaintenanceRisk = "low" | "medium";

export interface WikiMaintenanceSourceDocument {
  paperKey: string;
  title: string;
  path: string;
  tags: string[];
  relatedPaperKeys: string[];
  body: string;
}

export interface WikiMaintenancePageDocument {
  pageKey: string;
  title: string;
  path: string;
  isAlias: boolean;
  canonicalPageKey?: string;
  relatedPageKeys: string[];
  sourceCitations: Array<{ paperKey: string; title?: string; path: string }>;
  tags: string[];
  body: string;
  frontmatter: string;
}

export interface WikiCoverageMapResult {
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
}

export interface WikiMaintenanceOptions {
  workspaceDir: string;
  goal?: string;
  focus?: string[];
}

function extractFrontmatter(markdown: string): string {
  return markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
}

function bodyWithoutFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

function extractYamlStringValues(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) {
    const inline = lines.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
    if (!inline || inline === "[]") {
      return [];
    }
    if (inline.startsWith("[") && inline.endsWith("]")) {
      try {
        const parsed = JSON.parse(inline);
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
      } catch {
        return [];
      }
    }
    try {
      const parsed = JSON.parse(inline);
      return typeof parsed === "string" ? [parsed] : [];
    } catch {
      return [inline.replace(/^"|"$/g, "")];
    }
  }

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const value = line.match(/^\s*-\s+(.+)$/)?.[1]?.trim();
    if (!value || value === "[]") {
      continue;
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") {
        values.push(parsed);
      }
    } catch {
      values.push(value.replace(/^"|"$/g, ""));
    }
  }
  return values;
}

function extractFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const raw = frontmatter.split("\n").find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}

function extractTitle(markdown: string, fallback: string): string {
  const frontmatter = extractFrontmatter(markdown);
  return extractFrontmatterValue(frontmatter, "title") ??
    markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    fallback;
}

function isAlias(frontmatter: string): boolean {
  return extractFrontmatterValue(frontmatter, "type") === "wiki-alias-page" ||
    Boolean(extractFrontmatterValue(frontmatter, "canonical_page"));
}

function extractSourceCitations(frontmatter: string): Array<{ paperKey: string; title?: string; path: string }> {
  const lines = frontmatter.split("\n");
  const citations: Array<{ paperKey: string; title?: string; path: string }> = [];
  let current: Partial<{ paperKey: string; title: string; path: string }> | undefined;
  for (const line of lines) {
    const paperKey = line.match(/^\s*-\s+paper_key:\s+(.+)$/)?.[1]?.trim();
    if (paperKey) {
      if (current?.paperKey && current.path) {
        citations.push({ paperKey: current.paperKey, ...(current.title ? { title: current.title } : {}), path: current.path });
      }
      current = { paperKey: unquoteYaml(paperKey) };
      continue;
    }
    if (!current) {
      continue;
    }
    const title = line.match(/^\s+title:\s+(.+)$/)?.[1]?.trim();
    if (title) {
      current.title = unquoteYaml(title);
      continue;
    }
    const sourcePath = line.match(/^\s+path:\s+(.+)$/)?.[1]?.trim();
    if (sourcePath) {
      current.path = unquoteYaml(sourcePath);
    }
  }
  if (current?.paperKey && current.path) {
    citations.push({ paperKey: current.paperKey, ...(current.title ? { title: current.title } : {}), path: current.path });
  }
  return citations;
}

function unquoteYaml(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value.replace(/^"|"$/g, "");
  }
}

function normalizeText(value: string): string {
  return value.toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[_/]+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeText(value).split(" ").filter((token) => token.length >= 3));
}

function tokenOverlapScore(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

async function readSourceDocuments(workspaceDir: string): Promise<WikiMaintenanceSourceDocument[]> {
  const files = await listPaperWikiSourceFiles(workspaceDir);
  const documents: WikiMaintenanceSourceDocument[] = [];
  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8");
    const frontmatter = extractFrontmatter(markdown);
    const paperKey = path.basename(filePath, ".md");
    documents.push({
      paperKey,
      title: extractTitle(markdown, paperKey),
      path: relativeToWorkspace(workspaceDir, filePath),
      tags: extractYamlStringValues(frontmatter, "tags").map((tag) => sanitizeWikiFilename(tag.toLowerCase())),
      relatedPaperKeys: extractYamlStringValues(frontmatter, "related_papers"),
      body: bodyWithoutFrontmatter(markdown)
    });
  }
  return documents;
}

async function readPageDocuments(workspaceDir: string): Promise<WikiMaintenancePageDocument[]> {
  const files = await listPaperWikiPageFiles(workspaceDir);
  const documents: WikiMaintenancePageDocument[] = [];
  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8");
    const frontmatter = extractFrontmatter(markdown);
    const pageKey = path.basename(filePath, ".md");
    documents.push({
      pageKey,
      title: extractTitle(markdown, pageKey),
      path: relativeToWorkspace(workspaceDir, filePath),
      isAlias: isAlias(frontmatter),
      ...(extractFrontmatterValue(frontmatter, "canonical_page") ? { canonicalPageKey: extractFrontmatterValue(frontmatter, "canonical_page") } : {}),
      relatedPageKeys: extractYamlStringValues(frontmatter, "related_pages").map((value) => sanitizeWikiFilename(value.toLowerCase())),
      sourceCitations: extractSourceCitations(frontmatter),
      tags: extractYamlStringValues(frontmatter, "tags").map((tag) => sanitizeWikiFilename(tag.toLowerCase())),
      body: bodyWithoutFrontmatter(markdown),
      frontmatter
    });
  }
  return documents;
}

export async function readWikiMaintenanceDocuments(workspaceDir: string): Promise<{
  sources: WikiMaintenanceSourceDocument[];
  pages: WikiMaintenancePageDocument[];
}> {
  const [sources, pages] = await Promise.all([
    readSourceDocuments(workspaceDir),
    readPageDocuments(workspaceDir)
  ]);
  return { sources, pages };
}

export async function buildWikiCoverageMap(options: WikiMaintenanceOptions): Promise<WikiCoverageMapResult> {
  const { sources, pages } = await readWikiMaintenanceDocuments(options.workspaceDir);
  const pageKeys = new Set(pages.map((page) => page.pageKey));
  const citedPaperKeys = new Set(pages.flatMap((page) => page.sourceCitations.map((citation) => citation.paperKey)));
  const sourcesByTag = new Map<string, WikiMaintenanceSourceDocument[]>();
  for (const source of sources) {
    for (const tag of source.tags) {
      sourcesByTag.set(tag, [...(sourcesByTag.get(tag) ?? []), source]);
    }
  }

  const uncoveredSources = sources
    .filter((source) => !citedPaperKeys.has(source.paperKey))
    .map((source) => ({
      paperKey: source.paperKey,
      title: source.title,
      tags: source.tags,
      candidatePageKeys: source.tags.filter((tag) => pageKeys.has(tag)),
      reason: "Source summary is not cited by any synthesis page."
    }))
    .sort((left, right) => left.paperKey.localeCompare(right.paperKey));

  const weaklyCoveredPages = pages
    .filter((page) => !page.isAlias && page.sourceCitations.length > 0 && page.sourceCitations.length < 2)
    .map((page) => ({
      pageKey: page.pageKey,
      sourceCount: page.sourceCitations.length,
      reason: "Synthesis page has fewer than two source citations."
    }))
    .sort((left, right) => left.pageKey.localeCompare(right.pageKey));

  const tagClusters = [...sourcesByTag.entries()]
    .map(([tag, taggedSources]) => ({
      tag,
      sourceCount: taggedSources.length,
      ...(pageKeys.has(tag) ? { existingPageKey: tag } : {}),
      uncoveredSourceCount: taggedSources.filter((source) => !citedPaperKeys.has(source.paperKey)).length
    }))
    .sort((left, right) => right.sourceCount - left.sourceCount || left.tag.localeCompare(right.tag));

  return {
    sourceCount: sources.length,
    pageCount: pages.length,
    coveredSourceCount: citedPaperKeys.size,
    uncoveredSources,
    weaklyCoveredPages,
    tagClusters
  };
}
```

- [ ] **Step 4: Implement ranking, evidence contract, alias, and scope helpers**

Append these exports to `src/agent/wiki/maintenance.ts`:

```ts
export interface RankedConceptGap {
  concept: string;
  sourceCount: number;
  priority: WikiMaintenancePriority;
  score: number;
  evidenceReadiness: "ready" | "needs_summary" | "needs_acquisition";
  recommendedAction: "build_page" | "alias_to_existing" | "defer";
  candidateCanonicalPage?: string;
  representativeSources: Array<{ paperKey: string; title: string; path: string }>;
  rationale: string;
}

export interface ConceptGapTriageResult {
  rankedConcepts: RankedConceptGap[];
}

function goalText(options: { goal?: string; focus?: string[] }): string {
  return [options.goal, ...(options.focus ?? [])].filter(Boolean).join(" ");
}

function broadConceptPenalty(concept: string): number {
  return /\b(survey|review|experiment|simulation|quantum|physics|chemistry|materials?)\b/i.test(concept)
    ? 3
    : 0;
}

export async function rankConceptGaps(options: WikiMaintenanceOptions): Promise<ConceptGapTriageResult> {
  const { sources, pages } = await readWikiMaintenanceDocuments(options.workspaceDir);
  const pageKeys = new Set(pages.map((page) => page.pageKey));
  const goal = goalText(options);
  const sourcesByTag = new Map<string, WikiMaintenanceSourceDocument[]>();
  for (const source of sources) {
    for (const tag of source.tags) {
      sourcesByTag.set(tag, [...(sourcesByTag.get(tag) ?? []), source]);
    }
  }

  const rankedConcepts = [...sourcesByTag.entries()]
    .filter(([, taggedSources]) => taggedSources.length >= 2)
    .map(([concept, taggedSources]) => {
      const representativeText = taggedSources.map((source) => `${source.title} ${source.body}`).join(" ");
      const directPageExists = pageKeys.has(concept);
      const canonical = pages
        .filter((page) => !page.isAlias)
        .map((page) => ({
          page,
          score: Math.max(
            tokenOverlapScore(concept, page.pageKey),
            tokenOverlapScore(concept, page.title),
            tokenOverlapScore(concept, page.tags.join(" "))
          )
        }))
        .filter((candidate) => candidate.score >= 0.5)
        .sort((left, right) => right.score - left.score)[0];
      const goalScore = goal ? tokenOverlapScore(`${concept} ${representativeText}`, goal) * 10 : 0;
      const sourceScore = Math.min(taggedSources.length, 5) * 2;
      const existingPenalty = directPageExists ? 8 : 0;
      const aliasPenalty = canonical && canonical.page.pageKey !== concept ? -2 : 0;
      const broadPenalty = broadConceptPenalty(concept);
      const score = Number((sourceScore + goalScore - existingPenalty - broadPenalty - aliasPenalty).toFixed(2));
      const recommendedAction = directPageExists
        ? "defer"
        : canonical && canonical.page.pageKey !== concept
          ? "alias_to_existing"
          : broadPenalty > 0 && sourceScore < 6
            ? "defer"
            : "build_page";
      const priority: WikiMaintenancePriority = score >= 7 && recommendedAction !== "defer"
        ? "high"
        : score >= 4 && recommendedAction !== "defer"
          ? "medium"
          : "low";

      return {
        concept,
        sourceCount: taggedSources.length,
        priority,
        score,
        evidenceReadiness: "ready" as const,
        recommendedAction,
        ...(canonical && canonical.page.pageKey !== concept ? { candidateCanonicalPage: canonical.page.pageKey } : {}),
        representativeSources: taggedSources.slice(0, 3).map((source) => ({
          paperKey: source.paperKey,
          title: source.title,
          path: source.path
        })),
        rationale: directPageExists
          ? "A synthesis page already exists for this concept."
          : recommendedAction === "alias_to_existing"
            ? `Concept is close to existing page ${canonical?.page.pageKey}.`
            : `Score combines source count ${taggedSources.length} with goal/focus relevance.`
      };
    })
    .sort((left, right) => right.score - left.score || left.concept.localeCompare(right.concept));

  return { rankedConcepts };
}

export interface PageEvidenceContractAuditResult {
  evidenceContractGaps: Array<{
    pageKey: string;
    path: string;
    inferredContract: WikiEvidenceContract;
    sourceCount: number;
    reason: string;
  }>;
}

function inferEvidenceContract(page: WikiMaintenancePageDocument): WikiEvidenceContract {
  const text = `${page.title} ${page.body}`.toLowerCase();
  if (page.sourceCitations.length > 0) {
    return "paper-backed";
  }
  if (/design record|design-record|benchmark|tool|agent|workflow|infrastructure|methodology/.test(text)) {
    return "design-backed";
  }
  if (/code|implementation|script|test|repository|repo/.test(text)) {
    return "code-backed";
  }
  return "unverified";
}

export async function auditPageEvidenceContracts(options: WikiMaintenanceOptions): Promise<PageEvidenceContractAuditResult> {
  const { pages } = await readWikiMaintenanceDocuments(options.workspaceDir);
  return {
    evidenceContractGaps: pages
      .filter((page) => !page.isAlias)
      .map((page) => ({
        page,
        inferredContract: inferEvidenceContract(page)
      }))
      .filter(({ page, inferredContract }) => page.sourceCitations.length === 0 || inferredContract === "unverified")
      .map(({ page, inferredContract }) => ({
        pageKey: page.pageKey,
        path: page.path,
        inferredContract,
        sourceCount: page.sourceCitations.length,
        reason: page.sourceCitations.length === 0
          ? `Synthesis page has no paper source citations; inferred contract is ${inferredContract}.`
          : "Synthesis page evidence contract is unclear."
      }))
      .sort((left, right) => left.pageKey.localeCompare(right.pageKey))
  };
}

export interface SemanticAliasSuggestionResult {
  suggestions: Array<{
    canonicalPageKey: string;
    aliasPageKey: string;
    score: number;
    risk: WikiMaintenanceRisk;
    evidence: string[];
  }>;
}

export async function suggestSemanticAliases(options: WikiMaintenanceOptions & { minScore?: number }): Promise<SemanticAliasSuggestionResult> {
  const { pages } = await readWikiMaintenanceDocuments(options.workspaceDir);
  const minScore = options.minScore ?? 0.55;
  const synthesisPages = pages.filter((page) => !page.isAlias);
  const suggestions: SemanticAliasSuggestionResult["suggestions"] = [];
  for (let index = 0; index < synthesisPages.length; index += 1) {
    for (const other of synthesisPages.slice(index + 1)) {
      const left = synthesisPages[index];
      if (!left) {
        continue;
      }
      const titleScore = tokenOverlapScore(left.title, other.title);
      const keyScore = tokenOverlapScore(left.pageKey, other.pageKey);
      const leftSources = new Set(left.sourceCitations.map((citation) => citation.paperKey));
      const sourceOverlap = other.sourceCitations.filter((citation) => leftSources.has(citation.paperKey)).length;
      const sourceScore = sourceOverlap > 0 ? 0.2 : 0;
      const score = Number((Math.max(titleScore, keyScore) + sourceScore).toFixed(2));
      if (score < minScore) {
        continue;
      }
      const canonical = left.sourceCitations.length >= other.sourceCitations.length ? left : other;
      const alias = canonical === left ? other : left;
      suggestions.push({
        canonicalPageKey: canonical.pageKey,
        aliasPageKey: alias.pageKey,
        score,
        risk: score >= 0.8 ? "low" : "medium",
        evidence: [
          `title/key similarity score ${score}`,
          `shared source citations ${sourceOverlap}`,
          `candidate pages ${left.pageKey} and ${other.pageKey}`
        ]
      });
    }
  }
  return {
    suggestions: suggestions.sort((left, right) => right.score - left.score || left.aliasPageKey.localeCompare(right.aliasPageKey))
  };
}

export interface ScopeDriftAuditResult {
  findings: Array<{
    pageKey: string;
    path: string;
    kind: "scope_drift";
    severity: WikiMaintenancePriority;
    evidence: string[];
    suggestedScopeNote: string;
  }>;
}

function centralFramingText(page: WikiMaintenancePageDocument): string {
  const firstHeading = page.body.match(/^#\s+(.+)$/m)?.[1] ?? "";
  const firstParagraph = page.body.replace(/^#.*$/m, "").split(/\n\s*\n/).find((block) => block.trim() && !block.trim().startsWith("##")) ?? "";
  const scopeSection = page.body.match(/^##\s+Scope Note\s*\n([\s\S]*?)(?:\n##\s+|\s*$)/m)?.[1] ?? "";
  return `${page.title}\n${firstHeading}\n${firstParagraph}\n${scopeSection}`;
}

export async function auditScopeDrift(options: WikiMaintenanceOptions & {
  staleTerms?: string[];
  preferredFraming?: string;
}): Promise<ScopeDriftAuditResult> {
  const staleTerms = options.staleTerms ?? ["million-qubit", "millions of qubits"];
  const preferredFraming = options.preferredFraming ?? options.goal ?? "the current research focus";
  const { pages } = await readWikiMaintenanceDocuments(options.workspaceDir);
  return {
    findings: pages
      .filter((page) => !page.isAlias)
      .flatMap((page) => {
        const central = centralFramingText(page).toLowerCase();
        const matched = staleTerms.filter((term) => central.includes(term.toLowerCase()));
        return matched.length === 0
          ? []
          : [{
              pageKey: page.pageKey,
              path: page.path,
              kind: "scope_drift" as const,
              severity: "medium" as const,
              evidence: matched.map((term) => `Central framing contains "${term}".`),
              suggestedScopeNote: `This page should frame the topic around ${preferredFraming}; older million-qubit language should be treated as background context unless the page is explicitly about scaling roadmaps.`
            }];
      })
      .sort((left, right) => left.pageKey.localeCompare(right.pageKey))
  };
}
```

- [ ] **Step 5: Run focused maintenance tests**

Run:

```bash
npm run build
node --test --experimental-test-isolation=none dist/test/agent/wiki-maintenance.test.js
```

Expected: all tests in `wiki-maintenance.test.js` pass.

- [ ] **Step 6: Commit Task 1**

```bash
rtk git add src/agent/wiki/maintenance.ts test/agent/wiki-maintenance.test.ts
rtk git commit -m "feat: add wiki maintenance analysis helpers"
```

## Task 2: Extend `wiki_lint` With Reports And New Issue Kinds

**Files:**
- Modify: `src/agent/wiki/lint.ts`
- Modify: `src/agent/wiki/tools.ts`
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Write failing tests for `wiki_lint` option passthrough and rich results**

Append to `test/agent/tools.test.ts` near existing `wiki_lint` delegation tests:

```ts
test("wiki_lint passes goal and report options into the injected lint dependency", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: unknown[] = [];

  try {
    const tool = getWikiLintTool(workspace, {
      lintPaperWiki: async (options) => {
        capturedCalls.push(options);
        return {
          pageCount: 1,
          sourceCount: 2,
          issueCount: 1,
          summary: {
            stale_index: 0,
            broken_wiki_link: 0,
            missing_source_citation: 0,
            orphan_page: 0,
            concept_gap: 0,
            high_value_concept_gap: 1,
            evidence_contract_gap: 0,
            semantic_alias_candidate: 0,
            scope_drift: 0,
            duplicate_page_title: 0,
            near_duplicate_page: 0,
            duplicate_section: 0,
            weak_synthesis_page: 0,
            rendered_wiki_link: 0,
          },
          issues: [{
            kind: "high_value_concept_gap",
            severity: "medium",
            concept: "tunable-coupler",
            count: 2,
            score: 9,
            reason: "Concept is relevant to the focus goal.",
          }],
          actions: ["1: Promote high-value repeated source tags with build_wiki_page."],
          reports: {
            conceptTriage: {
              rankedConcepts: [{
                concept: "tunable-coupler",
                sourceCount: 2,
                priority: "high",
                score: 9,
                evidenceReadiness: "ready",
                recommendedAction: "build_page",
                representativeSources: [],
                rationale: "Goal match.",
              }],
            },
          },
        };
      },
    });

    const result = await tool.execute("wiki-lint-call", {
      maxItems: 5,
      goal: "superconducting chip design",
      focus: ["tunable coupler"],
      includeCoverage: true,
      includeQualityAudit: true,
      includeAliasCandidates: true,
    }, undefined);

    assert.deepEqual(capturedCalls, [{
      workspaceDir: workspace,
      maxItems: 5,
      goal: "superconducting chip design",
      focus: ["tunable coupler"],
      includeCoverage: true,
      includeQualityAudit: true,
      includeAliasCandidates: true,
    }]);
    assert.equal((result.details as { reports?: unknown }).reports !== undefined, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

Add a direct lint fixture test to `test/agent/wiki-maintenance.test.ts`:

```ts
test("lintPaperWiki emits high value concept gaps and optional reports", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base/wiki/sources/paper-a.md"), sourceSummary({
      paperKey: "paper-a",
      title: "Tunable Coupler Evidence",
      tags: ["tunable-coupler"],
      body: "Tunable coupler evidence for superconducting chip design."
    }));
    await writeText(path.join(workspace, "knowledge-base/wiki/sources/paper-b.md"), sourceSummary({
      paperKey: "paper-b",
      title: "Coupler Calibration Evidence",
      tags: ["tunable-coupler"],
      body: "Tunable coupler calibration evidence."
    }));

    const { lintPaperWiki } = await import("../../src/agent/wiki/lint.js");
    const result = await lintPaperWiki({
      workspaceDir: workspace,
      goal: "superconducting chip design",
      focus: ["tunable coupler"],
      includeCoverage: true,
      maxItems: 20
    });

    assert.equal(result.summary.high_value_concept_gap, 1);
    assert.ok(result.issues.some((issue) => issue.kind === "high_value_concept_gap" && issue.concept === "tunable-coupler"));
    assert.equal(result.reports?.coverage?.sourceCount, 2);
    assert.equal(result.reports?.conceptTriage?.rankedConcepts[0]?.concept, "tunable-coupler");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run:

```bash
npm run build
node --test --experimental-test-isolation=none dist/test/agent/wiki-maintenance.test.js dist/test/agent/tools.test.js
```

Expected: TypeScript fails because `PaperWikiLintOptions` and the tool schema do not yet include the new option fields.

- [ ] **Step 3: Extend lint types and invoke maintenance helpers**

Modify `src/agent/wiki/lint.ts`:

```ts
import {
  auditPageEvidenceContracts,
  auditScopeDrift,
  buildWikiCoverageMap,
  rankConceptGaps,
  suggestSemanticAliases,
  type ConceptGapTriageResult,
  type PageEvidenceContractAuditResult,
  type ScopeDriftAuditResult,
  type SemanticAliasSuggestionResult,
  type WikiCoverageMapResult
} from "./maintenance.js";

export type PaperWikiLintIssueKind =
  | "stale_index"
  | "broken_wiki_link"
  | "missing_source_citation"
  | "orphan_page"
  | "concept_gap"
  | "high_value_concept_gap"
  | "evidence_contract_gap"
  | "semantic_alias_candidate"
  | "scope_drift"
  | "duplicate_page_title"
  | "near_duplicate_page"
  | "duplicate_section"
  | "weak_synthesis_page"
  | "rendered_wiki_link";

export interface PaperWikiLintIssue {
  kind: PaperWikiLintIssueKind;
  severity: PaperWikiLintSeverity;
  path?: string;
  target?: string;
  concept?: string;
  count?: number;
  score?: number;
  reason: string;
}

export interface PaperWikiLintOptions {
  workspaceDir: string;
  maxItems?: number;
  goal?: string;
  focus?: string[];
  includeCoverage?: boolean;
  includeQualityAudit?: boolean;
  includeAliasCandidates?: boolean;
}

export interface PaperWikiLintReports {
  coverage?: WikiCoverageMapResult;
  conceptTriage?: ConceptGapTriageResult;
  pageQuality?: PageEvidenceContractAuditResult;
  aliasCandidates?: SemanticAliasSuggestionResult;
  scopeDrift?: ScopeDriftAuditResult;
}

export interface PaperWikiLintResult {
  pageCount: number;
  sourceCount: number;
  issueCount: number;
  summary: Record<PaperWikiLintIssueKind, number>;
  issues: PaperWikiLintIssue[];
  actions: string[];
  reports?: PaperWikiLintReports;
}
```

Add the new issue kinds to `ISSUE_KINDS` and `summarizeActions`.

Near the end of `lintPaperWiki`, before summary construction, call:

```ts
  const reports: PaperWikiLintReports = {};
  const conceptTriage = await rankConceptGaps({
    workspaceDir,
    ...(options.goal ? { goal: options.goal } : {}),
    ...(options.focus ? { focus: options.focus } : {})
  });
  reports.conceptTriage = conceptTriage;

  // Keep default structural lint compatible with wiki_structure_plan. Only promote
  // goal-aware concept triage into issues when the caller supplied optimization intent.
  if (options.goal || options.focus?.length) {
    for (const concept of conceptTriage.rankedConcepts.filter((item) => item.priority === "high" && item.recommendedAction === "build_page")) {
      issues.push({
        kind: "high_value_concept_gap",
        severity: "medium",
        concept: concept.concept,
        count: concept.sourceCount,
        score: concept.score,
        target: path.join(relativeToWorkspace(workspaceDir, getPaperWikiPagesDir(workspaceDir)), `${concept.concept}.md`),
        reason: concept.rationale
      });
    }
  }

  if (options.includeCoverage) {
    reports.coverage = await buildWikiCoverageMap({ workspaceDir });
  }
  if (options.includeQualityAudit) {
    reports.pageQuality = await auditPageEvidenceContracts({ workspaceDir });
    for (const gap of reports.pageQuality.evidenceContractGaps) {
      issues.push({
        kind: "evidence_contract_gap",
        severity: gap.inferredContract === "unverified" ? "medium" : "low",
        path: gap.path,
        reason: gap.reason
      });
    }
    const scopeDrift = await auditScopeDrift({
      workspaceDir,
      ...(options.goal ? { preferredFraming: options.goal } : {})
    });
    reports.scopeDrift = scopeDrift;
    for (const finding of scopeDrift.findings) {
      issues.push({
        kind: "scope_drift",
        severity: finding.severity,
        path: finding.path,
        reason: finding.evidence.join(" ")
      });
    }
  }
  if (options.includeAliasCandidates) {
    reports.aliasCandidates = await suggestSemanticAliases({ workspaceDir });
    for (const suggestion of reports.aliasCandidates.suggestions) {
      issues.push({
        kind: "semantic_alias_candidate",
        severity: suggestion.risk === "low" ? "low" : "medium",
        path: `knowledge-base/wiki/pages/${suggestion.aliasPageKey}.md`,
        target: suggestion.canonicalPageKey,
        score: suggestion.score,
        reason: suggestion.evidence.join(" ")
      });
    }
  }
```

Return `reports` only when it has keys:

```ts
  const finalReports = Object.keys(reports).length > 0 ? reports : undefined;
  return {
    pageCount: pageFiles.length,
    sourceCount: sourceFiles.length,
    issueCount: issues.length,
    summary,
    issues: sortedIssues.slice(0, maxItems),
    actions: summarizeActions(issues),
    ...(finalReports ? { reports: finalReports } : {})
  };
```

- [ ] **Step 4: Extend `wiki_lint` tool schema**

Modify `src/agent/wiki/tools.ts`:

```ts
const wikiLintParameters = Type.Object({
  maxItems: Type.Optional(Type.Integer({ description: "Maximum wiki structure issues to return.", minimum: 1 })),
  goal: Type.Optional(Type.String({
    description: "Optional research or maintenance goal used to prioritize concept gaps."
  })),
  focus: Type.Optional(Type.Array(Type.String({
    description: "Optional focus keyword or concept phrase for goal-aware wiki diagnostics."
  }))),
  includeCoverage: Type.Optional(Type.Boolean({
    description: "Include source-to-page coverage reports. Defaults to false."
  })),
  includeQualityAudit: Type.Optional(Type.Boolean({
    description: "Include page evidence-contract and scope-framing audit reports. Defaults to false."
  })),
  includeAliasCandidates: Type.Optional(Type.Boolean({
    description: "Include semantic alias candidate reports. Defaults to false."
  }))
});
```

Pass the fields into `lintPaperWikiImpl`:

```ts
      const result = await lintPaperWikiImpl({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.focus !== undefined ? { focus: args.focus } : {}),
        ...(args.includeCoverage !== undefined ? { includeCoverage: args.includeCoverage } : {}),
        ...(args.includeQualityAudit !== undefined ? { includeQualityAudit: args.includeQualityAudit } : {}),
        ...(args.includeAliasCandidates !== undefined ? { includeAliasCandidates: args.includeAliasCandidates } : {})
      });
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npm run build
node --test --experimental-test-isolation=none dist/test/agent/wiki-maintenance.test.js dist/test/agent/tools.test.js
```

Expected: relevant tests pass. Existing tests that compare exact `summary` objects may fail because new issue kinds are present.

- [ ] **Step 6: Update exact summary assertions**

Where tests compare lint summary exactly, add the new zero fields:

```ts
high_value_concept_gap: 0,
evidence_contract_gap: 0,
semantic_alias_candidate: 0,
scope_drift: 0,
```

Use `rg -n "concept_gap: 0|concept_gap: 1" test/agent` to find all exact summary fixtures.

- [ ] **Step 7: Run focused tests again**

Run:

```bash
npm run build
node --test --experimental-test-isolation=none dist/test/agent/wiki-maintenance.test.js dist/test/agent/tools.test.js dist/test/agent/paper-reader.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 8: Commit Task 2**

```bash
rtk git add src/agent/wiki/lint.ts src/agent/wiki/tools.ts test/agent/tools.test.ts test/agent/wiki-maintenance.test.ts
rtk git commit -m "feat: enrich wiki lint diagnostics"
```

## Task 3: Upgrade `wiki_structure_plan` Into A Goal-Aware Planner

**Files:**
- Modify: `src/agent/wiki/structure-plan.ts`
- Modify: `src/agent/wiki/tools.ts`
- Modify: `test/agent/tools.test.ts`
- Modify: `test/agent/wiki-maintenance.test.ts`

- [ ] **Step 1: Add failing planner tests**

Append to `test/agent/wiki-maintenance.test.ts`:

```ts
test("planWikiStructure emits budgeted tool-call-shaped growth and verification actions", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base/wiki/sources/paper-a.md"), sourceSummary({
      paperKey: "paper-a",
      title: "Tunable Coupler Evidence",
      tags: ["tunable-coupler"],
      body: "Tunable coupler evidence for superconducting chip design."
    }));
    await writeText(path.join(workspace, "knowledge-base/wiki/sources/paper-b.md"), sourceSummary({
      paperKey: "paper-b",
      title: "Coupler Calibration Evidence",
      tags: ["tunable-coupler"],
      body: "Tunable coupler calibration evidence."
    }));

    const { planWikiStructure } = await import("../../src/agent/wiki/structure-plan.js");
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
    assert.equal(promote?.recommendedTool, "build_wiki_page");
    assert.deepEqual(promote?.recommendedArgs, {
      topic: "tunable-coupler",
      pageKey: "tunable-coupler",
      mode: "draft",
      maxLocalResults: 8
    });
    assert.ok(result.actions.some((action) => action.type === "verify" && action.recommendedTool === "wiki_lint"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

Append to `test/agent/tools.test.ts` near `wiki_structure_plan` delegation:

```ts
test("wiki_structure_plan passes goal, focus, growth, and budget options", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const capturedCalls: unknown[] = [];

  try {
    const tool = getWikiStructurePlanTool(workspace, {
      planWikiStructure: async (options) => {
        capturedCalls.push(options);
        return {
          status: "planned",
          lintSummary: {
            stale_index: 0,
            broken_wiki_link: 0,
            missing_source_citation: 0,
            orphan_page: 0,
            concept_gap: 0,
            high_value_concept_gap: 0,
            evidence_contract_gap: 0,
            semantic_alias_candidate: 0,
            scope_drift: 0,
            duplicate_page_title: 0,
            near_duplicate_page: 0,
            duplicate_section: 0,
            weak_synthesis_page: 0,
            rendered_wiki_link: 0,
          },
          actionCount: 0,
          actions: [],
          warnings: [],
        };
      },
    });

    await tool.execute("wiki-structure-plan-call", {
      maxItems: 5,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "superconducting chip design",
      focus: ["tunable coupler"],
      budget: { maxPagesToBuild: 1, maxAliasesToCreate: 2, maxScopeNotes: 1 },
    }, undefined);

    assert.deepEqual(capturedCalls, [{
      workspaceDir: workspace,
      maxItems: 5,
      includeMediumRisk: true,
      includeGrowthActions: true,
      goal: "superconducting chip design",
      focus: ["tunable coupler"],
      budget: { maxPagesToBuild: 1, maxAliasesToCreate: 2, maxScopeNotes: 1 },
    }]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run:

```bash
npm run build
node --test --experimental-test-isolation=none dist/test/agent/wiki-maintenance.test.js dist/test/agent/tools.test.js
```

Expected: TypeScript fails because planner options and action fields do not exist.

- [ ] **Step 3: Extend planner types and action construction**

Modify `src/agent/wiki/structure-plan.ts`:

```ts
export type WikiStructureActionType =
  | "merge_duplicate_pages"
  | "create_alias"
  | "fix_duplicate_section"
  | "fix_rendered_wiki_link"
  | "rebuild_weak_page"
  | "promote_concept"
  | "update_scope_note"
  | "rebuild_index"
  | "verify";

export type WikiStructureOwner = "wiki-agent" | "paper-download-subagent" | "wiki-evidence-worker";
export type WikiStructureRecommendedTool =
  | "merge_wiki_aliases"
  | "build_wiki_page"
  | "replace_file_text"
  | "wiki_apply_structure_plan"
  | "wiki_lint"
  | "wiki_health"
  | "wiki_health_fix";

export interface WikiStructurePlanVerification {
  tool: "wiki_lint" | "wiki_health" | "search_paper_wiki" | "answer_paper_wiki_question";
  args: unknown;
  expected: string;
}

export interface WikiStructurePlanAction {
  id: string;
  type: WikiStructureActionType;
  priority: WikiStructurePriority;
  risk: WikiStructureRisk;
  issueKind: PaperWikiLintIssue["kind"];
  owner: WikiStructureOwner;
  path?: string;
  target?: string;
  concept?: string;
  reason: string;
  recommendedTool?: WikiStructureRecommendedTool;
  recommendedArgs?: unknown;
  verification?: WikiStructurePlanVerification[];
}

export interface WikiStructurePlanBudget {
  maxPagesToBuild?: number;
  maxAliasesToCreate?: number;
  maxScopeNotes?: number;
}

export interface WikiStructurePlanOptions {
  workspaceDir: string;
  maxItems?: number;
  includeMediumRisk?: boolean;
  goal?: string;
  focus?: string[];
  includeGrowthActions?: boolean;
  budget?: WikiStructurePlanBudget;
}
```

Update every existing action to include `owner: "wiki-agent"`.

For `concept_gap` and `high_value_concept_gap`, create:

```ts
      recommendedArgs: {
        topic: issue.concept,
        pageKey: issue.concept,
        mode: "draft",
        maxLocalResults: 8
      },
      verification: [{
        tool: "wiki_lint",
        args: {
          maxItems: 50,
          ...(options.goal ? { goal: options.goal } : {}),
          ...(options.focus ? { focus: options.focus } : {}),
          includeCoverage: true
        },
        expected: `Concept gap for ${issue.concept} should be reduced after page promotion.`
      }]
```

Task 5 adds `minSources`, `forbidExternalEvidence`, and `verifyAfterWrite` to
`build_wiki_page`; Task 3 should recommend only arguments supported by the
current tool schema.

Add budget filtering after actions are created:

```ts
function applyBudget(actions: WikiStructurePlanAction[], budget: Required<WikiStructurePlanBudget>): WikiStructurePlanAction[] {
  let pages = 0;
  let aliases = 0;
  let scopes = 0;
  return actions.filter((action) => {
    if (action.type === "promote_concept") {
      pages += 1;
      return pages <= budget.maxPagesToBuild;
    }
    if (action.type === "create_alias") {
      aliases += 1;
      return aliases <= budget.maxAliasesToCreate;
    }
    if (action.type === "update_scope_note") {
      scopes += 1;
      return scopes <= budget.maxScopeNotes;
    }
    return true;
  });
}
```

In `planWikiStructure`, call `lintPaperWiki` with the goal-aware options:

```ts
  const lint = await lintPaperWiki({
    workspaceDir: options.workspaceDir,
    maxItems,
    ...(options.goal ? { goal: options.goal } : {}),
    ...(options.focus ? { focus: options.focus } : {}),
    includeCoverage: options.includeGrowthActions ?? false,
    includeQualityAudit: options.includeGrowthActions ?? false,
    includeAliasCandidates: options.includeGrowthActions ?? false
  });
```

Append a verification action when any write-capable action exists:

```ts
  if (actions.some((action) => action.recommendedTool && action.recommendedTool !== "wiki_lint" && action.recommendedTool !== "wiki_health")) {
    actions.push({
      id: `wiki-structure-${String(actions.length + 1).padStart(3, "0")}`,
      type: "verify",
      priority: "high",
      risk: "low",
      issueKind: "stale_index",
      owner: "wiki-agent",
      reason: "Verify wiki structure after applying approved maintenance actions.",
      recommendedTool: "wiki_lint",
      recommendedArgs: {
        maxItems: 100,
        ...(options.goal ? { goal: options.goal } : {}),
        ...(options.focus ? { focus: options.focus } : {}),
        includeCoverage: true,
        includeQualityAudit: true,
        includeAliasCandidates: true
      }
    });
  }
```

- [ ] **Step 4: Extend `wiki_structure_plan` tool schema**

Modify `src/agent/wiki/tools.ts`:

```ts
const wikiStructurePlanParameters = Type.Object({
  maxItems: Type.Optional(Type.Integer({ description: "Maximum planned structure actions to return.", minimum: 1 })),
  includeMediumRisk: Type.Optional(Type.Boolean({
    description: "Include medium-risk actions such as page merges, page promotion drafts, and rebuild recommendations. Defaults to false."
  })),
  goal: Type.Optional(Type.String({
    description: "Optional research or maintenance goal used to prioritize growth actions."
  })),
  focus: Type.Optional(Type.Array(Type.String({
    description: "Optional focus keyword or concept phrase for goal-aware planning."
  }))),
  includeGrowthActions: Type.Optional(Type.Boolean({
    description: "Include goal-aware concept promotion, alias, and scope-note plan actions. Defaults to false."
  })),
  budget: Type.Optional(Type.Object({
    maxPagesToBuild: Type.Optional(Type.Integer({ minimum: 0 })),
    maxAliasesToCreate: Type.Optional(Type.Integer({ minimum: 0 })),
    maxScopeNotes: Type.Optional(Type.Integer({ minimum: 0 }))
  }))
});
```

Pass the new fields into `planWikiStructureImpl`.

- [ ] **Step 5: Run planner tests**

Run:

```bash
npm run build
node --test --experimental-test-isolation=none dist/test/agent/wiki-maintenance.test.js dist/test/agent/tools.test.js
```

Expected: targeted tests pass after updating existing planner fixtures to include `owner`.

- [ ] **Step 6: Commit Task 3**

```bash
rtk git add src/agent/wiki/structure-plan.ts src/agent/wiki/tools.ts test/agent/tools.test.ts test/agent/wiki-maintenance.test.ts
rtk git commit -m "feat: prioritize wiki structure plans"
```

## Task 4: Extend Safe Structure Apply Actions

**Files:**
- Modify: `src/agent/wiki/content.ts`
- Modify: `src/agent/wiki/structure-apply.ts`
- Modify: `test/agent/wiki-maintenance.test.ts`

- [ ] **Step 1: Add failing apply tests**

Append to `test/agent/wiki-maintenance.test.ts`:

```ts
test("applyWikiStructurePlan dry-runs safe alias and scope note actions", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base/wiki/pages/tunable-coupler.md"), synthesisPage({
      pageKey: "tunable-coupler",
      title: "Tunable Coupler",
      sources: [{ paperKey: "paper-a", title: "Evidence", path: "knowledge-base/wiki/sources/paper-a.md" }],
      body: "Coupler page."
    }));
    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    const result = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: true,
      actions: [
        {
          id: "wiki-structure-001",
          type: "create_alias",
          priority: "medium",
          risk: "low",
          issueKind: "semantic_alias_candidate",
          owner: "wiki-agent",
          path: "knowledge-base/wiki/pages/tunable-couplers.md",
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
          path: "knowledge-base/wiki/pages/tunable-coupler.md",
          reason: "Add scope note.",
          recommendedTool: "wiki_apply_structure_plan",
          recommendedArgs: {
            pagePath: "knowledge-base/wiki/pages/tunable-coupler.md",
            scopeNote: "This page focuses on tunable couplers for superconducting chip design."
          }
        }
      ]
    });

    assert.equal(result.status, "dry_run");
    assert.equal(result.applied.length, 2);
    assert.equal(result.changedFiles.length, 0);
    await assert.rejects(readFile(path.join(workspace, "knowledge-base/wiki/pages/tunable-couplers.md"), "utf8"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("applyWikiStructurePlan writes safe alias and scope note actions", async () => {
  const workspace = await createWorkspace();
  try {
    await writeText(path.join(workspace, "knowledge-base/wiki/pages/tunable-coupler.md"), synthesisPage({
      pageKey: "tunable-coupler",
      title: "Tunable Coupler",
      sources: [{ paperKey: "paper-a", title: "Evidence", path: "knowledge-base/wiki/sources/paper-a.md" }],
      body: "Coupler page."
    }));
    const { applyWikiStructurePlan } = await import("../../src/agent/wiki/structure-apply.js");
    const result = await applyWikiStructurePlan({
      workspaceDir: workspace,
      dryRun: false,
      actions: [
        {
          id: "wiki-structure-001",
          type: "create_alias",
          priority: "medium",
          risk: "low",
          issueKind: "semantic_alias_candidate",
          owner: "wiki-agent",
          path: "knowledge-base/wiki/pages/tunable-couplers.md",
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
          path: "knowledge-base/wiki/pages/tunable-coupler.md",
          reason: "Add scope note.",
          recommendedTool: "wiki_apply_structure_plan",
          recommendedArgs: {
            pagePath: "knowledge-base/wiki/pages/tunable-coupler.md",
            scopeNote: "This page focuses on tunable couplers for superconducting chip design."
          }
        }
      ]
    });

    assert.equal(result.status, "applied");
    assert.ok(result.changedFiles.includes("knowledge-base/wiki/pages/tunable-couplers.md"));
    assert.ok(result.changedFiles.includes("knowledge-base/wiki/pages/tunable-coupler.md"));
    const alias = await readFile(path.join(workspace, "knowledge-base/wiki/pages/tunable-couplers.md"), "utf8");
    assert.match(alias, /canonical_page: "tunable-coupler"/);
    const canonical = await readFile(path.join(workspace, "knowledge-base/wiki/pages/tunable-coupler.md"), "utf8");
    assert.match(canonical, /## Scope Note/);
    assert.match(canonical, /superconducting chip design/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Export deterministic index rewrite**

Modify `src/agent/wiki/content.ts`:

```ts
export async function rewritePaperWikiIndex(workspaceDir: string): Promise<void> {
  await rewriteWikiIndex(workspaceDir);
}
```

Keep existing calls to private `rewriteWikiIndex` unchanged.

- [ ] **Step 3: Implement safe apply helpers**

Modify `src/agent/wiki/structure-apply.ts` imports:

```ts
import { mergePaperWikiAliases, rewritePaperWikiIndex } from "./content.js";
import { getPaperWikiIndexPath, relativeToWorkspace } from "./store.js";
```

Add helper functions:

```ts
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

async function applyAliasAction(input: {
  workspaceDir: string;
  action: WikiStructurePlanAction;
  dryRun: boolean;
}): Promise<AppliedWikiStructureAction | SkippedWikiStructureAction> {
  const args = asRecord(input.action.recommendedArgs);
  const aliases = args?.aliases;
  if (!Array.isArray(aliases)) {
    return { action: input.action, reason: "Alias action is missing recommendedArgs.aliases." };
  }
  if (input.dryRun) {
    return {
      action: input.action,
      changedFiles: aliases
        .map((alias) => asRecord(alias)?.alias)
        .filter((alias): alias is string => typeof alias === "string")
        .map((alias) => `knowledge-base/wiki/pages/${alias}.md`),
      message: "Would create safe wiki alias mappings."
    };
  }
  const result = await mergePaperWikiAliases({
    workspaceDir: input.workspaceDir,
    aliases: aliases as Parameters<typeof mergePaperWikiAliases>[0]["aliases"],
    replaceExisting: false
  });
  const changedFiles = result.aliases
    .filter((alias) => alias.status === "written")
    .map((alias) => alias.pagePath);
  return changedFiles.length > 0
    ? { action: input.action, changedFiles, message: `Wrote ${changedFiles.length} wiki alias page(s).` }
    : { action: input.action, reason: result.aliases.map((alias) => alias.reason).filter(Boolean).join("; ") || "No alias pages were written." };
}

function replaceOrAppendScopeNote(markdown: string, scopeNote: string): string {
  const section = `## Scope Note\n\n${scopeNote.trim()}\n`;
  const existing = markdown.match(/^##\s+Scope Note\s*\n[\s\S]*?(?=^##\s+|\s*$)/m);
  if (existing) {
    return markdown.replace(existing[0], section);
  }
  const sourcesIndex = markdown.search(/^##\s+Sources\s*$/m);
  if (sourcesIndex >= 0) {
    return `${markdown.slice(0, sourcesIndex).trimEnd()}\n\n${section}\n${markdown.slice(sourcesIndex)}`;
  }
  return `${markdown.trimEnd()}\n\n${section}`;
}

async function applyScopeNoteAction(input: {
  workspaceDir: string;
  action: WikiStructurePlanAction;
  dryRun: boolean;
}): Promise<AppliedWikiStructureAction | SkippedWikiStructureAction> {
  const args = asRecord(input.action.recommendedArgs);
  const pagePath = typeof args?.pagePath === "string" ? args.pagePath : input.action.path;
  const scopeNote = typeof args?.scopeNote === "string" ? args.scopeNote : undefined;
  if (!pagePath || !scopeNote) {
    return { action: input.action, reason: "Scope-note action is missing pagePath or scopeNote." };
  }
  const resolvedPath = resolveWikiPagePath(input.workspaceDir, pagePath);
  const original = await readFile(resolvedPath, "utf8");
  const updated = replaceOrAppendScopeNote(original, scopeNote);
  if (updated === original) {
    return { action: input.action, reason: "Scope note is already up to date." };
  }
  if (!input.dryRun) {
    await writeFile(resolvedPath, updated, "utf8");
  }
  return {
    action: input.action,
    changedFiles: [pagePath],
    message: input.dryRun ? `Would update Scope Note in ${pagePath}.` : `Updated Scope Note in ${pagePath}.`
  };
}

async function applyIndexRebuildAction(input: {
  workspaceDir: string;
  action: WikiStructurePlanAction;
  dryRun: boolean;
}): Promise<AppliedWikiStructureAction | SkippedWikiStructureAction> {
  const indexPath = relativeToWorkspace(input.workspaceDir, getPaperWikiIndexPath(input.workspaceDir));
  if (!input.dryRun) {
    await rewritePaperWikiIndex(input.workspaceDir);
  }
  return {
    action: input.action,
    changedFiles: [indexPath],
    message: input.dryRun ? `Would rebuild ${indexPath}.` : `Rebuilt ${indexPath}.`
  };
}
```

Update the action dispatch:

```ts
    const result =
      action.type === "fix_duplicate_section"
        ? await applyDuplicateSectionAction({ workspaceDir, action, dryRun })
        : action.type === "create_alias"
          ? await applyAliasAction({ workspaceDir, action, dryRun })
          : action.type === "update_scope_note"
            ? await applyScopeNoteAction({ workspaceDir, action, dryRun })
            : action.type === "rebuild_index"
              ? await applyIndexRebuildAction({ workspaceDir, action, dryRun })
              : { action, reason: `Action type ${action.type} is not supported by wiki_apply_structure_plan.` };
```

- [ ] **Step 4: Run targeted apply tests**

Run:

```bash
npm run build
node --test --experimental-test-isolation=none dist/test/agent/wiki-maintenance.test.js
```

Expected: apply tests pass.

- [ ] **Step 5: Commit Task 4**

```bash
rtk git add src/agent/wiki/content.ts src/agent/wiki/structure-apply.ts test/agent/wiki-maintenance.test.ts
rtk git commit -m "feat: apply safe wiki maintenance actions"
```

## Task 5: Add Evidence Contract Controls To `build_wiki_page`

**Files:**
- Modify: `src/agent/wiki/types.ts`
- Modify: `src/agent/wiki/content.ts`
- Modify: `src/agent/wiki/tools.ts`
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Add failing `build_wiki_page` tests**

Append to `test/agent/tools.test.ts` near existing `build_wiki_page` tests:

```ts
test("build_wiki_page refuses write mode when minSources is not met", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [{
          paperKey: "paper-a",
          title: "Single Evidence",
          path: "knowledge-base/wiki/sources/paper-a.md",
          snippet: "single source",
        }],
      }),
      paperWikiPageWorker: async () => ({
        title: "Tunable Coupler",
        pageMarkdown: "## Overview\n\nOne-source draft.",
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-page-min-sources", {
      topic: "tunable coupler",
      pageKey: "tunable-coupler",
      minSources: 2,
    }, undefined);
    const details = result.details as { status?: string; message?: string };

    assert.equal(details.status, "needs_evidence");
    assert.match(details.message ?? "", /minimum source count/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("build_wiki_page writes evidence contract and verifies after write", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  try {
    const tool = getBuildWikiPageTool(workspace, {
      searchPaperWiki: async (options) => ({
        query: options.query,
        results: [
          {
            paperKey: "paper-a",
            title: "Evidence A",
            path: "knowledge-base/wiki/sources/paper-a.md",
            snippet: "source A",
          },
          {
            paperKey: "paper-b",
            title: "Evidence B",
            path: "knowledge-base/wiki/sources/paper-b.md",
            snippet: "source B",
          },
        ],
      }),
      paperWikiPageWorker: async () => ({
        title: "Tunable Coupler",
        pageMarkdown: "## Overview\n\nTwo-source synthesis.",
        confidence: "high",
      }),
    });

    const result = await tool.execute("build-page-contract", {
      topic: "tunable coupler",
      pageKey: "tunable-coupler",
      minSources: 2,
      requiredSourceKeys: ["paper-a"],
      evidenceContract: "paper-backed",
      forbidExternalEvidence: true,
      verifyAfterWrite: true,
    }, undefined);
    const details = result.details as { status?: string; verification?: { lintAfter?: { issueCount?: number } } };

    assert.equal(details.status, "written");
    assert.equal(typeof details.verification?.lintAfter?.issueCount, "number");
    const page = await readFile(path.join(workspace, "knowledge-base/wiki/pages/tunable-coupler.md"), "utf8");
    assert.match(page, /evidence_contract: "paper-backed"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Extend page input types and writer frontmatter**

Modify `src/agent/wiki/types.ts`:

```ts
export type PaperWikiEvidenceContract = "paper-backed" | "design-backed" | "code-backed" | "mixed";

export interface PaperWikiPageInput {
  workspaceDir: string;
  topic: string;
  pageMarkdown: string;
  pageKey?: string;
  title?: string;
  tags?: string[];
  sourceCitations: PaperWikiPageSourceCitation[];
  openQuestions?: string[];
  relatedPageKeys?: string[];
  evidenceContract?: PaperWikiEvidenceContract;
}
```

Modify `writePaperWikiPage` frontmatter in `src/agent/wiki/content.ts`:

```ts
evidence_contract: ${quoteYaml(input.evidenceContract ?? "paper-backed")}
```

Place it after `topic`.

- [ ] **Step 3: Extend build tool details and schema**

Modify `src/agent/wiki/tools.ts` `buildWikiPageParameters`:

```ts
  evidenceContract: Type.Optional(Type.Union([
    Type.Literal("paper-backed"),
    Type.Literal("design-backed"),
    Type.Literal("code-backed"),
    Type.Literal("mixed")
  ], { description: "Evidence contract to write into page frontmatter." })),
  minSources: Type.Optional(Type.Integer({
    description: "Minimum citeable source summaries required before writing. Defaults to 1.",
    minimum: 0
  })),
  requiredSourceKeys: Type.Optional(Type.Array(Type.String({
    description: "Paper keys that must be present in selected source evidence before writing."
  }))),
  forbidExternalEvidence: Type.Optional(Type.Boolean({
    description: "Do not fall back to external evidence acquisition even outside wiki-agent boundary. Defaults to false."
  })),
  verifyAfterWrite: Type.Optional(Type.Boolean({
    description: "Run wiki_lint after writing and include verification summary. Defaults to false."
  }))
```

Extend `BuildWikiPageDetails`:

```ts
  verification?: {
    lintAfter?: Awaited<ReturnType<typeof lintPaperWiki>>;
  };
```

Set:

```ts
      const allowExternalEvidence = (dependencies.allowBuildWikiPageExternalEvidence ?? true) && args.forbidExternalEvidence !== true;
```

Before worker synthesis, after `sourceEvidence` is final, add:

```ts
      const minSources = Math.max(0, Math.trunc(args.minSources ?? 1));
      const requiredSourceKeys = new Set(args.requiredSourceKeys ?? []);
      const presentSourceKeys = new Set(sourceEvidence.map((item) => item.paperKey));
      const missingRequiredSourceKeys = [...requiredSourceKeys].filter((paperKey) => !presentSourceKeys.has(paperKey));
      const contractAllowsNonPaperEvidence = args.evidenceContract === "design-backed" || args.evidenceContract === "code-backed";
      if (!contractAllowsNonPaperEvidence && mode !== "draft" && sourceEvidence.length < minSources) {
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          bootstrap,
          ...(research ? { research } : {}),
          status: "needs_evidence",
          message: `Cannot write a wiki page because minimum source count ${minSources} is not met; found ${sourceEvidence.length}.`,
          evidence
        };
        return {
          content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
          details: result
        };
      }
      if (mode !== "draft" && missingRequiredSourceKeys.length > 0) {
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          bootstrap,
          ...(research ? { research } : {}),
          status: "needs_evidence",
          message: `Cannot write a wiki page because required source keys are missing: ${missingRequiredSourceKeys.join(", ")}.`,
          evidence
        };
        return {
          content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
          details: result
        };
      }
```

Pass evidence contract into `writePaperWikiPageImpl`:

```ts
        ...(args.evidenceContract ? { evidenceContract: args.evidenceContract } : {}),
```

After page write:

```ts
      const verification = args.verifyAfterWrite
        ? { lintAfter: await lintPaperWiki({ workspaceDir: resolvedWorkspaceDir, maxItems: 100 }) }
        : undefined;
```

Add `...(verification ? { verification } : {})` to the result.

- [ ] **Step 4: Run `build_wiki_page` tests**

Run:

```bash
npm run build
node --test --experimental-test-isolation=none dist/test/agent/tools.test.js
```

Expected: `build_wiki_page` tests pass.

- [ ] **Step 5: Commit Task 5**

```bash
rtk git add src/agent/wiki/types.ts src/agent/wiki/content.ts src/agent/wiki/tools.ts test/agent/tools.test.ts
rtk git commit -m "feat: enforce wiki page evidence contracts"
```

## Task 6: Update Docs, Prompts, Boundaries, And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `src/agent/agent-prompts.ts`
- Modify: `test/agent/tool-organization.test.ts`
- Modify: `test/agent/wiki-domain-boundary.test.ts`

- [ ] **Step 1: Update README wiki maintenance descriptions**

In `README.md`, replace the `wiki_lint`, `wiki_structure_plan`, `wiki_apply_structure_plan`, and `build_wiki_page` bullets with:

```md
- `build_wiki_page`: writes durable synthesis pages under `knowledge-base/wiki/pages/` from local source-summary evidence. It supports explicit evidence contracts, minimum source counts, required source keys, external-evidence blocking, and optional write-after lint verification.
- `wiki_lint`: checks wiki structure, source-to-page coverage, repeated concept gaps, evidence-contract gaps, semantic alias candidates, scope drift, stale index entries, broken links, missing citations, orphan pages, duplicate titles, repeated sections, weak uncited pages, and rendered wiki-link failures. Goal/focus options can prioritize concept gaps for a current research direction.
- `wiki_structure_plan`: turns `wiki_lint` findings into a reviewable, budgeted, goal-aware maintenance plan with owner, risk, recommended tool args, and verification actions. It suggests low-risk actions by default and does not rewrite wiki content.
- `wiki_apply_structure_plan`: applies approved low-risk `wiki_structure_plan` actions with dry-run and verification safeguards. Supported writes are deterministic duplicate-section cleanup, safe alias creation, deterministic index rebuild, and constrained `## Scope Note` updates.
```

- [ ] **Step 2: Update system prompt guidance**

Modify `src/agent/agent-prompts.ts` maintenance line:

```ts
  "When the user asks to optimize, clean up, restructure, deduplicate, merge, or improve wiki structure, call wiki_lint with the user's goal/focus when available, then call wiki_structure_plan. Use wiki_apply_structure_plan only for approved low-risk structural actions, and use build_wiki_page or merge_wiki_aliases for content/page and alias changes instead of ad hoc wiki rewrites.",
```

- [ ] **Step 3: Confirm tool organization still exposes no new public tools**

Update `test/agent/tool-organization.test.ts` expected lint tool list only if order changed. It should remain:

```ts
["wiki_lint", "wiki_structure_plan", "wiki_apply_structure_plan"]
```

Add assertion in `test/agent/tools.test.ts` boundary test:

```ts
assert.ok(!createTools(workspace, { toolProfile: "full" }).some((tool) => tool.name === "wiki_coverage_map"));
assert.ok(!createTools(workspace, { toolProfile: "full" }).some((tool) => tool.name === "wiki_concept_triage"));
```

- [ ] **Step 4: Export facade only if needed**

If `test/agent/wiki-domain-boundary.test.ts` needs read-only helper exports, add to `src/agent/wiki/index.ts`:

```ts
export {
  auditPageEvidenceContracts,
  auditScopeDrift,
  buildWikiCoverageMap,
  rankConceptGaps,
  suggestSemanticAliases
} from "./maintenance.js";
```

Then add assertions:

```ts
assert.equal(typeof buildWikiCoverageMap, "function");
assert.equal(typeof rankConceptGaps, "function");
```

If no facade export is needed, keep helpers module-local and do not change `wiki-domain-boundary.test.ts`.

- [ ] **Step 5: Run focused validation**

Run:

```bash
npm run build
node --test --experimental-test-isolation=none dist/test/agent/wiki-maintenance.test.js dist/test/agent/tools.test.js dist/test/agent/tool-organization.test.js dist/test/agent/wiki-domain-boundary.test.js dist/test/agent/pi-agent.test.js
```

Expected: all focused tests pass.

- [ ] **Step 6: Run full validation**

Run:

```bash
npm test
```

Expected: full suite passes. Use plain `npm test` for full-suite validation in this repo.

- [ ] **Step 7: Commit Task 6**

```bash
rtk git add README.md src/agent/agent-prompts.ts test/agent/tool-organization.test.ts test/agent/wiki-domain-boundary.test.ts test/agent/tools.test.ts
rtk git commit -m "docs: document wiki self-optimization workflow"
```

## Task 7: Final Integration Check

**Files:**
- No planned source changes unless verification reveals a bug.

- [ ] **Step 1: Inspect final diff**

Run:

```bash
rtk git status --short
rtk git log --oneline -6
```

Expected: only unrelated pre-existing untracked `.hermes/`, `notes/`, and `outputs/` remain outside the commits.

- [ ] **Step 2: Run final full suite**

Run:

```bash
npm test
```

Expected: full test suite passes.

- [ ] **Step 3: Summarize implemented behavior**

Prepare final implementation summary:

```text
Implemented wiki self-optimization enhancements by adding internal read-only maintenance helpers, goal-aware lint reports, budgeted structure plans, safe low-risk apply actions, and explicit build_wiki_page evidence contracts. Public tool names stayed stable; no wiki_coverage_map/wiki_concept_triage public tools were added.
```

- [ ] **Step 4: Commit any final fixups**

If focused or full tests required additional source fixes:

```bash
rtk git status --short
rtk git add src/agent/wiki/maintenance.ts src/agent/wiki/lint.ts src/agent/wiki/structure-plan.ts src/agent/wiki/structure-apply.ts src/agent/wiki/content.ts src/agent/wiki/types.ts src/agent/wiki/tools.ts src/agent/agent-prompts.ts README.md test/agent/wiki-maintenance.test.ts test/agent/tools.test.ts test/agent/tool-organization.test.ts test/agent/wiki-domain-boundary.test.ts
rtk git commit -m "fix: stabilize wiki self-optimization tools"
```

If no additional changes were needed, do not create an empty commit.
