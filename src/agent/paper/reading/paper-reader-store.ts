import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isPathInsideDirectory,
  resolvePaperLibraryPaths,
  uniquePaths
} from "../../knowledge-base.js";
import type { PaperRecord } from "../types.js";
import type {
  ConcretePaperParseEngine,
  PaperParseArtifactPaths,
  PaperParseQualityReport,
  PaperReaderSource,
  ParsedPaperDocument
} from "./types.js";
import { PaperReaderError } from "./types.js";
import type { PaperChunk } from "./chunks.js";

export interface ResolvePaperInput {
  workspaceDir: string;
  path?: string;
  recordPath?: string;
}

export interface ResolvedPaperSource {
  source: PaperReaderSource;
  record?: PaperRecord;
}

function sanitizePaperKey(value: string): string {
  const sanitized = value
    .trim()
    .replace(/\.[Pp][Dd][Ff]$/, "")
    .replace(/\.[Jj][Ss][Oo][Nn]$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "");

  if (!sanitized) {
    throw new PaperReaderError("paper_not_found", "Unable to derive a paper key.");
  }
  return sanitized;
}

function paperKeyFromRecord(record: PaperRecord, recordPath: string): string {
  if (record.source === "external") {
    return sanitizePaperKey(
      path.basename(recordPath) === "acquisition.json"
        ? path.basename(path.dirname(recordPath))
        : path.basename(recordPath)
    );
  }
  return sanitizePaperKey(`${record.source}-${record.canonicalId}`);
}

function paperKeyFromPdfPath(pdfPath: string): string {
  return sanitizePaperKey(path.basename(pdfPath));
}

async function resolvePathInsideWorkspace(
  workspaceDir: string,
  requestedPath: string
): Promise<string> {
  if (!requestedPath.trim()) {
    throw new PaperReaderError("paper_not_found", "Path is required.");
  }

  const paths = resolvePaperLibraryPaths(workspaceDir);
  const resolvedWorkspaceDir = paths.workspaceDir;
  const allowedRoots = uniquePaths([resolvedWorkspaceDir, paths.libraryRoot]);
  const normalizedRequestedPath = normalizeRequestedPath(requestedPath);
  const candidatePath = path.isAbsolute(normalizedRequestedPath)
    ? path.resolve(normalizedRequestedPath)
    : path.resolve(resolvedWorkspaceDir, normalizedRequestedPath);

  if (!allowedRoots.some((root) => isPathInsideDirectory(path.resolve(root), candidatePath))) {
    throw new PaperReaderError("paper_not_found", "Requested path is outside the workspace or knowledge base.");
  }

  let realAllowedRoots: string[];
  let realCandidatePath: string;
  try {
    [realAllowedRoots, realCandidatePath] = await Promise.all([
      Promise.all(allowedRoots.map(async (root) => realpath(root).catch(() => path.resolve(root)))),
      realpath(candidatePath)
    ]);
  } catch {
    throw new PaperReaderError("paper_not_found", `Paper file was not found: ${requestedPath}`);
  }

  if (!realAllowedRoots.some((root) => isPathInsideDirectory(root, realCandidatePath))) {
    throw new PaperReaderError("paper_not_found", "Requested path is outside the workspace or knowledge base.");
  }

  return realCandidatePath;
}

function normalizeRequestedPath(requestedPath: string): string {
  const drivePathMatch = requestedPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drivePathMatch?.[1] && drivePathMatch[2]) {
    return path.posix.join(
      "/mnt",
      drivePathMatch[1].toLowerCase(),
      ...drivePathMatch[2].split(/[\\/]+/).filter(Boolean)
    );
  }

  const uncWslMatch = requestedPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+\\(.+)$/i);
  if (uncWslMatch?.[1]) {
    return path.posix.join("/", ...uncWslMatch[1].split(/[\\/]+/).filter(Boolean));
  }

  return requestedPath;
}

function assertInsidePapersDir(workspaceDir: string, pdfPath: string): void {
  const paths = resolvePaperLibraryPaths(workspaceDir);
  const allowedRoots = [paths.rawPdfRoot].map((candidate) => path.resolve(candidate));
  if (!allowedRoots.some((root) => isPathInsideDirectory(root, path.resolve(pdfPath)))) {
    throw new PaperReaderError(
      "pdf_outside_papers_dir",
      "Paper reading only accepts PDFs stored under knowledge-base/raw/pdfs/."
    );
  }
}

