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
import { parsePaperWebPageHtmlWithPandoc } from "../acquisition/paper-webpage-fetch.js";
import { savePaperWebPageParse } from "../reading/engines/webpage.js";
import { parsePaper } from "../reading/paper-reader.js";
import type { PaperParseResult } from "../reading/types.js";
import {
  readPaperRecord,
  resolveExternalPaperPdfPath,
  resolvePaperPdfPath,
  resolvePaperRecordPath,
  resolvePaperSupplementalPdfPath,
  updatePaperRecordParseManifest,
  updatePaperRecordReadingFailure,
  writePaperRecord
} from "../storage/paper-store.js";
import { resolvePublisherCanonicalIdFromArticleUrl } from "../acquisition/paper-download.js";
import type { PaperRecord, PaperSupplementalMaterial, SupportedPaperSource } from "../types.js";

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
  citationMetadataFetchImpl?: typeof fetch;
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
        ...(job.purpose === undefined ? {} : { purpose: job.purpose }),
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
        ...(message.failureCode ? { failureCode: message.failureCode } : {}),
        ...(message.message ? { message: message.message } : {})
      }
    });

    return {
      type: "status_ack",
      jobId: message.jobId,
      status: message.status
    };
  }

  if (message.type === "register_webpage_snapshot") {
    return registerWebpageSnapshot({
      workspaceDir: options.workspaceDir,
      message,
      recordedAt
    });
  }

  if (message.type === "register_supplemental_material") {
    return registerSupplementalMaterial({
      workspaceDir: options.workspaceDir,
      message,
      recordedAt
    });
  }

  return registerDownloadedPaper({
    workspaceDir: options.workspaceDir,
    message,
    recordedAt,
    ...(options.citationMetadataFetchImpl ? { citationMetadataFetchImpl: options.citationMetadataFetchImpl } : {})
  });
}

async function registerWebpageSnapshot(options: {
  workspaceDir: string;
  message: Extract<ExtensionHostMessage, { type: "register_webpage_snapshot" }>;
  recordedAt: string;
}): Promise<ExtensionHostResponse> {
  try {
    const pageUrl = options.message.finalUrl ?? options.message.articleUrl;
    if (
      options.message.source !== "external" &&
      (isPublisherSupplementalUrl(pageUrl) || isPublisherSupplementalUrl(options.message.articleUrl))
    ) {
      return registrationError({
        jobId: options.message.jobId,
        code: "supplemental_webpage_snapshot_unsupported",
        message: "Supplemental material pages are not registered as standalone wiki sources; download the supplemental PDF instead."
      });
    }

    const extraction = await parsePaperWebPageHtmlWithPandoc({
      url: pageUrl,
      html: options.message.html
    });
    const saved = await savePaperWebPageParse({
      workspaceDir: options.workspaceDir,
      extraction: {
        ...extraction,
        ...(options.message.webpageAssets ? { assets: options.message.webpageAssets } : {})
      },
      force: true
    });
    const webpageRecord = await resolveRecordForExtensionMessage({
      workspaceDir: options.workspaceDir,
      message: options.message
    });
    if (webpageRecord) {
      await updatePaperRecordParseManifest({
        workspaceDir: options.workspaceDir,
        recordPath: webpageRecord.recordPath,
        strategy: "webpage",
        status: saved.status,
        paperKey: saved.paperKey,
        engine: saved.engine,
        sourceSha256: saved.pdfSha256,
        artifacts: saved.artifacts,
        quality: saved.quality,
        updatedAt: options.recordedAt
      });
    }

    await appendPaperDownloadJobEvent({
      workspaceDir: options.workspaceDir,
      event: {
        jobId: options.message.jobId,
        recordedAt: options.recordedAt,
        status: "webpage_snapshot_ready",
        articleUrl: options.message.articleUrl,
        source: options.message.source,
        purpose: "webpage",
        ...(options.message.title ? { title: options.message.title } : {}),
        ...(options.message.finalUrl ? { finalUrl: options.message.finalUrl } : {}),
        paperKey: saved.paperKey,
        markdownPath: saved.artifacts.markdownPath,
        parsePath: saved.artifacts.parsePath,
        qualityPath: saved.artifacts.qualityPath,
        chunksPath: saved.artifacts.chunksPath,
        message: extraction.access.status === "access_limited"
          ? extraction.access.message
          : "Registered webpage snapshot and saved parsed article artifacts."
      }
    });

    return {
      type: "webpage_registered",
      jobId: options.message.jobId,
      articleUrl: options.message.articleUrl,
      paperKey: saved.paperKey,
      markdownPath: saved.artifacts.markdownPath,
      parsePath: saved.artifacts.parsePath,
      qualityPath: saved.artifacts.qualityPath,
      chunksPath: saved.artifacts.chunksPath,
      quality: saved.quality,
      ...(extraction.title ? { title: extraction.title } : {})
    };
  } catch (error) {
    return registrationError({
      jobId: options.message.jobId,
      code: "webpage_registration_failed",
      message: error instanceof Error ? error.message : "Unable to register webpage snapshot."
    });
  }
}

