# Extension-First Paper Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an extension-first publisher download path where a Chrome/Edge extension attempts PDF downloads from the user's real browser profile, keeps failed pages open for manual download, and registers completed PDFs through a local native messaging host.

**Architecture:** The agent remains responsible for search, classification, de-duplication, and paper index state. A Manifest V3 extension owns browser tabs and download monitoring, and it polls a Node native messaging host for queued jobs because native messaging connections are initiated by the extension, not by the agent. The native host validates downloaded PDF files and writes `downloads/papers/index/` records. The existing Playwright manager becomes an explicit fallback rather than the default publisher path.

**Tech Stack:** TypeScript, Node built-in test runner, Chrome/Edge Manifest V3 extension JavaScript, Chrome downloads/tabs/runtime APIs, Chrome Native Messaging, existing paper-store and paper-manager modules.

---

## File Structure

- Create `src/agent/paper-extension-protocol.ts`: shared message/status types plus runtime parsers for extension-native-host messages.
- Create `src/agent/paper-download-jobs.ts`: append-only JSONL job state store for queued/open/manual/downloaded extension jobs.
- Create `src/agent/paper-extension-host.ts`: native messaging host logic that reads framed JSON messages, validates PDFs, writes the paper index, and emits framed JSON responses.
- Create `src/paper-extension-host.ts`: CLI entrypoint for Chrome Native Messaging.
- Create `extension/paper-downloader/manifest.json`: MV3 extension manifest for Chrome/Edge.
- Create `extension/paper-downloader/background.js`: service worker for jobs, tabs, downloads, native messaging, and tab closing.
- Create `extension/paper-downloader/content/common.js`: publisher-independent page classification and PDF candidate extraction.
- Create `extension/paper-downloader/content/nature.js`: Nature-specific PDF candidate extraction.
- Create `extension/paper-downloader/content/science.js`: Science-specific PDF candidate extraction.
- Create `extension/paper-downloader/content/aps.js`: APS-specific PDF candidate extraction and challenge detection.
- Create `extension/paper-downloader/content/runner.js`: sends page classification and PDF candidates from content scripts to the background worker.
- Create `extension/paper-downloader/popup.html` and `extension/paper-downloader/popup.js`: minimal status UI for pending/manual jobs.
- Create `scripts/register-paper-extension-host.ps1`: Windows registration script for Chrome and Edge native messaging manifests.
- Modify `src/agent/paper-manager.ts`: route supported publisher/external URLs to the extension bridge when available; keep arXiv direct download.
- Modify `src/agent/tools.ts`: expose extension bridge status and preserve existing `download_paper`, `register_manual_paper_download`, and `open_paper_page_for_login` behavior.
- Modify `src/index.ts`: export new extension protocol/job/host APIs.
- Modify `README.md` and `docs/windows-powershell-codex-quickstart.md`: document extension install, native host registration, and fallback rules.
- Test with `test/agent/paper-extension-protocol.test.ts`, `test/agent/paper-download-jobs.test.ts`, `test/agent/paper-extension-host.test.ts`, `test/agent/paper-manager-extension.test.ts`, `test/agent/tools-extension.test.ts`, and extension helper tests under `test/extension/paper-downloader.test.mjs`.

## Task 1: Protocol Types and Parsers

**Files:**
- Create: `src/agent/paper-extension-protocol.ts`
- Create: `test/agent/paper-extension-protocol.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing protocol parser tests**

Add `test/agent/paper-extension-protocol.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseExtensionHostMessage,
  parseExtensionHostResponse
} from "../../src/agent/paper-extension-protocol.js";

test("parseExtensionHostMessage accepts register_download messages", () => {
  assert.deepEqual(
    parseExtensionHostMessage({
      type: "register_download",
      jobId: "job-123",
      articleUrl: "https://example.com/paper",
      source: "external",
      downloadPath: "C:\\Users\\user\\Downloads\\paper.pdf",
      title: "Manual Paper"
    }),
    {
      type: "register_download",
      jobId: "job-123",
      articleUrl: "https://example.com/paper",
      source: "external",
      downloadPath: "C:\\Users\\user\\Downloads\\paper.pdf",
      title: "Manual Paper"
    }
  );
});

test("parseExtensionHostMessage accepts job_status handoff messages", () => {
  assert.deepEqual(
    parseExtensionHostMessage({
      type: "job_status",
      jobId: "job-aps",
      status: "awaiting_user_verification",
      articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
      source: "aps",
      message: "Cloudflare verification is visible."
    }),
    {
      type: "job_status",
      jobId: "job-aps",
      status: "awaiting_user_verification",
      articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
      source: "aps",
      message: "Cloudflare verification is visible."
    }
  );
});

test("parseExtensionHostMessage accepts poll_jobs messages", () => {
  assert.deepEqual(
    parseExtensionHostMessage({
      type: "poll_jobs",
      extensionInstanceId: "chrome-main"
    }),
    {
      type: "poll_jobs",
      extensionInstanceId: "chrome-main"
    }
  );
});

test("parseExtensionHostMessage rejects unknown message shapes", () => {
  assert.throws(
    () =>
      parseExtensionHostMessage({
        type: "register_download",
        jobId: "job-123",
        articleUrl: "https://example.com/paper",
        source: "external"
      }),
    /downloadPath/i
  );
});

test("parseExtensionHostResponse accepts jobs, registered, and error responses", () => {
  assert.deepEqual(
    parseExtensionHostResponse({
      type: "jobs",
      jobs: [
        {
          jobId: "job-queued",
          articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
          source: "nature",
          autoClose: true
        }
      ]
    }),
    {
      type: "jobs",
      jobs: [
        {
          jobId: "job-queued",
          articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
          source: "nature",
          autoClose: true
        }
      ]
    }
  );

  assert.deepEqual(
    parseExtensionHostResponse({
      type: "registered",
      jobId: "job-123",
      articleUrl: "https://example.com/paper",
      downloadPath: "D:\\repo\\downloads\\papers\\external-example.pdf",
      recordPath: "D:\\repo\\downloads\\papers\\index\\external-example.json",
      fileSha256: "abc123"
    }),
    {
      type: "registered",
      jobId: "job-123",
      articleUrl: "https://example.com/paper",
      downloadPath: "D:\\repo\\downloads\\papers\\external-example.pdf",
      recordPath: "D:\\repo\\downloads\\papers\\index\\external-example.json",
      fileSha256: "abc123"
    }
  );

  assert.deepEqual(
    parseExtensionHostResponse({
      type: "error",
      jobId: "job-123",
      code: "not_pdf",
      message: "Downloaded file is not a valid PDF."
    }),
    {
      type: "error",
      jobId: "job-123",
      code: "not_pdf",
      message: "Downloaded file is not a valid PDF."
    }
  );
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
npm.cmd run build
```

Expected: TypeScript fails because `src/agent/paper-extension-protocol.ts` does not exist.

- [ ] **Step 3: Implement protocol types and parsers**

Create `src/agent/paper-extension-protocol.ts`:

```ts
import type { PaperSource } from "./paper-types.js";

export type ExtensionJobStatus =
  | "queued"
  | "opened_in_browser"
  | "page_classified"
  | "pdf_candidate_found"
  | "automatic_download_started"
  | "automatic_download_failed"
  | "awaiting_user_verification"
  | "awaiting_user_manual_download"
  | "manual_download_observed"
  | "downloaded";

export interface ExtensionPaperJobPayload {
  jobId: string;
  articleUrl: string;
  source: PaperSource;
  title?: string;
  autoClose?: boolean;
}

export type ExtensionHostMessage =
  | {
      type: "poll_jobs";
      extensionInstanceId: string;
    }
  | {
      type: "register_download";
      jobId: string;
      articleUrl: string;
      source: PaperSource;
      downloadPath: string;
      title?: string;
    }
  | {
      type: "job_status";
      jobId: string;
      status: ExtensionJobStatus;
      articleUrl: string;
      source?: PaperSource;
      message?: string;
    };

export type ExtensionHostResponse =
  | {
      type: "jobs";
      jobs: ExtensionPaperJobPayload[];
    }
  | {
      type: "registered";
      jobId: string;
      articleUrl: string;
      downloadPath: string;
      recordPath: string;
      fileSha256: string;
      title?: string;
    }
  | {
      type: "status_ack";
      jobId: string;
      status: ExtensionJobStatus;
    }
  | {
      type: "error";
      jobId?: string;
      code: string;
      message: string;
    };

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected a JSON object.");
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string when provided.`);
  }
  return value;
}

function readPaperSource(record: Record<string, unknown>, key: string): PaperSource {
  const value = readString(record, key);
  if (!["arxiv", "science", "nature", "aps", "external"].includes(value)) {
    throw new Error(`${key} must be a supported paper source.`);
  }
  return value as PaperSource;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean when provided.`);
  }
  return value;
}

