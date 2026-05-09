# Wiki Structure Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add wiki-structure governance tools so the wiki-agent can diagnose and plan wiki cleanup through controlled tools instead of direct ad hoc edits to `knowledge-base/wiki`.

**Architecture:** Keep `wiki_lint` as the structural health checker, add a pure planning module under `src/agent/wiki/structure-plan.ts`, and expose a new `wiki_structure_plan` tool through `src/agent/wiki/tools.ts`. The first phase is deliberately conservative: it reports duplicate pages, alias candidates, repeated sections, weak/empty synthesis pages, bad rendered wiki links, and prioritized concept gaps, but it does not rewrite wiki content.

**Tech Stack:** TypeScript, Node.js test runner, existing `@mariozechner/pi-ai` TypeBox schemas, existing wiki store/content/lint helpers, `npm test` for full validation.

---

## Context

The current wiki tool surface already has:

- `wiki_lint`: detects stale index entries, broken links, missing citations, orphan pages, and repeated source-tag `concept_gap`.
- `wiki_health`: checks acquisition, download, parse, summary, artifact, blocklist, and citation metadata health.
- `search_paper_wiki`: retrieves source summaries and durable synthesis pages.
- `build_wiki_page`: writes durable cross-paper concept pages.
- `merge_wiki_aliases`: creates alias pages for duplicate concept names.

Observed live audit findings that the new tools must make visible:

- 70 wiki pages and 132 source summaries are present.
- `wiki_lint` reports 103 low-severity `concept_gap` issues.
- `wiki_health` reports 141 paper records with 2 authorization issues and 1 `download_blocked` issue.
- Duplicate title: `Agentic Quantum EDA, Calibration Automation, and Frequency Planning for Million-Qubit Superconducting Systems` appears in both `autonomous-agent-quantum-eda-calibration-frequency-allocation-llm-chip-design` and `agentic-quantum-eda-calibration-frequency-allocation-autonomous-discovery`.
- Near duplicates include `surface-code` / `surface-codes` and `cross-resonance-gate` / `cross-resonance-gates`.
- Many pages contain duplicate `Open Questions` sections.
- `minimal-superconducting-qldpc-chip-v0-1-spec` renders a bad page link for `[[12,2,3]]` as `/view/pages/12-2-3.md`.
- Several short or alias-like pages have no source citations, such as `surface-codes`, `cross-resonance-gates`, `eda`, `bosonic-modes`, `qldpc-decoding`, `fault-tolerance`, and `ldpc-codes`.

The intended agent workflow after this plan is implemented:

```text
wiki_health
  -> wiki_lint
  -> wiki_structure_plan
  -> agent reviews proposed actions
  -> existing build_wiki_page / merge_wiki_aliases / replace_file_text for approved low-risk changes
  -> wiki_lint and search_paper_wiki verification
```

Do not add a broad "rewrite wiki" tool in this phase.

## File Structure

- Modify: `src/agent/wiki/lint.ts`
  - Add new lint issue kinds for structural problems that are currently invisible.
  - Keep this file focused on deterministic checks, not ranking or repair planning.

- Create: `src/agent/wiki/structure-plan.ts`
  - Convert `wiki_lint` results and page metadata into a prioritized, reviewable plan.
  - Return recommended tool calls for existing tools, without applying them.

- Modify: `src/agent/wiki/tools.ts`
  - Add TypeBox schema and thin adapter for `wiki_structure_plan`.
  - Keep tool logic thin; delegate all domain logic to `structure-plan.ts`.

- Modify: `src/agent/tool-types.ts`
  - Add `wiki_structure_plan` to the global tool name union.
  - Expose it only on the `wiki-agent` boundary.

- Modify: `test/agent/paper-reader.test.ts`
  - Add domain tests for new lint issue kinds.

- Modify: `test/agent/tools.test.ts`
  - Add tool adapter and boundary exposure tests.

- Modify: `test/agent/wiki-domain-boundary.test.ts`
  - Confirm the new domain function is exported if the wiki index exports it.

- Modify: `README.md`
  - Add the new tool to the Wiki Maintenance Tools section.

---

### Task 1: Extend Wiki Lint Issue Types

**Files:**
- Modify: `src/agent/wiki/lint.ts`
- Test: `test/agent/paper-reader.test.ts`

- [ ] **Step 1: Update lint issue kind union**

