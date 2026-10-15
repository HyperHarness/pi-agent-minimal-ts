import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  downloadPaperList,
  stagePaperDownloadList
} from "../../src/agent/paper/acquisition/paper-download-list.js";

test("downloadPaperList treats resolved failure statuses as failed and keeps candidates for retry", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-download-list-"));
  try {
    const staged = await stagePaperDownloadList({
      workspaceDir,
      candidates: [
        { id: "2401.01234", title: "First candidate" },
        { url: "https://example.com/paper-b", title: "Second candidate" }
      ],
      listPath: ".memory/paper-download-lists/retry.md"
    });

    const download = await downloadPaperList({
      workspaceDir,
      listPath: staged.listPath,
      downloadPaperImpl: async (options) => {
        if (options.id === "2401.01234") {
          return {
            status: "extension_unavailable",
            source: "external",
            articleUrl: "https://arxiv.org/abs/2401.01234",
            failure: {
              code: "extension_unavailable",
              message: "The browser extension bridge is unavailable."
            }
          };
        }
        // Fallback statuses resolve without a failure field.
        return {
          status: "external_opened",
          source: "external",
          articleUrl: "https://example.com/paper-b",
          openedUrl: "https://example.com/paper-b",
          recordPath: "knowledge-base/sources/external-9f86d081/acquisition.json"
        };
      }
    });

    assert.equal(download.totalCandidates, 2);
    assert.equal(download.attempted, 2);
    assert.equal(download.downloaded, 0);
    assert.equal(download.failed, 2);
    assert.equal(download.remainingCandidates, 2);
    assert.deepEqual(download.results.map((entry) => entry.status), ["failed", "failed"]);
    assert.match(download.results[0]?.message ?? "", /extension bridge is unavailable/i);
    assert.match(download.results[1]?.message ?? "", /external_opened/);

    const rewritten = await readFile(path.join(workspaceDir, staged.listPath), "utf8");
    assert.match(rewritten, /id: 2401\.01234/);
    assert.match(rewritten, /lastError: The browser extension bridge is unavailable\./);
    assert.match(rewritten, /url: "https:\/\/example\.com\/paper-b"/);
    assert.match(
      rewritten,
      /lastError: "download_paper returned status \\"external_opened\\" without a downloaded paper\."/
    );

    // The retained candidates stay retryable on the next run.
    const retry = await downloadPaperList({
      workspaceDir,
      listPath: staged.listPath,
      downloadPaperImpl: async () => ({
        status: "downloaded",
        source: "arxiv",
        canonicalId: "2401.01234",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        finalPdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
        path: "knowledge-base/raw/pdfs/arxiv-2401.01234.pdf",
        recordPath: "knowledge-base/sources/arxiv-2401.01234/acquisition.json"
      })
    });
    assert.equal(retry.downloaded, 2);
    assert.equal(retry.failed, 0);
    assert.equal(retry.remainingCandidates, 0);
    const finalList = await readFile(path.join(workspaceDir, staged.listPath), "utf8");
    assert.doesNotMatch(finalList, /^-\s/m);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaperList removes candidates only when download_paper reports downloaded or already_downloaded", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-download-list-"));
  try {
    const staged = await stagePaperDownloadList({
      workspaceDir,
      candidates: [
        { id: "2401.01234", title: "Downloaded now" },
        { id: "2401.01235", title: "Already local" },
        { id: "2401.01236", title: "Blocked by user" }
      ],
      listPath: ".memory/paper-download-lists/success.md"
    });

    const download = await downloadPaperList({
      workspaceDir,
      listPath: staged.listPath,
      downloadPaperImpl: async (options) => {
        if (options.id === "2401.01234") {
          return { status: "downloaded" };
        }
        if (options.id === "2401.01235") {
          return { status: "already_downloaded" };
        }
        return {
          status: "blocked",
          source: "arxiv",
          canonicalId: "2401.01236",
          failure: { code: "blocked", message: "Candidate is on the download blocklist." }
        };
      }
    });

    assert.equal(download.downloaded, 2);
    assert.equal(download.failed, 1);
    assert.equal(download.remainingCandidates, 1);
    assert.deepEqual(
      download.results.map((entry) => entry.status),
      ["downloaded", "already_downloaded", "failed"]
    );

    const rewritten = await readFile(path.join(workspaceDir, staged.listPath), "utf8");
    assert.doesNotMatch(rewritten, /2401\.01234/);
    assert.doesNotMatch(rewritten, /2401\.01235/);
    assert.match(rewritten, /id: 2401\.01236/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaperList still records thrown download_paper errors as failures", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-download-list-"));
  try {
    const staged = await stagePaperDownloadList({
      workspaceDir,
      candidates: [{ id: "2401.01234", title: "Thrown failure" }],
      listPath: ".memory/paper-download-lists/thrown.md"
    });

    const download = await downloadPaperList({
      workspaceDir,
      listPath: staged.listPath,
      downloadPaperImpl: async () => {
        throw new Error("network unreachable");
      }
    });

    assert.equal(download.attempted, 1);
    assert.equal(download.downloaded, 0);
    assert.equal(download.failed, 1);
    assert.equal(download.remainingCandidates, 1);
    assert.equal(download.results[0]?.status, "failed");
    assert.equal(download.results[0]?.message, "network unreachable");

    const rewritten = await readFile(path.join(workspaceDir, staged.listPath), "utf8");
    assert.match(rewritten, /id: 2401\.01234/);
    assert.match(rewritten, /lastError: network unreachable/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("download list round-trips values containing semicolons and quotes", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-download-list-"));
  try {
    const staged = await stagePaperDownloadList({
      workspaceDir,
      candidates: [
        {
          id: "2401.01234",
          title: "Qubits; a review",
          note: "see section 3; page 12",
          lastError: "Candidate lacks id or url; search_papers or add a stable locator before retrying."
        },
        {
          url: "https://example.com/\"quoted\";v=2",
          title: "Escaped \\ backslash"
        }
      ],
      listPath: ".memory/paper-download-lists/round-trip.md"
    });

    const serialized = await readFile(path.join(workspaceDir, staged.listPath), "utf8");
    assert.match(serialized, /title: "Qubits; a review"/);
    assert.match(serialized, /note: "see section 3; page 12"/);
    assert.match(
      serialized,
      /lastError: "Candidate lacks id or url; search_papers or add a stable locator before retrying\."/
    );

    const download = await downloadPaperList({
      workspaceDir,
      listPath: staged.listPath,
      dryRun: true,
      downloadPaperImpl: async () => {
        throw new Error("download_paper must not run during a dry run.");
      }
    });

    assert.equal(download.results.length, 2);
    assert.deepEqual(download.results.map((entry) => entry.status), ["dry_run", "dry_run"]);
    assert.deepEqual(download.results.map((entry) => entry.candidate), [
      {
        id: "2401.01234",
        title: "Qubits; a review",
        note: "see section 3; page 12",
        lastError: "Candidate lacks id or url; search_papers or add a stable locator before retrying."
      },
      {
        url: "https://example.com/\"quoted\";v=2",
        title: "Escaped \\ backslash"
      }
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("download list parsing keeps mid-value apostrophes literal and still splits unquoted fields", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-download-list-"));
  try {
    const listPath = ".memory/paper-download-lists/legacy.md";
    await mkdir(path.dirname(path.join(workspaceDir, listPath)), { recursive: true });
    await writeFile(
      path.join(workspaceDir, listPath),
      [
        "# Temporary Paper Download List",
        "",
        "- title: Shor's algorithm notes; url: https://example.com/shor; id: 2401.01234",
        ""
      ].join("\n"),
      "utf8"
    );

    const download = await downloadPaperList({
      workspaceDir,
      listPath,
      dryRun: true,
      downloadPaperImpl: async () => {
        throw new Error("download_paper must not run during a dry run.");
      }
    });

    assert.equal(download.results.length, 1);
    assert.deepEqual(download.results[0]?.candidate, {
      id: "2401.01234",
      url: "https://example.com/shor",
      title: "Shor's algorithm notes"
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
