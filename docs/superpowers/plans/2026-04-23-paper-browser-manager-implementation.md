# Paper Browser Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single-instance paper browser manager that owns `.browser-profile/paper-access/` and lets the existing paper tools reuse one browser session for both manual review and automatic download.

**Architecture:** Introduce a small localhost-only manager process that starts and owns the shared paper browser, exposes a narrow HTTP API, and is auto-started plus discovered by the agent tool layer. Move `open_paper_page_for_login` and `download_paper_pdf` to call the manager instead of directly launching Chrome or Playwright against the shared profile.

**Tech Stack:** TypeScript, Node.js built-in `http`, Playwright `chromium.connectOverCDP`, existing agent tool system, Node test runner

---

## File Structure

**Create:**
- `src/agent/paper-browser-manager-types.ts`
  Shared request/response shapes and status payloads for the manager protocol.
- `src/agent/paper-browser-manager-discovery.ts`
  Single-instance metadata helpers, stale-manager detection, and start/connect discovery.
- `src/agent/paper-browser-manager-server.ts`
  Localhost HTTP manager that owns Chrome, attaches over CDP, and serves paper actions.
- `src/agent/paper-browser-manager-client.ts`
  Agent-side client that talks to the manager and auto-starts it on demand.
- `test/agent/paper-browser-manager-discovery.test.ts`
  Unit tests for discovery metadata and stale-manager logic.
- `test/agent/paper-browser-manager-server.test.ts`
  Manager protocol and browser-owner unit tests with injected fakes.
- `test/agent/paper-browser-manager-client.test.ts`
  Client request/response and auto-start behavior tests.

**Modify:**
- `src/agent/browser-session.ts`
  Keep low-level page and PDF logic that still applies inside the manager, but remove direct shared-profile ownership from the agent tool path.
- `src/agent/tools.ts`
  Replace direct browser launch/manual open logic with manager-backed calls.
- `src/pi-agent.ts`
  Ensure tool cleanup also closes any manager client resources if needed.
- `src/index.ts`
  Re-export manager modules that belong in the library surface.
- `test/agent/tools.test.ts`
  Update tool tests to cover manager-backed behavior and cleanup.
- `README.md`
  Document the browser manager lifecycle and how manual review plus retry works now.

## Task 1: Define Manager Protocol And Discovery

**Files:**
- Create: `src/agent/paper-browser-manager-types.ts`
- Create: `src/agent/paper-browser-manager-discovery.ts`
- Test: `test/agent/paper-browser-manager-discovery.test.ts`

- [ ] **Step 1: Write the failing discovery and protocol tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  getPaperBrowserManagerMetadataPath,
  readPaperBrowserManagerMetadata,
  writePaperBrowserManagerMetadata,
  isPaperBrowserManagerMetadataStale
} from "../../src/agent/paper-browser-manager-discovery.js";

