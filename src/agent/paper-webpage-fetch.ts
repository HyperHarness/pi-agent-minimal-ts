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
  referenceLinks?: PaperWebPageReferenceLink[];
  referenceSummary?: string;
}

export interface PaperWebPageReferenceLink {
  url: string;
  label?: string;
  kind: "arxiv" | "doi" | "publisher" | "scholarly_url";
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

export interface PaperWebPageHtmlCandidateDiagnostic {
  selector: string;
  extractedFrom: PaperWebPageExtraction["stats"]["extractedFrom"];
  htmlChars: number;
  textCharsApprox: number;
  headingCountApprox: number;
  sectionSignals: string[];
  score: number;
  preview: string;
}

export interface PaperWebPageHtmlDiagnostic {
  selected: PaperWebPageHtmlCandidateDiagnostic;
  candidates: PaperWebPageHtmlCandidateDiagnostic[];
  unfilteredMarkdownChars: number;
  filteredMarkdownChars: number;
  removedLines: number;
  removedBlocks: number;
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
  { label: "purchase_access", pattern: /Purchase digital access to this article/i },
  { label: "nature_preview_subscription", pattern: /This is a preview of subscription content/i },
  { label: "nature_institution_access", pattern: /Access through your institution/i },
  { label: "nature_buy_or_subscribe", pattern: /Buy or subscribe/i },
  { label: "nature_access_options", pattern: /Access options/i },
  { label: "nature_buy_article", pattern: /Buy this article/i },
  { label: "nature_springerlink_purchase", pattern: /Purchase on SpringerLink/i },
  { label: "nature_full_article_pdf_purchase", pattern: /Instant access to the full article PDF/i },
  { label: "aps_authorization_required", pattern: /Authorization Required/i },
  {
    label: "aps_credentials_required",
    pattern: /provide your credentials before accessing this content/i
  },
  { label: "aps_member_login", pattern: /APS Member Log In/i },
  { label: "aps_journals_account", pattern: /Log in with APS Journals Account/i },
  { label: "aps_institution_login", pattern: /Log in with username\/password provided by your institution/i },
  { label: "aps_subscription_required", pattern: /Subscription Required/i }
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

function countHeadingTagsApprox(html: string): number {
  return [...html.matchAll(/<h[1-6]\b/gi)].length;
}

function plainTextFromHtmlForDiagnostics(html: string): string {
  return compactLine(htmlToMarkdown(html).replace(/^#{1,6}\s+/gm, ""));
}

function getArticleSectionSignals(html: string): string[] {
  const normalized = html.toLowerCase();
  return [
    "abstract",
    "introduction",
    "results",
    "discussion",
    "methods",
    "data availability",
    "article text",
    "references"
  ].filter((signal) => normalized.includes(signal));
}

function buildHtmlCandidateDiagnostics(html: string): Array<PaperWebPageHtmlCandidateDiagnostic & {
  html: string;
}> {
  const candidates = [
    ...findElementHtmlCandidates(html, "main").map((candidate) => ({
      html: candidate,
      selector: "main",
      extractedFrom: "main" as const
    })),
    ...findElementHtmlCandidates(html, "article").map((candidate) => ({
      html: candidate,
      selector: "article",
      extractedFrom: "article" as const
    })),
    {
      html: extractBodyHtml(html),
      selector: "body",
      extractedFrom: "body" as const
    }
  ];

  return candidates.map((candidate) => {
    const sectionSignals = getArticleSectionSignals(candidate.html);
    const articleBodySignal = /<[^>]+(?:article body|article-main|main-column|article[-_\s]?text|full[-_\s]?text)[^>]*>/i.test(
      candidate.html
    )
      ? 10
      : 0;
    const bodyPenalty = candidate.extractedFrom === "body" ? 30_000 : 0;
    const score =
      candidate.html.length + sectionSignals.length * 20_000 + articleBodySignal * 20_000 - bodyPenalty;
    const plainText = plainTextFromHtmlForDiagnostics(candidate.html);

    return {
      ...candidate,
      htmlChars: candidate.html.length,
      textCharsApprox: plainText.length,
      headingCountApprox: countHeadingTagsApprox(candidate.html),
      sectionSignals,
      score,
      preview: plainText.slice(0, 280)
    };
  });
}

function selectArticleHtml(html: string): {
  html: string;
  extractedFrom: PaperWebPageExtraction["stats"]["extractedFrom"];
  diagnostic: PaperWebPageHtmlCandidateDiagnostic;
} {
  const candidates = buildHtmlCandidateDiagnostics(html);

  let bestCandidate:
    | {
        html: string;
        extractedFrom: "article" | "main" | "body";
        score: number;
        diagnostic: PaperWebPageHtmlCandidateDiagnostic;
      }
    | undefined;

  for (const candidate of candidates) {
    if (bestCandidate === undefined || candidate.score > bestCandidate.score) {
      const { html: candidateHtml, ...diagnostic } = candidate;
      bestCandidate = {
        html: candidateHtml,
        extractedFrom: candidate.extractedFrom,
        score: candidate.score,
        diagnostic
      };
    }
  }

  if (bestCandidate) {
    return {
      html: bestCandidate.html,
      extractedFrom: bestCandidate.extractedFrom,
      diagnostic: bestCandidate.diagnostic
    };
  }

  const bodyHtml = extractBodyHtml(html);
  const diagnostic = buildHtmlCandidateDiagnostics(bodyHtml)[0];
  if (!diagnostic) {
    throw new Error("Unable to build webpage HTML candidate diagnostics.");
  }
  const { html: _html, ...candidateDiagnostic } = diagnostic;
  return { html: bodyHtml, extractedFrom: "body", diagnostic: candidateDiagnostic };
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

function classifyReferenceLink(url: URL): PaperWebPageReferenceLink["kind"] | undefined {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname === "doi.org" || hostname === "dx.doi.org") {
    return "doi";
  }
  if (hostname === "arxiv.org") {
    return "arxiv";
  }
  if (
    /(?:nature\.com|science\.org|journals\.aps\.org|link\.aps\.org|springer\.com|link\.springer\.com|sciencedirect\.com|iopscience\.iop\.org|ieeexplore\.ieee\.org|dl\.acm\.org)$/i
      .test(hostname)
  ) {
    return "publisher";
  }
  if (
    /(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|semanticscholar\.org|adsabs\.harvard\.edu|inspirehep\.net|crossref\.org)$/i
      .test(hostname)
  ) {
    return "scholarly_url";
  }
  return undefined;
}

function extractAnchorText(anchorHtml: string): string | undefined {
  const text = compactLine(decodeHtmlEntities(anchorHtml.replace(/<[^>]+>/g, " ")));
  return text || undefined;
}

function extractReferenceLinks(html: string, baseUrl: string): PaperWebPageReferenceLink[] {
  const base = new URL(baseUrl);
  const links: PaperWebPageReferenceLink[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const attributes = match[1] ?? "";
    const rawHref = getAttribute(attributes, "href");
    if (!rawHref || /^(?:mailto:|tel:|#)/i.test(rawHref)) {
      continue;
    }

    let linkUrl: URL;
    try {
      linkUrl = new URL(decodeHtmlEntities(rawHref), base);
    } catch {
      continue;
    }

    if (linkUrl.origin === base.origin && linkUrl.pathname === base.pathname && linkUrl.hash) {
      continue;
    }

    const kind = classifyReferenceLink(linkUrl);
    if (!kind) {
      continue;
    }

    const normalizedUrl = linkUrl.toString();
    if (seen.has(normalizedUrl)) {
      continue;
    }
    seen.add(normalizedUrl);

    const label = extractAnchorText(match[2] ?? "");
    links.push({
      url: normalizedUrl,
      ...(label ? { label } : {}),
      kind
    });
  }

  return links.slice(0, 200);
}

function summarizeReferenceLinks(links: PaperWebPageReferenceLink[]): string | undefined {
  if (links.length === 0) {
    return undefined;
  }

  const counts = new Map<PaperWebPageReferenceLink["kind"], number>();
  for (const link of links) {
    counts.set(link.kind, (counts.get(link.kind) ?? 0) + 1);
  }
  const parts = Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${count} ${kind.replace(/_/g, " ")}`);
  return `Extracted ${links.length} linked citation/reference target${links.length === 1 ? "" : "s"} from the article body: ${parts.join(", ")}.`;
}

function extractMetadata(html: string, referenceHtml?: { html: string; baseUrl: string }): PaperWebPageMetadata {
  const title = extractTitle(html);
  const doi = extractMetaContent(html, ["citation_doi", "dc.identifier", "prism.doi"]);
  const referenceLinks = referenceHtml
    ? extractReferenceLinks(referenceHtml.html, referenceHtml.baseUrl)
    : [];
  const referenceSummary = summarizeReferenceLinks(referenceLinks);

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
    authors: extractMetaContents(html, ["citation_author", "dc.creator"]),
    ...(referenceLinks.length > 0 ? { referenceLinks } : {}),
    ...(referenceSummary ? { referenceSummary } : {})
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
  const selected = selectArticleHtml(stripComments(options.html));
  const metadata = extractMetadata(options.html, {
    html: selected.html,
    baseUrl: options.url
  });
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

export function diagnosePaperWebPageHtml(options: {
  url: string;
  html: string;
}): PaperWebPageHtmlDiagnostic {
  const selected = selectArticleHtml(stripComments(options.html));
  const cleanedBlocks = removeKnownNoiseBlocks(selected.html);
  const unfilteredMarkdown = htmlToMarkdown(selected.html);
  const cleanedMarkdown = cleanMarkdown(htmlToMarkdown(cleanedBlocks.html));
  const candidates = buildHtmlCandidateDiagnostics(stripComments(options.html))
    .map(({ html: _html, ...candidate }) => candidate)
    .sort((left, right) => right.score - left.score);

  return {
    selected: selected.diagnostic,
    candidates,
    unfilteredMarkdownChars: compactLine(unfilteredMarkdown).length,
    filteredMarkdownChars: cleanedMarkdown.markdown.length,
    removedLines: cleanedMarkdown.removedLines,
    removedBlocks: cleanedBlocks.removed
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
