import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isPathInsideDirectory,
  resolvePaperLibraryPaths
} from "./knowledge-base.js";
import type {
  DownloadablePaperSource,
  PaperRecord,
  PaperRecordArtifactManifest,
  PaperRecordReadingManifest,
  PaperSource
} from "./paper-types.js";

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

function getRecordIndexDir(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).recordsRoot;
}

function toWorkspacePath(input: { workspaceDir: string; filePath: string }): string {
  const resolvedFilePath = path.resolve(input.filePath);
  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);
  return isPathInsideDirectory(resolvedWorkspaceDir, resolvedFilePath)
    ? path.relative(resolvedWorkspaceDir, resolvedFilePath)
    : input.filePath;
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
  if (input.source !== "external" && !input.canonicalId) {
    throw new Error("canonicalId is required for supported paper sources.");
  }
  const canonicalId = input.canonicalId ? sanitizeCanonicalId(input.canonicalId) : undefined;

  const filename =
    input.source === "external"
      ? getExternalRecordFilename(input.articleUrl)
      : `${sanitizeFilenameComponent(input.source)}-${canonicalId}.json`;

  return path.join(getRecordIndexDir(input.workspaceDir), filename);
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
    const pdfDoiMatch = pdfUrl.pathname.match(/^\/doi\/epdf\/(.+)$/i);
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

function assertRecordPathInsideRecords(input: { workspaceDir: string; recordPath: string }): string {
  const recordsRoot = path.resolve(getRecordIndexDir(input.workspaceDir));
  const recordPath = path.resolve(input.recordPath);
  if (!isPathInsideDirectory(recordsRoot, recordPath)) {
    throw new Error("recordPath must be inside knowledge-base/records.");
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
  const recordPath = assertRecordPathInsideRecords(input);
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
}): Promise<string> {
  const record = withInitialRecordManifest(input);
  const recordPath = resolvePaperRecordPath({
    workspaceDir: input.workspaceDir,
    source: record.source,
    canonicalId: record.canonicalId,
    articleUrl: record.articleUrl
  });
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
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

  await writeFile(saved.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
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
  const record: PaperRecord = {
    ...saved.record,
    updatedAt,
    ...(input.strategy === "webpage" ? { webpage: artifact } : { parse: artifact }),
    reading: {
      status: "failed",
      updatedAt,
      preferredSource: input.strategy,
      reason: input.message
    }
  };

  await writeFile(saved.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
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

  await writeFile(saved.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}
