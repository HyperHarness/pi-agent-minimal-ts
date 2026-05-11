import { access, readFile } from "node:fs/promises";
import path from "node:path";
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
import {
  getPaperWikiIndexPath,
  getPaperWikiPagesDir,
  isSourceDerivedWikiPageKey,
  listPaperWikiPageFiles,
  listPaperWikiSourceFiles,
  relativeToWorkspace,
  sanitizeWikiFilename
} from "./store.js";
import { listTypedWikiPages, type WikiPageDiagnostic } from "./typed-store.js";

export type PaperWikiLintIssueKind =
  | "stale_index"
  | "broken_wiki_link"
  | "missing_source_citation"
  | "source_without_synthesis_coverage"
  | "source_derived_page_key"
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
  | "rendered_wiki_link"
  | "weak_evidence_contract"
  | "missing_claim_provenance"
  | "unresolved_contradiction"
  | "missing_typed_relation"
  | "missing_experiment_ref"
  | "code_backed_without_experiment";

export type PaperWikiLintSeverity = "high" | "medium" | "low";

export interface PaperWikiLintIssue {
  kind: PaperWikiLintIssueKind;
  severity: PaperWikiLintSeverity;
  path?: string;
  target?: string;
  concept?: string;
  count?: number;
  sourceCount?: number;
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
  summary: Record<string, number>;
  issues: PaperWikiLintIssue[];
  actions: string[];
  reports?: PaperWikiLintReports;
}

const ISSUE_KINDS: PaperWikiLintIssueKind[] = [
  "stale_index",
  "broken_wiki_link",
  "missing_source_citation",
  "source_without_synthesis_coverage",
  "source_derived_page_key",
  "orphan_page",
  "concept_gap",
  "high_value_concept_gap",
  "evidence_contract_gap",
  "semantic_alias_candidate",
  "scope_drift",
  "duplicate_page_title",
  "near_duplicate_page",
  "duplicate_section",
  "weak_synthesis_page",
  "rendered_wiki_link",
  "weak_evidence_contract",
  "missing_claim_provenance",
  "unresolved_contradiction",
  "missing_typed_relation",
  "missing_experiment_ref",
  "code_backed_without_experiment"
];
const DEFAULT_MAX_ITEMS = 30;
const TYPED_WIKI_PAGE_TYPES = new Set([
  "paper-source",
  "synthesis",
  "concept",
  "method",
  "finding",
  "dataset",
  "question",
  "design-record",
  "alias"
]);

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

function parseFrontmatterScalar(frontmatter: string, key: string): string | undefined {
  const rawValue = frontmatter
    .split("\n")
    .find((line) => line.startsWith(`${key}:`))
    ?.slice(key.length + 1)
    .trim();
  if (!rawValue) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawValue);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return rawValue.replace(/^"|"$/g, "").trim();
  }
}

function frontmatterOptsIntoTypedSchema(frontmatter: string): boolean {
  if (/^schema_version:/m.test(frontmatter)) {
    return true;
  }
  const type = parseFrontmatterScalar(frontmatter, "type");
  return Boolean(type && TYPED_WIKI_PAGE_TYPES.has(type));
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

function extractSourceCitationKeys(frontmatter: string): string[] {
  const keys = new Set<string>();
  for (const sourceRef of extractYamlStringValues(frontmatter, "source_refs")) {
    keys.add(sourceRef);
  }
  for (const match of frontmatter.matchAll(/^\s+paper_key:\s+(.+)$/gm)) {
    const rawValue = match[1]?.trim();
    if (!rawValue) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawValue);
      if (typeof parsed === "string" && parsed.trim()) {
        keys.add(parsed.trim());
      }
    } catch {
      keys.add(rawValue.replace(/^"|"$/g, "").trim());
    }
  }
  return [...keys].filter(Boolean);
}

function isAliasFrontmatter(frontmatter: string): boolean {
  return frontmatter.includes('type: "wiki-alias-page"') ||
    frontmatter.includes("type: wiki-alias-page") ||
    /^canonical_page:/m.test(frontmatter);
}

