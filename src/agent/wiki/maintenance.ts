import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  getPaperWikiManifestsDir,
  getPaperWikiSourcePath,
  listPaperWikiPageFiles,
  listPaperWikiSourceFiles,
  paperKeyFromPaperWikiSourcePath,
  relativeToWorkspace,
  sanitizeWikiFilename
} from "./store.js";

export interface WikiMaintenanceSourceCitation {
  paperKey: string;
  title?: string;
  path?: string;
}

export interface WikiMaintenanceSourceDocument {
  paperKey: string;
  title: string;
  path: string;
  tags: string[];
  relatedPaperKeys: string[];
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface WikiMaintenanceUncoveredSource extends WikiMaintenanceSourceDocument {
  reason: "not_cited_by_any_page";
  candidatePageKeys: string[];
}

export interface WikiMaintenancePageDocument {
  pageKey: string;
  title: string;
  path: string;
  isAlias: boolean;
  canonicalPageKey?: string;
  relatedPageKeys: string[];
  sourceCitations: WikiMaintenanceSourceCitation[];
  tags: string[];
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface WikiMaintenanceDocuments {
  workspaceDir: string;
  sources: WikiMaintenanceSourceDocument[];
  pages: WikiMaintenancePageDocument[];
}

export interface WikiCoverageTagCluster {
  tag: string;
  sourceCount: number;
  sourcePaperKeys: string[];
  existingPageKey?: string;
}

export interface WikiCoverageWeakPage {
  pageKey: string;
  title: string;
  path: string;
  sourceCount: number;
}

export interface WikiMaintenanceWorkspaceOptions {
  workspaceDir: string;
}

export type BuildWikiCoverageMapOptions = WikiMaintenanceWorkspaceOptions;

export interface WikiCoverageMapResult {
  sourceCount: number;
  pageCount: number;
  coveredSourceCount: number;
  uncoveredSources: WikiMaintenanceUncoveredSource[];
  weaklyCoveredPages: WikiCoverageWeakPage[];
  tagClusters: WikiCoverageTagCluster[];
}

export type ConceptGapAction = "build_page" | "alias_to_existing" | "defer";
export type ConceptGapPriority = "high" | "medium" | "low";
export type ConceptGapReadiness = "ready" | "needs_summary" | "needs_acquisition";

export interface ConceptGapRepresentativeSource {
  paperKey: string;
  title: string;
  path: string;
}

export interface ConceptGap {
  concept: string;
  sourceCount: number;
  sourcePaperKeys: string[];
  priority: ConceptGapPriority;
  score: number;
  evidenceReadiness: ConceptGapReadiness;
  recommendedAction: ConceptGapAction;
  candidateCanonicalPage?: string;
  representativeSources: ConceptGapRepresentativeSource[];
  rationale: string;
}

export interface RankConceptGapsOptions extends WikiMaintenanceWorkspaceOptions {
  goal?: string;
  focus?: string[];
  minSourceCount?: number;
}

export interface ConceptGapTriageResult {
  rankedConcepts: ConceptGap[];
}

export type PageEvidenceContract = "paper-backed" | "design-backed" | "code-backed" | "mixed" | "unverified";

export interface PageEvidenceContractIssue {
  pageKey: string;
  title: string;
  path: string;
  inferredContract: PageEvidenceContract;
  sourceCount: number;
  reason: string;
}

export type AuditPageEvidenceContractsOptions = WikiMaintenanceWorkspaceOptions;

export interface PageEvidenceContractAuditResult {
  evidenceContractGaps: PageEvidenceContractIssue[];
}

export interface SemanticAliasSuggestion {
  canonicalPageKey: string;
  aliasPageKey: string;
  score: number;
  risk: "low" | "medium";
  evidence: string[];
}

export interface SuggestSemanticAliasesOptions extends WikiMaintenanceWorkspaceOptions {
  minScore?: number;
}

export interface SemanticAliasSuggestionResult {
  suggestions: SemanticAliasSuggestion[];
}

export interface ScopeDriftIssue {
  pageKey: string;
  path: string;
  kind: "scope_drift";
  severity: "high" | "medium" | "low";
  evidence: string[];
  suggestedScopeNote: string;
}

export interface AuditScopeDriftOptions extends WikiMaintenanceWorkspaceOptions {
  staleTerms: string[];
  preferredFraming?: string;
}

export interface ScopeDriftAuditResult {
  findings: ScopeDriftIssue[];
}

type ParsedMarkdown = {
  frontmatter: Record<string, unknown>;
  body: string;
};

export async function readWikiMaintenanceDocuments(workspaceDir: string): Promise<WikiMaintenanceDocuments> {
  const [sourceFiles, manifestFiles, pageFiles] = await Promise.all([
    listPaperWikiSourceFiles(workspaceDir),
    listSourceManifestFiles(workspaceDir),
    listPaperWikiPageFiles(workspaceDir)
  ]);

  const [summarySources, manifestSources] = await Promise.all([
    Promise.all(sourceFiles.map((filePath) => readSourceDocument(workspaceDir, filePath))),
    Promise.all(manifestFiles.map((filePath) => readSourceManifestDocument(workspaceDir, filePath)))
  ]);
  const pages = await Promise.all(pageFiles.map((filePath) => readPageDocument(workspaceDir, filePath)));
  const sources = mergeSourceDocuments(summarySources, manifestSources.filter((source): source is WikiMaintenanceSourceDocument => Boolean(source)));
  return { workspaceDir, sources, pages };
}

export async function buildWikiCoverageMap(options: BuildWikiCoverageMapOptions): Promise<WikiCoverageMapResult> {
  return buildWikiCoverageMapFromDocuments(await readWikiMaintenanceDocuments(options.workspaceDir));
}

export async function rankConceptGaps(options: RankConceptGapsOptions): Promise<ConceptGapTriageResult> {
  const documents = await readWikiMaintenanceDocuments(options.workspaceDir);
  return {
    rankedConcepts: rankConceptGapsFromDocuments(documents, options)
  };
}

export async function auditPageEvidenceContracts(
  options: AuditPageEvidenceContractsOptions
): Promise<PageEvidenceContractAuditResult> {
  const documents = await readWikiMaintenanceDocuments(options.workspaceDir);
  return {
    evidenceContractGaps: auditPageEvidenceContractsFromDocuments(documents)
  };
}

export async function suggestSemanticAliases(
  options: SuggestSemanticAliasesOptions
): Promise<SemanticAliasSuggestionResult> {
  const documents = await readWikiMaintenanceDocuments(options.workspaceDir);
  return {
    suggestions: suggestSemanticAliasesFromDocuments(documents, options)
  };
}

export async function auditScopeDrift(options: AuditScopeDriftOptions): Promise<ScopeDriftAuditResult> {
  const documents = await readWikiMaintenanceDocuments(options.workspaceDir);
  return {
    findings: auditScopeDriftFromDocuments(documents, options)
  };
}

function buildWikiCoverageMapFromDocuments(options: WikiMaintenanceDocuments): WikiCoverageMapResult {
  const sourceKeys = new Set(options.sources.map((source) => source.paperKey));
  const coveredKeys = new Set<string>();
  for (const page of options.pages) {
    for (const citation of page.sourceCitations) {
      if (sourceKeys.has(citation.paperKey)) {
        coveredKeys.add(citation.paperKey);
      }
    }
  }

  const tagClusters = buildTagClusters(options.sources, options.pages);

  return {
    sourceCount: options.sources.length,
    pageCount: options.pages.length,
    coveredSourceCount: coveredKeys.size,
    uncoveredSources: options.sources
      .filter((source) => !coveredKeys.has(source.paperKey))
      .map((source) => ({
        ...source,
        reason: "not_cited_by_any_page" as const,
        candidatePageKeys: candidatePageKeysForSource(source, options.pages)
      }))
      .sort((left, right) => left.paperKey.localeCompare(right.paperKey)),
    weaklyCoveredPages: options.pages
      .filter((page) => !page.isAlias && page.sourceCitations.length === 1)
      .map((page) => ({
        pageKey: page.pageKey,
        title: page.title,
        path: page.path,
        sourceCount: page.sourceCitations.length
      }))
      .sort((left, right) => left.pageKey.localeCompare(right.pageKey)),
    tagClusters
  };
}

function rankConceptGapsFromDocuments(
  documents: WikiMaintenanceDocuments,
  options: Pick<RankConceptGapsOptions, "goal" | "focus" | "minSourceCount">
): ConceptGap[] {
  const minSourceCount = options.minSourceCount ?? 2;
  const goalTokens = tokenize(`${options.goal ?? ""} ${(options.focus ?? []).join(" ")}`);
  const clusters = buildTagClusters(documents.sources, documents.pages);

  return clusters
    .filter((cluster) => cluster.sourceCount >= minSourceCount || cluster.existingPageKey)
    .map((cluster) => {
      const tagTokens = tokenize(cluster.tag);
      const sourceContextTokens = tokenize(
        documents.sources
          .filter((source) => cluster.sourcePaperKeys.includes(source.paperKey))
          .map((source) => `${source.title} ${source.tags.join(" ")} ${source.body}`)
          .join(" ")
      );
      const overlap = Math.max(countOverlap(tagTokens, goalTokens), countOverlap(sourceContextTokens, goalTokens));
      const specificityBonus = [...tagTokens].some((token) => !goalTokens.has(token)) ? 1 : 0;
      const actionPenalty = cluster.existingPageKey ? 1 : 0;
      const score = cluster.sourceCount + overlap * 2 + specificityBonus - actionPenalty;
      const suggestedAction = cluster.existingPageKey
        ? "defer"
        : findClosePageKey(cluster.tag, documents.pages)
          ? "alias_to_existing"
          : "build_page";
      const closePageKey = suggestedAction === "alias_to_existing" ? findClosePageKey(cluster.tag, documents.pages) : undefined;
      const representativeSources = documents.sources
        .filter((source) => cluster.sourcePaperKeys.includes(source.paperKey))
        .sort((left, right) => left.paperKey.localeCompare(right.paperKey))
        .map((source) => ({
          paperKey: source.paperKey,
          title: source.title,
          path: source.path
        }));
      const conceptGap: ConceptGap = {
        concept: cluster.tag,
        sourceCount: cluster.sourceCount,
        sourcePaperKeys: cluster.sourcePaperKeys,
        priority: score >= 6 || (cluster.sourceCount >= 2 && overlap >= 1) ? "high" : score >= 3 ? "medium" : "low",
        score,
        evidenceReadiness: cluster.sourceCount >= minSourceCount ? "ready" : "needs_summary",
        recommendedAction: suggestedAction,
        representativeSources,
        rationale: `${cluster.sourceCount} source${cluster.sourceCount === 1 ? "" : "s"} mention ${cluster.tag}; goal overlap ${overlap}.`
      };
      const candidateCanonicalPage = cluster.existingPageKey ?? closePageKey;
      if (candidateCanonicalPage) {
        conceptGap.candidateCanonicalPage = candidateCanonicalPage;
      }
      return conceptGap;
    })
    .sort((left, right) => right.score - left.score || right.sourceCount - left.sourceCount || left.concept.localeCompare(right.concept));
}

function auditPageEvidenceContractsFromDocuments(options: WikiMaintenanceDocuments): PageEvidenceContractIssue[] {
  return options.pages
    .filter((page) => !page.isAlias)
    .map((page): PageEvidenceContractIssue | null => {
      const evidenceContract = inferEvidenceContract(page);
      if (page.sourceCitations.length > 0 && evidenceContract !== "unverified") {
        return null;
      }
      if (page.sourceCitations.length === 0 || evidenceContract === "unverified") {
        return {
          pageKey: page.pageKey,
          title: page.title,
          path: page.path,
          inferredContract: evidenceContract,
          sourceCount: page.sourceCitations.length,
          reason:
            page.sourceCitations.length === 0
              ? "Page has no source citations."
              : "Page citations do not establish an evidence contract."
        };
      }
      return null;
    })
    .filter((issue): issue is PageEvidenceContractIssue => issue !== null)
    .sort((left, right) => left.pageKey.localeCompare(right.pageKey));
}

function suggestSemanticAliasesFromDocuments(
  documents: WikiMaintenanceDocuments,
  options: Pick<SuggestSemanticAliasesOptions, "minScore">
): SemanticAliasSuggestion[] {
  const minScore = options.minScore ?? 0.55;
  const pages = documents.pages.filter((page) => !page.isAlias);
  const suggestions: SemanticAliasSuggestion[] = [];

  for (let leftIndex = 0; leftIndex < pages.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < pages.length; rightIndex += 1) {
      const left = pages[leftIndex];
      const right = pages[rightIndex];
      const leftTokens = tokenizeForSemanticAlias(`${left.title} ${left.pageKey}`);
      const rightTokens = tokenizeForSemanticAlias(`${right.title} ${right.pageKey}`);
      const tokenOverlap = [...leftTokens].filter((token) => rightTokens.has(token)).sort();
      const sharedPaperKeys = sharedCitationKeys(left, right);
      if (sharedPaperKeys.length === 0) {
        continue;
      }
      if (!isPlausibleSemanticAlias({ left, right, leftTokens, rightTokens, tokenOverlap })) {
        continue;
      }
      const unionSize = new Set([...leftTokens, ...rightTokens]).size || 1;
      const tokenScore = tokenOverlap.length / unionSize;
      const sourceScore = sharedPaperKeys.length / Math.max(left.sourceCitations.length, right.sourceCitations.length, 1);
      const score = Number((tokenScore * 0.7 + sourceScore * 0.3).toFixed(3));
      if (score >= minScore) {
        suggestions.push({
          canonicalPageKey: left.pageKey.localeCompare(right.pageKey) <= 0 ? left.pageKey : right.pageKey,
          aliasPageKey: left.pageKey.localeCompare(right.pageKey) <= 0 ? right.pageKey : left.pageKey,
          score,
          risk: score >= 0.65 || sharedPaperKeys.length >= 1 && tokenScore >= 0.45 ? "low" : "medium",
          evidence: [
            `shared sources: ${sharedPaperKeys.join(", ")}`,
            `overlapping tokens: ${tokenOverlap.join(", ")}`
          ]
        });
      }
    }
  }

