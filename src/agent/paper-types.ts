export type PaperSource = "arxiv" | "science" | "nature" | "aps" | "external";

export type PaperAction = "direct_download" | "authorized_download" | "open_url_only";
export type SupportedPaperSource = "science" | "nature" | "aps";
export type DownloadablePaperSource = "arxiv" | SupportedPaperSource;

export interface PaperFailure {
  code: string;
  message: string;
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
  handlingMethod: "browser_session";
  status: "downloaded";
  canonicalId: string;
  pdfUrl: string;
  downloadPath: string;
  openedUrl?: never;
  failure?: never;
};

type ManualFallbackPaperRecord = {
  source: SupportedPaperSource;
  articleUrl: string;
  openedUrl: string;
  recordedAt: string;
  handlingMethod: "browser_session";
  status: "manual_fallback_opened";
  canonicalId: string;
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

export type PaperRecord =
  | DownloadedArxivPaperRecord
  | DownloadedPublisherPaperRecord
  | ManualFallbackPaperRecord
  | ExternalOpenedPaperRecord;

export interface DownloadedPaperResult {
  status: "downloaded";
  source: DownloadablePaperSource;
  canonicalId: string;
  articleUrl: string;
  finalPdfUrl: string;
  path: string;
  recordPath: string;
}

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

export type PaperDownloadResult =
  | DownloadedPaperResult
  | ManualFallbackPaperResult
  | ExternalOpenedPaperResult;
