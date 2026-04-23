import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  getPaperBrowserProfileDir,
  openPageInSystemChromeForManualLogin,
  normalizeChromeExecutablePath,
  resolveSystemChromeExecutablePath,
  resolvePaperBrowserLaunchOptions
} from "../../src/agent/browser-session.js";

test("getPaperBrowserProfileDir keeps the browser profile inside the workspace", () => {
  const workspaceDir = path.join("D:", "Codex", "pi-agent-minimal-ts");

  assert.equal(
    getPaperBrowserProfileDir(workspaceDir),
    path.join(workspaceDir, ".browser-profile", "paper-access")
  );
});

test("normalizeChromeExecutablePath trims blank values to undefined", () => {
  assert.equal(normalizeChromeExecutablePath(undefined), undefined);
  assert.equal(normalizeChromeExecutablePath("   "), undefined);
  assert.equal(
    normalizeChromeExecutablePath("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  );
});

test("resolvePaperBrowserLaunchOptions uses the dedicated profile path", () => {
  const options = resolvePaperBrowserLaunchOptions({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    env: {
      PI_PAPER_CHROME_EXECUTABLE: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    }
  });

  assert.equal(
    options.userDataDir,
    path.join("D:\\Codex\\pi-agent-minimal-ts", ".browser-profile", "paper-access")
  );
  assert.equal(
    options.executablePath,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  );
});

test("resolveSystemChromeExecutablePath prefers the configured Chrome executable", () => {
  const executablePath = resolveSystemChromeExecutablePath({
    env: {
      PI_PAPER_CHROME_EXECUTABLE: "C:\\Custom\\Chrome\\chrome.exe"
    },
    platform: "win32",
    fileExists: () => false
  });

  assert.equal(executablePath, "C:\\Custom\\Chrome\\chrome.exe");
});

test("openPageInSystemChromeForManualLogin launches Chrome with the shared profile", async () => {
  const spawned: Array<{
    executablePath: string;
    args: string[];
    options: { detached?: boolean; stdio?: string; windowsHide?: boolean };
  }> = [];
  let unrefCalls = 0;

  const result = await openPageInSystemChromeForManualLogin({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    url: "https://www.science.org/doi/10.1126/science.adz8659",
    env: {
      PI_PAPER_CHROME_EXECUTABLE: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    },
    spawnImpl: ((
      executablePath: string,
      args: readonly string[],
      options: { detached?: boolean; stdio?: string | readonly string[]; windowsHide?: boolean }
    ) => {
      spawned.push({
        executablePath,
        args: [...args],
        options: {
          detached: options?.detached,
          stdio: typeof options?.stdio === "string" ? options.stdio : undefined,
          windowsHide: options?.windowsHide
        }
      });

      return {
        unref() {
          unrefCalls += 1;
        }
      } as never;
    }) as never
  });

  assert.deepEqual(spawned, [
    {
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: [
        "--new-window",
        "--no-first-run",
        "--no-default-browser-check",
        "--user-data-dir=D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access",
        "https://www.science.org/doi/10.1126/science.adz8659"
      ],
      options: {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      }
    }
  ]);
  assert.equal(unrefCalls, 1);
  assert.deepEqual(result, {
    url: "https://www.science.org/doi/10.1126/science.adz8659",
    openedUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    profileDir: path.join("D:\\Codex\\pi-agent-minimal-ts", ".browser-profile", "paper-access"),
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  });
});
