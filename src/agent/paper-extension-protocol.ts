import type { PaperSource } from "./paper-types.js";

export type ExtensionJobStatus =
  | "queued"
  | "opened_in_browser"
  | "page_classified"
  | "pdf_candidate_found"
  | "automatic_download_started"
  | "automatic_download_failed"
  | "awaiting_user_verification"
  | "awaiting_user_manual_download"
  | "manual_download_observed"
  | "downloaded";

export interface ExtensionPaperJobPayload {
  jobId: string;
  articleUrl: string;
  source: PaperSource;
  title?: string;
  autoClose?: boolean;
}

export type ExtensionHostMessage =
  | {
      type: "poll_jobs";
      extensionInstanceId: string;
    }
  | {
      type: "register_download";
      jobId: string;
      articleUrl: string;
      source: PaperSource;
      downloadPath: string;
      title?: string;
    }
  | {
      type: "job_status";
      jobId: string;
      status: ExtensionJobStatus;
      articleUrl: string;
      source?: PaperSource;
      message?: string;
    };

export type ExtensionHostResponse =
  | {
      type: "jobs";
      jobs: ExtensionPaperJobPayload[];
    }
  | {
      type: "registered";
      jobId: string;
      articleUrl: string;
      downloadPath: string;
      recordPath: string;
      fileSha256: string;
      title?: string;
    }
  | {
      type: "status_ack";
      jobId: string;
      status: ExtensionJobStatus;
    }
  | {
      type: "error";
      jobId?: string;
      code: string;
      message: string;
    };

const VALID_PAPER_SOURCES = new Set<PaperSource>(["arxiv", "science", "nature", "aps", "external"]);

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

function parseRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function parseRequiredString(record: Record<string, unknown>, fieldName: string): string {
  const value = record[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  return value;
}

function parseOptionalString(
  record: Record<string, unknown>,
  fieldName: string
): string | undefined {
  const value = record[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string when provided.`);
  }

  return value;
}

function parseOptionalBoolean(
  record: Record<string, unknown>,
  fieldName: string
): boolean | undefined {
  const value = record[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean when provided.`);
  }

  return value;
}

function parsePaperSource(record: Record<string, unknown>, fieldName: string): PaperSource {
  const source = parseRequiredString(record, fieldName);
  if (!VALID_PAPER_SOURCES.has(source as PaperSource)) {
    throw new Error(`${fieldName} must be a valid PaperSource.`);
  }

  return source as PaperSource;
}

function parseOptionalPaperSource(
  record: Record<string, unknown>,
  fieldName: string
): PaperSource | undefined {
  if (record[fieldName] === undefined) {
    return undefined;
  }

  return parsePaperSource(record, fieldName);
}

function parseExtensionJobStatus(
  record: Record<string, unknown>,
  fieldName: string
): ExtensionJobStatus {
  const status = parseRequiredString(record, fieldName);
  if (!VALID_JOB_STATUSES.has(status as ExtensionJobStatus)) {
    throw new Error(`${fieldName} must be a valid ExtensionJobStatus.`);
  }

  return status as ExtensionJobStatus;
}

function parseExtensionPaperJobPayload(value: unknown): ExtensionPaperJobPayload {
  const record = parseRecord(value, "job");
  return {
    jobId: parseRequiredString(record, "jobId"),
    articleUrl: parseRequiredString(record, "articleUrl"),
    source: parsePaperSource(record, "source"),
    ...parseOptionalFields(record, ["title"]),
    ...parseOptionalBooleanField(record, "autoClose")
  };
}

function parseOptionalFields(
  record: Record<string, unknown>,
  fieldNames: string[]
): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const fieldName of fieldNames) {
    const value = parseOptionalString(record, fieldName);
    if (value !== undefined) {
      parsed[fieldName] = value;
    }
  }

  return parsed;
}

function parseOptionalBooleanField(
  record: Record<string, unknown>,
  fieldName: string
): Record<string, boolean> {
  const value = parseOptionalBoolean(record, fieldName);
  return value === undefined ? {} : { [fieldName]: value };
}

export function parseExtensionHostMessage(value: unknown): ExtensionHostMessage {
  const record = parseRecord(value, "extension host message");
  const type = parseRequiredString(record, "type");

  if (type === "poll_jobs") {
    return {
      type,
      extensionInstanceId: parseRequiredString(record, "extensionInstanceId")
    };
  }

  if (type === "register_download") {
    return {
      type,
      jobId: parseRequiredString(record, "jobId"),
      articleUrl: parseRequiredString(record, "articleUrl"),
      source: parsePaperSource(record, "source"),
      downloadPath: parseRequiredString(record, "downloadPath"),
      ...parseOptionalFields(record, ["title"])
    };
  }

  if (type === "job_status") {
    return {
      type,
      jobId: parseRequiredString(record, "jobId"),
      status: parseExtensionJobStatus(record, "status"),
      articleUrl: parseRequiredString(record, "articleUrl"),
      ...parseOptionalPaperSourceField(record, "source"),
      ...parseOptionalFields(record, ["message"])
    };
  }

  throw new Error("type must be a valid extension host message type.");
}

function parseOptionalPaperSourceField(
  record: Record<string, unknown>,
  fieldName: string
): Record<string, PaperSource> {
  const value = parseOptionalPaperSource(record, fieldName);
  return value === undefined ? {} : { [fieldName]: value };
}

export function parseExtensionHostResponse(value: unknown): ExtensionHostResponse {
  const record = parseRecord(value, "extension host response");
  const type = parseRequiredString(record, "type");

  if (type === "jobs") {
    const jobs = record.jobs;
    if (!Array.isArray(jobs)) {
      throw new Error("jobs must be an array.");
    }

    return {
      type,
      jobs: jobs.map(parseExtensionPaperJobPayload)
    };
  }

  if (type === "registered") {
    return {
      type,
      jobId: parseRequiredString(record, "jobId"),
      articleUrl: parseRequiredString(record, "articleUrl"),
      downloadPath: parseRequiredString(record, "downloadPath"),
      recordPath: parseRequiredString(record, "recordPath"),
      fileSha256: parseRequiredString(record, "fileSha256"),
      ...parseOptionalFields(record, ["title"])
    };
  }

  if (type === "status_ack") {
    return {
      type,
      jobId: parseRequiredString(record, "jobId"),
      status: parseExtensionJobStatus(record, "status")
    };
  }

  if (type === "error") {
    return {
      type,
      ...parseOptionalFields(record, ["jobId"]),
      code: parseRequiredString(record, "code"),
      message: parseRequiredString(record, "message")
    };
  }

  throw new Error("type must be a valid extension host response type.");
}
