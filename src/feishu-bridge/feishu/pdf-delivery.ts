import path from 'node:path';
import { readPaperDownloadJobEvents, summarizePaperDownloadJobs } from '../../agent/paper-download-jobs.js';

export interface DownloadedPdfAttachment {
  path: string;
  fileName: string;
  status: 'downloaded' | 'already_downloaded';
  source?: string;
  canonicalId?: string;
  articleUrl?: string;
}

export interface QueuedPdfDeliveryJob {
  jobId: string;
  source?: string;
  articleUrl?: string;
}

export interface CompiledPaperPdfConfig {
  dir?: string;
  compiledPdfPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function resolveLocalPath(rawPath: string, workspaceDir: string): string {
  const normalizedRawPath = normalizePotentiallyEscapedPath(rawPath);
  const wslUncMatch = normalizedRawPath.match(/^\\\\wsl(?:\.localhost)?\\[^\\]+\\(.+)$/i);
  if (wslUncMatch?.[1]) {
    return path.normalize(`/${wslUncMatch[1].replace(/\\/g, '/')}`);
  }

  return path.isAbsolute(normalizedRawPath)
    ? path.normalize(normalizedRawPath)
    : path.resolve(workspaceDir, normalizedRawPath);
}

function normalizePotentiallyEscapedPath(rawPath: string): string {
  let value = rawPath.trim().replace(/^[`"'(<[]+|[`"').,，。；;:：\]>]+$/g, '');
  const wslPrefix = value.match(/^(\\+)wsl(?:\.localhost)?\\/i);
  if (wslPrefix && wslPrefix[1].length >= 2) {
    const rest = value.slice(wslPrefix[1].length).replace(/\\{2,}/g, '\\');
    value = `\\\\${rest}`;
  }
  return value;
}

function buildDownloadedPdfAttachment(input: {
  rawPath: string;
  workspaceDir: string;
  status: 'downloaded' | 'already_downloaded';
  source?: string;
  canonicalId?: string;
  articleUrl?: string;
}): DownloadedPdfAttachment | null {
  const resolvedPath = resolveLocalPath(input.rawPath, input.workspaceDir);
  if (path.extname(resolvedPath).toLowerCase() !== '.pdf') {
    return null;
  }

  return {
    path: resolvedPath,
    fileName: path.basename(resolvedPath),
    status: input.status,
    ...(input.source ? { source: input.source } : {}),
    ...(input.canonicalId ? { canonicalId: input.canonicalId } : {}),
    ...(input.articleUrl ? { articleUrl: input.articleUrl } : {}),
  };
}

export function extractDownloadedPdfAttachment(event: unknown, workspaceDir: string): DownloadedPdfAttachment | null {
  if (!isRecord(event) || event.type !== 'tool_execution_end' || event.toolName !== 'download_paper' || event.isError === true) {
    return null;
  }

  const result = isRecord(event.result) ? event.result : undefined;
  const details = result && isRecord(result.details) ? result.details : undefined;
  if (!details) {
    return null;
  }

  const status = details.status;
  if (status !== 'downloaded' && status !== 'already_downloaded') {
    return null;
  }

  const rawPath = readString(details, 'path');
  if (!rawPath) {
    return null;
  }

  return buildDownloadedPdfAttachment({
    rawPath,
    workspaceDir,
    status,
    source: readString(details, 'source'),
    canonicalId: readString(details, 'canonicalId'),
    articleUrl: readString(details, 'articleUrl'),
  });
}

export function extractQueuedPdfDeliveryJob(event: unknown): QueuedPdfDeliveryJob | null {
  if (!isRecord(event) || event.type !== 'tool_execution_end' || event.toolName !== 'download_paper' || event.isError === true) {
    return null;
  }

  const result = isRecord(event.result) ? event.result : undefined;
  const details = result && isRecord(result.details) ? result.details : undefined;
  if (!details || details.status !== 'extension_job_queued') {
    return null;
  }

  const jobId = readString(details, 'jobId');
  if (!jobId) {
    return null;
  }

  return {
    jobId,
    source: readString(details, 'source'),
    articleUrl: readString(details, 'articleUrl'),
  };
}

export function extractPdfAttachmentsFromText(text: string, workspaceDir: string): DownloadedPdfAttachment[] {
  const rawPaths = new Set<string>();
  const patterns = [
    /\\{2,}wsl(?:\.localhost)?\\[^\s`"'<>]+?\.pdf/gi,
    /(?<![\w.-])\/(?!\/)[^\s`"'<>]+?\.pdf/gi,
    /\b(?:knowledge-base|paper-projects)\/[^\s`"'<>]+?\.pdf/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      rawPaths.add(match[0]);
    }
  }

  const attachments: DownloadedPdfAttachment[] = [];
  const seenPaths = new Set<string>();
  for (const rawPath of rawPaths) {
    const attachment = buildDownloadedPdfAttachment({
      rawPath,
      workspaceDir,
      status: 'already_downloaded',
    });
    if (attachment && !seenPaths.has(attachment.path)) {
      seenPaths.add(attachment.path);
      attachments.push(attachment);
    }
  }

  return attachments;
}

export function parseCompiledPaperPdfDeliveryCommand(text: string): boolean {
  const normalized = text
    .replace(/^@\S+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return false;
  }

  const mentionsPaperPdf = /(论文|paper|manuscript|main\.pdf|pdf)/i.test(normalized);
  const asksDelivery =
    /(发给我|发我|发送给我|发送一下|发一下|传给我|上传给我|把.+发给我|send\s+me|send.+pdf|upload.+pdf)/i.test(
      normalized,
    );
  const compiledHint = /(编译后|编译好的|compiled|main\.pdf|pdf|这个论文|这篇论文)/i.test(normalized);

  return mentionsPaperPdf && asksDelivery && compiledHint;
}

export function resolveCompiledPaperPdfAttachment(config: CompiledPaperPdfConfig): DownloadedPdfAttachment | null {
  if (!config.dir) {
    return null;
  }

  const configuredPath = config.compiledPdfPath?.trim() || 'manuscript/main.pdf';
  const resolvedPath = path.isAbsolute(configuredPath)
    ? path.normalize(configuredPath)
    : path.resolve(config.dir, configuredPath);
  if (path.extname(resolvedPath).toLowerCase() !== '.pdf') {
    return null;
  }

  return {
    path: resolvedPath,
    fileName: path.basename(resolvedPath),
    status: 'already_downloaded',
    source: 'paper_workspace',
  };
}

export async function resolveDownloadedPdfAttachmentsForQueuedJobs(
  workspaceDir: string,
  jobs: QueuedPdfDeliveryJob[],
): Promise<DownloadedPdfAttachment[]> {
  if (jobs.length === 0) {
    return [];
  }

  const wantedJobIds = new Set(jobs.map((job) => job.jobId));
  const jobMetadata = new Map(jobs.map((job) => [job.jobId, job]));
  const summaries = summarizePaperDownloadJobs(await readPaperDownloadJobEvents({ workspaceDir }));
  const attachments: DownloadedPdfAttachment[] = [];

  for (const summary of summaries) {
    if (!wantedJobIds.has(summary.jobId) || summary.status !== 'downloaded' || !summary.downloadPath) {
      continue;
    }

    const metadata = jobMetadata.get(summary.jobId);
    const attachment = buildDownloadedPdfAttachment({
      rawPath: summary.downloadPath,
      workspaceDir,
      status: 'downloaded',
      source: summary.source ?? metadata?.source,
      articleUrl: summary.articleUrl || metadata?.articleUrl,
    });
    if (attachment) {
      attachments.push(attachment);
    }
  }

  return attachments;
}
