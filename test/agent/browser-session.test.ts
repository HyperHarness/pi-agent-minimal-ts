import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  getPaperBrowserProfileDir,
  normalizeChromeExecutablePath,
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
