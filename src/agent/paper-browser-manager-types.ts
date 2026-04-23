export interface PaperBrowserManagerMetadata {
  pid: number;
  startedAt: string;
  endpoint: string;
  profileDir: string;
}

export interface PaperBrowserManagerHealthResponse {
  ok: true;
  browserConnected: boolean;
  profileDir: string;
}

export interface OpenArticleRequest {
  url: string;
}

export interface OpenArticleResponse {
  openedUrl: string;
}

export interface DownloadPdfRequest {
  url: string;
  workspaceDir: string;
}

export interface DownloadPdfResponse {
  status: "downloaded";
  path: string;
  publisher: "science" | "nature" | "aps";
  articleUrl: string;
  finalArticleUrl: string;
  finalPdfUrl: string;
}
