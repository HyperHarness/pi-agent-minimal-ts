import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isPathInsideDirectory,
  resolvePaperLibraryPaths
} from "../../knowledge-base.js";
import type {
  DownloadablePaperSource,
  PaperRecord,
  PaperRecordArtifactManifest,
  PaperRecordReadingManifest,
  PaperSourceMetadata,
  PaperSource
} from "../types.js";
import type { ParsedPaperDocument } from "../reading/types.js";

type DownloadedPaperRecord = Extract<PaperRecord, { status: "downloaded" }>;
type FindDownloadedPaperRecordInput =
  | {
      workspaceDir: string;
      source: DownloadablePaperSource;
      canonicalId: string;
      articleUrl: string;
    }
  | {
      workspaceDir: string;
      source: "external";
      articleUrl: string;
      canonicalId?: never;
    };

export interface DownloadedPaperRecordMatch {
  record: DownloadedPaperRecord;
  recordPath: string;
  downloadPath: string;
}

export interface PaperRecordParseManifestInput {
  workspaceDir: string;
  recordPath: string;
  strategy: "pdf_parse" | "webpage";
  status: "parsed" | "already_parsed";
  paperKey: string;
  engine: string;
  sourceSha256: string;
  artifacts: {
    markdownPath: string;
    parsePath: string;
    qualityPath: string;
    chunksPath: string;
  };
  quality: {
    status: string;
    score: number;
    pages: number;
    totalTextLength: number;
    warnings: string[];
  };
  updatedAt?: string;
}

export interface PaperRecordReadingFailureInput {
  workspaceDir: string;
  recordPath: string;
  strategy: "pdf_parse" | "webpage";
  message: string;
  updatedAt?: string;
}

export interface PaperRecordQueuedReadingInput {
  workspaceDir: string;
  recordPath: string;
  strategy: "webpage" | "pdf_parse";
  jobId?: string;
  message: string;
  updatedAt?: string;
}

function sanitizeFilenameComponent(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "");
}

function sanitizeCanonicalId(value: string): string {
  const sanitizedValue = sanitizeFilenameComponent(value);
  if (!sanitizedValue) {
    throw new Error("canonicalId must contain at least one filename-safe character.");
  }

  return sanitizedValue;
}

function getSourceAcquisitionRoot(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).sourceArtifactsRoot;
}

function toWorkspacePath(input: { workspaceDir: string; filePath: string }): string {
  const normalizedFilePath = normalizePortableFilePath(input.filePath);
  const resolvedFilePath = path.resolve(normalizedFilePath);
  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);
  return isPathInsideDirectory(resolvedWorkspaceDir, resolvedFilePath)
    ? path.relative(resolvedWorkspaceDir, resolvedFilePath)
    : normalizedFilePath;
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

function toQualitySummary(input: PaperRecordParseManifestInput["quality"]) {
  return {
    status: input.status,
    score: input.score,
    pages: input.pages,
    totalTextLength: input.totalTextLength,
    warnings: input.warnings
  };
}

function getExternalRecordFilename(articleUrl: string): string {
  const hostname = sanitizeFilenameComponent(new URL(articleUrl).hostname);
  const hash = createHash("sha1").update(articleUrl).digest("hex").slice(0, 12);
  return `external-${hostname}-${hash}.json`;
}

export function resolvePaperRecordKey(input: {
  source: PaperSource;
  canonicalId?: string;
  articleUrl: string;
}): string {
  if (input.source !== "external" && !input.canonicalId) {
    throw new Error("canonicalId is required for supported paper sources.");
  }
  return input.source === "external"
    ? getExternalRecordFilename(input.articleUrl).replace(/\.json$/, "")
    : `${sanitizeFilenameComponent(input.source)}-${sanitizeCanonicalId(input.canonicalId ?? "")}`;
}

export function resolveExternalPaperPdfPath(input: {
  workspaceDir: string;
  articleUrl: string;
}): string {
  const filename = getExternalRecordFilename(input.articleUrl).replace(/\.json$/, ".pdf");
  return path.join(resolvePaperLibraryPaths(input.workspaceDir).rawPdfRoot, filename);
}

export function resolvePaperPdfPath(input: {
  workspaceDir: string;
  source: Exclude<PaperSource, "external">;
  canonicalId: string;
}): string {
  const filename = `${sanitizeFilenameComponent(input.source)}-${sanitizeCanonicalId(input.canonicalId)}.pdf`;
  return path.join(resolvePaperLibraryPaths(input.workspaceDir).rawPdfRoot, filename);
}

export function resolvePaperRecordPath(input: {
  workspaceDir: string;
  source: PaperSource;
  canonicalId?: string;
  articleUrl: string;
}): string {
  const paperKey = resolvePaperRecordKey({
    source: input.source,
    canonicalId: input.canonicalId,
    articleUrl: input.articleUrl
  });
  return path.join(getSourceAcquisitionRoot(input.workspaceDir), paperKey, "acquisition.json");
}

export function resolvePaperSourcePath(input: {
  workspaceDir: string;
  source: PaperSource;
  canonicalId?: string;
  articleUrl: string;
}): string {
  return path.join(path.dirname(resolvePaperRecordPath(input)), "source.json");
}

function resolvePaperSourcePathFromRecordPath(recordPath: string): string {
  return path.join(path.dirname(recordPath), "source.json");
}

function resolveIndexedDownloadPath(input: {
  workspaceDir: string;
  downloadPath: string;
}): string | null {
  const candidates = [input.downloadPath];
  const drivePathMatch = input.downloadPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drivePathMatch?.[1] && drivePathMatch[2]) {
    candidates.push(
      path.posix.join(
        "/mnt",
        drivePathMatch[1].toLowerCase(),
        ...drivePathMatch[2].split(/[\\/]+/).filter(Boolean)
      )
    );
  }

  const uncWslMatch = input.downloadPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+\\(.+)$/i);
  if (uncWslMatch?.[1]) {
    candidates.push(path.posix.join("/", ...uncWslMatch[1].split(/[\\/]+/).filter(Boolean)));
  }

  const paths = resolvePaperLibraryPaths(input.workspaceDir);
  const allowedRoots = [paths.rawPdfRoot].map((candidate) => path.resolve(candidate));

  for (const candidate of candidates) {
    const resolvedPath = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(input.workspaceDir, candidate);
    if (allowedRoots.some((root) => isPathInsideDirectory(root, resolvedPath))) {
      return resolvedPath;
    }
  }

  return null;
}

