import path from "node:path";
import { readFile } from "node:fs/promises";
import { createPaperChunks } from "./chunks.js";
import { parseWithOpenDataLoader } from "./engines/opendataloader.js";
import { parseWithPlainTextBaseline } from "./engines/plain-text-baseline.js";
import {
  assertPaperReadingExists,
  getPaperParseArtifactPaths,
  listPaperParseEngines,
  readCachedParse,
  readParsedPaperDocument,
  readPaperSourceByKey,
  resolvePaperSource,
  writeParseArtifacts
} from "./paper-reader-store.js";
import { evaluateParseQuality } from "./quality.js";
import type {
  ConcretePaperParseEngine,
  PaperInspectionResult,
  PaperParseEngine,
  PaperParseQualityReport,
  PaperParseResult,
  PaperSection,
  PaperSectionReadResult,
  PaperTextSearchResult,
  ParsedPaperDocument
} from "./types.js";
import { PaperReaderError } from "./types.js";

export interface ParsePaperOptions {
  workspaceDir: string;
  path?: string;
  recordPath?: string;
  engine?: PaperParseEngine;
  force?: boolean;
  opendataloaderBin?: string;
}

export interface InspectPaperOptions {
  workspaceDir: string;
  path?: string;
  recordPath?: string;
  paperKey?: string;
}

export interface ReadPaperSectionOptions {
  workspaceDir: string;
  paperKey: string;
  engine?: ConcretePaperParseEngine;
  sectionId?: string;
  pageFrom?: number;
  pageTo?: number;
  maxChars?: number;
}

export interface SearchPaperTextOptions {
  workspaceDir: string;
  paperKey: string;
  engine?: ConcretePaperParseEngine;
  query: string;
  maxResults?: number;
}

const DEFAULT_MAX_SECTION_CHARS = 6000;
const MAX_SECTION_CHARS = 30_000;
const DEFAULT_SEARCH_RESULTS = 8;

function toSectionPreview(sections: PaperSection[]): PaperParseResult["sections"] {
  return sections.slice(0, 20).map((section) => ({
    id: section.id,
    title: section.title,
    level: section.level,
    pageFrom: section.pageFrom,
    pageTo: section.pageTo
  }));
}

function resolveConcreteEngine(engine: PaperParseEngine | undefined): ConcretePaperParseEngine {
  if (engine === undefined || engine === "auto") {
    return "opendataloader-local";
  }
  return engine;
}

function sortEnginesByPreference(engines: ConcretePaperParseEngine[]): ConcretePaperParseEngine[] {
  const priority: Record<ConcretePaperParseEngine, number> = {
    "opendataloader-hybrid": 0,
    "opendataloader-local": 1,
    "plain-text-baseline": 2
  };
  return engines.slice().sort((left, right) => priority[left] - priority[right]);
}

async function resolveAvailableEngine(input: {
  workspaceDir: string;
  paperKey: string;
  engine?: ConcretePaperParseEngine;
}): Promise<ConcretePaperParseEngine> {
  if (input.engine) {
    return input.engine;
  }
  const engines = sortEnginesByPreference(
    await listPaperParseEngines({
      workspaceDir: input.workspaceDir,
      paperKey: input.paperKey
    })
  );
  const engine = engines[0];
  if (!engine) {
    throw new PaperReaderError("paper_not_found", `No parsed paper found for ${input.paperKey}.`);
  }
  return engine;
}

async function runParser(input: {
  engine: ConcretePaperParseEngine;
  pdfPath: string;
  paperKey: string;
  pdfSha256: string;
  title?: string;
  opendataloaderBin?: string;
}): Promise<{ document: ParsedPaperDocument; markdown: string }> {
  if (input.engine === "plain-text-baseline") {
    return parseWithPlainTextBaseline(input);
  }

  return parseWithOpenDataLoader({
    pdfPath: input.pdfPath,
    paperKey: input.paperKey,
    pdfSha256: input.pdfSha256,
    engine: input.engine,
    ...(input.title ? { title: input.title } : {}),
    ...(input.opendataloaderBin ? { bin: input.opendataloaderBin } : {})
  });
}

