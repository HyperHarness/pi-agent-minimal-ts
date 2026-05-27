import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MathMLToLaTeX } from "mathml-to-latex";
import {
  getResponseStatusError,
  resolveFetchTimeoutMs,
  withRequestTimeout
} from "../../network.js";
import { sanitizeLatexmlMarkdown } from "../reading/latexml-markdown.js";

export interface FetchPaperWebPageOptions {
  url: string;
  env?: FetchPaperWebPageEnvironment;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface FetchPaperWebPageEnvironment extends NodeJS.ProcessEnv {}

export interface ParsePaperWebPageHtmlOptions {
  url: string;
  html: string;
  env?: FetchPaperWebPageEnvironment;
  pandocBin?: string;
}

export interface PaperWebPageMetadata {
  title?: string;
  doi?: string;
  journal?: string;
  publicationDate?: string;
  comments?: string;
  expectedFigureCount?: number;
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

export interface PaperWebPageAsset {
  url: string;
  dataBase64: string;
  originalUrl?: string;
  filename?: string;
  mimeType?: string;
  alt?: string;
}

export interface PaperWebPageExtraction {
  url: string;
  title?: string;
  html?: string;
  snapshotHtml?: string;
  markdown: string;
  assets?: PaperWebPageAsset[];
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
const DEFAULT_PANDOC_TIMEOUT_MS = 60_000;
const MAX_DIRECT_IMAGE_ASSETS = 200;
const MAX_DIRECT_IMAGE_BYTES = 25 * 1024 * 1024;
const execFileAsync = promisify(execFile);

const BLOCK_TAGS_TO_REMOVE = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "dialog",
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
  /\s(?:class|id|role|aria-label|data-[\w:-]+)=["'][^"']*(?:advert|altmetric|badge|banner|breadcrumb|cookie|dialog|dimensions|export|login|menu|metrics|modal|nav|newsletter|osano|popup|recommend|related|share|sidebar|sign-?up|skip|social|toolbar|tqc|z3988)[^"']*["']/i;
const NOISE_CONTAINER_TAGS = ["section", "aside", "div", "article", "ul", "ol", "details", "span"];

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

function extractTagAttribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp("\\s" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))", "i");
  const match = tag.match(pattern);
  const value = match?.[2] ?? match?.[3] ?? match?.[4];
  return value ? decodeHtmlEntities(value.trim()) : undefined;
}

function preferredSrcFromSrcset(srcset: string | undefined): string | undefined {
  if (!srcset) {
    return undefined;
  }
  const candidates = srcset
    .split(",")
    .map((entry) => {
      const [url, descriptor] = entry.trim().split(/\s+/, 2);
      const width = descriptor?.endsWith("w")
        ? Number(descriptor.slice(0, -1))
        : descriptor?.endsWith("x")
          ? Number(descriptor.slice(0, -1)) * 1000
          : 0;
      return { url, width: Number.isFinite(width) ? width : 0 };
    })
    .filter((candidate): candidate is { url: string; width: number } => Boolean(candidate.url));
  candidates.sort((left, right) => right.width - left.width);
  return candidates[0]?.url;
}

function filenameFromUrlLike(value: string): string | undefined {
  try {
    const parsed = new URL(value, "https://example.invalid/");
    const filename = path.posix.basename(parsed.pathname);
    return filename ? decodeURIComponent(filename) : undefined;
  } catch {
    const filename = value.split(/[?#]/, 1)[0]?.split("/").pop();
    return filename ? decodeURIComponent(filename) : undefined;
  }
}

function collectImageAssetCandidates(html: string, baseUrl: string): Array<{
  url: string;
  originalUrl: string;
  filename?: string;
  alt?: string;
}> {
  const candidates: Array<{
    url: string;
    originalUrl: string;
    filename?: string;
    alt?: string;
  }> = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const originalUrl =
      extractTagAttribute(tag, "src") ??
      extractTagAttribute(tag, "data-src") ??
      preferredSrcFromSrcset(extractTagAttribute(tag, "srcset")) ??
      preferredSrcFromSrcset(extractTagAttribute(tag, "data-srcset"));
    if (!originalUrl) {
      continue;
    }
    let resolvedUrl: string;
    try {
      if (originalUrl.startsWith("data:")) {
        resolvedUrl = originalUrl;
      } else {
        const parsedBase = new URL(baseUrl);
        const arxivHtmlMatch = parsedBase.pathname.match(/^\/html\/([^/]+)\/$/i);
        if (
          arxivHtmlMatch?.[1] &&
          new RegExp(`^${arxivHtmlMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}v\\d+/`).test(originalUrl)
        ) {
          resolvedUrl = new URL(`/html/${originalUrl}`, parsedBase).toString();
        } else {
          resolvedUrl = new URL(originalUrl, baseUrl).toString();
        }
      }
    } catch {
      continue;
    }
    if (seen.has(resolvedUrl)) {
      continue;
    }
    seen.add(resolvedUrl);
    candidates.push({
      url: resolvedUrl,
      originalUrl,
      ...(filenameFromUrlLike(originalUrl) ? { filename: filenameFromUrlLike(originalUrl) } : {}),
      ...(extractTagAttribute(tag, "alt") ? { alt: extractTagAttribute(tag, "alt") } : {})
    });
    if (candidates.length >= MAX_DIRECT_IMAGE_ASSETS) {
      break;
    }
  }

  return candidates;
}

function resolveArticleAssetBaseUrl(url: URL): string {
  if (/(^|\.)arxiv\.org$/i.test(url.hostname) && /^\/html\/[^/]+$/i.test(url.pathname)) {
    const withSlash = new URL(url.toString());
    withSlash.pathname = `${withSlash.pathname}/`;
    return withSlash.toString();
  }
  return url.toString();
}

function parseArxivIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)arxiv\.org$/i.test(parsed.hostname)) {
      return undefined;
    }
    const match = parsed.pathname.match(/^\/(?:abs|html|pdf)\/([^/?#]+?)(?:\.pdf)?\/?$/i);
    return match?.[1]?.replace(/v\d+$/i, "");
  } catch {
    return undefined;
  }
}

function parseExpectedFigureCountFromComments(comments: string): number | undefined {
  const match = comments.match(/\b(\d+)\s+fig(?:ure)?s?\b/i);
  if (!match?.[1]) {
    return undefined;
  }
  const count = Number(match[1]);
  return Number.isInteger(count) && count >= 0 ? count : undefined;
}

function stripHtmlToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " "));
}

