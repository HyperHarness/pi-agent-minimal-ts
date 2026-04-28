import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPaperChunks } from "../chunks.js";
import {
  getParseDir,
  readCachedParse,
  readPaperSourceByKey,
  writeParseArtifacts
} from "../paper-reader-store.js";
import { evaluateParseQuality } from "../quality.js";
import type {
  PaperElement,
  PaperElementType,
  PaperParseQualityReport,
  PaperParseResult,
  PaperReaderSource,
  PaperSection,
  ParsedPaperDocument
} from "../types.js";
import type { PaperWebPageExtraction } from "../../paper-webpage-fetch.js";
import { getPublisherAdapter } from "../../publisher-adapters/index.js";
import { resolvePublisherCanonicalIdFromArticleUrl } from "../../paper-download.js";
import { parseArxivLocator } from "../../arxiv.js";

export interface SavePaperWebPageParseOptions {
  workspaceDir: string;
  extraction: PaperWebPageExtraction;
  paperKey?: string;
  force?: boolean;
}

function sanitizePaperKey(value: string): string {
  const sanitized = value
    .trim()
    .replace(/\.[Jj][Ss][Oo][Nn]$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "");

  if (!sanitized) {
    throw new Error("Unable to derive a paper key.");
  }
  return sanitized;
}

function paperKeyFromUrl(url: string): string | undefined {
  try {
    const locator = parseArxivLocator(url);
    return sanitizePaperKey(`arxiv-${locator.id}`);
  } catch {
    // Continue with publisher URL matching.
  }

  try {
    const adapter = getPublisherAdapter(url);
    const canonicalId = resolvePublisherCanonicalIdFromArticleUrl({
      publisher: adapter.id,
      articleUrl: url
    });
    return canonicalId ? sanitizePaperKey(`${adapter.id}-${canonicalId}`) : undefined;
  } catch {
    return undefined;
  }
}

function paperKeyFromDoi(doi: string | undefined): string | undefined {
  return doi ? sanitizePaperKey(`doi-${doi}`) : undefined;
}

function paperKeyFromFallbackUrl(url: string): string {
  const parsedUrl = new URL(url);
  return sanitizePaperKey(`${parsedUrl.hostname}${parsedUrl.pathname}`);
}

function resolvePaperKey(input: {
  paperKey?: string;
  extraction: PaperWebPageExtraction;
}): string {
  if (input.paperKey?.trim()) {
    return sanitizePaperKey(input.paperKey);
  }

  return (
    paperKeyFromUrl(input.extraction.url) ??
    paperKeyFromDoi(input.extraction.metadata.doi) ??
    paperKeyFromFallbackUrl(input.extraction.url)
  );
}

function hashWebpageExtraction(extraction: PaperWebPageExtraction): string {
  const hash = createHash("sha256");
  hash.update(extraction.url);
  hash.update("\0");
  hash.update(extraction.markdown);
  for (const asset of extraction.assets ?? []) {
    hash.update("\0asset\0");
    hash.update(asset.url);
    hash.update("\0");
    hash.update(asset.originalUrl ?? "");
    hash.update("\0");
    hash.update(asset.filename ?? "");
    hash.update("\0");
    hash.update(asset.mimeType ?? "");
    hash.update("\0");
    hash.update(asset.dataBase64);
  }
  return hash.digest("hex");
}

function extensionFromMimeType(mimeType: string | undefined): string {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpeg") {
    return ".jpg";
  }
  if (normalized === "image/png") {
    return ".png";
  }
  if (normalized === "image/gif") {
    return ".gif";
  }
  if (normalized === "image/webp") {
    return ".webp";
  }
  if (normalized === "image/svg+xml") {
    return ".svg";
  }
  if (normalized === "application/pdf") {
    return ".pdf";
  }
  return "";
}

function filenameFromAssetUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return decodeURIComponent(path.posix.basename(parsed.pathname));
  } catch {
    const withoutQuery = value.split(/[?#]/, 1)[0] ?? "";
    return path.basename(withoutQuery);
  }
}

function sanitizeAssetFilename(value: string): string {
  return value
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
}

function isUsableAssetFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    !value.toLowerCase().includes("base64")
  );
}

