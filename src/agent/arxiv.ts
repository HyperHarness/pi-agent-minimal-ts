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

export interface ArxivLocator {
  id: string;
  absUrl: string;
  pdfUrl: string;
}

export interface DownloadArxivPdfOptions {
  input: string;
  fetchImpl?: typeof fetch;
}

export interface DownloadArxivPdfResult {
  canonicalId: string;
  articleUrl: string;
  finalPdfUrl: string;
  pdfBytes: Buffer;
}

const MODERN_ARXIV_ID = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const LEGACY_ARXIV_ID = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/i;
const PROBABLY_MANGLED_QUERY = /^[?\uFFFD\s]+$/;

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
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

function extractEntryId(rawId: string): string {
  const normalized = rawId.trim();
  const suffix = normalized.split("/abs/").pop() ?? normalized;
  return normalizeArxivId(suffix);
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

function extractArxivIdFromUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.hostname !== "arxiv.org") {
      return null;
    }

    const path = url.pathname.replace(/\/+$/, "");
    if (path.startsWith("/abs/")) {
      return path.slice("/abs/".length);
    }

    if (path.startsWith("/pdf/")) {
      return path.slice("/pdf/".length).replace(/\.pdf$/i, "");
    }

    return null;
  } catch {
    return null;
  }
}

export function parseArxivLocator(input: string): ArxivLocator {
  const rawId = extractArxivIdFromUrl(input.trim()) ?? input.trim();
  const id = normalizeArxivId(rawId);

  return {
    id,
    absUrl: buildArxivAbsUrl(id),
    pdfUrl: buildArxivPdfUrl(id)
  };
}

export async function downloadArxivPdf(
  options: DownloadArxivPdfOptions
): Promise<DownloadArxivPdfResult> {
  const locator = parseArxivLocator(options.input);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(locator.pdfUrl);

  if (!response.ok) {
    throw new Error(`arXiv PDF download failed with HTTP ${response.status}.`);
  }

  const pdfBytes = Buffer.from(await response.arrayBuffer());
  if (pdfBytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Expected a PDF response from arXiv.");
  }

  return {
    canonicalId: locator.id,
    articleUrl: locator.absUrl,
    finalPdfUrl: response.url || locator.pdfUrl,
    pdfBytes
  };
}

function assertQueryWasNotMangled(query: string): void {
  if (!PROBABLY_MANGLED_QUERY.test(query)) {
    return;
  }

  throw new Error(
    "The arXiv query appears to have been mangled into question marks before reaching the tool. Use a UTF-8 terminal or English keywords for arXiv searches."
  );
}

export async function searchArxiv(
  options: SearchArxivOptions
): Promise<ArxivSearchResult[]> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("arXiv query is required.");
  }
  assertQueryWasNotMangled(query);

  const maxResults = options.maxResults ?? 5;
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error("maxResults must be a positive integer.");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const endpoint = new URL("https://export.arxiv.org/api/query");
  endpoint.search = `search_query=${encodeURIComponent(`all:${query}`)}&start=0&max_results=${maxResults}`;

  const response = await fetchImpl(endpoint);
  if (!response.ok) {
    throw new Error(`arXiv search failed with HTTP ${response.status}.`);
  }

  const feed = await response.text();
  return Array.from(feed.matchAll(/<entry>([\s\S]*?)<\/entry>/gi), (match) => {
    const entry = match[1] ?? "";
    const id = extractEntryId(getFirstTag(entry, "id"));

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
