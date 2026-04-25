import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DownloadablePaperSource, PaperRecord, PaperSource } from "./paper-types.js";

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
  return path.join(workspaceDir, "downloads", "papers", "index");
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
  return path.join(input.workspaceDir, "downloads", "papers", filename);
}

export function resolvePaperPdfPath(input: {
  workspaceDir: string;
  source: Exclude<PaperSource, "external">;
  canonicalId: string;
}): string {
  const filename = `${sanitizeFilenameComponent(input.source)}-${sanitizeCanonicalId(input.canonicalId)}.pdf`;
  return path.join(input.workspaceDir, "downloads", "papers", filename);
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

function isPathInsideDirectory(rootDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootDir, candidatePath);
  return (
    relativePath === "" ||
    (
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    )
  );
}

function resolveIndexedDownloadPath(input: {
  workspaceDir: string;
  downloadPath: string;
}): string | null {
  const resolvedPath = path.isAbsolute(input.downloadPath)
    ? path.resolve(input.downloadPath)
    : path.resolve(input.workspaceDir, input.downloadPath);
  const papersDir = path.resolve(input.workspaceDir, "downloads", "papers");

  return isPathInsideDirectory(papersDir, resolvedPath) ? resolvedPath : null;
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
      record.handlingMethod === "manual_file_import" &&
      typeof record.fileSha256 === "string" &&
      (record.openedUrl === undefined || typeof record.openedUrl === "string") &&
      (record.title === undefined || typeof record.title === "string")
    );
  }

  return typeof record.canonicalId === "string" && typeof record.pdfUrl === "string";
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
    record.source !== input.source ||
    record.articleUrl !== input.articleUrl ||
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
    record,
    recordPath,
    downloadPath
  };
}

export async function writePaperRecord(input: {
  workspaceDir: string;
  record: PaperRecord;
}): Promise<string> {
  const recordPath = resolvePaperRecordPath({
    workspaceDir: input.workspaceDir,
    source: input.record.source,
    canonicalId: input.record.canonicalId,
    articleUrl: input.record.articleUrl
  });
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(input.record, null, 2)}\n`, "utf8");
  return recordPath;
}
