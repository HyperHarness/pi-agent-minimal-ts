import test from "node:test";
import assert from "node:assert/strict";
import { searchPapers } from "../../src/agent/paper-manager.js";
import type { ArxivSearchResult } from "../../src/agent/arxiv.js";
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