function uniqueAssetFilename(input: {
  preferred?: string;
  url: string;
  mimeType?: string;
  index: number;
  used: Set<string>;
}): string {
  const fallback = `asset-${String(input.index + 1).padStart(3, "0")}${extensionFromMimeType(input.mimeType)}`;
  const preferred = sanitizeAssetFilename(input.preferred ?? "");
  const fromUrl = sanitizeAssetFilename(filenameFromAssetUrl(input.url));
  const sanitized = isUsableAssetFilename(preferred)
    ? preferred
    : isUsableAssetFilename(fromUrl)
      ? fromUrl
      : fallback;
  const ext = path.extname(sanitized) || extensionFromMimeType(input.mimeType);
  const stem = sanitizeAssetFilename(path.basename(sanitized, path.extname(sanitized))) || `asset-${input.index + 1}`;
  let candidate = `${stem}${ext}`;
  let suffix = 2;
  while (input.used.has(candidate.toLowerCase())) {
    candidate = `${stem}-${suffix}${ext}`;
    suffix += 1;
  }
  input.used.add(candidate.toLowerCase());
  return candidate;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteMarkdownImageLinks(
  markdown: string,
  replacements: Map<string, string>
): string {
  if (replacements.size === 0) {
    return markdown;
  }

  return markdown.replace(
    /!\[([^\]]*)]\(([^)\n]+)\)(\{[^}\n]*})?/g,
    (match, alt: string, target: string) => {
      const trimmedTarget = target.trim().replace(/^<|>$/g, "");
      const replacement = replacements.get(trimmedTarget);
      return replacement ? `![${alt}](${replacement})` : match;
    }
  );
}

function natureImageStemFromArticleUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)nature\.com$/i.test(parsed.hostname)) {
      return undefined;
    }
    const match = parsed.pathname.match(/\/articles\/s(\d+)-(\d{3})-0*(\d+)-[a-z0-9]+/i);
    if (!match?.[1] || !match[2] || !match[3]) {
      return undefined;
    }
    return `${match[1]}_${2000 + Number(match[2])}_${Number(match[3])}`;
  } catch {
    return undefined;
  }
}

function assetBelongsToArticle(input: {
  extractionUrl: string;
  assetUrl: string;
  filename: string;
}): boolean {
  const natureStem = natureImageStemFromArticleUrl(input.extractionUrl);
  if (!natureStem) {
    return true;
  }

  const candidates = [input.assetUrl, input.filename].join(" ");
  if (/media\.springernature\.com|MediaObjects/i.test(candidates)) {
    return candidates.includes(natureStem);
  }

  return true;
}

function figureNumberFromAssetFilename(filename: string): string | undefined {
  const match = filename.match(/(?:^|[_-])Fig(?:ure)?[_-]?(\d+)(?:[_-]|\.|$)/i);
  return match?.[1] ? String(Number(match[1])) : undefined;
}

function insertMissingFigureAssetLinks(markdown: string, assets: Array<{ filename: string }>): string {
  if (/!\[[^\]]*]\(assets\//.test(markdown)) {
    return markdown;
  }

  const figureAssets = new Map<string, string>();
  for (const asset of assets) {
    const figureNumber = figureNumberFromAssetFilename(asset.filename);
    if (figureNumber && !figureAssets.has(figureNumber)) {
      figureAssets.set(figureNumber, `assets/${asset.filename}`);
    }
  }
  if (figureAssets.size === 0) {
    return markdown;
  }

  const lines = markdown.split("\n");
  const rewritten: string[] = [];
  for (const line of lines) {
    const captionMatch = line.match(/^(?:Figure:\s*)?Fig\.\s*(\d+)\b/i);
    if (captionMatch?.[1]) {
      const relativePath = figureAssets.get(String(Number(captionMatch[1])));
      if (relativePath && rewritten[rewritten.length - 1] !== `![Fig. ${captionMatch[1]}](${relativePath})`) {
        if (rewritten.length > 0 && rewritten[rewritten.length - 1] !== "") {
          rewritten.push("");
        }
        rewritten.push(`![Fig. ${captionMatch[1]}](${relativePath})`);
        rewritten.push("");
      }
    }
    rewritten.push(line);
  }

  return rewritten.join("\n");
}

