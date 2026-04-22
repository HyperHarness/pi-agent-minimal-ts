# Agent Web Search And arXiv Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add general web search, page fetching, and official arXiv search/PDF access to the standalone TypeScript agent without changing the REPL contract or system prompt.

**Architecture:** Keep networking in focused helper modules under `src/agent/` and expose the capabilities through four new tools assembled by `createTools(workspaceDir)`. Use dependency injection at the tool boundary so the network clients can be tested without live HTTP and so the REPL/runtime stays unchanged.

**Tech Stack:** TypeScript, Node.js built-in `fetch`, Node test runner, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`

---

## Planned Files

- Create: `src/agent/network.ts`
  Shared request timeout, auth-header, and response parsing helpers for outbound HTTP calls.
- Create: `src/agent/web-search.ts`
  Configured web-search client for the external `POST /search` provider.
- Create: `src/agent/web-fetch.ts`
  Direct webpage fetcher with HTML-to-text cleanup and response validation.
- Create: `src/agent/arxiv.ts`
  Official arXiv metadata search client and canonical PDF URL helpers.
- Modify: `src/agent/tools.ts`
  Add new tool schemas, dependency injection hooks, and tool assembly.
- Create: `test/agent/web-search.test.ts`
  Search-client tests for env configuration, auth headers, payload mapping, and upstream failures.
- Create: `test/agent/web-fetch.test.ts`
  Fetch-client tests for URL validation, HTML cleanup, truncation, and content-type rejection.
- Create: `test/agent/arxiv.test.ts`
  arXiv-client tests for Atom feed parsing and canonical URL generation.
- Modify: `test/agent/tools.test.ts`
  Tool-registration and tool-execution tests for the new tools using injected client doubles.
- Modify: `README.md`
  Document search env vars, new tools, arXiv usage, and expected runtime behavior.

### Task 1: Add Web Search Client

**Files:**
- Create: `src/agent/network.ts`
- Create: `src/agent/web-search.ts`
- Test: `test/agent/web-search.test.ts`

- [ ] **Step 1: Write the failing web-search tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { searchWeb } from "../../src/agent/web-search.js";

function createJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

test("searchWeb sends the provider request and normalizes results", async () => {
  let observedUrl = "";
  let observedMethod = "";
  let observedAuthHeader = "";
  let observedBody = "";

  const results = await searchWeb({
    query: "nasdaq composite index now",
    maxResults: 3,
    env: {
      PI_SEARCH_API_URL: "https://search.example.test/search",
      PI_SEARCH_API_KEY: "secret-key",
      PI_FETCH_TIMEOUT_MS: "4321"
    },
    fetchImpl: async (input, init) => {
      observedUrl = String(input);
      observedMethod = init?.method ?? "";
      observedAuthHeader = new Headers(init?.headers).get("authorization") ?? "";
      observedBody = String(init?.body ?? "");

      return createJsonResponse({
        results: [
          {
            title: "NASDAQ Composite Index",
            url: "https://example.test/nasdaq",
            snippet: "Latest market summary"
          }
        ]
      });
    }
  });

  assert.equal(observedUrl, "https://search.example.test/search");
  assert.equal(observedMethod, "POST");
  assert.equal(observedAuthHeader, "Bearer secret-key");
  assert.deepEqual(JSON.parse(observedBody), {
    query: "nasdaq composite index now",
    maxResults: 3
  });
  assert.deepEqual(results, [
    {
      title: "NASDAQ Composite Index",
      url: "https://example.test/nasdaq",
      snippet: "Latest market summary"
    }
  ]);
});

test("searchWeb fails when PI_SEARCH_API_URL is missing", async () => {
  await assert.rejects(
    () =>
      searchWeb({
        query: "jay chou latest concert",
        env: {},
        fetchImpl: async () => {
          throw new Error("fetch should not run without configuration");
        }
      }),
    /PI_SEARCH_API_URL/i
  );
});

test("searchWeb surfaces upstream HTTP failures", async () => {
  await assert.rejects(
    () =>
      searchWeb({
        query: "nasdaq now",
        env: { PI_SEARCH_API_URL: "https://search.example.test/search" },
        fetchImpl: async () =>
          createJsonResponse({ error: "bad gateway" }, { status: 502 })
      }),
    /502/
  );
});
```

- [ ] **Step 2: Run the targeted test to verify the red state**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/web-search.test.js
```

Expected: FAIL because `searchWeb` and its helper module do not exist yet.

- [ ] **Step 3: Write the minimal shared network helper and search client**

`src/agent/network.ts`

```ts
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export function resolveFetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_FETCH_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("PI_FETCH_TIMEOUT_MS must be a positive number.");
  }

  return parsed;
}