export async function assertValidPdf(pdfPath: string): Promise<void> {
  const file = await readFile(pdfPath);
  if (file.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new PaperReaderError("invalid_pdf", "Paper file is not a valid PDF.");
  }
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

function getRecordDownloadPath(record: PaperRecord): string | undefined {
  return record.status === "downloaded" ? record.downloadPath : undefined;
}

function relativeToWorkspace(workspaceDir: string, filePath: string): string {
  const normalizedPath = path.isAbsolute(filePath)
    ? path.relative(workspaceDir, filePath)
    : filePath;
  return normalizedPath.split(path.sep).join("/");
}

export async function resolvePaperSource(input: ResolvePaperInput): Promise<ResolvedPaperSource> {
  const locatorCount = Number(Boolean(input.path)) + Number(Boolean(input.recordPath));
  if (locatorCount !== 1) {
    throw new PaperReaderError("paper_not_found", "Provide exactly one of path or recordPath.");
  }

  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);
  let pdfPath: string;
  let recordPath: string | undefined;
  let record: PaperRecord | undefined;

  if (input.recordPath) {
    recordPath = await resolvePathInsideWorkspace(resolvedWorkspaceDir, input.recordPath);
    try {
      record = JSON.parse(await readFile(recordPath, "utf8")) as PaperRecord;
    } catch {
      throw new PaperReaderError("paper_not_found", "Paper record could not be read.");
    }

    const downloadPath = getRecordDownloadPath(record);
    if (!downloadPath) {
      throw new PaperReaderError(
        "paper_not_found",
        "Paper record does not point to a downloaded PDF."
      );
    }
    pdfPath = await resolvePathInsideWorkspace(resolvedWorkspaceDir, downloadPath);
  } else {
    pdfPath = await resolvePathInsideWorkspace(resolvedWorkspaceDir, input.path ?? "");
  }

  assertInsidePapersDir(resolvedWorkspaceDir, pdfPath);
  await assertValidPdf(pdfPath);
  const pdfSha256 = await hashFile(pdfPath);
  const paperKey = record && recordPath
    ? paperKeyFromRecord(record, recordPath)
    : paperKeyFromPdfPath(pdfPath);

  return {
    source: {
      paperKey,
      pdfPath,
      pdfSha256,
      createdAt: new Date().toISOString(),
      ...(recordPath ? { recordPath } : {}),
      ...(record ? { source: record.source } : {}),
      ...(record && "canonicalId" in record && record.canonicalId ? { canonicalId: record.canonicalId } : {}),
      ...(record?.articleUrl ? { articleUrl: record.articleUrl } : {}),
      ...(record && "title" in record && record.title ? { title: record.title } : {})
    },
    ...(record ? { record } : {})
  };
}

export function getReadingDir(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).sourceArtifactsRoot;
}

export function getPaperReadingDir(workspaceDir: string, paperKey: string): string {
  return path.join(getReadingDir(workspaceDir), sanitizePaperKey(paperKey));
}

export function getParseDir(
  workspaceDir: string,
  paperKey: string,
  engine: ConcretePaperParseEngine
): string {
  return path.join(getPaperReadingDir(workspaceDir, paperKey), "parses", engine);
}

export function getPaperParseArtifactPaths(input: {
  workspaceDir: string;
  paperKey: string;
  engine: ConcretePaperParseEngine;
}): PaperParseArtifactPaths {
  const paperDir = getPaperReadingDir(input.workspaceDir, input.paperKey);
  const parseDir = getParseDir(input.workspaceDir, input.paperKey, input.engine);
  return {
    metadataPath: path.join(paperDir, "metadata.json"),
    parsePath: path.join(parseDir, "parse.json"),
    markdownPath: path.join(parseDir, "document.md"),
    qualityPath: path.join(parseDir, "quality.json"),
    chunksPath: path.join(paperDir, "chunks", `${input.engine}.jsonl`)
  };
}