function readJobStatus(record: Record<string, unknown>, key: string): ExtensionJobStatus {
  const value = readString(record, key);
  if (
    ![
      "queued",
      "opened_in_browser",
      "page_classified",
      "pdf_candidate_found",
      "automatic_download_started",
      "automatic_download_failed",
      "awaiting_user_verification",
      "awaiting_user_manual_download",
      "manual_download_observed",
      "downloaded"
    ].includes(value)
  ) {
    throw new Error(`${key} must be a supported extension job status.`);
  }
  return value as ExtensionJobStatus;
}

export function parseExtensionHostMessage(value: unknown): ExtensionHostMessage {
  assertRecord(value);
  const type = readString(value, "type");

  if (type === "poll_jobs") {
    return {
      type,
      extensionInstanceId: readString(value, "extensionInstanceId")
    };
  }

  if (type === "register_download") {
    return {
      type,
      jobId: readString(value, "jobId"),
      articleUrl: readString(value, "articleUrl"),
      source: readPaperSource(value, "source"),
      downloadPath: readString(value, "downloadPath"),
      ...(readOptionalString(value, "title") ? { title: readOptionalString(value, "title") } : {})
    };
  }

  if (type === "job_status") {
    const source = value.source === undefined ? undefined : readPaperSource(value, "source");
    return {
      type,
      jobId: readString(value, "jobId"),
      status: readJobStatus(value, "status"),
      articleUrl: readString(value, "articleUrl"),
      ...(source ? { source } : {}),
      ...(readOptionalString(value, "message") ? { message: readOptionalString(value, "message") } : {})
    };
  }

  throw new Error(`Unsupported extension host message type: ${type}`);
}

function parseExtensionPaperJobPayload(value: unknown): ExtensionPaperJobPayload {
  assertRecord(value);
  const autoClose = readOptionalBoolean(value, "autoClose");
  return {
    jobId: readString(value, "jobId"),
    articleUrl: readString(value, "articleUrl"),
    source: readPaperSource(value, "source"),
    ...(readOptionalString(value, "title") ? { title: readOptionalString(value, "title") } : {}),
    ...(autoClose === undefined ? {} : { autoClose })
  };
}

export function parseExtensionHostResponse(value: unknown): ExtensionHostResponse {
  assertRecord(value);
  const type = readString(value, "type");

  if (type === "jobs") {
    const jobs = value.jobs;
    if (!Array.isArray(jobs)) {
      throw new Error("jobs must be an array.");
    }
    return {
      type,
      jobs: jobs.map(parseExtensionPaperJobPayload)
    };
  }

  if (type === "registered") {
    return {
      type,
      jobId: readString(value, "jobId"),
      articleUrl: readString(value, "articleUrl"),
      downloadPath: readString(value, "downloadPath"),
      recordPath: readString(value, "recordPath"),
      fileSha256: readString(value, "fileSha256"),
      ...(readOptionalString(value, "title") ? { title: readOptionalString(value, "title") } : {})
    };
  }

  if (type === "status_ack") {
    return {
      type,
      jobId: readString(value, "jobId"),
      status: readJobStatus(value, "status")
    };
  }

  if (type === "error") {
    return {
      type,
      ...(readOptionalString(value, "jobId") ? { jobId: readOptionalString(value, "jobId") } : {}),
      code: readString(value, "code"),
      message: readString(value, "message")
    };
  }

  throw new Error(`Unsupported extension host response type: ${type}`);
}
```

Modify `src/index.ts`:

```ts
export * from "./agent/paper-extension-protocol.js";
```

- [ ] **Step 4: Run protocol tests to verify GREEN**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/paper-extension-protocol.test.js
```

Expected: build succeeds and protocol tests pass.

- [ ] **Step 5: Commit Task 1**

Run:

```powershell
git add src/agent/paper-extension-protocol.ts src/index.ts test/agent/paper-extension-protocol.test.ts
git commit -m "Add paper extension protocol"
```

## Task 2: Durable Extension Job Store

**Files:**
- Create: `src/agent/paper-download-jobs.ts`
- Create: `test/agent/paper-download-jobs.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing job store tests**

Create `test/agent/paper-download-jobs.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  appendPaperDownloadJobEvent,
  readPaperDownloadJobEvents,
  resolvePaperDownloadJobsPath,
  summarizePaperDownloadJobs
} from "../../src/agent/paper-download-jobs.js";

test("resolvePaperDownloadJobsPath stores operational state under .browser-profile", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-jobs-"));
  try {
    assert.equal(
      resolvePaperDownloadJobsPath({ workspaceDir }),
      path.join(workspaceDir, ".browser-profile", "paper-download-jobs.jsonl")
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("appendPaperDownloadJobEvent writes jsonl and summarizePaperDownloadJobs returns latest event per job", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-jobs-"));
  try {
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "job-1",
        recordedAt: "2026-04-25T10:00:00.000Z",
        status: "queued",
        articleUrl: "https://example.com/paper",
        source: "external",
        autoClose: true
      }
    });
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "job-1",
        recordedAt: "2026-04-25T10:01:00.000Z",
        status: "downloaded",
        articleUrl: "https://example.com/paper",
        source: "external",
        recordPath: path.join(workspaceDir, "downloads", "papers", "index", "external-example.json")
      }
    });

    assert.match(await readFile(resolvePaperDownloadJobsPath({ workspaceDir }), "utf8"), /"status":"queued"/);
    assert.deepEqual((await readPaperDownloadJobEvents({ workspaceDir })).map((event) => event.status), [
      "queued",
      "downloaded"
    ]);
    assert.deepEqual(summarizePaperDownloadJobs(await readPaperDownloadJobEvents({ workspaceDir })), {
      "job-1": {
        jobId: "job-1",
        recordedAt: "2026-04-25T10:01:00.000Z",
        status: "downloaded",
        articleUrl: "https://example.com/paper",
        source: "external",
        autoClose: true,
        recordPath: path.join(workspaceDir, "downloads", "papers", "index", "external-example.json")
      }
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("readPaperDownloadJobEvents ignores malformed jsonl lines", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-jobs-"));
  try {
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "job-2",
        recordedAt: "2026-04-25T10:00:00.000Z",
        status: "awaiting_user_verification",
        articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
        source: "aps",
        message: "Cloudflare verification is visible."
      }
    });
    await import("node:fs/promises").then(({ appendFile }) =>
      appendFile(resolvePaperDownloadJobsPath({ workspaceDir }), "not-json\n", "utf8")
    );

    assert.equal((await readPaperDownloadJobEvents({ workspaceDir })).length, 1);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
npm.cmd run build
```

Expected: TypeScript fails because `src/agent/paper-download-jobs.ts` does not exist.

- [ ] **Step 3: Implement job store**

Create `src/agent/paper-download-jobs.ts`:

```ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PaperSource } from "./paper-types.js";
import type { ExtensionJobStatus } from "./paper-extension-protocol.js";

