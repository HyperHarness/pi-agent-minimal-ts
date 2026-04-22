import path from "node:path";
import { chromium } from "playwright";

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

export function classifyArticleAuthorization(input: {
  finalUrl: string;
  html: string;
}): {
  authorized: boolean;
  failureCode?: "authorization_failed";
} {
  const finalUrl = input.finalUrl.toLowerCase();
  const html = input.html.toLowerCase();
  const urlSignals = [
    "showlogin",
    "/login",
    "/signin"
  ];
  const loginWallSignals = [
    "access through your institution",
    "purchase access",
    "institutional sign in",
    "sign in through your institution"
  ];

  if (
    urlSignals.some((signal) => finalUrl.includes(signal)) ||
    loginWallSignals.some((signal) => html.includes(signal))
  ) {
    return {
      authorized: false,
      failureCode: "authorization_failed"
    };
  }

  return {
    authorized: true
  };
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

export function resolveDefaultPaperBrowserSessionFactory(options: {
  workspaceDir: string;
  env?: PaperBrowserEnvironment;
}): () => Promise<PaperBrowserSession> {
  return async () => {
    const launchOptions = resolvePaperBrowserLaunchOptions(options);

    try {
      const context = await chromium.launchPersistentContext(launchOptions.userDataDir, {
        executablePath: launchOptions.executablePath,
        headless: false,
        acceptDownloads: true
      });

      return {
        async openArticlePage(url: string): Promise<OpenArticlePageResult> {
          const page = await context.newPage();

          try {
            await page.goto(url, { waitUntil: "domcontentloaded" });

            try {
              await page.waitForLoadState("networkidle");
            } catch {
              // Some publisher pages never go idle; use the settled DOM state we have.
            }

            const finalArticleUrl = page.url();
            const html = await page.content();
            const authorization = classifyArticleAuthorization({
              finalUrl: finalArticleUrl,
              html
            });

            return {
              finalArticleUrl,
              html,
              authorized: authorization.authorized
            };
          } finally {
            await page.close().catch(() => {});
          }
        },

        async downloadPdf(url: string, destinationPath: string): Promise<void> {
          const page = await context.newPage();

          try {
            const downloadPromise = page.waitForEvent("download");
            await page.goto(url, { waitUntil: "domcontentloaded" });
            const download = await downloadPromise;
            await download.saveAs(destinationPath);
          } finally {
            await page.close().catch(() => {});
          }
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PaperBrowserSessionError("browser_session_unavailable", message);
    }
  };
}