async function registerSupplementalMaterial(options: {
  workspaceDir: string;
  message: Extract<ExtensionHostMessage, { type: "register_supplemental_material" }>;
  recordedAt: string;
}): Promise<ExtensionHostResponse> {
  if (!SUPPORTED_PUBLISHER_SOURCES.has(options.message.source as SupportedPaperSource)) {
    return registrationError({
      jobId: options.message.jobId,
      code: "unsupported_supplemental_source",
      message: "Supplemental material registration is only supported for publisher article records."
    });
  }

  const source = options.message.source as SupportedPaperSource;
  const canonicalId = resolvePublisherCanonicalIdFromArticleUrl({
    publisher: source,
    articleUrl: options.message.articleUrl
  });
  if (!canonicalId) {
    return registrationError({
      jobId: options.message.jobId,
      code: "canonical_id_not_found",
      message: "Unable to derive a canonical paper identifier from the article URL."
    });
  }

  let materialBytes: Buffer;
  try {
    materialBytes = Buffer.from(options.message.materialBase64, "base64");
  } catch {
    return registrationError({
      jobId: options.message.jobId,
      code: "invalid_supplemental_bytes",
      message: "Unable to decode supplemental material bytes."
    });
  }
  if (materialBytes.byteLength === 0) {
    return registrationError({
      jobId: options.message.jobId,
      code: "invalid_supplemental_bytes",
      message: "Supplemental material bytes are empty."
    });
  }
  if (!materialBytes.subarray(0, PDF_SIGNATURE.byteLength).equals(PDF_SIGNATURE)) {
    return registrationError({
      jobId: options.message.jobId,
      code: "supplement_not_pdf",
      message: "Supplemental material registration only accepts downloaded PDF files."
    });
  }

  const filename = sanitizeSupplementalFilename(options.message.filename, options.message.materialUrl);
  const targetRecordPath = resolvePaperRecordPath({
    workspaceDir: options.workspaceDir,
    source,
    canonicalId,
    articleUrl: options.message.articleUrl
  });
  const downloadPath = resolvePaperSupplementalPdfPath({
    workspaceDir: options.workspaceDir,
    source,
    canonicalId,
    filename
  });
  await mkdir(path.dirname(downloadPath), { recursive: true });
  await writeFile(downloadPath, materialBytes);

  const sha256 = createHash("sha256").update(materialBytes).digest("hex");
  const material: PaperSupplementalMaterial = {
    url: options.message.materialUrl,
    ...(normalizeOptionalString(options.message.title) ? { title: normalizeOptionalString(options.message.title) } : {}),
    filename,
    path: downloadPath,
    ...(normalizeOptionalString(options.message.mimeType) ? { mimeType: normalizeOptionalString(options.message.mimeType) } : {}),
    sha256,
    downloadedAt: options.recordedAt
  };

  const existingRecord = await readPaperRecord({
    workspaceDir: options.workspaceDir,
    source,
    canonicalId,
    articleUrl: options.message.articleUrl
  });
  const existingMaterials =
    existingRecord?.record.source === source &&
    "supplementalMaterials" in existingRecord.record &&
    Array.isArray(existingRecord.record.supplementalMaterials)
      ? existingRecord.record.supplementalMaterials
      : [];
  const supplementalMaterials = mergeSupplementalMaterials(existingMaterials, material);
  const record: PaperRecord = existingRecord
    ? ({
      ...existingRecord.record,
      supplementalMaterials
    } as PaperRecord)
    : {
      source,
      articleUrl: options.message.articleUrl,
      recordedAt: options.recordedAt,
      handlingMethod: "accepted_paper",
      status: "publisher_pending",
      canonicalId,
      ...(normalizeOptionalString(options.message.title) ? { title: normalizeOptionalString(options.message.title) } : {}),
      supplementalMaterials,
      failure: {
        code: "supplemental_material_only",
        message: "Supplemental material was downloaded before the main publisher PDF was registered."
      }
    };

  const recordPath = await writePaperRecord({
    workspaceDir: options.workspaceDir,
    record
  });

  await appendPaperDownloadJobEvent({
    workspaceDir: options.workspaceDir,
    event: {
      jobId: options.message.jobId,
      recordedAt: options.recordedAt,
      status: "supplemental_material_downloaded",
      articleUrl: options.message.articleUrl,
      source,
      materialUrl: options.message.materialUrl,
      downloadPath,
      recordPath,
      sha256,
      ...(material.mimeType ? { mimeType: material.mimeType } : {}),
      ...(material.title ? { title: material.title } : {})
    }
  });

  return {
    type: "supplemental_registered",
    jobId: options.message.jobId,
    articleUrl: options.message.articleUrl,
    materialUrl: options.message.materialUrl,
    path: downloadPath,
    sha256,
    recordPath,
    ...(material.title ? { title: material.title } : {})
  };
}

