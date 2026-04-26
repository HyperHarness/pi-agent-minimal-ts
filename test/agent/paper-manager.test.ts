import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  downloadLatestApsPapers,
  downloadPaper,
  registerManualPaperDownload,
  searchPapers
} from "../../src/agent/paper-manager.js";
import type { ArxivSearchResult } from "../../src/agent/arxiv.js";
import { PaperDownloadError } from "../../src/agent/paper-download.js";
import {
  resolveExternalPaperPdfPath,
  resolvePaperPdfPath,
  resolvePaperRecordPath
} from "../../src/agent/paper-store.js";
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
    searchApsPapersImpl: async () => [],
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
    searchApsPapersImpl: async () => [],
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

test("searchPapers includes latest APS metadata results as downloadable paper sources", async () => {
  const results = await searchPapers({
    query: "superconducting quantum computing",
    searchArxivImpl: async () => [],
    searchApsPapersImpl: async () => [
      {
        title: "Latest Superconducting Qubit Paper",
        authors: ["Grace Hopper"],
        summary: "Published in Physical Review Letters.",
        primarySource: "aps",
        primaryAction: "authorized_download",
        sources: [
          {
            source: "aps",
            action: "authorized_download",
            canonicalId: "10.1103/PhysRevLett.135.030801",
            articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.135.030801"
          }
        ]
      }
    ],
    searchWebImpl: async () => []
  });

  assert.deepEqual(results, [
    {
      title: "Latest Superconducting Qubit Paper",
      authors: ["Grace Hopper"],
      summary: "Published in Physical Review Letters.",
      primarySource: "aps",
      primaryAction: "authorized_download",
      sources: [
        {
          source: "aps",
          action: "authorized_download",
          canonicalId: "10.1103/PhysRevLett.135.030801",
          articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.135.030801"
        }
      ]
    } satisfies PaperSearchResult
  ]);
});

