import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  getPaperWikiIndexPath,
  getPaperWikiPagesDir,
  listPaperWikiPageFiles,
  listPaperWikiSourceFiles,
  relativeToWorkspace,
  sanitizeWikiFilename
} from "./paper-wiki-store.js";

export type PaperWikiLintIssueKind =
  | "stale_index"
  | "broken_wiki_link"
  | "missing_source_citation"
  | "orphan_page"
  | "concept_gap";

export type PaperWikiLintSeverity = "high" | "medium" | "low";

export interface PaperWikiLintIssue {
  kind: PaperWikiLintIssueKind;
  severity: PaperWikiLintSeverity;
  path?: string;
  target?: string;
  concept?: string;
  count?: number;
  reason: string;
}

export interface PaperWikiLintOptions {
  workspaceDir: string;
  maxItems?: number;
}

export interface PaperWikiLintResult {
  pageCount: number;
  sourceCount: number;
  issueCount: number;
  summary: Record<PaperWikiLintIssueKind, number>;
  issues: PaperWikiLintIssue[];
  actions: string[];
}

const ISSUE_KINDS: PaperWikiLintIssueKind[] = [
  "stale_index",
  "broken_wiki_link",
  "missing_source_citation",
  "orphan_page",
  "concept_gap"
];
const DEFAULT_MAX_ITEMS = 30;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractFrontmatter(markdown: string): string {
  return markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
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
    if (!value) {
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

function extractSourceCitationPaths(frontmatter: string): string[] {
  return frontmatter
    .split("\n")
    .map((line) => line.match(/^\s+path:\s+(.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      try {
        const parsed = JSON.parse(value);
        return typeof parsed === "string" ? parsed : value;
      } catch {
        return value.replace(/^"|"$/g, "");
      }
    });
}

function extractMarkdownLinks(markdown: string): string[] {
  const links = new Set<string>();
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]?.trim();
    if (target?.startsWith("knowledge-base/wiki/")) {
      links.add(target);
    }
  }
  return [...links];
}

function summarizeActions(issues: PaperWikiLintIssue[]): string[] {
  const counts = new Map<PaperWikiLintIssueKind, number>();
  for (const issue of issues) {
    counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  }
  return [
    ["stale_index", "Rebuild index.md so every synthesis page is discoverable."],
    ["broken_wiki_link", "Fix or regenerate markdown links that point to missing wiki files."],
    ["missing_source_citation", "Repair synthesis page source citations or regenerate the page from source summaries."],
    ["orphan_page", "Add related_pages or links from another page so synthesis pages form a navigable graph."],
    ["concept_gap", "Promote repeated source tags into durable topic pages with build_wiki_page."]
  ].flatMap(([kind, text]) => {
    const count = counts.get(kind as PaperWikiLintIssueKind) ?? 0;
    return count > 0 ? [`${count}: ${text}`] : [];
  });
}

function issueRank(issue: PaperWikiLintIssue): number {
  const rank: Record<PaperWikiLintSeverity, number> = { high: 0, medium: 1, low: 2 };
  return rank[issue.severity];
}

export async function lintPaperWiki(options: PaperWikiLintOptions): Promise<PaperWikiLintResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const maxItems = Math.max(1, Math.trunc(options.maxItems ?? DEFAULT_MAX_ITEMS));
  const [sourceFiles, pageFiles] = await Promise.all([
    listPaperWikiSourceFiles(workspaceDir),
    listPaperWikiPageFiles(workspaceDir)
  ]);
  const issues: PaperWikiLintIssue[] = [];
  const indexPath = getPaperWikiIndexPath(workspaceDir);
  const indexMarkdown = await readFile(indexPath, "utf8").catch(() => "");

  for (const filePath of pageFiles) {
    const workspaceRelativePath = relativeToWorkspace(workspaceDir, filePath);
    const wikiRelativePath = path.relative(path.dirname(indexPath), filePath).split(path.sep).join("/");
    if (!indexMarkdown.includes(workspaceRelativePath) && !indexMarkdown.includes(wikiRelativePath)) {
      issues.push({
        kind: "stale_index",
        severity: "medium",
        path: workspaceRelativePath,
        reason: "Wiki index does not list this synthesis page."
      });
    }
  }

  const incomingPageLinks = new Map<string, number>();
  const sourceTagCounts = new Map<string, number>();

  for (const filePath of sourceFiles) {
    const markdown = await readFile(filePath, "utf8");
    const frontmatter = extractFrontmatter(markdown);
    for (const tag of extractYamlStringValues(frontmatter, "tags")) {
      const normalized = sanitizeWikiFilename(tag.toLowerCase());
      sourceTagCounts.set(normalized, (sourceTagCounts.get(normalized) ?? 0) + 1);
    }
    for (const target of extractMarkdownLinks(markdown)) {
      const targetPath = path.resolve(workspaceDir, target);
      if (!(await pathExists(targetPath))) {
        issues.push({
          kind: "broken_wiki_link",
          severity: "high",
          path: relativeToWorkspace(workspaceDir, filePath),
          target,
          reason: "Markdown link points to a missing wiki file."
        });
      }
      const pageMatch = target.match(/knowledge-base\/wiki\/pages\/([^/]+)\.md$/);
      if (pageMatch?.[1]) {
        incomingPageLinks.set(pageMatch[1], (incomingPageLinks.get(pageMatch[1]) ?? 0) + 1);
      }
    }
  }

  for (const filePath of pageFiles) {
    const markdown = await readFile(filePath, "utf8");
    const relativePath = relativeToWorkspace(workspaceDir, filePath);
    const pageKey = path.basename(filePath, ".md");
    const frontmatter = extractFrontmatter(markdown);
    const relatedPages = extractYamlStringValues(frontmatter, "related_pages");
    for (const relatedPage of relatedPages) {
      incomingPageLinks.set(sanitizeWikiFilename(relatedPage), (incomingPageLinks.get(sanitizeWikiFilename(relatedPage)) ?? 0) + 1);
    }

    for (const citationPath of extractSourceCitationPaths(frontmatter)) {
      const resolvedCitationPath = path.resolve(workspaceDir, citationPath);
      if (!(await pathExists(resolvedCitationPath))) {
        issues.push({
          kind: "missing_source_citation",
          severity: "high",
          path: relativePath,
          target: citationPath,
          reason: "Synthesis page cites a source summary path that does not exist."
        });
      }
    }

    for (const target of extractMarkdownLinks(markdown)) {
      const targetPath = path.resolve(workspaceDir, target);
      if (!(await pathExists(targetPath))) {
        issues.push({
          kind: "broken_wiki_link",
          severity: "high",
          path: relativePath,
          target,
          reason: "Markdown link points to a missing wiki file."
        });
      }
      const pageMatch = target.match(/knowledge-base\/wiki\/pages\/([^/]+)\.md$/);
      if (pageMatch?.[1]) {
        incomingPageLinks.set(pageMatch[1], (incomingPageLinks.get(pageMatch[1]) ?? 0) + 1);
      }
    }

    if (pageFiles.length > 1 && relatedPages.length === 0 && (incomingPageLinks.get(pageKey) ?? 0) === 0) {
      issues.push({
        kind: "orphan_page",
        severity: "low",
        path: relativePath,
        reason: "Synthesis page has no related_pages and no inbound page links."
      });
    }
  }

  const pageKeys = new Set(pageFiles.map((filePath) => path.basename(filePath, ".md")));
  for (const [concept, count] of sourceTagCounts) {
    if (count >= 2 && !pageKeys.has(concept)) {
      issues.push({
        kind: "concept_gap",
        severity: "low",
        concept,
        count,
        target: path.join(relativeToWorkspace(workspaceDir, getPaperWikiPagesDir(workspaceDir)), `${concept}.md`),
        reason: "Repeated source tag has no durable synthesis page."
      });
    }
  }

  const summary = Object.fromEntries(ISSUE_KINDS.map((kind) => [kind, 0])) as Record<PaperWikiLintIssueKind, number>;
  for (const issue of issues) {
    summary[issue.kind] += 1;
  }
  const sortedIssues = issues.sort((left, right) =>
    issueRank(left) - issueRank(right) ||
    left.kind.localeCompare(right.kind) ||
    (left.path ?? left.concept ?? "").localeCompare(right.path ?? right.concept ?? "")
  );

  return {
    pageCount: pageFiles.length,
    sourceCount: sourceFiles.length,
    issueCount: issues.length,
    summary,
    issues: sortedIssues.slice(0, maxItems),
    actions: summarizeActions(issues)
  };
}