export function withRequestTimeout(timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer)
  };
}

export function getBearerHeaders(apiKey: string | undefined): Headers {
  const headers = new Headers();
  if (apiKey?.trim()) {
    headers.set("authorization", `Bearer ${apiKey.trim()}`);
  }

  return headers;
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`Expected a JSON response but received '${contentType || "unknown"}'.`);
  }

  return response.json();
}

export function getResponseStatusError(response: Response, context: string): Error {
  return new Error(`${context} failed with HTTP ${response.status}.`);
}
```

`src/agent/web-search.ts`

```ts
import {
  getBearerHeaders,
  getResponseStatusError,
  parseJsonResponse,
  resolveFetchTimeoutMs,
  withRequestTimeout
} from "./network.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchWebOptions {
  query: string;
  maxResults?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

type SearchApiResponse = {
  results?: Array<{
    title?: unknown;
    url?: unknown;
    snippet?: unknown;
  }>;
};

export async function searchWeb(options: SearchWebOptions): Promise<WebSearchResult[]> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("Search query is required.");
  }

  const env = options.env ?? process.env;
  const endpoint = env.PI_SEARCH_API_URL?.trim();
  if (!endpoint) {
    throw new Error("PI_SEARCH_API_URL is not configured.");
  }

  const maxResults = options.maxResults ?? 5;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = resolveFetchTimeoutMs(env);
  const { signal, dispose } = withRequestTimeout(timeoutMs);
  const headers = getBearerHeaders(env.PI_SEARCH_API_KEY);
  headers.set("content-type", "application/json");

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, maxResults }),
      signal
    });

    if (!response.ok) {
      throw getResponseStatusError(response, "Web search");
    }

    const body = (await parseJsonResponse(response)) as SearchApiResponse;
    return (body.results ?? []).flatMap((result) => {
      if (
        typeof result.title !== "string" ||
        typeof result.url !== "string" ||
        typeof result.snippet !== "string"
      ) {
        return [];
      }

      return [
        {
          title: result.title,
          url: result.url,
          snippet: result.snippet
        }
      ];
    });
  } finally {
    dispose();
  }
}
```

- [ ] **Step 4: Run the targeted test to verify the green state**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/web-search.test.js
```

Expected: PASS with `3` tests and `0` failures.

- [ ] **Step 5: Commit**

```bash
git add src/agent/network.ts src/agent/web-search.ts test/agent/web-search.test.ts
git commit -m "Add web search client"
```

### Task 2: Add Web Fetch Client

**Files:**
- Create: `src/agent/web-fetch.ts`
- Test: `test/agent/web-fetch.test.ts`

- [ ] **Step 1: Write the failing web-fetch tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { fetchWebPage } from "../../src/agent/web-fetch.js";

function createHtmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init
  });
}

test("fetchWebPage rejects non-http URLs", async () => {
  await assert.rejects(
    () =>
      fetchWebPage({
        url: "file:///tmp/test.html",
        fetchImpl: async () => {
          throw new Error("fetch should not run for unsupported URLs");
        }
      }),
    /http/i
  );
});

test("fetchWebPage removes scripts and returns cleaned text", async () => {
  const result = await fetchWebPage({
    url: "https://example.test/article",
    fetchImpl: async () =>
      createHtmlResponse(`
        <html>
          <head>
            <style>.hidden { display: none; }</style>
            <script>window.bad = true;</script>
          </head>
          <body>
            <h1>Headline</h1>
            <p>First paragraph.</p>
            <noscript>ignore me</noscript>
          </body>
        </html>
      `)
  });

  assert.equal(result.url, "https://example.test/article");
  assert.equal(result.contentType, "text/html; charset=utf-8");
  assert.match(result.text, /Headline First paragraph\./);
  assert.doesNotMatch(result.text, /window\.bad|ignore me|hidden/);
});

