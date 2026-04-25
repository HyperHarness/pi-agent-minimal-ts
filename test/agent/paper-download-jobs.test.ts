import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendPaperDownloadJobEvent,
  readPaperDownloadJobEvents,
  resolvePaperDownloadJobsPath,
  summarizePaperDownloadJobs
} from "../../src/agent/paper-download-jobs.js";

async function createWorkspaceDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "paper-download-jobs-"));
}

test("resolvePaperDownloadJobsPath stores jobs under .browser-profile", async () => {
  const workspaceDir = await createWorkspaceDir();
  try {
    assert.equal(
      resolvePaperDownloadJobsPath({ workspaceDir }),
      path.join(workspaceDir, ".browser-profile", "paper-download-jobs.jsonl")
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("readPaperDownloadJobEvents rethrows non-missing file read errors", async () => {
  const workspaceDir = await createWorkspaceDir();
  try {
    const jobsPath = resolvePaperDownloadJobsPath({ workspaceDir });
    await mkdir(jobsPath, { recursive: true });

    await assert.rejects(
      readPaperDownloadJobEvents({ workspaceDir }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code !== "ENOENT"
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("appendPaperDownloadJobEvent appends JSONL events and reads statuses in order", async () => {
  const workspaceDir = await createWorkspaceDir();
  try {
    const jobsPath = await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "job-1",
        recordedAt: "2026-04-25T03:00:00.000Z",
        status: "queued",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        source: "arxiv",
        autoClose: true
      }
    });

    const secondPath = await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "job-1",
        recordedAt: "2026-04-25T03:01:00.000Z",
        status: "downloaded",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        downloadPath: "downloads/papers/paper.pdf",
        fileSha256: "abc123"
      }
    });

    assert.equal(secondPath, jobsPath);
    assert.equal(
      await readFile(jobsPath, "utf8"),
      [
        '{"jobId":"job-1","recordedAt":"2026-04-25T03:00:00.000Z","status":"queued","articleUrl":"https://arxiv.org/abs/2401.01234","source":"arxiv","autoClose":true}',
        '{"jobId":"job-1","recordedAt":"2026-04-25T03:01:00.000Z","status":"downloaded","articleUrl":"https://arxiv.org/abs/2401.01234","downloadPath":"downloads/papers/paper.pdf","fileSha256":"abc123"}',
        ""
      ].join("\n")
    );

    const events = await readPaperDownloadJobEvents({ workspaceDir });
    assert.deepEqual(
      events.map((event) => event.status),
      ["queued", "downloaded"]
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("summarizePaperDownloadJobs merges latest status while preserving prior metadata", () => {
  const summaries = summarizePaperDownloadJobs([
    {
      jobId: "job-1",
      recordedAt: "2026-04-25T03:00:00.000Z",
      status: "queued",
      articleUrl: "https://arxiv.org/abs/2401.01234",
      source: "arxiv",
      title: "Queued Paper",
      autoClose: true
    },
    {
      jobId: "job-1",
      recordedAt: "2026-04-25T03:01:00.000Z",
      status: "downloaded",
      articleUrl: "https://arxiv.org/abs/2401.01234",
      downloadPath: "downloads/papers/paper.pdf",
      fileSha256: "abc123"
    }
  ]);

  assert.deepEqual(summaries, [
    {
      jobId: "job-1",
      recordedAt: "2026-04-25T03:01:00.000Z",
      status: "downloaded",
      articleUrl: "https://arxiv.org/abs/2401.01234",
      source: "arxiv",
      title: "Queued Paper",
      autoClose: true,
      downloadPath: "downloads/papers/paper.pdf",
      fileSha256: "abc123"
    }
  ]);
});

test("readPaperDownloadJobEvents ignores malformed JSONL lines and invalid records", async () => {
  const workspaceDir = await createWorkspaceDir();
  try {
    const jobsPath = resolvePaperDownloadJobsPath({ workspaceDir });
    await mkdir(path.dirname(jobsPath), { recursive: true });
    await writeFile(
      jobsPath,
      [
        "",
        "not json",
        '{"jobId":"job-1","recordedAt":"2026-04-25T03:00:00.000Z","status":"queued","articleUrl":"https://example.com/paper"}',
        '{"jobId":"job-2","recordedAt":"2026-04-25T03:01:00.000Z","status":"complete","articleUrl":"https://example.com/paper"}',
        '{"jobId":"job-3","recordedAt":"2026-04-25T03:02:00.000Z","articleUrl":"https://example.com/paper"}'
      ].join("\n"),
      "utf8"
    );

    const events = await readPaperDownloadJobEvents({ workspaceDir });

    assert.deepEqual(events, [
      {
        jobId: "job-1",
        recordedAt: "2026-04-25T03:00:00.000Z",
        status: "queued",
        articleUrl: "https://example.com/paper"
      }
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("readPaperDownloadJobEvents returns an empty array for missing job files", async () => {
  const workspaceDir = await createWorkspaceDir();
  try {
    assert.deepEqual(await readPaperDownloadJobEvents({ workspaceDir }), []);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
