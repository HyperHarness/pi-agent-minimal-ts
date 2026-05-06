import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { createPaperChunks } from "./chunks.js";
import { parseWithDocling } from "./engines/docling.js";
import { parseWithOpenDataLoader } from "./engines/opendataloader.js";
import { parseWithPlainTextBaseline } from "./engines/plain-text-baseline.js";
import { parseWithTexSource } from "./engines/tex-source.js";
import {
  assertPaperReadingExists,
  getPaperParseArtifactPaths,
  listPaperParseEngines,
  readCachedParse,
  readParsedPaperDocument,
  readPaperSourceByKey,
  resolveExistingPaperKey,
  resolvePaperSource,
  writeParseArtifacts
} from "./paper-reader-store.js";
import { evaluateParseQuality, evaluateParseQualityWithMarkdown } from "./quality.js";
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
  latexmlBin?: string;
  pandocBin?: string;
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

function enginePreference(engine: ConcretePaperParseEngine): number {
  const priority: Record<ConcretePaperParseEngine, number> = {
    "webpage": 0,
    "tex-source": 1,
    "opendataloader-hybrid": 2,
    "opendataloader-local": 3,
    "docling": 4,
    "plain-text-baseline": 5
  };
  return priority[engine];
}

function sortEnginesByPreference(engines: ConcretePaperParseEngine[]): ConcretePaperParseEngine[] {
  return engines.slice().sort((left, right) => enginePreference(left) - enginePreference(right));
}

function qualityStatusRank(status: PaperParseQualityReport["status"]): number {
  const rank: Record<PaperParseQualityReport["status"], number> = {
    good: 3,
    needs_hybrid: 2,
    poor: 1
  };
  return rank[status];
}

function statusFromScore(score: number): PaperParseQualityReport["status"] {
  return score >= 0.7 ? "good" : score >= 0.4 ? "needs_hybrid" : "poor";
}

function refreshStoredQuality(
  document: ParsedPaperDocument,
  storedQuality: PaperParseQualityReport
): PaperParseQualityReport {
  if (document.engine !== "webpage") {
    return storedQuality;
  }

  const currentQuality = evaluateParseQuality(document);
  const score = Math.min(storedQuality.score, currentQuality.score);
  return {
    ...currentQuality,
    status: statusFromScore(score),
    score,
    warnings: [...new Set([...storedQuality.warnings, ...currentQuality.warnings])]
  };
}

async function resolveAvailableEngine(input: {
  workspaceDir: string;
  paperKey: string;
  engine?: ConcretePaperParseEngine;
}): Promise<{ paperKey: string; engine: ConcretePaperParseEngine }> {
  const paperKey = await resolveExistingPaperKey({
    workspaceDir: input.workspaceDir,
    paperKey: input.paperKey
  });
  if (input.engine) {
    return { paperKey, engine: input.engine };
  }
  const engines = sortEnginesByPreference(
    await listPaperParseEngines({
      workspaceDir: input.workspaceDir,
      paperKey
    })
  );
  const parseSummaries = (await Promise.all(
    engines.map((engine) => readParseSummary({
      workspaceDir: input.workspaceDir,
      paperKey,
      engine
    }))
  )).filter((parse): parse is NonNullable<typeof parse> => parse !== undefined);
  const engine = parseSummaries
    .sort((left, right) => {
      const statusDelta = qualityStatusRank(right.quality.status) - qualityStatusRank(left.quality.status);
      if (statusDelta !== 0) {
        return statusDelta;
      }
      const scoreDelta = right.quality.score - left.quality.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return enginePreference(left.engine) - enginePreference(right.engine);
    })[0]?.engine ?? engines[0];
  if (!engine) {
    throw new PaperReaderError("paper_not_found", `No parsed paper found for ${input.paperKey}.`);
  }
  return { paperKey, engine };
}