In `src/agent/wiki/lint.ts`, replace the `PaperWikiLintIssueKind` union with:

```ts
export type PaperWikiLintIssueKind =
  | "stale_index"
  | "broken_wiki_link"
  | "missing_source_citation"
  | "orphan_page"
  | "concept_gap"
  | "duplicate_page_title"
  | "near_duplicate_page"
  | "duplicate_section"
  | "weak_synthesis_page"
  | "rendered_wiki_link";
```

Replace `ISSUE_KINDS` with:

```ts
const ISSUE_KINDS: PaperWikiLintIssueKind[] = [
  "stale_index",
  "broken_wiki_link",
  "missing_source_citation",
  "orphan_page",
  "concept_gap",
  "duplicate_page_title",
  "near_duplicate_page",
  "duplicate_section",
  "weak_synthesis_page",
  "rendered_wiki_link"
];
```

- [ ] **Step 2: Add helper functions**

Add these helpers below `extractMarkdownLinks`:

```ts
function extractMarkdownTitle(markdown: string, fallback: string): string {
  const frontmatterTitle = extractFrontmatter(markdown)
    .split("\n")
    .find((line) => line.startsWith("title:"))
    ?.slice("title:".length)
    .trim();
  if (frontmatterTitle) {
    try {
      const parsed = JSON.parse(frontmatterTitle);
      if (typeof parsed === "string" && parsed.trim()) {
        return parsed.trim();
      }
    } catch {
      return frontmatterTitle.replace(/^"|"$/g, "").trim();
    }
  }
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function normalizeTitleForDuplicate(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(codes|qubits|gates|architectures|systems)\b/g, (match) => {
      const stems: Record<string, string> = {
        codes: "code",
        qubits: "qubit",
        gates: "gate",
        architectures: "architecture",
        systems: "system"
      };
      return stems[match] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function extractSectionTitles(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function countBodyWords(markdown: string): number {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/[#>*_`[\](),.:;/\\-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function extractRenderedWikiLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[\[([^\]]+)\]\]/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => `knowledge-base/wiki/pages/${sanitizeWikiFilename(value)}.md`);
}
```

- [ ] **Step 3: Add deterministic page metadata pass**

Inside `lintPaperWiki`, after `incomingPageLinks` and `sourceTagCounts` are created, add:

```ts
const pageMetadata: Array<{
  pageKey: string;
  title: string;
  normalizedTitle: string;
  path: string;
  sourceCitationCount: number;
  sectionTitles: string[];
  bodyWords: number;
}> = [];
```

Inside the existing `for (const filePath of pageFiles)` loop, after `frontmatter` is read, add:

```ts
const title = extractMarkdownTitle(markdown, pageKey);
const sectionTitles = extractSectionTitles(markdown);
const sourceCitationCount = extractSourceCitationPaths(frontmatter).length;
pageMetadata.push({
  pageKey,
  title,
  normalizedTitle: normalizeTitleForDuplicate(title),
  path: relativePath,
  sourceCitationCount,
  sectionTitles,
  bodyWords: countBodyWords(markdown)
});

const sectionCounts = new Map<string, number>();
for (const sectionTitle of sectionTitles) {
  sectionCounts.set(sectionTitle, (sectionCounts.get(sectionTitle) ?? 0) + 1);
}
for (const [sectionTitle, count] of sectionCounts) {
  if (count > 1) {
    issues.push({
      kind: "duplicate_section",
      severity: "medium",
      path: relativePath,
      reason: `Section "${sectionTitle}" appears ${count} times in the same synthesis page.`
    });
  }
}

if (sourceCitationCount === 0 && countBodyWords(markdown) < 350) {
  issues.push({
    kind: "weak_synthesis_page",
    severity: "medium",
    path: relativePath,
    reason: "Page is short and has no source citations; it should be converted to an alias or rebuilt as a grounded synthesis page."
  });
}