export async function resolvePaperParseArtifactPaths(input: {
  workspaceDir: string;
  paperKey: string;
  engine: ConcretePaperParseEngine;
}): Promise<PaperParseArtifactPaths> {
  return getPaperParseArtifactPaths(input);
}

export async function readCachedParse(input: {
  workspaceDir: string;
  paperKey: string;
  engine: ConcretePaperParseEngine;
  pdfSha256: string;
}): Promise<{
  document: ParsedPaperDocument;
  quality: PaperParseQualityReport;
  artifacts: PaperParseArtifactPaths;
} | null> {
  const artifacts = getPaperParseArtifactPaths(input);
  try {
    const [documentText, qualityText] = await Promise.all([
      readFile(artifacts.parsePath, "utf8"),
      readFile(artifacts.qualityPath, "utf8")
    ]);
    const document = JSON.parse(documentText) as ParsedPaperDocument;
    const quality = JSON.parse(qualityText) as PaperParseQualityReport;
    if (document.pdfSha256 !== input.pdfSha256 || document.engine !== input.engine) {
      return null;
    }
    if (
      document.engine === "plain-text-baseline" &&
      document.elements.some((element) =>
        element.text.includes("%PDF-") &&
        element.text.includes(" endobj ") &&
        element.text.includes(" endstream ")
      )
    ) {
      return null;
    }
    return { document, quality, artifacts };
  } catch {
    return null;
  }
}

export async function writeParseArtifacts(input: {
  workspaceDir: string;
  source: PaperReaderSource;
  document: ParsedPaperDocument;
  markdown: string;
  quality: PaperParseQualityReport;
  chunks: PaperChunk[];
}): Promise<PaperParseArtifactPaths> {
  const artifacts = getPaperParseArtifactPaths({
    workspaceDir: input.workspaceDir,
    paperKey: input.document.paperKey,
    engine: input.document.engine
  });
  const metadataPath = artifacts.metadataPath ?? path.join(getPaperReadingDir(input.workspaceDir, input.document.paperKey), "metadata.json");
  await Promise.all([
    mkdir(path.dirname(metadataPath), { recursive: true }),
    mkdir(path.dirname(artifacts.parsePath), { recursive: true }),
    mkdir(path.dirname(artifacts.chunksPath), { recursive: true })
  ]);
  const existingMetadata = await readJsonFile<Record<string, unknown>>(metadataPath);
  const source = buildParseMetadata({
    workspaceDir: input.workspaceDir,
    source: input.source,
    document: input.document,
    artifacts,
    existingMetadata
  });
  await Promise.all([
    writeFile(metadataPath, `${JSON.stringify(source, null, 2)}\n`, "utf8"),
    writeFile(artifacts.parsePath, `${JSON.stringify(input.document, null, 2)}\n`, "utf8"),
    writeFile(artifacts.markdownPath, `${input.markdown.trimEnd()}\n`, "utf8"),
    writeFile(artifacts.qualityPath, `${JSON.stringify(input.quality, null, 2)}\n`, "utf8"),
    writeFile(
      artifacts.chunksPath,
      input.chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n",
      "utf8"
    )
  ]);
  return artifacts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sanitizeExistingPaperMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) {
    return {};
  }
  const sanitized: Record<string, unknown> = { ...metadata };
  for (const field of [
    "paperKey",
    "pdfPath",
    "pdfSha256",
    "recordPath",
    "source",
    "canonicalId",
    "articleUrl",
    "pdfUrl",
    "downloadStatus",
    "readingStatus",
    "rawPath",
    "downloadPath",
    "rawSha256"
  ]) {
    delete sanitized[field];
  }
  return sanitized;
}

function sanitizeExistingProvenance(provenance: unknown): Record<string, unknown> {
  if (!isRecord(provenance)) {
    return {};
  }
  const sanitized = { ...provenance };
  for (const field of [
    "recordPath",
    "rawPath",
    "downloadPath",
    "source",
    "canonicalId",
    "rawSha256",
    "pdfPath",
    "pdfSha256",
    "pdfUrl",
    "downloadStatus",
    "readingStatus"
  ]) {
    delete sanitized[field];
  }
  return sanitized;
}

