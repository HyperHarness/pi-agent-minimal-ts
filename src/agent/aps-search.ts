import type { PaperSearchResult } from "./paper-types.js";

export interface SearchApsPapersOptions {
  query: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

type CrossrefAuthor = {
  given?: unknown;
  family?: unknown;
  name?: unknown;
};

type CrossrefItem = {
  DOI?: unknown;
  title?: unknown;
  abstract?: unknown;
  author?: unknown;
  published?: unknown;
  "container-title"?: unknown;
};

function normalizeQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("Query is required.");
  }

  return trimmed
    .replace(/超导/g, " superconducting ")
    .replace(/量子计算/g, " quantum computing ")
    .replace(/量子比特/g, " qubit ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMaxResults(maxResults: number | undefined): number {
  if (maxResults === undefined) {
    return 3;
  }

  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error("maxResults must be a positive integer.");
  }

  return maxResults;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" ? [item] : [])) : [];
}

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function getPublishedTime(value: unknown): number {
  if (!value || typeof value !== "object" || !("date-parts" in value)) {
    return 0;
  }

  const dateParts = value["date-parts"];
  if (!Array.isArray(dateParts) || !Array.isArray(dateParts[0])) {
    return 0;
  }

  const [year, month = 1, day = 1] = dateParts[0];
  if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number") {
    return 0;
  }

  return Date.UTC(year, month - 1, day);
}

function formatPublishedDate(value: unknown): string | null {
  const time = getPublishedTime(value);
  if (time === 0) {
    return null;
  }

  return new Date(time).toISOString().slice(0, 10);
}

function formatAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((author: CrossrefAuthor) => {
    if (typeof author.name === "string" && author.name.trim()) {
      return [author.name.trim()];
    }

    const parts = [author.given, author.family].flatMap((part) =>
      typeof part === "string" && part.trim() ? [part.trim()] : []
    );
    return parts.length > 0 ? [parts.join(" ")] : [];
  });
}

function buildCandidateText(item: CrossrefItem): string {
  return [
    ...getStringArray(item.title),
    ...getStringArray(item["container-title"]),
    typeof item.abstract === "string" ? stripMarkup(item.abstract) : ""
  ]
    .join(" ")
    .toLowerCase();
}

function isRelevantToQuery(item: CrossrefItem, query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  const text = buildCandidateText(item);

  if (normalizedQuery.includes("superconduct") && !text.includes("superconduct")) {
    return false;
  }

  if (
    normalizedQuery.includes("quantum") &&
    !/\b(quantum|qubit|qubits)\b/i.test(text)
  ) {
    return false;
  }

  if (/\b(computing|computation|computer|compute)\b/i.test(normalizedQuery)) {
    const computingText =
      /\b(comput|qubit|processor|circuit|gate|device)\w*\b/i.test(text) ||
      /\bsuperconducting\s+qubits?\b/i.test(text);
    if (!computingText) {
      return false;
    }
  }

  if (
    normalizedQuery.includes("superconduct") &&
    normalizedQuery.includes("quantum") &&
    !/\b(quantum\s+comput|superconducting\s+qubit|superconducting\s+processor|superconducting\s+circuit|gate)\w*\b/i.test(text)
  ) {
    return false;
  }

  return true;
}

const APS_JOURNAL_SLUGS = new Map<string, string>([
  ["physical review letters", "prl"],
  ["physical review x", "prx"],
  ["prx quantum", "prxquantum"],
  ["physical review a", "pra"],
  ["physical review b", "prb"],
  ["physical review c", "prc"],
  ["physical review d", "prd"],
  ["physical review e", "pre"],
  ["physical review applied", "prapplied"],
  ["physical review research", "prresearch"],
  ["physical review materials", "prmaterials"],
  ["physical review fluids", "prfluids"],
  ["reviews of modern physics", "rmp"],
  ["physics", "physics"]
]);

function encodeApsDoiPath(doi: string): string {
  return encodeURIComponent(doi).replace(/%2F/gi, "/");
}

function getApsJournalSlug(containerTitle: string | undefined): string | null {
  const normalizedTitle = containerTitle?.trim().toLowerCase();
  return normalizedTitle ? APS_JOURNAL_SLUGS.get(normalizedTitle) ?? null : null;
}

function toApsArticleUrl(input: {
  doi: string;
  containerTitle?: string;
}): string {
  const doiPath = encodeApsDoiPath(input.doi);
  const journalSlug = getApsJournalSlug(input.containerTitle);
  return journalSlug
    ? `https://journals.aps.org/${journalSlug}/abstract/${doiPath}`
    : `https://journals.aps.org/doi/${doiPath}`;
}

function toPaperSearchResult(item: CrossrefItem): PaperSearchResult | null {
  if (typeof item.DOI !== "string" || !item.DOI.trim()) {
    return null;
  }

  const title = stripMarkup(getStringArray(item.title)[0] ?? "");
  if (!title) {
    return null;
  }

  const doi = item.DOI.trim();
  const journal = getStringArray(item["container-title"])[0]?.trim();
  const articleUrl = toApsArticleUrl({
    doi,
    containerTitle: journal
  });
  const publishedDate = formatPublishedDate(item.published);
  const abstract = typeof item.abstract === "string" ? stripMarkup(item.abstract) : "";
  const summaryParts = [
    publishedDate ? `Published ${publishedDate}` : null,
    journal ? `in ${journal}` : null,
    abstract
  ].flatMap((part) => (part ? [part] : []));

  return {
    title: title.replace(/\s+/g, " "),
    authors: formatAuthors(item.author),
    summary: summaryParts.join(". "),
    primarySource: "aps",
    primaryAction: "authorized_download",
    sources: [
      {
        source: "aps",
        action: "authorized_download",
        canonicalId: doi,
        articleUrl
      }
    ]
  };
}

export async function searchApsPapers(options: SearchApsPapersOptions): Promise<PaperSearchResult[]> {
  const query = normalizeQuery(options.query);
  const maxResults = normalizeMaxResults(options.maxResults);
  const rows = 200;
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("filter", "prefix:10.1103,type:journal-article");
  url.searchParams.set("sort", "published");
  url.searchParams.set("order", "desc");
  url.searchParams.set("rows", String(rows));

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`APS search request failed with HTTP ${response.status}.`);
  }

  const parsed = (await response.json()) as { message?: { items?: unknown } };
  const items = Array.isArray(parsed.message?.items) ? parsed.message.items : [];
  return items
    .flatMap((item) => (typeof item === "object" && item !== null ? [item as CrossrefItem] : []))
    .filter((item) => isRelevantToQuery(item, query))
    .sort((left, right) => getPublishedTime(right.published) - getPublishedTime(left.published))
    .flatMap((item) => {
      const result = toPaperSearchResult(item);
      return result ? [result] : [];
    })
    .slice(0, maxResults);
}