async function parseWithConcreteEngine(input: {
  workspaceDir: string;
  path?: string;
  recordPath?: string;
  engine: ConcretePaperParseEngine;
  force?: boolean;
  opendataloaderBin?: string;
}): Promise<PaperParseResult> {
  const resolved = await resolvePaperSource(input);
  const cached = input.force === true
    ? null
    : await readCachedParse({
      workspaceDir: input.workspaceDir,
      paperKey: resolved.source.paperKey,
      engine: input.engine,
      pdfSha256: resolved.source.pdfSha256
    });
  if (cached) {
    return {
      status: "already_parsed",
      paperKey: resolved.source.paperKey,
      engine: input.engine,
      pdfSha256: resolved.source.pdfSha256,
      artifacts: cached.artifacts,
      quality: cached.quality,
      sections: toSectionPreview(cached.document.sections)
    };
  }

  const parsed = await runParser({
    engine: input.engine,
    pdfPath: resolved.source.pdfPath,
    paperKey: resolved.source.paperKey,
    pdfSha256: resolved.source.pdfSha256,
    ...(resolved.source.title ? { title: resolved.source.title } : {}),
    ...(input.opendataloaderBin ? { opendataloaderBin: input.opendataloaderBin } : {})
  });
  const quality = evaluateParseQuality(parsed.document);
  const chunks = createPaperChunks(parsed.document);
  const artifacts = await writeParseArtifacts({
    workspaceDir: input.workspaceDir,
    source: resolved.source,
    document: parsed.document,
    markdown: parsed.markdown,
    quality,
    chunks
  });

  return {
    status: "parsed",
    paperKey: resolved.source.paperKey,
    engine: input.engine,
    pdfSha256: resolved.source.pdfSha256,
    artifacts,
    quality,
    sections: toSectionPreview(parsed.document.sections)
  };
}

export async function parsePaper(options: ParsePaperOptions): Promise<PaperParseResult> {
  const requestedEngine = options.engine ?? "auto";
  if (requestedEngine !== "auto") {
    return parseWithConcreteEngine({
      workspaceDir: options.workspaceDir,
      ...(options.path ? { path: options.path } : {}),
      ...(options.recordPath ? { recordPath: options.recordPath } : {}),
      engine: resolveConcreteEngine(requestedEngine),
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.opendataloaderBin ? { opendataloaderBin: options.opendataloaderBin } : {})
    });
  }

  const localResult = await parseWithConcreteEngine({
    workspaceDir: options.workspaceDir,
    ...(options.path ? { path: options.path } : {}),
    ...(options.recordPath ? { recordPath: options.recordPath } : {}),
    engine: "opendataloader-local",
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.opendataloaderBin ? { opendataloaderBin: options.opendataloaderBin } : {})
  });

  if (localResult.quality.status !== "needs_hybrid") {
    return localResult;
  }

  try {
    return await parseWithConcreteEngine({
      workspaceDir: options.workspaceDir,
      ...(options.path ? { path: options.path } : {}),
      ...(options.recordPath ? { recordPath: options.recordPath } : {}),
      engine: "opendataloader-hybrid",
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.opendataloaderBin ? { opendataloaderBin: options.opendataloaderBin } : {})
    });
  } catch (error) {
    if (error instanceof PaperReaderError && error.code === "hybrid_server_unavailable") {
      return localResult;
    }
    throw error;
  }
}

async function readParseSummary(input: {
  workspaceDir: string;
  paperKey: string;
  engine: ConcretePaperParseEngine;
}): Promise<PaperInspectionResult["parses"][number] | undefined> {
  const artifacts = getPaperParseArtifactPaths(input);
  try {
    const [documentText, qualityText] = await Promise.all([
      readFile(artifacts.parsePath, "utf8"),
      readFile(artifacts.qualityPath, "utf8")
    ]);
    const document = JSON.parse(documentText) as ParsedPaperDocument;
    const quality = JSON.parse(qualityText) as PaperParseQualityReport;
    return {
      engine: input.engine,
      pdfSha256: document.pdfSha256,
      createdAt: document.createdAt,
      markdownPath: path.relative(input.workspaceDir, artifacts.markdownPath),
      parsePath: path.relative(input.workspaceDir, artifacts.parsePath),
      qualityPath: path.relative(input.workspaceDir, artifacts.qualityPath),
      chunksPath: path.relative(input.workspaceDir, artifacts.chunksPath),
      quality,
      sections: toSectionPreview(document.sections)
    };
  } catch {
    return undefined;
  }
}

