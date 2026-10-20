import {
  cancelResponseBody,
  getResponseStatusError,
  readResponseBytes,
  resolveFetchTimeoutMs,
  withRequestTimeout
} from "./network.js";
import { createPublicUrlDispatcher, resolvePublicUrl, type PublicUrlResolver } from "./public-url-policy.js";

export interface FetchWebPageOptions {
  url: string;
  env?: FetchWebPageEnvironment;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  resolveHostname?: PublicUrlResolver;
}

export interface FetchWebPageEnvironment extends NodeJS.ProcessEnv {}

const DEFAULT_USER_AGENT = "pi-agent-minimal-ts/1.0";
const MAX_TEXT_LENGTH = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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
    .replace(/&#39;/gi, "'");
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
  let endpoint = normalizeUrl(options.url);
  const timeout = withRequestTimeout(resolveFetchTimeoutMs(env));

  try {
    for (let redirects = 0; redirects <= 10; redirects++) {
      const target = await resolvePublicUrl(endpoint, options.resolveHostname, timeout.signal);
      const dispatcher = createPublicUrlDispatcher(target, env);
      try {
        const init: RequestInit & { dispatcher: typeof dispatcher } = {
          headers: new Headers({ "user-agent": normalizeUserAgent(env) }),
          signal: timeout.signal, redirect: "manual", dispatcher,
        };
        const response = await fetchImpl(target.url, init);
        const location = response.headers.get("location");
        if ([301, 302, 303, 307, 308].includes(response.status) && location !== null) {
          await cancelResponseBody(response);
          if (redirects === 10) throw new Error("Too many web page redirects.");
          endpoint = new URL(location, target.url);
          continue;
        }

        if (!response.ok) {
          await cancelResponseBody(response);
          throw getResponseStatusError(response, "web page fetch");
        }

        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        const mediaType = contentType.split(";", 1)[0]?.trim();
        if (mediaType !== "text/html") {
          await cancelResponseBody(response);
          throw new Error("Expected text/html content-type.");
        }

        const bytes = await readResponseBytes(response, MAX_RESPONSE_BYTES);
        return cleanHtml(new TextDecoder().decode(bytes)).slice(0, MAX_TEXT_LENGTH);
      } finally {
        await dispatcher.destroy().catch(() => {});
      }
    }
    throw new Error("Too many web page redirects.");
  } finally {
    timeout.dispose();
  }
}
