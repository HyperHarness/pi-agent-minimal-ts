import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  appendPaperDownloadJobEvent,
  readPaperDownloadJobEvents,
  summarizePaperDownloadJobs
} from "./paper-download-jobs.js";
import {
  parseExtensionHostMessage,
  type ExtensionHostMessage,
  type ExtensionHostResponse
} from "./paper-extension-protocol.js";
import {
  readPaperRecord,
  resolveExternalPaperPdfPath,
  resolvePaperPdfPath,
  writePaperRecord
} from "./paper-store.js";
import { resolvePublisherCanonicalIdFromArticleUrl } from "./paper-download.js";
import type { PaperRecord, SupportedPaperSource } from "./paper-types.js";

const NATIVE_HOST_NAME = "com.pi_agent.paper_downloader";
const NATIVE_HOST_DESCRIPTION = "Pi Agent paper downloader native host";
const PDF_SIGNATURE = Buffer.from("%PDF-");
const SUPPORTED_PUBLISHER_SOURCES = new Set<SupportedPaperSource>([
  "nature",
  "science",
  "aps"
]);

export function encodeNativeMessage(message: ExtensionHostResponse): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

export function readNativeMessagesFromBuffer(buffer: Buffer): unknown[] {
  const messages: unknown[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.byteLength) {
    const messageLength = buffer.readUInt32LE(offset);
    const bodyStart = offset + 4;
    const bodyEnd = bodyStart + messageLength;
    if (bodyEnd > buffer.byteLength) {
      break;
    }

    messages.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as unknown);
    offset = bodyEnd;
  }

  return messages;
}

export async function handleExtensionHostMessage(options: {
  workspaceDir: string;
  message: unknown;
  now?: () => Date;
}): Promise<ExtensionHostResponse> {
  let message: ExtensionHostMessage;
  try {
    message = parseExtensionHostMessage(options.message);
  } catch (error) {
    return {
      type: "error",
      code: "invalid_message",
      message: error instanceof Error ? error.message : "Invalid extension host message."
    };
  }

  if (message.type === "poll_jobs") {
    const jobs = summarizePaperDownloadJobs(
      await readPaperDownloadJobEvents({ workspaceDir: options.workspaceDir })
    )
      .filter((job) => job.status === "queued" && job.source !== undefined)
      .map((job) => ({
        jobId: job.jobId,
        articleUrl: job.articleUrl,
        source: job.source as NonNullable<typeof job.source>,
        ...(job.title ? { title: job.title } : {}),
        ...(job.autoClose === undefined ? {} : { autoClose: job.autoClose })
      }));

    return {
      type: "jobs",
      jobs
    };
  }

  const now = options.now ?? (() => new Date());
  const recordedAt = now().toISOString();

  if (message.type === "job_status") {
    await appendPaperDownloadJobEvent({
      workspaceDir: options.workspaceDir,
      event: {
        jobId: message.jobId,
        recordedAt,
        status: message.status,
        articleUrl: message.articleUrl,
        ...(message.source ? { source: message.source } : {}),
        ...(message.message ? { message: message.message } : {})
      }
    });

    return {
      type: "status_ack",
      jobId: message.jobId,
      status: message.status
    };
  }

  return registerDownloadedPaper({
    workspaceDir: options.workspaceDir,
    message,
    recordedAt
  });
}

