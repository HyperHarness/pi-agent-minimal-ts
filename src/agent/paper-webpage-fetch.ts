import {
  getResponseStatusError,
  resolveFetchTimeoutMs,
  withRequestTimeout
} from "./network.js";

export interface FetchPaperWebPageOptions {
  url: string;
  env?: FetchPaperWebPageEnvironment;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface FetchPaperWebPageEnvironment extends NodeJS.ProcessEnv {}

export interface PaperWebPageMetadata {
  title?: string;
  doi?: string;
  journal?: string;
  publicationDate?: string;
  authors: string[];
}

export interface PaperWebPageAccessStatus {
  status: "full_text" | "access_limited";
  signals: string[];
  message?: string;
}

export interface PaperWebPageExtraction {
  url: string;
  title?: string;
  markdown: string;
  metadata: PaperWebPageMetadata;
  access: PaperWebPageAccessStatus;
  stats: {
    chars: number;
    wordsApprox: number;
    navigationLinesRemoved: number;
    extractedFrom: "article" | "main" | "body";
  };
}

const DEFAULT_USER_AGENT = "pi-agent-minimal-ts/1.0";

const BLOCK_TAGS_TO_REMOVE = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "form",
  "button",
  "select",
  "nav",
  "header",
  "footer",
  "aside"
];