for (const target of extractRenderedWikiLinkTargets(markdown)) {
  const targetPath = path.resolve(workspaceDir, target);
  if (!(await pathExists(targetPath))) {
    issues.push({
      kind: "rendered_wiki_link",
      severity: "high",
      path: relativePath,
      target,
      reason: "Double-bracket wiki link resolves to a missing page in the local viewer."
    });
  }
}
```

- [ ] **Step 4: Add duplicate title checks**

After the page loop and before concept-gap checks, add:

```ts
const exactTitles = new Map<string, typeof pageMetadata>();
const normalizedTitles = new Map<string, typeof pageMetadata>();
for (const page of pageMetadata) {
  const exactKey = page.title.toLowerCase().trim();
  exactTitles.set(exactKey, [...(exactTitles.get(exactKey) ?? []), page]);
  normalizedTitles.set(page.normalizedTitle, [...(normalizedTitles.get(page.normalizedTitle) ?? []), page]);
}

for (const pages of exactTitles.values()) {
  if (pages.length > 1) {
    for (const page of pages) {
      issues.push({
        kind: "duplicate_page_title",
        severity: "high",
        path: page.path,
        reason: `Page title duplicates: ${pages.map((item) => item.pageKey).join(", ")}.`
      });
    }
  }
}

for (const pages of normalizedTitles.values()) {
  const uniqueTitles = new Set(pages.map((page) => page.title.toLowerCase().trim()));
  if (pages.length > 1 && uniqueTitles.size > 1) {
    for (const page of pages) {
      issues.push({
        kind: "near_duplicate_page",
        severity: "medium",
        path: page.path,
        reason: `Page title is near-duplicate with: ${pages.map((item) => item.pageKey).join(", ")}.`
      });
    }
  }
}
```

- [ ] **Step 5: Update action summary**

In `summarizeActions`, add these action pairs:

```ts
["duplicate_page_title", "Merge duplicate-title synthesis pages or convert secondary pages into aliases."],
["near_duplicate_page", "Review near-duplicate concept pages and add aliases when one page is canonical."],
["duplicate_section", "Normalize synthesis pages so each section title appears once."],
["weak_synthesis_page", "Convert short uncited pages into aliases or rebuild them with source-backed evidence."],
["rendered_wiki_link", "Fix double-bracket wiki links that render to missing local pages."]
```

- [ ] **Step 6: Add lint domain test**

In `test/agent/paper-reader.test.ts`, add a test after the existing `lintPaperWiki reports structural wiki gaps` test:

```ts
test("lintPaperWiki reports duplicate titles, weak pages, duplicate sections, and rendered wiki links", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-wiki-lint-"));
  try {
    await mkdir(path.join(workspace, "knowledge-base/wiki/pages"), { recursive: true });
    await mkdir(path.join(workspace, "knowledge-base/wiki/sources"), { recursive: true });
    await writeFile(path.join(workspace, "knowledge-base/wiki/index.md"), [
      "# Paper LLM Wiki Index",
      "",
      "## Knowledge Entries",
      "",
      "- [Surface Code](pages/surface-code.md)",
      "- [Surface Codes](pages/surface-codes.md)",
      "- [Spec](pages/spec.md)"
    ].join("\n"));
    await writeFile(path.join(workspace, "knowledge-base/wiki/pages/surface-code.md"), [
      "---",
      "title: \"Surface Code\"",
      "source_citations: []",
      "related_pages: []",
      "---",
      "# Surface Code",
      "",
      "## Open Questions",
      "",
      "- First question.",
      "",
      "## Open Questions",
      "",
      "- Second question."
    ].join("\n"));
    await writeFile(path.join(workspace, "knowledge-base/wiki/pages/surface-codes.md"), [
      "---",
      "title: \"Surface Codes\"",
      "source_citations: []",
      "related_pages: []",
      "---",
      "# Surface Codes",
      "",
      "Alias-like short page."
    ].join("\n"));
    await writeFile(path.join(workspace, "knowledge-base/wiki/pages/spec.md"), [
      "---",
      "title: \"Minimal [[12,2,3]] Spec\"",
      "source_citations: []",
      "related_pages: []",
      "---",
      "# Minimal [[12,2,3]] Spec",
      "",
      "This page mentions [[12,2,3]] and should produce a missing rendered link."
    ].join("\n"));

    const lint = await lintPaperWiki({ workspaceDir: workspace, maxItems: 20 });

    assert.ok(lint.issues.some((issue) => issue.kind === "duplicate_section"));
    assert.ok(lint.issues.some((issue) => issue.kind === "near_duplicate_page"));
    assert.ok(lint.issues.some((issue) => issue.kind === "weak_synthesis_page"));
    assert.ok(lint.issues.some((issue) => issue.kind === "rendered_wiki_link" && issue.target?.endsWith("/12-2-3.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 7: Run focused test**

Run:

```bash
npm test -- test/agent/paper-reader.test.ts
```

Expected: the new test passes and existing paper-reader tests still pass.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/agent/wiki/lint.ts test/agent/paper-reader.test.ts
git commit -m "feat: expand wiki lint structure checks"
```

---

### Task 2: Add Pure Wiki Structure Plan Module

**Files:**
- Create: `src/agent/wiki/structure-plan.ts`
- Test: `test/agent/paper-reader.test.ts`

- [ ] **Step 1: Create structure plan module**

Create `src/agent/wiki/structure-plan.ts`:

```ts
import { lintPaperWiki, type PaperWikiLintIssue } from "./lint.js";

export type WikiStructureActionType =
  | "merge_duplicate_pages"
  | "create_alias"
  | "fix_duplicate_section"
  | "fix_rendered_wiki_link"
  | "rebuild_weak_page"
  | "promote_concept";

export type WikiStructureRisk = "low" | "medium" | "high";
export type WikiStructurePriority = "high" | "medium" | "low";

export interface WikiStructurePlanAction {
  id: string;
  type: WikiStructureActionType;
  priority: WikiStructurePriority;
  risk: WikiStructureRisk;
  issueKind: PaperWikiLintIssue["kind"];
  path?: string;
  target?: string;
  concept?: string;
  reason: string;
  recommendedTool?: "merge_wiki_aliases" | "build_wiki_page" | "replace_file_text";
  recommendedArgs?: unknown;
}

export interface WikiStructurePlanOptions {
  workspaceDir: string;
  maxItems?: number;
  includeMediumRisk?: boolean;
}

export interface WikiStructurePlanResult {
  status: "planned";
  lintSummary: Awaited<ReturnType<typeof lintPaperWiki>>["summary"];
  actionCount: number;
  actions: WikiStructurePlanAction[];
  warnings: string[];
}

function priorityForIssue(issue: PaperWikiLintIssue): WikiStructurePriority {
  if (issue.severity === "high") {
    return "high";
  }
  if (issue.kind === "duplicate_section" || issue.kind === "weak_synthesis_page" || issue.kind === "near_duplicate_page") {
    return "medium";
  }
  return "low";
}

function actionForIssue(issue: PaperWikiLintIssue, index: number): WikiStructurePlanAction | undefined {
  const id = `wiki-structure-${String(index + 1).padStart(3, "0")}`;
  if (issue.kind === "duplicate_page_title") {
    return {
      id,
      type: "merge_duplicate_pages",
      priority: "high",
      risk: "medium",
      issueKind: issue.kind,
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "merge_wiki_aliases",
      recommendedArgs: {
        aliases: [],
        replaceExisting: false
      }
    };
  }
  if (issue.kind === "near_duplicate_page") {
    return {
      id,
      type: "create_alias",
      priority: priorityForIssue(issue),
      risk: "low",
      issueKind: issue.kind,
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "merge_wiki_aliases",
      recommendedArgs: {
        aliases: [],
        replaceExisting: false
      }
    };
  }
  if (issue.kind === "duplicate_section") {
    return {
      id,
      type: "fix_duplicate_section",
      priority: priorityForIssue(issue),
      risk: "low",
      issueKind: issue.kind,
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "replace_file_text"
    };
  }
  if (issue.kind === "rendered_wiki_link") {
    return {
      id,
      type: "fix_rendered_wiki_link",
      priority: "high",
      risk: "low",
      issueKind: issue.kind,
      path: issue.path,
      target: issue.target,
      reason: issue.reason,
      recommendedTool: "replace_file_text"
    };
  }
  if (issue.kind === "weak_synthesis_page") {
    return {
      id,
      type: "rebuild_weak_page",
      priority: priorityForIssue(issue),
      risk: "medium",
      issueKind: issue.kind,
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "build_wiki_page"
    };
  }
  if (issue.kind === "concept_gap" && issue.concept) {
    return {
      id,
      type: "promote_concept",
      priority: issue.count && issue.count >= 5 ? "medium" : "low",
      risk: "medium",
      issueKind: issue.kind,
      concept: issue.concept,
      target: issue.target,
      reason: issue.reason,
      recommendedTool: "build_wiki_page",
      recommendedArgs: {
        topic: issue.concept.replace(/-/g, " "),
        pageKey: issue.concept,
        mode: "draft",
        maxLocalResults: 8,
        maxDownloads: 0,
        autoDownload: false,
        autoSummarize: false
      }
    };
  }
  return undefined;
}

export async function planWikiStructure(options: WikiStructurePlanOptions): Promise<WikiStructurePlanResult> {
  const maxItems = Math.max(1, Math.trunc(options.maxItems ?? 50));
  const lint = await lintPaperWiki({
    workspaceDir: options.workspaceDir,
    maxItems
  });
  const includeMediumRisk = options.includeMediumRisk ?? false;
  const actions = lint.issues
    .map((issue, index) => actionForIssue(issue, index))
    .filter((action): action is WikiStructurePlanAction => Boolean(action))
    .filter((action) => includeMediumRisk || action.risk === "low")
    .slice(0, maxItems);

  return {
    status: "planned",
    lintSummary: lint.summary,
    actionCount: actions.length,
    actions,
    warnings: [
      "This tool only plans structural changes. Use existing wiki write tools for approved actions.",
      "Medium-risk merge and rebuild actions should be reviewed before applying."
    ]
  };
}
```

- [ ] **Step 2: Add plan module test**

In `test/agent/paper-reader.test.ts`, add imports:

```ts
import { planWikiStructure } from "../../src/agent/wiki/structure-plan.js";
```

Add a test after the lint expansion test:

```ts
test("planWikiStructure turns lint findings into low-risk structure actions", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-wiki-plan-"));
  try {
    await mkdir(path.join(workspace, "knowledge-base/wiki/pages"), { recursive: true });
    await mkdir(path.join(workspace, "knowledge-base/wiki/sources"), { recursive: true });
    await writeFile(path.join(workspace, "knowledge-base/wiki/index.md"), [
      "# Paper LLM Wiki Index",
      "",
      "## Knowledge Entries",
      "",
      "- [Spec](pages/spec.md)"
    ].join("\n"));
    await writeFile(path.join(workspace, "knowledge-base/wiki/pages/spec.md"), [
      "---",
      "title: \"Minimal [[12,2,3]] Spec\"",
      "source_citations: []",
      "related_pages: []",
      "---",
      "# Minimal [[12,2,3]] Spec",
      "",
      "## Open Questions",
      "",
      "- First.",
      "",
      "## Open Questions",
      "",
      "- Second.",
      "",
      "This page links [[12,2,3]]."
    ].join("\n"));

    const plan = await planWikiStructure({
      workspaceDir: workspace,
      maxItems: 20
    });

    assert.equal(plan.status, "planned");
    assert.ok(plan.actions.some((action) => action.type === "fix_duplicate_section"));
    assert.ok(plan.actions.some((action) => action.type === "fix_rendered_wiki_link"));
    assert.ok(plan.actions.every((action) => action.risk === "low"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run focused test**

Run:

```bash
npm test -- test/agent/paper-reader.test.ts
```

Expected: plan module test passes.

- [ ] **Step 4: Commit Task 2**

```bash
git add src/agent/wiki/structure-plan.ts test/agent/paper-reader.test.ts
git commit -m "feat: plan wiki structure maintenance actions"
```

---

### Task 3: Expose `wiki_structure_plan` Tool

**Files:**
- Modify: `src/agent/wiki/tools.ts`
- Modify: `src/agent/tool-types.ts`
- Test: `test/agent/tools.test.ts`

- [ ] **Step 1: Add tool name and boundary**

In `src/agent/tool-types.ts`, add `"wiki_structure_plan"` to `ToolName` next to `"wiki_lint"`.

Add it to the `"wiki-agent"` boundary after `"wiki_lint"`:

```ts
"wiki_health",
"wiki_lint",
"wiki_structure_plan"
```

Do not add it to `paper-download-subagent`, `wiki-evidence-worker`, `design-subagent`, or `paper-writing-worker`.

- [ ] **Step 2: Add dependency hook**

In `src/agent/tool-types.ts`, import:

```ts
import type { planWikiStructure } from "./wiki/structure-plan.js";
```

Add to `ToolDependencies`:

```ts
planWikiStructure?: typeof planWikiStructure;
```

- [ ] **Step 3: Add schema and adapter**

In `src/agent/wiki/tools.ts`, add import:

```ts
import { planWikiStructure } from "./structure-plan.js";
```

Add parameters near `wikiLintParameters`:

```ts
const wikiStructurePlanParameters = Type.Object({
  maxItems: Type.Optional(Type.Integer({ description: "Maximum planned structure actions to return.", minimum: 1 })),
  includeMediumRisk: Type.Optional(Type.Boolean({
    description:
      "Include medium-risk actions such as page merges and rebuild recommendations. Defaults to false."
  }))
});
```

Inside `createWikiTools`, add:

```ts
const planWikiStructureImpl = dependencies.planWikiStructure ?? planWikiStructure;
```

Add the tool next to `wikiLintTool`:

```ts
const wikiStructurePlanTool = {
  name: "wiki_structure_plan",
  label: "Wiki Structure Plan",
  description:
    "Creates a reviewable structural maintenance plan from wiki_lint findings. It suggests low-risk actions by default and does not rewrite wiki content.",
  parameters: wikiStructurePlanParameters,
  execute: async (_toolCallId: string, args: Static<typeof wikiStructurePlanParameters>) => {
    const result = await planWikiStructureImpl({
      workspaceDir: resolvedWorkspaceDir,
      ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
      ...(args.includeMediumRisk !== undefined ? { includeMediumRisk: args.includeMediumRisk } : {})
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result
    };
  }
} satisfies AgentTool<Static<typeof wikiStructurePlanParameters>>;
```

Add it to the returned default lint/maintenance tool group:

```ts
lintTools: [wikiLintTool, wikiStructurePlanTool],
```

- [ ] **Step 4: Add adapter test**

In `test/agent/tools.test.ts`, add a helper type near other tool types:

```ts
type WikiStructurePlanTool = {
  execute: (
    toolCallId: string,
    args: { maxItems?: number; includeMediumRisk?: boolean },
    signal: undefined,
  ) => Promise<ToolResult>;
};
```

Add helper:

```ts
function getWikiStructurePlanTool(workspace: string, dependencies: agentTools.ToolDependencies = {}): WikiStructurePlanTool {
  const tool = createTools(workspace, dependencies).find((candidate) => candidate.name === "wiki_structure_plan");
  assert.ok(tool);
  return tool as WikiStructurePlanTool;
}
```

Add test after the `wiki_lint delegates...` test:

```ts
test("wiki_structure_plan delegates to the injected planner and returns details", async () => {
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
            duplicate_page_title: 0,
            near_duplicate_page: 0,
            duplicate_section: 1,
            weak_synthesis_page: 0,
            rendered_wiki_link: 0
          },
          actionCount: 1,
          actions: [
            {
              id: "wiki-structure-001",
              type: "fix_duplicate_section",
              priority: "medium",
              risk: "low",
              issueKind: "duplicate_section",
              path: "knowledge-base/wiki/pages/example.md",
              reason: "Section appears twice.",
              recommendedTool: "replace_file_text"
            }
          ],
          warnings: ["This tool only plans structural changes."]
        };
      }
    });

    const result = await tool.execute("wiki-structure-plan-call", {
      maxItems: 5,
      includeMediumRisk: true
    }, undefined);

    assert.deepEqual(capturedCalls, [{
      workspaceDir: workspace,
      maxItems: 5,
      includeMediumRisk: true
    }]);
    assert.equal((result.details as { actionCount: number }).actionCount, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Update boundary exposure test**

In the `createToolsForBoundary exposes isolated wiki and worker tool surfaces` test, update the expected wiki-agent names to include `"wiki_structure_plan"`. Confirm other role expectations do not include the new tool.

- [ ] **Step 6: Run focused test**

Run:

```bash
npm test -- test/agent/tools.test.ts
```

Expected: adapter and boundary tests pass.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/agent/wiki/tools.ts src/agent/tool-types.ts test/agent/tools.test.ts
git commit -m "feat: expose wiki structure planning tool"
```

---

### Task 4: Export Domain API and Update Docs

**Files:**
- Modify: `src/agent/wiki/index.ts`
- Modify: `test/agent/wiki-domain-boundary.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Export new planner**

In `src/agent/wiki/index.ts`, add:

```ts
export {
  planWikiStructure,
  type WikiStructurePlanAction,
  type WikiStructurePlanOptions,
  type WikiStructurePlanResult
} from "./structure-plan.js";
```

- [ ] **Step 2: Add domain boundary test**

In `test/agent/wiki-domain-boundary.test.ts`, add `planWikiStructure` to the import list and assertion:

```ts
import {
  lintPaperWiki,
  planWikiStructure
} from "../../src/agent/wiki/index.js";

test("wiki domain exports maintenance helpers", () => {
  assert.equal(typeof lintPaperWiki, "function");
  assert.equal(typeof planWikiStructure, "function");
});
```

If the file already has this test shape, modify the existing test rather than adding a duplicate.

- [ ] **Step 3: Update README tool list**

In `README.md`, under `### Wiki Maintenance Tools`, change:

```md
- `wiki_lint`: checks wiki structure, stale index entries, broken links, missing citations, orphan pages, and repeated tags that should become pages
```

to:

```md
- `wiki_lint`: checks wiki structure, stale index entries, broken links, missing citations, orphan pages, repeated tags that should become pages, duplicate titles, repeated sections, weak uncited pages, and rendered wiki-link failures
- `wiki_structure_plan`: turns `wiki_lint` findings into a reviewable structure-maintenance plan. It suggests low-risk actions by default and does not rewrite wiki content.
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- test/agent/wiki-domain-boundary.test.ts test/agent/tools.test.ts
```

Expected: exports and tool tests pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/agent/wiki/index.ts test/agent/wiki-domain-boundary.test.ts README.md
git commit -m "docs: document wiki structure planning tool"
```

---

### Task 5: Full Validation

**Files:**
- No new file edits unless validation reveals a bug.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Build and smoke-check tools without external model calls**

Run:

```bash
node -e '
import { createTools, cleanupTools } from "./dist/src/agent/tools.js";
const tools = createTools(process.cwd(), { toolProfile: "full" });
try {
  const lint = tools.find((tool) => tool.name === "wiki_lint");
  const plan = tools.find((tool) => tool.name === "wiki_structure_plan");
  if (!lint || !plan) throw new Error("missing wiki structure tools");
  const lintResult = await lint.execute("lint-smoke", { maxItems: 5 }, undefined);
  const planResult = await plan.execute("plan-smoke", { maxItems: 5 }, undefined);
  console.log(JSON.stringify({
    lintIssues: lintResult.details.issueCount,
    plannedActions: planResult.details.actionCount
  }));
} finally {
  await cleanupTools(tools);
}
'
```

Expected: command prints JSON with numeric `lintIssues` and `plannedActions`.

- [ ] **Step 3: Confirm wiki-agent boundary**

Run:

```bash
node -e '
import { getToolBoundaryToolNames } from "./dist/src/agent/tools.js";
console.log(JSON.stringify({
  wikiAgent: getToolBoundaryToolNames("wiki-agent").includes("wiki_structure_plan"),
  paperDownload: getToolBoundaryToolNames("paper-download-subagent").includes("wiki_structure_plan"),
  evidence: getToolBoundaryToolNames("wiki-evidence-worker").includes("wiki_structure_plan"),
  writing: getToolBoundaryToolNames("paper-writing-worker").includes("wiki_structure_plan")
}));
'
```

Expected:

```json
{"wikiAgent":true,"paperDownload":false,"evidence":false,"writing":false}
```

- [ ] **Step 4: Final commit if validation required fixes**

If Task 5 required code edits, commit them:

```bash
git add src test README.md
git commit -m "test: validate wiki structure planning tools"
```

If Task 5 required no edits, do not create an empty commit.

---

## Out of Scope

- Automatically merging wiki pages.
- Automatically deleting duplicate pages.
- Downloading new papers to fill concept gaps.
- Rewriting page prose at scale.
- Changing `wiki_health` acquisition behavior.
- Exposing structure-planning tools to paper-download or evidence-worker boundaries.

## Completion Criteria

- `wiki_lint` reports duplicate page titles, near duplicates, duplicate sections, weak pages, and rendered wiki-link failures.
- `wiki_structure_plan` returns reviewable actions and recommends existing tools instead of applying changes.
- `wiki_structure_plan` is visible to `wiki-agent` and not visible to unrelated worker boundaries.
- README documents the new tool.
- `npm test` passes.
- A local smoke check can run `wiki_lint` and `wiki_structure_plan` without calling an external model.
