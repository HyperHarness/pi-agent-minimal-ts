import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { lintPaperWiki, type PaperWikiLintResult } from "./lint.js";
import type { WikiStructurePlanAction } from "./structure-plan.js";

export interface ApplyWikiStructurePlanOptions {
  workspaceDir: string;
  actions: WikiStructurePlanAction[];
  dryRun?: boolean;
  requireLowRisk?: boolean;
  maxActions?: number;
  runVerification?: boolean;
}

export interface AppliedWikiStructureAction {
  action: WikiStructurePlanAction;
  changedFiles: string[];
  message: string;
}

export interface SkippedWikiStructureAction {
  action: WikiStructurePlanAction;
  reason: string;
}

export interface ApplyWikiStructurePlanResult {
  status: "dry_run" | "applied" | "partially_applied" | "blocked";
  applied: AppliedWikiStructureAction[];
  skipped: SkippedWikiStructureAction[];
  changedFiles: string[];
  verification?: {
    lintBefore?: PaperWikiLintResult;
    lintAfter?: PaperWikiLintResult;
  };
}

interface MarkdownSectionBlock {
  title: string;
  text: string;
  body: string;
  index: number;
}

function extractLevelTwoSections(markdown: string): MarkdownSectionBlock[] {
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)].map((match, index) => ({
    title: match[1]?.trim() ?? "",
    start: match.index ?? 0,
    endOfHeading: (match.index ?? 0) + match[0].length,
    index
  }));

  return headings
    .filter((heading) => heading.title)
    .map((heading, index) => {
      const end = headings[index + 1]?.start ?? markdown.length;
      return {
        title: heading.title,
        text: markdown.slice(heading.start, end),
        body: markdown.slice(heading.endOfHeading, end),
        index: heading.index
      };
    });
}

function normalizeSectionTitle(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasSourceCitation(markdown: string): boolean {
  return /knowledge-base\/wiki\/sources\/|source_citations?:|source summary|paper-source-summary/i.test(markdown);
}

function resolveWikiPagePath(workspaceDir: string, relativePath: string): string {
  const normalized = relativePath.split(path.sep).join("/");
  if (!normalized.startsWith("knowledge-base/wiki/pages/") || !normalized.endsWith(".md")) {
    throw new Error("Structure apply actions must target wiki synthesis pages.");
  }

  const workspace = path.resolve(workspaceDir);
  const resolved = path.resolve(workspace, relativePath);
  const relative = path.relative(workspace, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Structure apply action path escapes the workspace.");
  }
  return resolved;
}

function selectDuplicateSectionToRemove(markdown: string, title: string): MarkdownSectionBlock | undefined {
  const duplicateSections = extractLevelTwoSections(markdown)
    .filter((section) => normalizeSectionTitle(section.title) === normalizeSectionTitle(title));
  if (duplicateSections.length < 2) {
    return undefined;
  }

  const laterSections = duplicateSections.slice(1);
  const uncitedLaterSections = laterSections.filter((section) => !hasSourceCitation(section.body));
  const candidates = uncitedLaterSections.length > 0 ? uncitedLaterSections : laterSections;
  return [...candidates].sort((left, right) => {
    const bodyLengthDelta = left.body.trim().length - right.body.trim().length;
    return bodyLengthDelta !== 0 ? bodyLengthDelta : right.index - left.index;
  })[0];
}

async function applyDuplicateSectionAction(input: {
  workspaceDir: string;
  action: WikiStructurePlanAction;
  dryRun: boolean;
}): Promise<AppliedWikiStructureAction | SkippedWikiStructureAction> {
  const { action, dryRun, workspaceDir } = input;
  if (!action.path || !action.target) {
    return { action, reason: "Duplicate-section action is missing path or target section title." };
  }

  const resolvedPath = resolveWikiPagePath(workspaceDir, action.path);
  const original = await readFile(resolvedPath, "utf8");
  const sectionToRemove = selectDuplicateSectionToRemove(original, action.target);
  if (!sectionToRemove) {
    return { action, reason: "Target page no longer has a duplicate section matching this action." };
  }

  if (!dryRun) {
    await writeFile(resolvedPath, original.replace(sectionToRemove.text, ""), "utf8");
  }

  return {
    action,
    changedFiles: [action.path],
    message: dryRun
      ? `Would remove duplicate section "${action.target}" from ${action.path}.`
      : `Removed duplicate section "${action.target}" from ${action.path}.`
  };
}

export async function applyWikiStructurePlan(options: ApplyWikiStructurePlanOptions): Promise<ApplyWikiStructurePlanResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const dryRun = options.dryRun ?? true;
  const requireLowRisk = options.requireLowRisk ?? true;
  const maxActions = Math.max(1, Math.trunc(options.maxActions ?? 10));
  const runVerification = options.runVerification ?? true;
  const applied: AppliedWikiStructureAction[] = [];
  const skipped: SkippedWikiStructureAction[] = [];
  const lintBefore = runVerification ? await lintPaperWiki({ workspaceDir, maxItems: 200 }) : undefined;

  for (const action of options.actions.slice(0, maxActions)) {
    if (requireLowRisk && action.risk !== "low") {
      skipped.push({ action, reason: "Skipped because requireLowRisk=true and action risk is not low." });
      continue;
    }
    if (action.type !== "fix_duplicate_section") {
      skipped.push({ action, reason: "Only fix_duplicate_section is supported by the first structure apply implementation." });
      continue;
    }

    const result = await applyDuplicateSectionAction({ workspaceDir, action, dryRun });
    if ("changedFiles" in result) {
      applied.push(result);
    } else {
      skipped.push(result);
    }
  }

  const changedFiles = [...new Set(applied.flatMap((item) => item.changedFiles))];
  const lintAfter = runVerification ? await lintPaperWiki({ workspaceDir, maxItems: 200 }) : undefined;
  const status = dryRun
    ? "dry_run"
    : applied.length === 0
      ? "blocked"
      : skipped.length > 0
        ? "partially_applied"
        : "applied";

  return {
    status,
    applied,
    skipped,
    changedFiles: dryRun ? [] : changedFiles,
    ...(runVerification ? { verification: { lintBefore, lintAfter } } : {})
  };
}