async function runParser(input: {
  engine: ConcretePaperParseEngine;
  workspaceDir: string;
  pdfPath: string;
  paperKey: string;
  pdfSha256: string;
  title?: string;
  opendataloaderBin?: string;
  latexmlBin?: string;
  pandocBin?: string;
}): Promise<{ document: ParsedPaperDocument; markdown: string }> {
  if (input.engine === "plain-text-baseline") {
    return parseWithPlainTextBaseline(input);
  }
  if (input.engine === "docling") {
    return parseWithDocling(input);
  }
  if (input.engine === "tex-source") {
    return parseWithTexSource({
      workspaceDir: input.workspaceDir,
      paperKey: input.paperKey,
      pdfSha256: input.pdfSha256,
      ...(input.title ? { title: input.title } : {}),
      ...(input.latexmlBin ? { latexmlBin: input.latexmlBin } : {}),
      ...(input.pandocBin ? { pandocBin: input.pandocBin } : {})
    });
  }
  if (input.engine === "webpage") {
    throw new PaperReaderError(
      "parse_failed",
      "The webpage engine is produced by fetch_paper_webpage, not parse_paper."
    );
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
  latexmlBin?: string;
  pandocBin?: string;
}): Promise<PaperParseResult> {
  const resolved = await resolvePaperSource(input);
  if (!resolved.source.pdfPath || !resolved.source.pdfSha256) {
    throw new PaperReaderError("paper_not_found", "Resolved paper source does not point to a PDF.");
  }
  const pdfPath = resolved.source.pdfPath;
  const pdfSha256 = resolved.source.pdfSha256;
  const cached = input.force === true
    ? null
    : await readCachedParse({
      workspaceDir: input.workspaceDir,
      paperKey: resolved.source.paperKey,
      engine: input.engine,
      pdfSha256
    });
  if (cached) {
    return {
      status: "already_parsed",
      paperKey: resolved.source.paperKey,
      engine: input.engine,
      pdfSha256,
      artifacts: cached.artifacts,
      quality: cached.quality,
      sections: toSectionPreview(cached.document.sections)
    };
  }

  const parsed = await runParser({
    engine: input.engine,
    workspaceDir: input.workspaceDir,
    pdfPath,
    paperKey: resolved.source.paperKey,
    pdfSha256,
    ...(resolved.source.title ? { title: resolved.source.title } : {}),
    ...(input.opendataloaderBin ? { opendataloaderBin: input.opendataloaderBin } : {}),
    ...(input.latexmlBin ? { latexmlBin: input.latexmlBin } : {}),
    ...(input.pandocBin ? { pandocBin: input.pandocBin } : {})
  });
  const quality = evaluateParseQualityWithMarkdown(parsed.document, parsed.markdown);
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
    pdfSha256,
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
      ...(options.opendataloaderBin ? { opendataloaderBin: options.opendataloaderBin } : {}),
      ...(options.latexmlBin ? { latexmlBin: options.latexmlBin } : {}),
      ...(options.pandocBin ? { pandocBin: options.pandocBin } : {})
    });
  }

  let localResult: PaperParseResult;
  try {
    localResult = await parseWithConcreteEngine({
      workspaceDir: options.workspaceDir,
      ...(options.path ? { path: options.path } : {}),
      ...(options.recordPath ? { recordPath: options.recordPath } : {}),
      engine: "opendataloader-local",
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.opendataloaderBin ? { opendataloaderBin: options.opendataloaderBin } : {}),
      ...(options.latexmlBin ? { latexmlBin: options.latexmlBin } : {}),
      ...(options.pandocBin ? { pandocBin: options.pandocBin } : {})
    });
  } catch (error) {
    if (error instanceof PaperReaderError && error.code === "parse_failed") {
      try {
        return await parseWithConcreteEngine({
          workspaceDir: options.workspaceDir,
          ...(options.path ? { path: options.path } : {}),
          ...(options.recordPath ? { recordPath: options.recordPath } : {}),
          engine: "docling",
          ...(options.force !== undefined ? { force: options.force } : {}),
          ...(options.latexmlBin ? { latexmlBin: options.latexmlBin } : {}),
          ...(options.pandocBin ? { pandocBin: options.pandocBin } : {})
        });
      } catch (doclingError) {
        if (!(doclingError instanceof PaperReaderError) || doclingError.code !== "parse_failed") {
          throw doclingError;
        }
      }
      return parseWithConcreteEngine({
        workspaceDir: options.workspaceDir,
        ...(options.path ? { path: options.path } : {}),
        ...(options.recordPath ? { recordPath: options.recordPath } : {}),
        engine: "plain-text-baseline",
        ...(options.force !== undefined ? { force: options.force } : {}),
        ...(options.latexmlBin ? { latexmlBin: options.latexmlBin } : {}),
        ...(options.pandocBin ? { pandocBin: options.pandocBin } : {})
      });
    }
    throw error;
  }

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
      ...(options.opendataloaderBin ? { opendataloaderBin: options.opendataloaderBin } : {}),
      ...(options.latexmlBin ? { latexmlBin: options.latexmlBin } : {}),
      ...(options.pandocBin ? { pandocBin: options.pandocBin } : {})
    });
  } catch (error) {
    if (error instanceof PaperReaderError && error.code === "hybrid_server_unavailable") {
      return localResult;
    }
    if (error instanceof PaperReaderError && error.code === "parse_failed") {
      try {
        return await parseWithConcreteEngine({
          workspaceDir: options.workspaceDir,
          ...(options.path ? { path: options.path } : {}),
          ...(options.recordPath ? { recordPath: options.recordPath } : {}),
          engine: "docling",
          ...(options.force !== undefined ? { force: options.force } : {}),
          ...(options.latexmlBin ? { latexmlBin: options.latexmlBin } : {}),
          ...(options.pandocBin ? { pandocBin: options.pandocBin } : {})
        });
      } catch (doclingError) {
        if (doclingError instanceof PaperReaderError && doclingError.code === "parse_failed") {
          return parseWithConcreteEngine({
            workspaceDir: options.workspaceDir,
            ...(options.path ? { path: options.path } : {}),
            ...(options.recordPath ? { recordPath: options.recordPath } : {}),
            engine: "plain-text-baseline",
            ...(options.force !== undefined ? { force: options.force } : {}),
            ...(options.latexmlBin ? { latexmlBin: options.latexmlBin } : {}),
            ...(options.pandocBin ? { pandocBin: options.pandocBin } : {})
          });
        }
        throw doclingError;
      }
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
    const storedQuality = JSON.parse(qualityText) as PaperParseQualityReport;
    const quality = refreshStoredQuality(document, storedQuality);
    const sourceKind = input.engine === "webpage" ? "webpage" : "pdf";
    return {
      engine: input.engine,
      sourceKind,
      sourceSha256: document.pdfSha256,
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

async function sourcePdfExists(input: {
  workspaceDir: string;
  source: Awaited<ReturnType<typeof readPaperSourceByKey>>;
}): Promise<boolean> {
  const source = input.source;
  if (!source?.pdfPath) {
    return false;
  }

  const pdfPath = path.isAbsolute(source.pdfPath)
    ? source.pdfPath
    : path.resolve(input.workspaceDir, source.pdfPath);
  try {
    await access(pdfPath);
    return true;
  } catch {
    return false;
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
  paperKey = await resolveExistingPaperKey({ workspaceDir: options.workspaceDir, paperKey });

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
    localPdf: {
      hasPdf: await sourcePdfExists({ workspaceDir: options.workspaceDir, source }),
      ...(source?.pdfPath ? { path: source.pdfPath } : {}),
      ...(source?.pdfSha256 ? { sha256: source.pdfSha256 } : {})
    },
    parses
  };
}

export async function readPaperSection(
  options: ReadPaperSectionOptions
): Promise<PaperSectionReadResult> {
  const { paperKey, engine } = await resolveAvailableEngine(options);
  const document = await readParsedPaperDocument({
    workspaceDir: options.workspaceDir,
    paperKey,
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
    paperKey,
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
  const { paperKey, engine } = await resolveAvailableEngine(options);
  const document = await readParsedPaperDocument({
    workspaceDir: options.workspaceDir,
    paperKey,
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
    paperKey,
    engine,
    query,
    results
  };
}