function extractMarkdownLinks(markdown: string): string[] {
  const links = new Set<string>();
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]?.trim();
    if (target?.startsWith("knowledge-base/")) {
      links.add(target);
    }
  }
  return [...links];
}

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

function sharedCitationKeyCount(
  left: { sourceCitationKeys: string[] },
  right: { sourceCitationKeys: string[] }
): number {
  const rightKeys = new Set(right.sourceCitationKeys);
  return left.sourceCitationKeys.filter((key) => rightKeys.has(key)).length;
}

function duplicateCanonicalSortKey(page: {
  pageKey: string;
  sourceCitationCount: number;
  bodyWords: number;
}): [number, number, number, string] {
  const pluralPenalty = /\b[a-z]+s\b/.test(page.pageKey.replace(/-/g, " ")) ? 1 : 0;
  return [
    -page.sourceCitationCount,
    -page.bodyWords,
    pluralPenalty,
    page.pageKey
  ];
}

function compareDuplicateCanonicalCandidates(
  left: {
    pageKey: string;
    sourceCitationCount: number;
    bodyWords: number;
  },
  right: {
    pageKey: string;
    sourceCitationCount: number;
    bodyWords: number;
  }
): number {
  const leftKey = duplicateCanonicalSortKey(left);
  const rightKey = duplicateCanonicalSortKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    const leftValue = leftKey[index];
    const rightValue = rightKey[index];
    if (typeof leftValue === "number" && typeof rightValue === "number" && leftValue !== rightValue) {
      return leftValue - rightValue;
    }
    if (typeof leftValue === "string" && typeof rightValue === "string" && leftValue !== rightValue) {
      return leftValue.localeCompare(rightValue);
    }
  }
  return 0;
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
    .map((value) => {
      const slug = value
        .split("|")[0]
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-|-$/g, "");
      return slug ? `knowledge-base/pages/${slug}.md` : undefined;
    })
    .filter((value): value is string => Boolean(value));
}

function summarizeActions(issues: PaperWikiLintIssue[]): string[] {
  const actionText = new Map<PaperWikiLintIssueKind, string>([
    ["stale_index", "Rebuild index.md so every synthesis page is discoverable."],
    ["broken_wiki_link", "Fix or regenerate markdown links that point to missing wiki files."],
    ["missing_source_citation", "Repair synthesis page source citations or regenerate the page from source summaries."],
    ["source_without_synthesis_coverage", "Promote or cite ready sources that are not referenced by any synthesis page."],
    ["source_derived_page_key", "Rename source-derived page files to semantic concept keys, or convert one-paper notes back into source summaries."],
    ["orphan_page", "Add related_pages or links from another page so synthesis pages form a navigable graph."],
    ["concept_gap", "Promote repeated source tags into durable topic pages with build_wiki_page."],
    ["high_value_concept_gap", "Build high-priority concept pages identified by maintenance triage."],
    ["evidence_contract_gap", "Add explicit source citations or scope notes to pages with weak evidence contracts."],
    ["semantic_alias_candidate", "Review semantic alias candidates and merge aliases into canonical pages."],
    ["scope_drift", "Update stale page framing so central sections match the current wiki goal."],
    ["duplicate_page_title", "Merge duplicate-title synthesis pages or convert secondary pages into aliases."],
    ["near_duplicate_page", "Review near-duplicate concept pages and add aliases when one page is canonical."],
    ["duplicate_section", "Normalize synthesis pages so each section title appears once."],
    ["weak_synthesis_page", "Convert short uncited pages into aliases or rebuild them with source-backed evidence."],
    ["rendered_wiki_link", "Fix double-bracket wiki links that render to missing local pages."],
    ["weak_evidence_contract", "Add source_refs to paper-backed typed wiki pages or weaken the evidence contract."],
    ["missing_claim_provenance", "Add concrete page, figure, table, element, chunk, or code-output provenance to quantitative claims."],
    ["unresolved_contradiction", "Review contradiction candidates and mark them confirmed or rejected."],
    ["missing_typed_relation", "Replace legacy related_pages with typed_relations."],
    ["missing_experiment_ref", "Fix experiment_refs paths or update the experiment status."],
    ["code_backed_without_experiment", "Attach local experiment_refs to code-backed or mixed pages when claims depend on code."]
  ]);
  const counts = new Map<PaperWikiLintIssueKind, number>();
  for (const issue of issues) {
    counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  }
  const seen = new Set<PaperWikiLintIssueKind>();
  const actions: string[] = [];
  for (const issue of issues) {
    if (seen.has(issue.kind)) {
      continue;
    }
    seen.add(issue.kind);
    const text = actionText.get(issue.kind);
    const count = counts.get(issue.kind) ?? 0;
    if (text && count > 0) {
      actions.push(`${count}: ${text}`);
    }
  }
  return actions;
}