const NOISE_ATTRIBUTE_PATTERN =
  /\s(?:class|id|role|aria-label)=["'][^"']*(?:advert|banner|breadcrumb|cookie|login|menu|metrics|nav|newsletter|popup|recommend|related|share|sidebar|sign-?up|skip|social|toolbar)[^"']*["']/i;
const NOISE_CONTAINER_TAGS = ["section", "aside", "div", "article", "ul", "ol"];

const NAVIGATION_LINE_PATTERNS = [
  /^skip to /i,
  /^thank you for visiting/i,
  /^you are using a browser version/i,
  /^get the most important science stories/i,
  /^sign up for/i,
  /^subscribe/i,
  /^log in/i,
  /^search$/i,
  /^menu$/i,
  /^subjects$/i,
  /^explore content$/i,
  /^about the journal$/i,
  /^publish with us$/i,
  /^share this article$/i,
  /^download pdf$/i,
  /^rights and permissions$/i,
  /^reprints and permissions$/i,
  /^advertisement$/i,
  /^nature portfolio$/i,
  /^springer nature$/i,
  /^view all access options to continue reading this article\.?$/i,
  /^check access$/i,
  /^loading(?:\.\.\.)?$/i,
  /^aaas id login$/i,
  /^loading institution options$/i,
  /^aaas login provides access to science/i,
  /^become a aaas member$/i,
  /^activate your aaas id$/i,
  /^purchase access to other journals/i,
  /^account help$/i,
  /^purchase digital access to this article$/i,
  /^purchase this issue in print$/i,
  /^buy a single issue of science/i,
  /^download this article as a pdf file$/i,
  /^full text$/i,
  /^share on social media$/i
];

const ACCESS_NOISE_SECTION_TITLES = new Set([
  "access the full article",
  "log in to view the full text",
  "more options",
  "pdf format",
  "full text",
  "share on social media"
]);

const TRAILING_NOISE_SECTION_PATTERNS = [
  /^submit a response to this article$/i,
  /^\(\d+\)\s*eletters$/i,
  /^information$/i,
  /^authors$/i,
  /^citations$/i,
  /^view options$/i
];

const ACCESS_LIMITED_SIGNAL_PATTERNS = [
  { label: "access_full_article", pattern: /Access the full article/i },
  { label: "view_access_options", pattern: /View all access options to continue reading this article/i },
  { label: "check_access", pattern: /\bCHECK ACCESS\b/i },
  { label: "login_full_text", pattern: /Log in to view the full text/i },
  { label: "aaas_login", pattern: /AAAS ID LOGIN|AAAS login provides access to Science/i },
  { label: "institution_options", pattern: /Loading institution options/i },
  { label: "purchase_access", pattern: /Purchase digital access to this article/i }
];

const ACCESS_LIMITED_MESSAGE =
  "Publisher access wall detected. Ask the user to log in through the browser extension tab, then rerun fetch_paper_webpage.";

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

function normalizeUserAgent(env: FetchPaperWebPageEnvironment): string {
  const userAgent = env.PI_FETCH_USER_AGENT?.trim();
  return userAgent || DEFAULT_USER_AGENT;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'");
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

function removeTagBlocks(html: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi");
  return html.replace(pattern, " ");
}

function removeKnownNoiseBlocks(html: string): { html: string; removed: number } {
  let nextHtml = html;
  let removed = 0;

  for (const tagName of BLOCK_TAGS_TO_REMOVE) {
    const before = nextHtml;
    nextHtml = removeTagBlocks(nextHtml, tagName);
    if (nextHtml !== before) {
      removed += 1;
    }
  }

  for (const tagName of NOISE_CONTAINER_TAGS) {
    const pattern = new RegExp(
      `<${tagName}\\b[^>]*\\s(?:class|id|role|aria-label)=["'][^"']*(?:advert|banner|breadcrumb|cookie|login|menu|metrics|nav|newsletter|popup|recommend|related|share|sidebar|sign-?up|skip|social|toolbar)[^"']*["'][^>]*>[\\s\\S]*?<\\/${tagName}>`,
      "gi"
    );
    const before = nextHtml;
    nextHtml = nextHtml.replace(pattern, " ");
    if (nextHtml !== before) {
      removed += 1;
    }
  }

  const elementPattern = /<([a-z][a-z0-9:-]*)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let previousHtml: string;
  do {
    previousHtml = nextHtml;
    nextHtml = nextHtml.replace(elementPattern, (match) => {
      const openingTag = match.match(/^<[^>]+>/)?.[0] ?? "";
      if (!NOISE_ATTRIBUTE_PATTERN.test(openingTag)) {
        return match;
      }

      removed += 1;
      return " ";
    });
  } while (nextHtml !== previousHtml);

  return { html: nextHtml, removed };
}

function findElementHtmlCandidates(html: string, tagName: "article" | "main"): string[] {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi");
  return [...html.matchAll(pattern)].map((match) => match[0]);
}

function extractBodyHtml(html: string): string {
  return html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
}

function selectArticleHtml(html: string): {
  html: string;
  extractedFrom: PaperWebPageExtraction["stats"]["extractedFrom"];
} {
  const candidates = [
    ...findElementHtmlCandidates(html, "main").map((candidate) => ({
      html: candidate,
      extractedFrom: "main" as const
    })),
    ...findElementHtmlCandidates(html, "article").map((candidate) => ({
      html: candidate,
      extractedFrom: "article" as const
    }))
  ];

  let bestCandidate:
    | {
        html: string;
        extractedFrom: "article" | "main";
        score: number;
      }
    | undefined;

  for (const candidate of candidates) {
    const normalized = candidate.html.toLowerCase();
    const sectionSignals = [
      "abstract",
      "introduction",
      "results",
      "discussion",
      "methods",
      "data availability",
      "references"
    ].filter((signal) => normalized.includes(signal)).length;
    const articleBodySignal = /article body|article-main|main-column/i.test(candidate.html) ? 10 : 0;
    const score = candidate.html.length + sectionSignals * 20_000 + articleBodySignal * 20_000;

    if (bestCandidate === undefined || score > bestCandidate.score) {
      bestCandidate = { ...candidate, score };
    }
  }

  if (bestCandidate) {
    return {
      html: bestCandidate.html,
      extractedFrom: bestCandidate.extractedFrom
    };
  }

  return { html: extractBodyHtml(html), extractedFrom: "body" };
}

function getAttribute(tag: string, attributeName: string): string | undefined {
  const pattern = new RegExp(`${attributeName}=["']([^"']+)["']`, "i");
  return tag.match(pattern)?.[1];
}

function extractMetaContent(html: string, names: string[]): string | undefined {
  const metaPattern = /<meta\b[^>]*>/gi;
  for (const match of html.matchAll(metaPattern)) {
    const tag = match[0];
    const name = getAttribute(tag, "name") ?? getAttribute(tag, "property");
    if (!name || !names.some((candidate) => candidate.toLowerCase() === name.toLowerCase())) {
      continue;
    }

    const content = getAttribute(tag, "content");
    if (content?.trim()) {
      return decodeHtmlEntities(content).trim();
    }
  }

  return undefined;
}

function extractMetaContents(html: string, names: string[]): string[] {
  const values: string[] = [];
  const metaPattern = /<meta\b[^>]*>/gi;
  for (const match of html.matchAll(metaPattern)) {
    const tag = match[0];
    const name = getAttribute(tag, "name") ?? getAttribute(tag, "property");
    if (!name || !names.some((candidate) => candidate.toLowerCase() === name.toLowerCase())) {
      continue;
    }

    const content = getAttribute(tag, "content");
    if (content?.trim()) {
      values.push(decodeHtmlEntities(content).trim());
    }
  }

  return [...new Set(values)];
}

function extractTitle(html: string): string | undefined {
  return (
    extractMetaContent(html, ["citation_title", "dc.title", "og:title", "twitter:title"]) ??
    decodeHtmlEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim() ??
    undefined
  );
}

function extractMetadata(html: string): PaperWebPageMetadata {
  const title = extractTitle(html);
  const doi = extractMetaContent(html, ["citation_doi", "dc.identifier", "prism.doi"]);

  return {
    ...(title ? { title } : {}),
    ...(doi ? { doi: doi.replace(/^doi:\s*/i, "") } : {}),
    ...(extractMetaContent(html, ["citation_journal_title", "prism.publicationName"])
      ? { journal: extractMetaContent(html, ["citation_journal_title", "prism.publicationName"]) }
      : {}),
    ...(extractMetaContent(html, ["citation_publication_date", "article:published_time"])
      ? {
          publicationDate: extractMetaContent(html, [
            "citation_publication_date",
            "article:published_time"
          ])
        }
      : {}),
    authors: extractMetaContents(html, ["citation_author", "dc.creator"])
  };
}

function htmlToMarkdown(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/\r/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/section>/gi, "\n\n")
    .replace(/<\/article>/gi, "\n")
    .replace(/<h1\b[^>]*>/gi, "\n# ")
    .replace(/<h2\b[^>]*>/gi, "\n## ")
    .replace(/<h3\b[^>]*>/gi, "\n### ")
    .replace(/<h4\b[^>]*>/gi, "\n#### ")
    .replace(/<h5\b[^>]*>/gi, "\n##### ")
    .replace(/<h6\b[^>]*>/gi, "\n###### ")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<figcaption\b[^>]*>/gi, "\nFigure: ")
    .replace(/<\/figcaption>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, "^$1")
    .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, "_$1")
    .replace(/<[^>]+>/g, " ");
}