function mergeSupplementalMaterials(
  existing: PaperSupplementalMaterial[],
  material: PaperSupplementalMaterial
): PaperSupplementalMaterial[] {
  const byUrl = new Map(existing.map((item) => [item.url, item]));
  byUrl.set(material.url, material);
  return [...byUrl.values()];
}

function sanitizeSupplementalFilename(value: string | undefined, materialUrl: string): string {
  let fallback = "supplemental-material";
  try {
    fallback = path.basename(new URL(materialUrl).pathname) || fallback;
  } catch {
    fallback = path.basename(materialUrl.split(/[?#]/, 1)[0] ?? "") || fallback;
  }
  const preferred = value?.trim() || fallback;
  const cleaned = preferred
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[ .]+$/g, "");
  return cleaned || "supplemental-material";
}

function isPublisherSupplementalUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.toLowerCase();
    return (
      pathname.includes("/supplemental/") ||
      pathname.includes("/doi/suppl/") ||
      pathname.includes("suppl_file") ||
      pathname.includes("supplementary")
    );
  } catch {
    const normalized = value.toLowerCase();
    return (
      normalized.includes("/supplemental/") ||
      normalized.includes("/doi/suppl/") ||
      normalized.includes("suppl_file") ||
      normalized.includes("supplementary")
    );
  }
}

async function resolveRecordForExtensionMessage(input: {
  workspaceDir: string;
  message: Extract<ExtensionHostMessage, { type: "register_webpage_snapshot" }>;
}): Promise<{ record: PaperRecord; recordPath: string } | null> {
  if (input.message.source === "external") {
    return readPaperRecord({
      workspaceDir: input.workspaceDir,
      source: "external",
      articleUrl: input.message.articleUrl
    });
  }

  if (!SUPPORTED_PUBLISHER_SOURCES.has(input.message.source as SupportedPaperSource)) {
    return null;
  }

  const source = input.message.source as SupportedPaperSource;
  const canonicalId = resolvePublisherCanonicalIdFromArticleUrl({
    publisher: source,
    articleUrl: input.message.articleUrl
  });
  if (!canonicalId) {
    return null;
  }

  return readPaperRecord({
    workspaceDir: input.workspaceDir,
    source,
    canonicalId,
    articleUrl: input.message.articleUrl
  });
}