function issueRank(issue: PaperWikiLintIssue): number {
  const rank: Record<PaperWikiLintSeverity, number> = { high: 0, medium: 1, low: 2 };
  return rank[issue.severity];
}

function diagnosticReason(diagnostic: WikiPageDiagnostic): string {
  return diagnostic.errors.map((error) => error.message).join(" ");
}

async function diagnosticOptsIntoTypedSchema(diagnostic: WikiPageDiagnostic): Promise<boolean> {
  const markdown = await readFile(diagnostic.path, "utf8").catch(() => "");
  return frontmatterOptsIntoTypedSchema(extractFrontmatter(markdown));
}

function diagnosticHasOnlyMissingSourceRefs(diagnostic: WikiPageDiagnostic): boolean {
  return diagnostic.errors.length > 0 && diagnostic.errors.every((error) => error.code === "missing_source_refs");
}

function diagnosticHasClaimProvenanceError(diagnostic: WikiPageDiagnostic): boolean {
  return diagnostic.errors.some((error) => error.code === "invalid_claim_provenance");
}

function claimHasConcreteEvidence(claim: {
  evidence: Array<{
    page?: number;
    figure?: string;
    table?: string;
    elementId?: string;
    chunkId?: string;
    codeOutputPath?: string;
  }>;
}): boolean {
  return claim.evidence.some((item) =>
    item.page !== undefined ||
    Boolean(item.figure) ||
    Boolean(item.table) ||
    Boolean(item.elementId) ||
    Boolean(item.chunkId) ||
    Boolean(item.codeOutputPath)
  );
}