function deriveParseMetadataStatus(existingStatus: unknown): string {
  const status = readOptionalString(existingStatus);
  if (!status || status === "missing_artifact") {
    return "ready";
  }
  return status;
}

function arxivIdFromUrl(articleUrl: string | undefined): string | undefined {
  if (!articleUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(articleUrl);
    if (!/(^|\.)arxiv\.org$/i.test(parsed.hostname)) {
      return undefined;
    }
    const match = parsed.pathname.match(/^\/(?:abs|pdf)\/([^/?#]+?)(?:\.pdf)?$/i);
    return match?.[1];
  } catch {
    return undefined;
  }
  return undefined;
}

function arxivIdFromSource(source: PaperReaderSource): string | undefined {
  if (source.source === "arxiv" && source.canonicalId) {
    return source.canonicalId;
  }
  if (source.paperKey.startsWith("arxiv-")) {
    return source.canonicalId ?? source.paperKey.slice("arxiv-".length);
  }
  return arxivIdFromUrl(source.articleUrl);
}

function sourceFromSourceKey(sourceKey: string): string | undefined {
  for (const source of ["arxiv", "science", "nature", "aps", "external"]) {
    if (sourceKey === source || sourceKey.startsWith(`${source}-`)) {
      return source;
    }
  }
  return undefined;
}

function sourceFromUrl(articleUrl: string | undefined): string | undefined {
  if (!articleUrl) {
    return undefined;
  }
  try {
    const hostname = new URL(articleUrl).hostname.toLowerCase();
    if (hostname === "arxiv.org" || hostname.endsWith(".arxiv.org")) {
      return "arxiv";
    }
    if (hostname === "www.nature.com" || hostname === "nature.com" || hostname.endsWith(".nature.com")) {
      return "nature";
    }
    if (hostname === "journals.aps.org" || hostname === "link.aps.org" || hostname.endsWith(".aps.org")) {
      return "aps";
    }
    if (hostname === "www.science.org" || hostname === "science.org" || hostname.endsWith(".science.org")) {
      return "science";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function publisherCanonicalIdFromUrl(source: string | undefined, articleUrl: string | undefined): string | undefined {
  if (!source || !articleUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(articleUrl);
    if (source === "science") {
      const match = decodeURIComponent(parsed.pathname).match(/^\/doi\/(?:abs\/|full\/|pdf\/|epdf\/)?(10\.\d{4,9}\/[^/?#]+)$/i);
      return match?.[1];
    }
    if (source === "aps") {
      const match = decodeURIComponent(parsed.pathname).match(/^\/[^/]+\/(?:abstract|accepted)\/(10\.1103)\/([^/?#]+)$/i);
      return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : undefined;
    }
    if (source === "nature") {
      const match = parsed.pathname.match(/^\/articles\/(s\d{5}-\d{3}-\d{5}-[a-z0-9])$/i);
      return match?.[1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function canonicalIdFromSourceKey(source: string | undefined, sourceKey: string): string | undefined {
  if (!source || !sourceKey.startsWith(`${source}-`)) {
    return undefined;
  }
  const suffix = sourceKey.slice(source.length + 1);
  if (!suffix) {
    return undefined;
  }
  if (source === "arxiv" || source === "nature") {
    return suffix;
  }
  return undefined;
}

function buildParseMetadata(input: {
  workspaceDir: string;
  source: PaperReaderSource;
  document: ParsedPaperDocument;
  artifacts: PaperParseArtifactPaths;
  existingMetadata: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const existing = sanitizeExistingPaperMetadata(input.existingMetadata);
  const existingProvenance = isRecord(input.existingMetadata?.provenance)
    ? input.existingMetadata.provenance
    : {};
  const provenance = sanitizeExistingProvenance(existingProvenance);
  const articleUrl = input.source.articleUrl ?? readOptionalString(provenance.url);
  const arxivId = arxivIdFromSource(input.source) ?? readOptionalString(provenance.arxivId);
  const acquisitionPath = input.source.recordPath
    ? relativeToWorkspace(input.workspaceDir, input.source.recordPath)
    : readOptionalString(provenance.acquisitionPath);
  const previousArtifacts = Array.isArray(input.existingMetadata?.artifacts)
    ? input.existingMetadata.artifacts.filter((artifact): artifact is Record<string, unknown> =>
        isRecord(artifact) &&
        artifact.kind === "parse" &&
        artifact.engine !== input.document.engine
      )
    : [];
  const parseArtifact = {
    kind: "parse",
    path: relativeToWorkspace(input.workspaceDir, input.artifacts.markdownPath),
    engine: input.document.engine,
    markdownPath: relativeToWorkspace(input.workspaceDir, input.artifacts.markdownPath),
    jsonPath: relativeToWorkspace(input.workspaceDir, input.artifacts.parsePath),
    qualityPath: relativeToWorkspace(input.workspaceDir, input.artifacts.qualityPath)
  };
  const now = input.document.createdAt;
  const citation = isRecord(input.existingMetadata?.citation)
    ? input.existingMetadata.citation
    : {
        citationStatus: "incomplete",
        missingFields: []
      };

  return {
    ...existing,
    schemaVersion: 1,
    sourceKind: "paper",
    sourceKey: input.document.paperKey,
    title: readOptionalString(input.existingMetadata?.title) ?? input.source.title ?? input.document.title ?? input.document.paperKey,
    status: deriveParseMetadataStatus(input.existingMetadata?.status),
    createdAt: readOptionalString(input.existingMetadata?.createdAt) ?? input.source.createdAt ?? now,
    updatedAt: now,
    summaryPath: readOptionalString(input.existingMetadata?.summaryPath) ?? `knowledge-base/sources/${input.document.paperKey}/summary.md`,
    citation,
    provenance: {
      ...provenance,
      ...(articleUrl ? { url: articleUrl } : {}),
      ...(arxivId ? { arxivId } : {}),
      ...(acquisitionPath ? { acquisitionPath } : {})
    },
    artifacts: [
      ...previousArtifacts,
      parseArtifact
    ],
    tags: Array.isArray(input.existingMetadata?.tags) ? input.existingMetadata.tags : [],
    relatedSourceKeys: Array.isArray(input.existingMetadata?.relatedSourceKeys) ? input.existingMetadata.relatedSourceKeys : [],
    synthesisPageKeys: Array.isArray(input.existingMetadata?.synthesisPageKeys) ? input.existingMetadata.synthesisPageKeys : []
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function readPaperSourceByKey(input: {
  workspaceDir: string;
  paperKey: string;
}): Promise<PaperReaderSource | undefined> {
  const metadataPath = path.join(getPaperReadingDir(input.workspaceDir, input.paperKey), "metadata.json");
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    const citation = typeof metadata.citation === "object" && metadata.citation !== null
      ? metadata.citation as Record<string, unknown>
      : {};
    const provenance = typeof metadata.provenance === "object" && metadata.provenance !== null
      ? metadata.provenance as Record<string, unknown>
      : {};
    const sourceKey = typeof metadata.sourceKey === "string" ? metadata.sourceKey : input.paperKey;
    const articleUrl = typeof provenance.url === "string" ? provenance.url : undefined;
    const source =
      sourceFromSourceKey(sourceKey) ??
      sourceFromUrl(articleUrl) ??
      (typeof provenance.source === "string" ? provenance.source : undefined);
    const canonicalId =
      publisherCanonicalIdFromUrl(source, articleUrl) ??
      (typeof citation.doi === "string" ? citation.doi : undefined) ??
      (typeof provenance.doi === "string" ? provenance.doi : undefined) ??
      (typeof citation.arxivId === "string" ? citation.arxivId : undefined) ??
      (typeof provenance.arxivId === "string" ? provenance.arxivId : undefined) ??
      arxivIdFromUrl(articleUrl) ??
      canonicalIdFromSourceKey(source, sourceKey) ??
      (typeof provenance.canonicalId === "string" ? provenance.canonicalId : undefined);
    return {
      paperKey: sourceKey,
      createdAt: typeof metadata.createdAt === "string" ? metadata.createdAt : new Date().toISOString(),
      ...(typeof provenance.acquisitionPath === "string" ? { recordPath: provenance.acquisitionPath } : {}),
      ...(source ? { source } : {}),
      ...(canonicalId ? { canonicalId } : {}),
      ...(articleUrl ? { articleUrl } : {}),
      ...(typeof metadata.title === "string" ? { title: metadata.title } : {})
    };
  } catch {
    return undefined;
  }
}

async function paperReadingDirExists(input: {
  workspaceDir: string;
  paperKey: string;
}): Promise<boolean> {
  try {
    await access(getPaperReadingDir(input.workspaceDir, input.paperKey));
    return true;
  } catch {
    return false;
  }
}

function paperKeyLookupCandidates(paperKey: string): string[] {
  const candidate = sanitizePaperKey(paperKey);
  const publisherPrefixes = ["arxiv", "nature", "science", "aps", "external"];
  const candidates = [
    candidate,
    ...publisherPrefixes
      .filter((prefix) => !candidate.startsWith(`${prefix}-`))
      .map((prefix) => `${prefix}-${candidate}`)
  ];
  return [...new Set(candidates)];
}

function sourceMatchesPaperKeyAlias(source: PaperReaderSource | undefined, requested: string): boolean {
  if (!source) {
    return false;
  }
  const candidates = [
    source.paperKey,
    source.canonicalId,
    source.source && source.canonicalId ? `${source.source}-${source.canonicalId}` : undefined,
    source.articleUrl
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return candidates.some((candidate) => {
    try {
      return sanitizePaperKey(candidate) === requested;
    } catch {
      return false;
    }
  });
}

export async function resolveExistingPaperKey(input: {
  workspaceDir: string;
  paperKey: string;
}): Promise<string> {
  const requested = sanitizePaperKey(input.paperKey);
  for (const candidate of paperKeyLookupCandidates(requested)) {
    if (await paperReadingDirExists({ workspaceDir: input.workspaceDir, paperKey: candidate })) {
      return candidate;
    }
  }

  let entries;
  try {
    entries = await readdir(getReadingDir(input.workspaceDir), { withFileTypes: true });
  } catch {
    throw new PaperReaderError("paper_not_found", `No parsed paper found for ${input.paperKey}.`);
  }

  const matchingKeys: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidateKey = sanitizePaperKey(entry.name);
    if (candidateKey.endsWith(`-${requested}`)) {
      matchingKeys.push(candidateKey);
      continue;
    }
    const source = await readPaperSourceByKey({
      workspaceDir: input.workspaceDir,
      paperKey: candidateKey
    });
    if (sourceMatchesPaperKeyAlias(source, requested)) {
      matchingKeys.push(candidateKey);
    }
  }

  const match = matchingKeys[0];
  if (!match) {
    throw new PaperReaderError("paper_not_found", `No parsed paper found for ${input.paperKey}.`);
  }
  return match;
}

export async function listPaperParseEngines(input: {
  workspaceDir: string;
  paperKey: string;
}): Promise<ConcretePaperParseEngine[]> {
  const engines: ConcretePaperParseEngine[] = [];
  const parsesDir = path.join(getPaperReadingDir(input.workspaceDir, input.paperKey), "parses");
  try {
    const entries = await readdir(parsesDir, { withFileTypes: true });
    engines.push(
      ...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name): name is ConcretePaperParseEngine =>
          name === "opendataloader-local" ||
          name === "opendataloader-hybrid" ||
          name === "docling" ||
          name === "tex-source" ||
          name === "plain-text-baseline" ||
          name === "webpage"
        )
    );
  } catch {
    return [];
  }
  return [...new Set(engines)];
}

export async function readParsedPaperDocument(input: {
  workspaceDir: string;
  paperKey: string;
  engine: ConcretePaperParseEngine;
}): Promise<ParsedPaperDocument> {
  const artifacts = await resolvePaperParseArtifactPaths(input);
  try {
    return JSON.parse(await readFile(artifacts.parsePath, "utf8")) as ParsedPaperDocument;
  } catch {
    throw new PaperReaderError(
      "paper_not_found",
      `No ${input.engine} parse found for ${input.paperKey}.`
    );
  }
}

export async function assertPaperReadingExists(input: {
  workspaceDir: string;
  paperKey: string;
}): Promise<void> {
  try {
    await access(getPaperReadingDir(input.workspaceDir, input.paperKey));
    return;
  } catch {
    throw new PaperReaderError("paper_not_found", `No parsed paper found for ${input.paperKey}.`);
  }
}
