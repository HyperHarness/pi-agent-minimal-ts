import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafePaperWikiWriteTarget, mergePaperWikiAliases, rewritePaperWikiIndex } from "./content.js";
import { beginWikiOperation, completeWikiOperation } from "./journal.js";
import { lintPaperWiki, type PaperWikiLintResult } from "./lint.js";
import {
  getPaperWikiIndexPath,
  getPaperWikiLogPath,
  getPaperWikiPagePath,
  getPaperWikiPagesDir,
  listPaperWikiPageFiles,
  relativeToWorkspace,
  sanitizeWikiFilename
} from "./store.js";
import type { WikiStructurePlanAction } from "./structure-plan.js";
import type { PaperWikiAliasInput } from "./types.js";

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
  operationId?: string;
  operationJournalPath?: string;
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
  return /knowledge-base\/sources\/|source_citations?:|source summary|paper-source-summary/i.test(markdown);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function extractFrontmatterValue(markdown: string, key: string): string | undefined {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch?.[1]) {
    return undefined;
  }
  const line = frontmatterMatch[1]
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}:`));
  const raw = line?.slice(key.length + 1).trim();
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return raw;
  }
}

function isAliasMarkdown(markdown: string): boolean {
  return extractFrontmatterValue(markdown, "type") === "wiki-alias-page" ||
    Boolean(extractFrontmatterValue(markdown, "canonical_page"));
}

function resolveWikiPagePath(workspaceDir: string, relativePath: string): string {
  const normalized = relativePath.split(path.sep).join("/");
  if (!normalized.startsWith("knowledge-base/pages/") || !normalized.endsWith(".md")) {
    throw new Error("Structure apply actions must target wiki synthesis pages.");
  }

  const workspace = path.resolve(workspaceDir);
  const resolved = path.resolve(workspace, relativePath);
  const pagesDir = path.resolve(getPaperWikiPagesDir(workspaceDir));
  const relativeToPages = path.relative(pagesDir, resolved);
  if (relativeToPages.startsWith("..") || path.isAbsolute(relativeToPages)) {
    throw new Error("Structure apply actions must target wiki synthesis pages.");
  }
  return resolved;
}

function normalizeAliasInputs(value: unknown): PaperWikiAliasInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const aliases: PaperWikiAliasInput[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const alias = typeof record?.alias === "string" ? record.alias.trim() : "";
    const canonical = typeof record?.canonical === "string" ? record.canonical.trim() : "";
    if (!alias || !canonical) {
      return undefined;
    }
    try {
      sanitizeWikiFilename(alias.toLowerCase());
      sanitizeWikiFilename(canonical.toLowerCase());
    } catch {
      return undefined;
    }
    aliases.push({
      alias,
      canonical,
      ...(typeof record?.title === "string" && record.title.trim() ? { title: record.title.trim() } : {}),
      ...(typeof record?.note === "string" && record.note.trim() ? { note: record.note.trim() } : {})
    });
  }

  return aliases;
}

interface DuplicatePageMergeArgs {
  canonicalPageKey: string;
  redundantPageKey: string;
  alias: string;
  note?: string;
}

interface DuplicatePageMergePreflight {
  args: DuplicatePageMergeArgs;
  changedFiles: string[];
  inboundPages: Array<{
    path: string;
    original: string;
    updated: string;
  }>;
}

function normalizeDuplicatePageMergeArgs(value: unknown): DuplicatePageMergeArgs | undefined {
  const record = asRecord(value);
  const canonical = typeof record?.canonical === "string" ? record.canonical.trim() : "";
  const redundant = typeof record?.redundant === "string" ? record.redundant.trim() : "";
  if (!canonical || !redundant) {
    return undefined;
  }
  const canonicalPageKey = sanitizeWikiFilename(canonical.toLowerCase());
  const redundantPageKey = sanitizeWikiFilename(redundant.toLowerCase());
  if (canonicalPageKey === redundantPageKey) {
    return undefined;
  }
  const alias = typeof record?.alias === "string" && record.alias.trim()
    ? sanitizeWikiFilename(record.alias.trim().toLowerCase())
    : redundantPageKey;
  return {
    canonicalPageKey,
    redundantPageKey,
    alias,
    ...(typeof record?.note === "string" && record.note.trim() ? { note: record.note.trim() } : {})
  };
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function parseYamlStringList(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) {
    return [];
  }
  const inline = lines[start]?.slice(key.length + 1).trim();
  if (inline && inline !== "[]") {
    try {
      const parsed = JSON.parse(inline);
      return typeof parsed === "string" ? [parsed] : [];
    } catch {
      return [inline.replace(/^"|"$/g, "").trim()].filter(Boolean);
    }
  }

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const value = line.match(/^\s*-\s*(.+)$/)?.[1]?.trim();
    if (!value) {
      continue;
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") {
        values.push(parsed);
      }
    } catch {
      values.push(value.replace(/^"|"$/g, "").trim());
    }
  }
  return values.filter(Boolean);
}

function replaceYamlStringList(frontmatter: string, key: string, values: string[]): string {
  const lines = frontmatter.split("\n");
  const replacement = values.length > 0
    ? [`${key}:`, ...values.map((value) => `  - ${quoteYamlString(value)}`)]
    : [`${key}: []`];
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) {
    return [...lines, ...replacement].join("\n");
  }
  let end = start + 1;
  while (end < lines.length && /^\s+/.test(lines[end])) {
    end += 1;
  }
  return [
    ...lines.slice(0, start),
    ...replacement,
    ...lines.slice(end)
  ].join("\n");
}

function addCanonicalAliases(markdown: string, aliases: string[]): string {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch?.[1]) {
    return markdown;
  }
  const frontmatter = frontmatterMatch[1];
  const existingAliases = parseYamlStringList(frontmatter, "aliases");
  const nextAliases = [...new Set([...existingAliases, ...aliases].map((alias) => alias.trim()).filter(Boolean))];
  const nextFrontmatter = replaceYamlStringList(frontmatter, "aliases", nextAliases);
  return `${markdown.slice(0, frontmatterMatch.index ?? 0)}---\n${nextFrontmatter}\n---\n${markdown.slice(frontmatterMatch[0].length)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderedWikiLinkTarget(value: string): string | undefined {
  const slug = value
    .split("|")[0]
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `knowledge-base/pages/${slug}.md` : undefined;
}

function renderedWikiLinkReplacement(value: string): string {
  const rawDisplay = value.split("|")[1]?.trim() || value.split("|")[0]?.trim() || value.trim();
  const display = rawDisplay.replace(/`/g, "").trim();
  return display ? `\`${display}\`` : "";
}

function replaceRenderedWikiLinks(markdown: string, target: string): { markdown: string; count: number } {
  let count = 0;
  const updated = markdown.replace(/\[\[([^\]]+)\]\]/g, (fullMatch, rawTarget: string) => {
    if (renderedWikiLinkTarget(rawTarget) !== target) {
      return fullMatch;
    }
    count += 1;
    return renderedWikiLinkReplacement(rawTarget);
  });
  return { markdown: updated, count };
}

function rewriteDuplicatePageLinks(markdown: string, redundantPageKey: string, canonicalPageKey: string): string {
  const redundantTarget = `knowledge-base/pages/${redundantPageKey}.md`;
  const canonicalTarget = `knowledge-base/pages/${canonicalPageKey}.md`;
  return markdown.replace(new RegExp(escapeRegExp(redundantTarget), "g"), canonicalTarget);
}

async function preflightDuplicatePageMerge(input: {
  workspaceDir: string;
  args: DuplicatePageMergeArgs;
}): Promise<DuplicatePageMergePreflight | { reason: string }> {
  const canonicalPath = getPaperWikiPagePath(input.workspaceDir, input.args.canonicalPageKey);
  const redundantPath = getPaperWikiPagePath(input.workspaceDir, input.args.redundantPageKey);
  const canonicalPathRelative = relativeToWorkspace(input.workspaceDir, canonicalPath);
  const redundantPathRelative = relativeToWorkspace(input.workspaceDir, redundantPath);
  const [canonicalMarkdown, redundantMarkdown] = await Promise.all([
    readFile(canonicalPath, "utf8").catch(() => undefined),
    readFile(redundantPath, "utf8").catch(() => undefined)
  ]);
  if (!canonicalMarkdown) {
    return { reason: "Canonical wiki page does not exist." };
  }
  if (!redundantMarkdown) {
    return { reason: "Redundant wiki page does not exist." };
  }
  if (isAliasMarkdown(canonicalMarkdown)) {
    return { reason: "Canonical wiki page is already an alias page." };
  }

  try {
    await assertSafePaperWikiWriteTarget({
      workspaceDir: input.workspaceDir,
      filePath: canonicalPath,
      allowedRoot: getPaperWikiPagesDir(input.workspaceDir),
      label: "canonical wiki page"
    });
    await assertSafePaperWikiWriteTarget({
      workspaceDir: input.workspaceDir,
      filePath: redundantPath,
      allowedRoot: getPaperWikiPagesDir(input.workspaceDir),
      label: "redundant wiki page"
    });
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }

  const inboundPages: DuplicatePageMergePreflight["inboundPages"] = [];
  const pageFiles = await listPaperWikiPageFiles(input.workspaceDir);
  for (const pageFile of pageFiles) {
    if (path.resolve(pageFile) === path.resolve(redundantPath)) {
      continue;
    }
    const original = await readFile(pageFile, "utf8");
    const updated = rewriteDuplicatePageLinks(original, input.args.redundantPageKey, input.args.canonicalPageKey);
    if (updated === original) {
      continue;
    }
    try {
      await assertSafePaperWikiWriteTarget({
        workspaceDir: input.workspaceDir,
        filePath: pageFile,
        allowedRoot: getPaperWikiPagesDir(input.workspaceDir),
        label: "inbound wiki page"
      });
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
    inboundPages.push({
      path: relativeToWorkspace(input.workspaceDir, pageFile),
      original,
      updated
    });
  }

  try {
    await assertSafePaperWikiWriteTarget({
      workspaceDir: input.workspaceDir,
      filePath: getPaperWikiIndexPath(input.workspaceDir),
      allowedRoot: path.dirname(getPaperWikiIndexPath(input.workspaceDir)),
      label: "wiki index"
    });
    await assertSafePaperWikiWriteTarget({
      workspaceDir: input.workspaceDir,
      filePath: getPaperWikiLogPath(input.workspaceDir),
      allowedRoot: path.dirname(getPaperWikiLogPath(input.workspaceDir)),
      label: "wiki log"
    });
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }

  return {
    args: input.args,
    changedFiles: [
      canonicalPathRelative,
      redundantPathRelative,
      ...inboundPages.map((page) => page.path),
      relativeToWorkspace(input.workspaceDir, getPaperWikiIndexPath(input.workspaceDir)),
      relativeToWorkspace(input.workspaceDir, getPaperWikiLogPath(input.workspaceDir))
    ],
    inboundPages
  };
}

async function preflightAliasDryRun(input: {
  workspaceDir: string;
  aliases: PaperWikiAliasInput[];
}): Promise<{ aliases: PaperWikiAliasInput[]; changedFiles: string[] } | { reason: string }> {
  const pageFiles = await listPaperWikiPageFiles(input.workspaceDir);
  const pageKeys = new Set(pageFiles.map((filePath) => path.basename(filePath, ".md")));
  const seen = new Set<string>();
  const safeAliases: PaperWikiAliasInput[] = [];
  const changedFiles: string[] = [];
  const skippedReasons: string[] = [];

  for (const aliasInput of input.aliases) {
    const aliasPageKey = sanitizeWikiFilename(aliasInput.alias.toLowerCase());
    const canonicalPageKey = sanitizeWikiFilename(aliasInput.canonical.toLowerCase());
    const pagePath = getPaperWikiPagePath(input.workspaceDir, aliasPageKey);
    const pagePathRelative = relativeToWorkspace(input.workspaceDir, pagePath);

    if (seen.has(aliasPageKey)) {
      continue;
    }
    seen.add(aliasPageKey);

    if (aliasPageKey === canonicalPageKey) {
      skippedReasons.push("Alias and canonical page keys are identical.");
      continue;
    }
    if (!pageKeys.has(canonicalPageKey)) {
      skippedReasons.push("Canonical wiki page does not exist; build the canonical page before creating aliases.");
      continue;
    }

    try {
      await assertSafePaperWikiWriteTarget({
        workspaceDir: input.workspaceDir,
        filePath: pagePath,
        allowedRoot: getPaperWikiPagesDir(input.workspaceDir),
        label: "wiki alias page"
      });
    } catch (error) {
      skippedReasons.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    const existing = await readFile(pagePath, "utf8").catch(() => undefined);
    if (existing && !isAliasMarkdown(existing)) {
      skippedReasons.push(
        "Alias page already exists as a synthesis page; set replaceExisting=true only after confirming it should be merged."
      );
      continue;
    }

    changedFiles.push(pagePathRelative);
    safeAliases.push(aliasInput);
    pageKeys.add(aliasPageKey);
  }

  if (changedFiles.length === 0) {
    return { reason: skippedReasons.join("; ") || "No alias pages would be written." };
  }

  try {
    await assertSafePaperWikiWriteTarget({
      workspaceDir: input.workspaceDir,
      filePath: getPaperWikiIndexPath(input.workspaceDir),
      allowedRoot: path.dirname(getPaperWikiIndexPath(input.workspaceDir)),
      label: "wiki index"
    });
    await assertSafePaperWikiWriteTarget({
      workspaceDir: input.workspaceDir,
      filePath: getPaperWikiLogPath(input.workspaceDir),
      allowedRoot: path.dirname(getPaperWikiLogPath(input.workspaceDir)),
      label: "wiki log"
    });
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }

  return {
    aliases: safeAliases,
    changedFiles: [
      ...changedFiles,
      relativeToWorkspace(input.workspaceDir, getPaperWikiIndexPath(input.workspaceDir)),
      relativeToWorkspace(input.workspaceDir, getPaperWikiLogPath(input.workspaceDir))
    ]
  };
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
  await assertSafePaperWikiWriteTarget({
    workspaceDir,
    filePath: resolvedPath,
    allowedRoot: getPaperWikiPagesDir(workspaceDir),
    label: "wiki page"
  });
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

async function applyRenderedWikiLinkAction(input: {
  workspaceDir: string;
  action: WikiStructurePlanAction;
  dryRun: boolean;
}): Promise<AppliedWikiStructureAction | SkippedWikiStructureAction> {
  const { action, dryRun, workspaceDir } = input;
  if (!action.path || !action.target) {
    return { action, reason: "Rendered-link action is missing path or target page." };
  }

  const resolvedPath = resolveWikiPagePath(workspaceDir, action.path);
  await assertSafePaperWikiWriteTarget({
    workspaceDir,
    filePath: resolvedPath,
    allowedRoot: getPaperWikiPagesDir(workspaceDir),
    label: "wiki page"
  });
  const original = await readFile(resolvedPath, "utf8");
  const replacement = replaceRenderedWikiLinks(original, action.target);
  if (replacement.count === 0 || replacement.markdown === original) {
    return { action, reason: "Target page no longer has a rendered wiki link matching this action." };
  }

  if (!dryRun) {
    await writeFile(resolvedPath, replacement.markdown, "utf8");
  }

  return {
    action,
    changedFiles: [action.path],
    message: dryRun
      ? `Would replace ${replacement.count} rendered wiki link(s) in ${action.path}.`
      : `Replaced ${replacement.count} rendered wiki link(s) in ${action.path}.`
  };
}

async function applyAliasAction(input: {
  workspaceDir: string;
  action: WikiStructurePlanAction;
  dryRun: boolean;
}): Promise<AppliedWikiStructureAction | SkippedWikiStructureAction> {
  const args = asRecord(input.action.recommendedArgs);
  const aliases = normalizeAliasInputs(args?.aliases);
  if (!aliases || aliases.length === 0) {
    return { action: input.action, reason: "Alias action is missing recommendedArgs.aliases." };
  }

  if (input.dryRun) {
    const preflight = await preflightAliasDryRun({ workspaceDir: input.workspaceDir, aliases });
    if ("reason" in preflight) {
      return { action: input.action, reason: preflight.reason };
    }
    return {
      action: input.action,
      changedFiles: preflight.changedFiles,
      message: "Would create safe wiki alias mappings."
    };
  }

  const preflight = await preflightAliasDryRun({ workspaceDir: input.workspaceDir, aliases });
  if ("reason" in preflight) {
    return { action: input.action, reason: preflight.reason };
  }

  const result = await mergePaperWikiAliases({
    workspaceDir: input.workspaceDir,
    aliases: preflight.aliases,
    replaceExisting: false
  });
  const changedFiles = result.aliases
    .filter((alias) => alias.status === "written")
    .map((alias) => alias.pagePath);

  return changedFiles.length > 0
    ? {
      action: input.action,
      changedFiles: [...new Set([...changedFiles, result.indexPath, result.logPath])],
      message: `Wrote ${changedFiles.length} wiki alias page(s).`
    }
    : {
      action: input.action,
      reason: result.aliases.map((alias) => alias.reason).filter(Boolean).join("; ") || "No alias pages were written."
    };
}

async function applyDuplicatePageMergeAction(input: {
  workspaceDir: string;
  action: WikiStructurePlanAction;
  dryRun: boolean;
}): Promise<AppliedWikiStructureAction | SkippedWikiStructureAction> {
  const args = normalizeDuplicatePageMergeArgs(input.action.recommendedArgs);
  if (!args) {
    return { action: input.action, reason: "Duplicate-page merge action is missing canonical or redundant page keys." };
  }

  const preflight = await preflightDuplicatePageMerge({ workspaceDir: input.workspaceDir, args });
  if ("reason" in preflight) {
    return { action: input.action, reason: preflight.reason };
  }

  if (input.dryRun) {
    return {
      action: input.action,
      changedFiles: preflight.changedFiles,
      message: `Would merge duplicate wiki page ${args.redundantPageKey} into ${args.canonicalPageKey}.`
    };
  }

  const canonicalPath = getPaperWikiPagePath(input.workspaceDir, args.canonicalPageKey);
  const redundantPath = getPaperWikiPagePath(input.workspaceDir, args.redundantPageKey);
  const canonicalMarkdown = await readFile(canonicalPath, "utf8");
  const updatedCanonical = addCanonicalAliases(canonicalMarkdown, [args.alias]);
  await writeFile(canonicalPath, updatedCanonical, "utf8");
  for (const page of preflight.inboundPages) {
    const resolvedPath = resolveWikiPagePath(input.workspaceDir, page.path);
    await writeFile(resolvedPath, page.updated, "utf8");
  }
  await unlink(redundantPath);
  await rewritePaperWikiIndex(input.workspaceDir);
  const now = new Date().toISOString();
  await appendFile(
    getPaperWikiLogPath(input.workspaceDir),
    `\n## [${now.slice(0, 10)}] merged duplicate pages\n\n- \`${args.redundantPageKey}\` -> \`${args.canonicalPageKey}\`${args.note ? ` (${args.note})` : ""}\n`,
    "utf8"
  );

  return {
    action: input.action,
    changedFiles: preflight.changedFiles,
    message: `Merged duplicate wiki page ${args.redundantPageKey} into ${args.canonicalPageKey}.`
  };
}

function replaceOrAppendScopeNote(markdown: string, scopeNote: string): string {
  const section = `## Scope Note\n\n${scopeNote.trim()}\n\n`;
  const existing = markdown.match(/^##\s+Scope Note\s*\n[\s\S]*?(?=^##\s+|(?![\s\S]))/m);
  if (existing) {
    return markdown.replace(existing[0], section);
  }

  const sourcesIndex = markdown.search(/^##\s+Sources\s*$/m);
  if (sourcesIndex >= 0) {
    return `${markdown.slice(0, sourcesIndex).trimEnd()}\n\n${section}${markdown.slice(sourcesIndex)}`;
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
  if (!pagePath || !scopeNote?.trim()) {
    return { action: input.action, reason: "Scope-note action is missing pagePath or scopeNote." };
  }

  const resolvedPath = resolveWikiPagePath(input.workspaceDir, pagePath);
  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: resolvedPath,
    allowedRoot: getPaperWikiPagesDir(input.workspaceDir),
    label: "wiki page"
  });
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
  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: getPaperWikiIndexPath(input.workspaceDir),
    allowedRoot: path.dirname(getPaperWikiIndexPath(input.workspaceDir)),
    label: "wiki index"
  });
  if (!input.dryRun) {
    await rewritePaperWikiIndex(input.workspaceDir);
  }

  return {
    action: input.action,
    changedFiles: [indexPath],
    message: input.dryRun ? `Would rebuild ${indexPath}.` : `Rebuilt ${indexPath}.`
  };
}

export async function applyWikiStructurePlan(options: ApplyWikiStructurePlanOptions): Promise<ApplyWikiStructurePlanResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const dryRun = options.dryRun ?? true;
  const requireLowRisk = options.requireLowRisk ?? true;
  const maxActions = Math.max(1, Math.trunc(options.maxActions ?? 10));
  const runVerification = options.runVerification ?? true;
  const lintBefore = runVerification ? await lintPaperWiki({ workspaceDir, maxItems: 200 }) : undefined;
  const selectedActions = options.actions.slice(0, maxActions);

  async function runActions(actionDryRun: boolean): Promise<{
    applied: AppliedWikiStructureAction[];
    skipped: SkippedWikiStructureAction[];
  }> {
    const applied: AppliedWikiStructureAction[] = [];
    const skipped: SkippedWikiStructureAction[] = [];
    for (const action of selectedActions) {
      if (requireLowRisk && action.risk !== "low") {
        skipped.push({ action, reason: "Skipped because requireLowRisk=true and action risk is not low." });
        continue;
      }
      const result =
        action.type === "fix_duplicate_section"
          ? await applyDuplicateSectionAction({ workspaceDir, action, dryRun: actionDryRun })
          : action.type === "fix_rendered_wiki_link"
            ? await applyRenderedWikiLinkAction({ workspaceDir, action, dryRun: actionDryRun })
          : action.type === "create_alias"
            ? await applyAliasAction({ workspaceDir, action, dryRun: actionDryRun })
            : action.type === "merge_duplicate_pages"
              ? await applyDuplicatePageMergeAction({ workspaceDir, action, dryRun: actionDryRun })
              : action.type === "update_scope_note"
                ? await applyScopeNoteAction({ workspaceDir, action, dryRun: actionDryRun })
                : action.type === "rebuild_index"
                  ? await applyIndexRebuildAction({ workspaceDir, action, dryRun: actionDryRun })
                  : { action, reason: `Action type ${action.type} is not supported by wiki_apply_structure_plan.` };
      if ("changedFiles" in result) {
        applied.push(result);
      } else {
        skipped.push(result);
      }
    }
    return { applied, skipped };
  }

  const preview = dryRun ? undefined : await runActions(true);
  const plannedFiles = preview
    ? [...new Set(preview.applied.flatMap((item) => item.changedFiles))]
    : [];
  const operation = !dryRun && plannedFiles.length > 0
    ? await beginWikiOperation({
      workspaceDir,
      intent: "apply_structure_plan",
      owner: "wiki-agent",
      plannedFiles,
      inputs: {
        actionIds: selectedActions.map((action) => action.id),
        maxActions,
        requireLowRisk
      }
    })
    : undefined;

  const { applied, skipped } = await runActions(dryRun);
  const changedFiles = [...new Set(applied.flatMap((item) => item.changedFiles))];
  const lintAfter = runVerification ? await lintPaperWiki({ workspaceDir, maxItems: 200 }) : undefined;
  const status = dryRun
    ? "dry_run"
    : applied.length === 0
      ? "blocked"
      : skipped.length > 0
        ? "partially_applied"
        : "applied";

  if (operation) {
    await completeWikiOperation({
      workspaceDir,
      operationId: operation.operationId,
      writtenFiles: changedFiles
    });
  }

  return {
    status,
    applied,
    skipped,
    changedFiles: dryRun ? [] : changedFiles,
    ...(operation ? {
      operationId: operation.operationId,
      operationJournalPath: operation.journalPath
    } : {}),
    ...(runVerification ? { verification: { lintBefore, lintAfter } } : {})
  };
}