function hasConceptGapIssue(issues: PaperWikiLintIssue[], concept: string): boolean {
  return issues.some((issue) =>
    (issue.kind === "concept_gap" || issue.kind === "high_value_concept_gap") &&
    issue.concept === concept
  );
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
  const pageMetadata: Array<{
    pageKey: string;
    title: string;
    normalizedTitle: string;
    path: string;
    isAlias: boolean;
    sourceCitationCount: number;
    sourceCitationKeys: string[];
    sectionTitles: string[];
    bodyWords: number;
  }> = [];
  const typedCitedPagePaths = new Set<string>();

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
      const pageMatch = target.match(/knowledge-base\/pages\/([^/]+)\.md$/);
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
    const title = extractMarkdownTitle(markdown, pageKey);
    const sectionTitles = extractSectionTitles(markdown);
    const typedSourceRefCount = frontmatterOptsIntoTypedSchema(frontmatter)
      ? extractYamlStringValues(frontmatter, "source_refs").length
      : 0;
    const sourceCitationKeys = extractSourceCitationKeys(frontmatter);
    const sourceCitationCount = extractSourceCitationPaths(frontmatter).length + typedSourceRefCount;
    const isAlias = isAliasFrontmatter(frontmatter);
    if (typedSourceRefCount > 0) {
      typedCitedPagePaths.add(relativePath);
    }
    pageMetadata.push({
      pageKey,
      title,
      normalizedTitle: normalizeTitleForDuplicate(title),
      path: relativePath,
      isAlias,
      sourceCitationCount,
      sourceCitationKeys,
      sectionTitles,
      bodyWords: countBodyWords(markdown)
    });

    if (!isAlias && isSourceDerivedWikiPageKey(pageKey)) {
      issues.push({
        kind: "source_derived_page_key",
        severity: "medium",
        path: relativePath,
        reason: "Synthesis page key is derived from a paper/source identifier instead of a durable concept name."
      });
    }

    if (!isAlias) {
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
            target: sectionTitle,
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
      const pageMatch = target.match(/knowledge-base\/pages\/([^/]+)\.md$/);
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

  const exactTitles = new Map<string, typeof pageMetadata>();
  const normalizedTitles = new Map<string, typeof pageMetadata>();
  for (const page of pageMetadata) {
    if (page.isAlias) {
      continue;
    }
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
      const canonical = [...pages].sort(compareDuplicateCanonicalCandidates)[0];
      const lowRiskPages = pages
        .filter((page) => page.pageKey !== canonical.pageKey)
        .filter((page) => sharedCitationKeyCount(canonical, page) > 0);
      const lowRiskPageKeys = new Set(lowRiskPages.map((page) => page.pageKey));
      for (const page of lowRiskPages) {
        issues.push({
          kind: "near_duplicate_page",
          severity: "low",
          path: page.path,
          target: canonical.pageKey,
          reason: `Low-risk duplicate concept page: normalized title and shared source evidence match canonical page ${canonical.pageKey}.`
        });
      }
      const mediumPages = lowRiskPages.length > 0
        ? pages.filter((candidate) => candidate.pageKey !== canonical.pageKey && !lowRiskPageKeys.has(candidate.pageKey))
        : pages;
      for (const page of mediumPages) {
        issues.push({
          kind: "near_duplicate_page",
          severity: "medium",
          path: page.path,
          reason: `Page title is near-duplicate with: ${pages.map((item) => item.pageKey).join(", ")}.`
        });
      }
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

  const reports: PaperWikiLintReports = {};
  reports.conceptTriage = await rankConceptGaps({
    workspaceDir,
    ...(options.goal !== undefined ? { goal: options.goal } : {}),
    ...(options.focus !== undefined ? { focus: options.focus } : {})
  });
  for (const concept of reports.conceptTriage.rankedConcepts) {
    if (
      concept.sourceCount >= 2 &&
      concept.recommendedAction === "build_page" &&
      !hasConceptGapIssue(issues, concept.concept)
    ) {
      issues.push({
        kind: "concept_gap",
        severity: "low",
        concept: concept.concept,
        count: concept.sourceCount,
        sourceCount: concept.sourceCount,
        target: path.join(relativeToWorkspace(workspaceDir, getPaperWikiPagesDir(workspaceDir)), `${concept.concept}.md`),
        reason: "Repeated source tag has no durable synthesis page."
      });
    }
  }
  const hasOptimizationIntent = Boolean(options.goal?.trim()) ||
    (options.focus?.some((item) => item.trim().length > 0) ?? false);
  if (hasOptimizationIntent) {
    for (const concept of reports.conceptTriage.rankedConcepts) {
      if (concept.priority === "high" && concept.recommendedAction === "build_page") {
        issues.push({
          kind: "high_value_concept_gap",
          severity: "medium",
          concept: concept.concept,
          count: concept.sourceCount,
          sourceCount: concept.sourceCount,
          score: concept.score,
          target: path.join(relativeToWorkspace(workspaceDir, getPaperWikiPagesDir(workspaceDir)), `${concept.concept}.md`),
          reason: concept.rationale
        });
      }
    }
  }

  if (options.includeCoverage) {
    reports.coverage = await buildWikiCoverageMap({ workspaceDir });
    for (const source of reports.coverage.uncoveredSources) {
      issues.push({
        kind: "source_without_synthesis_coverage",
        severity: "medium",
        path: source.path,
        target: source.paperKey,
        reason: "Ready source is not referenced by any synthesis or typed page source citation."
      });
    }
  }

  if (options.includeQualityAudit) {
    const typedPages = await listTypedWikiPages({
      workspaceDir,
      includeSources: false,
      includePages: true
    });
    const weakEvidencePaths = new Set<string>();
    for (const diagnostic of typedPages.diagnostics) {
      if (diagnosticHasClaimProvenanceError(diagnostic)) {
        issues.push({
          kind: "missing_claim_provenance",
          severity: "high",
          path: diagnostic.relativePath,
          reason: diagnosticReason(diagnostic)
        });
      }
      if (
        !(await diagnosticOptsIntoTypedSchema(diagnostic)) ||
        !diagnosticHasOnlyMissingSourceRefs(diagnostic)
      ) {
        continue;
      }
      weakEvidencePaths.add(diagnostic.relativePath);
      issues.push({
        kind: "weak_evidence_contract",
        severity: "medium",
        path: diagnostic.relativePath,
        reason: diagnosticReason(diagnostic)
      });
    }
    for (const page of typedPages.pages) {
      const relativePath = relativeToWorkspace(workspaceDir, page.path);
      for (const claim of page.metadata.claims ?? []) {
        if (claim.kind === "quantitative" && !claimHasConcreteEvidence(claim)) {
          issues.push({
            kind: "missing_claim_provenance",
            severity: "high",
            path: relativePath,
            target: claim.claimId,
            reason: "Quantitative claim lacks concrete paper location or code output provenance."
          });
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
        const experimentPaths = [
          experiment.scriptPath,
          experiment.resultPath,
          experiment.logPath,
          ...(experiment.artifactPaths ?? [])
        ].filter((candidate): candidate is string => Boolean(candidate));
        for (const experimentPath of experimentPaths) {
          if (!(await pathExists(path.resolve(workspaceDir, experimentPath)))) {
            issues.push({
              kind: "missing_experiment_ref",
              severity: experiment.status === "planned" ? "low" : "medium",
              path: relativePath,
              target: experimentPath,
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
      if (
        page.metadata.evidence_contract === "paper-backed" &&
        page.metadata.source_refs.length === 0 &&
        !weakEvidencePaths.has(relativePath)
      ) {
        issues.push({
          kind: "weak_evidence_contract",
          severity: "medium",
          path: relativePath,
          reason: "Paper-backed wiki page has no source_refs."
        });
      }
    }

    reports.pageQuality = await auditPageEvidenceContracts({ workspaceDir });
    for (const gap of reports.pageQuality.evidenceContractGaps) {
      if (typedCitedPagePaths.has(gap.path)) {
        continue;
      }
      issues.push({
        kind: "evidence_contract_gap",
        severity: gap.inferredContract === "unverified" ? "medium" : "low",
        path: gap.path,
        target: gap.pageKey,
        count: gap.sourceCount,
        sourceCount: gap.sourceCount,
        reason: gap.reason
      });
    }

    const staleTerms = ["million-qubit", "million qubit"];
    reports.scopeDrift = await auditScopeDrift({
      workspaceDir,
      staleTerms,
      ...(options.goal !== undefined ? { preferredFraming: options.goal } : {})
    });
    for (const drift of reports.scopeDrift.findings) {
      issues.push({
        kind: "scope_drift",
        severity: drift.severity,
        path: drift.path,
        target: drift.pageKey,
        reason: drift.evidence.join(" ")
      });
    }
  }

  if (options.includeAliasCandidates) {
    reports.aliasCandidates = await suggestSemanticAliases({ workspaceDir });
    for (const suggestion of reports.aliasCandidates.suggestions) {
      issues.push({
        kind: "semantic_alias_candidate",
        severity: suggestion.risk === "low" ? "low" : "medium",
        path: `knowledge-base/pages/${suggestion.aliasPageKey}.md`,
        target: suggestion.canonicalPageKey,
        score: suggestion.score,
        reason: suggestion.evidence.join("; ")
      });
    }
  }

  const summary = Object.fromEntries(ISSUE_KINDS.map((kind) => [kind, 0])) as Record<string, number>;
  for (const issue of issues) {
    summary[issue.kind] = (summary[issue.kind] ?? 0) + 1;
  }
  const sortedIssues = issues.sort((left, right) =>
    issueRank(left) - issueRank(right) ||
    left.kind.localeCompare(right.kind) ||
    (left.path ?? left.concept ?? "").localeCompare(right.path ?? right.concept ?? "")
  );

  const result: PaperWikiLintResult = {
    pageCount: pageFiles.length,
    sourceCount: sourceFiles.length,
    issueCount: issues.length,
    summary,
    issues: sortedIssues.slice(0, maxItems),
    actions: summarizeActions(sortedIssues)
  };
  if (Object.keys(reports).length > 0) {
    result.reports = reports;
  }
  return result;
}
