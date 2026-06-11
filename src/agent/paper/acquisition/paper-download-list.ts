import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath, resolveWorkspaceWritablePath, relativeWorkspacePath } from "../../file-tools.js";
import { listLocalPapers, type LocalPaperEntry } from "../storage/local-paper-library.js";
import { parseArxivLocator } from "./arxiv.js";

export interface PaperDownloadListCandidate {
  id?: string;
  url?: string;
  title?: string;
  note?: string;
  lastError?: string;
}

export interface StagePaperDownloadListOptions {
  workspaceDir: string;
  candidates: PaperDownloadListCandidate[];
  listPath?: string;
}

export interface StagePaperDownloadListResult {
  listPath: string;
  totalCandidates: number;
  retainedCandidates: number;
  duplicatesRemoved: number;
}

export interface DownloadPaperListOptions {
  workspaceDir: string;
  listPath: string;
  maxItems?: number;
  dryRun?: boolean;
  downloadPaperImpl: (options: {
    workspaceDir: string;
    id?: string;
    url?: string;
    title?: string;
  }) => Promise<unknown>;
}

export interface DownloadPaperListResult {
  listPath: string;
  totalCandidates: number;
  attempted: number;
  downloaded: number;
  failed: number;
  skippedAlreadyDownloaded: number;
  remainingCandidates: number;
  results: Array<{
    candidate: PaperDownloadListCandidate;
    status: "already_downloaded" | "downloaded" | "failed" | "dry_run";
    message: string;
    details?: unknown;
  }>;
}