export interface PaperDownloadJobEvent {
  jobId: string;
  recordedAt: string;
  status: ExtensionJobStatus;
  articleUrl: string;
  source?: PaperSource;
  title?: string;
  autoClose?: boolean;
  tabId?: number;
  downloadId?: number;
  recordPath?: string;
  downloadPath?: string;
  fileSha256?: string;
  message?: string;
}

export function resolvePaperDownloadJobsPath(input: { workspaceDir: string }): string {
  return path.join(input.workspaceDir, ".browser-profile", "paper-download-jobs.jsonl");
}

function isPaperDownloadJobEvent(value: unknown): value is PaperDownloadJobEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.jobId === "string" &&
    typeof event.recordedAt === "string" &&
    typeof event.status === "string" &&
    typeof event.articleUrl === "string"
  );
}

export async function appendPaperDownloadJobEvent(input: {
  workspaceDir: string;
  event: PaperDownloadJobEvent;
}): Promise<string> {
  const jobsPath = resolvePaperDownloadJobsPath({ workspaceDir: input.workspaceDir });
  await mkdir(path.dirname(jobsPath), { recursive: true });
  await appendFile(jobsPath, `${JSON.stringify(input.event)}\n`, "utf8");
  return jobsPath;
}

export async function readPaperDownloadJobEvents(input: {
  workspaceDir: string;
}): Promise<PaperDownloadJobEvent[]> {
  const jobsPath = resolvePaperDownloadJobsPath({ workspaceDir: input.workspaceDir });
  let text: string;
  try {
    text = await readFile(jobsPath, "utf8");
  } catch {
    return [];
  }

  const events: PaperDownloadJobEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (isPaperDownloadJobEvent(parsed)) {
        events.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return events;
}

export function summarizePaperDownloadJobs(
  events: PaperDownloadJobEvent[]
): Record<string, PaperDownloadJobEvent> {
  const summary: Record<string, PaperDownloadJobEvent> = {};
  for (const event of events) {
    summary[event.jobId] = event;
  }
  return summary;
}
```

Modify `src/index.ts`:

```ts
export * from "./agent/paper-download-jobs.js";
```

- [ ] **Step 4: Run job store tests to verify GREEN**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/paper-download-jobs.test.js
```

Expected: build succeeds and job store tests pass.

- [ ] **Step 5: Commit Task 2**

Run:

```powershell
git add src/agent/paper-download-jobs.ts src/index.ts test/agent/paper-download-jobs.test.ts
git commit -m "Add paper extension job store"
```

## Task 3: Native Messaging Host Core

**Files:**
- Create: `src/agent/paper-extension-host.ts`
- Create: `src/paper-extension-host.ts`
- Create: `test/agent/paper-extension-host.test.ts`
- Modify: `package.json`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing native host tests**

Create `test/agent/paper-extension-host.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  encodeNativeMessage,
  handleExtensionHostMessage,
  readNativeMessagesFromBuffer
} from "../../src/agent/paper-extension-host.js";
import { appendPaperDownloadJobEvent } from "../../src/agent/paper-download-jobs.js";

test("native message framing round-trips JSON messages", () => {
  const frame = encodeNativeMessage({ type: "status_ack", jobId: "job-1", status: "queued" });
  assert.deepEqual(readNativeMessagesFromBuffer(frame), [
    {
      type: "status_ack",
      jobId: "job-1",
      status: "queued"
    }
  ]);
});

test("handleExtensionHostMessage registers a completed external PDF download", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-host-"));
  const manualPdfPath = path.join(workspaceDir, "Downloads", "paper.pdf");
  try {
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.dirname(manualPdfPath), { recursive: true })
    );
    await writeFile(manualPdfPath, "%PDF-1.7\nmanual pdf\n", "utf8");

    const response = await handleExtensionHostMessage({
      workspaceDir,
      message: {
        type: "register_download",
        jobId: "job-1",
        articleUrl: "https://example.com/paper",
        source: "external",
        downloadPath: manualPdfPath,
        title: "Manual Paper"
      },
      now: () => new Date("2026-04-25T10:00:00.000Z")
    });

    assert.equal(response.type, "registered");
    assert.equal(response.jobId, "job-1");
    assert.equal(response.articleUrl, "https://example.com/paper");
    assert.match(response.fileSha256, /^[a-f0-9]{64}$/);
    assert.equal((await readFile(response.downloadPath, "utf8")).startsWith("%PDF-"), true);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage records status handoffs without indexing a PDF", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-host-"));
  try {
    const response = await handleExtensionHostMessage({
      workspaceDir,
      message: {
        type: "job_status",
        jobId: "job-aps",
        status: "awaiting_user_verification",
        articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
        source: "aps",
        message: "Cloudflare verification is visible."
      },
      now: () => new Date("2026-04-25T10:00:00.000Z")
    });

    assert.deepEqual(response, {
      type: "status_ack",
      jobId: "job-aps",
      status: "awaiting_user_verification"
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage returns queued jobs to polling extensions", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-host-"));
  try {
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "job-nature",
        recordedAt: "2026-04-25T10:00:00.000Z",
        status: "queued",
        articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
        source: "nature",
        autoClose: true
      }
    });

    const response = await handleExtensionHostMessage({
      workspaceDir,
      message: {
        type: "poll_jobs",
        extensionInstanceId: "chrome-main"
      }
    });

    assert.deepEqual(response, {
      type: "jobs",
      jobs: [
        {
          jobId: "job-nature",
          articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
          source: "nature",
          autoClose: true
        }
      ]
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("handleExtensionHostMessage returns structured errors for non-PDF files", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-host-"));
  const textPath = path.join(workspaceDir, "Downloads", "not-pdf.txt");
  try {
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.dirname(textPath), { recursive: true })
    );
    await writeFile(textPath, "not a pdf", "utf8");

    const response = await handleExtensionHostMessage({
      workspaceDir,
      message: {
        type: "register_download",
        jobId: "job-2",
        articleUrl: "https://example.com/not-pdf",
        source: "external",
        downloadPath: textPath
      }
    });

    assert.deepEqual(response, {
      type: "error",
      jobId: "job-2",
      code: "not_pdf",
      message: "Downloaded file is not a valid PDF."
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
npm.cmd run build
```

Expected: TypeScript fails because `src/agent/paper-extension-host.ts` does not exist.

- [ ] **Step 3: Implement native host core**

Create `src/agent/paper-extension-host.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerManualPaperDownload } from "./paper-manager.js";
import {
  parseExtensionHostMessage,
  type ExtensionHostMessage,
  type ExtensionHostResponse
} from "./paper-extension-protocol.js";
import {
  appendPaperDownloadJobEvent,
  readPaperDownloadJobEvents,
  summarizePaperDownloadJobs
} from "./paper-download-jobs.js";

export function encodeNativeMessage(message: ExtensionHostResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function readNativeMessagesFromBuffer(buffer: Buffer): unknown[] {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const start = offset + 4;
    const end = start + length;
    if (end > buffer.length) {
      break;
    }
    messages.push(JSON.parse(buffer.subarray(start, end).toString("utf8")));
    offset = end;
  }
  return messages;
}

function toErrorResponse(input: {
  jobId?: string;
  code: string;
  message: string;
}): ExtensionHostResponse {
  return {
    type: "error",
    ...(input.jobId ? { jobId: input.jobId } : {}),
    code: input.code,
    message: input.message
  };
}

export async function handleExtensionHostMessage(input: {
  workspaceDir: string;
  message: ExtensionHostMessage;
  now?: () => Date;
}): Promise<ExtensionHostResponse> {
  if (input.message.type === "poll_jobs") {
    const summary = summarizePaperDownloadJobs(
      await readPaperDownloadJobEvents({ workspaceDir: input.workspaceDir })
    );
    return {
      type: "jobs",
      jobs: Object.values(summary)
        .filter((event) => event.status === "queued")
        .flatMap((event) => {
          if (event.source === undefined) {
            return [];
          }
          return [
            {
              jobId: event.jobId,
              articleUrl: event.articleUrl,
              source: event.source,
              ...(event.title ? { title: event.title } : {}),
              ...(event.autoClose === undefined ? {} : { autoClose: event.autoClose })
            }
          ];
        })
    };
  }

  if (input.message.type === "job_status") {
    await appendPaperDownloadJobEvent({
      workspaceDir: input.workspaceDir,
      event: {
        jobId: input.message.jobId,
        recordedAt: (input.now ?? (() => new Date()))().toISOString(),
        status: input.message.status,
        articleUrl: input.message.articleUrl,
        ...(input.message.source ? { source: input.message.source } : {}),
        ...(input.message.message ? { message: input.message.message } : {})
      }
    });
    return {
      type: "status_ack",
      jobId: input.message.jobId,
      status: input.message.status
    };
  }

  try {
    const result = await registerManualPaperDownload({
      workspaceDir: input.workspaceDir,
      url: input.message.articleUrl,
      pdfPath: input.message.downloadPath,
      ...(input.message.title ? { title: input.message.title } : {}),
      now: input.now
    });
    await appendPaperDownloadJobEvent({
      workspaceDir: input.workspaceDir,
      event: {
        jobId: input.message.jobId,
        recordedAt: (input.now ?? (() => new Date()))().toISOString(),
        status: "downloaded",
        articleUrl: result.articleUrl,
        source: result.source,
        downloadPath: result.path,
        recordPath: result.recordPath,
        fileSha256: result.fileSha256,
        ...(result.title ? { title: result.title } : {})
      }
    });
    return {
      type: "registered",
      jobId: input.message.jobId,
      articleUrl: result.articleUrl,
      downloadPath: result.path,
      recordPath: result.recordPath,
      fileSha256: result.fileSha256,
      ...(result.title ? { title: result.title } : {})
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to register downloaded PDF.";
    return toErrorResponse({
      jobId: input.message.jobId,
      code: /valid PDF/i.test(message) ? "not_pdf" : "registration_failed",
      message
    });
  }
}

export async function runPaperExtensionNativeHost(input: {
  workspaceDir: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}): Promise<void> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input.stdin) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      const frameLength = 4 + length;
      if (buffer.length < frameLength) {
        break;
      }

      const rawPayload = buffer.subarray(4, frameLength).toString("utf8");
      buffer = buffer.subarray(frameLength);
      let response: ExtensionHostResponse;
      try {
        response = await handleExtensionHostMessage({
          workspaceDir: input.workspaceDir,
          message: parseExtensionHostMessage(JSON.parse(rawPayload))
        });
      } catch (error) {
        response = toErrorResponse({
          code: "invalid_message",
          message: error instanceof Error ? error.message : "Invalid native message."
        });
      }
      input.stdout.write(encodeNativeMessage(response));
    }
  }
}

export async function writeNativeHostManifest(input: {
  manifestPath: string;
  hostPath: string;
  extensionId: string;
}): Promise<void> {
  await mkdir(path.dirname(input.manifestPath), { recursive: true });
  await writeFile(
    input.manifestPath,
    `${JSON.stringify(
      {
        name: "com.pi_agent.paper_downloader",
        description: "Pi Agent paper downloader native host",
        path: input.hostPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${input.extensionId}/`]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}
```

Create `src/paper-extension-host.ts`:

```ts
import path from "node:path";
import { runPaperExtensionNativeHost } from "./agent/paper-extension-host.js";

const workspaceDir = process.env.PI_PAPER_WORKSPACE
  ? path.resolve(process.env.PI_PAPER_WORKSPACE)
  : process.cwd();

await runPaperExtensionNativeHost({
  workspaceDir,
  stdin: process.stdin,
  stdout: process.stdout
});
```

Modify `src/index.ts`:

```ts
export * from "./agent/paper-extension-host.js";
```

Modify `package.json` scripts:

```json
{
  "paper-extension-host": "node dist/src/paper-extension-host.js"
}
```

- [ ] **Step 4: Run native host tests to verify GREEN**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/paper-extension-host.test.js
```

Expected: build succeeds and native host tests pass.

- [ ] **Step 5: Commit Task 3**

Run:

```powershell
git add src/agent/paper-extension-host.ts src/paper-extension-host.ts src/index.ts package.json test/agent/paper-extension-host.test.ts
git commit -m "Add paper extension native host"
```

## Task 4: Extension Shell and Static Helper Tests

**Files:**
- Create: `extension/paper-downloader/manifest.json`
- Create: `extension/paper-downloader/background.js`
- Create: `extension/paper-downloader/content/common.js`
- Create: `extension/paper-downloader/content/nature.js`
- Create: `extension/paper-downloader/content/science.js`
- Create: `extension/paper-downloader/content/aps.js`
- Create: `extension/paper-downloader/content/runner.js`
- Create: `extension/paper-downloader/popup.html`
- Create: `extension/paper-downloader/popup.js`
- Create: `test/extension/paper-downloader.test.mjs`

- [ ] **Step 1: Write failing extension helper tests**

Create `test/extension/paper-downloader.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

await import("../../extension/paper-downloader/content/common.js");
await import("../../extension/paper-downloader/content/nature.js");
await import("../../extension/paper-downloader/content/science.js");
await import("../../extension/paper-downloader/content/aps.js");

const { classifyPage, findPdfCandidate } = globalThis.PiAgentPaperCommon;
const { findNaturePdfCandidate } = globalThis.PiAgentPaperNature;
const { findSciencePdfCandidate } = globalThis.PiAgentPaperScience;
const { findApsPdfCandidate } = globalThis.PiAgentPaperAps;

function readAttribute(attributes, name) {
  const match = attributes.match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return match ? match[1] : null;
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, "").trim();
}

function doc(html) {
  const anchors = Array.from(html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)).map((match) => ({
    href: readAttribute(match[1], "href"),
    textContent: stripTags(match[2])
  }));

  return {
    querySelectorAll(selector) {
      if (selector !== "a[href]") {
        return [];
      }

      return anchors
        .filter((anchor) => anchor.href !== null)
        .map((anchor) => ({
          textContent: anchor.textContent,
          getAttribute(name) {
            return name === "href" ? anchor.href : null;
          }
        }));
    }
  };
}

test("classifyPage detects Cloudflare and login handoff pages", () => {
  assert.equal(
    classifyPage({
      url: "https://journals.aps.org/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page",
      title: "Just a moment...",
      text: "Checking if the site connection is secure"
    }).status,
    "awaiting_user_verification"
  );

  assert.equal(
    classifyPage({
      url: "https://www.nature.com/articles/s41586-019-1666-5",
      title: "Login",
      text: "Sign in through your institution"
    }).status,
    "awaiting_user_verification"
  );
});

test("findPdfCandidate extracts direct PDF links", () => {
  const document = doc('<a href="/paper.pdf">PDF</a>', "https://example.com/article");
  assert.equal(
    findPdfCandidate({ document, baseUrl: "https://example.com/article" }),
    "https://example.com/paper.pdf"
  );
});

test("publisher helpers extract Nature, Science, and APS PDF candidates", () => {
  assert.equal(
    findNaturePdfCandidate({
      document: doc('<a data-track-action="download pdf" href="/articles/s41586-019-1666-5.pdf">PDF</a>'),
      baseUrl: "https://www.nature.com/articles/s41586-019-1666-5"
    }),
    "https://www.nature.com/articles/s41586-019-1666-5.pdf"
  );

  assert.equal(
    findSciencePdfCandidate({
      document: doc('<a href="/doi/pdf/10.1126/science.adz8659">PDF</a>'),
      baseUrl: "https://www.science.org/doi/10.1126/science.adz8659"
    }),
    "https://www.science.org/doi/pdf/10.1126/science.adz8659"
  );

  assert.equal(
    findApsPdfCandidate({
      document: doc("<main>No PDF link</main>"),
      baseUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601"
    }),
    "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.134.090601"
  );
});
```

- [ ] **Step 2: Run the extension helper tests to verify RED**

Run:

```powershell
node --test test/extension/paper-downloader.test.mjs
```

Expected: Node fails because extension helper files do not exist.

- [ ] **Step 3: Add extension manifest and content helpers**

Create `extension/paper-downloader/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Pi Agent Paper Downloader",
  "version": "0.1.0",
  "description": "Downloads and registers papers for Pi Agent using the user's browser profile.",
  "permissions": ["activeTab", "alarms", "downloads", "nativeMessaging", "storage", "tabs"],
  "host_permissions": [
    "https://arxiv.org/*",
    "https://www.nature.com/*",
    "https://nature.com/*",
    "https://www.science.org/*",
    "https://science.org/*",
    "https://journals.aps.org/*",
    "https://aps.org/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_title": "Pi Agent Papers",
    "default_popup": "popup.html"
  },
  "content_scripts": [
    {
      "matches": [
        "https://www.nature.com/*",
        "https://nature.com/*",
        "https://www.science.org/*",
        "https://science.org/*",
        "https://journals.aps.org/*",
        "https://aps.org/*"
      ],
      "js": [
        "content/common.js",
        "content/nature.js",
        "content/science.js",
        "content/aps.js",
        "content/runner.js"
      ],
      "run_at": "document_idle"
    }
  ]
}
```

Create `extension/paper-downloader/content/common.js`:

```js
(function installPiAgentPaperCommon(root) {
  function classifyPage(input) {
    const haystack = `${input.url}\n${input.title}\n${input.text}`.toLowerCase();
    if (
      haystack.includes("cdn-cgi/challenge") ||
      haystack.includes("checking if the site connection is secure") ||
      haystack.includes("cloudflare") ||
      haystack.includes("sign in through your institution") ||
      haystack.includes("log in through your institution")
    ) {
      return {
        status: "awaiting_user_verification",
        message: "The page requires user login or verification."
      };
    }

    return {
      status: "page_classified"
    };
  }

  function findPdfCandidate(input) {
    const anchors = Array.from(input.document.querySelectorAll("a[href]"));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      const text = (anchor.textContent || "").toLowerCase();
      if (/\.pdf(?:[?#].*)?$/i.test(href) || text.trim() === "pdf" || text.includes("download pdf")) {
        return new URL(href, input.baseUrl).toString();
      }
    }
    return null;
  }

  root.PiAgentPaperCommon = {
    classifyPage,
    findPdfCandidate
  };
})(globalThis);
```

Create `extension/paper-downloader/content/nature.js`:

```js
(function installPiAgentPaperNature(root) {
  function findNaturePdfCandidate(input) {
    return root.PiAgentPaperCommon.findPdfCandidate(input);
  }

  root.PiAgentPaperNature = {
    findNaturePdfCandidate
  };
})(globalThis);
```

Create `extension/paper-downloader/content/science.js`:

```js
(function installPiAgentPaperScience(root) {
  function findSciencePdfCandidate(input) {
    return root.PiAgentPaperCommon.findPdfCandidate(input);
  }

  root.PiAgentPaperScience = {
    findSciencePdfCandidate
  };
})(globalThis);
```

Create `extension/paper-downloader/content/aps.js`:

```js
(function installPiAgentPaperAps(root) {
  function findApsPdfCandidate(input) {
    const direct = root.PiAgentPaperCommon.findPdfCandidate(input);
    if (direct) {
      return direct;
    }

    const url = new URL(input.baseUrl);
    const match = url.pathname.match(/^\/([^/]+)\/abstract\/(.+)$/i);
    if (!match) {
      return null;
    }
    return new URL(`/${match[1]}/pdf/${match[2]}`, url.origin).toString();
  }

  root.PiAgentPaperAps = {
    findApsPdfCandidate
  };
})(globalThis);
```

Create `extension/paper-downloader/content/runner.js`:

```js
(function runPiAgentPaperContent(root) {
  const page = {
    url: root.location.href,
    title: root.document.title,
    text: root.document.body?.innerText || ""
  };
  const classification = root.PiAgentPaperCommon.classifyPage(page);
  let pdfUrl = null;

  if (classification.status !== "awaiting_user_verification") {
    if (root.location.hostname.includes("nature.com")) {
      pdfUrl = root.PiAgentPaperNature.findNaturePdfCandidate({
        document: root.document,
        baseUrl: root.location.href
      });
    } else if (root.location.hostname.includes("science.org")) {
      pdfUrl = root.PiAgentPaperScience.findSciencePdfCandidate({
        document: root.document,
        baseUrl: root.location.href
      });
    } else if (root.location.hostname.includes("aps.org")) {
      pdfUrl = root.PiAgentPaperAps.findApsPdfCandidate({
        document: root.document,
        baseUrl: root.location.href
      });
    } else {
      pdfUrl = root.PiAgentPaperCommon.findPdfCandidate({
        document: root.document,
        baseUrl: root.location.href
      });
    }
  }

  chrome.runtime.sendMessage({
    type: "paper_page_classified",
    status: classification.status,
    message: classification.message,
    pdfUrl
  });
})(globalThis);
```

Create `extension/paper-downloader/background.js`:

```js
const nativeHostName = "com.pi_agent.paper_downloader";
const jobs = new Map();
const attemptedAutomaticDownloads = new Set();

function connectNativeHost() {
  return chrome.runtime.connectNative(nativeHostName);
}

function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    const port = connectNativeHost();
    port.onMessage.addListener((response) => {
      resolve(response);
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      }
    });
    port.postMessage(message);
  });
}

