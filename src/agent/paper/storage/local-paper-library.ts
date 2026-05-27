import { access, readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { isPathInsideDirectory, resolvePaperLibraryPaths } from "../../knowledge-base.js";
import { resolvePublisherCanonicalIdFromArticleUrl } from "../acquisition/paper-download.js";
import type { ConcretePaperParseEngine, PaperParseQualityReport, PaperReaderSource } from "../reading/types.js";
import type {
  PaperCitationStatus,
  PaperRecord,
  PaperSource,
  PaperSourceMetadata,
  SupportedPaperSource
} from "../types.js";

export type LocalPaperListStatus = "all" | "downloaded" | "parsed" | "summarized";

type PaperSourceFile = PaperReaderSource & Partial<PaperSourceMetadata>;

export interface LocalPaperParseSummary {
  engine: ConcretePaperParseEngine;
  status?: PaperParseQualityReport["status"];
  score?: number;
  totalTextLength?: number;
  markdownPath: string;
  parsePath: string;
  qualityPath: string;
  chunksPath: string;
  warnings: string[];
}

export interface LocalPaperEntry {
  paperKey: string;
  title?: string;
  source?: PaperSource | string;
  canonicalId?: string;
  articleUrl?: string;
  status?: string;
  recordedAt?: string;
  recordPath?: string;
  sourcePath?: string;
  pdfPath?: string;
  citationStatus?: PaperCitationStatus | string;
  missingCitationFields?: string[];
  hasPdf: boolean;
  hasParsedArtifacts: boolean;
  hasWikiSummary: boolean;
  wikiSummaryPath?: string;
  parses: LocalPaperParseSummary[];
}

export interface ListLocalPapersOptions {
  workspaceDir: string;
  query?: string;
  status?: LocalPaperListStatus;
  maxResults?: number;
}

export interface ListLocalPapersResult {
  total: number;
  count: number;
  results: LocalPaperEntry[];
}

export interface LocalPaperSearchMatch {
  field: "metadata" | "record" | "wiki_summary" | "parsed_markdown";
  snippet: string;
  path?: string;
  engine?: ConcretePaperParseEngine;
}

export interface LocalPaperSearchResult {
  paper: LocalPaperEntry;
  score: number;
  matches: LocalPaperSearchMatch[];
}

export interface SearchLocalPapersOptions {
  workspaceDir: string;
  query: string;
  maxResults?: number;
}

export interface SearchLocalPapersResult {
  query: string;
  count: number;
  results: LocalPaperSearchResult[];
}

const DEFAULT_LOCAL_PAPER_RESULTS = 20;
const MAX_TEXT_SEARCH_BYTES = 2_000_000;

const CONCRETE_ENGINES = new Set<ConcretePaperParseEngine>([
  "opendataloader-local",
  "opendataloader-hybrid",
  "docling",
  "tex-source",
  "plain-text-baseline",
  "webpage"
]);

function relativeToWorkspace(workspaceDir: string, filePath: string): string {
  return path.relative(workspaceDir, filePath).split(path.sep).join("/");
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function createSnippet(text: string, query: string, maxLength = 320): string {
  const compact = compactText(text);
  const lowerText = compact.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index < 0) {
    return compact.slice(0, maxLength);
  }
  const start = Math.max(0, index - 120);
  const end = Math.min(compact.length, index + query.length + 180);
  return `${start > 0 ? "... " : ""}${compact.slice(start, end)}${end < compact.length ? " ..." : ""}`;
}

function sanitizePaperKey(value: string): string {
  return value
    .trim()
    .replace(/\.[Jj][Ss][Oo][Nn]$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "");
}

function sourceIsSupportedPublisher(source: PaperReaderSource): source is PaperReaderSource & { source: SupportedPaperSource } {
  return source.source === "science" || source.source === "nature" || source.source === "aps";
}

function paperKeyFromSourceDirectory(sourceDirName: string, source: PaperReaderSource | undefined): string {
  if (!source || !source.articleUrl || !sourceIsSupportedPublisher(source)) {
    return sourceDirName;
  }

  const canonicalId = resolvePublisherCanonicalIdFromArticleUrl({
    publisher: source.source,
    articleUrl: source.articleUrl
  });
  const canonicalKey = canonicalId ? sanitizePaperKey(`${source.source}-${canonicalId}`) : "";
  return canonicalKey || sourceDirName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizePortableFilePath(filePath: string): string {
  const drivePathMatch = filePath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drivePathMatch?.[1] && drivePathMatch[2]) {
    return path.posix.join(
      "/mnt",
      drivePathMatch[1].toLowerCase(),
      ...drivePathMatch[2].split(/[\\/]+/).filter(Boolean)
    );
  }

  const uncWslMatch = filePath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+\\(.+)$/i);
  if (uncWslMatch?.[1]) {
    return path.posix.join("/", ...uncWslMatch[1].split(/[\\/]+/).filter(Boolean));
  }

  return filePath.includes("\\") ? filePath.replace(/\\/g, "/") : filePath;
}

