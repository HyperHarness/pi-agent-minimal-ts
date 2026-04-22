import {
  getResponseStatusError,
  resolveFetchTimeoutMs,
  withRequestTimeout
} from "./network.js";

export interface FetchWebPageOptions {
  url: string;
  env?: FetchWebPageEnvironment;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface FetchWebPageEnvironment extends NodeJS.ProcessEnv {}

const DEFAULT_USER_AGENT = "pi-agent-minimal-ts/1.0";
const MAX_TEXT_LENGTH = 12_000;

function normalizeUrl(url: string): URL {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error("URL is required.");
  }

  const parsedUrl = new URL(trimmedUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }

  return parsedUrl;
}

function normalizeUserAgent(env: FetchWebPageEnvironment): string {
  const userAgent = env.PI_FETCH_USER_AGENT?.trim();
  return userAgent || DEFAULT_USER_AGENT;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, value: string) => String.fromCharCode(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) => String.fromCharCode(Number.parseInt(value, 16)));
}

function cleanHtml(html: string): string {
  const withoutBlocks = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(withoutTags);
  return decoded.replace(/\s+/g, " ").trim();
}

export async function fetchWebPage(
  options: FetchWebPageOptions
): Promise<string> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const endpoint = normalizeUrl(options.url);
  const timeout = withRequestTimeout(resolveFetchTimeoutMs(env));

  try {
    const response = await fetchImpl(endpoint, {
      headers: new Headers({
        "user-agent": normalizeUserAgent(env)
      }),
      signal: timeout.signal
    });

    if (!response.ok) {
      throw getResponseStatusError(response, "web page fetch");
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html")) {
      throw new Error("Expected text/html content-type.");
    }

    return cleanHtml(await response.text()).slice(0, MAX_TEXT_LENGTH);
  } finally {
    timeout.dispose();
  }
}