async function registerDownloadedPaper(options: {
  workspaceDir: string;
  message: Extract<ExtensionHostMessage, { type: "register_download" }>;
  recordedAt: string;
}): Promise<ExtensionHostResponse> {
  let pdfBytes: Buffer;
  try {
    pdfBytes = await readDownloadedFile(options.message.downloadPath);
  } catch (error) {
    return registrationError({
      jobId: options.message.jobId,
      code: "read_failed",
      message: error instanceof Error ? error.message : "Unable to read downloaded file."
    });
  }

  if (!pdfBytes.subarray(0, PDF_SIGNATURE.byteLength).equals(PDF_SIGNATURE)) {
    return registrationError({
      jobId: options.message.jobId,
      code: "not_pdf",
      message: "Downloaded file is not a valid PDF."
    });
  }

  try {
    if (options.message.source === "external") {
      return await registerExternalDownload({
        ...options,
        pdfBytes
      });
    }

    if (SUPPORTED_PUBLISHER_SOURCES.has(options.message.source as SupportedPaperSource)) {
      return await registerSupportedPublisherDownload({
        ...options,
        source: options.message.source as SupportedPaperSource,
        pdfBytes
      });
    }

    return registrationError({
      jobId: options.message.jobId,
      code: "unsupported_source",
      message: `Registration is not supported for source "${options.message.source}".`
    });
  } catch (error) {
    return registrationError({
      jobId: options.message.jobId,
      code: "registration_failed",
      message: error instanceof Error ? error.message : "Paper registration failed."
    });
  }
}

