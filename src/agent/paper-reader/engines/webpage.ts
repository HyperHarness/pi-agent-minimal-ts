import { createHash } from "node:crypto";
import { createPaperChunks } from "../chunks.js";
import {
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
  return hash.digest("hex");
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
  const sourceSha256 = hashWebpageExtraction(options.extraction);
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
    extraction: options.extraction
  });
  const source = await buildSource({
    workspaceDir: options.workspaceDir,
    paperKey,
    extraction: options.extraction,
    sourceSha256
  });
  const quality = applyWebpageAccessQualityWarning({
    quality: evaluateParseQuality(document),
    extraction: options.extraction
  });
  const chunks = createPaperChunks(document);
  const artifacts = await writeParseArtifacts({
    workspaceDir: options.workspaceDir,
    source,
    document,
    markdown: options.extraction.markdown,
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
