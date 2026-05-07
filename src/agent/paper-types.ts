export type PaperSource = "arxiv" | "science" | "nature" | "aps" | "external";

export type PaperAction = "direct_download" | "authorized_download" | "open_url_only";
export type SupportedPaperSource = "science" | "nature" | "aps";
export type DownloadablePaperSource = "arxiv" | SupportedPaperSource;

export interface PaperFailure {
  code: string;
  message: string;
}

export type PaperRecordArtifactStatus =
  | "not_started"
  | "downloaded"
  | "parsed"
  | "already_parsed"
  | "queued"
  | "failed"
  | "manual_login_required"
  | "manual_fallback_opened"
  | "preprint_fallback"
  | "publisher_pending"
  | "external_opened";

export type PaperRecordReadingStatus = "not_ready" | "ready" | "queued" | "failed";
export type PaperRecordReadingPreferredSource = "webpage" | "pdf_parse";

export interface PaperRecordQualitySummary {
  status: string;
  score: number;
  pages: number;
  totalTextLength: number;
  warnings: string[];
}

export interface PaperRecordArtifactManifest {
  status: PaperRecordArtifactStatus;
  updatedAt: string;
  method?: string;
  paperKey?: string;
  engine?: string;
  pdfPath?: string;
  pdfUrl?: string;
  pdfSha256?: string;
  sourceSha256?: string;
  markdownPath?: string;
  parsePath?: string;
  qualityPath?: string;
  chunksPath?: string;
  jobId?: string;
  message?: string;
  quality?: PaperRecordQualitySummary;
  failure?: PaperFailure;
}

export interface PaperRecordReadingManifest {
  status: PaperRecordReadingStatus;
  updatedAt: string;
  preferredSource?: PaperRecordReadingPreferredSource;
  paperKey?: string;
  markdownPath?: string;
  parsePath?: string;
  qualityPath?: string;
  chunksPath?: string;
  quality?: PaperRecordQualitySummary;
  reason?: string;
}

export interface PaperRecordManifest {
  updatedAt?: string;
  download?: PaperRecordArtifactManifest;
  parse?: PaperRecordArtifactManifest;
  webpage?: PaperRecordArtifactManifest;
  reading?: PaperRecordReadingManifest;
}

export type PaperCitationStatus = "complete" | "incomplete";

export interface PaperSourcePreprintFallback {
  arxivId: string;
  articleUrl: string;
  pdfUrl: string;
  acquisitionPath: string;
  downloadPath: string;
  status: "downloaded" | "already_downloaded";
}

export interface PaperSourceMetadata {
  schemaVersion: 2;
  paperKey: string;
  source: PaperSource;
  canonicalId?: string;
  title?: string;
  authors: string[];
  year?: number;
  venue?: string;
  publisher?: string;
  doi?: string;
  arxivId?: string;
  articleUrl: string;
  createdAt?: string;
  pdfUrl?: string;
  pdfPath?: string;
  pdfSha256?: string;
  downloadPath?: string;
  acquisitionPath: string;
  recordPath: string;
  bibPath?: string;
  cslPath?: string;
  downloadStatus: PaperRecord["status"];
  readingStatus?: PaperRecordReadingStatus;
  citationStatus: PaperCitationStatus;
  missingFields: string[];
  resolvedFrom: "acquisition";
  sourceConfidence: "high" | "medium" | "low";
  recordedAt: string;
  updatedAt: string;
  preprintFallback?: PaperSourcePreprintFallback;
}

export interface PaperRecordPreprintFallback {
  source: "arxiv";
  canonicalId: string;
  articleUrl: string;
  pdfUrl: string;
  recordPath: string;
  downloadPath: string;
  status: "downloaded" | "already_downloaded";
}

export type PaperSearchSource =
  | {
      source: "arxiv";
      action: "direct_download";
      canonicalId: string;
      articleUrl: string;
      pdfUrl: string;
    }
  | {
      source: SupportedPaperSource;
      action: "authorized_download";
      canonicalId?: string;
      articleUrl: string;
      pdfUrl?: string;
    }
  | {
      source: "external";
      action: "open_url_only";
      articleUrl: string;
      canonicalId?: never;
      pdfUrl?: never;
    };

type PaperSearchPrimary =
  | {
      primarySource: "arxiv";
      primaryAction: "direct_download";
    }
  | {
      primarySource: SupportedPaperSource;
      primaryAction: "authorized_download";
    }
  | {
      primarySource: "external";
      primaryAction: "open_url_only";
    };

export type PaperSearchResult = PaperSearchPrimary & {
  title: string;
  authors: string[];
  summary: string;
  sources: PaperSearchSource[];
};

type DownloadedArxivPaperRecord = {
  source: "arxiv";
  articleUrl: string;
  recordedAt: string;
  handlingMethod: "direct_http";
  status: "downloaded";
  canonicalId: string;
  pdfUrl: string;
  downloadPath: string;
  openedUrl?: never;
  failure?: never;
};

type DownloadedPublisherPaperRecord = {
  source: SupportedPaperSource;
  articleUrl: string;
  recordedAt: string;
  handlingMethod: "browser_session" | "direct_http";
  status: "downloaded";
  canonicalId: string;
  pdfUrl: string;
  downloadPath: string;
  openedUrl?: never;
  failure?: never;
};

type PublisherPreprintFallbackPaperRecord = {
  source: SupportedPaperSource;
  articleUrl: string;
  recordedAt: string;
  handlingMethod: "arxiv_preprint_fallback";
  status: "preprint_fallback";
  canonicalId: string;
  title?: string;
  preprint: PaperRecordPreprintFallback;
  failure: PaperFailure;
  openedUrl?: never;
  pdfUrl?: never;
  downloadPath?: never;
};

