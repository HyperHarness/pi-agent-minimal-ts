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
} from "../../src/agent/paper/acquisition/paper-manager.js";
import type { ArxivSearchResult } from "../../src/agent/paper/acquisition/arxiv.js";
import { PaperDownloadError } from "../../src/agent/paper/acquisition/paper-download.js";
import {
  resolveExternalPaperPdfPath,
  resolvePaperPdfPath,
  resolvePaperRecordPath
} from "../../src/agent/paper/storage/paper-store.js";
import { appendPaperDownloadJobEvent } from "../../src/agent/paper/extension/paper-download-jobs.js";
import { blockPaperDownload } from "../../src/agent/paper/acquisition/paper-blocklist.js";
import type { WebSearchResult } from "../../src/agent/web-search.js";
import type { PaperSearchResult, PaperSearchSource } from "../../src/agent/paper/types.js";

type SearchArxivCall = {
  query: string;
  maxResults?: number;
};

type SearchWebCall = {
  query: string;
  maxResults?: number;
};

function stripRecordManifest(record: Record<string, unknown>): Record<string, unknown> {
  const {
    updatedAt: _updatedAt,
    download: _download,
    parse: _parse,
    webpage: _webpage,
    reading: _reading,
    ...legacyRecord
  } = record;
  return legacyRecord;
}

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

