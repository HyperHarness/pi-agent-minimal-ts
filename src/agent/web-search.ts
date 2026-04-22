import {
  getBearerHeaders,
  getResponseStatusError,
  parseJsonResponse,
  resolveFetchTimeoutMs,
  withRequestTimeout
} from "./network.js";

export interface SearchWebOptions {
  query: string;
  maxResults?: number;
  env?: SearchWebEnvironment;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface SearchWebEnvironment extends NodeJS.ProcessEnv {}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function isTavilyEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname === "api.tavily.com";
  } catch {
    return false;
  }
}

function normalizeSearchResult(result: unknown): WebSearchResult | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const title = "title" in result && typeof result.title === "string" ? result.title : null;
  const url = "url" in result && typeof result.url === "string" ? result.url : null;
  const snippet =
    "snippet" in result && typeof result.snippet === "string"
      ? result.snippet
      : "content" in result && typeof result.content === "string"
        ? result.content
        : null;

  if (!title || !url || !snippet) {
    return null;
  }

  return { title, url, snippet };
}

function normalizeQuery(query: string): string {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error("Query is required.");
  }

  return normalizedQuery;
}

function normalizeMaxResults(maxResults: number | undefined): number {
  if (maxResults === undefined) {
    return 5;
  }

  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error("maxResults must be a positive integer.");
  }

  return maxResults;
}

export async function searchWeb(
  options: SearchWebOptions
): Promise<WebSearchResult[]> {
  const env = options.env ?? process.env;
  const endpoint = env.PI_SEARCH_API_URL?.trim();
  if (!endpoint) {
    throw new Error("PI_SEARCH_API_URL is not configured.");
  }

  const normalizedQuery = normalizeQuery(options.query);
  const normalizedMaxResults = normalizeMaxResults(options.maxResults);
  const requestBody = {
    query: normalizedQuery,
    ...(isTavilyEndpoint(endpoint)
      ? { max_results: normalizedMaxResults }
      : { maxResults: normalizedMaxResults })
  };
  const headers = new Headers({
    "content-type": "application/json"
  });

  if (env.PI_SEARCH_API_KEY?.trim()) {
    const bearerHeaders = getBearerHeaders(env.PI_SEARCH_API_KEY.trim());
    bearerHeaders.forEach((value, key) => headers.set(key, value));
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = resolveFetchTimeoutMs(env);
  const timeout = withRequestTimeout(timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: timeout.signal
    });

    if (!response.ok) {
      throw getResponseStatusError(response, "web search request");
    }

    const parsedResponse = (await parseJsonResponse(response)) as { results?: unknown };
    const results = Array.isArray(parsedResponse.results) ? parsedResponse.results : [];

    return results.flatMap((result) => {
      const normalizedResult = normalizeSearchResult(result);
      return normalizedResult ? [normalizedResult] : [];
    });
  } finally {
    timeout.dispose();
  }
}