  return suggestions.sort((left, right) => right.score - left.score || left.canonicalPageKey.localeCompare(right.canonicalPageKey));
}

const SEMANTIC_ALIAS_GENERIC_TOKENS = new Set([
  "architecture",
  "automated",
  "automation",
  "computing",
  "design",
  "fault",
  "hardware",
  "high",
  "level",
  "llm4eda",
  "processor",
  "quantum",
  "research",
  "roadmap",
  "superconducting",
  "synthesis",
  "system",
  "tolerant"
]);

function stemSemanticAliasToken(token: string): string {
  const stems: Record<string, string> = {
    architectures: "architecture",
    codes: "code",
    gates: "gate",
    processors: "processor",
    systems: "system"
  };
  return stems[token] ?? token;
}

function tokenizeForSemanticAlias(value: string): Set<string> {
  return new Set([...tokenize(value)]
    .map(stemSemanticAliasToken)
    .filter((token) => !SEMANTIC_ALIAS_GENERIC_TOKENS.has(token)));
}

function hasVersionedSpecificationMarker(page: WikiMaintenancePageDocument): boolean {
  const text = `${page.title} ${page.pageKey}`.toLowerCase();
  return /\bv?\d+(?:[-.]\d+)+\b/.test(text) ||
    /(?:^|[-\s])(spec|specification|version|revision|draft)(?:$|[-\s])/.test(text);
}

function isPlausibleSemanticAlias(input: {
  left: WikiMaintenancePageDocument;
  right: WikiMaintenancePageDocument;
  leftTokens: Set<string>;
  rightTokens: Set<string>;
  tokenOverlap: string[];
}): boolean {
  if (input.tokenOverlap.length < 2) {
    return false;
  }

  const smallerTokenCount = Math.min(input.leftTokens.size, input.rightTokens.size);
  const largerTokenCount = Math.max(input.leftTokens.size, input.rightTokens.size);
  if (smallerTokenCount === 0 || largerTokenCount === 0) {
    return false;
  }

  const smallerCoverage = input.tokenOverlap.length / smallerTokenCount;
  const largerCoverage = input.tokenOverlap.length / largerTokenCount;
  if (smallerCoverage < 0.75) {
    return false;
  }

  return largerCoverage >= 0.75 ||
    hasVersionedSpecificationMarker(input.left) ||
    hasVersionedSpecificationMarker(input.right);
}

function auditScopeDriftFromDocuments(
  documents: WikiMaintenanceDocuments,
  options: Pick<AuditScopeDriftOptions, "staleTerms" | "preferredFraming">
): ScopeDriftIssue[] {
  const staleTerms = options.staleTerms.map((term) => term.toLowerCase());
  const preferredFraming = (options.preferredFraming ?? "").toLowerCase();
  const issues: ScopeDriftIssue[] = [];

  for (const page of documents.pages.filter((candidate) => !candidate.isAlias)) {
    const region = centralFramingRegion(page);
    const lowerRegion = region.toLowerCase();
    const matchedStaleTerms = staleTerms.filter((term) => lowerRegion.includes(term));
    if (matchedStaleTerms.length === 0) {
      continue;
    }
    issues.push({
      pageKey: page.pageKey,
      path: page.path,
      kind: "scope_drift",
      severity: matchedStaleTerms.length > 1 ? "high" : "medium",
      evidence: matchedStaleTerms.map((term) => `central framing contains stale term: ${term}`),
      suggestedScopeNote: preferredFraming
        ? `Scope note: Reframe this page around ${preferredFraming} and keep stale roadmap language as context.`
        : "Scope note: Reframe this page around the current wiki scope and keep stale roadmap language as context."
    });
  }

  return issues.sort((left, right) => left.pageKey.localeCompare(right.pageKey));
}

async function readSourceDocument(workspaceDir: string, filePath: string): Promise<WikiMaintenanceSourceDocument> {
  const parsed = parseMarkdown(await readFile(filePath, "utf8"));
  const fallbackKey = paperKeyFromPaperWikiSourcePath(filePath);
  const paperKey = stringValue(parsed.frontmatter.paper_key) ?? stringValue(parsed.frontmatter.paperKey) ?? fallbackKey;
  const title = stringValue(parsed.frontmatter.title) ?? paperKey;
  return {
    paperKey,
    title,
    path: relativeToWorkspace(workspaceDir, filePath),
    tags: normalizeTags(listValue(parsed.frontmatter.tags)),
    relatedPaperKeys: listValue(
      parsed.frontmatter.related_papers ?? parsed.frontmatter.related_paper_keys ?? parsed.frontmatter.relatedPaperKeys
    ).map((value) => sanitizeWikiFilename(value.toLowerCase())),
    body: parsed.body,
    frontmatter: parsed.frontmatter
  };
}

async function listSourceManifestFiles(workspaceDir: string): Promise<string[]> {
  try {
    const manifestsDir = getPaperWikiManifestsDir(workspaceDir);
    const entries = await readdir(manifestsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(manifestsDir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeManifestWorkspaceRelativePath(workspaceDir: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const rawPath = value.trim();
  if (path.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) {
    return undefined;
  }
  const absolutePath = path.resolve(workspaceDir, rawPath.split(/[\\/]+/).join(path.sep));
  const relativePath = path.relative(workspaceDir, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return relativeToWorkspace(workspaceDir, absolutePath);
}

async function readSourceManifestDocument(
  workspaceDir: string,
  filePath: string
): Promise<WikiMaintenanceSourceDocument | undefined> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
  if (!manifest || typeof manifest !== "object") {
    return undefined;
  }
  const record = manifest as Record<string, unknown>;
  if (stringValue(record.status) !== "ready") {
    return undefined;
  }
  const paperKey = stringValue(record.paperKey) ?? stringValue(record.paper_key) ?? path.basename(filePath, ".json");
  const fallbackSourceSummaryPath = getPaperWikiSourcePath(workspaceDir, paperKey);
  const sourceSummaryPath =
    safeManifestWorkspaceRelativePath(workspaceDir, record.sourceSummaryPath) ??
    (await pathExists(fallbackSourceSummaryPath) ? relativeToWorkspace(workspaceDir, fallbackSourceSummaryPath) : undefined);
  if (!sourceSummaryPath) {
    return undefined;
  }
  return {
    paperKey,
    title: stringValue(record.title) ?? paperKey,
    path: sourceSummaryPath,
    tags: normalizeTags(listValue(record.tags)),
    relatedPaperKeys: listValue(record.relatedPaperKeys ?? record.related_papers).map((value) =>
      sanitizeWikiFilename(value.toLowerCase())
    ),
    body: "",
    frontmatter: record
  };
}

function mergeSourceDocuments(
  summarySources: WikiMaintenanceSourceDocument[],
  manifestSources: WikiMaintenanceSourceDocument[]
): WikiMaintenanceSourceDocument[] {
  const byPaperKey = new Map<string, WikiMaintenanceSourceDocument>();
  for (const source of manifestSources) {
    byPaperKey.set(source.paperKey, source);
  }
  for (const source of summarySources) {
    const manifest = byPaperKey.get(source.paperKey);
    if (!manifest) {
      byPaperKey.set(source.paperKey, source);
      continue;
    }
    byPaperKey.set(source.paperKey, {
      ...source,
      title: source.title || manifest.title,
      tags: normalizeTags([...source.tags, ...manifest.tags]),
      relatedPaperKeys: normalizeTags([...source.relatedPaperKeys, ...manifest.relatedPaperKeys]),
      frontmatter: {
        ...manifest.frontmatter,
        ...source.frontmatter
      }
    });
  }
  return [...byPaperKey.values()].sort((left, right) => left.paperKey.localeCompare(right.paperKey));
}

async function readPageDocument(workspaceDir: string, filePath: string): Promise<WikiMaintenancePageDocument> {
  const parsed = parseMarkdown(await readFile(filePath, "utf8"));
  const fallbackKey = sanitizeWikiFilename(path.basename(filePath, ".md"));
  const typedPageKey = stringValue(parsed.frontmatter.key);
  const legacyPageKey = stringValue(parsed.frontmatter.page_key ?? parsed.frontmatter.pageKey);
  const pageKey = sanitizeWikiFilename((typedPageKey ?? legacyPageKey ?? fallbackKey).toLowerCase());
  const pageType = stringValue(parsed.frontmatter.type);
  const canonicalPageKey = stringValue(
    parsed.frontmatter.canonical_page ??
    parsed.frontmatter.canonicalPage ??
    parsed.frontmatter.alias_of
  );
  const sourceCitations = [
    ...sourceCitationList(parsed.frontmatter.sources),
    ...sourceRefCitationList(parsed.frontmatter.source_refs)
  ];
  return {
    pageKey,
    title: stringValue(parsed.frontmatter.title) ?? headingTitle(parsed.body) ?? fallbackKey,
    path: relativeToWorkspace(workspaceDir, filePath),
    isAlias: Boolean(
      (pageType === "alias" && canonicalPageKey) ||
      canonicalPageKey ||
      parsed.frontmatter.is_alias === "true"
    ),
    ...(canonicalPageKey ? { canonicalPageKey: sanitizeWikiFilename(canonicalPageKey.toLowerCase()) } : {}),
    relatedPageKeys: listValue(parsed.frontmatter.related_pages ?? parsed.frontmatter.relatedPageKeys).map((value) =>
      sanitizeWikiFilename(value.toLowerCase())
    ),
    sourceCitations,
    tags: normalizeTags(listValue(parsed.frontmatter.tags)),
    body: parsed.body,
    frontmatter: parsed.frontmatter
  };
}

function parseMarkdown(markdown: string): ParsedMarkdown {
  const frontmatterMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!frontmatterMatch?.[1]) {
    return { frontmatter: {}, body: markdown.trim() };
  }
  const yaml = frontmatterMatch[1].trimEnd();
  const body = markdown.slice(frontmatterMatch[0].length).trim();
  return { frontmatter: parseSimpleYaml(yaml), body };
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const topMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!topMatch) {
      index += 1;
      continue;
    }
    const [, key, rawValue] = topMatch;
    if (rawValue) {
      result[key] = parseInlineYamlValue(rawValue.trim());
      index += 1;
      continue;
    }

    const list: unknown[] = [];
    index += 1;
    while (index < lines.length && /^\s+/.test(lines[index])) {
      const itemMatch = /^\s*-\s*(.*)$/.exec(lines[index]);
      if (!itemMatch) {
        index += 1;
        continue;
      }
      const itemValue = itemMatch[1].trim();
      if (/^[A-Za-z0-9_-]+:\s*/.test(itemValue)) {
        const objectValue: Record<string, string> = {};
        const firstPair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(itemValue);
        if (firstPair) {
          objectValue[firstPair[1]] = parseInlineYamlScalar(firstPair[2].trim());
        }
        index += 1;
        while (index < lines.length) {
          const pairMatch = /^\s{4,}([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
          if (!pairMatch) {
            break;
          }
          objectValue[pairMatch[1]] = parseInlineYamlScalar(pairMatch[2].trim());
          index += 1;
        }
        list.push(objectValue);
      } else {
        list.push(parseInlineYamlScalar(itemValue));
        index += 1;
      }
    }
    result[key] = list;
  }

  return result;
}

function buildTagClusters(
  sources: WikiMaintenanceSourceDocument[],
  pages: WikiMaintenancePageDocument[]
): WikiCoverageTagCluster[] {
  const byTag = new Map<string, Set<string>>();
  for (const source of sources) {
    for (const tag of source.tags) {
      const paperKeys = byTag.get(tag) ?? new Set<string>();
      paperKeys.add(source.paperKey);
      byTag.set(tag, paperKeys);
    }
  }

  const existingPages = new Map<string, string>();
  for (const page of pages.filter((candidate) => !candidate.isAlias)) {
    existingPages.set(sanitizeWikiFilename(page.pageKey.toLowerCase()), page.pageKey);
    existingPages.set(sanitizeWikiFilename(page.title.toLowerCase()), page.pageKey);
    for (const tag of page.tags) {
      existingPages.set(tag, page.pageKey);
    }
  }

  return [...byTag.entries()]
    .map(([tag, paperKeys]) => {
      const cluster: WikiCoverageTagCluster = {
        tag,
        sourceCount: paperKeys.size,
        sourcePaperKeys: [...paperKeys].sort()
      };
      const existingPageKey = existingPages.get(tag);
      if (existingPageKey) {
        cluster.existingPageKey = existingPageKey;
      }
      return cluster;
    })
    .sort((left, right) => right.sourceCount - left.sourceCount || left.tag.localeCompare(right.tag));
}

function normalizeTags(values: string[]): string[] {
  return [...new Set(values.map((value) => sanitizeWikiFilename(value.toLowerCase())))].sort();
}

function sourceCitationList(value: unknown): WikiMaintenanceSourceCitation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return { paperKey: sanitizeWikiFilename(item) };
      }
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const paperKey = stringValue(record.paper_key) ?? stringValue(record.paperKey);
      if (!paperKey) {
        return null;
      }
      return {
        paperKey,
        ...(stringValue(record.title) ? { title: stringValue(record.title) } : {}),
        ...(stringValue(record.path) ? { path: stringValue(record.path) } : {})
      };
    })
    .filter((citation): citation is WikiMaintenanceSourceCitation => citation !== null);
}