async function materializeWebpageAssets(input: {
  workspaceDir: string;
  paperKey: string;
  extraction: PaperWebPageExtraction;
}): Promise<PaperWebPageExtraction> {
  const assets = input.extraction.assets?.filter((asset) => asset.dataBase64.trim()) ?? [];
  if (assets.length === 0) {
    return input.extraction;
  }

  const assetsDir = path.join(getParseDir(input.workspaceDir, input.paperKey, "webpage"), "assets");
  await rm(assetsDir, { recursive: true, force: true });
  await mkdir(assetsDir, { recursive: true });

  const used = new Set<string>();
  const replacements = new Map<string, string>();
  const materializedAssets = [];

  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index]!;
    const filename = uniqueAssetFilename({
      preferred: asset.filename,
      url: asset.url,
      mimeType: asset.mimeType,
      index,
      used
    });
    const relativePath = `assets/${filename}`;
    if (!assetBelongsToArticle({
      extractionUrl: input.extraction.url,
      assetUrl: asset.url,
      filename
    })) {
      continue;
    }
    const buffer = Buffer.from(asset.dataBase64, "base64");
    await writeFile(path.join(assetsDir, filename), buffer);

    replacements.set(asset.url, relativePath);
    if (asset.originalUrl) {
      replacements.set(asset.originalUrl, relativePath);
      try {
        replacements.set(new URL(asset.originalUrl, input.extraction.url).toString(), relativePath);
      } catch {
        // Keep the original link replacement only.
      }
    }

    materializedAssets.push({
      ...asset,
      filename
    });
  }

  let markdown = input.extraction.markdown;
  markdown = rewriteMarkdownImageLinks(markdown, replacements);

  for (const [target, replacement] of replacements.entries()) {
    markdown = markdown.replace(new RegExp(escapeRegExp(target), "g"), replacement);
  }
  markdown = insertMissingFigureAssetLinks(markdown, materializedAssets);

  return {
    ...input.extraction,
    markdown,
    assets: materializedAssets
  };
}

function sectionIdFromTitle(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `section-${slug}` : `section-${index + 1}`;
}

function elementTypeFromLine(line: string, currentSection?: PaperSection): PaperElementType {
  if (/^#{1,6}\s+/.test(line)) {
    return "heading";
  }
  if (/^(?:-|\*)\s+/.test(line)) {
    return "list";
  }
  if (/^Figure:\s+|^Fig\.\s*\d+/i.test(line)) {
    return "caption";
  }
  if (currentSection?.title.toLowerCase().includes("reference")) {
    return "reference";
  }
  return "paragraph";
}

function stripMarkdownMarker(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:-|\*)\s+/, "")
    .trim();
}

function buildWebpageDocument(input: {
  paperKey: string;
  sourceSha256: string;
  extraction: PaperWebPageExtraction;
}): ParsedPaperDocument {
  const elements: PaperElement[] = [];
  const sections: PaperSection[] = [];
  let currentSection: PaperSection | undefined;

  const pushElement = (line: string) => {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch?.[1] && headingMatch[2]) {
      const title = headingMatch[2].trim();
      currentSection = {
        id: sectionIdFromTitle(title, sections.length),
        title,
        level: headingMatch[1].length,
        pageFrom: 1,
        pageTo: 1,
        elementIds: []
      };
      sections.push(currentSection);
    }

    const text = stripMarkdownMarker(line);
    if (!text) {
      return;
    }

    const element: PaperElement = {
      id: `webpage-${String(elements.length + 1).padStart(5, "0")}`,
      type: elementTypeFromLine(line, currentSection),
      text,
      page: 1,
      ...(currentSection ? { sectionId: currentSection.id } : {}),
      ...(headingMatch?.[1] ? { headingLevel: headingMatch[1].length } : {})
    };
    elements.push(element);
    currentSection?.elementIds.push(element.id);
  };

  for (const block of input.extraction.markdown.split(/\n{2,}/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      pushElement(line);
    }
  }

  if (sections.length === 0 && input.extraction.title) {
    const section: PaperSection = {
      id: "section-title",
      title: input.extraction.title,
      level: 1,
      pageFrom: 1,
      pageTo: 1,
      elementIds: elements.map((element) => element.id)
    };
    sections.push(section);
    for (const element of elements) {
      element.sectionId = section.id;
    }
  }

  return {
    paperKey: input.paperKey,
    engine: "webpage",
    pdfSha256: input.sourceSha256,
    createdAt: new Date().toISOString(),
    ...(input.extraction.title ? { title: input.extraction.title } : {}),
    pages: 1,
    elements,
    sections
  };
}