test("fetchWebPage rejects non-html responses", async () => {
  await assert.rejects(
    () =>
      fetchWebPage({
        url: "https://example.test/data.json",
        fetchImpl: async () =>
          new Response('{"ok":true}', {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      }),
    /HTML/i
  );
});

test("fetchWebPage truncates very large pages", async () => {
  const hugeParagraph = `<p>${"A".repeat(20_000)}</p>`;
  const result = await fetchWebPage({
    url: "https://example.test/huge",
    fetchImpl: async () => createHtmlResponse(`<html><body>${hugeParagraph}</body></html>`)
  });

  assert.ok(result.text.length <= 12_000);
});
```

- [ ] **Step 2: Run the targeted test to verify the red state**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/web-fetch.test.js
```

Expected: FAIL because `fetchWebPage` does not exist yet.

- [ ] **Step 3: Write the minimal webpage fetcher**

`src/agent/web-fetch.ts`

```ts
import {
  getResponseStatusError,
  resolveFetchTimeoutMs,
  withRequestTimeout
} from "./network.js";

const MAX_FETCH_TEXT_LENGTH = 12_000;

export interface FetchedWebPage {
  url: string;
  contentType: string;
  text: string;
}

export interface FetchWebPageOptions {
  url: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchWebPage(options: FetchWebPageOptions): Promise<FetchedWebPage> {
  const targetUrl = new URL(options.url);
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }

  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = resolveFetchTimeoutMs(env);
  const { signal, dispose } = withRequestTimeout(timeoutMs);

  try {
    const response = await fetchImpl(targetUrl, {
      headers: {
        "user-agent": env.PI_FETCH_USER_AGENT?.trim() || "pi-agent-minimal-ts/1.0"
      },
      signal
    });

    if (!response.ok) {
      throw getResponseStatusError(response, "Web fetch");
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error(`Expected HTML content but received '${contentType || "unknown"}'.`);
    }

    const html = await response.text();
    return {
      url: targetUrl.toString(),
      contentType,
      text: stripHtml(html).slice(0, MAX_FETCH_TEXT_LENGTH)
    };
  } finally {
    dispose();
  }
}
```

- [ ] **Step 4: Run the targeted test to verify the green state**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/web-fetch.test.js
```

Expected: PASS with `4` tests and `0` failures.

- [ ] **Step 5: Commit**

```bash
git add src/agent/network.ts src/agent/web-fetch.ts test/agent/web-fetch.test.ts
git commit -m "Add webpage fetch client"
```

### Task 3: Add Official arXiv Search And PDF Helpers

**Files:**
- Create: `src/agent/arxiv.ts`
- Test: `test/agent/arxiv.test.ts`

- [ ] **Step 1: Write the failing arXiv tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildArxivPdfUrl, searchArxiv } from "../../src/agent/arxiv.js";

const sampleFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2501.01234v1</id>
    <title> Example Paper Title </title>
    <summary> Example summary text. </summary>
    <author><name>Alice Example</name></author>
    <author><name>Bob Example</name></author>
  </entry>
</feed>`;

test("searchArxiv parses the Atom response into compact result objects", async () => {
  let observedUrl = "";

  const results = await searchArxiv({
    query: "agent memory",
    maxResults: 2,
    fetchImpl: async (input) => {
      observedUrl = String(input);
      return new Response(sampleFeed, {
        status: 200,
        headers: { "content-type": "application/atom+xml" }
      });
    }
  });

  assert.match(observedUrl, /export\.arxiv\.org\/api\/query/);
  assert.match(observedUrl, /search_query=all%3Aagent%20memory/);
  assert.match(observedUrl, /max_results=2/);
  assert.deepEqual(results, [
    {
      id: "2501.01234",
      title: "Example Paper Title",
      authors: ["Alice Example", "Bob Example"],
      summary: "Example summary text.",
      absUrl: "https://arxiv.org/abs/2501.01234",
      pdfUrl: "https://arxiv.org/pdf/2501.01234.pdf"
    }
  ]);
});

test("buildArxivPdfUrl accepts legacy identifiers", () => {
  assert.equal(
    buildArxivPdfUrl("hep-th/9901001"),
    "https://arxiv.org/pdf/hep-th/9901001.pdf"
  );
});

test("buildArxivPdfUrl rejects malformed identifiers", () => {
  assert.throws(() => buildArxivPdfUrl("not an arxiv id"), /arXiv/i);
});
```

- [ ] **Step 2: Run the targeted test to verify the red state**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/arxiv.test.js
```

Expected: FAIL because the arXiv helper module does not exist yet.

- [ ] **Step 3: Write the minimal arXiv client**

`src/agent/arxiv.ts`

```ts
export interface ArxivSearchResult {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  absUrl: string;
  pdfUrl: string;
}

export interface SearchArxivOptions {
  query: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

const MODERN_ARXIV_ID = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const LEGACY_ARXIV_ID = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/i;

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function collapseWhitespace(text: string): string {
  return decodeXml(text).replace(/\s+/g, " ").trim();
}

function stripVersion(arxivId: string): string {
  return arxivId.replace(/v\d+$/i, "");
}

function getFirstTag(entry: string, tagName: string): string {
  const match = entry.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return collapseWhitespace(match?.[1] ?? "");
}

function getAllTags(entry: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "gi");
  return Array.from(entry.matchAll(pattern), (match) => collapseWhitespace(match[1] ?? ""))
    .filter(Boolean);
}

export function normalizeArxivId(id: string): string {
  const trimmed = id.trim();
  if (!MODERN_ARXIV_ID.test(trimmed) && !LEGACY_ARXIV_ID.test(trimmed)) {
    throw new Error("A valid arXiv identifier is required.");
  }

  return stripVersion(trimmed);
}

export function buildArxivAbsUrl(id: string): string {
  return `https://arxiv.org/abs/${normalizeArxivId(id)}`;
}

export function buildArxivPdfUrl(id: string): string {
  return `https://arxiv.org/pdf/${normalizeArxivId(id)}.pdf`;
}

export async function searchArxiv(options: SearchArxivOptions): Promise<ArxivSearchResult[]> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("arXiv query is required.");
  }

  const maxResults = options.maxResults ?? 5;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL("https://export.arxiv.org/api/query");
  endpoint.searchParams.set("search_query", `all:${query}`);
  endpoint.searchParams.set("start", "0");
  endpoint.searchParams.set("max_results", String(maxResults));

  const response = await fetchImpl(endpoint);
  if (!response.ok) {
    throw new Error(`arXiv search failed with HTTP ${response.status}.`);
  }

  const feed = await response.text();
  return Array.from(feed.matchAll(/<entry>([\s\S]*?)<\/entry>/gi), (match) => {
    const entry = match[1] ?? "";
    const rawId = getFirstTag(entry, "id").split("/abs/").pop() ?? "";
    const id = normalizeArxivId(rawId);

    return {
      id,
      title: getFirstTag(entry, "title"),
      authors: getAllTags(entry, "name"),
      summary: getFirstTag(entry, "summary"),
      absUrl: buildArxivAbsUrl(id),
      pdfUrl: buildArxivPdfUrl(id)
    };
  });
}
```

- [ ] **Step 4: Run the targeted test to verify the green state**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/arxiv.test.js
```

