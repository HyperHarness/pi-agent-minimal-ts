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
  | "downloaded"
  | "webpage_snapshot_ready";

export type ExtensionJobPurpose = "download" | "webpage" | "download_and_webpage";

export interface ExtensionPaperJobPayload {
  jobId: string;
  articleUrl: string;
  source: PaperSource;
  title?: string;
  autoClose?: boolean;
  purpose?: ExtensionJobPurpose;
}

export interface ExtensionWebpageAsset {
  url: string;
  dataBase64: string;
  originalUrl?: string;
  filename?: string;
  mimeType?: string;
  alt?: string;
}

export interface ExtensionWebpageQuality {
  status: string;
  score: number;
  pages: number;
  totalTextLength: number;
  warnings: string[];
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
      pdfUrl?: string;
      title?: string;
    }
  | {
      type: "register_download_bytes";
      jobId: string;
      articleUrl: string;
      source: PaperSource;
      pdfBase64: string;
      pdfUrl?: string;
      pdfFileName?: string;
      title?: string;
    }
  | {
      type: "register_webpage_snapshot";
      jobId: string;
      articleUrl: string;
      source: PaperSource;
      html: string;
      finalUrl?: string;
      title?: string;
      webpageAssets?: ExtensionWebpageAsset[];
    }
  | {
      type: "job_status";
      jobId: string;
      status: ExtensionJobStatus;
      articleUrl: string;
      source?: PaperSource;
      failureCode?: string;
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
      type: "webpage_registered";
      jobId: string;
      articleUrl: string;
      paperKey: string;
      markdownPath: string;
      parsePath: string;
      qualityPath: string;
      chunksPath: string;
      quality?: ExtensionWebpageQuality;
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
  "downloaded",
  "webpage_snapshot_ready"
]);

const VALID_JOB_PURPOSES = new Set<ExtensionJobPurpose>([
  "download",
  "webpage",
  "download_and_webpage"
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

function parseRequiredNumber(record: Record<string, unknown>, fieldName: string): number {
  const value = record[fieldName];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
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

function parseOptionalJobPurpose(
  record: Record<string, unknown>,
  fieldName: string
): ExtensionJobPurpose | undefined {
  const value = record[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !VALID_JOB_PURPOSES.has(value as ExtensionJobPurpose)) {
    throw new Error(`${fieldName} must be a valid ExtensionJobPurpose.`);
  }

  return value as ExtensionJobPurpose;
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
    ...parseOptionalBooleanField(record, "autoClose"),
    ...parseOptionalJobPurposeField(record, "purpose")
  };
}

function parseExtensionWebpageAsset(value: unknown): ExtensionWebpageAsset {
  const record = parseRecord(value, "webpage asset");
  return {
    url: parseRequiredString(record, "url"),
    dataBase64: parseRequiredString(record, "dataBase64"),
    ...parseOptionalFields(record, ["originalUrl", "filename", "mimeType", "alt"])
  };
}

function parseOptionalExtensionWebpageAssetsField(
  record: Record<string, unknown>,
  fieldName: string
): Record<string, ExtensionWebpageAsset[]> {
  const value = record[fieldName];
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array when provided.`);
  }

  return { [fieldName]: value.map(parseExtensionWebpageAsset) };
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

function parseOptionalJobPurposeField(
  record: Record<string, unknown>,
  fieldName: string
): Record<string, ExtensionJobPurpose> {
  const value = parseOptionalJobPurpose(record, fieldName);
  return value === undefined ? {} : { [fieldName]: value };
}

function parseWebpageQuality(value: unknown): ExtensionWebpageQuality {
  const record = parseRecord(value, "quality");
  const warnings = record.warnings;
  if (!Array.isArray(warnings) || warnings.some((warning) => typeof warning !== "string")) {
    throw new Error("warnings must be an array of strings.");
  }

  return {
    status: parseRequiredString(record, "status"),
    score: parseRequiredNumber(record, "score"),
    pages: parseRequiredNumber(record, "pages"),
    totalTextLength: parseRequiredNumber(record, "totalTextLength"),
    warnings
  };
}

function parseOptionalWebpageQualityField(
  record: Record<string, unknown>,
  fieldName: string
): Record<string, ExtensionWebpageQuality> {
  const value = record[fieldName];
  return value === undefined ? {} : { [fieldName]: parseWebpageQuality(value) };
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
      ...parseOptionalFields(record, ["title", "pdfUrl"])
    };
  }

  if (type === "register_download_bytes") {
    return {
      type,
      jobId: parseRequiredString(record, "jobId"),
      articleUrl: parseRequiredString(record, "articleUrl"),
      source: parsePaperSource(record, "source"),
      pdfBase64: parseRequiredString(record, "pdfBase64"),
      ...parseOptionalFields(record, ["title", "pdfUrl", "pdfFileName"])
    };
  }

  if (type === "register_webpage_snapshot") {
    return {
      type,
      jobId: parseRequiredString(record, "jobId"),
      articleUrl: parseRequiredString(record, "articleUrl"),
      source: parsePaperSource(record, "source"),
      html: parseRequiredString(record, "html"),
      ...parseOptionalFields(record, ["title", "finalUrl"]),
      ...parseOptionalExtensionWebpageAssetsField(record, "webpageAssets")
    };
  }

  if (type === "job_status") {
    return {
      type,
      jobId: parseRequiredString(record, "jobId"),
      status: parseExtensionJobStatus(record, "status"),
      articleUrl: parseRequiredString(record, "articleUrl"),
      ...parseOptionalPaperSourceField(record, "source"),
      ...parseOptionalFields(record, ["failureCode", "message"])
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

  if (type === "webpage_registered") {
    return {
      type,
      jobId: parseRequiredString(record, "jobId"),
      articleUrl: parseRequiredString(record, "articleUrl"),
      paperKey: parseRequiredString(record, "paperKey"),
      markdownPath: parseRequiredString(record, "markdownPath"),
      parsePath: parseRequiredString(record, "parsePath"),
      qualityPath: parseRequiredString(record, "qualityPath"),
      chunksPath: parseRequiredString(record, "chunksPath"),
      ...parseOptionalWebpageQualityField(record, "quality"),
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