function isDownloadedPaperRecord(value: unknown): value is DownloadedPaperRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    record.status !== "downloaded" ||
    typeof record.source !== "string" ||
    typeof record.articleUrl !== "string" ||
    typeof record.recordedAt !== "string" ||
    typeof record.downloadPath !== "string"
  ) {
    return false;
  }

  if (record.source === "external") {
    return (
      (record.handlingMethod === "manual_file_import" || record.handlingMethod === "direct_http") &&
      typeof record.fileSha256 === "string" &&
      (record.openedUrl === undefined || typeof record.openedUrl === "string") &&
      (record.title === undefined || typeof record.title === "string") &&
      (record.pdfUrl === undefined || typeof record.pdfUrl === "string")
    );
  }

  return typeof record.canonicalId === "string" && typeof record.pdfUrl === "string";
}

function isCompatibleDownloadedPaperRecord(record: DownloadedPaperRecord): boolean {
  if (record.source !== "science") {
    return true;
  }

  try {
    const pdfUrl = new URL(record.pdfUrl);
    const pdfDoiMatch = pdfUrl.pathname.match(/^\/doi\/(?:epdf|pdf)\/(.+)$/i);
    return decodeURIComponent(pdfDoiMatch?.[1] ?? "").replace(/\.pdf$/i, "") === record.canonicalId;
  } catch {
    return false;
  }
}

function buildInitialDownloadManifest(input: {
  workspaceDir: string;
  record: PaperRecord;
}): Pick<PaperRecord, "download" | "reading" | "updatedAt"> {
  const updatedAt = input.record.recordedAt;
  if (input.record.status === "downloaded") {
    const pdfSha256 = input.record.source === "external" ? input.record.fileSha256 : undefined;
    return {
      updatedAt,
      download: {
        status: "downloaded",
        updatedAt,
        method: input.record.handlingMethod,
        pdfPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: input.record.downloadPath }),
        ...("pdfUrl" in input.record && input.record.pdfUrl ? { pdfUrl: input.record.pdfUrl } : {}),
        ...(pdfSha256 ? { pdfSha256 } : {})
      },
      reading: {
        status: "not_ready",
        updatedAt,
        reason: "PDF is downloaded, but markdown reading artifacts are not registered yet."
      }
    };
  }

  if (input.record.status === "manual_fallback_opened") {
    return {
      updatedAt,
      download: {
        status: "manual_fallback_opened",
        updatedAt,
        method: input.record.handlingMethod,
        failure: input.record.failure
      },
      reading: {
        status: "not_ready",
        updatedAt,
        reason: input.record.failure.message
      }
    };
  }

  if (input.record.status === "preprint_fallback") {
    const message =
      `Publisher version is not available yet; using arXiv preprint ${input.record.preprint.canonicalId}.`;
    return {
      updatedAt,
      download: {
        status: "preprint_fallback",
        updatedAt,
        method: input.record.handlingMethod,
        pdfPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: input.record.preprint.downloadPath }),
        pdfUrl: input.record.preprint.pdfUrl,
        message,
        failure: input.record.failure
      },
      reading: {
        status: "not_ready",
        updatedAt,
        reason: message
      }
    };
  }

  if (input.record.status === "publisher_pending") {
    return {
      updatedAt,
      download: {
        status: "publisher_pending",
        updatedAt,
        method: input.record.handlingMethod,
        message: input.record.failure.message,
        failure: input.record.failure
      },
      reading: {
        status: "not_ready",
        updatedAt,
        reason: input.record.failure.message
      }
    };
  }

  return {
    updatedAt,
    download: {
      status: "external_opened",
      updatedAt,
      method: input.record.handlingMethod,
      message: "External article page was opened, but no PDF is registered yet."
    },
    reading: {
      status: "not_ready",
      updatedAt,
      reason: "External article page was opened, but no markdown reading artifact is registered yet."
    }
  };
}

function withInitialRecordManifest(input: {
  workspaceDir: string;
  record: PaperRecord;
}): PaperRecord {
  const initial = buildInitialDownloadManifest(input);
  return {
    ...input.record,
    updatedAt: input.record.updatedAt ?? initial.updatedAt,
    download: input.record.download ?? initial.download,
    reading: input.record.reading ?? initial.reading
  };
}

function paperKeyFromRecordPath(recordPath: string): string {
  return path.basename(path.dirname(recordPath));
}

