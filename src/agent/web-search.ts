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
}

export interface SearchWebEnvironment extends NodeJS.ProcessEnv {}

export interface SearchWebRuntime {
  env?: SearchWebEnvironment;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface SearchWebResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchWebResponse {
  results: SearchWebResult[];
}

function normalizeQuery(query: string): string {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error("Query is required.");
  }

  return normalizedQuery;
}

function normalizeMaxResults(maxResults: number | undefined): number {
  const requestedMaxResults = maxResults ?? 5;
  if (!Number.isFinite(requestedMaxResults)) {
    return 5;
  }

  return Math.max(1, Math.min(10, Math.floor(requestedMaxResults)));
}

export async function searchWeb(
  options: SearchWebOptions,
  runtime: SearchWebRuntime = {}
): Promise<SearchWebResponse> {
  const env = runtime.env ?? process.env;
  const endpoint = env.PI_SEARCH_API_URL?.trim();
  if (!endpoint) {
    throw new Error("PI_SEARCH_API_URL is not configured.");
  }

  const requestBody = {
    query: normalizeQuery(options.query),
    maxResults: normalizeMaxResults(options.maxResults)
  };
  const headers = new Headers({
    "content-type": "application/json"
  });

  if (env.PI_SEARCH_API_KEY?.trim()) {
    const bearerHeaders = getBearerHeaders(env.PI_SEARCH_API_KEY.trim());
    bearerHeaders.forEach((value, key) => headers.set(key, value));
  }

  const fetchImpl = runtime.fetch ?? globalThis.fetch.bind(globalThis);
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

    const parsedResponse = (await parseJsonResponse(response)) as Partial<SearchWebResponse>;
    const results = Array.isArray(parsedResponse.results) ? parsedResponse.results : [];

    return {
      results: results.filter(
        (result): result is SearchWebResult =>
          !!result &&
          typeof result.title === "string" &&
          typeof result.url === "string"
      )
    };
  } finally {
    timeout.clear();
  }
}