test("searchPapers keeps supported hosts classified by hostname even when the path shape is unknown", async () => {
  const results = await searchPapers({
    query: "hostname classified paper",
    searchArxivImpl: async () => [],
    searchApsPapersImpl: async () => [],
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
    searchApsPapersImpl: async () => [],
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
    searchApsPapersImpl: async () => [],
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

test("downloadPaper returns an existing arXiv download without fetching it again", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "arxiv",
    canonicalId: "2401.01234"
  });
  const recordPath = resolvePaperRecordPath({
    workspaceDir,
    source: "arxiv",
    canonicalId: "2401.01234",
    articleUrl: "https://arxiv.org/abs/2401.01234"
  });
  let fetchCalls = 0;

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.4\nexisting pdf\n", "utf8");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          source: "arxiv",
          articleUrl: "https://arxiv.org/abs/2401.01234",
          recordedAt: "2026-04-25T10:00:00.000Z",
          handlingMethod: "direct_http",
          status: "downloaded",
          canonicalId: "2401.01234",
          pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
          downloadPath: pdfPath
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await downloadPaper({
      workspaceDir,
      id: "2401.01234v2",
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not run for an existing local paper");
      }
    });

    assert.equal(fetchCalls, 0);
    assert.deepEqual(result, {
      status: "already_downloaded",
      source: "arxiv",
      canonicalId: "2401.01234",
      articleUrl: "https://arxiv.org/abs/2401.01234",
      finalPdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
      path: pdfPath,
      recordPath,
      recordedAt: "2026-04-25T10:00:00.000Z"
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper returns an existing publisher download without opening the browser", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "science",
    canonicalId: "10.1126/science.adz8659"
  });
  const recordPath = resolvePaperRecordPath({
    workspaceDir,
    source: "science",
    canonicalId: "10.1126/science.adz8659",
    articleUrl
  });
  const browserCalls: string[] = [];

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.4\nexisting science pdf\n", "utf8");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          source: "science",
          articleUrl,
          recordedAt: "2026-04-25T10:00:00.000Z",
          handlingMethod: "browser_session",
          status: "downloaded",
          canonicalId: "10.1126/science.adz8659",
          pdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
          downloadPath: pdfPath
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      downloadPublisherPaperImpl: async () => {
        browserCalls.push("download");
        throw new Error("browser download should not run for an existing local paper");
      },
      openPublisherForLoginImpl: async () => {
        browserCalls.push("open");
        throw new Error("manual fallback should not open for an existing local paper");
      }
    });

    assert.deepEqual(browserCalls, []);
    assert.deepEqual(result, {
      status: "already_downloaded",
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl,
      finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
      path: pdfPath,
      recordPath,
      recordedAt: "2026-04-25T10:00:00.000Z"
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
      usePlaywrightFallback: true,
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
      usePlaywrightFallback: true,
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

test("downloadPaper keeps successful publisher downloads as downloaded when the canonical id comes from the resolved PDF URL", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://www.nature.com/content/preview";

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      usePlaywrightFallback: true,
      browserSessionFactory: async () => ({
        openArticlePage: async () => ({
          finalArticleUrl: articleUrl,
          html: '<a href="/articles/s41586-024-12345-6.pdf">PDF</a>',
          authorized: true
        }),
        openPageForManualLogin: async () => ({
          openedUrl: articleUrl
        }),
        downloadPdf: async (_url: string, destinationPath: string) => {
          await writeFile(destinationPath, Buffer.from("%PDF-1.7\nnature\n", "utf8"));
        }
      })
    });

    assert.equal(result.status, "downloaded");
    assert.equal(result.source, "nature");
    assert.equal(result.canonicalId, "s41586-024-12345-6");
    assert.equal(result.articleUrl, articleUrl);
    assert.equal(path.basename(result.path), "nature-s41586-024-12345-6.pdf");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper opens unsupported external URLs with explicit browser fallback", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://example.com/paper";

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      usePlaywrightFallback: true,
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

test("registerManualPaperDownload imports an external PDF and makes future downloads skip opening the browser", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://example.com/paper";
  const manualPdfPath = path.join(workspaceDir, "downloads", "inbox", "manual.pdf");
  const events: string[] = [];

  try {
    await downloadPaper({
      workspaceDir,
      url: articleUrl,
      usePlaywrightFallback: true,
      openPageInSystemChromeImpl: async () => {
        events.push("open");
        return {
          url: articleUrl,
          openedUrl: `${articleUrl}?opened=1`,
          profileDir: path.join(workspaceDir, ".browser-profile", "paper-access"),
          executablePath: "stubbed-chrome.exe"
        };
      }
    });

    await mkdir(path.dirname(manualPdfPath), { recursive: true });
    await writeFile(manualPdfPath, "%PDF-1.7\nmanual external pdf\n", "utf8");

    const expectedPdfPath = resolveExternalPaperPdfPath({ workspaceDir, articleUrl });
    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "external",
      articleUrl
    });
    const result = await registerManualPaperDownload({
      workspaceDir,
      url: articleUrl,
      pdfPath: manualPdfPath,
      title: "Manual External Paper",
      now: () => new Date("2026-04-25T10:30:00.000Z")
    });
    const expectedSha256 = createHash("sha256")
      .update(Buffer.from("%PDF-1.7\nmanual external pdf\n", "utf8"))
      .digest("hex");

    assert.deepEqual(result, {
      status: "downloaded",
      source: "external",
      articleUrl,
      path: expectedPdfPath,
      recordPath: expectedRecordPath,
      fileSha256: expectedSha256,
      title: "Manual External Paper"
    });
    assert.equal(await readFile(expectedPdfPath, "utf8"), "%PDF-1.7\nmanual external pdf\n");
    assert.deepEqual(JSON.parse(await readFile(expectedRecordPath, "utf8")), {
      source: "external",
      articleUrl,
      openedUrl: `${articleUrl}?opened=1`,
      recordedAt: "2026-04-25T10:30:00.000Z",
      handlingMethod: "manual_file_import",
      status: "downloaded",
      downloadPath: expectedPdfPath,
      fileSha256: expectedSha256,
      title: "Manual External Paper"
    });

    const existing = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      openPageInSystemChromeImpl: async () => {
        events.push("reopen");
        throw new Error("external paper should be found in the local index");
      }
    });

    assert.deepEqual(events, ["open"]);
    assert.deepEqual(existing, {
      status: "already_downloaded",
      source: "external",
      articleUrl,
      path: expectedPdfPath,
      recordPath: expectedRecordPath,
      recordedAt: "2026-04-25T10:30:00.000Z",
      fileSha256: expectedSha256,
      title: "Manual External Paper"
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("registerManualPaperDownload rejects non-PDF files and supported publisher URLs", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const textPath = path.join(workspaceDir, "downloads", "inbox", "not-pdf.txt");

  try {
    await mkdir(path.dirname(textPath), { recursive: true });
    await writeFile(textPath, "not a pdf", "utf8");

    await assert.rejects(
      () =>
        registerManualPaperDownload({
          workspaceDir,
          url: "https://example.com/paper",
          pdfPath: textPath
        }),
      /valid PDF/i
    );
    await writeFile(textPath, "%PDF-1.7\nmanual publisher pdf\n", "utf8");
    await assert.rejects(
      () =>
        registerManualPaperDownload({
          workspaceDir,
          url: "https://www.science.org/doi/10.1126/science.adz8659",
          pdfPath: textPath
        }),
      /external URLs/i
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper uses openPageInSystemChromeImpl for supported-publisher manual fallback when no login opener is injected", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.adz8659";
  const fallbackUrl = `${articleUrl}?manual=1`;
  const openCalls: Array<{
    url: string;
    openedUrl: string;
    profileDir: string;
    executablePath: string;
  }> = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      usePlaywrightFallback: true,
      downloadPublisherPaperImpl: async () => {
        throw new PaperDownloadError(
          "manual_login_required",
          "Publisher requires manual login."
        );
      },
      openPageInSystemChromeImpl: async (options) => {
        openCalls.push({
          url: options.url,
          openedUrl: fallbackUrl,
          profileDir: path.join(workspaceDir, ".browser-profile", "paper-access"),
          executablePath: "stubbed-chrome.exe"
        });

        return openCalls.at(-1) as {
          url: string;
          openedUrl: string;
          profileDir: string;
          executablePath: string;
        };
      }
    });

    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl
    });

    assert.equal(openCalls.length, 1);
    assert.equal(openCalls[0]?.url, articleUrl);
    assert.deepEqual(result, {
      status: "manual_fallback_opened",
      source: "science",
      canonicalId: "10.1126/science.adz8659",
      articleUrl,
      fallbackUrl,
      recordPath: expectedRecordPath,
      failure: {
        code: "manual_login_required",
        message: "Publisher requires manual login."
      },
      profileDir: path.join(workspaceDir, ".browser-profile", "paper-access"),
      executablePath: "stubbed-chrome.exe"
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadLatestApsPapers searches APS and attempts each requested download", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const firstUrl = "https://journals.aps.org/doi/10.1103/PhysRevApplied.24.034057";
  const secondUrl = "https://journals.aps.org/doi/10.1103/PhysRevLett.135.030801";
  const searchCalls: Array<{ query: string; maxResults?: number }> = [];
  const downloadCalls: Array<{ workspaceDir: string; url?: string }> = [];

  try {
    const result = await downloadLatestApsPapers({
      workspaceDir,
      query: "superconducting quantum computing",
      maxResults: 2,
      searchApsPapersImpl: async (options) => {
        searchCalls.push(options);
        return [
          {
            title: "On-chip direct-current source for scalable superconducting quantum computing",
            authors: ["Grace Hopper"],
            summary: "Published 22 September 2025 in Physical Review Applied.",
            primarySource: "aps",
            primaryAction: "authorized_download",
            sources: [
              {
                source: "aps",
                action: "authorized_download",
                articleUrl: firstUrl,
                canonicalId: "10.1103/PhysRevApplied.24.034057"
              }
            ]
          },
          {
            title: "Complete Self-Testing of a System of Remote Superconducting Qubits",
            authors: ["Ada Lovelace"],
            summary: "Published 15 July 2025 in Physical Review Letters.",
            primarySource: "aps",
            primaryAction: "authorized_download",
            sources: [
              {
                source: "aps",
                action: "authorized_download",
                articleUrl: secondUrl,
                canonicalId: "10.1103/PhysRevLett.135.030801"
              }
            ]
          }
        ];
      },
      downloadPaperImpl: async (options) => {
        downloadCalls.push(options);
        if (options.url === firstUrl) {
          return {
            status: "downloaded",
            source: "aps",
            canonicalId: "10.1103/PhysRevApplied.24.034057",
            articleUrl: firstUrl,
            finalPdfUrl: "https://journals.aps.org/prapplied/pdf/10.1103/PhysRevApplied.24.034057",
            path: path.join(workspaceDir, "downloads", "papers", "aps-10.1103-PhysRevApplied.24.034057.pdf"),
            recordPath: path.join(workspaceDir, "downloads", "papers", "index", "aps-10.1103-PhysRevApplied.24.034057.json")
          };
        }

        return {
          status: "manual_fallback_opened",
          source: "aps",
          canonicalId: "10.1103/PhysRevLett.135.030801",
          articleUrl: secondUrl,
          fallbackUrl: secondUrl,
          recordPath: path.join(workspaceDir, "downloads", "papers", "index", "aps-10.1103-PhysRevLett.135.030801.json"),
          failure: {
            code: "download_failed",
            message: "Timed out waiting for PDF download."
          }
        };
      }
    });

    assert.deepEqual(searchCalls, [
      { query: "superconducting quantum computing", maxResults: 2 }
    ]);
    assert.deepEqual(downloadCalls, [
      { workspaceDir, url: firstUrl },
      { workspaceDir, url: secondUrl }
    ]);
    assert.equal(result.query, "superconducting quantum computing");
    assert.equal(result.requested, 2);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0]?.title, "On-chip direct-current source for scalable superconducting quantum computing");
    assert.equal(result.results[0]?.download.status, "downloaded");
    assert.equal(result.results[1]?.download.status, "manual_fallback_opened");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadLatestApsPapers skips remaining automatic APS downloads after a Cloudflare fallback", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrls = [
    "https://journals.aps.org/prapplied/abstract/10.1103/k3d5-v43c",
    "https://journals.aps.org/prapplied/abstract/10.1103/rp4w-3n7l",
    "https://journals.aps.org/prapplied/abstract/10.1103/4ssz-6ctb"
  ];
  const downloadCalls: Array<{
    workspaceDir: string;
    url?: string;
    forceManualOpen?: { code: string; message: string };
  }> = [];

  try {
    const result = await downloadLatestApsPapers({
      workspaceDir,
      query: "superconducting quantum computing",
      maxResults: 3,
      now: () => new Date("2026-04-24T10:00:00.000Z"),
      searchApsPapersImpl: async () =>
        articleUrls.map((articleUrl, index) => ({
          title: `APS superconducting qubit paper ${index + 1}`,
          authors: [],
          summary: "Published in Physical Review Applied.",
          primarySource: "aps",
          primaryAction: "authorized_download",
          sources: [
            {
              source: "aps",
              action: "authorized_download",
              canonicalId: articleUrl.slice(articleUrl.lastIndexOf("/") + 1),
              articleUrl
            }
          ]
        })),
      downloadPaperImpl: async (options) => {
        downloadCalls.push(options);
        const canonicalId = options.url?.slice(options.url.lastIndexOf("/") + 1) ?? "unknown";
        return {
          status: "manual_fallback_opened",
          source: "aps",
          canonicalId,
          articleUrl: options.url as string,
          fallbackUrl:
            options.forceManualOpen === undefined
              ? `${options.url}?__cf_chl_rt_tk=blocked`
              : options.url as string,
          recordPath: path.join(workspaceDir, "downloads", "papers", "index", `aps-${canonicalId}.json`),
          failure: options.forceManualOpen ?? {
            code: "download_failed",
            message: "Timed out waiting for PDF download."
          }
        };
      }
    });

    assert.equal(result.results.length, 3);
    assert.equal(downloadCalls[0]?.forceManualOpen, undefined);
    assert.equal(downloadCalls[1]?.forceManualOpen?.code, "recent_cloudflare_block");
    assert.equal(downloadCalls[2]?.forceManualOpen?.code, "recent_cloudflare_block");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadLatestApsPapers defers remaining APS papers after queueing one extension job", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrls = [
    "https://journals.aps.org/prapplied/abstract/10.1103/PhysRevApplied.24.034057",
    "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.135.030801"
  ];
  const downloadCalls: string[] = [];

  try {
    const result = await downloadLatestApsPapers({
      workspaceDir,
      query: "superconducting quantum computing",
      maxResults: 2,
      searchApsPapersImpl: async () =>
        articleUrls.map((articleUrl, index) => ({
          title: `APS superconducting qubit paper ${index + 1}`,
          authors: [],
          summary: "Published in Physical Review.",
          primarySource: "aps",
          primaryAction: "authorized_download",
          sources: [
            {
              source: "aps",
              action: "authorized_download",
              canonicalId: articleUrl.slice(articleUrl.lastIndexOf("/") + 1),
              articleUrl
            }
          ]
        })),
      downloadPaperImpl: async (options) => {
        downloadCalls.push(options.url as string);
        return {
          status: "extension_job_queued",
          source: "aps",
          articleUrl: options.url as string,
          jobId: "job-aps-1",
          message: "Paper download job queued for the browser extension."
        };
      }
    });

    assert.deepEqual(downloadCalls, [articleUrls[0]]);
    assert.equal(result.results[0]?.download.status, "extension_job_queued");
    assert.equal(result.results[1]?.download.status, "extension_unavailable");
    if (result.results[1]?.download.status !== "extension_unavailable") {
      assert.fail("Expected the second APS result to be deferred.");
    }
    assert.equal(result.results[1].download.failure.code, "aps_extension_job_pending");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadLatestApsPapers skips all automatic APS downloads when a recent Cloudflare block is recorded", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrls = [
    "https://journals.aps.org/prapplied/abstract/10.1103/k3d5-v43c",
    "https://journals.aps.org/prapplied/abstract/10.1103/rp4w-3n7l",
    "https://journals.aps.org/prapplied/abstract/10.1103/4ssz-6ctb"
  ];
  const downloadCalls: Array<{
    url?: string;
    forceManualOpen?: { code: string; message: string };
  }> = [];

  try {
    await downloadLatestApsPapers({
      workspaceDir,
      query: "superconducting quantum computing",
      maxResults: 3,
      now: () => new Date("2026-04-24T10:15:00.000Z"),
      readPublisherAccessStateImpl: async () => ({
        cloudflareBlocks: {
          aps: {
            blockedAt: "2026-04-24T10:00:00.000Z"
          }
        }
      }),
      writePublisherAccessStateImpl: async () => {
        throw new Error("state should not be rewritten when only reading a recent block");
      },
      searchApsPapersImpl: async () =>
        articleUrls.map((articleUrl, index) => ({
          title: `APS superconducting qubit paper ${index + 1}`,
          authors: [],
          summary: "Published in Physical Review Applied.",
          primarySource: "aps",
          primaryAction: "authorized_download",
          sources: [
            {
              source: "aps",
              action: "authorized_download",
              canonicalId: articleUrl.slice(articleUrl.lastIndexOf("/") + 1),
              articleUrl
            }
          ]
        })),
      downloadPaperImpl: async (options) => {
        downloadCalls.push(options);
        const canonicalId = options.url?.slice(options.url.lastIndexOf("/") + 1) ?? "unknown";
        return {
          status: "manual_fallback_opened",
          source: "aps",
          canonicalId,
          articleUrl: options.url as string,
          fallbackUrl: options.url as string,
          recordPath: path.join(workspaceDir, "downloads", "papers", "index", `aps-${canonicalId}.json`),
          failure: options.forceManualOpen ?? {
            code: "download_failed",
            message: "Unexpected automatic attempt."
          }
        };
      }
    });

    assert.deepEqual(
      downloadCalls.map((call) => ({
        url: call.url,
        code: call.forceManualOpen?.code
      })),
      articleUrls.map((url) => ({
        url,
        code: "recent_cloudflare_block"
      }))
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
