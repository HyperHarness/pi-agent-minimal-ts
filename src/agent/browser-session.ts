import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
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

export interface OpenManualLoginPageResult {
  openedUrl: string;
}

export interface OpenSystemChromePageResult {
  url: string;
  openedUrl: string;
  profileDir: string;
  executablePath: string;
}

export interface OpenSystemChromePageOptions {
  workspaceDir: string;
  url: string;
  env?: PaperBrowserEnvironment;
  platform?: NodeJS.Platform;
  fileExists?: (candidatePath: string) => boolean;
  spawnImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => Pick<ChildProcess, "unref">;
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
  openPageForManualLogin(url: string): Promise<OpenManualLoginPageResult>;
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

export function resolveSystemChromeExecutablePath(options: {
  env?: PaperBrowserEnvironment;
  platform?: NodeJS.Platform;
  fileExists?: (candidatePath: string) => boolean;
}): string | undefined {
  const env = options.env ?? process.env;
  const configuredPath = normalizeChromeExecutablePath(env.PI_PAPER_CHROME_EXECUTABLE);
  if (configuredPath) {
    return configuredPath;
  }

  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;
  const candidates =
    platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
        ]
      : [];

  return candidates.find((candidatePath) => fileExists(candidatePath));
}

export async function openPageInSystemChromeForManualLogin(
  options: OpenSystemChromePageOptions
): Promise<OpenSystemChromePageResult> {
  const executablePath = resolveSystemChromeExecutablePath(options);
  if (!executablePath) {
    throw new Error(
      "Unable to locate a local Chrome or Edge executable. Set PI_PAPER_CHROME_EXECUTABLE first."
    );
  }

  const profileDir = getPaperBrowserProfileDir(path.resolve(options.workspaceDir));
  const spawnImpl =
    options.spawnImpl ??
    ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions) as Pick<ChildProcess, "unref">);
  const args = [
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    options.url
  ];

  const child = spawnImpl(executablePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();

  return {
    url: options.url,
    openedUrl: options.url,
    profileDir,
    executablePath
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

        async openPageForManualLogin(url: string): Promise<OpenManualLoginPageResult> {
          const page = await context.newPage();

          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.bringToFront().catch(() => {});

          return {
            openedUrl: page.url()
          };
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