type PublisherPendingPaperRecord = {
  source: SupportedPaperSource;
  articleUrl: string;
  recordedAt: string;
  handlingMethod: "accepted_paper";
  status: "publisher_pending";
  canonicalId: string;
  title?: string;
  failure: PaperFailure;
  openedUrl?: never;
  pdfUrl?: never;
  downloadPath?: never;
};

type ManualFallbackPaperRecord = {
  source: SupportedPaperSource;
  articleUrl: string;
  openedUrl: string;
  recordedAt: string;
  handlingMethod: "browser_session";
  status: "manual_fallback_opened";
  canonicalId: string;
  title?: string;
  failure: PaperFailure;
  pdfUrl?: never;
  downloadPath?: never;
};

type ExternalOpenedPaperRecord = {
  source: "external";
  articleUrl: string;
  openedUrl: string;
  recordedAt: string;
  handlingMethod: "system_browser_open";
  status: "external_opened";
  canonicalId?: never;
  pdfUrl?: never;
  downloadPath?: never;
  failure?: never;
};

type DownloadedExternalPaperRecord = {
  source: "external";
  articleUrl: string;
  openedUrl?: string;
  recordedAt: string;
  handlingMethod: "manual_file_import" | "direct_http";
  status: "downloaded";
  downloadPath: string;
  fileSha256: string;
  title?: string;
  pdfUrl?: string;
  canonicalId?: never;
  failure?: never;
};

export type PaperRecord = PaperRecordManifest & (
  | DownloadedArxivPaperRecord
  | DownloadedPublisherPaperRecord
  | DownloadedExternalPaperRecord
  | PublisherPreprintFallbackPaperRecord
  | PublisherPendingPaperRecord
  | ManualFallbackPaperRecord
  | ExternalOpenedPaperRecord
);

export interface PublisherPreprintFallbackResult {
  source: SupportedPaperSource;
  canonicalId: string;
  articleUrl: string;
  recordPath: string;
  reason: string;
  title?: string;
}

export interface DownloadedPaperResult {
  status: "downloaded";
  source: DownloadablePaperSource;
  canonicalId: string;
  articleUrl: string;
  finalPdfUrl: string;
  path: string;
  recordPath: string;
  publisherFallback?: PublisherPreprintFallbackResult;
}

export interface DownloadedExternalPaperResult {
  status: "downloaded";
  source: "external";
  articleUrl: string;
  finalPdfUrl: string;
  path: string;
  recordPath: string;
  fileSha256: string;
  title?: string;
}

type AlreadyDownloadedManagedPaperResult = {
  status: "already_downloaded";
  source: DownloadablePaperSource;
  canonicalId: string;
  articleUrl: string;
  finalPdfUrl: string;
  path: string;
  recordPath: string;
  recordedAt: string;
  publisherFallback?: PublisherPreprintFallbackResult;
};

type AlreadyDownloadedExternalPaperResult = {
  status: "already_downloaded";
  source: "external";
  articleUrl: string;
  path: string;
  recordPath: string;
  recordedAt: string;
  fileSha256: string;
  title?: string;
  canonicalId?: never;
  finalPdfUrl?: string;
};

export type AlreadyDownloadedPaperResult =
  | AlreadyDownloadedManagedPaperResult
  | AlreadyDownloadedExternalPaperResult;

export interface ManualFallbackPaperResult {
  status: "manual_fallback_opened";
  source: "science" | "nature" | "aps";
  canonicalId: string;
  articleUrl: string;
  fallbackUrl: string;
  recordPath: string;
  failure: PaperFailure;
  profileDir?: string;
  executablePath?: string;
}

export interface ExternalOpenedPaperResult {
  status: "external_opened";
  source: "external";
  articleUrl: string;
  openedUrl: string;
  recordPath: string;
  executablePath?: string;
}

export interface ExtensionUnavailablePaperResult {
  status: "extension_unavailable";
  source: SupportedPaperSource | "external";
  articleUrl: string;
  failure: PaperFailure;
}

export interface BlockedPaperDownloadResult {
  status: "blocked";
  source?: PaperSource;
  canonicalId?: string;
  articleUrl?: string;
  paperKey?: string;
  title?: string;
  failure: PaperFailure;
}

export interface PublisherPendingPaperResult {
  status: "publisher_pending";
  source: SupportedPaperSource;
  canonicalId: string;
  articleUrl: string;
  recordPath: string;
  failure: PaperFailure;
  title?: string;
}

export interface ExtensionPaperJobResult {
  status:
    | "extension_job_queued"
    | "opened_in_user_browser"
    | "awaiting_user_verification"
    | "awaiting_user_manual_download";
  source: SupportedPaperSource | "external";
  articleUrl: string;
  jobId: string;
  message: string;
}

export interface RegisteredManualPaperDownloadResult {
  status: "downloaded";
  source: "external";
  articleUrl: string;
  path: string;
  recordPath: string;
  fileSha256: string;
  title?: string;
}

export type PaperDownloadResult =
  | DownloadedPaperResult
  | DownloadedExternalPaperResult
  | AlreadyDownloadedPaperResult
  | ManualFallbackPaperResult
  | ExternalOpenedPaperResult
  | ExtensionUnavailablePaperResult
  | BlockedPaperDownloadResult
  | PublisherPendingPaperResult
  | ExtensionPaperJobResult;
