import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearPaperBrowserManagerMetadata,
  getPaperBrowserManagerMetadataPath,
  isPaperBrowserManagerMetadataStale,
  readPaperBrowserManagerMetadata,
  writePaperBrowserManagerMetadata
} from "../../src/agent/paper-browser-manager-discovery.js";
import type {
  DownloadPdfRequest,
  DownloadPdfResponse,
  OpenArticleRequest,
  OpenArticleResponse,
  PaperBrowserManagerHealthResponse,
  PaperBrowserManagerMetadata
} from "../../src/agent/paper-browser-manager-types.js";

test("getPaperBrowserManagerMetadataPath stores metadata inside the browser profile directory", () => {
  const workspaceDir = path.join("C:", "work", "papers");

  assert.equal(
    getPaperBrowserManagerMetadataPath(workspaceDir),
    path.join(workspaceDir, ".browser-profile", "paper-access-manager.json")
  );
});

test("paper browser manager protocol types accept representative values", () => {
  const metadata: PaperBrowserManagerMetadata = {
    pid: 1234,
    startedAt: "2026-04-23T10:11:12.000Z",
    endpoint: "http://127.0.0.1:4040",
    profileDir: "C:/work/papers/.browser-profile"
  };
  const health: PaperBrowserManagerHealthResponse = {
    ok: true,
    browserConnected: true,
    profileDir: metadata.profileDir
  };
  const openRequest: OpenArticleRequest = {
    url: "https://www.science.org/doi/10.1126/science.adz8659"
  };
  const openResponse: OpenArticleResponse = {
    openedUrl: openRequest.url
  };
  const downloadRequest: DownloadPdfRequest = {
    url: openRequest.url,
    workspaceDir: "C:/work/papers"
  };
  const downloadResponse: DownloadPdfResponse = {
    status: "downloaded",
    path: "C:/work/papers/downloads/papers/science-10.1126-science.adz8659.pdf",
    publisher: "science",
    articleUrl: downloadRequest.url,
    finalArticleUrl: openResponse.openedUrl,
    finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659"
  };

  assert.equal(metadata.pid, 1234);
  assert.equal(health.ok, true);
  assert.equal(openResponse.openedUrl, openRequest.url);
  assert.equal(downloadResponse.status, "downloaded");
  assert.equal(downloadResponse.publisher, "science");
});

test("writePaperBrowserManagerMetadata persists pretty-printed JSON that readPaperBrowserManagerMetadata can parse", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-manager-"));
  const metadata = {
    pid: 1234,
    startedAt: "2026-04-23T10:11:12.000Z",
    endpoint: "http://127.0.0.1:4040",
    profileDir: path.join(workspaceDir, ".browser-profile")
  };

  await writePaperBrowserManagerMetadata({ workspaceDir, metadata });

  const metadataPath = getPaperBrowserManagerMetadataPath(workspaceDir);
  assert.equal(
    await readFile(metadataPath, "utf8"),
    JSON.stringify(metadata, null, 2)
  );
  assert.deepEqual(await readPaperBrowserManagerMetadata({ workspaceDir }), metadata);
});

test("readPaperBrowserManagerMetadata returns null when the metadata file is unreadable or invalid JSON", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-manager-"));
  const metadataPath = getPaperBrowserManagerMetadataPath(workspaceDir);

  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, "{ not valid json", "utf8");

  assert.equal(await readPaperBrowserManagerMetadata({ workspaceDir }), null);
});

test("clearPaperBrowserManagerMetadata removes the metadata file", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-manager-"));
  const metadata = {
    pid: 1234,
    startedAt: "2026-04-23T10:11:12.000Z",
    endpoint: "http://127.0.0.1:4040",
    profileDir: path.join(workspaceDir, ".browser-profile")
  };

  await writePaperBrowserManagerMetadata({ workspaceDir, metadata });
  await clearPaperBrowserManagerMetadata({ workspaceDir });

  assert.equal(await readPaperBrowserManagerMetadata({ workspaceDir }), null);
});

test("isPaperBrowserManagerMetadataStale respects the injected process liveness check", () => {
  const metadata = {
    pid: 1234,
    startedAt: "2026-04-23T10:11:12.000Z",
    endpoint: "http://127.0.0.1:4040",
    profileDir: "/tmp/browser-profile"
  };

  assert.equal(
    isPaperBrowserManagerMetadataStale({
      metadata,
      isProcessAlive: () => false
    }),
    true
  );
  assert.equal(isPaperBrowserManagerMetadataStale({ metadata, isProcessAlive: () => true }), false);
});