function toSectionPreview(sections: PaperSection[]): PaperParseResult["sections"] {
  return sections.slice(0, 20).map((section) => ({
    id: section.id,
    title: section.title,
    level: section.level,
    pageFrom: section.pageFrom,
    pageTo: section.pageTo
  }));
}

function resolvePublisherMetadata(url: string): {
  source?: string;
  canonicalId?: string;
} {
  try {
    const locator = parseArxivLocator(url);
    return {
      source: "arxiv",
      canonicalId: locator.id
    };
  } catch {
    // Continue with supported publisher URL matching.
  }

  try {
    const adapter = getPublisherAdapter(url);
    const canonicalId = resolvePublisherCanonicalIdFromArticleUrl({
      publisher: adapter.id,
      articleUrl: url
    });
    return {
      source: adapter.id,
      ...(canonicalId ? { canonicalId } : {})
    };
  } catch {
    return {};
  }
}

function applyWebpageAccessQualityWarning(input: {
  quality: PaperParseQualityReport;
  extraction: PaperWebPageExtraction;
}): PaperParseQualityReport {
  if (input.extraction.access.status !== "access_limited") {
    return input.quality;
  }

  const loginWarning =
    input.extraction.access.message ??
    "Publisher access wall detected. Ask the user to log in through the browser extension tab, then rerun fetch_paper_webpage.";
  const score = Math.min(input.quality.score, 0.45);
  const status = score >= 0.4 ? "needs_hybrid" : "poor";

  return {
    ...input.quality,
    status,
    score,
    warnings: input.quality.warnings.includes(loginWarning)
      ? input.quality.warnings
      : [loginWarning, ...input.quality.warnings]
  };
}

async function buildSource(input: {
  workspaceDir: string;
  paperKey: string;
  extraction: PaperWebPageExtraction;
  sourceSha256: string;
}): Promise<PaperReaderSource> {
  const existing = await readPaperSourceByKey({
    workspaceDir: input.workspaceDir,
    paperKey: input.paperKey
  });
  const publisher = resolvePublisherMetadata(input.extraction.url);
  return {
    ...(existing ?? {}),
    paperKey: input.paperKey,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    articleUrl: input.extraction.url,
    ...(publisher.source ? { source: existing?.source ?? publisher.source } : {}),
    ...(publisher.canonicalId ? { canonicalId: existing?.canonicalId ?? publisher.canonicalId } : {}),
    ...(input.extraction.title ? { title: existing?.title ?? input.extraction.title } : {}),
    ...(existing?.pdfPath ? { pdfPath: existing.pdfPath } : {}),
    ...(existing?.pdfSha256 ? { pdfSha256: existing.pdfSha256 } : {})
  };
}

export async function savePaperWebPageParse(
  options: SavePaperWebPageParseOptions
): Promise<PaperParseResult> {
  const paperKey = resolvePaperKey({
    ...(options.paperKey ? { paperKey: options.paperKey } : {}),
    extraction: options.extraction
  });
  const extraction = await materializeWebpageAssets({
    workspaceDir: options.workspaceDir,
    paperKey,
    extraction: options.extraction
  });
  const sourceSha256 = hashWebpageExtraction(extraction);
  const cached = options.force === true
    ? null
    : await readCachedParse({
      workspaceDir: options.workspaceDir,
      paperKey,
      engine: "webpage",
      pdfSha256: sourceSha256
    });

  if (cached) {
    return {
      status: "already_parsed",
      paperKey,
      engine: "webpage",
      pdfSha256: sourceSha256,
      artifacts: cached.artifacts,
      quality: cached.quality,
      sections: toSectionPreview(cached.document.sections)
    };
  }

  const document = buildWebpageDocument({
    paperKey,
    sourceSha256,
    extraction
  });
  const source = await buildSource({
    workspaceDir: options.workspaceDir,
    paperKey,
    extraction,
    sourceSha256
  });
  const quality = applyWebpageAccessQualityWarning({
    quality: evaluateParseQuality(document),
    extraction
  });
  const chunks = createPaperChunks(document);
  const artifacts = await writeParseArtifacts({
    workspaceDir: options.workspaceDir,
    source,
    document,
    markdown: extraction.markdown,
    quality,
    chunks
  });

  return {
    status: "parsed",
    paperKey,
    engine: "webpage",
    pdfSha256: sourceSha256,
    artifacts,
    quality,
    sections: toSectionPreview(document.sections)
  };
}
