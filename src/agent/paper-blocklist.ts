import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePaperLibraryPaths } from "./knowledge-base.js";
import type { PaperSource } from "./paper-types.js";

export type PaperBlockReasonCode =
  | "irrelevant"
  | "license_denied"
  | "not_a_paper"
  | "download_failed"
  | "duplicate"
  | "other";

export interface PaperBlocklistEntry {
  createdAt: string;
  reasonCode: PaperBlockReasonCode;
  paperKey?: string;
  source?: PaperSource;
  canonicalId?: string;
  articleUrl?: string;
  title?: string;
  note?: string;
}

export interface PaperBlocklistLookup {
  paperKey?: string;
  source?: PaperSource;
  canonicalId?: string;
  articleUrl?: string;
  title?: string;
}

export interface BlockPaperDownloadOptions extends PaperBlocklistLookup {
  workspaceDir: string;
  reasonCode: PaperBlockReasonCode;
  note?: string;
  createdAt?: string;
}

const VALID_REASON_CODES = new Set<PaperBlockReasonCode>([
  "irrelevant",
  "license_denied",
  "not_a_paper",
  "download_failed",
  "duplicate",
  "other"
]);

const VALID_SOURCES = new Set<PaperSource>(["arxiv", "science", "nature", "aps", "external"]);

function getBlocklistPath(workspaceDir: string): string {
  return path.join(resolvePaperLibraryPaths(workspaceDir).stateRoot, "paper-blocklist.jsonl");
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSource(value: unknown): PaperSource | undefined {
  return typeof value === "string" && VALID_SOURCES.has(value as PaperSource)
    ? value as PaperSource
    : undefined;
}

function normalizeReasonCode(value: unknown): PaperBlockReasonCode | undefined {
  return typeof value === "string" && VALID_REASON_CODES.has(value as PaperBlockReasonCode)
    ? value as PaperBlockReasonCode
    : undefined;
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}

function normalizeTitle(value: string | undefined): string | undefined {
  const normalized = value
    ?.normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
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

export function derivePaperKeyForBlocklist(input: {
  source?: PaperSource;
  canonicalId?: string;
}): string | undefined {
  if (!input.source || !input.canonicalId) {
    return undefined;
  }
  return sanitizePaperKey(`${input.source}-${input.canonicalId}`);
}

function parseEntry(value: unknown): PaperBlocklistEntry | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const createdAt = readOptionalString(record, "createdAt");
  const reasonCode = normalizeReasonCode(record.reasonCode);
  if (!createdAt || !reasonCode) {
    return undefined;
  }
  const source = normalizeSource(record.source);
  const entry: PaperBlocklistEntry = {
    createdAt,
    reasonCode,
    ...(readOptionalString(record, "paperKey") ? { paperKey: readOptionalString(record, "paperKey") } : {}),
    ...(source ? { source } : {}),
    ...(readOptionalString(record, "canonicalId") ? { canonicalId: readOptionalString(record, "canonicalId") } : {}),
    ...(readOptionalString(record, "articleUrl") ? { articleUrl: readOptionalString(record, "articleUrl") } : {}),
    ...(readOptionalString(record, "title") ? { title: readOptionalString(record, "title") } : {}),
    ...(readOptionalString(record, "note") ? { note: readOptionalString(record, "note") } : {})
  };
  return hasBlocklistIdentifier(entry) ? entry : undefined;
}

function hasBlocklistIdentifier(input: PaperBlocklistLookup): boolean {
  return Boolean(
    input.paperKey?.trim() ||
    input.canonicalId?.trim() ||
    input.articleUrl?.trim() ||
    input.title?.trim()
  );
}

export async function readPaperBlocklist(workspaceDir: string): Promise<PaperBlocklistEntry[]> {
  const filePath = getBlocklistPath(workspaceDir);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const entries: PaperBlocklistEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const entry = parseEntry(JSON.parse(trimmed));
      if (entry) {
        entries.push(entry);
      }
    } catch {
      continue;
    }
  }
  return entries;
}

function matchesEntry(entry: PaperBlocklistEntry, lookup: PaperBlocklistLookup): boolean {
  const lookupSource = lookup.source;
  const entrySource = entry.source;
  const sameSource = !entrySource || !lookupSource || entrySource === lookupSource;

  const lookupPaperKeys = [
    lookup.paperKey,
    derivePaperKeyForBlocklist({ source: lookup.source, canonicalId: lookup.canonicalId })
  ].map(normalizeIdentifier).filter(Boolean);
  const entryPaperKey = normalizeIdentifier(entry.paperKey);
  if (entryPaperKey && lookupPaperKeys.includes(entryPaperKey)) {
    return true;
  }

  const entryCanonicalId = normalizeIdentifier(entry.canonicalId);
  const lookupCanonicalId = normalizeIdentifier(lookup.canonicalId);
  if (sameSource && entryCanonicalId && lookupCanonicalId && entryCanonicalId === lookupCanonicalId) {
    return true;
  }

  const entryUrl = normalizeUrl(entry.articleUrl);
  const lookupUrl = normalizeUrl(lookup.articleUrl);
  if (entryUrl && lookupUrl && entryUrl === lookupUrl) {
    return true;
  }

  const entryTitle = normalizeTitle(entry.title);
  const lookupTitle = normalizeTitle(lookup.title);
  if (entryTitle && lookupTitle && entryTitle.length >= 16 && entryTitle === lookupTitle) {
    return true;
  }

  return false;
}

export async function findBlockedPaperDownload(options: {
  workspaceDir: string;
  lookup: PaperBlocklistLookup;
}): Promise<PaperBlocklistEntry | undefined> {
  if (!hasBlocklistIdentifier(options.lookup)) {
    return undefined;
  }

  const entries = await readPaperBlocklist(options.workspaceDir);
  return entries.find((entry) => matchesEntry(entry, options.lookup));
}

export async function blockPaperDownload(options: BlockPaperDownloadOptions): Promise<{
  status: "blocked";
  entry: PaperBlocklistEntry;
  blocklistPath: string;
}> {
  if (!hasBlocklistIdentifier(options)) {
    throw new Error("At least one of paperKey, canonicalId, articleUrl, or title is required.");
  }

  const entry: PaperBlocklistEntry = {
    createdAt: options.createdAt ?? new Date().toISOString(),
    reasonCode: options.reasonCode,
    ...(options.paperKey?.trim() ? { paperKey: options.paperKey.trim() } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.canonicalId?.trim() ? { canonicalId: options.canonicalId.trim() } : {}),
    ...(options.articleUrl?.trim() ? { articleUrl: options.articleUrl.trim() } : {}),
    ...(options.title?.trim() ? { title: options.title.trim() } : {}),
    ...(options.note?.trim() ? { note: options.note.trim() } : {})
  };
  const blocklistPath = getBlocklistPath(options.workspaceDir);
  await mkdir(path.dirname(blocklistPath), { recursive: true });
  await writeFile(blocklistPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
  return {
    status: "blocked",
    entry,
    blocklistPath
  };
}