Expected: PASS with `3` tests and `0` failures.

- [ ] **Step 5: Commit**

```bash
git add src/agent/arxiv.ts test/agent/arxiv.test.ts
git commit -m "Add arXiv search helpers"
```

### Task 4: Wire The New Tools And Update Docs

**Files:**
- Modify: `src/agent/tools.ts`
- Modify: `test/agent/tools.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing tool and documentation tests**

Append to `test/agent/tools.test.ts`:

```ts
type WebSearchTool = {
  execute: (
    toolCallId: string,
    args: { query: string; maxResults?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type FetchUrlTool = {
  execute: (
    toolCallId: string,
    args: { url: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type SearchArxivTool = {
  execute: (
    toolCallId: string,
    args: { query: string; maxResults?: number },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type DownloadArxivPdfTool = {
  execute: (
    toolCallId: string,
    args: { id: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

function getTool<TTool extends { execute: (...args: never[]) => Promise<ToolResult> }>(
  workspace: string,
  name: string,
  dependencies?: Parameters<typeof createTools>[1],
): TTool {
  const tools = createTools(workspace, dependencies) as ReadonlyArray<{
    name: string;
    execute?: TTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as TTool;
}

test("createTools exposes the web and arXiv tools", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const tools = createTools(workspace);
    const names = tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      "get_time",
      "read_file",
      "web_search",
      "fetch_url",
      "search_arxiv",
      "download_arxiv_pdf"
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("web_search delegates to the search client", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const webSearchTool = getTool<WebSearchTool>(workspace, "web_search", {
      searchWeb: async ({ query, maxResults }) => {
        assert.equal(query, "nasdaq composite index now");
        assert.equal(maxResults, 2);
        return [
          {
            title: "NASDAQ Composite",
            url: "https://example.test/nasdaq",
            snippet: "Latest market summary"
          }
        ];
      }
    });

    const result = await webSearchTool.execute(
      "call-search",
      { query: "nasdaq composite index now", maxResults: 2 },
      undefined
    );

    assert.match(JSON.stringify(result.content), /NASDAQ Composite/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("download_arxiv_pdf returns the canonical PDF URL", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const downloadTool = getTool<DownloadArxivPdfTool>(workspace, "download_arxiv_pdf");
    const result = await downloadTool.execute("call-pdf", { id: "2501.01234v2" }, undefined);
    assert.match(JSON.stringify(result.content), /https:\/\/arxiv\.org\/pdf\/2501\.01234\.pdf/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the targeted test to verify the red state**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/tools.test.js
```

Expected: FAIL because the new tools are not registered yet and `createTools()` does not accept injected dependencies.

- [ ] **Step 3: Wire the tools, widen the tool type, and document the feature**

Replace `src/agent/tools.ts` with:

```ts
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { buildArxivPdfUrl, searchArxiv, type ArxivSearchResult } from "./arxiv.js";
import { fetchWebPage, type FetchedWebPage } from "./web-fetch.js";
import { searchWeb, type WebSearchResult } from "./web-search.js";

const getTimeParameters = Type.Object({
  timezone: Type.Optional(Type.String({ description: "Optional IANA timezone name." }))
});

const readFileParameters = Type.Object({
  path: Type.String({ description: "Relative UTF-8 text file path inside the workspace." })
});

const webSearchParameters = Type.Object({
  query: Type.String({ description: "Search query for current web information." }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 }))
});

const fetchUrlParameters = Type.Object({
  url: Type.String({ description: "Public http or https URL to inspect." })
});

const searchArxivParameters = Type.Object({
  query: Type.String({ description: "Search query for arXiv papers." }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 }))
});

const downloadArxivPdfParameters = Type.Object({
  id: Type.String({ description: "Canonical arXiv identifier such as 2501.01234 or hep-th/9901001." })
});

type GetTimeParameters = Static<typeof getTimeParameters>;
type ReadFileParameters = Static<typeof readFileParameters>;
type WebSearchParameters = Static<typeof webSearchParameters>;
type FetchUrlParameters = Static<typeof fetchUrlParameters>;
type SearchArxivParameters = Static<typeof searchArxivParameters>;
type DownloadArxivPdfParameters = Static<typeof downloadArxivPdfParameters>;

export interface ToolDependencies {
  searchWeb?: typeof searchWeb;
  fetchWebPage?: typeof fetchWebPage;
  searchArxiv?: typeof searchArxiv;
  buildArxivPdfUrl?: typeof buildArxivPdfUrl;
}

export type AgentTools = ReadonlyArray<AgentTool<any, any>>;

function assertPathInsideDirectory(rootDir: string, candidatePath: string): void {
  const relativePath = path.relative(rootDir, candidatePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Requested path is outside the workspace.");
  }
}

async function resolveWorkspacePath(workspaceDir: string, requestedPath: string): Promise<string> {
  if (!requestedPath.trim()) {
    throw new Error("Path is required.");
  }

  if (path.isAbsolute(requestedPath)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedPath = path.resolve(resolvedWorkspaceDir, requestedPath);
  assertPathInsideDirectory(resolvedWorkspaceDir, resolvedPath);

  const [realWorkspaceDir, realResolvedPath] = await Promise.all([
    realpath(resolvedWorkspaceDir),
    realpath(resolvedPath)
  ]);
  assertPathInsideDirectory(realWorkspaceDir, realResolvedPath);

  return realResolvedPath;
}

function formatSearchResults(results: WebSearchResult[] | ArxivSearchResult[]): string {
  return JSON.stringify(results, null, 2);
}

function formatFetchedPage(result: FetchedWebPage): string {
  return JSON.stringify(result, null, 2);
}

export function createTools(
  workspaceDir: string,
  dependencies: ToolDependencies = {}
): AgentTools {
  const searchWebImpl = dependencies.searchWeb ?? searchWeb;
  const fetchWebPageImpl = dependencies.fetchWebPage ?? fetchWebPage;
  const searchArxivImpl = dependencies.searchArxiv ?? searchArxiv;
  const buildArxivPdfUrlImpl = dependencies.buildArxivPdfUrl ?? buildArxivPdfUrl;

  const getTimeTool: AgentTool<typeof getTimeParameters, { timezone: string }> = {
    name: "get_time",
    label: "Get Time",
    description: "Returns the current time, optionally formatted for a specific timezone.",
    parameters: getTimeParameters,
    execute: async (_toolCallId: string, args: GetTimeParameters) => {
      const timezone = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const formatter = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: args.timezone
      });

      return {
        content: [{ type: "text", text: formatter.format(new Date()) }],
        details: { timezone }
      };
    }
  };

  const readFileTool: AgentTool<typeof readFileParameters, { path: string }> = {
    name: "read_file",
    label: "Read File",
    description: "Reads a UTF-8 text file from inside the workspace.",
    parameters: readFileParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: ReadFileParameters) => {
      const resolvedPath = await resolveWorkspacePath(workspaceDir, args.path);
      const content = await readFile(resolvedPath, "utf8");

      return {
        content: [{ type: "text", text: content }],
        details: { path: args.path }
      };
    }
  };

  const webSearchTool: AgentTool<typeof webSearchParameters, { query: string; maxResults: number }> = {
    name: "web_search",
    label: "Web Search",
    description: "Searches the web for current information and returns titles, URLs, and snippets.",
    parameters: webSearchParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: WebSearchParameters) => {
      const maxResults = args.maxResults ?? 5;
      const results = await searchWebImpl({ query: args.query, maxResults });

      return {
        content: [{ type: "text", text: formatSearchResults(results) }],
        details: { query: args.query, maxResults, count: results.length }
      };
    }
  };

  const fetchUrlTool: AgentTool<typeof fetchUrlParameters, { url: string }> = {
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetches a public webpage and returns cleaned text for source verification.",
    parameters: fetchUrlParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: FetchUrlParameters) => {
      const result = await fetchWebPageImpl({ url: args.url });

      return {
        content: [{ type: "text", text: formatFetchedPage(result) }],
        details: { url: result.url, contentType: result.contentType, textLength: result.text.length }
      };
    }
  };

  const searchArxivTool: AgentTool<typeof searchArxivParameters, { query: string; maxResults: number }> = {
    name: "search_arxiv",
    label: "Search arXiv",
    description: "Searches arXiv papers using the official arXiv metadata API.",
    parameters: searchArxivParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: SearchArxivParameters) => {
      const maxResults = args.maxResults ?? 5;
      const results = await searchArxivImpl({ query: args.query, maxResults });

      return {
        content: [{ type: "text", text: formatSearchResults(results) }],
        details: { query: args.query, maxResults, count: results.length }
      };
    }
  };

  const downloadArxivPdfTool: AgentTool<typeof downloadArxivPdfParameters, { id: string; pdfUrl: string }> = {
    name: "download_arxiv_pdf",
    label: "Download arXiv PDF",
    description: "Returns the official PDF URL for an arXiv paper identifier.",
    parameters: downloadArxivPdfParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: DownloadArxivPdfParameters) => {
      const pdfUrl = buildArxivPdfUrlImpl(args.id);

      return {
        content: [{ type: "text", text: pdfUrl }],
        details: { id: args.id, pdfUrl }
      };
    }
  };

  return [
    getTimeTool,
    readFileTool,
    webSearchTool,
    fetchUrlTool,
    searchArxivTool,
    downloadArxivPdfTool
  ];
}
```

Append to `README.md`:

````md
## Search Configuration

To enable general web search, configure a compatible search service:

```powershell
$env:PI_SEARCH_API_URL="https://your-search-service.example.com/search"
$env:PI_SEARCH_API_KEY="your-api-key"
$env:PI_FETCH_USER_AGENT="pi-agent-minimal-ts/1.0"
$env:PI_FETCH_TIMEOUT_MS="10000"
```

`PI_SEARCH_API_URL` must accept `POST` requests with:

```json
{
  "query": "nasdaq composite index now",
  "maxResults": 5
}
```

and respond with:

```json
{
  "results": [
    {
      "title": "NASDAQ Composite Index",
      "url": "https://example.com/nasdaq",
      "snippet": "Latest market summary..."
    }
  ]
}
```

## Additional Tools

- `web_search`: searches the configured web-search provider for current information
- `fetch_url`: fetches a public webpage and returns cleaned text
- `search_arxiv`: searches arXiv papers through the official arXiv API
- `download_arxiv_pdf`: returns the canonical arXiv PDF URL for a paper ID

Example prompts:

```text
what is the latest nasdaq composite index level?
find recent Jay Chou concert schedule updates
search arxiv for agent memory papers
give me the PDF for arXiv 2501.01234
```
````

- [ ] **Step 4: Run the targeted tool test and the full suite**

Run:

```powershell
npm.cmd run build
node --test --test-isolation=none dist/test/agent/tools.test.js
npm.cmd test
```

Expected:
- targeted tool tests PASS
- full suite PASS with `37` tests and `0` failures

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts test/agent/tools.test.ts README.md
git commit -m "Wire web and arXiv tools into the agent"
```