async function readDownloadedFile(downloadPath: string): Promise<Buffer> {
  let lastError: unknown;
  for (const candidatePath of resolveDownloadPathCandidates(downloadPath)) {
    try {
      return await readFile(candidatePath);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Unable to read downloaded file at ${downloadPath}.`);
}

export function resolveDownloadPathCandidates(downloadPath: string): string[] {
  const candidates = [downloadPath];

  const drivePathMatch = downloadPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drivePathMatch?.[1] && drivePathMatch[2]) {
    candidates.push(
      path.posix.join(
        "/mnt",
        drivePathMatch[1].toLowerCase(),
        ...drivePathMatch[2].split(/[\\/]+/).filter(Boolean)
      )
    );
  }

  const uncWslMatch = downloadPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+\\(.+)$/i);
  if (uncWslMatch?.[1]) {
    candidates.push(path.posix.join("/", ...uncWslMatch[1].split(/[\\/]+/).filter(Boolean)));
  }

  return [...new Set(candidates)];
}

async function registerExternalDownload(options: {
  workspaceDir: string;
  message: Extract<ExtensionHostMessage, { type: "register_download" }>;
  recordedAt: string;
  pdfBytes: Buffer;
}): Promise<ExtensionHostResponse> {
  const downloadPath = resolveExternalPaperPdfPath({
    workspaceDir: options.workspaceDir,
    articleUrl: options.message.articleUrl
  });
  await mkdir(path.dirname(downloadPath), { recursive: true });
  await writeFile(downloadPath, options.pdfBytes);

  const fileSha256 = createHash("sha256").update(options.pdfBytes).digest("hex");
  const previousRecord = await readPaperRecord({
    workspaceDir: options.workspaceDir,
    source: "external",
    articleUrl: options.message.articleUrl
  });
  const previousOpenedUrl =
    previousRecord?.record.source === "external" && "openedUrl" in previousRecord.record
      ? previousRecord.record.openedUrl
      : undefined;
  const title = normalizeOptionalString(options.message.title);
  const recordPath = await writePaperRecord({
    workspaceDir: options.workspaceDir,
    record: {
      source: "external",
      articleUrl: options.message.articleUrl,
      ...(previousOpenedUrl ? { openedUrl: previousOpenedUrl } : {}),
      recordedAt: options.recordedAt,
      handlingMethod: "manual_file_import",
      status: "downloaded",
      downloadPath,
      fileSha256,
      ...(title ? { title } : {})
    }
  });

  await appendDownloadedJobEvent({
    workspaceDir: options.workspaceDir,
    message: options.message,
    recordedAt: options.recordedAt,
    downloadPath,
    recordPath,
    fileSha256,
    title
  });

  return {
    type: "registered",
    jobId: options.message.jobId,
    articleUrl: options.message.articleUrl,
    downloadPath,
    recordPath,
    fileSha256,
    ...(title ? { title } : {})
  };
}

async function registerSupportedPublisherDownload(options: {
  workspaceDir: string;
  message: Extract<ExtensionHostMessage, { type: "register_download" }>;
  source: SupportedPaperSource;
  recordedAt: string;
  pdfBytes: Buffer;
}): Promise<ExtensionHostResponse> {
  const canonicalId = resolvePublisherCanonicalIdFromArticleUrl({
    publisher: options.source,
    articleUrl: options.message.articleUrl
  });
  if (!canonicalId) {
    return registrationError({
      jobId: options.message.jobId,
      code: "canonical_id_not_found",
      message: "Unable to derive a canonical paper identifier from the article URL."
    });
  }

  const existingRecord = await readPaperRecord({
    workspaceDir: options.workspaceDir,
    source: options.source,
    canonicalId,
    articleUrl: options.message.articleUrl
  });
  if (
    existingRecord?.record.source === options.source &&
    existingRecord.record.canonicalId === canonicalId &&
    existingRecord.record.articleUrl !== options.message.articleUrl
  ) {
    return registrationError({
      jobId: options.message.jobId,
      code: "record_conflict",
      message: "A different article URL is already indexed for this publisher record."
    });
  }

  const pdfUrl =
    normalizeOptionalString(options.message.pdfUrl) ??
    getExistingDownloadedPdfUrl({
      existingRecord: existingRecord?.record,
      source: options.source,
      canonicalId,
      articleUrl: options.message.articleUrl
    }) ??
    derivePublisherPdfUrl({
      source: options.source,
      articleUrl: options.message.articleUrl
    });
  if (!pdfUrl) {
    return registrationError({
      jobId: options.message.jobId,
      code: "pdf_url_not_found",
      message: "Unable to determine a PDF URL for this publisher article."
    });
  }

  const downloadPath = resolvePaperPdfPath({
    workspaceDir: options.workspaceDir,
    source: options.source,
    canonicalId
  });
  await mkdir(path.dirname(downloadPath), { recursive: true });
  await writeFile(downloadPath, options.pdfBytes);

  const fileSha256 = createHash("sha256").update(options.pdfBytes).digest("hex");
  const title = normalizeOptionalString(options.message.title);
  const recordPath = await writePaperRecord({
    workspaceDir: options.workspaceDir,
    record: {
      source: options.source,
      articleUrl: options.message.articleUrl,
      recordedAt: options.recordedAt,
      handlingMethod: "browser_session",
      status: "downloaded",
      canonicalId,
      pdfUrl,
      downloadPath
    }
  });

  await appendDownloadedJobEvent({
    workspaceDir: options.workspaceDir,
    message: options.message,
    recordedAt: options.recordedAt,
    downloadPath,
    recordPath,
    fileSha256,
    title
  });

  return {
    type: "registered",
    jobId: options.message.jobId,
    articleUrl: options.message.articleUrl,
    downloadPath,
    recordPath,
    fileSha256,
    ...(title ? { title } : {})
  };
}

function getExistingDownloadedPdfUrl(options: {
  existingRecord: PaperRecord | undefined;
  source: SupportedPaperSource;
  canonicalId: string;
  articleUrl: string;
}): string | undefined {
  if (
    options.existingRecord?.source !== options.source ||
    options.existingRecord.status !== "downloaded" ||
    options.existingRecord.canonicalId !== options.canonicalId ||
    options.existingRecord.articleUrl !== options.articleUrl
  ) {
    return undefined;
  }

  return normalizeOptionalString(options.existingRecord.pdfUrl);
}

function derivePublisherPdfUrl(options: {
  source: SupportedPaperSource;
  articleUrl: string;
}): string | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.articleUrl);
  } catch {
    return undefined;
  }

  if (options.source === "nature") {
    const match = parsedUrl.pathname.match(/^\/articles\/([^/?#]+?)(?:\.pdf)?$/i);
    if (!match?.[1]) {
      return undefined;
    }

    parsedUrl.pathname = `/articles/${match[1]}.pdf`;
    parsedUrl.search = "";
    parsedUrl.hash = "";
    return parsedUrl.toString();
  }

  if (options.source === "science") {
    const existingPdfMatch = parsedUrl.pathname.match(/^\/doi\/pdf\/(.+)$/i);
    if (existingPdfMatch?.[1]) {
      parsedUrl.search = "";
      parsedUrl.hash = "";
      return parsedUrl.toString();
    }

    const match = parsedUrl.pathname.match(/^\/doi\/(?!pdf\/|full\/|abs\/|epdf\/)(.+)$/i);
    if (!match?.[1]) {
      return undefined;
    }

    parsedUrl.pathname = `/doi/pdf/${match[1]}`;
    parsedUrl.search = "";
    parsedUrl.hash = "";
    return parsedUrl.toString();
  }

  const match = parsedUrl.pathname.match(/^\/([^/]+)\/(?:abstract|pdf)\/(.+)$/i);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  parsedUrl.pathname = `/${match[1]}/pdf/${match[2]}`;
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString();
}

async function appendDownloadedJobEvent(options: {
  workspaceDir: string;
  message: Extract<ExtensionHostMessage, { type: "register_download" }>;
  recordedAt: string;
  downloadPath: string;
  recordPath: string;
  fileSha256: string;
  title?: string;
}): Promise<void> {
  await appendPaperDownloadJobEvent({
    workspaceDir: options.workspaceDir,
    event: {
      jobId: options.message.jobId,
      recordedAt: options.recordedAt,
      status: "downloaded",
      articleUrl: options.message.articleUrl,
      source: options.message.source,
      downloadPath: options.downloadPath,
      recordPath: options.recordPath,
      fileSha256: options.fileSha256,
      ...(options.title ? { title: options.title } : {})
    }
  });
}

function registrationError(input: {
  jobId: string;
  code: string;
  message: string;
}): ExtensionHostResponse {
  return {
    type: "error",
    jobId: input.jobId,
    code: input.code,
    message: input.message
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function extractCompleteNativePayloads(buffer: Buffer): {
  payloads: Buffer[];
  remainingBuffer: Buffer;
} {
  const payloads: Buffer[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.byteLength) {
    const messageLength = buffer.readUInt32LE(offset);
    const bodyStart = offset + 4;
    const bodyEnd = bodyStart + messageLength;
    if (bodyEnd > buffer.byteLength) {
      break;
    }

    payloads.push(buffer.subarray(bodyStart, bodyEnd));
    offset = bodyEnd;
  }

  return {
    payloads,
    remainingBuffer: buffer.subarray(offset)
  };
}

export async function runPaperExtensionNativeHost(options: {
  workspaceDir: string;
  stdin: Readable;
  stdout: Writable;
}): Promise<void> {
  let buffered: Buffer = Buffer.alloc(0);
  let processing = Promise.resolve();

  await new Promise<void>((resolve, reject) => {
    options.stdin.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const extracted = extractCompleteNativePayloads(buffered);
      buffered = extracted.remainingBuffer;

      for (const payload of extracted.payloads) {
        processing = processing.then(async () => {
          let message: unknown;
          try {
            message = JSON.parse(payload.toString("utf8")) as unknown;
          } catch (error) {
            const response: ExtensionHostResponse = {
              type: "error",
              code: "invalid_json",
              message: error instanceof Error ? error.message : "Invalid native message JSON."
            };
            options.stdout.write(encodeNativeMessage(response));
            return;
          }

          let response: ExtensionHostResponse;
          try {
            response = await handleExtensionHostMessage({
              workspaceDir: options.workspaceDir,
              message
            });
          } catch (error) {
            response = {
              type: "error",
              code: "handler_failed",
              message: error instanceof Error ? error.message : "Extension host handler failed."
            };
          }
          options.stdout.write(encodeNativeMessage(response));
        });
      }
      processing.catch(reject);
    });
    options.stdin.on("error", reject);
    options.stdout.on("error", reject);
    options.stdin.on("end", () => {
      processing.then(() => resolve(), reject);
    });
  });
}

export async function writeNativeHostManifest(options: {
  manifestPath: string;
  hostPath: string;
  extensionId: string;
}): Promise<void> {
  await mkdir(path.dirname(options.manifestPath), { recursive: true });
  await writeFile(
    options.manifestPath,
    `${JSON.stringify(
      {
        name: NATIVE_HOST_NAME,
        description: NATIVE_HOST_DESCRIPTION,
        path: options.hostPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${options.extensionId}/`]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}
