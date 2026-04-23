import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PaperRecord, PaperSource } from "./paper-types.js";

function sanitizeFilenameComponent(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "");
}

function getRecordIndexDir(workspaceDir: string): string {
  return path.join(workspaceDir, "downloads", "papers", "index");
}

function getExternalRecordFilename(articleUrl: string): string {
  const hostname = sanitizeFilenameComponent(new URL(articleUrl).hostname);
  const hash = createHash("sha1").update(articleUrl).digest("hex").slice(0, 12);
  return `external-${hostname}-${hash}.json`;
}

export function resolvePaperPdfPath(input: {
  workspaceDir: string;
  source: Exclude<PaperSource, "external">;
  canonicalId: string;
}): string {
  const filename = `${sanitizeFilenameComponent(input.source)}-${sanitizeFilenameComponent(
    input.canonicalId
  )}.pdf`;
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
  const canonicalId = input.canonicalId!;

  const filename =
    input.source === "external"
      ? getExternalRecordFilename(input.articleUrl)
      : `${sanitizeFilenameComponent(input.source)}-${sanitizeFilenameComponent(canonicalId)}.json`;

  return path.join(getRecordIndexDir(input.workspaceDir), filename);
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