test("writePaperBrowserManagerMetadata persists the manager endpoint and profile path", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-meta-"));

  try {
    const metadata = {
      pid: 4242,
      startedAt: "2026-04-23T12:00:00.000Z",
      endpoint: "http://127.0.0.1:43123",
      profileDir: path.join(workspaceDir, ".browser-profile", "paper-access")
    };

    await writePaperBrowserManagerMetadata({ workspaceDir, metadata });
    const saved = await readPaperBrowserManagerMetadata({ workspaceDir });
    const raw = JSON.parse(
      await readFile(getPaperBrowserManagerMetadataPath(workspaceDir), "utf8")
    );

    assert.deepEqual(saved, metadata);
    assert.deepEqual(raw, metadata);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("isPaperBrowserManagerMetadataStale returns true when the manager pid is no longer alive", async () => {
  const stale = await isPaperBrowserManagerMetadataStale({
    metadata: {
      pid: 999999,
      startedAt: "2026-04-23T12:00:00.000Z",
      endpoint: "http://127.0.0.1:43123",
      profileDir: "C:\\\\path\\\\to\\\\workspace\\\\.browser-profile\\\\paper-access"
    },
    isProcessAlive: async () => false
  });

  assert.equal(stale, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-isolation=none dist/test/agent/paper-browser-manager-discovery.test.js`

Expected: FAIL with module-not-found or missing export errors for `paper-browser-manager-discovery`.

- [ ] **Step 3: Write the shared protocol types**

```ts
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
```

- [ ] **Step 4: Write minimal discovery helpers**

```ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PaperBrowserManagerMetadata } from "./paper-browser-manager-types.js";

export function getPaperBrowserManagerMetadataPath(workspaceDir: string): string {
  return path.join(workspaceDir, ".browser-profile", "paper-access-manager.json");
}

export async function writePaperBrowserManagerMetadata(options: {
  workspaceDir: string;
  metadata: PaperBrowserManagerMetadata;
}): Promise<void> {
  const metadataPath = getPaperBrowserManagerMetadataPath(options.workspaceDir);
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(options.metadata, null, 2), "utf8");
}

export async function readPaperBrowserManagerMetadata(options: {
  workspaceDir: string;
}): Promise<PaperBrowserManagerMetadata | null> {
  try {
    const text = await readFile(getPaperBrowserManagerMetadataPath(options.workspaceDir), "utf8");
    return JSON.parse(text) as PaperBrowserManagerMetadata;
  } catch {
    return null;
  }
}

export async function clearPaperBrowserManagerMetadata(options: {
  workspaceDir: string;
}): Promise<void> {
  await rm(getPaperBrowserManagerMetadataPath(options.workspaceDir), { force: true });
}

export async function isPaperBrowserManagerMetadataStale(options: {
  metadata: PaperBrowserManagerMetadata;
  isProcessAlive?: (pid: number) => Promise<boolean>;
}): Promise<boolean> {
  const isProcessAlive = options.isProcessAlive ?? (async () => true);
  return !(await isProcessAlive(options.metadata.pid));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/paper-browser-manager-discovery.test.js`

Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/agent/paper-browser-manager-types.ts src/agent/paper-browser-manager-discovery.ts test/agent/paper-browser-manager-discovery.test.ts
git commit -m "Add paper browser manager protocol and discovery helpers"
```

### Task 2: Add The Browser Manager Server

**Files:**
- Create: `src/agent/paper-browser-manager-server.ts`
- Modify: `src/agent/browser-session.ts`
- Test: `test/agent/paper-browser-manager-server.test.ts`

- [ ] **Step 1: Write the failing manager-server tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPaperBrowserManagerServer
} from "../../src/agent/paper-browser-manager-server.js";

test("manager health reports browser connection state", async () => {
  const server = createPaperBrowserManagerServer({
    workspaceDir: "C:\\\\path\\\\to\\\\workspace",
    browserController: {
      ensureBrowser: async () => {},
      health: async () => ({
        browserConnected: true,
        profileDir: "C:\\\\path\\\\to\\\\workspace\\\\.browser-profile\\\\paper-access"
      })
    } as never
  });

  const health = await server.handleHealth();

  assert.deepEqual(health, {
    ok: true,
    browserConnected: true,
    profileDir: "C:\\\\path\\\\to\\\\workspace\\\\.browser-profile\\\\paper-access"
  });
});

test("manager download delegates to the shared browser controller", async () => {
  let called = false;
  const server = createPaperBrowserManagerServer({
    workspaceDir: "C:\\\\path\\\\to\\\\workspace",
    browserController: {
      ensureBrowser: async () => {},
      downloadPaperPdf: async () => {
        called = true;
        return {
          status: "downloaded",
          path: "C:\\\\path\\\\to\\\\workspace\\\\downloads\\\\papers\\\\nature-s41586-019-1666-5.pdf",
          publisher: "nature",
          articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
          finalArticleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
          finalPdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf"
        };
      }
    } as never
  });

  const result = await server.handleDownloadPdf({
    url: "https://www.nature.com/articles/s41586-019-1666-5",
    workspaceDir: "C:\\\\path\\\\to\\\\workspace"
  });

  assert.equal(called, true);
  assert.equal(result.status, "downloaded");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-isolation=none dist/test/agent/paper-browser-manager-server.test.js`

Expected: FAIL with module-not-found or missing export errors for `paper-browser-manager-server`.

- [ ] **Step 3: Write the browser manager server skeleton**

```ts
import type {
  DownloadPdfRequest,
  DownloadPdfResponse,
  OpenArticleRequest,
  OpenArticleResponse,
  PaperBrowserManagerHealthResponse
} from "./paper-browser-manager-types.js";

export interface PaperBrowserController {
  ensureBrowser(): Promise<void>;
  health(): Promise<{ browserConnected: boolean; profileDir: string }>;
  openArticle(request: OpenArticleRequest): Promise<OpenArticleResponse>;
  downloadPaperPdf(request: DownloadPdfRequest): Promise<DownloadPdfResponse>;
  close(): Promise<void>;
}

export function createPaperBrowserManagerServer(options: {
  workspaceDir: string;
  browserController: PaperBrowserController;
}) {
  return {
    async handleHealth(): Promise<PaperBrowserManagerHealthResponse> {
      await options.browserController.ensureBrowser();
      const health = await options.browserController.health();
      return { ok: true, ...health };
    },
    async handleOpenArticle(request: OpenArticleRequest): Promise<OpenArticleResponse> {
      await options.browserController.ensureBrowser();
      return options.browserController.openArticle(request);
    },
    async handleDownloadPdf(request: DownloadPdfRequest): Promise<DownloadPdfResponse> {
      await options.browserController.ensureBrowser();
      return options.browserController.downloadPaperPdf(request);
    }
  };
}
```

- [ ] **Step 4: Extract reusable browser-page logic in `browser-session.ts`**

```ts
export interface AttachedPaperBrowserSession {
  openArticlePage(url: string): Promise<OpenArticlePageResult>;
  openPageForManualLogin(url: string): Promise<OpenManualLoginPageResult>;
  downloadPdf(url: string, destinationPath: string): Promise<void>;
}

export function createAttachedPaperBrowserSession(options: {
  context: {
    newPage: () => Promise<any>;
  };
}): AttachedPaperBrowserSession {
  return {
    async openArticlePage(url) {
      const page = await options.context.newPage();
      // Move the existing openArticlePage logic here unchanged.
    },
    async openPageForManualLogin(url) {
      const page = await options.context.newPage();
      // Move the existing openPageForManualLogin logic here unchanged.
    },
    async downloadPdf(url, destinationPath) {
      const page = await options.context.newPage();
      // Move the existing PDF-byte validation logic here unchanged.
    }
  };
}
```

- [ ] **Step 5: Add the HTTP host entrypoint for the manager**

```ts
import http from "node:http";

export async function startPaperBrowserManagerHttpServer(options: {
  workspaceDir: string;
  manager: ReturnType<typeof createPaperBrowserManagerServer>;
}): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const body = JSON.stringify(await options.manager.handleHealth());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind paper browser manager.");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/paper-browser-manager-server.test.js`

Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/agent/browser-session.ts src/agent/paper-browser-manager-server.ts test/agent/paper-browser-manager-server.test.ts
git commit -m "Add paper browser manager server"
```

### Task 3: Add The Manager Client And Tool Integration

**Files:**
- Create: `src/agent/paper-browser-manager-client.ts`
- Modify: `src/agent/tools.ts`
- Modify: `src/pi-agent.ts`
- Test: `test/agent/paper-browser-manager-client.test.ts`
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Write the failing client and tool tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createPaperBrowserManagerClient } from "../../src/agent/paper-browser-manager-client.js";
import { createTools } from "../../src/agent/tools.js";

test("paper browser manager client reuses an existing healthy manager endpoint", async () => {
  let healthCalls = 0;
  const client = createPaperBrowserManagerClient({
    workspaceDir: "C:\\\\path\\\\to\\\\workspace",
    readMetadata: async () => ({
      pid: 4242,
      startedAt: "2026-04-23T12:00:00.000Z",
      endpoint: "http://127.0.0.1:43123",
      profileDir: "C:\\\\path\\\\to\\\\workspace\\\\.browser-profile\\\\paper-access"
    }),
    fetchJson: async (url) => {
      if (url.endsWith("/health")) {
        healthCalls += 1;
        return { ok: true, browserConnected: true, profileDir: "C:\\\\path\\\\to\\\\workspace\\\\.browser-profile\\\\paper-access" };
      }
      throw new Error("unexpected request");
    }
  } as never);

  const endpoint = await client.ensureManagerEndpoint();

  assert.equal(endpoint, "http://127.0.0.1:43123");
  assert.equal(healthCalls, 1);
});

test("download_paper_pdf uses the browser manager client instead of direct browser ownership", async () => {
  const tools = createTools("C:\\\\path\\\\to\\\\workspace", {
    paperBrowserManagerClient: {
      downloadPaperPdf: async () => ({
        status: "downloaded",
        path: "C:\\\\path\\\\to\\\\workspace\\\\downloads\\\\papers\\\\aps-10.1103-PhysRevLett.134.090601.pdf",
        publisher: "aps",
        articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
        finalArticleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
        finalPdfUrl: "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.134.090601"
      })
    }
  } as never);

  const tool = tools.find((candidate) => candidate.name === "download_paper_pdf");
  const result = await tool!.execute!("call-1", {
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601"
  }, undefined);

  assert.equal((result.details as { status: string }).status, "downloaded");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-isolation=none dist/test/agent/paper-browser-manager-client.test.js`

Expected: FAIL with module-not-found or missing dependency injection support.

- [ ] **Step 3: Write the manager client**

```ts
import type {
  DownloadPdfRequest,
  DownloadPdfResponse,
  OpenArticleRequest,
  OpenArticleResponse,
  PaperBrowserManagerMetadata
} from "./paper-browser-manager-types.js";
import {
  clearPaperBrowserManagerMetadata,
  readPaperBrowserManagerMetadata,
  writePaperBrowserManagerMetadata
} from "./paper-browser-manager-discovery.js";

export interface PaperBrowserManagerClient {
  ensureManagerEndpoint(): Promise<string>;
  openArticle(request: OpenArticleRequest): Promise<OpenArticleResponse>;
  downloadPaperPdf(request: DownloadPdfRequest): Promise<DownloadPdfResponse>;
  close(): Promise<void>;
}

export function createPaperBrowserManagerClient(options: {
  workspaceDir: string;
  readMetadata?: typeof readPaperBrowserManagerMetadata;
  writeMetadata?: typeof writePaperBrowserManagerMetadata;
  clearMetadata?: typeof clearPaperBrowserManagerMetadata;
  fetchJson?: (url: string, init?: { method?: string; body?: string }) => Promise<any>;
  spawnManager?: () => Promise<PaperBrowserManagerMetadata>;
}): PaperBrowserManagerClient {
  let cachedEndpoint: string | undefined;

  return {
    async ensureManagerEndpoint() {
      if (cachedEndpoint) {
        return cachedEndpoint;
      }

      const metadata = await (options.readMetadata ?? readPaperBrowserManagerMetadata)({
        workspaceDir: options.workspaceDir
      });

      if (metadata) {
        await (options.fetchJson ?? (async () => ({})))(`${metadata.endpoint}/health`);
        cachedEndpoint = metadata.endpoint;
        return cachedEndpoint;
      }

      const started = await options.spawnManager!();
      await (options.writeMetadata ?? writePaperBrowserManagerMetadata)({
        workspaceDir: options.workspaceDir,
        metadata: started
      });
      cachedEndpoint = started.endpoint;
      return cachedEndpoint;
    },
    async openArticle(request) {
      const endpoint = await this.ensureManagerEndpoint();
      return (options.fetchJson ?? (async () => ({})))(`${endpoint}/open-article`, {
        method: "POST",
        body: JSON.stringify(request)
      });
    },
    async downloadPaperPdf(request) {
      const endpoint = await this.ensureManagerEndpoint();
      return (options.fetchJson ?? (async () => ({})))(`${endpoint}/download-pdf`, {
        method: "POST",
        body: JSON.stringify(request)
      });
    },
    async close() {}
  };
}
```

- [ ] **Step 4: Wire manager-backed paper tools into `src/agent/tools.ts`**

```ts
export interface ToolDependencies {
  // existing dependencies...
  paperBrowserManagerClient?: {
    openArticle(request: { url: string }): Promise<OpenPaperPageForLoginResult>;
    downloadPaperPdf(request: {
      url: string;
      workspaceDir: string;
    }): Promise<DownloadPaperPdfResult>;
    close?(): Promise<void>;
  };
}

const paperBrowserManagerClient =
  dependencies.paperBrowserManagerClient ??
  createPaperBrowserManagerClient({ workspaceDir: resolvedWorkspaceDir });

const openPaperPageForLoginImpl =
  dependencies.openPaperPageForLogin ??
  (async (options: { workspaceDir: string; url: string }) =>
    paperBrowserManagerClient.openArticle({ url: options.url }));

const downloadPaperPdfImpl =
  dependencies.downloadPaperPdf ??
  (async (options: { workspaceDir: string; url: string }) =>
    paperBrowserManagerClient.downloadPaperPdf({
      workspaceDir: options.workspaceDir,
      url: options.url
    }));
```

- [ ] **Step 5: Extend tool cleanup to close the manager client**

```ts
let cleanupPromise: Promise<void> | undefined;

Object.defineProperties(tools, {
  cleanup: {
    enumerable: false,
    value: async () => {
      cleanupPromise ??= (async () => {
        await disposeCachedBrowserSession();
        await paperBrowserManagerClient.close?.();
      })();
      await cleanupPromise;
    }
  }
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run build && node --test --test-isolation=none dist/test/agent/paper-browser-manager-client.test.js && node --test --test-isolation=none dist/test/agent/tools.test.js`

Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/agent/paper-browser-manager-client.ts src/agent/tools.ts src/pi-agent.ts test/agent/paper-browser-manager-client.test.ts test/agent/tools.test.ts
git commit -m "Integrate paper browser manager with agent tools"
```

### Task 4: Add Manager Startup, Docs, And End-To-End Verification

**Files:**
- Modify: `src/agent/paper-browser-manager-discovery.ts`
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `test/agent/paper-browser-manager-client.test.ts`

- [ ] **Step 1: Write the failing auto-start and stale-manager tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createPaperBrowserManagerClient } from "../../src/agent/paper-browser-manager-client.js";

test("client clears stale metadata and starts a fresh manager", async () => {
  let cleared = false;
  let spawned = false;

  const client = createPaperBrowserManagerClient({
    workspaceDir: "C:\\\\path\\\\to\\\\workspace",
    readMetadata: async () => ({
      pid: 999999,
      startedAt: "2026-04-23T12:00:00.000Z",
      endpoint: "http://127.0.0.1:43123",
      profileDir: "C:\\\\path\\\\to\\\\workspace\\\\.browser-profile\\\\paper-access"
    }),
    fetchJson: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    clearMetadata: async () => {
      cleared = true;
    },
    spawnManager: async () => {
      spawned = true;
      return {
        pid: 4343,
        startedAt: "2026-04-23T12:05:00.000Z",
        endpoint: "http://127.0.0.1:43124",
        profileDir: "C:\\\\path\\\\to\\\\workspace\\\\.browser-profile\\\\paper-access"
      };
    }
  } as never);

  const endpoint = await client.ensureManagerEndpoint();

  assert.equal(cleared, true);
  assert.equal(spawned, true);
  assert.equal(endpoint, "http://127.0.0.1:43124");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-isolation=none dist/test/agent/paper-browser-manager-client.test.js`

Expected: FAIL because stale-manager recovery is not implemented yet.

- [ ] **Step 3: Add stale-manager recovery and process spawn hook**

```ts
async function ensureFreshManagerEndpoint(): Promise<string> {
  const metadata = await readMetadata({ workspaceDir: options.workspaceDir });
  if (metadata) {
    try {
      await fetchJson(`${metadata.endpoint}/health`);
      return metadata.endpoint;
    } catch {
      await clearMetadata({ workspaceDir: options.workspaceDir });
    }
  }

  const started = await spawnManager();
  await writeMetadata({ workspaceDir: options.workspaceDir, metadata: started });
  return started.endpoint;
}
```

- [ ] **Step 4: Re-export manager modules**

```ts
export * from "./agent/paper-browser-manager-types.js";
export * from "./agent/paper-browser-manager-discovery.js";
export * from "./agent/paper-browser-manager-client.js";
export * from "./agent/paper-browser-manager-server.js";
```

- [ ] **Step 5: Document the new browser ownership model in `README.md`**

```md
## Paper Browser Manager

Paper downloads now use a single browser manager that owns `.browser-profile/paper-access/`.

- `open_paper_page_for_login` opens a tab in the managed browser session
- `download_paper_pdf` reuses that same session for automatic download
- if the manager is stale or not running, the agent starts it automatically

This removes the old conflict where manual fallback opened Chrome with the shared profile and later automatic download attempts could no longer launch Playwright against that same profile.
```

- [ ] **Step 6: Run final verification**

Run: `npm test`

Expected: PASS, 0 failures.

Run manually after tests:

```powershell
$env:PI_PAPER_CHROME_EXECUTABLE="C:\Path\To\Chrome\chrome.exe"
npm run agent
```

Then verify this sequence in one browser session:

```text
Open this paper page with open_paper_page_for_login: https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601
Download this paper with download_paper_pdf: https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601
```

Expected:

- the managed browser stays open
- no profile-contention error appears
- automatic download either succeeds or returns a publisher-specific failure unrelated to profile ownership

- [ ] **Step 7: Commit**

```bash
git add src/agent/paper-browser-manager-discovery.ts src/index.ts README.md test/agent/paper-browser-manager-client.test.ts
git commit -m "Add paper browser manager startup and docs"
```

## Self-Review

### Spec Coverage

- single browser owner: Task 2
- localhost control channel: Task 2
- discovery and stale-manager recovery: Tasks 1 and 4
- manager-backed tool integration: Task 3
- manual review plus retry in one browser session: Task 4 manual verification
- typed error preservation and PDF byte validation: Tasks 2 and 3 via reused browser-session logic

### Placeholder Scan

- No `TODO`, `TBD`, or deferred implementation markers remain.
- Each task lists exact files, commands, and concrete code to add.

### Type Consistency

- manager protocol types are defined first in Task 1 and reused consistently in Tasks 2 through 4
- tool integration uses `openArticle` and `downloadPaperPdf` consistently
- metadata fields stay fixed as `pid`, `startedAt`, `endpoint`, and `profileDir`