function extractArxivComments(absHtml: string): string | undefined {
  const match = absHtml.match(/<td\b[^>]*class=["'][^"']*\bcomments\b[^"']*["'][^>]*>\s*([\s\S]*?)<\/td>/i);
  const value = match?.[1]
    ? compactLine(stripHtmlToText(match[1]))
    : undefined;
  return value || undefined;
}

async function fetchArxivAbsMetadata(input: {
  articleUrl: string;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  signal: AbortSignal;
  userAgent: string;
}): Promise<Pick<PaperWebPageMetadata, "comments" | "expectedFigureCount">> {
  const arxivId = parseArxivIdFromUrl(input.articleUrl);
  if (!arxivId) {
    return {};
  }

  try {
    const response = await input.fetchImpl(`https://arxiv.org/abs/${arxivId}`, {
      headers: new Headers({
        "user-agent": input.userAgent
      }),
      signal: input.signal
    });
    if (!response.ok) {
      return {};
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html")) {
      return {};
    }
    const comments = extractArxivComments(await response.text());
    const expectedFigureCount = comments
      ? parseExpectedFigureCountFromComments(comments)
      : undefined;
    return {
      ...(comments ? { comments } : {}),
      ...(expectedFigureCount !== undefined ? { expectedFigureCount } : {})
    };
  } catch {
    return {};
  }
}

function parseDataImageAsset(candidate: {
  url: string;
  originalUrl: string;
  filename?: string;
  alt?: string;
}): PaperWebPageAsset | undefined {
  const match = candidate.url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match?.[3]) {
    return undefined;
  }
  const mimeType = match[1] || "image/png";
  const data = match[2]
    ? match[3]
    : Buffer.from(decodeURIComponent(match[3]), "utf8").toString("base64");
  return {
    url: candidate.url,
    originalUrl: candidate.originalUrl,
    dataBase64: data,
    mimeType,
    ...(candidate.filename ? { filename: candidate.filename } : {}),
    ...(candidate.alt ? { alt: candidate.alt } : {})
  };
}

function isImageContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean(mediaType?.startsWith("image/") || mediaType === "application/pdf");
}

