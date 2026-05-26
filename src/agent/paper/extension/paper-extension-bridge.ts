import { createHash } from "node:crypto";
import { appendPaperDownloadJobEvent } from "./paper-download-jobs.js";
import type { ExtensionJobPurpose } from "./paper-extension-protocol.js";
import type { ExtensionPaperJobResult, SupportedPaperSource } from "../types.js";

type ExtensionPaperSource = SupportedPaperSource | "external";

export interface ExtensionPaperJob {
  jobId: string;
  articleUrl: string;
  source: ExtensionPaperSource;
  title?: string;
  autoClose?: boolean;
  purpose?: ExtensionJobPurpose;
}

export type ExtensionBridgeSubmitResult = ExtensionPaperJobResult;

export interface PaperExtensionBridge {
  submitJob(job: ExtensionPaperJob): Promise<ExtensionBridgeSubmitResult>;
}

let queuedJobSequence = 0;

export function createPaperExtensionJob(options: {
  articleUrl: string;
  source: ExtensionPaperSource;
  title?: string;
  autoClose?: boolean;
  purpose?: ExtensionJobPurpose;
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
    ...(options.autoClose === undefined ? {} : { autoClose: options.autoClose }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose })
  };
}

export function createQueuedPaperExtensionBridge(options: {
  workspaceDir: string;
  now?: () => Date;
}): PaperExtensionBridge {
  const now = options.now ?? (() => new Date());
  return {
    async submitJob(job) {
      const recordedAt = now();
      const queuedJobId = `${job.jobId}-${recordedAt.getTime().toString(36)}-${(
        queuedJobSequence++
      ).toString(36)}`;
      const message = job.purpose === "download_and_webpage"
        ? "Paper download and webpage snapshot job queued for the browser extension."
        : job.purpose === "supplemental"
          ? "Supplemental material download job queued for the browser extension."
          : "Paper download job queued for the browser extension.";
      await appendPaperDownloadJobEvent({
        workspaceDir: options.workspaceDir,
        event: {
          jobId: queuedJobId,
          recordedAt: recordedAt.toISOString(),
          status: "queued",
          articleUrl: job.articleUrl,
          source: job.source,
          ...(job.purpose === undefined ? {} : { purpose: job.purpose }),
          ...(job.title ? { title: job.title } : {}),
          ...(job.autoClose === undefined ? {} : { autoClose: job.autoClose }),
          message
        }
      });

      return {
        status: "extension_job_queued",
        source: job.source,
        articleUrl: job.articleUrl,
        jobId: queuedJobId,
        message: job.purpose === "webpage"
          ? "Paper webpage snapshot job queued for the browser extension."
          : message
      };
    }
  };
}