async function openJobTab(job) {
  const tab = await chrome.tabs.create({ url: job.articleUrl, active: true });
  jobs.set(job.jobId, { ...job, tabId: tab.id, status: "opened_in_browser" });
  await sendNativeMessage({
    type: "job_status",
    jobId: job.jobId,
    status: "opened_in_browser",
    articleUrl: job.articleUrl,
    source: job.source
  });
  return tab;
}

async function pollQueuedJobs() {
  let response;
  try {
    response = await sendNativeMessage({
      type: "poll_jobs",
      extensionInstanceId: "chrome-main"
    });
  } catch {
    return;
  }

  if (response.type !== "jobs") {
    return;
  }

  for (const job of response.jobs) {
    if (!jobs.has(job.jobId)) {
      await openJobTab(job);
    }
  }
}

function jobForTab(tabId) {
  return Array.from(jobs.values()).find((job) => job.tabId === tabId);
}

async function attemptAutomaticDownload(job, pdfUrl) {
  if (attemptedAutomaticDownloads.has(job.jobId)) {
    return;
  }
  attemptedAutomaticDownloads.add(job.jobId);

  await sendNativeMessage({
    type: "job_status",
    jobId: job.jobId,
    status: "automatic_download_started",
    articleUrl: job.articleUrl,
    source: job.source
  });

  try {
    chrome.downloads.download({ url: pdfUrl, saveAs: false }, async (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        await sendNativeMessage({
          type: "job_status",
          jobId: job.jobId,
          status: "awaiting_user_manual_download",
          articleUrl: job.articleUrl,
          source: job.source,
          message: chrome.runtime.lastError?.message || "Automatic download did not start."
        });
        return;
      }

      jobs.set(job.jobId, { ...job, downloadId, status: "automatic_download_started" });
    });
  } catch (error) {
    await sendNativeMessage({
      type: "job_status",
      jobId: job.jobId,
      status: "awaiting_user_manual_download",
      articleUrl: job.articleUrl,
      source: job.source,
      message: String(error?.message || error)
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "paper_page_classified") {
    return false;
  }

  const job = sender.tab?.id === undefined ? undefined : jobForTab(sender.tab.id);
  if (!job) {
    sendResponse({ ok: false, message: "No matching paper job for tab." });
    return false;
  }

  if (message.status === "awaiting_user_verification") {
    sendNativeMessage({
      type: "job_status",
      jobId: job.jobId,
      status: "awaiting_user_verification",
      articleUrl: job.articleUrl,
      source: job.source,
      message: message.message || "User verification is required."
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message || error) }));
    return true;
  }

  if (message.pdfUrl) {
    attemptAutomaticDownload(job, message.pdfUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message || error) }));
    return true;
  }

  sendNativeMessage({
    type: "job_status",
    jobId: job.jobId,
    status: "awaiting_user_manual_download",
    articleUrl: job.articleUrl,
    source: job.source,
    message: "No PDF candidate was found."
  })
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, message: String(error?.message || error) }));
  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || delta.state.current !== "complete") {
    return;
  }

  chrome.downloads.search({ id: delta.id }, (items) => {
    const item = items[0];
    if (!item?.filename) {
      return;
    }

    const matchingJob = Array.from(jobs.values()).find((job) =>
      job.downloadId === delta.id ||
      item.finalUrl?.startsWith(job.articleUrl) ||
      item.url?.startsWith(job.articleUrl) ||
      item.referrer?.startsWith(job.articleUrl)
    );
    if (!matchingJob) {
      return;
    }

    const port = connectNativeHost();
    port.postMessage({
      type: "register_download",
      jobId: matchingJob.jobId,
      articleUrl: matchingJob.articleUrl,
      source: matchingJob.source || "external",
      downloadPath: item.filename,
      title: matchingJob.title
    });
    port.onMessage.addListener((response) => {
      if (response.type === "registered" && matchingJob.autoClose !== false && matchingJob.tabId) {
        chrome.tabs.remove(matchingJob.tabId);
      }
    });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("poll-paper-jobs", { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("poll-paper-jobs", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll-paper-jobs") {
    pollQueuedJobs();
  }
});

pollQueuedJobs();
```

Create `extension/paper-downloader/popup.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Pi Agent Papers</title>
  </head>
  <body>
    <main>
      <h1>Paper Downloads</h1>
      <pre id="status">No active jobs.</pre>
    </main>
    <script src="popup.js"></script>
  </body>
</html>
```

Create `extension/paper-downloader/popup.js`:

```js
document.getElementById("status").textContent = "Open paper jobs are tracked in the background worker.";
```

- [ ] **Step 4: Run extension helper tests to verify GREEN**

Run:

```powershell
node --test test/extension/paper-downloader.test.mjs
```

Expected: extension helper tests pass.

- [ ] **Step 5: Commit Task 4**

Run:

```powershell
git add extension/paper-downloader test/extension/paper-downloader.test.mjs
git commit -m "Add paper downloader extension shell"
```

## Task 5: Agent Extension Bridge Routing

**Files:**
- Create: `src/agent/paper-extension-bridge.ts`
- Create: `test/agent/paper-manager-extension.test.ts`
- Modify: `src/agent/paper-manager.ts`
- Modify: `src/agent/paper-types.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing extension bridge routing tests**

Create `test/agent/paper-manager-extension.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { downloadPaper } from "../../src/agent/paper-manager.js";
import { createQueuedPaperExtensionBridge } from "../../src/agent/paper-extension-bridge.js";
import { readPaperDownloadJobEvents } from "../../src/agent/paper-download-jobs.js";

test("downloadPaper routes supported publisher URLs to the extension bridge when available", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-extension-route-"));
  const calls: Array<{ articleUrl: string; source: string }> = [];
  try {
    const result = await downloadPaper({
      workspaceDir,
      url: "https://www.nature.com/articles/s41586-019-1666-5",
      extensionBridge: {
        async submitJob(job) {
          calls.push({ articleUrl: job.articleUrl, source: job.source });
          return {
            status: "opened_in_user_browser",
            source: job.source,
            articleUrl: job.articleUrl,
            jobId: job.jobId,
            message: "Opened in Chrome extension."
          };
        }
      }
    });

    assert.deepEqual(calls, [
      {
        articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
        source: "nature"
      }
    ]);
    assert.equal(result.status, "opened_in_user_browser");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper returns extension_unavailable instead of launching Playwright by default", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-extension-route-"));
  try {
    const result = await downloadPaper({
      workspaceDir,
      url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
      extensionBridge: {
        async submitJob(): Promise<never> {
          throw Object.assign(new Error("Extension bridge is not available."), {
            code: "extension_unavailable"
          });
        }
      }
    });

    assert.deepEqual(result, {
      status: "extension_unavailable",
      source: "aps",
      articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
      failure: {
        code: "extension_unavailable",
        message: "Extension bridge is not available."
      }
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("queued extension bridge appends jobs for native-host polling", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-extension-route-"));
  try {
    const bridge = createQueuedPaperExtensionBridge({
      workspaceDir,
      now: () => new Date("2026-04-25T10:00:00.000Z")
    });
    const result = await bridge.submitJob({
      jobId: "job-science",
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      source: "science",
      autoClose: true
    });

    assert.equal(result.status, "extension_job_queued");
    assert.deepEqual(await readPaperDownloadJobEvents({ workspaceDir }), [
      {
        jobId: "job-science",
        recordedAt: "2026-04-25T10:00:00.000Z",
        status: "queued",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        source: "science",
        autoClose: true
      }
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
npm.cmd run build
```

Expected: TypeScript fails because `DownloadPaperOptions` has no `extensionBridge` property and result types do not include extension statuses.

- [ ] **Step 3: Implement bridge types and paper-manager routing**

Create `src/agent/paper-extension-bridge.ts`:

```ts
import { createHash } from "node:crypto";
import type { PaperSource } from "./paper-types.js";
import { appendPaperDownloadJobEvent } from "./paper-download-jobs.js";

export interface ExtensionPaperJob {
  jobId: string;
  articleUrl: string;
  source: PaperSource;
  title?: string;
  autoClose?: boolean;
}

export type ExtensionBridgeSubmitResult =
  | {
      status: "extension_job_queued" | "opened_in_user_browser" | "awaiting_user_verification" | "awaiting_user_manual_download";
      source: PaperSource;
      articleUrl: string;
      jobId: string;
      message: string;
    }
  | {
      status: "downloaded";
      source: PaperSource;
      articleUrl: string;
      path: string;
      recordPath: string;
      fileSha256?: string;
    };

export interface PaperExtensionBridge {
  submitJob(job: ExtensionPaperJob): Promise<ExtensionBridgeSubmitResult>;
}

export function createPaperExtensionJob(input: {
  articleUrl: string;
  source: PaperSource;
  title?: string;
  autoClose?: boolean;
}): ExtensionPaperJob {
  const hash = createHash("sha1").update(`${input.source}:${input.articleUrl}`).digest("hex").slice(0, 12);
  return {
    jobId: `paper-${input.source}-${hash}`,
    articleUrl: input.articleUrl,
    source: input.source,
    ...(input.title ? { title: input.title } : {}),
    ...(input.autoClose === undefined ? {} : { autoClose: input.autoClose })
  };
}

export function createQueuedPaperExtensionBridge(input: {
  workspaceDir: string;
  now?: () => Date;
}): PaperExtensionBridge {
  return {
    async submitJob(job) {
      await appendPaperDownloadJobEvent({
        workspaceDir: input.workspaceDir,
        event: {
          jobId: job.jobId,
          recordedAt: (input.now ?? (() => new Date()))().toISOString(),
          status: "queued",
          articleUrl: job.articleUrl,
          source: job.source,
          ...(job.title ? { title: job.title } : {}),
          ...(job.autoClose === undefined ? {} : { autoClose: job.autoClose })
        }
      });
      return {
        status: "extension_job_queued",
        source: job.source,
        articleUrl: job.articleUrl,
        jobId: job.jobId,
        message: "Queued for the browser extension. The extension polls the native host and will open the page from the user's browser profile."
      };
    }
  };
}
```

Modify `src/agent/paper-types.ts`:

```ts
export interface ExtensionUnavailablePaperResult {
  status: "extension_unavailable";
  source: PaperSource;
  articleUrl: string;
  failure: PaperFailure;
}

export interface ExtensionPaperJobResult {
  status:
    | "extension_job_queued"
    | "opened_in_user_browser"
    | "awaiting_user_verification"
    | "awaiting_user_manual_download";
  source: PaperSource;
  articleUrl: string;
  jobId: string;
  message: string;
}
```

Add both result types to `PaperDownloadResult`.

Modify `src/agent/paper-manager.ts`:

```ts
import { createPaperExtensionJob, type PaperExtensionBridge } from "./paper-extension-bridge.js";

export interface DownloadPaperOptions {
  workspaceDir: string;
  id?: string;
  url?: string;
  forceManualOpen?: PaperFailure;
  fetchImpl?: typeof fetch;
  browserSessionFactory?: () => Promise<PaperBrowserSession>;
  downloadPublisherPaperImpl?: DownloadPublisherPaperImplementation;
  openPublisherForLoginImpl?: OpenPublisherForLoginImplementation;
  openPageInSystemChromeImpl?: typeof openPageInSystemChrome;
  extensionBridge?: PaperExtensionBridge;
  usePlaywrightFallback?: boolean;
}

async function submitExtensionJob(input: {
  bridge: PaperExtensionBridge;
  source: PaperSource;
  articleUrl: string;
}): Promise<PaperDownloadResult> {
  try {
    return await input.bridge.submitJob(
      createPaperExtensionJob({
        articleUrl: input.articleUrl,
        source: input.source,
        autoClose: true
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extension bridge is not available.";
    return {
      status: "extension_unavailable",
      source: input.source,
      articleUrl: input.articleUrl,
      failure: {
        code: "extension_unavailable",
        message
      }
    };
  }
}
```

In the external and supported-publisher branches, after index lookup and before Playwright setup, route through `extensionBridge` when present. If the bridge is absent and `usePlaywrightFallback !== true`, return `extension_unavailable`. If `usePlaywrightFallback === true`, keep existing Playwright behavior.

Modify `src/index.ts`:

```ts
export * from "./agent/paper-extension-bridge.js";
```

- [ ] **Step 4: Run routing tests to verify GREEN**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/paper-manager-extension.test.js
```

Expected: build succeeds and extension routing tests pass.

- [ ] **Step 5: Commit Task 5**

Run:

```powershell
git add src/agent/paper-extension-bridge.ts src/agent/paper-manager.ts src/agent/paper-types.ts src/index.ts test/agent/paper-manager-extension.test.ts
git commit -m "Route paper downloads through extension bridge"
```

## Task 6: Tool Integration and Fallback Controls

**Files:**
- Create: `test/agent/tools-extension.test.ts`
- Modify: `src/agent/tools.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing tool integration tests**

Create `test/agent/tools-extension.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createTools } from "../../src/agent/tools.js";

test("download_paper reports extension_unavailable when no extension bridge is configured", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tools-extension-"));
  try {
    const tools = createTools(workspace);
    const tool = tools.find((candidate) => candidate.name === "download_paper");
    assert.ok(tool?.execute);
    const result = await tool.execute(
      "tool-call-extension-missing",
      { url: "https://www.nature.com/articles/s41586-019-1666-5" },
      undefined
    );
    const details = result.details as { status?: string };
    assert.equal(details.status, "extension_unavailable");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_paper uses injected extension bridge for publisher URLs", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tools-extension-"));
  try {
    const tools = createTools(workspace, {
      extensionBridge: {
        async submitJob(job) {
          return {
            status: "opened_in_user_browser",
            source: job.source,
            articleUrl: job.articleUrl,
            jobId: job.jobId,
            message: "Opened in browser extension."
          };
        }
      }
    });
    const tool = tools.find((candidate) => candidate.name === "download_paper");
    assert.ok(tool?.execute);
    const result = await tool.execute(
      "tool-call-extension",
      { url: "https://www.nature.com/articles/s41586-019-1666-5" },
      undefined
    );
    const details = result.details as { status?: string };
    assert.equal(details.status, "opened_in_user_browser");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
npm.cmd run build
```

Expected: TypeScript fails because `ToolDependencies` does not include `extensionBridge`.

- [ ] **Step 3: Add tool dependency wiring**

Modify `src/agent/tools.ts`:

```ts
import type { PaperExtensionBridge } from "./paper-extension-bridge.js";

export interface ToolDependencies {
  searchWeb?: typeof searchWeb;
  fetchWebPage?: typeof fetchWebPage;
  searchPapers?: typeof searchPapers;
  searchApsPapers?: typeof searchApsPapers;
  downloadPaper?: typeof downloadPaper;
  downloadLatestApsPapers?: typeof downloadLatestApsPapers;
  registerManualPaperDownload?: typeof registerManualPaperDownload;
  openPaperPageForLogin?: OpenPaperPageForLoginDependency;
  browserSessionFactory?: ReturnType<typeof resolveDefaultPaperBrowserSessionFactory>;
  paperBrowserManagerClient?: PaperBrowserManagerClient;
  extensionBridge?: PaperExtensionBridge;
  usePlaywrightPaperFallback?: boolean;
}
```

When constructing `downloadPaperImpl`, pass:

```ts
extensionBridge: dependencies.extensionBridge,
usePlaywrightFallback: dependencies.usePlaywrightPaperFallback === true
```

Do not silently create a fake bridge. The default result for publisher/external URLs without an extension bridge should be `extension_unavailable`.

- [ ] **Step 4: Run tool integration tests to verify GREEN**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/tools-extension.test.js
```

Expected: build succeeds and tool extension tests pass.

- [ ] **Step 5: Commit Task 6**

Run:

```powershell
git add src/agent/tools.ts test/agent/tools-extension.test.ts
git commit -m "Wire paper extension bridge into tools"
```

## Task 7: Windows Native Host Registration

**Files:**
- Create: `scripts/register-paper-extension-host.ps1`
- Create: `test/agent/paper-extension-host-registration.test.ts`
- Modify: `src/agent/paper-extension-host.ts`
- Modify: `README.md`
- Modify: `docs/windows-powershell-codex-quickstart.md`

- [ ] **Step 1: Write failing manifest generation tests**

Create `test/agent/paper-extension-host-registration.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeNativeHostManifest } from "../../src/agent/paper-extension-host.js";

test("writeNativeHostManifest writes Chrome native messaging manifest", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "native-host-manifest-"));
  try {
    const manifestPath = path.join(workspace, "com.pi_agent.paper_downloader.json");
    const hostPath = path.join(workspace, "paper-extension-host.cmd");
    await writeNativeHostManifest({
      manifestPath,
      hostPath,
      extensionId: "abcdefghijklmnopabcdefghijklmnop"
    });

    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), {
      name: "com.pi_agent.paper_downloader",
      description: "Pi Agent paper downloader native host",
      path: hostPath,
      type: "stdio",
      allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/paper-extension-host-registration.test.js
```

Expected: test fails if `writeNativeHostManifest` is missing or does not match the required manifest shape.

- [ ] **Step 3: Add Windows registration script**

Create `scripts/register-paper-extension-host.ps1`:

```powershell
param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [string]$WorkspaceDir = (Resolve-Path ".").Path,
  [ValidateSet("Chrome", "Edge", "Both")]
  [string]$Browser = "Both"
)