function compactLine(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function isNavigationLine(line: string): boolean {
  const compacted = compactLine(line);
  if (!compacted) {
    return false;
  }

  return NAVIGATION_LINE_PATTERNS.some((pattern) => pattern.test(compacted));
}

function parseMarkdownHeading(line: string): { level: number; title: string } | undefined {
  const match = line.match(/^(#{1,6})\s+(.+)$/);
  return match?.[1] && match[2]
    ? { level: match[1].length, title: match[2].trim() }
    : undefined;
}

function shouldSkipAccessNoiseSection(title: string): boolean {
  return ACCESS_NOISE_SECTION_TITLES.has(title.toLowerCase());
}

function isTrailingNoiseSection(title: string): boolean {
  return TRAILING_NOISE_SECTION_PATTERNS.some((pattern) => pattern.test(title));
}

function cleanMarkdown(markdown: string): { markdown: string; removedLines: number } {
  const outputLines: string[] = [];
  let removedLines = 0;
  let previousLine = "";
  let blankPending = false;
  let skipSectionLevel: number | undefined;

  for (const rawLine of markdown.split("\n")) {
    const line = compactLine(rawLine);

    if (!line) {
      blankPending = outputLines.length > 0;
      continue;
    }

    const heading = parseMarkdownHeading(line);
    if (heading) {
      if (skipSectionLevel !== undefined && heading.level <= skipSectionLevel) {
        skipSectionLevel = undefined;
      }

      if (isTrailingNoiseSection(heading.title)) {
        removedLines += 1;
        break;
      }

      if (shouldSkipAccessNoiseSection(heading.title)) {
        skipSectionLevel = heading.level;
        removedLines += 1;
        continue;
      }
    }

    if (skipSectionLevel !== undefined) {
      removedLines += 1;
      continue;
    }

    if (isNavigationLine(line)) {
      removedLines += 1;
      continue;
    }

    if (line === previousLine) {
      removedLines += 1;
      continue;
    }

    if (blankPending) {
      outputLines.push("");
      blankPending = false;
    }

    outputLines.push(line);
    previousLine = line;
  }

  return {
    markdown: outputLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    removedLines
  };
}

function countWordsApprox(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu);
  return matches?.length ?? 0;
}

function detectAccessStatus(html: string): PaperWebPageAccessStatus {
  const signals = ACCESS_LIMITED_SIGNAL_PATTERNS
    .filter((candidate) => candidate.pattern.test(html))
    .map((candidate) => candidate.label);

  if (signals.length > 0) {
    return {
      status: "access_limited",
      signals,
      message: ACCESS_LIMITED_MESSAGE
    };
  }

  return {
    status: "full_text",
    signals: []
  };
}

export function parsePaperWebPageHtml(options: {
  url: string;
  html: string;
}): PaperWebPageExtraction {
  const metadata = extractMetadata(options.html);
  const selected = selectArticleHtml(stripComments(options.html));
  const access = detectAccessStatus(selected.html);
  const cleanedBlocks = removeKnownNoiseBlocks(selected.html);
  const cleanedMarkdown = cleanMarkdown(htmlToMarkdown(cleanedBlocks.html));

  return {
    url: options.url,
    ...(metadata.title ? { title: metadata.title } : {}),
    markdown: cleanedMarkdown.markdown,
    metadata,
    access,
    stats: {
      chars: cleanedMarkdown.markdown.length,
      wordsApprox: countWordsApprox(cleanedMarkdown.markdown),
      navigationLinesRemoved: cleanedBlocks.removed + cleanedMarkdown.removedLines,
      extractedFrom: selected.extractedFrom
    }
  };
}

export async function fetchPaperWebPage(
  options: FetchPaperWebPageOptions
): Promise<PaperWebPageExtraction> {
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
      throw getResponseStatusError(response, "paper webpage fetch");
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const mediaType = contentType.split(";", 1)[0]?.trim();
    if (mediaType !== "text/html") {
      throw new Error("Expected text/html content-type.");
    }

    return parsePaperWebPageHtml({
      url: endpoint.toString(),
      html: await response.text()
    });
  } finally {
    timeout.dispose();
  }
}
