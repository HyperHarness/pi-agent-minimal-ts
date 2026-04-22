import path from "node:path";

export interface PaperBrowserLaunchOptions {
  userDataDir: string;
  executablePath?: string;
}

export interface PaperBrowserEnvironment extends NodeJS.ProcessEnv {
  PI_PAPER_CHROME_EXECUTABLE?: string;
}

export interface OpenArticlePageResult {
  finalArticleUrl: string;
  html: string;
  authorized: boolean;
}

export class PaperBrowserSessionError extends Error {
  constructor(
    readonly code: "browser_session_unavailable" | "authorization_failed",
    message: string
  ) {
    super(message);
    this.name = "PaperBrowserSessionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface PaperBrowserSession {
  openArticlePage(url: string): Promise<OpenArticlePageResult>;
  downloadPdf(url: string, destinationPath: string): Promise<void>;
}

export function getPaperBrowserProfileDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".browser-profile", "paper-access");
}

export function normalizeChromeExecutablePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolvePaperBrowserLaunchOptions(options: {
  workspaceDir: string;
  env?: PaperBrowserEnvironment;
}): PaperBrowserLaunchOptions {
  const env = options.env ?? process.env;

  return {
    userDataDir: getPaperBrowserProfileDir(options.workspaceDir),
    executablePath: normalizeChromeExecutablePath(env.PI_PAPER_CHROME_EXECUTABLE)
  };
}