$ErrorActionPreference = "Stop"

$repo = Resolve-Path $WorkspaceDir
$hostCmd = Join-Path $repo "scripts\paper-extension-host.cmd"
$manifestDir = Join-Path $repo ".browser-profile\native-messaging"
$manifestPath = Join-Path $manifestDir "com.pi_agent.paper_downloader.json"

New-Item -ItemType Directory -Force -Path (Split-Path $hostCmd) | Out-Null
@"
@echo off
set PI_PAPER_WORKSPACE=$repo
node "$repo\dist\src\paper-extension-host.js"
"@ | Set-Content -Path $hostCmd -Encoding ASCII

New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
@{
  name = "com.pi_agent.paper_downloader"
  description = "Pi Agent paper downloader native host"
  path = $hostCmd
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

if ($Browser -eq "Chrome" -or $Browser -eq "Both") {
  New-Item -ItemType Directory -Force -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pi_agent.paper_downloader" | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pi_agent.paper_downloader" -Name "(default)" -Value $manifestPath
}

if ($Browser -eq "Edge" -or $Browser -eq "Both") {
  New-Item -ItemType Directory -Force -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.pi_agent.paper_downloader" | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.pi_agent.paper_downloader" -Name "(default)" -Value $manifestPath
}

Write-Output "Registered com.pi_agent.paper_downloader at $manifestPath"
```

Modify README and Windows quickstart with:

```md
### Extension-first paper downloads

1. Run `npm.cmd run build`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer Mode.
4. Load unpacked extension from `extension/paper-downloader`.
5. Copy the extension id.
6. Run `powershell -ExecutionPolicy Bypass -File scripts/register-paper-extension-host.ps1 -ExtensionId <id>`.
7. Restart the browser.
```

- [ ] **Step 4: Run registration tests to verify GREEN**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/paper-extension-host-registration.test.js
```

Expected: build succeeds and registration manifest test passes.

- [ ] **Step 5: Commit Task 7**

Run:

```powershell
git add scripts/register-paper-extension-host.ps1 src/agent/paper-extension-host.ts README.md docs/windows-powershell-codex-quickstart.md test/agent/paper-extension-host-registration.test.ts
git commit -m "Add paper extension native host registration"
```

## Task 8: Full Verification and Live Manual Checks

**Files:**
- Modify: `README.md`
- Modify: `docs/windows-powershell-codex-quickstart.md`

- [ ] **Step 1: Run full automated verification**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Build extension/native host artifacts**

Run:

```powershell
npm.cmd run build
```

Expected: TypeScript build succeeds and `dist/src/paper-extension-host.js` exists.

- [ ] **Step 3: Manual Chrome extension install check**

Run through these exact browser steps:

```text
1. Open chrome://extensions.
2. Enable Developer Mode.
3. Load unpacked extension/paper-downloader.
4. Copy the extension id.
5. Run scripts/register-paper-extension-host.ps1 with that id.
6. Restart Chrome.
```

Expected: extension loads without manifest errors and native host registration script prints `Registered com.pi_agent.paper_downloader`.

- [ ] **Step 4: Live Nature check**

Use a Nature URL known to expose a PDF button, for example:

```text
https://www.nature.com/articles/s41586-019-1666-5
```

Expected:

- `download_paper` routes to the extension.
- Extension opens the page in the user's browser.
- Extension attempts one automatic PDF download.
- Native host writes a downloaded index record.
- Extension closes the tab only after host-confirmed indexing.
- Re-running `download_paper` returns `already_downloaded`.

- [ ] **Step 5: Live APS handoff check**

Use an APS URL that frequently triggers Cloudflare:

```text
https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601
```

Expected:

- Extension opens the tab and detects challenge/login state.
- Extension reports `awaiting_user_verification`.
- The page remains open.
- User can complete verification and manually download the PDF.
- Extension observes the completed download and native host indexes it.

- [ ] **Step 6: Commit final doc adjustments**

If live checks reveal setup wording gaps, update README and Windows quickstart with exact observed commands. Then run:

```powershell
git add README.md docs/windows-powershell-codex-quickstart.md
git commit -m "Document paper extension verification"
```

If docs do not change, skip this commit.

## Final Verification Checklist

- [ ] Protocol parser tests pass.
- [ ] Job store tests pass.
- [ ] Native host tests pass.
- [ ] Extension helper tests pass.
- [ ] Paper manager extension routing tests pass.
- [ ] Tool extension tests pass.
- [ ] Native host registration tests pass.
- [ ] `npm.cmd test` passes.
- [ ] Nature live check confirms automatic extension download and tab close.
- [ ] APS live check confirms verification handoff and manual download observation.
- [ ] Runtime `.browser-profile/` and `downloads/` artifacts remain untracked unless the user explicitly asks to preserve a sample artifact.