test("searchPapers merges duplicate titles and keeps publisher sources primary", async () => {
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
        url: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
        snippet: "science summary. Research Article."
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
    summary: "science summary. Research Article.",
    primarySource: "science",
    primaryAction: "authorized_download",
    sources: [
      {
        source: "science",
        canonicalId: "10.1126/science.adz8659",
        articleUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
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

test("searchPapers keeps APS article URLs and matching arXiv preprints as alternate sources", async () => {
  const results = await searchPapers({
    query: "Superconducting qubits in the millions",
    maxResults: 2,
    searchArxivImpl: async () => [
      createArxivResult({
        id: "2406.06015",
        title: "Superconducting qubits in the millions: The potential and limitations of modularity",
        summary: "arXiv preprint summary.",
        absUrl: "https://arxiv.org/abs/2406.06015",
        pdfUrl: "https://arxiv.org/pdf/2406.06015.pdf"
      })
    ],
    searchApsPapersImpl: async () => [
      {
        title: "Superconducting qubits in the millions: The potential and limitations of modularity",
        authors: ["S. N. Saadatmand"],
        summary: "APS metadata summary.",
        primarySource: "aps",
        primaryAction: "authorized_download",
        sources: [
          {
            source: "aps",
            action: "authorized_download",
            canonicalId: "10.1103/example",
            articleUrl: "https://journals.aps.org/prxquantum/abstract/10.1103/example"
          }
        ]
      }
    ],
    searchWebImpl: async () => []
  });

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    title: "Superconducting qubits in the millions: The potential and limitations of modularity",
    authors: ["S. N. Saadatmand"],
    summary: "APS metadata summary.",
    primarySource: "aps",
    primaryAction: "authorized_download",
    sources: [
      {
        source: "aps",
        action: "authorized_download",
        canonicalId: "10.1103/example",
        articleUrl: "https://journals.aps.org/prxquantum/abstract/10.1103/example"
      },
      {
        source: "arxiv",
        action: "direct_download",
        canonicalId: "2406.06015",
        articleUrl: "https://arxiv.org/abs/2406.06015",
        pdfUrl: "https://arxiv.org/pdf/2406.06015.pdf"
      }
    ]
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

test("searchPapers filters Nature and Science news pages from downloadable paper results", async () => {
  const results = await searchPapers({
    query: "ai scientific discovery",
    maxResults: 10,
    searchArxivImpl: async () => [],
    searchApsPapersImpl: async () => [],
    searchWebImpl: async () => [
      createWebResult({
        title: "Learning the language of life with AI",
        url: "https://www.science.org/doi/10.1126/science.adv4414",
        snippet: "Editorial coverage from Science, not a research article."
      }),
      createWebResult({
        title: "Accelerating science with AI",
        url: "https://www.science.org/doi/10.1126/science.aee0605",
        snippet: "News and editorial analysis."
      }),
      createWebResult({
        title: "AI scientist 'team' joins the search for extraterrestrial life",
        url: "https://www.nature.com/articles/d41586-025-01364-w",
        snippet: "Nature News."
      }),
      createWebResult({
        title: "Progression without progress",
        url: "https://www.science.org/doi/10.1126/science.aeh8945",
        snippet: "Perspective article."
      }),
      createWebResult({
        title: "AI has supercharged scientists-but may have shrunk science",
        url: "https://www.science.org/content/article/ai-has-supercharged-scientists-may-have-shrunk-science",
        snippet: "Science news story."
      }),
      createWebResult({
        title: "Accelerating scientific discovery with Co-Scientist",
        url: "https://www.nature.com/articles/s41586-026-10644-y",
        snippet: "Nature research article."
      }),
      createWebResult({
        title: "A Science Advances research paper",
        url: "https://www.science.org/doi/10.1126/sciadv.adp6388",
        snippet: "Research Article."
      })
    ]
  });

  assert.deepEqual(
    results.map((result) => result.sources[0]?.articleUrl),
    [
      "https://www.nature.com/articles/s41586-026-10644-y",
      "https://www.science.org/doi/10.1126/sciadv.adp6388"
    ]
  );
  assert.equal(results.every((result) => result.primaryAction === "authorized_download"), true);
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

test("searchPapers prefers original supported web URLs over generated APS metadata URLs", async () => {
  const generatedUrl = "https://journals.aps.org/prapplied/abstract/10.1103/k3d5-v43c";
  const originalUrl = "https://journals.aps.org/prapplied/abstract/10.1103/PhysRevApplied.24.034057";

  const results = await searchPapers({
    query: "superconducting quantum computing",
    searchArxivImpl: async () => [],
    searchApsPapersImpl: async () => [
      {
        title: "Latest Superconducting Qubit Paper",
        authors: ["Grace Hopper"],
        summary: "APS metadata summary.",
        primarySource: "aps",
        primaryAction: "authorized_download",
        sources: [
          {
            source: "aps",
            action: "authorized_download",
            canonicalId: "10.1103/k3d5-v43c",
            articleUrl: generatedUrl
          }
        ]
      }
    ],
    searchWebImpl: async () => [
      createWebResult({
        title: "Latest Superconducting Qubit Paper",
        url: originalUrl,
        snippet: "Web search original URL summary."
      })
    ]
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.summary, "Web search original URL summary.");
  assert.deepEqual(results[0]?.sources[0], {
    source: "aps",
    action: "authorized_download",
    articleUrl: originalUrl,
    canonicalId: "10.1103/PhysRevApplied.24.034057"
  });
});

test("searchPapers still returns available paper results when optional search providers fail", async () => {
  const results = await searchPapers({
    query: "superconducting quantum computing",
    searchArxivImpl: async () => {
      throw new Error("arXiv temporarily unavailable");
    },
    searchApsPapersImpl: async () => [
      {
        title: "Resilient APS Paper",
        authors: [],
        summary: "Published in Physical Review Applied.",
        primarySource: "aps",
        primaryAction: "authorized_download",
        sources: [
          {
            source: "aps",
            action: "authorized_download",
            canonicalId: "10.1103/PhysRevApplied.24.034057",
            articleUrl: "https://journals.aps.org/prapplied/abstract/10.1103/PhysRevApplied.24.034057"
          }
        ]
      }
    ],
    searchWebImpl: async () => {
      throw new Error("PI_SEARCH_API_URL is not configured.");
    }
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "Resilient APS Paper");
  assert.equal(results[0]?.primarySource, "aps");
});

test("searchPapers filters supported hosts when the path is not a journal article", async () => {
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

  assert.deepEqual(results, []);
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

test("searchPapers classifies link.aps.org DOI URLs as APS sources", async () => {
  const results = await searchPapers({
    query: "aps link doi",
    searchArxivImpl: async () => [],
    searchApsPapersImpl: async () => [],
    searchWebImpl: async () => [
      createWebResult({
        title: "APS Link DOI",
        url: "https://link.aps.org/doi/10.1103/k3d5-v43c",
        snippet: "aps summary"
      })
    ]
  });

  assert.deepEqual(results, [
    {
      title: "APS Link DOI",
      authors: [],
      summary: "aps summary",
      primarySource: "aps",
      primaryAction: "authorized_download",
      sources: [
        {
          source: "aps",
          canonicalId: "10.1103/k3d5-v43c",
          articleUrl: "https://link.aps.org/doi/10.1103/k3d5-v43c",
          action: "authorized_download"
        }
      ]
    } satisfies PaperSearchResult
  ]);
});

test("searchPapers canonicalizes lowercase APS PhysRev DOI URLs from web results", async () => {
  const results = await searchPapers({
    query: "lowercase aps doi",
    searchArxivImpl: async () => [],
    searchApsPapersImpl: async () => [],
    searchWebImpl: async () => [
      createWebResult({
        title: "Lowercase APS DOI",
        url: "https://journals.aps.org/pra/abstract/10.1103/physreva.111.012619",
        snippet: "aps summary"
      })
    ]
  });

  assert.deepEqual(results, [
    {
      title: "Lowercase APS DOI",
      authors: [],
      summary: "aps summary",
      primarySource: "aps",
      primaryAction: "authorized_download",
      sources: [
        {
          source: "aps",
          canonicalId: "10.1103/PhysRevA.111.012619",
          articleUrl: "https://journals.aps.org/pra/abstract/10.1103/PhysRevA.111.012619",
          action: "authorized_download"
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
        snippet: "science summary B. Research Article."
      }),
      createWebResult({
        title: "Paper A",
        url: "https://www.science.org/doi/10.1126/science.paper-a",
        snippet: "science summary A. Research Article."
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

    const savedRecord = JSON.parse(await readFile(expectedRecordPath, "utf8"));
    assert.deepEqual(stripRecordManifest(savedRecord), {
      source: "arxiv",
      articleUrl: "https://arxiv.org/abs/2401.01234",
      recordedAt: savedRecord.recordedAt,
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "2401.01234",
      pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf",
      downloadPath: expectedPdfPath
    });
    assert.equal(savedRecord.download.status, "downloaded");
    assert.equal(savedRecord.reading.status, "not_ready");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper treats arXiv HTML URLs as arXiv papers", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const pdfBytes = Buffer.from("%PDF-1.4\nmock pdf\n", "utf8");
  const fetchCalls: string[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: "https://arxiv.org/html/2601.00425v1",
      fetchImpl: async (input) => {
        fetchCalls.push(String(input));
        return new Response(pdfBytes, {
          status: 200,
          headers: {
            "content-type": "application/pdf"
          }
        });
      }
    });

    assert.deepEqual(fetchCalls, ["https://arxiv.org/pdf/2601.00425.pdf"]);
    assert.equal(result.status, "downloaded");
    assert.equal(result.source, "arxiv");
    assert.equal(result.canonicalId, "2601.00425");
    assert.equal(result.articleUrl, "https://arxiv.org/abs/2601.00425");
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

test("downloadPaper blocks arXiv downloads from the local blocklist before fetching", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-blocklist-"));
  let fetchCalls = 0;

  try {
    await blockPaperDownload({
      workspaceDir,
      source: "arxiv",
      canonicalId: "2401.01234",
      reasonCode: "irrelevant",
      note: "Outside the project scope.",
      createdAt: "2026-05-06T00:00:00.000Z"
    });

    const result = await downloadPaper({
      workspaceDir,
      id: "2401.01234v2",
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not run for a blocked paper");
      }
    });

    assert.equal(fetchCalls, 0);
    assert.deepEqual(result, {
      status: "blocked",
      source: "arxiv",
      canonicalId: "2401.01234",
      articleUrl: "https://arxiv.org/abs/2401.01234",
      paperKey: "arxiv-2401.01234",
      failure: {
        code: "blocked_irrelevant",
        message: "Paper download is blocked by the local blocklist: Outside the project scope."
      }
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper blocks publisher downloads before queueing extension jobs", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-blocklist-"));
  const articleUrl = "https://www.science.org/doi/10.1126/science.ado6285";
  const submittedJobs: unknown[] = [];

  try {
    await blockPaperDownload({
      workspaceDir,
      source: "science",
      canonicalId: "10.1126/science.ado6285",
      articleUrl,
      title: "Beyond-classical computation in quantum simulation",
      reasonCode: "license_denied",
      note: "Science license does not permit PDF download.",
      createdAt: "2026-05-06T00:00:00.000Z"
    });

    const result = await downloadPaper({
      workspaceDir,
      url: "https://www.science.org/doi/epdf/10.1126/science.ado6285",
      extensionBridge: {
        async submitJob(job) {
          submittedJobs.push(job);
          return {
            status: "extension_job_queued",
            source: job.source,
            articleUrl: job.articleUrl,
            jobId: job.jobId,
            message: "Paper download job queued for the browser extension."
          };
        }
      }
    });

    assert.deepEqual(submittedJobs, []);
    assert.deepEqual(result, {
      status: "blocked",
      source: "science",
      canonicalId: "10.1126/science.ado6285",
      articleUrl: "https://www.science.org/doi/epdf/10.1126/science.ado6285",
      paperKey: "science-10.1126-science.ado6285",
      title: "Beyond-classical computation in quantum simulation",
      failure: {
        code: "blocked_license_denied",
        message: "Paper download is blocked by the local blocklist: Science license does not permit PDF download."
      }
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
          pdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
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
      finalPdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
      path: pdfPath,
      recordPath,
      recordedAt: "2026-04-25T10:00:00.000Z"
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper returns existing APS downloads for equivalent PDF URLs without re-downloading", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://journals.aps.org/prapplied/abstract/10.1103/4ssz-6ctb";
  const requestedUrl = "https://journals.aps.org/prapplied/pdf/10.1103/4ssz-6ctb";
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "aps",
    canonicalId: "10.1103/4ssz-6ctb"
  });
  const recordPath = resolvePaperRecordPath({
    workspaceDir,
    source: "aps",
    canonicalId: "10.1103/4ssz-6ctb",
    articleUrl
  });
  const calls: string[] = [];

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\nexisting aps pdf\n", "utf8");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          source: "aps",
          articleUrl,
          recordedAt: "2026-04-25T10:00:00.000Z",
          handlingMethod: "browser_session",
          status: "downloaded",
          canonicalId: "10.1103/4ssz-6ctb",
          pdfUrl: requestedUrl,
          downloadPath: `\\\\wsl.localhost\\Ubuntu-24.04${pdfPath.replace(/\//g, "\\")}`
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await downloadPaper({
      workspaceDir,
      url: requestedUrl,
      fetchImpl: async () => {
        calls.push("fetch");
        throw new Error("direct fetch should not run for an existing local paper");
      },
      extensionBridge: {
        async submitJob() {
          calls.push("extension");
          throw new Error("extension should not run for an existing local paper");
        }
      },
      downloadPublisherPaperImpl: async () => {
        calls.push("browser");
        throw new Error("browser fallback should not run for an existing local paper");
      }
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(result, {
      status: "already_downloaded",
      source: "aps",
      canonicalId: "10.1103/4ssz-6ctb",
      articleUrl,
      finalPdfUrl: requestedUrl,
      path: pdfPath,
      recordPath,
      recordedAt: "2026-04-25T10:00:00.000Z"
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper enriches source citation metadata after a supported publisher download", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://www.nature.com/articles/s41586-024-08449-y";
  const finalPdfUrl = "https://www.nature.com/articles/s41586-024-08449-y.pdf";
  const pdfPath = resolvePaperPdfPath({
    workspaceDir,
    source: "nature",
    canonicalId: "s41586-024-08449-y"
  });
  const citationFetchCalls: string[] = [];

  try {
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "%PDF-1.7\nnature pdf\n", "utf8");

    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title: "Quantum error correction below the surface code threshold",
      usePlaywrightFallback: true,
      searchArxivImpl: async () => [],
      downloadPublisherPaperImpl: async () => ({
        publisher: "nature",
        canonicalId: "s41586-024-08449-y",
        articleUrl,
        finalArticleUrl: articleUrl,
        finalPdfUrl,
        path: pdfPath
      }),
      citationMetadataFetchImpl: async (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        citationFetchCalls.push(url.toString());
        assert.equal(url.hostname, "api.crossref.org");
        assert.equal(url.pathname, "/works/10.1038%2Fs41586-024-08449-y");
        return new Response(JSON.stringify({
          message: {
            DOI: "10.1038/s41586-024-08449-y",
            title: ["Quantum error correction below the surface code threshold"],
            author: [
              { given: "Google", family: "Quantum AI" },
              { given: "A.", family: "Researcher" }
            ],
            published: { "date-parts": [[2025, 1, 1]] },
            "container-title": ["Nature"]
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    assert.equal(result.status, "downloaded");
    const sourcePath = path.join(path.dirname(result.recordPath), "source.json");
    const source = JSON.parse(await readFile(sourcePath, "utf8"));

    assert.equal(source.title, "Quantum error correction below the surface code threshold");
    assert.deepEqual(source.authors, ["Google Quantum AI", "A. Researcher"]);
    assert.equal(source.year, 2025);
    assert.equal(source.venue, "Nature");
    assert.equal(source.doi, "10.1038/s41586-024-08449-y");
    assert.equal(source.citationStatus, "complete");
    assert.deepEqual(source.missingFields, []);
    assert.equal(source.resolvedFrom, "crossref_api");
    assert.equal(citationFetchCalls.length, 1);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper only downloads open APS abstract PDFs directly in explicit fallback mode", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://journals.aps.org/prapplied/abstract/10.1103/4ssz-6ctb";
  const pdfUrl = "https://journals.aps.org/prapplied/pdf/10.1103/4ssz-6ctb";
  const pdfBytes = Buffer.from("%PDF-1.7\naps open access\n", "utf8");
  const fetchCalls: string[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      fetchImpl: async (input) => {
        fetchCalls.push(String(input));
        return new Response(pdfBytes, {
          status: 200,
          headers: {
            "content-type": "application/pdf"
          }
        });
      },
      usePlaywrightFallback: true,
      downloadPublisherPaperImpl: async () => {
        throw new Error("browser fallback should not run for direct APS PDF downloads");
      }
    });

    const expectedPdfPath = resolvePaperPdfPath({
      workspaceDir,
      source: "aps",
      canonicalId: "10.1103/4ssz-6ctb"
    });
    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "aps",
      canonicalId: "10.1103/4ssz-6ctb",
      articleUrl
    });
    const savedRecord = JSON.parse(await readFile(expectedRecordPath, "utf8"));

    assert.deepEqual(fetchCalls, [pdfUrl]);
    assert.deepEqual(result, {
      status: "downloaded",
      source: "aps",
      canonicalId: "10.1103/4ssz-6ctb",
      articleUrl,
      finalPdfUrl: pdfUrl,
      path: expectedPdfPath,
      recordPath: expectedRecordPath
    });
    assert.equal(await readFile(expectedPdfPath, "utf8"), pdfBytes.toString("utf8"));
    assert.deepEqual(stripRecordManifest(savedRecord), {
      source: "aps",
      articleUrl,
      recordedAt: savedRecord.recordedAt,
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "10.1103/4ssz-6ctb",
      pdfUrl,
      downloadPath: expectedPdfPath
    });
    assert.equal(savedRecord.download.status, "downloaded");
    assert.equal(savedRecord.reading.status, "not_ready");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper queues extension bridge before attempting direct APS PDF fetch", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://journals.aps.org/prapplied/abstract/10.1103/4ssz-6ctb";
  const fetchCalls: string[] = [];
  const submittedJobs: unknown[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      fetchImpl: async (input) => {
        fetchCalls.push(String(input));
        return new Response("<html>not a pdf</html>", {
          status: 200,
          headers: {
            "content-type": "text/html"
          }
        });
      },
      extensionBridge: {
        async submitJob(job) {
          submittedJobs.push(job);
          return {
            status: "extension_job_queued",
            source: job.source,
            articleUrl: job.articleUrl,
            jobId: job.jobId,
            message: "Paper download job queued for the browser extension."
          };
        }
      },
      downloadPublisherPaperImpl: async () => {
        throw new Error("Playwright fallback should not run by default");
      }
    });

    assert.deepEqual(fetchCalls, []);
    assert.deepEqual(submittedJobs, [
      {
        jobId: "paper-aps-6004bdc34f5d",
        articleUrl,
        source: "aps",
        purpose: "download_and_webpage"
      }
    ]);
    assert.deepEqual(result, {
      status: "extension_job_queued",
      source: "aps",
      articleUrl,
      jobId: "paper-aps-6004bdc34f5d",
      message: "Paper download job queued for the browser extension."
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper normalizes invalid APS journals DOI resolver URLs before queueing", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const invalidArticleUrl = "https://journals.aps.org/doi/10.1103/9shv-l4cx";
  const normalizedArticleUrl = "https://link.aps.org/doi/10.1103/9shv-l4cx";
  const submittedJobs: unknown[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: invalidArticleUrl,
      extensionBridge: {
        async submitJob(job) {
          submittedJobs.push(job);
          return {
            status: "extension_job_queued",
            source: job.source,
            articleUrl: job.articleUrl,
            jobId: job.jobId,
            message: "Paper download job queued for the browser extension."
          };
        }
      },
      downloadPublisherPaperImpl: async () => {
        throw new Error("Playwright fallback should not run by default");
      }
    });

    assert.deepEqual(submittedJobs, [
      {
        jobId: "paper-aps-3ba6a6a8c92e",
        articleUrl: normalizedArticleUrl,
        source: "aps",
        purpose: "download_and_webpage"
      }
    ]);
    assert.deepEqual(result, {
      status: "extension_job_queued",
      source: "aps",
      articleUrl: normalizedArticleUrl,
      jobId: "paper-aps-3ba6a6a8c92e",
      message: "Paper download job queued for the browser extension."
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper downloads direct Nature reference PDFs without requiring the extension", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://www.nature.com/articles/s41534-026-01243-w_reference.pdf";
  const pdfBytes = Buffer.from("%PDF-1.7\nnature article in press\n", "utf8");
  const fetchCalls: string[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      fetchImpl: async (input) => {
        fetchCalls.push(String(input));
        return new Response(pdfBytes, {
          status: 200,
          headers: {
            "content-type": "application/pdf"
          }
        });
      },
      downloadPublisherPaperImpl: async () => {
        throw new Error("browser fallback should not run for direct Nature PDF downloads");
      }
    });

    const expectedPdfPath = resolvePaperPdfPath({
      workspaceDir,
      source: "nature",
      canonicalId: "s41534-026-01243-w"
    });
    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "nature",
      canonicalId: "s41534-026-01243-w",
      articleUrl
    });
    const savedRecord = JSON.parse(await readFile(expectedRecordPath, "utf8"));

    assert.deepEqual(fetchCalls, [articleUrl]);
    assert.deepEqual(result, {
      status: "downloaded",
      source: "nature",
      canonicalId: "s41534-026-01243-w",
      articleUrl,
      finalPdfUrl: articleUrl,
      path: expectedPdfPath,
      recordPath: expectedRecordPath
    });
    assert.equal(await readFile(expectedPdfPath, "utf8"), pdfBytes.toString("utf8"));
    assert.deepEqual(stripRecordManifest(savedRecord), {
      source: "nature",
      articleUrl,
      recordedAt: savedRecord.recordedAt,
      handlingMethod: "direct_http",
      status: "downloaded",
      canonicalId: "s41534-026-01243-w",
      pdfUrl: articleUrl,
      downloadPath: expectedPdfPath
    });
    assert.equal(savedRecord.download.status, "downloaded");
    assert.equal(savedRecord.reading.status, "not_ready");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper tries an exact-title arXiv preprint when a publisher URL cannot be downloaded", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://journals.aps.org/prxquantum/abstract/10.1103/example";
  const title = "Superconducting qubits in the millions: The potential and limitations of modularity";
  const arxivPdfUrl = "https://arxiv.org/pdf/2406.06015.pdf";
  const pdfBytes = Buffer.from("%PDF-1.7\narxiv preprint\n", "utf8");
  const fetchCalls: string[] = [];
  const searchCalls: Array<{ query: string; maxResults?: number }> = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title,
      fetchImpl: async (input) => {
        fetchCalls.push(String(input));
        if (String(input) === arxivPdfUrl) {
          return new Response(pdfBytes, {
            status: 200,
            headers: {
              "content-type": "application/pdf"
            }
          });
        }

        return new Response("<html>publisher unavailable</html>", {
          status: 503,
          headers: {
            "content-type": "text/html"
          }
        });
      },
      searchArxivImpl: async (options) => {
        searchCalls.push({ query: options.query, maxResults: options.maxResults });
        return [
          createArxivResult({
            id: "2406.06015",
            title,
            summary: "arXiv preprint summary.",
            absUrl: "https://arxiv.org/abs/2406.06015",
            pdfUrl: arxivPdfUrl
          })
        ];
      }
    });

    const expectedPdfPath = resolvePaperPdfPath({
      workspaceDir,
      source: "arxiv",
      canonicalId: "2406.06015"
    });
    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "arxiv",
      canonicalId: "2406.06015",
      articleUrl: "https://arxiv.org/abs/2406.06015"
    });
    const expectedPublisherFallbackRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "aps",
      canonicalId: "10.1103/example",
      articleUrl
    });

    assert.deepEqual(fetchCalls, [arxivPdfUrl]);
    assert.deepEqual(searchCalls, [{ query: title, maxResults: 5 }]);
    assert.deepEqual(result, {
      status: "downloaded",
      source: "arxiv",
      canonicalId: "2406.06015",
      articleUrl: "https://arxiv.org/abs/2406.06015",
      finalPdfUrl: arxivPdfUrl,
      path: expectedPdfPath,
      recordPath: expectedRecordPath,
      publisherFallback: {
        source: "aps",
        canonicalId: "10.1103/example",
        articleUrl,
        recordPath: expectedPublisherFallbackRecordPath,
        reason: "Publisher PDF was not downloaded automatically; using matching arXiv preprint 2406.06015.",
        title
      }
    });
    assert.equal(await readFile(expectedPdfPath, "utf8"), pdfBytes.toString("utf8"));
    const publisherFallbackRecord = JSON.parse(await readFile(expectedPublisherFallbackRecordPath, "utf8"));
    assert.equal(publisherFallbackRecord.status, "preprint_fallback");
    assert.equal(publisherFallbackRecord.preprint.canonicalId, "2406.06015");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper matches arXiv preprints across hyphenated publisher title variants", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://journals.aps.org/prxquantum/abstract/10.1103/9shv-l4cx";
  const title = "Parametric Multielement Coupling Architecture for Coherent and Dissipative Control of Superconducting Qubits";
  const arxivTitle = "Parametric multi-element coupling architecture for coherent and dissipative control of superconducting qubits";
  const arxivPdfUrl = "https://arxiv.org/pdf/2403.02203.pdf";
  const pdfBytes = Buffer.from("%PDF-1.7\narxiv preprint\n", "utf8");

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title,
      fetchImpl: async (input) => {
        assert.equal(String(input), arxivPdfUrl);
        return new Response(pdfBytes, {
          status: 200,
          headers: {
            "content-type": "application/pdf"
          }
        });
      },
      searchArxivImpl: async () => [
        createArxivResult({
          id: "2403.02203",
          title: arxivTitle,
          absUrl: "https://arxiv.org/abs/2403.02203",
          pdfUrl: arxivPdfUrl
        })
      ]
    });

    const expectedPublisherFallbackRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "aps",
      canonicalId: "10.1103/9shv-l4cx",
      articleUrl
    });
    const publisherFallbackRecord = JSON.parse(await readFile(expectedPublisherFallbackRecordPath, "utf8"));

    assert.equal(result.status, "downloaded");
    assert.equal(result.source, "arxiv");
    assert.equal(result.canonicalId, "2403.02203");
    assert.equal(result.publisherFallback?.recordPath, expectedPublisherFallbackRecordPath);
    assert.equal(publisherFallbackRecord.status, "preprint_fallback");
    assert.equal(publisherFallbackRecord.preprint.canonicalId, "2403.02203");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper keeps publisher failure results when title does not match an arXiv preprint", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://journals.aps.org/prxquantum/abstract/10.1103/example";
  const title = "Superconducting qubits in the millions: The potential and limitations of modularity";

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title,
      fetchImpl: async () =>
        new Response("<html>publisher unavailable</html>", {
          status: 503,
          headers: {
            "content-type": "text/html"
          }
        }),
      searchArxivImpl: async () => [
        createArxivResult({
          id: "2406.06015",
          title: "A different superconducting qubit paper",
          absUrl: "https://arxiv.org/abs/2406.06015",
          pdfUrl: "https://arxiv.org/pdf/2406.06015.pdf"
        })
      ]
    });

    assert.deepEqual(result, {
      status: "extension_unavailable",
      source: "aps",
      articleUrl,
      failure: {
        code: "extension_unavailable",
        message: "Paper extension bridge is not configured, and no direct PDF or exact-title open fallback was available."
      }
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper uses arXiv fallback after a prior extension non-PDF failure", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://journals.aps.org/prxquantum/abstract/10.1103/k3d5-v43c";
  const title = "Superconducting qubits in the millions: The potential and limitations of modularity";
  const arxivPdfUrl = "https://arxiv.org/pdf/2406.06015.pdf";
  const pdfBytes = Buffer.from("%PDF-1.7\narxiv preprint\n", "utf8");
  const submittedJobs: unknown[] = [];
  const fetchCalls: string[] = [];

  try {
    await appendPaperDownloadJobEvent({
      workspaceDir,
      event: {
        jobId: "paper-aps-failed",
        recordedAt: "2026-04-27T10:00:00.000Z",
        status: "automatic_download_failed",
        articleUrl,
        source: "aps",
        title,
        message: "Downloaded file is not a valid PDF."
      }
    });

    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title,
      fetchImpl: async (input) => {
        fetchCalls.push(String(input));
        if (String(input) === arxivPdfUrl) {
          return new Response(pdfBytes, {
            status: 200,
            headers: {
              "content-type": "application/pdf"
            }
          });
        }

        return new Response("<html>publisher unavailable</html>", {
          status: 200,
          headers: {
            "content-type": "text/html"
          }
        });
      },
      searchArxivImpl: async () => [
        createArxivResult({
          id: "2406.06015",
          title,
          absUrl: "https://arxiv.org/abs/2406.06015",
          pdfUrl: arxivPdfUrl
        })
      ],
      extensionBridge: {
        async submitJob(job) {
          submittedJobs.push(job);
          return {
            status: "extension_job_queued",
            source: job.source,
            articleUrl: job.articleUrl,
            jobId: job.jobId,
            message: "Paper download job queued for the browser extension."
          };
        }
      }
    });

    const expectedPdfPath = resolvePaperPdfPath({
      workspaceDir,
      source: "arxiv",
      canonicalId: "2406.06015"
    });

    assert.deepEqual(submittedJobs, []);
    assert.deepEqual(fetchCalls, [arxivPdfUrl]);
    assert.equal(result.status, "downloaded");
    assert.equal(result.source, "arxiv");
    assert.equal(result.path, expectedPdfPath);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper uses arXiv fallback when a prior publisher artifact is HTML", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://journals.aps.org/prxquantum/abstract/10.1103/k3d5-v43c";
  const title = "Superconducting qubits in the millions: The potential and limitations of modularity";
  const arxivPdfUrl = "https://arxiv.org/pdf/2406.06015.pdf";
  const pdfBytes = Buffer.from("%PDF-1.7\narxiv preprint\n", "utf8");
  const htmlArtifactPath = resolvePaperPdfPath({
    workspaceDir,
    source: "aps",
    canonicalId: "10.1103/k3d5-v43c"
  }).replace(/\.pdf$/i, ".htm");
  const submittedJobs: unknown[] = [];

  try {
    await mkdir(path.dirname(htmlArtifactPath), { recursive: true });
    await writeFile(htmlArtifactPath, "<html>not a PDF</html>", "utf8");

    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title,
      fetchImpl: async (input) => {
        if (String(input) === arxivPdfUrl) {
          return new Response(pdfBytes, {
            status: 200,
            headers: {
              "content-type": "application/pdf"
            }
          });
        }

        assert.equal(String(input), arxivPdfUrl);
        return new Response("<html>publisher unavailable</html>", {
          status: 200,
          headers: {
            "content-type": "text/html"
          }
        });
      },
      searchArxivImpl: async () => [
        createArxivResult({
          id: "2406.06015",
          title,
          absUrl: "https://arxiv.org/abs/2406.06015",
          pdfUrl: arxivPdfUrl
        })
      ],
      extensionBridge: {
        async submitJob(job) {
          submittedJobs.push(job);
          return {
            status: "extension_job_queued",
            source: job.source,
            articleUrl: job.articleUrl,
            jobId: job.jobId,
            message: "Paper download job queued for the browser extension."
          };
        }
      }
    });

    assert.deepEqual(submittedJobs, []);
    assert.equal(result.status, "downloaded");
    assert.equal(result.source, "arxiv");
    assert.equal(result.canonicalId, "2406.06015");
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
    assert.deepEqual(stripRecordManifest(savedRecord), {
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
    assert.equal(savedRecord.download.status, "manual_fallback_opened");
    assert.equal(savedRecord.reading.status, "not_ready");
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
    assert.equal(path.basename(path.dirname(result.recordPath)).startsWith("nature-www.nature.com-"), true);
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
    assert.deepEqual(stripRecordManifest(savedRecord), {
      source: "external",
      articleUrl,
      openedUrl: articleUrl,
      recordedAt: savedRecord.recordedAt,
      handlingMethod: "system_browser_open",
      status: "external_opened"
    });
    assert.equal(savedRecord.download.status, "external_opened");
    assert.equal(savedRecord.reading.status, "not_ready");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPaper directly downloads Quantum Journal external PDFs", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-manager-"));
  const articleUrl = "https://quantum-journal.org/papers/q-2025-05-05-1728/";
  const pdfBytes = Buffer.from("%PDF-1.7\nquantum journal pdf\n", "utf8");
  const fetchCalls: string[] = [];

  try {
    const result = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      title: "Hierarchical memories",
      fetchImpl: async (url) => {
        fetchCalls.push(String(url));
        return new Response(pdfBytes, {
          status: 200,
          headers: { "content-type": "application/pdf" }
        });
      },
      openPageInSystemChromeImpl: async () => {
        throw new Error("Quantum Journal PDF should be downloaded directly.");
      }
    });

    const expectedPdfUrl = "https://quantum-journal.org/papers/q-2025-05-05-1728/pdf/";
    const expectedPdfPath = resolveExternalPaperPdfPath({ workspaceDir, articleUrl });
    const expectedRecordPath = resolvePaperRecordPath({
      workspaceDir,
      source: "external",
      articleUrl
    });
    const expectedSha256 = createHash("sha256").update(pdfBytes).digest("hex");

    assert.deepEqual(fetchCalls, [expectedPdfUrl]);
    assert.deepEqual(result, {
      status: "downloaded",
      source: "external",
      articleUrl,
      finalPdfUrl: expectedPdfUrl,
      path: expectedPdfPath,
      recordPath: expectedRecordPath,
      fileSha256: expectedSha256,
      title: "Hierarchical memories"
    });
    assert.equal(await readFile(expectedPdfPath, "utf8"), pdfBytes.toString("utf8"));
    const savedRecord = JSON.parse(await readFile(expectedRecordPath, "utf8"));
    assert.deepEqual(stripRecordManifest(savedRecord), {
      source: "external",
      articleUrl,
      recordedAt: savedRecord.recordedAt,
      handlingMethod: "direct_http",
      status: "downloaded",
      pdfUrl: expectedPdfUrl,
      downloadPath: expectedPdfPath,
      fileSha256: expectedSha256,
      title: "Hierarchical memories"
    });
    assert.equal(savedRecord.download.status, "downloaded");
    assert.equal(savedRecord.reading.status, "not_ready");

    const existing = await downloadPaper({
      workspaceDir,
      url: articleUrl,
      openPageInSystemChromeImpl: async () => {
        throw new Error("direct external paper should be found in the local index");
      }
    });

    assert.equal(existing.status, "already_downloaded");
    assert.equal(existing.source, "external");
    assert.equal(existing.finalPdfUrl, expectedPdfUrl);
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
    const savedManualRecord = JSON.parse(await readFile(expectedRecordPath, "utf8"));
    assert.deepEqual(stripRecordManifest(savedManualRecord), {
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
    assert.equal(savedManualRecord.download.status, "downloaded");
    assert.equal(savedManualRecord.reading.status, "not_ready");

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
  const downloadCalls: Array<{ workspaceDir: string; url?: string; title?: string }> = [];

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
      {
        workspaceDir,
        url: firstUrl,
        title: "On-chip direct-current source for scalable superconducting quantum computing"
      },
      {
        workspaceDir,
        url: secondUrl,
        title: "Complete Self-Testing of a System of Remote Superconducting Qubits"
      }
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
    title?: string;
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
    title?: string;
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