export async function inspectPaper(options: InspectPaperOptions): Promise<PaperInspectionResult> {
  let paperKey = options.paperKey;
  if (!paperKey) {
    const resolved = await resolvePaperSource({
      workspaceDir: options.workspaceDir,
      ...(options.path ? { path: options.path } : {}),
      ...(options.recordPath ? { recordPath: options.recordPath } : {})
    });
    paperKey = resolved.source.paperKey;
  }
  if (!paperKey) {
    throw new PaperReaderError("paper_not_found", "paperKey is required.");
  }

  await assertPaperReadingExists({ workspaceDir: options.workspaceDir, paperKey });
  const [source, engines] = await Promise.all([
    readPaperSourceByKey({ workspaceDir: options.workspaceDir, paperKey }),
    listPaperParseEngines({ workspaceDir: options.workspaceDir, paperKey })
  ]);
  const parses = (await Promise.all(
    engines.map((engine) => readParseSummary({
      workspaceDir: options.workspaceDir,
      paperKey,
      engine
    }))
  )).filter((parse): parse is PaperInspectionResult["parses"][number] => parse !== undefined);

  return {
    paperKey,
    ...(source ? { source } : {}),
    parses
  };
}

export async function readPaperSection(
  options: ReadPaperSectionOptions
): Promise<PaperSectionReadResult> {
  const engine = await resolveAvailableEngine(options);
  const document = await readParsedPaperDocument({
    workspaceDir: options.workspaceDir,
    paperKey: options.paperKey,
    engine
  });
  const pageFrom = options.pageFrom;
  const pageTo = options.pageTo;
  if ((pageFrom !== undefined && pageFrom < 1) || (pageTo !== undefined && pageTo < 1)) {
    throw new Error("pageFrom and pageTo must be positive page numbers.");
  }
  if (pageFrom !== undefined && pageTo !== undefined && pageFrom > pageTo) {
    throw new Error("pageFrom must be less than or equal to pageTo.");
  }

  const maxChars = Math.min(
    MAX_SECTION_CHARS,
    Math.max(1, Math.trunc(options.maxChars ?? DEFAULT_MAX_SECTION_CHARS))
  );
  const elements = document.elements.filter((element) => {
    if (options.sectionId && element.sectionId !== options.sectionId) {
      return false;
    }
    if (pageFrom !== undefined && element.page < pageFrom) {
      return false;
    }
    if (pageTo !== undefined && element.page > pageTo) {
      return false;
    }
    return true;
  });
  const fullText = elements.map((element) => `[p.${element.page}] ${element.text.trim()}`).join("\n\n");
  const truncated = fullText.length > maxChars;
  const text = truncated ? fullText.slice(0, maxChars).trimEnd() : fullText;

  return {
    paperKey: options.paperKey,
    engine,
    ...(options.sectionId ? { sectionId: options.sectionId } : {}),
    ...(pageFrom !== undefined ? { pageFrom } : {}),
    ...(pageTo !== undefined ? { pageTo } : {}),
    maxChars,
    text,
    truncated,
    elements: elements.map((element) => ({
      id: element.id,
      type: element.type,
      page: element.page,
      ...(element.bbox ? { bbox: element.bbox } : {}),
      ...(element.sectionId ? { sectionId: element.sectionId } : {})
    }))
  };
}

function createSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const lowerText = normalizedText.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index < 0) {
    return normalizedText.slice(0, 240);
  }
  const start = Math.max(0, index - 90);
  const end = Math.min(normalizedText.length, index + query.length + 140);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < normalizedText.length ? " ..." : "";
  return `${prefix}${normalizedText.slice(start, end)}${suffix}`;
}

export async function searchPaperText(
  options: SearchPaperTextOptions
): Promise<PaperTextSearchResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("query is required.");
  }

  const maxResults = Math.max(1, Math.trunc(options.maxResults ?? DEFAULT_SEARCH_RESULTS));
  const engine = await resolveAvailableEngine(options);
  const document = await readParsedPaperDocument({
    workspaceDir: options.workspaceDir,
    paperKey: options.paperKey,
    engine
  });
  const lowerQuery = query.toLowerCase();
  const results = document.elements
    .filter((element) => element.text.toLowerCase().includes(lowerQuery))
    .slice(0, maxResults)
    .map((element) => ({
      elementId: element.id,
      type: element.type,
      page: element.page,
      ...(element.sectionId ? { sectionId: element.sectionId } : {}),
      ...(element.bbox ? { bbox: element.bbox } : {}),
      snippet: createSnippet(element.text, query)
    }));

  return {
    paperKey: options.paperKey,
    engine,
    query,
    results
  };
}