async function fetchImageAssets(input: {
  candidates: Array<{
    url: string;
    originalUrl: string;
    filename?: string;
    alt?: string;
  }>;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  userAgent: string;
  timeoutMs: number;
}): Promise<PaperWebPageAsset[]> {
  const fetchOne = async (candidate: typeof input.candidates[number]): Promise<PaperWebPageAsset | undefined> => {
    if (candidate.url.startsWith("data:")) {
      return parseDataImageAsset(candidate);
    }

    const timeout = withRequestTimeout(input.timeoutMs);
    try {
      const response = await input.fetchImpl(candidate.url, {
        headers: new Headers({
          "user-agent": input.userAgent
        }),
        signal: timeout.signal
      });
      if (!response.ok) {
        return undefined;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!isImageContentType(contentType)) {
        return undefined;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_DIRECT_IMAGE_BYTES) {
        return undefined;
      }
      return {
        url: candidate.url,
        originalUrl: candidate.originalUrl,
        dataBase64: bytes.toString("base64"),
        mimeType: contentType,
        ...(candidate.filename ? { filename: candidate.filename } : {}),
        ...(candidate.alt ? { alt: candidate.alt } : {})
      };
    } catch {
      return undefined;
    } finally {
      timeout.dispose();
    }
  };

  const assets: PaperWebPageAsset[] = [];
  const batchSize = 8;
  for (let index = 0; index < input.candidates.length; index += batchSize) {
    const batch = input.candidates.slice(index, index + batchSize);
    const batchAssets = await Promise.all(batch.map((candidate) => fetchOne(candidate)));
    assets.push(...batchAssets.filter((asset): asset is PaperWebPageAsset => asset !== undefined));
  }
  return assets;
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeMathText(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function normalizeMathSpeechText(value: string): string {
  return normalizeMathText(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s*,?\s*math\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

type MathFormulaText = {
  text: string;
  format: "latex" | "mathml" | "speech";
  mathml?: string;
  speech?: string;
};

const SEMANTIC_SPEECH_SYMBOLS: Record<string, string> = {
  alpha: "\\alpha",
  beta: "\\beta",
  gamma: "\\gamma",
  Gamma: "\\Gamma",
  delta: "\\delta",
  Delta: "\\Delta",
  triangle: "\\Delta",
  epsilon: "\\epsilon",
  phi: "\\phi",
  Phi: "\\Phi",
  pi: "\\pi",
  theta: "\\theta",
  Theta: "\\Theta",
  omega: "\\omega",
  Omega: "\\Omega"
};

const EXACT_SEMANTIC_SPEECH_LATEX: Record<string, string> = {
  delta: "\\Delta",
  triangle: "\\Delta",
  "gamma equals gamma sub 1 comma d divided by 2 plus gamma sub phi comma d plus gamma sub 1 comma q divided by 2 plus gamma sub phi comma q":
    "\\Gamma = \\Gamma_{1,D}/2 + \\Gamma_{\\phi,D} + \\Gamma_{1,Q}/2 + \\Gamma_{\\phi,Q}",
  "gamma sub 1 equals the fraction with numerator 2 g squared of gamma and denominator gamma squared plus triangle squared plus gamma sub 1 comma q comma":
    "\\Gamma_1 = \\frac{2g^2\\Gamma}{\\Gamma^2 + \\Delta^2} + \\Gamma_{1,Q},",
  "e equals b divided by the square root of x": "E = B/\\sqrt{x}",
  "g of slash 2 pi tilde 0.1 mhz": "g/2\\pi \\sim 0.1\\,\\mathrm{MHz}",
  "g of slash 2 pi is greater than or equivalent to 0.2 mhz": "g/2\\pi \\gtrsim 0.2\\,\\mathrm{MHz}",
  "g equals p e": "g = pE",
  "x equals 3 nanometers": "x = 3\\,\\mathrm{nm}",
  "1 divided by open paren gamma sub 1 comma d divided by 2 plus gamma sub phi comma d close paren tilde 50 en dash 100 nanoseconds":
    "\\frac{1}{\\Gamma_{1,D}/2 + \\Gamma_{\\phi,D}} \\sim 50-100\\,\\mathrm{ns}",
  "s": "S",
  "w": "W",
  "z": "Z",
  "x y": "XY",
  "l": "L",
  "g": "g",
  "x": "x",
  "b": "B",
  "n": "N",
  "k": "K",
  "0.30 times 0.20 mu meters squared": "0.30 \\times 0.20\\,\\mu\\mathrm{m}^{2}",
  "1.5 times 10 to the sixth power": "1.5 \\times 10^{6}",
  "t sub 2 raised to the asterisk power equals 15 mu seconds": "T_{2}^{*} = 15\\,\\mu\\mathrm{s}",
  "t sub 2 raised to the asterisk power": "T_{2}^{*}",
  "q sub l equals 10 to the fourth power": "Q_{l} = 10^{4}",
  "t sub 2 raised to the asterisk power equals 10 mu seconds": "T_{2}^{*} = 10\\,\\mu\\mathrm{s}",
  "t sub 2 raised to the asterisk power equals 0.07 mu seconds": "T_{2}^{*} = 0.07\\,\\mu\\mathrm{s}",
  "t sub 2 raised to the asterisk power equals 2.5 mu seconds": "T_{2}^{*} = 2.5\\,\\mu\\mathrm{s}",
  "t sub 2 raised to the asterisk power equals 2 mu seconds": "T_{2}^{*} = 2\\,\\mu\\mathrm{s}",
  "t sub 1 is less than 8 mu seconds": "T_{1} < 8\\,\\mu\\mathrm{s}",
  "gamma sub 1 comma d is greater than g is greater than gamma sub 1 comma q":
    "\\Gamma_{1,D} > g > \\Gamma_{1,Q}",
  "rho sub 0 the square root of 1 minus p squared divided by p sub max squared divided by p":
    "\\rho_{0}\\sqrt{1 - p^2/p_{max}^2}/p",
  "rho sub 0 almost equals 10 squared divided by mu meters cubed divided by ghz":
    "\\rho_{0} \\approx 10^2/(\\mu\\mathrm{m}^{3}\\,\\mathrm{GHz})",
  "n equals the double integral of rho sub 0 the fraction with numerator the square root of 1 minus p squared divided by p sub max squared and denominator p theta times open bracket p times the absolute value of e of open paren r right arrow close paren minus g sub min close bracket d p d r right arrow comma":
    "N = \\iint \\rho_{0}\\frac{\\sqrt{1 - p^2/p_{max}^2}}{p}\\Theta[p|E(\\vec{r})| - g_{min}]\\,dp\\,d\\vec{r},",
  "e of open paren r right arrow close paren": "E(\\vec{r})",
  "r right arrow": "\\vec{r}",
  "n tilde 30 en dash 50 divided by ghz": "N \\sim 30-50/\\mathrm{GHz}",
  "g sub min of slash 2 pi tilde 0.2 mhz": "g_{min}/2\\pi \\sim 0.2\\,\\mathrm{MHz}",
  "c equals 8 l times open paren epsilon sub 0 plus epsilon sub sub close paren times k of k divided by k of open paren the square root of 1 minus k squared close paren":
    "C = 8L(\\epsilon_{0} + \\epsilon_{sub})K(k)/K(\\sqrt{1 - k^2})",
  "b equals 2 millivolts divided by the square root of meters":
    "B = 2\\,\\mathrm{mV}/\\sqrt{\\mathrm{m}}"
};

function semanticSpeechTokenToLatex(token: string): string {
  return SEMANTIC_SPEECH_SYMBOLS[token] ?? SEMANTIC_SPEECH_SYMBOLS[token.toLowerCase()] ?? token;
}

function normalizeLatexFormulaText(text: string): string {
  return text
    .replace(/^\s*\${1,2}\s*/, "")
    .replace(/\s*\${1,2}\s*$/, "")
    .trim();
}

function normalizeMathMlLatexText(text: string): string {
  return normalizeLatexFormulaText(text)
    .replace(/[\u2061\u2062\u2063\u2064]/g, " ")
    .replace(/_\{([^{}]*?)\s+\}/g, "_{$1}")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function formulaFromMathMlText(mathml: string): MathFormulaText | undefined {
  const normalizedMathMl = mathml.trim();
  if (!normalizedMathMl) {
    return undefined;
  }
  try {
    const latex = normalizeMathMlLatexText(MathMLToLaTeX.convert(normalizedMathMl));
    if (!latex) {
      return undefined;
    }
    return {
      text: latex,
      format: "mathml",
      mathml: normalizedMathMl
    };
  } catch {
    return undefined;
  }
}

function convertSemanticSpeechSubscripts(value: string): string {
  return value.replace(
    /\b([A-Za-z]+) sub (negative )?([A-Za-z0-9]+)(?: comma ([A-Za-z0-9]+))?/gi,
    (_match, base: string, negative: string | undefined, first: string, second: string | undefined) => {
      const subscript = [
        `${negative ? "-" : ""}${semanticSpeechTokenToLatex(first)}`,
        ...(second ? [semanticSpeechTokenToLatex(second)] : [])
      ].join(",");
      return `${semanticSpeechTokenToLatex(base)}_{${subscript}}`;
    }
  );
}

function semanticSpeechToLatex(value: string): string | undefined {
  const normalized = normalizeMathSpeechText(value);
  if (!normalized) {
    return undefined;
  }

  const exact = normalized.toLowerCase();
  const exactLatex = EXACT_SEMANTIC_SPEECH_LATEX[exact];
  if (exactLatex) {
    return exactLatex;
  }

  let latex = convertSemanticSpeechSubscripts(normalized);
  latex = latex
    .replace(/\b(\d+(?:\.\d+)?)\s+mu\s*seconds\b/gi, "$1\\,\\mu\\mathrm{s}")
    .replace(/\b(\d+(?:\.\d+)?)\s+nanoseconds\b/gi, "$1\\,\\mathrm{ns}")
    .replace(/\b(\d+(?:\.\d+)?)\s+MHz\b/g, "$1\\,\\mathrm{MHz}")
    .replace(/\b(\d+(?:\.\d+)?)\s+GHz\b/g, "$1\\,\\mathrm{GHz}")
    .replace(/\b(\d+(?:\.\d+)?)\s+Debye\b/g, "$1\\,\\mathrm{Debye}")
    .replace(/\bgreater than or equivalent to\b/gi, "\\gtrsim")
    .replace(/\bless than or equivalent to\b/gi, "\\lesssim")
    .replace(/\bgreater than or equal to\b/gi, "\\ge")
    .replace(/\bless than or equal to\b/gi, "\\le")
    .replace(/\bnot equal to\b/gi, "\\ne")
    .replace(/\bequals\b/gi, "=")
    .replace(/\bplus\b/gi, "+")
    .replace(/\bminus\b/gi, "-")
    .replace(/\btimes\b/gi, "\\times")
    .replace(/\bdivided by\b/gi, "/")
    .replace(/\bslash\b/gi, "/")
    .replace(/\btilde\b/gi, "\\sim")
    .replace(/\bopen paren\b/gi, "(")
    .replace(/\bclose paren\b/gi, ")")
    .replace(/\bcomma\b/gi, ",");

  latex = latex.replace(
    /(?<!\\)\b(alpha|beta|gamma|Gamma|delta|Delta|triangle|epsilon|phi|Phi|pi|theta|Theta|omega|Omega)\b/g,
    (token) => semanticSpeechTokenToLatex(token)
  );

  latex = latex
    .replace(/\bmu\s*meters\b/gi, "\\mu\\mathrm{m}")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*([=+<>])\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();

  if (/\b(?:the|fraction|numerator|denominator|square root|squared|cubed|raised|power|almost|of|is|en dash|right arrow|absolute value)\b/i.test(latex)) {
    return undefined;
  }
  return latex && latex !== normalized ? latex : undefined;
}

function formulaFromSpeechText(speech: string): MathFormulaText | undefined {
  const normalizedSpeech = normalizeMathSpeechText(speech);
  if (!normalizedSpeech) {
    return undefined;
  }
  const latex = semanticSpeechToLatex(normalizedSpeech);
  if (latex) {
    return {
      text: latex,
      format: "latex",
      speech: normalizedSpeech
    };
  }
  return {
    text: normalizedSpeech,
    format: "speech",
    speech: normalizedSpeech
  };
}

function formulaTextFromMathJaxHtml(html: string): MathFormulaText | undefined {
  const annotationMatch = html.match(
    /<annotation\b[^>]*\bencoding=["']application\/x-tex["'][^>]*>([\s\S]*?)<\/annotation>/i
  );
  const annotationText = normalizeMathText(annotationMatch?.[1] ?? "");
  if (annotationText) {
    return {
      text: normalizeLatexFormulaText(annotationText),
      format: "latex"
    };
  }

  const mathMlMatch = html.match(/<math\b[^>]*>[\s\S]*?<\/math>/i);
  const mathMlFormula = formulaFromMathMlText(mathMlMatch?.[0] ?? "");
  if (mathMlFormula) {
    return mathMlFormula;
  }

  const openingTag = html.match(/^<mjx-container\b[^>]*>/i)?.[0] ?? "";
  const semanticSpeechNone = formulaFromSpeechText(extractTagAttribute(openingTag, "data-semantic-speech-none") ?? "");
  if (semanticSpeechNone) {
    return semanticSpeechNone;
  }

  const ariaLabel = formulaFromSpeechText(extractTagAttribute(openingTag, "aria-label") ?? "");
  if (ariaLabel) {
    return ariaLabel;
  }

  const speechTag = html.match(/<mjx-speech\b[^>]*>/i)?.[0] ?? "";
  const speechAriaLabel = formulaFromSpeechText(extractTagAttribute(speechTag, "aria-label") ?? "");
  if (speechAriaLabel) {
    return speechAriaLabel;
  }

  const semanticSpeech = formulaFromSpeechText(extractTagAttribute(openingTag, "data-semantic-speech") ?? "");
  if (semanticSpeech) {
    return semanticSpeech;
  }

  const title = normalizeMathText(extractTagAttribute(openingTag, "title") ?? "");
  if (!title) {
    return undefined;
  }
  return {
    text: title,
    format: "speech"
  };
}

function renderFormulaTextHtml(formula: MathFormulaText, display: boolean): string {
  if (formula.format === "mathml" && formula.mathml) {
    const latexBody = display ? `$$${formula.text}$$` : `$${formula.text}$`;
    const speechAttribute = formula.speech ? ` data-math-speech="${escapeHtmlText(formula.speech)}"` : "";
    const attributes = `class="math-formula${display ? " display" : ""}" data-math-format="mathml" data-latex="${escapeHtmlText(latexBody)}"${speechAttribute}`;
    return display
      ? `<div ${attributes}>${formula.mathml}</div>`
      : `<span ${attributes}>${formula.mathml}</span>`;
  }

  const body = formula.format === "latex"
    ? display
      ? `$$${formula.text}$$`
      : `$${formula.text}$`
    : formula.text;
  const escaped = escapeHtmlText(body);
  const speechAttribute = formula.speech ? ` data-math-speech="${escapeHtmlText(formula.speech)}"` : "";
  const attributes = `class="math-formula" data-math-format="${formula.format}"${speechAttribute}`;
  return display
    ? `<div ${attributes.replace('class="math-formula"', 'class="math-formula display"')}>${escaped}</div>`
    : `<span ${attributes}>${escaped}</span>`;
}

function normalizeMathJaxHtml(html: string): string {
  return html
    .replace(
      /<script\b[^>]*\btype=["']math\/tex(?:;[^"']*)?["'][^>]*>([\s\S]*?)<\/script>/gi,
      (match, text: string) => {
        const normalizedText = normalizeMathText(text);
        if (!normalizedText) {
          return match;
        }
        return renderFormulaTextHtml({
          text: normalizeLatexFormulaText(normalizedText),
          format: "latex"
        }, /type=["']math\/tex;\s*mode=display["']/i.test(match));
      }
    )
    .replace(/<mjx-container\b[^>]*>[\s\S]*?<\/mjx-container>/gi, (match) => {
      if (/<mjx-lazy\b/i.test(match) && !/<annotation\b/i.test(match)) {
        return match;
      }

      const formulaText = formulaTextFromMathJaxHtml(match);
      if (!formulaText) {
        return match;
      }

      return renderFormulaTextHtml(
        formulaText,
        /\bdisplay\s*=\s*["']?(?:true|block)/i.test(match)
      );
    })
    .replace(/<(span|div)\b([^>]*)>([^<>]*)<\/\1>/gi, (match, tagName: string, attributes: string, text: string) => {
      if (!/\bclass=["'][^"']*\bmath-formula\b/i.test(attributes)) {
        return match;
      }
      const display = tagName.toLowerCase() === "div" || /\bdisplay\b/i.test(attributes);
      const speechText = extractTagAttribute(`<${tagName}${attributes}>`, "data-math-speech") ?? "";
      const speechFormula = formulaFromSpeechText(speechText);
      if (speechFormula) {
        return renderFormulaTextHtml(speechFormula, display);
      }
      if (/\bdata-math-format=/i.test(attributes)) {
        return match;
      }
      const normalizedText = normalizeMathText(text);
      if (!normalizedText || /^\${1,2}/.test(normalizedText)) {
        return match;
      }
      const formulaText = formulaFromSpeechText(normalizedText);
      if (!formulaText || formulaText.format !== "latex") {
        return match;
      }
      return renderFormulaTextHtml(formulaText, display);
    });
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
      `<${tagName}\\b[^>]*\\s(?:class|id|role|aria-label|data-[\\w:-]+)=["'][^"']*(?:advert|altmetric|badge|banner|breadcrumb|cookie|dialog|dimensions|export|login|menu|metrics|modal|nav|newsletter|osano|popup|recommend|related|share|sidebar|sign-?up|skip|social|toolbar|tqc|z3988)[^"']*["'][^>]*>[\\s\\S]*?<\\/${tagName}>`,
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

  for (const pattern of [
    /<img\b[^>]*(?:badge\.dimensions\.ai|__dimensions)[^>]*>/gi,
    /<a\b[^>]*(?:altmetric\.com|link-to-altmetric-details-tab)[^>]*>[\s\S]*?<\/a>/gi,
    /<div\b[^>]*class=["'][^"']*__db_[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    /<li\b[^>]*class=["'][^"']*\barticle-feature-tag\b[^"']*["'][^>]*>\s*Access by [\s\S]*?<\/li>/gi,
    /<p\b[^>]*>\s*(?:&copy;|\u00a9)\s*\d{4}\s+American Physical Society\s*<\/p>/gi
  ]) {
    const before = nextHtml;
    nextHtml = nextHtml.replace(pattern, " ");
    if (nextHtml !== before) {
      removed += 1;
    }
  }

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
    .replace(/<([a-z][a-z0-9:-]*)\b[^>]*\bclass=["'][^"']*\bmath-formula\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, (match) => {
      const openingTag = match.match(/^<[^>]+>/)?.[0] ?? "";
      return extractTagAttribute(openingTag, "data-latex") ?? match;
    })
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

function resolvePandocBin(options: {
  env: FetchPaperWebPageEnvironment;
  pandocBin?: string;
}): string | undefined {
  const configured = options.pandocBin?.trim() ||
    options.env.PI_PAPER_WEBPAGE_PANDOC_BIN?.trim() ||
    options.env.PI_PAPER_READER_PANDOC_BIN?.trim();
  if (configured) {
    return configured;
  }
  if (/^(0|false|off|no)$/i.test(options.env.PI_PAPER_WEBPAGE_PANDOC ?? "")) {
    return undefined;
  }
  return "pandoc";
}

function resolvePandocTimeoutMs(env: FetchPaperWebPageEnvironment): number {
  const value = Number(env.PI_PAPER_WEBPAGE_PANDOC_TIMEOUT_MS || "") ||
    Number(env.PI_PAPER_READER_TIMEOUT_MS || "") ||
    DEFAULT_PANDOC_TIMEOUT_MS;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PANDOC_TIMEOUT_MS;
}

async function htmlToMarkdownWithPandoc(input: {
  html: string;
  env: FetchPaperWebPageEnvironment;
  pandocBin?: string;
}): Promise<string | undefined> {
  const pandocBin = resolvePandocBin(input);
  if (!pandocBin) {
    return undefined;
  }

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "pi-paper-webpage-pandoc-"));
  try {
    const htmlPath = path.join(outputDir, "article.html");
    const markdownPath = path.join(outputDir, "article.md");
    await writeFile(htmlPath, input.html, "utf8");
    await execFileAsync(
      pandocBin,
      [
        "--from",
        "html",
        "--to",
        "gfm",
        "--wrap=none",
        "--output",
        markdownPath,
        htmlPath
      ],
      {
        timeout: resolvePandocTimeoutMs(input.env),
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8"
      }
    );
    const markdown = (await readFile(markdownPath, "utf8")).trim();
    return markdown || undefined;
  } catch {
    return undefined;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

function isArxivUrl(url: string): boolean {
  try {
    return /(^|\.)arxiv\.org$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isLikelyLatexmlHtml(html: string): boolean {
  return /\bltx_(?:document|page_main|page_content|para|section|abstract)\b|LaTeXML/i.test(html);
}

function maybeSanitizeLatexmlMarkdown(input: {
  url: string;
  html: string;
  markdown: string;
}): string {
  if (!isArxivUrl(input.url) && !isLikelyLatexmlHtml(input.html)) {
    return input.markdown;
  }
  return sanitizeLatexmlMarkdown(input.markdown);
}

function htmlSnapshotHasRenderableLatex(html: string): boolean {
  return /\bdata-math-format=["']latex["']/i.test(html);
}

function extractMathFormulaMarkdown(match: string): string | undefined {
  const openingTag = match.match(/^<[^>]+>/)?.[0] ?? "";
  const dataLatex = extractTagAttribute(openingTag, "data-latex");
  if (dataLatex?.trim()) {
    return dataLatex.trim();
  }

  const text = normalizeMathText(match.replace(/<[^>]+>/g, " "));
  return text ? decodeHtmlEntities(text) : undefined;
}

function replaceMathFormulaBlocksWithPlaceholders(html: string): {
  html: string;
  formulas: string[];
} {
  const formulas: string[] = [];
  const replaced = html.replace(
    /<([a-z][a-z0-9:-]*)\b[^>]*\bclass=["'][^"']*\bmath-formula\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    (match) => {
      const formula = extractMathFormulaMarkdown(match);
      if (!formula) {
        return match;
      }
      const token = `PIAGENTMATH${formulas.length}`;
      formulas.push(formula);
      return `<span>${token}</span>`;
    }
  );
  return { html: replaced, formulas };
}

function restoreMathFormulaPlaceholders(markdown: string, formulas: string[]): string {
  let restored = markdown;
  for (let index = 0; index < formulas.length; index += 1) {
    restored = restored.replace(new RegExp(`\\bPIAGENTMATH${index}\\b`, "g"), formulas[index] ?? "");
  }
  return restored;
}

function buildKatexAutoRenderHead(html: string): string[] {
  if (!htmlSnapshotHasRenderableLatex(html)) {
    return [];
  }
  return [
    '  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">',
    '  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js"></script>',
    "  <script defer src=\"https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/auto-render.min.js\" onload=\"renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false});\"></script>"
  ];
}

function buildReadableHtmlSnapshot(input: {
  url: string;
  title?: string;
  html: string;
}): string {
  const title = escapeHtmlText(input.title?.trim() || input.url);
  const body = input.html.trim();
  const katexHead = buildKatexAutoRenderHead(body);
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '  <meta charset="utf-8">',
    `  <title>${title}</title>`,
    ...katexHead,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    ""
  ].join("\n");
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

function buildPaperWebPageExtraction(input: {
  url: string;
  html: string;
  markdown: string;
}): PaperWebPageExtraction {
  const html = normalizeMathJaxHtml(input.html);
  const cleanedMarkdown = cleanMarkdown(input.markdown);
  const selected = selectArticleHtml(stripComments(html));
  const cleanedBlocks = removeKnownNoiseBlocks(selected.html);
  const metadata = extractMetadata(html, {
    html: selected.html,
    baseUrl: input.url
  });
  const access = detectAccessStatus(selected.html);

  return {
    url: input.url,
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(html ? { html } : {}),
    snapshotHtml: buildReadableHtmlSnapshot({
      url: input.url,
      ...(metadata.title ? { title: metadata.title } : {}),
      html: cleanedBlocks.html
    }),
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

export function parsePaperWebPageHtml(options: ParsePaperWebPageHtmlOptions): PaperWebPageExtraction {
  const html = normalizeMathJaxHtml(options.html);
  const selected = selectArticleHtml(stripComments(html));
  const cleanedBlocks = removeKnownNoiseBlocks(selected.html);
  const markdown = maybeSanitizeLatexmlMarkdown({
    url: options.url,
    html,
    markdown: htmlToMarkdown(cleanedBlocks.html)
  });
  return buildPaperWebPageExtraction({
    url: options.url,
    html,
    markdown
  });
}

export async function parsePaperWebPageHtmlWithPandoc(
  options: ParsePaperWebPageHtmlOptions
): Promise<PaperWebPageExtraction> {
  const html = normalizeMathJaxHtml(options.html);
  const selected = selectArticleHtml(stripComments(html));
  const cleanedBlocks = removeKnownNoiseBlocks(selected.html);
  const pandocInput = replaceMathFormulaBlocksWithPlaceholders(cleanedBlocks.html);
  const rawMarkdown = await htmlToMarkdownWithPandoc({
    html: pandocInput.html,
    env: options.env ?? process.env,
    ...(options.pandocBin ? { pandocBin: options.pandocBin } : {})
  });
  const markdownFromPandoc = rawMarkdown
    ? restoreMathFormulaPlaceholders(rawMarkdown, pandocInput.formulas)
    : undefined;
  const markdownSource = markdownFromPandoc ?? htmlToMarkdown(cleanedBlocks.html);
  const markdown = maybeSanitizeLatexmlMarkdown({
    url: options.url,
    html,
    markdown: markdownSource
  });
  return buildPaperWebPageExtraction({
    url: options.url,
    html,
    markdown
  });
}

export function diagnosePaperWebPageHtml(options: {
  url: string;
  html: string;
}): PaperWebPageHtmlDiagnostic {
  const html = normalizeMathJaxHtml(options.html);
  const selected = selectArticleHtml(stripComments(html));
  const cleanedBlocks = removeKnownNoiseBlocks(selected.html);
  const unfilteredMarkdown = htmlToMarkdown(selected.html);
  const cleanedMarkdown = cleanMarkdown(htmlToMarkdown(cleanedBlocks.html));
  const candidates = buildHtmlCandidateDiagnostics(stripComments(html))
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
  const requestTimeoutMs = resolveFetchTimeoutMs(env);
  const timeout = withRequestTimeout(requestTimeoutMs);
  const userAgent = normalizeUserAgent(env);

  try {
    const response = await fetchImpl(endpoint, {
      headers: new Headers({
        "user-agent": userAgent
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

    const html = await response.text();
    const finalUrl = response.url || endpoint.toString();
    const extraction = await parsePaperWebPageHtmlWithPandoc({
      url: finalUrl,
      html,
      env
    });
    const arxivMetadata = await fetchArxivAbsMetadata({
      articleUrl: finalUrl,
      fetchImpl,
      signal: timeout.signal,
      userAgent
    });
    const extractionWithMetadata = Object.keys(arxivMetadata).length > 0
      ? {
          ...extraction,
          metadata: {
            ...extraction.metadata,
            ...arxivMetadata
          }
        }
      : extraction;
    const selected = selectArticleHtml(stripComments(html));
    const cleanedBlocks = removeKnownNoiseBlocks(selected.html);
    const assets = await fetchImageAssets({
      candidates: collectImageAssetCandidates(cleanedBlocks.html, resolveArticleAssetBaseUrl(new URL(finalUrl))),
      fetchImpl,
      userAgent,
      timeoutMs: requestTimeoutMs
    });

    return assets.length > 0
      ? { ...extractionWithMetadata, assets }
      : extractionWithMetadata;
  } finally {
    timeout.dispose();
  }
}
