import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionJobStatus } from "./paper-extension-protocol.js";
import type { PaperSource } from "./paper-types.js";

export interface PaperDownloadJobEvent {
  jobId: string;
  recordedAt: string;
  status: ExtensionJobStatus;
  articleUrl: string;
  source?: PaperSource;
  title?: string;
  autoClose?: boolean;
  tabId?: number;
  downloadId?: number;
  recordPath?: string;
  downloadPath?: string;
  fileSha256?: string;
  message?: string;
}

const VALID_JOB_STATUSES = new Set<ExtensionJobStatus>([
  "queued",
  "opened_in_browser",
  "page_classified",
  "pdf_candidate_found",
  "automatic_download_started",
  "automatic_download_failed",
  "awaiting_user_verification",
  "awaiting_user_manual_download",
  "manual_download_observed",
  "downloaded"
]);

const VALID_PAPER_SOURCES = new Set<PaperSource>(["arxiv", "science", "nature", "aps", "external"]);

export function resolvePaperDownloadJobsPath(options: { workspaceDir: string }): string {
  return path.join(options.workspaceDir, ".browser-profile", "paper-download-jobs.jsonl");
}

export async function appendPaperDownloadJobEvent(options: {
  workspaceDir: string;
  event: PaperDownloadJobEvent;
}): Promise<string> {
  const jobsPath = resolvePaperDownloadJobsPath({ workspaceDir: options.workspaceDir });
  await mkdir(path.dirname(jobsPath), { recursive: true });
  await appendFile(jobsPath, `${JSON.stringify(options.event)}\n`, "utf8");
  return jobsPath;
}

export async function readPaperDownloadJobEvents(options: {
  workspaceDir: string;
}): Promise<PaperDownloadJobEvent[]> {
  let rawEvents: string;
  try {
    rawEvents = await readFile(
      resolvePaperDownloadJobsPath({ workspaceDir: options.workspaceDir }),
      "utf8"
    );
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const events: PaperDownloadJobEvent[] = [];
  for (const line of rawEvents.split(/\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      const event = parsePaperDownloadJobEvent(parsed);
      if (event) {
        events.push(event);
      }
    } catch {
      continue;
    }
  }

  return events;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function summarizePaperDownloadJobs(
  events: PaperDownloadJobEvent[]
): PaperDownloadJobEvent[] {
  const summaries = new Map<string, PaperDownloadJobEvent>();
  for (const event of events) {
    summaries.set(event.jobId, {
      ...summaries.get(event.jobId),
      ...event
    });
  }

  return [...summaries.values()];
}

function parsePaperDownloadJobEvent(value: unknown): PaperDownloadJobEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const jobId = parseRequiredString(record.jobId);
  const recordedAt = parseRequiredString(record.recordedAt);
  const articleUrl = parseRequiredString(record.articleUrl);
  const status = parseExtensionJobStatus(record.status);
  if (!jobId || !recordedAt || !articleUrl || !status) {
    return null;
  }

  return {
    jobId,
    recordedAt,
    status,
    articleUrl,
    ...parseOptionalPaperSourceField(record, "source"),
    ...parseOptionalStringFields(record, [
      "title",
      "recordPath",
      "downloadPath",
      "fileSha256",
      "message"
    ]),
    ...parseOptionalBooleanField(record, "autoClose"),
    ...parseOptionalNumberFields(record, ["tabId", "downloadId"])
  };
}

function parseRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseExtensionJobStatus(value: unknown): ExtensionJobStatus | null {
  if (typeof value !== "string") {
    return null;
  }

  return VALID_JOB_STATUSES.has(value as ExtensionJobStatus) ? (value as ExtensionJobStatus) : null;
}

function parseOptionalPaperSourceField(
  record: Record<string, unknown>,
  fieldName: string
): Record<string, PaperSource> {
  const value = record[fieldName];
  if (value === undefined) {
    return {};
  }

  return typeof value === "string" && VALID_PAPER_SOURCES.has(value as PaperSource)
    ? { [fieldName]: value as PaperSource }
    : {};
}

function parseOptionalStringFields(
  record: Record<string, unknown>,
  fieldNames: string[]
): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === "string" && value.trim() !== "") {
      parsed[fieldName] = value;
    }
  }

  return parsed;
}

function parseOptionalBooleanField(
  record: Record<string, unknown>,
  fieldName: string
): Record<string, boolean> {
  return typeof record[fieldName] === "boolean" ? { [fieldName]: record[fieldName] } : {};
}

function parseOptionalNumberFields(
  record: Record<string, unknown>,
  fieldNames: string[]
): Record<string, number> {
  const parsed: Record<string, number> = {};
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === "number" && Number.isFinite(value)) {
      parsed[fieldName] = value;
    }
  }

  return parsed;
}
