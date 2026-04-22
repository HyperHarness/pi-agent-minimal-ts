import { writeFile } from "node:fs/promises";
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
  dispose?(): Promise<void>;
}

const CHALLENGE_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const CHALLENGE_POLL_INTERVAL_MS = 1_000;

function isAntiBotChallengePage(html: string): boolean {
  const normalizedHtml = html.toLowerCase();
  const antiBotSignals = [
    "security service to protect itself from malicious automated programs",
    "during verification that you are not an automated program",
    "verify you are not a robot"
  ];

  return antiBotSignals.some((signal) => normalizedHtml.includes(signal));
}

async function waitForAntiBotChallengeToClear(options: {
  page: {
    waitForTimeout: (timeout: number) => Promise<void>;
    content: () => Promise<string>;
  };
  isCleared: () => Promise<boolean>;
}): Promise<boolean> {
  const deadline = Date.now() + CHALLENGE_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await options.page.waitForTimeout(CHALLENGE_POLL_INTERVAL_MS);

    if (await options.isCleared()) {
      return true;
    }

    const html = await options.page.content();
    if (!isAntiBotChallengePage(html)) {
      return false;
    }
  }

  return false;
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
    "sign in through your institution",
    "security service to protect itself from malicious automated programs",
    "during verification that you are not an automated program",
    "verify you are not a robot"
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
      let disposePromise: Promise<void> | undefined;

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

            let finalArticleUrl = page.url();
            let html = await page.content();
            let authorization = classifyArticleAuthorization({
              finalUrl: finalArticleUrl,
              html
            });

            if (!authorization.authorized && isAntiBotChallengePage(html)) {
              await waitForAntiBotChallengeToClear({
                page,
                isCleared: async () => {
                  finalArticleUrl = page.url();
                  html = await page.content();
                  authorization = classifyArticleAuthorization({
                    finalUrl: finalArticleUrl,
                    html
                  });

                  return authorization.authorized;
                }
              });
            }

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
            const downloadPromise =
              typeof page.waitForEvent === "function"
                ? page.waitForEvent("download", { timeout: 30_000 }).catch(() => null)
                : Promise.resolve(null);
            let response = await page.goto(url, { waitUntil: "domcontentloaded" });
            let contentType = response?.headers()["content-type"]?.toLowerCase();

            if (response && contentType?.includes("application/pdf")) {
              const pdfBytes = await response.body();
              await writeFile(destinationPath, pdfBytes);
              return;
            }

            const html = await page.content();
            if (isAntiBotChallengePage(html)) {
              const challengeCleared = await waitForAntiBotChallengeToClear({
                page,
                isCleared: async () => {
                  response = await page.goto(url, { waitUntil: "domcontentloaded" });
                  contentType = response?.headers()["content-type"]?.toLowerCase();

                  if (response && contentType?.includes("application/pdf")) {
                    const pdfBytes = await response.body();
                    await writeFile(destinationPath, pdfBytes);
                    return true;
                  }

                  return false;
                }
              });

              if (response && contentType?.includes("application/pdf")) {
                return;
              }

              if (!challengeCleared) {
                throw new PaperBrowserSessionError(
                  "authorization_failed",
                  "Cloudflare verification blocked the PDF request. Complete the verification in the browser and retry."
                );
              }
            }

            const download = await downloadPromise;
            if (!download) {
              throw new Error("Timed out waiting for PDF download.");
            }
            await download.saveAs(destinationPath);
          } finally {
            await page.close().catch(() => {});
          }
        },

        async dispose(): Promise<void> {
          disposePromise ??= context.close();
          await disposePromise;
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PaperBrowserSessionError("browser_session_unavailable", message);
    }
  };
}