function readRecordString(record: PaperRecord, key: string): string | undefined {
  const value = (record as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getRecordCanonicalId(record: PaperRecord): string | undefined {
  return "canonicalId" in record && record.canonicalId ? record.canonicalId : undefined;
}

function getRecordPdfUrl(record: PaperRecord): string | undefined {
  if ("pdfUrl" in record && typeof record.pdfUrl === "string" && record.pdfUrl.trim()) {
    return record.pdfUrl;
  }
  return record.status === "preprint_fallback" ? record.preprint.pdfUrl : undefined;
}

function getRecordDownloadPath(record: PaperRecord): string | undefined {
  if ("downloadPath" in record && typeof record.downloadPath === "string" && record.downloadPath.trim()) {
    return record.downloadPath;
  }
  return record.status === "preprint_fallback" ? record.preprint.downloadPath : undefined;
}

function getRecordPublisher(source: PaperSource): string | undefined {
  if (source === "arxiv") {
    return "arXiv";
  }
  if (source === "science") {
    return "American Association for the Advancement of Science";
  }
  if (source === "nature") {
    return "Springer Nature";
  }
  if (source === "aps") {
    return "American Physical Society";
  }
  return undefined;
}

function getRecordDoi(record: PaperRecord): string | undefined {
  const canonicalId = getRecordCanonicalId(record);
  if (!canonicalId) {
    return undefined;
  }
  if ((record.source === "science" || record.source === "aps") && canonicalId.startsWith("10.")) {
    return canonicalId;
  }
  if (record.source === "nature" && /^s\d{5}-\d{3}-\d{5}-[a-z0-9]$/i.test(canonicalId)) {
    return `10.1038/${canonicalId}`;
  }
  return undefined;
}

function getRecordArxivId(record: PaperRecord): string | undefined {
  if (record.source === "arxiv" && record.canonicalId) {
    return record.canonicalId;
  }
  return undefined;
}

function getArxivYear(arxivId: string | undefined): number | undefined {
  const match = arxivId?.match(/^(\d{2})(\d{2})\.\d+/);
  if (!match?.[1]) {
    return undefined;
  }
  const year = Number(match[1]);
  return year >= 91 ? 1900 + year : 2000 + year;
}

function getApsVenueFromDoi(doi: string | undefined): string | undefined {
  const suffix = doi?.trim().replace(/^10\.1103\//i, "");
  const journalCode = suffix?.match(/^([A-Za-z]+)\.\d+\./)?.[1];
  if (!journalCode) {
    return undefined;
  }

  const venues = new Map<string, string>([
    ["PhysRevLett", "Phys. Rev. Lett."],
    ["PhysRevA", "Phys. Rev. A"],
    ["PhysRevB", "Phys. Rev. B"],
    ["PhysRevC", "Phys. Rev. C"],
    ["PhysRevD", "Phys. Rev. D"],
    ["PhysRevE", "Phys. Rev. E"],
    ["PhysRevX", "Phys. Rev. X"],
    ["PhysRevApplied", "Phys. Rev. Applied"],
    ["PhysRevResearch", "Phys. Rev. Research"],
    ["PhysRevMaterials", "Phys. Rev. Materials"],
    ["RevModPhys", "Rev. Mod. Phys."],
    ["PRXQuantum", "PRX Quantum"]
  ]);
  return venues.get(journalCode);
}

function getVenueFromArticleUrl(articleUrl: string): string | undefined {
  try {
    const hostname = new URL(articleUrl).hostname.replace(/^www\./i, "").toLowerCase();
    if (hostname === "quantum-journal.org") {
      return "Quantum";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function getMissingCitationFields(input: {
  title?: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  articleUrl?: string;
}): string[] {
  const missing: string[] = [];
  if (!input.title) {
    missing.push("title");
  }
  if (input.authors.length === 0) {
    missing.push("authors");
  }
  if (typeof input.year !== "number") {
    missing.push("year");
  }
  if (!input.venue) {
    missing.push("venue");
  }
  if (!input.doi && !input.arxivId && !input.articleUrl) {
    missing.push("stableIdentifier");
  }
  return missing;
}

function getSourceConfidence(input: {
  record: PaperRecord;
  title?: string;
  doi?: string;
  arxivId?: string;
}): PaperSourceMetadata["sourceConfidence"] {
  if ((input.doi || input.arxivId) && input.title) {
    return "high";
  }
  if (input.doi || input.arxivId || input.record.articleUrl) {
    return "medium";
  }
  return "low";
}

async function readExistingPaperSourceMetadata(sourcePath: string): Promise<Partial<PaperSourceMetadata> | undefined> {
  try {
    return JSON.parse(await readFile(sourcePath, "utf8")) as Partial<PaperSourceMetadata>;
  } catch {
    return undefined;
  }
}

type PaperSourceMetadataPatch = Partial<Pick<PaperSourceMetadata, "title" | "authors" | "year" | "venue" | "doi" | "arxivId">> & {
  resolvedFrom: PaperSourceMetadata["resolvedFrom"];
};

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeText(value: string | undefined): string {
  return decodeXml(value ?? "").replace(/\s+/g, " ").trim();
}

function resolveWorkspaceArtifactPath(input: { workspaceDir: string; filePath: string }): string {
  const normalizedFilePath = normalizePortableFilePath(input.filePath);
  return path.isAbsolute(normalizedFilePath)
    ? path.resolve(normalizedFilePath)
    : path.resolve(input.workspaceDir, normalizedFilePath);
}

function getRecordReadingParsePath(record: PaperRecord): string | undefined {
  return record.reading?.parsePath ?? record.webpage?.parsePath ?? record.parse?.parsePath;
}

async function readParsedPaperDocument(input: {
  workspaceDir: string;
  record: PaperRecord;
}): Promise<ParsedPaperDocument | undefined> {
  const parsePath = getRecordReadingParsePath(input.record);
  if (!parsePath) {
    return undefined;
  }

  try {
    return JSON.parse(
      await readFile(resolveWorkspaceArtifactPath({ workspaceDir: input.workspaceDir, filePath: parsePath }), "utf8")
    ) as ParsedPaperDocument;
  } catch {
    return undefined;
  }
}

function cleanAuthorLine(value: string): string {
  return normalizeText(value)
    .replace(/\b(?:PDF|Share|CITATIONS|Abstract)\b.*$/i, "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
    .replace(/\([^)]*contributed equally[^)]*\)/gi, "")
    .replace(/\^\s*\d+(?:\s*,\s*\d+)*/g, "")
    .replace(/(?<=[A-Za-z.])\d+(?:,\d+)*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitAuthorLine(value: string): string[] {
  const cleaned = cleanAuthorLine(value);
  if (
    !cleaned ||
    /\b(?:access|published|doi|abstract|keywords?|references?|copyright|download|supplementary)\b/i.test(cleaned)
  ) {
    return [];
  }

  return cleaned
    .replace(/\s+and\s+/gi, ", ")
    .split(/\s*,\s*/)
    .map((author) => author.replace(/\s+/g, " ").trim())
    .filter((author) =>
      author.length > 2 &&
      /\p{L}/u.test(author) &&
      !/^\d+$/.test(author) &&
      !/\b(?:university|institute|laboratory|department|division|center|centre|usa|china|japan|germany|france)\b/i.test(author)
    );
}

function findParsedAuthorLine(input: { document: ParsedPaperDocument; title?: string }): string | undefined {
  const texts = input.document.elements
    .slice(0, 40)
    .map((element) => normalizeText(element.text))
    .filter(Boolean);
  const normalizedTitle = normalizeText(input.title ?? input.document.title).toLowerCase();
  const titleIndex = normalizedTitle
    ? texts.findIndex((text) => text.toLowerCase() === normalizedTitle)
    : -1;
  const candidates = titleIndex >= 0 ? texts.slice(titleIndex + 1, titleIndex + 5) : texts.slice(0, 8);
  return candidates.find((text) => splitAuthorLine(text).length > 0);
}

function extractDoiFromParsedText(texts: string[]): string | undefined {
  const joined = texts.slice(0, 80).join(" ");
  return joined.match(/\b10\.\d{4,9}\/[^\s<>"']+/i)?.[0]?.replace(/[).,;]+$/, "");
}

function extractYearFromParsedText(texts: string[], arxivId?: string): number | undefined {
  for (const text of texts.slice(0, 80)) {
    const published = text.match(/\bPublished\b.*?\b(19\d{2}|20\d{2})\b/i);
    if (published?.[1]) {
      return Number(published[1]);
    }
  }
  const arxivYear = getArxivYear(arxivId);
  if (typeof arxivYear === "number") {
    return arxivYear;
  }
  const firstYear = texts.slice(0, 20).join(" ").match(/\b(19\d{2}|20\d{2})\b/);
  return firstYear?.[1] ? Number(firstYear[1]) : undefined;
}

function extractVenueFromParsedText(input: {
  texts: string[];
  source: PaperSource;
  arxivId?: string;
}): string | undefined {
  if (input.source === "arxiv" || input.arxivId) {
    return "arXiv";
  }

  for (const text of input.texts.slice(0, 80)) {
    const apsMatch = text.match(/^\s*((?:Phys\. Rev\.|Physical Review|PRX Quantum|Rev\. Mod\. Phys\.)[A-Za-z .]*)\s+\d+.*?\bPublished\b/i);
    if (apsMatch?.[1]) {
      return normalizeText(apsMatch[1]);
    }
    const natureMatch = text.match(/\b(Nature(?: [A-Z][A-Za-z]+)*|npj Quantum Information|Communications Physics)\b/);
    if (natureMatch?.[1]) {
      return normalizeText(natureMatch[1]);
    }
  }
  return undefined;
}

async function readLocalParseCitationMetadata(input: {
  workspaceDir: string;
  record: PaperRecord;
  arxivId?: string;
}): Promise<PaperSourceMetadataPatch | undefined> {
  const document = await readParsedPaperDocument(input);
  if (!document) {
    return undefined;
  }

  const title = normalizeText(document.title);
  const authorLine = findParsedAuthorLine({ document, title });
  const authors = authorLine ? splitAuthorLine(authorLine) : [];
  const texts = document.elements.map((element) => normalizeText(element.text)).filter(Boolean);
  const year = extractYearFromParsedText(texts, input.arxivId);
  const venue = extractVenueFromParsedText({ texts, source: input.record.source, arxivId: input.arxivId });
  const doi = extractDoiFromParsedText(texts);

  if (!title && authors.length === 0 && typeof year !== "number" && !venue && !doi) {
    return undefined;
  }

  return {
    resolvedFrom: "local_parse",
    ...(title ? { title } : {}),
    ...(authors.length > 0 ? { authors } : {}),
    ...(typeof year === "number" ? { year } : {}),
    ...(venue ? { venue } : {}),
    ...(doi ? { doi } : {})
  };
}

async function readArxivApiCitationMetadata(input: {
  arxivId: string;
  fetchImpl: typeof fetch;
}): Promise<PaperSourceMetadataPatch | undefined> {
  try {
    const endpoint = new URL("https://export.arxiv.org/api/query");
    endpoint.searchParams.set("id_list", input.arxivId);
    endpoint.searchParams.set("max_results", "1");
    const response = await input.fetchImpl(endpoint);
    if (!response.ok) {
      return undefined;
    }
    const entry = (await response.text()).match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];
    if (!entry) {
      return undefined;
    }
    const getFirstTag = (tagName: string) =>
      normalizeText(entry.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"))?.[1]);
    const authors = Array.from(entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi), (match) =>
      normalizeText(match[1])
    ).filter(Boolean);
    const publishedYear = getFirstTag("published").match(/\b(19\d{2}|20\d{2})\b/)?.[1];
    return {
      resolvedFrom: "arxiv_api",
      title: getFirstTag("title"),
      authors,
      ...(publishedYear ? { year: Number(publishedYear) } : {}),
      venue: "arXiv",
      arxivId: input.arxivId
    };
  } catch {
    return undefined;
  }
}

function formatCrossrefAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((author) => {
    if (!author || typeof author !== "object") {
      return [];
    }
    const record = author as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.trim()) {
      return [record.name.trim()];
    }
    const parts = [record.given, record.family].flatMap((part) =>
      typeof part === "string" && part.trim() ? [part.trim()] : []
    );
    return parts.length > 0 ? [parts.join(" ")] : [];
  });
}

function extractCrossrefYear(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("date-parts" in value)) {
    return undefined;
  }
  const dateParts = (value as { "date-parts"?: unknown })["date-parts"];
  if (!Array.isArray(dateParts) || !Array.isArray(dateParts[0])) {
    return undefined;
  }
  const year = dateParts[0][0];
  return typeof year === "number" ? year : undefined;
}

async function readCrossrefCitationMetadata(input: {
  doi: string;
  fetchImpl: typeof fetch;
}): Promise<PaperSourceMetadataPatch | undefined> {
  try {
    const response = await input.fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(input.doi)}`);
    if (!response.ok) {
      return undefined;
    }
    const message = ((await response.json()) as { message?: Record<string, unknown> }).message;
    if (!message) {
      return undefined;
    }
    const titles = Array.isArray(message.title) ? message.title : [];
    const venues = Array.isArray(message["container-title"]) ? message["container-title"] : [];
    const title = typeof titles[0] === "string" ? normalizeText(titles[0]) : undefined;
    const venue = typeof venues[0] === "string" ? normalizeText(venues[0]) : undefined;
    const doi = typeof message.DOI === "string" && message.DOI.trim() ? message.DOI.trim() : input.doi;
    const year =
      extractCrossrefYear(message.published) ??
      extractCrossrefYear(message["published-print"]) ??
      extractCrossrefYear(message["published-online"]) ??
      extractCrossrefYear(message.created);
    return {
      resolvedFrom: "crossref_api",
      ...(title ? { title } : {}),
      authors: formatCrossrefAuthors(message.author),
      ...(typeof year === "number" ? { year } : {}),
      ...(venue ? { venue } : {}),
      doi
    };
  } catch {
    return undefined;
  }
}

function normalizeCitationTitleForCompare(value: string | undefined): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[-‐‑‒–—]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function crossrefMessageToMetadataPatch(input: {
  message: Record<string, unknown>;
  fallbackDoi?: string;
  resolvedFrom: PaperSourceMetadataPatch["resolvedFrom"];
}): PaperSourceMetadataPatch | undefined {
  const titles = Array.isArray(input.message.title) ? input.message.title : [];
  const venues = Array.isArray(input.message["container-title"]) ? input.message["container-title"] : [];
  const title = typeof titles[0] === "string" ? normalizeText(titles[0]) : undefined;
  const venue = typeof venues[0] === "string" ? normalizeText(venues[0]) : undefined;
  const doi = typeof input.message.DOI === "string" && input.message.DOI.trim()
    ? input.message.DOI.trim()
    : input.fallbackDoi;
  const year =
    extractCrossrefYear(input.message.published) ??
    extractCrossrefYear(input.message["published-print"]) ??
    extractCrossrefYear(input.message["published-online"]) ??
    extractCrossrefYear(input.message.created);
  const authors = formatCrossrefAuthors(input.message.author);
  if (!title && authors.length === 0 && typeof year !== "number" && !venue && !doi) {
    return undefined;
  }
  return {
    resolvedFrom: input.resolvedFrom,
    ...(title ? { title } : {}),
    authors,
    ...(typeof year === "number" ? { year } : {}),
    ...(venue ? { venue } : {}),
    ...(doi ? { doi } : {})
  };
}

async function readCrossrefSearchCitationMetadata(input: {
  doi?: string;
  title?: string;
  fetchImpl: typeof fetch;
}): Promise<PaperSourceMetadataPatch | undefined> {
  const query = input.doi ?? input.title;
  if (!query?.trim()) {
    return undefined;
  }

  try {
    const endpoint = new URL("https://api.crossref.org/works");
    endpoint.searchParams.set("query.bibliographic", query);
    endpoint.searchParams.set("rows", "5");
    if (input.doi?.trim()) {
      endpoint.searchParams.set("filter", "type:journal-article");
    }
    const response = await input.fetchImpl(endpoint);
    if (!response.ok) {
      return undefined;
    }
    const items = (((await response.json()) as { message?: { items?: unknown[] } }).message?.items ?? [])
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
    const normalizedDoi = input.doi?.trim().toLowerCase();
    const normalizedTitle = normalizeCitationTitleForCompare(input.title);
    const match = items.find((item) => {
      const itemDoi = typeof item.DOI === "string" ? item.DOI.trim().toLowerCase() : undefined;
      if (normalizedDoi && itemDoi === normalizedDoi) {
        return true;
      }
      const titles = Array.isArray(item.title) ? item.title : [];
      const itemTitle = typeof titles[0] === "string" ? normalizeCitationTitleForCompare(titles[0]) : "";
      return Boolean(normalizedTitle && itemTitle === normalizedTitle);
    }) ?? items[0];
    return match
      ? crossrefMessageToMetadataPatch({
        message: match,
        ...(input.doi ? { fallbackDoi: input.doi } : {}),
        resolvedFrom: "crossref_search"
      })
      : undefined;
  } catch {
    return undefined;
  }
}

async function readSemanticScholarCitationMetadata(input: {
  doi: string;
  fetchImpl: typeof fetch;
}): Promise<PaperSourceMetadataPatch | undefined> {
  try {
    const endpoint = new URL(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(input.doi)}`);
    endpoint.searchParams.set("fields", "title,authors,year,venue,publicationVenue,externalIds");
    const response = await input.fetchImpl(endpoint);
    if (!response.ok) {
      return undefined;
    }
    const message = await response.json() as Record<string, unknown>;
    const authors = Array.isArray(message.authors)
      ? message.authors.flatMap((author) => {
        if (!author || typeof author !== "object") {
          return [];
        }
        const name = (author as Record<string, unknown>).name;
        return typeof name === "string" && name.trim() ? [name.trim()] : [];
      })
      : [];
    const publicationVenue = message.publicationVenue && typeof message.publicationVenue === "object"
      ? message.publicationVenue as Record<string, unknown>
      : undefined;
    const venue = typeof publicationVenue?.name === "string" && publicationVenue.name.trim()
      ? publicationVenue.name.trim()
      : typeof message.venue === "string" && message.venue.trim()
        ? message.venue.trim()
        : undefined;
    const externalIds = message.externalIds && typeof message.externalIds === "object"
      ? message.externalIds as Record<string, unknown>
      : undefined;
    const doi = typeof externalIds?.DOI === "string" && externalIds.DOI.trim()
      ? externalIds.DOI.trim()
      : input.doi;
    if (
      typeof message.title !== "string" &&
      authors.length === 0 &&
      typeof message.year !== "number" &&
      !venue &&
      !doi
    ) {
      return undefined;
    }
    return {
      resolvedFrom: "semantic_scholar_api",
      ...(typeof message.title === "string" && message.title.trim() ? { title: normalizeText(message.title) } : {}),
      authors,
      ...(typeof message.year === "number" ? { year: message.year } : {}),
      ...(venue ? { venue } : {}),
      doi
    };
  } catch {
    return undefined;
  }
}

function patchHasRequiredCitationCore(patch: PaperSourceMetadataPatch | undefined): boolean {
  return Boolean(
    patch &&
    Array.isArray(patch.authors) &&
    patch.authors.length > 0 &&
    typeof patch.year === "number" &&
    typeof patch.venue === "string" &&
    patch.venue.trim()
  );
}

async function readRemoteCitationMetadata(input: {
  doi?: string;
  arxivId?: string;
  title?: string;
  fetchImpl?: typeof fetch;
}): Promise<PaperSourceMetadataPatch | undefined> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    return undefined;
  }
  if (input.arxivId) {
    return readArxivApiCitationMetadata({ arxivId: input.arxivId, fetchImpl });
  }
  if (input.doi) {
    const exact = await readCrossrefCitationMetadata({ doi: input.doi, fetchImpl });
    if (patchHasRequiredCitationCore(exact)) {
      return exact;
    }
    const search = await readCrossrefSearchCitationMetadata({
      doi: input.doi,
      ...(input.title ? { title: input.title } : {}),
      fetchImpl
    });
    if (patchHasRequiredCitationCore(search)) {
      return search;
    }
    const semanticScholar = await readSemanticScholarCitationMetadata({ doi: input.doi, fetchImpl });
    if (semanticScholar) {
      return semanticScholar;
    }
    return search ?? exact;
  }
  if (input.title) {
    return readCrossrefSearchCitationMetadata({ title: input.title, fetchImpl });
  }
  return undefined;
}

function completeString(value: string | undefined, ...fallbacks: Array<string | undefined>): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  for (const fallback of fallbacks) {
    if (typeof fallback === "string" && fallback.trim()) {
      return fallback.trim();
    }
  }
  return undefined;
}

