import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadPaper, searchPapers } from "../../src/agent/paper-manager.js";
import type { ArxivSearchResult } from "../../src/agent/arxiv.js";
import { PaperDownloadError } from "../../src/agent/paper-download.js";
import { resolvePaperPdfPath, resolvePaperRecordPath } from "../../src/agent/paper-store.js";
import type { WebSearchResult } from "../../src/agent/web-search.js";
import type { PaperSearchResult, PaperSearchSource } from "../../src/agent/paper-types.js";

type SearchArxivCall = {
  query: string;
  maxResults?: number;
};

type SearchWebCall = {
  query: string;
  maxResults?: number;
};

function createArxivResult(overrides: Partial<ArxivSearchResult> = {}): ArxivSearchResult {
  return {
    id: "2401.01234",
    title: "Unified Paper Search",
    authors: ["Ada Lovelace"],
    summary: "arXiv summary",
    absUrl: "https://arxiv.org/abs/2401.01234",
    pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
    ...overrides
  };
}

function createWebResult(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return {
    title: "Unified Paper Search",
    url: "https://example.com/paper",
    snippet: "web summary",
    ...overrides
  };
}

test("searchPapers merges duplicate titles and prefers supported publisher sources", async () => {
  const arxivCalls: SearchArxivCall[] = [];
  const webCalls: SearchWebCall[] = [];

  const results = await searchPapers({
    query: "unified paper search",
    maxResults: 2,
    searchArxivImpl: async (options) => {
      arxivCalls.push({ query: options.query, maxResults: options.maxResults });
      return [
        createArxivResult({
          title: "Unified Paper Search",
          summary: "arXiv summary"
        })
      ];
    },
    searchWebImpl: async (options) => {
      webCalls.push({ query: options.query, maxResults: options.maxResults });
      return [
        createWebResult({
          title: " Unified  Paper Search ",
          url: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
          snippet: "science summary"
        }),
        createWebResult({
          title: "unified paper search",
          url: "https://example.org/blog/post",
          snippet: "external summary"
        })
      ];
    }
  });

  assert.deepEqual(arxivCalls, [{ query: "unified paper search", maxResults: 2 }]);
  assert.deepEqual(webCalls, [{ query: "unified paper search", maxResults: 2 }]);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    title: "Unified Paper Search",
    authors: ["Ada Lovelace"],
    summary: "science summary",
    primarySource: "science",
    primaryAction: "authorized_download",
    sources: [
        {
          source: "science",
          canonicalId: "10.1126/science.adz8659",
          articleUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
          action: "authorized_download"
        },
      {
        source: "arxiv",
        canonicalId: "2401.01234",
        articleUrl: "https://arxiv.org/abs/2401.01234",
        pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
        action: "direct_download"
      },
      {
        source: "external",
        articleUrl: "https://example.org/blog/post",
        action: "open_url_only"
      }
    ] satisfies PaperSearchSource[]
  } satisfies PaperSearchResult);
});

test("searchPapers maps unsupported hosts to external open_url_only results", async () => {
  const results = await searchPapers({
    query: "unsupported host paper",
    searchArxivImpl: async () => [],
    searchWebImpl: async () => [
      createWebResult({
        title: "Unsupported Host Paper",
        url: "https://example.org/paper",
        snippet: "external summary"
      })
    ]
  });

  assert.deepEqual(results, [
    {
      title: "Unsupported Host Paper",
      authors: [],
      summary: "external summary",
      primarySource: "external",
      primaryAction: "open_url_only",
      sources: [
        {
          source: "external",
          articleUrl: "https://example.org/paper",
          action: "open_url_only"
        }
      ]
    } satisfies PaperSearchResult
  ]);
});

test("searchPapers keeps supported hosts classified by hostname even when the path shape is unknown", async () => {
  const results = await searchPapers({
    query: "hostname classified paper",
    searchArxivImpl: async () => [],
    searchWebImpl: async () => [
      createWebResult({
        title: "Hostname Classified Paper",
        url: "https://www.nature.com/content/preview",
        snippet: "nature summary"
      })
    ]
  });

  assert.deepEqual(results, [
    {
      title: "Hostname Classified Paper",
      authors: [],
      summary: "nature summary",
      primarySource: "nature",
      primaryAction: "authorized_download",
      sources: [
        {
          source: "nature",
          articleUrl: "https://www.nature.com/content/preview",
          action: "authorized_download"
        }
      ]
    } satisfies PaperSearchResult
  ]);
});

test("searchPapers treats unsupported www.aps.org hosts as external results", async () => {
  const results = await searchPapers({
    query: "aps host parity",
    searchArxivImpl: async () => [],
    searchWebImpl: async () => [
      createWebResult({
        title: "APS Host Parity",
        url: "https://www.aps.org/doi/10.1103/PhysRevLett.133.123456",
        snippet: "aps summary"
      })
    ]
  });

  assert.deepEqual(results, [
    {
      title: "APS Host Parity",
      authors: [],
      summary: "aps summary",
      primarySource: "external",
      primaryAction: "open_url_only",
      sources: [
        {
          source: "external",
          articleUrl: "https://www.aps.org/doi/10.1103/PhysRevLett.133.123456",
          action: "open_url_only"
        }
      ]
    } satisfies PaperSearchResult
  ]);
});