function toWorkspaceRelativePath(workspaceDir: string, filePath: string): string {
  const normalizedFilePath = normalizePortableFilePath(filePath);
  if (!path.isAbsolute(normalizedFilePath)) {
    return normalizedFilePath;
  }

  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedFilePath = path.resolve(normalizedFilePath);
  return isPathInsideDirectory(resolvedWorkspaceDir, resolvedFilePath)
    ? relativeToWorkspace(resolvedWorkspaceDir, resolvedFilePath)
    : normalizedFilePath;
}

function applyRecord(entry: LocalPaperEntry, record: PaperRecord, recordPath: string, workspaceDir: string): void {
  const rawRecord = record as unknown as Record<string, unknown>;
  entry.source = record.source;
  entry.articleUrl = record.articleUrl;
  entry.status = record.status;
  entry.recordedAt = record.recordedAt;
  entry.recordPath = relativeToWorkspace(workspaceDir, recordPath);
  entry.title = entry.title ?? readOptionalString(rawRecord.title);
  if ("canonicalId" in record && record.canonicalId) {
    entry.canonicalId = record.canonicalId;
  }
  if ("downloadPath" in record && typeof record.downloadPath === "string") {
    entry.pdfPath = toWorkspaceRelativePath(workspaceDir, record.downloadPath);
  }
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function inferMissingCitationFields(source: PaperReaderSource & Partial<PaperSourceMetadata>): string[] {
  const missing: string[] = [];
  const rawSource = source as unknown as Record<string, unknown>;
  const rawCitation = typeof rawSource.citation === "object" && rawSource.citation !== null
    ? rawSource.citation as Record<string, unknown>
    : {};
  const authors = readOptionalStringArray(rawCitation.authors) ?? readOptionalStringArray(rawSource.authors) ?? [];
  if (!readOptionalString(source.title)) {
    missing.push("title");
  }
  if (authors.length === 0) {
    missing.push("authors");
  }
  if (typeof rawCitation.year !== "number" && typeof rawSource.year !== "number") {
    missing.push("year");
  }
  if (!readOptionalString(rawCitation.venue) && !readOptionalString(rawSource.venue)) {
    missing.push("venue");
  }
  if (
    !readOptionalString(rawCitation.doi) &&
    !readOptionalString(rawCitation.arxivId) &&
    !readOptionalString(rawSource.doi) &&
    !readOptionalString(rawSource.arxivId) &&
    !readOptionalString(source.articleUrl)
  ) {
    missing.push("stableIdentifier");
  }
  return missing;
}

function applySource(
  entry: LocalPaperEntry,
  source: PaperReaderSource & Partial<PaperSourceMetadata>,
  sourcePath: string,
  workspaceDir: string
): void {
  const rawSource = source as unknown as Record<string, unknown>;
  entry.sourcePath = relativeToWorkspace(workspaceDir, sourcePath);
  entry.title = entry.title ?? source.title;
  entry.source = entry.source ?? source.source;
  entry.canonicalId = entry.canonicalId ?? source.canonicalId;
  entry.articleUrl = entry.articleUrl ?? source.articleUrl;
  const rawCitation = typeof rawSource.citation === "object" && rawSource.citation !== null
    ? rawSource.citation as Record<string, unknown>
    : {};
  const explicitMissingFields = readOptionalStringArray(rawCitation.missingFields) ?? readOptionalStringArray(rawSource.missingFields);
  const inferredMissingFields = inferMissingCitationFields(source);
  const citationStatus = readOptionalString(rawCitation.citationStatus) ?? readOptionalString(rawSource.citationStatus);
  entry.citationStatus = citationStatus ?? (inferredMissingFields.length > 0 ? "incomplete" : entry.citationStatus);
  entry.missingCitationFields = explicitMissingFields ?? (
    citationStatus === undefined || inferredMissingFields.length > 0
      ? inferredMissingFields
      : entry.missingCitationFields
  );
  if (source.recordPath && !entry.recordPath) {
    entry.recordPath = toWorkspaceRelativePath(workspaceDir, source.recordPath);
  }
  if (source.pdfPath && !entry.pdfPath) {
    entry.pdfPath = toWorkspaceRelativePath(workspaceDir, source.pdfPath);
  }
}

function createEmptyEntry(paperKey: string): LocalPaperEntry {
  return {
    paperKey,
    hasPdf: false,
    hasParsedArtifacts: false,
    hasWikiSummary: false,
    parses: []
  };
}

async function pathExists(filePath: string | undefined): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function normalizeKnowledgeSourceMetadata(input: {
  raw: unknown;
  fallbackPaperKey: string;
}): PaperSourceFile | undefined {
  if (!isRecord(input.raw)) {
    return undefined;
  }
  if (input.raw.schemaVersion !== 1 || input.raw.sourceKind !== "paper") {
    return input.raw as unknown as PaperSourceFile;
  }
  const citation = isRecord(input.raw.citation) ? input.raw.citation : {};
  const provenance = isRecord(input.raw.provenance) ? input.raw.provenance : {};
  const paperKey = readOptionalString(input.raw.sourceKey) ?? input.fallbackPaperKey;
  const createdAt = readOptionalString(input.raw.createdAt) ?? new Date().toISOString();
  const source = readOptionalString(provenance.source);
  const canonicalId =
    readOptionalString(provenance.canonicalId) ??
    readOptionalString(citation.doi) ??
    readOptionalString(citation.arxivId);
  const articleUrl = readOptionalString(provenance.url);
  const recordPath = readOptionalString(provenance.acquisitionPath);
  const pdfPath = undefined;

  return {
    ...(input.raw as unknown as PaperSourceFile),
    paperKey,
    createdAt,
    ...(readOptionalString(input.raw.title) ? { title: readOptionalString(input.raw.title) } : {}),
    ...(source ? { source } : {}),
    ...(canonicalId ? { canonicalId } : {}),
    ...(articleUrl ? { articleUrl } : {}),
    ...(recordPath ? { recordPath } : {}),
    ...(pdfPath ? { pdfPath } : {})
  };
}

async function readSourceMetadata(input: {
  paperDir: string;
  paperKey: string;
}): Promise<{ source: PaperSourceFile; path: string } | undefined> {
  const metadataPath = path.join(input.paperDir, "metadata.json");
  const metadata = normalizeKnowledgeSourceMetadata({
    raw: await readJsonFile<unknown>(metadataPath),
    fallbackPaperKey: input.paperKey
  });
  if (metadata) {
    return { source: metadata, path: metadataPath };
  }
  return undefined;
}

function resolveKnownPdfPath(workspaceDir: string, pdfPath: string | undefined): string | undefined {
  if (!pdfPath) {
    return undefined;
  }
  const normalizedPdfPath = normalizePortableFilePath(pdfPath);
  return path.isAbsolute(normalizedPdfPath) ? normalizedPdfPath : path.resolve(workspaceDir, normalizedPdfPath);
}

async function collectAcquisitions(workspaceDir: string, entries: Map<string, LocalPaperEntry>): Promise<void> {
  const paths = resolvePaperLibraryPaths(workspaceDir);
  let sourceDirs;
  try {
    sourceDirs = await readdir(paths.sourceArtifactsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const sourceDir of sourceDirs) {
    if (!sourceDir.isDirectory()) {
      continue;
    }
    const paperKey = sanitizePaperKey(sourceDir.name);
    const recordPath = path.join(paths.sourceArtifactsRoot, sourceDir.name, "acquisition.json");
    const record = await readJsonFile<PaperRecord>(recordPath);
    if (!record) {
      continue;
    }
    const entry = entries.get(paperKey) ?? createEmptyEntry(paperKey);
    applyRecord(entry, record, recordPath, workspaceDir);
    entry.sourcePath = entry.sourcePath ?? relativeToWorkspace(workspaceDir, path.join(paths.sourceArtifactsRoot, sourceDir.name, "metadata.json"));
    entry.hasPdf = await pathExists(resolveKnownPdfPath(workspaceDir, entry.pdfPath));
    entries.set(paperKey, entry);
  }
}

async function collectParses(workspaceDir: string, entries: Map<string, LocalPaperEntry>): Promise<void> {
  const paths = resolvePaperLibraryPaths(workspaceDir);
  let sourceDirs;
  try {
    sourceDirs = await readdir(paths.sourceArtifactsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const sourceDir of sourceDirs) {
    if (!sourceDir.isDirectory()) {
      continue;
    }
    const paperDir = path.join(paths.sourceArtifactsRoot, sourceDir.name);
    const sourceMetadata = await readSourceMetadata({
      paperDir,
      paperKey: sourceDir.name
    });
    const source = sourceMetadata?.source;
    const paperKey = paperKeyFromSourceDirectory(sourceDir.name, source);
    const entry = entries.get(paperKey) ?? createEmptyEntry(paperKey);
    entry.sourcePath = sourceMetadata
      ? relativeToWorkspace(workspaceDir, sourceMetadata.path)
      : entry.sourcePath ?? relativeToWorkspace(workspaceDir, path.join(paperDir, "metadata.json"));
    if (source) {
      applySource(entry, source, sourceMetadata.path, workspaceDir);
    }

    const parsesDir = path.join(paperDir, "parses");
    let parseDirs: Dirent[];
    try {
      parseDirs = await readdir(parsesDir, { withFileTypes: true });
    } catch {
      parseDirs = [];
    }

    const parses: LocalPaperParseSummary[] = [];
    for (const parseDir of parseDirs) {
      if (!parseDir.isDirectory() || !CONCRETE_ENGINES.has(parseDir.name as ConcretePaperParseEngine)) {
        continue;
      }
      const engine = parseDir.name as ConcretePaperParseEngine;
      const parseRoot = path.join(parsesDir, parseDir.name);
      const qualityPath = path.join(parseRoot, "quality.json");
      const quality = await readJsonFile<PaperParseQualityReport>(qualityPath);
      parses.push({
        engine,
        ...(quality?.status ? { status: quality.status } : {}),
        ...(typeof quality?.score === "number" ? { score: quality.score } : {}),
        ...(typeof quality?.totalTextLength === "number" ? { totalTextLength: quality.totalTextLength } : {}),
        markdownPath: relativeToWorkspace(workspaceDir, path.join(parseRoot, "document.md")),
        parsePath: relativeToWorkspace(workspaceDir, path.join(parseRoot, "parse.json")),
        qualityPath: relativeToWorkspace(workspaceDir, qualityPath),
        chunksPath: relativeToWorkspace(workspaceDir, path.join(paperDir, "chunks", `${engine}.jsonl`)),
        warnings: quality?.warnings ?? []
      });
    }
    entry.parses = [...entry.parses, ...parses].sort((left, right) => left.engine.localeCompare(right.engine));
    entry.hasParsedArtifacts = entry.parses.length > 0;
    entry.hasPdf = entry.hasPdf || await pathExists(resolveKnownPdfPath(workspaceDir, entry.pdfPath));
    entries.set(paperKey, entry);
  }
}

async function collectWikiSummaries(workspaceDir: string, entries: Map<string, LocalPaperEntry>): Promise<void> {
  const paths = resolvePaperLibraryPaths(workspaceDir);
  let sourceFiles;
  try {
    sourceFiles = await readdir(paths.sourcesRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const file of sourceFiles) {
    if (!file.isDirectory()) {
      continue;
    }
    const paperKey = file.name;
    const entry = entries.get(paperKey) ?? createEmptyEntry(paperKey);
    const summaryPath = path.join(paths.sourcesRoot, file.name, "summary.md");
    const summary = await readFile(summaryPath, "utf8").catch(() => undefined);
    if (summary === undefined) {
      continue;
    }
    const title = summary?.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    if (title) {
      entry.title = entry.title ?? title;
    }
    entry.hasWikiSummary = true;
    entry.wikiSummaryPath = relativeToWorkspace(workspaceDir, summaryPath);
    entries.set(paperKey, entry);
  }
}

function matchesStatus(entry: LocalPaperEntry, status: LocalPaperListStatus): boolean {
  if (status === "all") {
    return true;
  }
  if (status === "downloaded") {
    return entry.status === "downloaded" || entry.hasPdf;
  }
  if (status === "parsed") {
    return entry.hasParsedArtifacts;
  }
  return entry.hasWikiSummary;
}

function metadataText(entry: LocalPaperEntry): string {
  return [
    entry.paperKey,
    entry.title,
    entry.source,
    entry.canonicalId,
    entry.articleUrl,
    entry.status,
    entry.recordedAt
  ].filter(Boolean).join(" ");
}

export async function listLocalPapers(options: ListLocalPapersOptions): Promise<ListLocalPapersResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const entries = new Map<string, LocalPaperEntry>();
  await collectAcquisitions(workspaceDir, entries);
  await collectParses(workspaceDir, entries);
  await collectWikiSummaries(workspaceDir, entries);

  const status = options.status ?? "all";
  const query = options.query?.trim().toLowerCase();
  const maxResults = Math.max(1, Math.trunc(options.maxResults ?? DEFAULT_LOCAL_PAPER_RESULTS));
  const filtered = Array.from(entries.values())
    .filter((entry) => matchesStatus(entry, status))
    .filter((entry) => !query || metadataText(entry).toLowerCase().includes(query))
    .sort((left, right) =>
      (right.recordedAt ?? "").localeCompare(left.recordedAt ?? "") ||
      left.paperKey.localeCompare(right.paperKey)
    );

  return {
    total: filtered.length,
    count: Math.min(filtered.length, maxResults),
    results: filtered.slice(0, maxResults)
  };
}

function countOccurrences(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) {
    return 0;
  }
  let count = 0;
  let index = lowerText.indexOf(lowerQuery);
  while (index >= 0) {
    count += 1;
    index = lowerText.indexOf(lowerQuery, index + lowerQuery.length);
  }
  return count;
}

async function readSearchableText(workspaceDir: string, relativePath: string | undefined): Promise<string | undefined> {
  if (!relativePath) {
    return undefined;
  }
  const filePath = path.resolve(workspaceDir, relativePath);
  try {
    const file = await readFile(filePath, { encoding: "utf8", flag: "r" });
    return file.length > MAX_TEXT_SEARCH_BYTES ? file.slice(0, MAX_TEXT_SEARCH_BYTES) : file;
  } catch {
    return undefined;
  }
}

export async function searchLocalPapers(options: SearchLocalPapersOptions): Promise<SearchLocalPapersResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("query is required.");
  }

  const listed = await listLocalPapers({
    workspaceDir: options.workspaceDir,
    status: "all",
    maxResults: Number.MAX_SAFE_INTEGER
  });
  const maxResults = Math.max(1, Math.trunc(options.maxResults ?? DEFAULT_LOCAL_PAPER_RESULTS));
  const results: LocalPaperSearchResult[] = [];

  for (const paper of listed.results) {
    let score = 0;
    const matches: LocalPaperSearchMatch[] = [];
    const metadata = metadataText(paper);
    const metadataCount = countOccurrences(metadata, query);
    if (metadataCount > 0) {
      score += metadataCount * 8;
      matches.push({
        field: "metadata",
        snippet: createSnippet(metadata, query)
      });
    }

    const recordText = await readSearchableText(options.workspaceDir, paper.recordPath);
    const recordCount = recordText ? countOccurrences(recordText, query) : 0;
    if (recordText && recordCount > 0) {
      score += recordCount * 4;
      matches.push({
        field: "record",
        path: paper.recordPath,
        snippet: createSnippet(recordText, query)
      });
    }

    const wikiText = await readSearchableText(options.workspaceDir, paper.wikiSummaryPath);
    const wikiCount = wikiText ? countOccurrences(wikiText, query) : 0;
    if (wikiText && wikiCount > 0) {
      score += wikiCount * 10;
      matches.push({
        field: "wiki_summary",
        path: paper.wikiSummaryPath,
        snippet: createSnippet(wikiText, query)
      });
    }

    for (const parse of paper.parses) {
      const markdownText = await readSearchableText(options.workspaceDir, parse.markdownPath);
      const markdownCount = markdownText ? countOccurrences(markdownText, query) : 0;
      if (!markdownText || markdownCount === 0) {
        continue;
      }
      score += markdownCount * 2;
      matches.push({
        field: "parsed_markdown",
        path: parse.markdownPath,
        engine: parse.engine,
        snippet: createSnippet(markdownText, query)
      });
    }

    if (matches.length > 0) {
      results.push({ paper, score, matches });
    }
  }

  const sorted = results
    .sort((left, right) =>
      right.score - left.score ||
      (right.paper.recordedAt ?? "").localeCompare(left.paper.recordedAt ?? "") ||
      left.paper.paperKey.localeCompare(right.paper.paperKey)
    )
    .slice(0, maxResults);

  return {
    query,
    count: sorted.length,
    results: sorted
  };
}
