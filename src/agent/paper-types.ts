export type PaperSource = "arxiv" | "science" | "nature" | "aps" | "external";

export type PaperAction = "direct_download" | "authorized_download" | "open_url_only";

export interface PaperFailure {
  code: string;
  message: string;
}

export interface PaperSearchSource {
  source: PaperSource;
  action: PaperAction;
  canonicalId?: string;
  articleUrl: string;
  pdfUrl?: string;
}

export interface PaperSearchResult {
  title: string;
  authors: string[];
  summary: string;
  primarySource: PaperSource;
  primaryAction: PaperAction;
  sources: PaperSearchSource[];
}

export interface PaperRecord {
  source: PaperSource;
  articleUrl: string;
  openedUrl?: string;
  recordedAt: string;
  handlingMethod: "direct_http" | "browser_session" | "system_browser_open";
  status: "downloaded" | "manual_fallback_opened" | "external_opened";
  canonicalId?: string;
  pdfUrl?: string;
  downloadPath?: string;
  failure?: PaperFailure;
}

export interface DownloadedPaperResult {
  status: "downloaded";
  source: Exclude<PaperSource, "external">;
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