test("searchPapers reorders merged candidates when a higher-priority source appears later", async () => {
  const results = await searchPapers({
    query: "ordering",
    maxResults: 1,
    searchArxivImpl: async () => [
      createArxivResult({
        id: "2401.00001",
        title: "Paper A",
        authors: ["Ada Lovelace"],
        summary: "arXiv summary A",
        absUrl: "https://arxiv.org/abs/2401.00001",
        pdfUrl: "https://arxiv.org/pdf/2401.00001.pdf"
      })
    ],
    searchWebImpl: async () => [
      createWebResult({
        title: "Paper B",
        url: "https://www.science.org/doi/10.1126/science.paper-b",
        snippet: "science summary B"
      }),
      createWebResult({
        title: "Paper A",
        url: "https://www.science.org/doi/10.1126/science.paper-a",
        snippet: "science summary A"
      })
    ]
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Paper B");
  assert.equal(results[0].primarySource, "science");
});

test("downloadPaper downloads arXiv ids, writes the PDF file, and returns downloaded status", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const pdfBytes = Buffer.from("%PDF-1.4\nmock pdf\n", "utf8");

  try {
    const result = await downloadPaper({
      workspaceDir,
      id: "2401.01234",
      fetchImpl: async () =>
        new Response(pdfBytes, {
          status: 200,
          headers: {
            "content-type": "application/pdf"
          }
        })
    });

    const expectedPdfPath = resolvePaperPdfPath({
      workspaceDir,
      source: "arxiv",
      canonicalId: "2401.01234"
    });
    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "arxiv",
      canonicalId: "2401.01234",
      articleUrl: "https://arxiv.org/abs/2401.01234"
    });

    assert.equal(result.status, "downloaded");
    assert.equal(result.source, "arxiv");
    assert.equal(result.canonicalId, "2401.01234");
    assert.equal(result.articleUrl, "https://arxiv.org/abs/2401.01234");
    assert.equal(result.path, expectedPdfPath);
    assert.equal(result.recordPath, expectedRecordPath);
    assert.equal(await readFile(expectedPdfPath, "utf8"), pdfBytes.toString("utf8"));

    assert.deepEqual(JSON.parse(await readFile(expectedRecordPath, "utf8")), {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.01234",
      recordedAt: JSON.parse(await readFile(expectedRecordPath, "utf8")).recordedAt,
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.01234",
      pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
      downloadPath: expectedPdfPath
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper preserves supported-publisher manual fallback results when automatic download fails", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      downloadPublisherPaperImpl: async () => {
        throw new PaperDownloadError(
          "authorization_failed",
          "Publisher requires institutional login."
        );
      },
      openPublisherForLoginImpl: async () => ({
        openedUrl: articleUrl,
        profileDir: path.join(workspaceDir, ".browser-profile", "paper-access"),
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      })
    });

    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl
    });
    const savedRecord = JSON.parse(await readFile(expectedRecordPath, "utf8"));

    assert.deepEqual(result, {
      status: "manual_fallback_opened",
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl,
      fallbackUrl: articleUrl,
      recordPath: expectedRecordPath,
      failure: {
        code: "authorization_failed",
        message: "Publisher requires institutional login."
      },
      profileDir: path.join(workspaceDir, ".browser-profile", "paper-access"),
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    });
    assert.deepEqual(savedRecord, {
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl,
      openedUrl: articleUrl,
      recordedAt: savedRecord.recordedAt,
      handlingMethod: "browser_session",
      status: "manual_fallback_opened",
      failure: {
        code: "authorization_failed",
        message: "Publisher requires institutional login."
      }
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper still opens supported hosts for manual fallback when canonical ids are unavailable", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://www.nature.com/content/preview";

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      downloadPublisherPaperImpl: async () => {
        throw new PaperDownloadError(
          "manual_login_required",
          "Nature requires manual sign-in."
        );
      },
      openPublisherForLoginImpl: async () => ({
        openedUrl: articleUrl,
        profileDir: path.join(workspaceDir, ".browser-profile", "paper-access")
      })
    });

    assert.equal(result.status, "manual_fallback_opened");
    assert.equal(result.source, "nature");
    assert.equal(result.articleUrl, articleUrl);
    assert.equal(result.fallbackUrl, articleUrl);
    assert.equal(result.failure.code, "manual_login_required");
    assert.equal(path.basename(result.recordPath).startsWith("nature-www.nature.com-"), true);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper opens unsupported external URLs instead of rejecting them", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://example.com/paper";

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      openPageInSystemChromeImpl: async () => ({
        url: articleUrl,
        openedUrl: articleUrl,
        profileDir: path.join(workspaceDir, ".browser-profile", "paper-access"),
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      })
    });

    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "external",
      articleUrl
    });
    const savedRecord = JSON.parse(await readFile(expectedRecordPath, "utf8"));

    assert.deepEqual(result, {
      status: "external_opened",
      source: "external",
      articleUrl,
      openedUrl: articleUrl,
      recordPath: expectedRecordPath,
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    });
    assert.deepEqual(savedRecord, {
      source: "external",
      articleUrl,
      openedUrl: articleUrl,
      recordedAt: savedRecord.recordedAt,
      handlingMethod: "system_browser_open",
      status: "external_opened"
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