function completeAuthors(authors: string[], ...fallbacks: Array<string[] | undefined>): string[] {
  if (authors.length > 0) {
    return authors;
  }
  for (const fallback of fallbacks) {
    const normalized = Array.isArray(fallback)
      ? fallback.filter((author): author is string => typeof author === "string" && author.trim().length > 0)
      : [];
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return [];
}

export async function writePaperSourceMetadataForRecord(input: {
  workspaceDir: string;
  record: PaperRecord;
  recordPath: string;
  enrichCitationMetadata?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const sourcePath = resolvePaperSourcePathFromRecordPath(input.recordPath);
  const existing = await readExistingPaperSourceMetadata(sourcePath);
  const acquisitionPath = toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: input.recordPath });
  const baseDoi = getRecordDoi(input.record) ?? existing?.doi;
  const baseArxivId = getRecordArxivId(input.record) ?? existing?.arxivId;
  const baseTitle = readRecordString(input.record, "title") ?? existing?.title;
  const localParseMetadata = await readLocalParseCitationMetadata({
    workspaceDir: input.workspaceDir,
    record: input.record,
    ...(baseArxivId ? { arxivId: baseArxivId } : {})
  });
  const remoteMetadata = input.enrichCitationMetadata
    ? await readRemoteCitationMetadata({
        ...(baseDoi ? { doi: baseDoi } : {}),
        ...(baseArxivId ? { arxivId: baseArxivId } : {}),
        ...(baseTitle ? { title: baseTitle } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
      })
    : undefined;
  const title = completeString(readRecordString(input.record, "title"), existing?.title, localParseMetadata?.title, remoteMetadata?.title);
  const authors = completeAuthors(
    Array.isArray(existing?.authors)
    ? existing.authors.filter((author): author is string => typeof author === "string" && author.trim().length > 0)
    : [],
    localParseMetadata?.authors,
    remoteMetadata?.authors
  );
  const year = typeof existing?.year === "number"
    ? existing.year
    : localParseMetadata?.year ?? remoteMetadata?.year ?? getArxivYear(baseArxivId);
  const venue = completeString(
    existing?.venue,
    localParseMetadata?.venue,
    remoteMetadata?.venue,
    getApsVenueFromDoi(baseDoi),
    getVenueFromArticleUrl(input.record.articleUrl),
    baseArxivId ? "arXiv" : undefined
  );
  const publisher = getRecordPublisher(input.record.source) ?? existing?.publisher;
  const doi = baseDoi ?? localParseMetadata?.doi ?? remoteMetadata?.doi;
  const arxivId = baseArxivId ?? remoteMetadata?.arxivId;
  const missingFields = getMissingCitationFields({
    title,
    authors,
    year,
    venue,
    doi,
    arxivId,
    articleUrl: input.record.articleUrl
  });
  const pdfUrl = getRecordPdfUrl(input.record);
  const downloadPath = getRecordDownloadPath(input.record);
  const resolvedFrom = missingFields.length === 0 && remoteMetadata
    ? remoteMetadata.resolvedFrom
    : missingFields.length === 0 && localParseMetadata
      ? localParseMetadata.resolvedFrom
      : "acquisition";
  const sourceMetadata: PaperSourceMetadata = {
    ...existing,
    schemaVersion: 2,
    paperKey: paperKeyFromRecordPath(input.recordPath),
    source: input.record.source,
    ...(getRecordCanonicalId(input.record) ? { canonicalId: getRecordCanonicalId(input.record) } : {}),
    ...(title ? { title } : {}),
    authors,
    ...(typeof year === "number" ? { year } : {}),
    ...(venue ? { venue } : {}),
    ...(publisher ? { publisher } : {}),
    ...(doi ? { doi } : {}),
    ...(arxivId ? { arxivId } : {}),
    articleUrl: input.record.articleUrl,
    ...(pdfUrl ? { pdfUrl } : {}),
    ...(downloadPath ? { downloadPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: downloadPath }) } : {}),
    acquisitionPath,
    recordPath: acquisitionPath,
    ...(existing?.bibPath ? { bibPath: existing.bibPath } : {}),
    ...(existing?.cslPath ? { cslPath: existing.cslPath } : {}),
    downloadStatus: input.record.status,
    ...(input.record.reading?.status ? { readingStatus: input.record.reading.status } : {}),
    citationStatus: missingFields.length === 0 ? "complete" : "incomplete",
    missingFields,
    resolvedFrom,
    sourceConfidence: getSourceConfidence({ record: input.record, title, doi, arxivId }),
    recordedAt: input.record.recordedAt,
    updatedAt: input.record.updatedAt ?? input.record.recordedAt,
    ...(input.record.status === "preprint_fallback" ? {
      preprintFallback: {
        arxivId: input.record.preprint.canonicalId,
        articleUrl: input.record.preprint.articleUrl,
        pdfUrl: input.record.preprint.pdfUrl,
        acquisitionPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: input.record.preprint.recordPath }),
        downloadPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: input.record.preprint.downloadPath }),
        status: input.record.preprint.status
      }
    } : {})
  };

  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, `${JSON.stringify(sourceMetadata, null, 2)}\n`, "utf8");
  return sourcePath;
}