function sourceRefCitationList(value: unknown): WikiMaintenanceSourceCitation[] {
  return listValue(value).map((paperKey) => ({ paperKey }));
}

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value.trim() && value.trim() !== "[]") {
    return [value.trim()];
  }
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function parseInlineYamlValue(value: string): unknown {
  if (value === "[]") {
    return [];
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : unquote(value);
    } catch {
      return unquote(value);
    }
  }
  return parseInlineYamlScalar(value);
}

function parseInlineYamlScalar(value: string): string {
  return unquote(value);
}

function headingTitle(body: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim();
}

function tokenize(value: string): Set<string> {
  const stopwords = new Set(["and", "for", "the", "with", "from", "into", "page"]);
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stopwords.has(token));
  return new Set(tokens);
}

function countOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) {
      count += 1;
    }
  }
  return count;
}

function findClosePageKey(tag: string, pages: WikiMaintenancePageDocument[]): string | undefined {
  const tagTokens = tokenize(tag);
  for (const page of pages.filter((candidate) => !candidate.isAlias)) {
    const pageTokens = tokenize(`${page.pageKey} ${page.title}`);
    if (countOverlap(tagTokens, pageTokens) >= Math.max(1, tagTokens.size - 1)) {
      return page.pageKey;
    }
  }
  return undefined;
}