const DEFAULT_LIST_DIR = ".memory/paper-download-lists";
const DEFAULT_MAX_DOWNLOAD_ITEMS = 50;
const YAML_SPECIAL_CHARS = /[:#\-\[\]{}&,*!|>'"%@`]/;

function compactText(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  return compact ? compact : undefined;
}

function normalizeArxivCandidateId(id: string | undefined): string | undefined {
  const compact = compactText(id)?.replace(/^arxiv:/i, "");
  if (!compact) {
    return undefined;
  }
  try {
    return parseArxivLocator(compact).id;
  } catch {
    return compact;
  }
}

function arxivIdFromUrl(url: string | undefined): string | undefined {
  const compact = compactText(url);
  if (!compact) {
    return undefined;
  }
  try {
    return parseArxivLocator(compact).id;
  } catch {
    return undefined;
  }
}

function normalizeCandidate(candidate: PaperDownloadListCandidate): PaperDownloadListCandidate | undefined {
  const url = compactText(candidate.url);
  const id = normalizeArxivCandidateId(candidate.id) ?? arxivIdFromUrl(url);
  const title = compactText(candidate.title);
  const note = compactText(candidate.note);
  const lastError = compactText(candidate.lastError);
  if (!id && !url && !title) {
    return undefined;
  }
  return {
    ...(id ? { id } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(note ? { note } : {}),
    ...(lastError ? { lastError } : {})
  };
}

function candidateKey(candidate: PaperDownloadListCandidate): string {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) {
    return "";
  }
  if (normalized.id) {
    return `id:${normalized.id.toLowerCase()}`;
  }
  if (normalized.url) {
    return `url:${normalized.url.toLowerCase()}`;
  }
  return `title:${normalized.title?.toLowerCase() ?? ""}`;
}

function dedupeCandidates(candidates: PaperDownloadListCandidate[]): PaperDownloadListCandidate[] {
  const seen = new Set<string>();
  const deduped: PaperDownloadListCandidate[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) {
      continue;
    }
    const key = candidateKey(normalized);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

function quoteYamlValue(value: string): string {
  if (!value || /^\s|\s$/.test(value) || YAML_SPECIAL_CHARS.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function serializeCandidateLine(candidate: PaperDownloadListCandidate): string {
  const fields: string[] = [];
  if (candidate.id) {
    fields.push(`id: ${quoteYamlValue(candidate.id)}`);
  }
  if (candidate.url) {
    fields.push(`url: ${quoteYamlValue(candidate.url)}`);
  }
  if (candidate.title) {
    fields.push(`title: ${quoteYamlValue(candidate.title)}`);
  }
  if (candidate.note) {
    fields.push(`note: ${quoteYamlValue(candidate.note)}`);
  }
  if (candidate.lastError) {
    fields.push(`lastError: ${quoteYamlValue(candidate.lastError)}`);
  }
  return `- ${fields.join("; ")}`;
}

function serializeDownloadList(candidates: PaperDownloadListCandidate[]): string {
  return [
    "# Temporary Paper Download List",
    "",
    "Each bullet is a normalized candidate generated from a non-strict reading list.",
    "download_paper_list removes candidates once they are already local or downloaded successfully.",
    "",
    "## Candidates",
    "",
    ...candidates.map(serializeCandidateLine),
    ""
  ].join("\n");
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseCandidateLine(line: string): PaperDownloadListCandidate | undefined {
  const body = line.replace(/^\s*-\s*/, "").trim();
  if (!body) {
    return undefined;
  }
  const candidate: PaperDownloadListCandidate = {};
  for (const part of body.split(/\s*;\s*/)) {
    const match = part.match(/^([A-Za-z][A-Za-z0-9]*):\s*([\s\S]*)$/);
    if (!match?.[1]) {
      continue;
    }
    const key = match[1];
    const value = parseYamlScalar(match[2] ?? "");
    if (key === "id") {
      candidate.id = value;
    } else if (key === "url") {
      candidate.url = value;
    } else if (key === "title") {
      candidate.title = value;
    } else if (key === "note") {
      candidate.note = value;
    } else if (key === "lastError") {
      candidate.lastError = value;
    }
  }
  return normalizeCandidate(candidate);
}

function parseDownloadList(markdown: string): PaperDownloadListCandidate[] {
  return dedupeCandidates(
    markdown
      .split(/\r?\n/)
      .filter((line) => /^\s*-\s+/.test(line))
      .map(parseCandidateLine)
      .filter((candidate): candidate is PaperDownloadListCandidate => Boolean(candidate))
  );
}

function defaultListPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${DEFAULT_LIST_DIR}/paper-download-list-${timestamp}.md`;
}

function localPaperMatchesCandidate(paper: LocalPaperEntry, candidate: PaperDownloadListCandidate): boolean {
  const candidateId = normalizeArxivCandidateId(candidate.id) ?? arxivIdFromUrl(candidate.url);
  if (candidateId) {
    const paperArxivId = paper.source === "arxiv" ? normalizeArxivCandidateId(paper.canonicalId) : undefined;
    return paperArxivId === candidateId || paper.paperKey === `arxiv-${candidateId}`;
  }
  if (candidate.url && paper.articleUrl) {
    return paper.articleUrl.toLowerCase() === candidate.url.toLowerCase();
  }
  return false;
}

async function candidateAlreadyDownloaded(workspaceDir: string, candidate: PaperDownloadListCandidate): Promise<boolean> {
  const papers = await listLocalPapers({
    workspaceDir,
    status: "downloaded",
    maxResults: 10000
  });
  return papers.results.some((paper) => localPaperMatchesCandidate(paper, candidate));
}

export async function stagePaperDownloadList(
  options: StagePaperDownloadListOptions
): Promise<StagePaperDownloadListResult> {
  const candidates = dedupeCandidates(options.candidates);
  const listPath = options.listPath ?? defaultListPath();
  const resolvedListPath = await resolveWorkspaceWritablePath(options.workspaceDir, listPath);
  await mkdir(path.dirname(resolvedListPath), { recursive: true });
  await writeFile(resolvedListPath, serializeDownloadList(candidates), "utf8");
  return {
    listPath: relativeWorkspacePath(options.workspaceDir, resolvedListPath),
    totalCandidates: options.candidates.length,
    retainedCandidates: candidates.length,
    duplicatesRemoved: Math.max(0, options.candidates.length - candidates.length)
  };
}

export async function downloadPaperList(
  options: DownloadPaperListOptions
): Promise<DownloadPaperListResult> {
  const resolvedListPath = await resolveWorkspacePath(options.workspaceDir, options.listPath);
  const candidates = parseDownloadList(await readFile(resolvedListPath, "utf8"));
  const maxItems = Math.max(0, Math.trunc(options.maxItems ?? DEFAULT_MAX_DOWNLOAD_ITEMS));
  const results: DownloadPaperListResult["results"] = [];
  const remaining: PaperDownloadListCandidate[] = [];
  let attempted = 0;
  let downloaded = 0;
  let failed = 0;
  let skippedAlreadyDownloaded = 0;

  for (const candidate of candidates) {
    if (await candidateAlreadyDownloaded(options.workspaceDir, candidate)) {
      skippedAlreadyDownloaded += 1;
      results.push({
        candidate,
        status: "already_downloaded",
        message: "Candidate is already present in the local paper library."
      });
      continue;
    }
    if (attempted >= maxItems) {
      remaining.push(candidate);
      continue;
    }
    if (!candidate.id && !candidate.url) {
      const message = "Candidate lacks id or url; search_papers or add a stable locator before retrying.";
      failed += 1;
      remaining.push({
        ...candidate,
        lastError: message
      });
      results.push({
        candidate,
        status: "failed",
        message
      });
      continue;
    }
    if (options.dryRun === true) {
      attempted += 1;
      remaining.push(candidate);
      results.push({
        candidate,
        status: "dry_run",
        message: "Dry run: would call download_paper for this candidate."
      });
      continue;
    }

    attempted += 1;
    try {
      const details = await options.downloadPaperImpl({
        workspaceDir: options.workspaceDir,
        ...(candidate.id ? { id: candidate.id } : {}),
        ...(candidate.url && !candidate.id ? { url: candidate.url } : {}),
        ...(candidate.title ? { title: candidate.title } : {})
      });
      downloaded += 1;
      results.push({
        candidate,
        status: "downloaded",
        message: "download_paper completed for this candidate.",
        details
      });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "download_paper failed.";
      remaining.push({
        ...candidate,
        lastError: message
      });
      results.push({
        candidate,
        status: "failed",
        message
      });
    }
  }

  await writeFile(resolvedListPath, serializeDownloadList(remaining), "utf8");
  return {
    listPath: relativeWorkspacePath(options.workspaceDir, resolvedListPath),
    totalCandidates: candidates.length,
    attempted,
    downloaded,
    failed,
    skippedAlreadyDownloaded,
    remainingCandidates: remaining.length,
    results
  };
}
