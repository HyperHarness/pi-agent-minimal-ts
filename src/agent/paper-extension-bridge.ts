import { createHash } from "node:crypto";
import { appendPaperDownloadJobEvent } from "./paper-download-jobs.js";
import type { ExtensionPaperJobResult, SupportedPaperSource } from "./paper-types.js";

type ExtensionPaperSource = SupportedPaperSource | "external";

export interface ExtensionPaperJob {
  jobId: string;
  articleUrl: string;
  source: ExtensionPaperSource;
  title?: string;
  autoClose?: boolean;
}

export type ExtensionBridgeSubmitResult = ExtensionPaperJobResult;

export interface PaperExtensionBridge {
  submitJob(job: ExtensionPaperJob): Promise<ExtensionBridgeSubmitResult>;
}

export function createPaperExtensionJob(options: {
  articleUrl: string;
  source: ExtensionPaperSource;
  title?: string;
  autoClose?: boolean;
}): ExtensionPaperJob {
  const hash = createHash("sha1")
    .update(`${options.source}:${options.articleUrl}`)
    .digest("hex")
    .slice(0, 12);
  return {
    jobId: `paper-${options.source}-${hash}`,
    articleUrl: options.articleUrl,
    source: options.source,
    ...(options.title ? { title: options.title } : {}),
    ...(options.autoClose === undefined ? {} : { autoClose: options.autoClose })
  };
}

export function createQueuedPaperExtensionBridge(options: {
  workspaceDir: string;
  now?: () => Date;
}): PaperExtensionBridge {
  const now = options.now ?? (() => new Date());
  return {
    async submitJob(job) {
      const message = "Paper download job queued for the browser extension.";
      await appendPaperDownloadJobEvent({
        workspaceDir: options.workspaceDir,
        event: {
          jobId: job.jobId,
          recordedAt: now().toISOString(),
          status: "queued",
          articleUrl: job.articleUrl,
          source: job.source,
          ...(job.title ? { title: job.title } : {}),
          ...(job.autoClose === undefined ? {} : { autoClose: job.autoClose }),
          message
        }
      });

      return {
        status: "extension_job_queued",
        source: job.source,
        articleUrl: job.articleUrl,
        jobId: job.jobId,
        message
      };
    }
  };
}