async function registerDownloadedPaper(options: {
  workspaceDir: string;
  message: Extract<ExtensionHostMessage, { type: "register_download" | "register_download_bytes" }>;
  recordedAt: string;
  citationMetadataFetchImpl?: typeof fetch;
}): Promise<ExtensionHostResponse> {
  const downloadPath =
    options.message.type === "register_download"
      ? options.message.downloadPath
      : options.message.pdfFileName ?? options.message.pdfUrl ?? options.message.articleUrl;

  if (
    options.message.source === "science" &&
    isScienceSupplementDownload({
      downloadPath,
      pdfUrl: options.message.pdfUrl
    })
  ) {
    return registrationError({
      jobId: options.message.jobId,
      code: "supplement_not_article",
      message: "Science supplementary material downloads are not registered as article PDFs."
    });
  }

  let pdfBytes: Buffer;
  try {
    pdfBytes =
      options.message.type === "register_download_bytes"
        ? decodeDownloadedPdfBase64(options.message.pdfBase64)
        : await readDownloadedFile(options.message.downloadPath);
  } catch (error) {
    return registrationError({
      jobId: options.message.jobId,
      code: "read_failed",
      message:
        error instanceof Error
          ? error.message
          : options.message.type === "register_download_bytes"
            ? "Unable to decode downloaded PDF bytes."
            : "Unable to read downloaded file."
    });
  }

  if (!pdfBytes.subarray(0, PDF_SIGNATURE.byteLength).equals(PDF_SIGNATURE)) {
    if (isSupportedPublisherHtmlDownload({
      source: options.message.source,
      downloadPath,
      bytes: pdfBytes
    })) {
      if (isPublisherLicenseDownloadDenied({
        source: options.message.source,
        bytes: pdfBytes
      })) {
        return registrationError({
          jobId: options.message.jobId,
          code: "publisher_license_not_permitted",
          message:
            `${formatPublisherSource(options.message.source)} reports that the current license does not permit this publication to be downloaded. ` +
            "The article webpage may still be readable, but the publisher PDF cannot be downloaded with the current account or institutional license."
        });
      }

      return registrationError({
        jobId: options.message.jobId,
        code: "manual_login_required",
        message:
          `${formatPublisherSource(options.message.source)} returned an HTML page instead of the article PDF. ` +
          "Log in or complete publisher verification in the browser extension tab, then retry the download."
      });
    }

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

function decodeDownloadedPdfBase64(pdfBase64: string): Buffer {
  return Buffer.from(pdfBase64, "base64");
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
  message: Extract<ExtensionHostMessage, { type: "register_download" | "register_download_bytes" }>;
  recordedAt: string;
  pdfBytes: Buffer;
  citationMetadataFetchImpl?: typeof fetch;
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
    ...(options.citationMetadataFetchImpl
      ? { enrichCitationMetadata: true, fetchImpl: options.citationMetadataFetchImpl }
      : {}),
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
  const parseResult = await tryParseRegisteredPdf({
    workspaceDir: options.workspaceDir,
    recordPath,
    pdfBytes: options.pdfBytes
  });

  await appendDownloadedJobEvent({
    workspaceDir: options.workspaceDir,
    message: options.message,
    recordedAt: options.recordedAt,
    downloadPath,
    recordPath,
    fileSha256,
    title,
    parseResult
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
  message: Extract<ExtensionHostMessage, { type: "register_download" | "register_download_bytes" }>;
  source: SupportedPaperSource;
  recordedAt: string;
  pdfBytes: Buffer;
  citationMetadataFetchImpl?: typeof fetch;
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
  const existingReadingArtifacts = preserveExistingReadingArtifacts(existingRecord?.record);
  const recordPath = await writePaperRecord({
    workspaceDir: options.workspaceDir,
    ...(options.citationMetadataFetchImpl
      ? { enrichCitationMetadata: true, fetchImpl: options.citationMetadataFetchImpl }
      : {}),
    record: {
      source: options.source,
      articleUrl: options.message.articleUrl,
      recordedAt: options.recordedAt,
      handlingMethod: "browser_session",
      status: "downloaded",
      canonicalId,
      pdfUrl,
      downloadPath,
      ...existingReadingArtifacts
    }
  });
  await restoreWebpageReadingManifestFromJob({
    workspaceDir: options.workspaceDir,
    recordPath,
    message: options.message,
    recordedAt: options.recordedAt
  });
  const parseResult = await tryParseRegisteredPdf({
    workspaceDir: options.workspaceDir,
    recordPath,
    pdfBytes: options.pdfBytes
  });

  await appendDownloadedJobEvent({
    workspaceDir: options.workspaceDir,
    message: options.message,
    recordedAt: options.recordedAt,
    downloadPath,
    recordPath,
    fileSha256,
    title,
    parseResult
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

function preserveExistingReadingArtifacts(record: PaperRecord | undefined): Pick<PaperRecord, "webpage" | "reading"> | {} {
  if (!record) {
    return {};
  }

  return {
    ...(record.webpage ? { webpage: record.webpage } : {}),
    ...(record.reading?.status === "ready" ? { reading: record.reading } : {})
  };
}

async function restoreWebpageReadingManifestFromJob(input: {
  workspaceDir: string;
  recordPath: string;
  message: Extract<ExtensionHostMessage, { type: "register_download" | "register_download_bytes" }>;
  recordedAt: string;
}): Promise<void> {
  const events = await readPaperDownloadJobEvents({ workspaceDir: input.workspaceDir });
  const webpageEvent = events
    .slice()
    .reverse()
    .find((event) =>
      event.jobId === input.message.jobId &&
      event.status === "webpage_snapshot_ready" &&
      Boolean(event.paperKey) &&
      Boolean(event.markdownPath) &&
      Boolean(event.parsePath) &&
      Boolean(event.qualityPath) &&
      Boolean(event.chunksPath)
    );
  if (
    !webpageEvent?.paperKey ||
    !webpageEvent.markdownPath ||
    !webpageEvent.parsePath ||
    !webpageEvent.qualityPath ||
    !webpageEvent.chunksPath
  ) {
    return;
  }

  try {
    const [parseArtifact, qualityArtifact] = await Promise.all([
      readJsonFromPortablePath(webpageEvent.parsePath),
      readJsonFromPortablePath(webpageEvent.qualityPath)
    ]);
    await updatePaperRecordParseManifest({
      workspaceDir: input.workspaceDir,
      recordPath: input.recordPath,
      strategy: "webpage",
      status: "parsed",
      paperKey: webpageEvent.paperKey,
      engine: readOptionalString(parseArtifact, "engine") ?? "webpage",
      sourceSha256: readOptionalString(parseArtifact, "pdfSha256") ?? "webpage",
      artifacts: {
        markdownPath: webpageEvent.markdownPath,
        parsePath: webpageEvent.parsePath,
        qualityPath: webpageEvent.qualityPath,
        chunksPath: webpageEvent.chunksPath
      },
      quality: {
        status: readOptionalString(qualityArtifact, "status") ?? "good",
        score: readOptionalNumber(qualityArtifact, "score") ?? 1,
        pages: readOptionalNumber(qualityArtifact, "pages") ?? 1,
        totalTextLength: readOptionalNumber(qualityArtifact, "totalTextLength") ?? 0,
        warnings: readStringArray(qualityArtifact, "warnings")
      },
      updatedAt: webpageEvent.recordedAt || input.recordedAt
    });
  } catch {
    return;
  }
}

async function readJsonFromPortablePath(filePath: string): Promise<Record<string, unknown>> {
  for (const candidatePath of resolveDownloadPathCandidates(filePath)) {
    try {
      const parsed = JSON.parse(await readFile(candidatePath, "utf8")) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      continue;
    }
  }

  throw new Error(`Unable to read JSON artifact: ${filePath}`);
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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

  const pdfUrl = normalizeOptionalString(options.existingRecord.pdfUrl);
  return pdfUrl && isCompatiblePublisherPdfUrl({
    source: options.source,
    canonicalId: options.canonicalId,
    pdfUrl
  })
    ? pdfUrl
    : undefined;
}

function isCompatiblePublisherPdfUrl(options: {
  source: SupportedPaperSource;
  canonicalId: string;
  pdfUrl: string;
}): boolean {
  if (options.source !== "science") {
    return true;
  }

  try {
    const parsedUrl = new URL(options.pdfUrl);
    const match = parsedUrl.pathname.match(/^\/doi\/(?:epdf|pdf)\/(.+)$/i);
    return safeDecodeURIComponent(match?.[1] ?? "").replace(/\.pdf$/i, "") === options.canonicalId;
  } catch {
    return false;
  }
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
    const match = parsedUrl.pathname.match(/^\/doi\/(?!suppl\/)(?:(?:pdf|full|abs|epdf)\/)?(.+)$/i);
    if (!match?.[1]) {
      return undefined;
    }

    parsedUrl.pathname = `/doi/pdf/${match[1]}`;
    parsedUrl.search = "?download=true";
    parsedUrl.hash = "";
    return parsedUrl.toString();
  }

  const doiPdfPathMatch = parsedUrl.pathname.match(/^\/doi\/pdf\/(.+)$/i);
  if (doiPdfPathMatch?.[1]) {
    parsedUrl.search = "";
    parsedUrl.hash = "";
    return parsedUrl.toString();
  }

  const doiPathMatch = parsedUrl.pathname.match(/^\/doi\/(.+)$/i);
  if (doiPathMatch?.[1]) {
    parsedUrl.pathname = `/doi/pdf/${doiPathMatch[1]}`;
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
  message: Extract<ExtensionHostMessage, { type: "register_download" | "register_download_bytes" }>;
  recordedAt: string;
  downloadPath: string;
  recordPath: string;
  fileSha256: string;
  title?: string;
  parseResult?: PaperParseResult;
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
      ...(options.parseResult ? {
        paperKey: options.parseResult.paperKey,
        markdownPath: options.parseResult.artifacts.markdownPath,
        parsePath: options.parseResult.artifacts.parsePath,
        qualityPath: options.parseResult.artifacts.qualityPath,
        chunksPath: options.parseResult.artifacts.chunksPath
      } : {}),
      ...(options.title ? { title: options.title } : {})
    }
  });
}

async function tryParseRegisteredPdf(input: {
  workspaceDir: string;
  recordPath: string;
  pdfBytes: Buffer;
}): Promise<PaperParseResult | undefined> {
  if (input.pdfBytes.byteLength < 1024) {
    return undefined;
  }

  try {
    const result = await parsePaper({
      workspaceDir: input.workspaceDir,
      recordPath: input.recordPath
    });
    await updatePaperRecordParseManifest({
      workspaceDir: input.workspaceDir,
      recordPath: input.recordPath,
      strategy: "pdf_parse",
      status: result.status,
      paperKey: result.paperKey,
      engine: result.engine,
      sourceSha256: result.pdfSha256,
      artifacts: result.artifacts,
      quality: result.quality
    });
    return result;
  } catch (error) {
    await updatePaperRecordReadingFailure({
      workspaceDir: input.workspaceDir,
      recordPath: input.recordPath,
      strategy: "pdf_parse",
      message: error instanceof Error ? error.message : "Registered PDF could not be parsed into markdown."
    }).catch(() => {});
    return undefined;
  }
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

function isScienceSupplementDownload(input: {
  downloadPath: string;
  pdfUrl?: string;
}): boolean {
  const values = [input.downloadPath, input.pdfUrl ?? ""].filter(Boolean);
  return values.some((value) => {
    const basename = String(value).split(/[\\/]/).pop()?.split(/[?#]/, 1)[0] ?? "";
    const decodedBasename = safeDecodeURIComponent(basename).toLowerCase();
    return decodedBasename.endsWith("sm.pdf");
  });
}

function isSupportedPublisherHtmlDownload(input: {
  source: string;
  downloadPath: string;
  bytes: Buffer;
}): boolean {
  if (!SUPPORTED_PUBLISHER_SOURCES.has(input.source as SupportedPaperSource)) {
    return false;
  }

  const basename = input.downloadPath.split(/[\\/]/).pop()?.split(/[?#]/, 1)[0] ?? "";
  const decodedBasename = safeDecodeURIComponent(basename).toLowerCase();
  if (decodedBasename.endsWith(".htm") || decodedBasename.endsWith(".html")) {
    return true;
  }

  const prefix = input.bytes.subarray(0, 512).toString("utf8").toLowerCase();
  return (
    prefix.includes("<!doctype html") ||
    prefix.includes("<html") ||
    prefix.includes("<head") ||
    prefix.includes("<body")
  );
}

function normalizeHtmlText(bytes: Buffer): string {
  return bytes
    .subarray(0, 128 * 1024)
    .toString("utf8")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isPublisherLicenseDownloadDenied(input: {
  source: string;
  bytes: Buffer;
}): boolean {
  if (input.source !== "science") {
    return false;
  }

  const text = normalizeHtmlText(input.bytes);
  return (
    text.includes("your license does not permit this publication to be downloaded") ||
    (
      text.includes("license does not permit") &&
      text.includes("publication to be downloaded")
    )
  );
}

function formatPublisherSource(source: string): string {
  if (source === "aps") {
    return "APS";
  }
  if (source === "science") {
    return "Science";
  }
  if (source === "nature") {
    return "Nature";
  }
  return "The publisher";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
  citationMetadataFetchImpl?: typeof fetch;
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
              message,
              ...(options.citationMetadataFetchImpl ? { citationMetadataFetchImpl: options.citationMetadataFetchImpl } : {})
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