function readSourceString(source: Partial<PaperSourceMetadata>, key: string): string | undefined {
  const value = (source as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function deriveCanonicalIdFromArticleUrl(source: PaperSource | undefined, articleUrl: string): string | undefined {
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

function paperRecordFromSourceMetadata(input: {
  existing: Partial<PaperSourceMetadata> | undefined;
}): PaperRecord {
  const existing = input.existing;
  const source = existing?.source;
  const articleUrl = readSourceString(existing ?? {}, "articleUrl");
  if (!source || !articleUrl) {
    throw new Error("source.json must include source and articleUrl before citation metadata can be refreshed.");
  }

  const canonicalId = readSourceString(existing, "canonicalId") ?? deriveCanonicalIdFromArticleUrl(source, articleUrl);
  const recordedAt = readSourceString(existing, "recordedAt") ?? readSourceString(existing, "createdAt") ?? new Date().toISOString();
  const title = readSourceString(existing, "title");
  const pdfUrl = readSourceString(existing, "pdfUrl");
  const downloadPath = readSourceString(existing, "downloadPath") ?? readSourceString(existing, "pdfPath");
  const updatedAt = readSourceString(existing, "updatedAt") ?? recordedAt;

  return {
    source,
    articleUrl,
    recordedAt,
    handlingMethod: "source_metadata_refresh",
    status: existing.downloadStatus ?? "external_opened",
    ...(canonicalId ? { canonicalId } : {}),
    ...(title ? { title } : {}),
    ...(pdfUrl ? { pdfUrl } : {}),
    ...(downloadPath ? { downloadPath } : {}),
    ...(existing.readingStatus ? {
      reading: {
        status: existing.readingStatus,
        updatedAt
      }
    } : {})
  } as unknown as PaperRecord;
}

export async function writePaperSourceMetadataForSource(input: {
  workspaceDir: string;
  sourcePath: string;
  enrichCitationMetadata?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const sourcePath = path.isAbsolute(input.sourcePath)
    ? path.resolve(input.sourcePath)
    : path.resolve(input.workspaceDir, input.sourcePath);
  const existing = await readExistingPaperSourceMetadata(sourcePath);
  const recordPath = path.join(path.dirname(sourcePath), "acquisition.json");
  const record = paperRecordFromSourceMetadata({ existing });
  return writePaperSourceMetadataForRecord({
    workspaceDir: input.workspaceDir,
    record,
    recordPath,
    enrichCitationMetadata: input.enrichCitationMetadata,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}

async function writePaperRecordAndSourceMetadata(input: {
  workspaceDir: string;
  record: PaperRecord;
  recordPath: string;
  enrichCitationMetadata?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  await writeFile(input.recordPath, `${JSON.stringify(input.record, null, 2)}\n`, "utf8");
  await writePaperSourceMetadataForRecord({
    workspaceDir: input.workspaceDir,
    record: input.record,
    recordPath: input.recordPath,
    ...(input.enrichCitationMetadata !== undefined ? { enrichCitationMetadata: input.enrichCitationMetadata } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}

function resolveInputRecordPath(input: { workspaceDir: string; recordPath: string }): string {
  const normalizedRecordPath = normalizePortableFilePath(input.recordPath);
  return path.isAbsolute(normalizedRecordPath)
    ? path.resolve(normalizedRecordPath)
    : path.resolve(input.workspaceDir, normalizedRecordPath);
}

function assertRecordPathInsideAcquisitionStore(input: { workspaceDir: string; recordPath: string }): string {
  const sourceArtifactsRoot = path.resolve(getSourceAcquisitionRoot(input.workspaceDir));
  const recordPath = resolveInputRecordPath(input);
  const isSourceAcquisitionPath =
    path.basename(recordPath) === "acquisition.json" &&
    isPathInsideDirectory(sourceArtifactsRoot, recordPath);
  if (!isSourceAcquisitionPath) {
    throw new Error("recordPath must be inside knowledge-base/sources/*/acquisition.json.");
  }
  return recordPath;
}

function stripRecordManifest<T extends PaperRecord>(record: T): T {
  const {
    updatedAt: _updatedAt,
    download: _download,
    parse: _parse,
    webpage: _webpage,
    reading: _reading,
    ...legacyRecord
  } = record;
  return legacyRecord as T;
}

export async function readPaperRecord(input: {
  workspaceDir: string;
  source: PaperSource;
  canonicalId?: string;
  articleUrl: string;
}): Promise<{ record: PaperRecord; recordPath: string } | null> {
  const recordPath = resolvePaperRecordPath({
    workspaceDir: input.workspaceDir,
    source: input.source,
    canonicalId: input.canonicalId,
    articleUrl: input.articleUrl
  });

  try {
    return {
      record: JSON.parse(await readFile(recordPath, "utf8")) as PaperRecord,
      recordPath
    };
  } catch {
    return null;
  }
}

export async function readPaperRecordByPath(input: {
  workspaceDir: string;
  recordPath: string;
}): Promise<{ record: PaperRecord; recordPath: string } | null> {
  const recordPath = assertRecordPathInsideAcquisitionStore(input);
  try {
    return {
      record: JSON.parse(await readFile(recordPath, "utf8")) as PaperRecord,
      recordPath
    };
  } catch {
    return null;
  }
}

export async function findDownloadedPaperRecord(
  input: FindDownloadedPaperRecordInput
): Promise<DownloadedPaperRecordMatch | null> {
  const saved = await readPaperRecord(input);
  if (!saved) {
    return null;
  }
  const { record, recordPath } = saved;

  if (
    !isDownloadedPaperRecord(record) ||
    !isCompatibleDownloadedPaperRecord(record) ||
    record.source !== input.source ||
    (input.source === "external" && record.articleUrl !== input.articleUrl) ||
    (input.source !== "external" && record.canonicalId !== input.canonicalId)
  ) {
    return null;
  }

  const downloadPath = resolveIndexedDownloadPath({
    workspaceDir: input.workspaceDir,
    downloadPath: record.downloadPath
  });
  if (downloadPath === null) {
    return null;
  }

  try {
    await access(downloadPath);
  } catch {
    return null;
  }

  return {
    record: stripRecordManifest(record),
    recordPath,
    downloadPath
  };
}

export async function writePaperRecord(input: {
  workspaceDir: string;
  record: PaperRecord;
  enrichCitationMetadata?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const record = withInitialRecordManifest(input);
  const recordPath = resolvePaperRecordPath({
    workspaceDir: input.workspaceDir,
    source: record.source,
    canonicalId: record.canonicalId,
    articleUrl: record.articleUrl
  });
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writePaperRecordAndSourceMetadata({
    workspaceDir: input.workspaceDir,
    record,
    recordPath,
    ...(input.enrichCitationMetadata !== undefined ? { enrichCitationMetadata: input.enrichCitationMetadata } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  return recordPath;
}

export async function updatePaperRecordParseManifest(input: PaperRecordParseManifestInput): Promise<void> {
  const saved = await readPaperRecordByPath({
    workspaceDir: input.workspaceDir,
    recordPath: input.recordPath
  });
  if (!saved) {
    return;
  }

  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const artifact: PaperRecordArtifactManifest = {
    status: input.status,
    updatedAt,
    paperKey: input.paperKey,
    engine: input.engine,
    sourceSha256: input.sourceSha256,
    markdownPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: input.artifacts.markdownPath }),
    parsePath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: input.artifacts.parsePath }),
    qualityPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: input.artifacts.qualityPath }),
    chunksPath: toWorkspacePath({ workspaceDir: input.workspaceDir, filePath: input.artifacts.chunksPath }),
    quality: toQualitySummary(input.quality)
  };
  const reading: PaperRecordReadingManifest = {
    status: "ready",
    updatedAt,
    preferredSource: input.strategy,
    paperKey: input.paperKey,
    markdownPath: artifact.markdownPath,
    parsePath: artifact.parsePath,
    qualityPath: artifact.qualityPath,
    chunksPath: artifact.chunksPath,
    quality: artifact.quality,
    reason:
      input.strategy === "webpage"
        ? "Publisher or arXiv webpage markdown is ready for reading."
        : "PDF markdown parse is ready for reading."
  };
  const record: PaperRecord = {
    ...saved.record,
    updatedAt,
    ...(input.strategy === "webpage" ? { webpage: artifact } : { parse: artifact }),
    reading
  };

  await writePaperRecordAndSourceMetadata({ workspaceDir: input.workspaceDir, record, recordPath: saved.recordPath });
}

export async function updatePaperRecordReadingFailure(input: PaperRecordReadingFailureInput): Promise<void> {
  const saved = await readPaperRecordByPath({
    workspaceDir: input.workspaceDir,
    recordPath: input.recordPath
  });
  if (!saved) {
    return;
  }

  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const artifact: PaperRecordArtifactManifest = {
    status: "failed",
    updatedAt,
    message: input.message
  };
  const failedReading: PaperRecordReadingManifest = {
    status: "failed",
    updatedAt,
    preferredSource: input.strategy,
    reason: input.message
  };
  const reading =
    saved.record.reading?.status === "ready" && saved.record.reading.preferredSource !== input.strategy
      ? saved.record.reading
      : failedReading;
  const record: PaperRecord = {
    ...saved.record,
    updatedAt,
    ...(input.strategy === "webpage" ? { webpage: artifact } : { parse: artifact }),
    reading
  };

  await writePaperRecordAndSourceMetadata({ workspaceDir: input.workspaceDir, record, recordPath: saved.recordPath });
}

export async function updatePaperRecordQueuedReading(input: PaperRecordQueuedReadingInput): Promise<void> {
  const saved = await readPaperRecordByPath({
    workspaceDir: input.workspaceDir,
    recordPath: input.recordPath
  });
  if (!saved) {
    return;
  }

  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const artifact: PaperRecordArtifactManifest = {
    status: "queued",
    updatedAt,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    message: input.message
  };
  const record: PaperRecord = {
    ...saved.record,
    updatedAt,
    ...(input.strategy === "webpage" ? { webpage: artifact } : { parse: artifact }),
    reading: {
      status: "queued",
      updatedAt,
      preferredSource: input.strategy,
      ...(input.jobId ? { reason: `${input.message} Job ID: ${input.jobId}` } : { reason: input.message })
    }
  };

  await writePaperRecordAndSourceMetadata({ workspaceDir: input.workspaceDir, record, recordPath: saved.recordPath });
}