function inferEvidenceContract(page: WikiMaintenancePageDocument): PageEvidenceContract {
  if (page.sourceCitations.length > 0) {
    return "paper-backed";
  }
  const text = `${page.title}\n${page.body}`;
  if (/\b(code|repo|test|script)\b/i.test(text)) {
    return "code-backed";
  }
  if (/\b(design|tool|agent|workflow|infrastructure|methodology)\b/i.test(text)) {
    return "design-backed";
  }
  return "unverified";
}

function sharedCitationKeys(left: WikiMaintenancePageDocument, right: WikiMaintenancePageDocument): string[] {
  const rightKeys = new Set(right.sourceCitations.map((citation) => citation.paperKey));
  return left.sourceCitations
    .map((citation) => citation.paperKey)
    .filter((paperKey) => rightKeys.has(paperKey))
    .sort();
}

function candidatePageKeysForSource(
  source: WikiMaintenanceSourceDocument,
  pages: WikiMaintenancePageDocument[]
): string[] {
  const sourceTags = new Set(source.tags);
  return pages
    .filter((page) => !page.isAlias && page.tags.some((tag) => sourceTags.has(tag)))
    .map((page) => page.pageKey)
    .sort();
}

function centralFramingRegion(page: WikiMaintenancePageDocument): string {
  const lines = page.body.split(/\r?\n/);
  const firstH1 = lines.find((line) => /^#\s+/.test(line)) ?? "";
  const firstParagraphLines: string[] = [];
  let sawHeading = false;
  for (const line of lines) {
    if (/^#\s+/.test(line)) {
      sawHeading = true;
      continue;
    }
    if (/^##\s+/.test(line)) {
      break;
    }
    if (!sawHeading || !line.trim()) {
      continue;
    }
    firstParagraphLines.push(line.trim());
  }

  const scopeNote = extractScopeNote(page.body);
  return [page.title, firstH1, firstParagraphLines.join(" "), scopeNote].filter(Boolean).join("\n");
}

function extractScopeNote(body: string): string {
  const lines = body.split(/\r?\n/);
  const scopeIndex = lines.findIndex((line) => /^##\s+Scope Note\s*$/i.test(line));
  if (scopeIndex < 0) {
    return "";
  }
  const sectionLines: string[] = [];
  for (let index = scopeIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      break;
    }
    sectionLines.push(lines[index]);
  }
  return sectionLines.join("\n").trim();
}
