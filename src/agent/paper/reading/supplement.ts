import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPathInsideDirectory } from "../../knowledge-base.js";
import { createPaperChunks, type PaperChunk } from "./chunks.js";
import { parseWithDocling } from "./engines/docling.js";
import { parseWithOpenDataLoader } from "./engines/opendataloader.js";
import { parseWithPlainTextBaseline } from "./engines/plain-text-baseline.js";
import {
  getPaperReadingDir,
  getParseDir
} from "./paper-reader-store.js";
import { evaluateParseQualityWithMarkdown } from "./quality.js";
import type {
  PaperParseQualityReport,
  ParsedPaperDocument
} from "./types.js";

export interface SupplementalParseArtifacts {
  markdownPath: string;
  parsePath: string;
  qualityPath: string;
  chunksPath: string;
}

export interface SupplementalParseResult {
  status: "parsed" | "already_parsed";
  paperKey: string;
  pdfSha256: string;
  artifacts: SupplementalParseArtifacts;
  quality: PaperParseQualityReport;
}

export type SupplementalPdfParser = (input: {
  workspaceDir: string;
  pdfPath: string;
  paperKey: string;
  pdfSha256: string;
  title?: string;
  createdAt: string;
}) => Promise<{ document: ParsedPaperDocument; markdown: string }>;

function normalizePortableFilePath(filePath: string): string {
  const drivePathMatch = filePath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drivePathMatch?.[1] && drivePathMatch[2]) {
    return path.posix.join(
      "/mnt",
      drivePathMatch[1].toLowerCase(),
      ...drivePathMatch[2].split(/[\\/]+/).filter(Boolean)
    );
  }

  const uncWslMatch = filePath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+\\(.+)$/i);
  if (uncWslMatch?.[1]) {
    return path.posix.join("/", ...uncWslMatch[1].split(/[\\/]+/).filter(Boolean));
  }

  return filePath.includes("\\") ? filePath.replace(/\\/g, "/") : filePath;
}

function relativeToWorkspace(workspaceDir: string, filePath: string): string {
  const normalizedWorkspaceDir = normalizePortableFilePath(workspaceDir);
  const normalizedFilePath = normalizePortableFilePath(filePath);
  const normalizedPath = path.isAbsolute(normalizedFilePath)
    ? path.relative(normalizedWorkspaceDir, normalizedFilePath)
    : normalizedFilePath;
  return normalizedPath.split(/[\\/]+/).join("/");
}

function getSupplementArtifacts(input: {
  workspaceDir: string;
  paperKey: string;
}): SupplementalParseArtifacts {
  const parseDir = getParseDir(input.workspaceDir, input.paperKey, "webpage");
  return {
    markdownPath: path.join(parseDir, "supplement.md"),
    parsePath: path.join(parseDir, "supplement.parse.json"),
    qualityPath: path.join(parseDir, "supplement.quality.json"),
    chunksPath: path.join(parseDir, "supplement.chunks.jsonl")
  };
}

async function readCachedSupplement(input: {
  artifacts: SupplementalParseArtifacts;
  pdfSha256: string;
}): Promise<{
  document: ParsedPaperDocument;
  quality: PaperParseQualityReport;
} | null> {
  try {
    const [documentText, qualityText] = await Promise.all([
      readFile(input.artifacts.parsePath, "utf8"),
      readFile(input.artifacts.qualityPath, "utf8")
    ]);
    const document = JSON.parse(documentText) as ParsedPaperDocument;
    const quality = JSON.parse(qualityText) as PaperParseQualityReport;
    return document.pdfSha256 === input.pdfSha256 ? { document, quality } : null;
  } catch {
    return null;
  }
}

function normalizeSupplementDocument(input: {
  document: ParsedPaperDocument;
  paperKey: string;
  pdfSha256: string;
  title?: string;
  createdAt: string;
}): ParsedPaperDocument {
  const sectionIdMap = new Map<string, string>();
  const elementIdMap = new Map(input.document.elements.map((element, index) => [
    element.id,
    `supplement-${String(index + 1).padStart(5, "0")}`
  ]));
  const sections = input.document.sections.map((section, index) => {
    const id = `supplement-section-${String(index + 1).padStart(4, "0")}`;
    sectionIdMap.set(section.id, id);
    return {
      ...section,
      id,
      elementIds: section.elementIds.map((elementId) => elementIdMap.get(elementId) ?? elementId)
    };
  });
  const elements = input.document.elements.map((element, index) => ({
    ...element,
    id: elementIdMap.get(element.id) ?? `supplement-${String(index + 1).padStart(5, "0")}`,
    ...(element.sectionId ? { sectionId: sectionIdMap.get(element.sectionId) ?? element.sectionId } : {})
  }));

  return {
    ...input.document,
    paperKey: input.paperKey,
    engine: "webpage",
    pdfSha256: input.pdfSha256,
    createdAt: input.createdAt,
    ...(input.title ? { title: input.title } : {}),
    elements,
    sections
  };
}

async function defaultSupplementalPdfParser(input: {
  workspaceDir: string;
  pdfPath: string;
  paperKey: string;
  pdfSha256: string;
  title?: string;
  createdAt: string;
}): Promise<{ document: ParsedPaperDocument; markdown: string }> {
  try {
    return await parseWithOpenDataLoader({
      pdfPath: input.pdfPath,
      paperKey: input.paperKey,
      pdfSha256: input.pdfSha256,
      engine: "opendataloader-local",
      ...(input.title ? { title: input.title } : {})
    });
  } catch {
    try {
      return await parseWithDocling({
        pdfPath: input.pdfPath,
        paperKey: input.paperKey,
        pdfSha256: input.pdfSha256,
        ...(input.title ? { title: input.title } : {})
      });
    } catch {
      return parseWithPlainTextBaseline({
        pdfPath: input.pdfPath,
        paperKey: input.paperKey,
        pdfSha256: input.pdfSha256,
        ...(input.title ? { title: input.title } : {}),
        createdAt: input.createdAt
      });
    }
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveSupplementPdf(input: {
  workspaceDir: string;
  pdfPath: string;
}): Promise<{ path: string; sha256: string }> {
  const normalizedPdfPath = normalizePortableFilePath(input.pdfPath);
  const resolvedPath = path.isAbsolute(normalizedPdfPath)
    ? path.resolve(normalizedPdfPath)
    : path.resolve(input.workspaceDir, normalizedPdfPath);
  const rawPdfRoot = path.resolve(input.workspaceDir, "knowledge-base", "raw", "pdfs");
  if (!isPathInsideDirectory(rawPdfRoot, resolvedPath)) {
    throw new Error("Supplement PDF must be stored under knowledge-base/raw/pdfs/.");
  }
  const bytes = await readFile(resolvedPath);
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Supplement file is not a valid PDF.");
  }
  return { path: resolvedPath, sha256: hashBytes(bytes) };
}

async function updateMetadataArtifacts(input: {
  workspaceDir: string;
  paperKey: string;
  artifacts: SupplementalParseArtifacts;
  pdfSha256: string;
  updatedAt: string;
}): Promise<void> {
  const metadataPath = path.join(getPaperReadingDir(input.workspaceDir, input.paperKey), "metadata.json");
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const existingArtifacts = Array.isArray(metadata.artifacts)
    ? metadata.artifacts.filter((artifact) =>
      typeof artifact !== "object" ||
      artifact === null ||
      (artifact as { markdownPath?: unknown }).markdownPath !== relativeToWorkspace(input.workspaceDir, input.artifacts.markdownPath)
    )
    : [];
  metadata.artifacts = [
    ...existingArtifacts,
    {
      kind: "parse",
      path: relativeToWorkspace(input.workspaceDir, input.artifacts.markdownPath),
      engine: "webpage",
      markdownPath: relativeToWorkspace(input.workspaceDir, input.artifacts.markdownPath),
      jsonPath: relativeToWorkspace(input.workspaceDir, input.artifacts.parsePath),
      qualityPath: relativeToWorkspace(input.workspaceDir, input.artifacts.qualityPath),
      sha256: input.pdfSha256,
      note: "Parsed supplemental material PDF."
    }
  ];
  metadata.updatedAt = input.updatedAt;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export async function parseSupplementPdfIntoWebpage(input: {
  workspaceDir: string;
  paperKey: string;
  pdfPath: string;
  title?: string;
  force?: boolean;
  now?: () => Date;
  parser?: SupplementalPdfParser;
}): Promise<SupplementalParseResult> {
  const resolved = await resolveSupplementPdf({
    workspaceDir: input.workspaceDir,
    pdfPath: input.pdfPath
  });
  const artifacts = getSupplementArtifacts({
    workspaceDir: input.workspaceDir,
    paperKey: input.paperKey
  });
  const cached = input.force === true
    ? null
    : await readCachedSupplement({ artifacts, pdfSha256: resolved.sha256 });
  if (cached) {
    return {
      status: "already_parsed",
      paperKey: input.paperKey,
      pdfSha256: resolved.sha256,
      artifacts,
      quality: cached.quality
    };
  }

  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const parser = input.parser ?? defaultSupplementalPdfParser;
  const parsed = await parser({
    workspaceDir: input.workspaceDir,
    pdfPath: resolved.path,
    paperKey: input.paperKey,
    pdfSha256: resolved.sha256,
    ...(input.title ? { title: input.title } : {}),
    createdAt
  });
  const document = normalizeSupplementDocument({
    document: parsed.document,
    paperKey: input.paperKey,
    pdfSha256: resolved.sha256,
    ...(input.title ? { title: input.title } : {}),
    createdAt
  });
  const quality = evaluateParseQualityWithMarkdown(document, parsed.markdown);
  const chunks = createPaperChunks(document);

  await Promise.all([
    mkdir(path.dirname(artifacts.markdownPath), { recursive: true }),
    mkdir(path.dirname(artifacts.chunksPath), { recursive: true })
  ]);
  await Promise.all([
    writeFile(artifacts.markdownPath, `${parsed.markdown.trimEnd()}\n`, "utf8"),
    writeFile(artifacts.parsePath, `${JSON.stringify(document, null, 2)}\n`, "utf8"),
    writeFile(artifacts.qualityPath, `${JSON.stringify(quality, null, 2)}\n`, "utf8"),
    writeFile(
      artifacts.chunksPath,
      chunks.map((chunk: PaperChunk) => JSON.stringify(chunk)).join("\n") + "\n",
      "utf8"
    )
  ]);
  await updateMetadataArtifacts({
    workspaceDir: input.workspaceDir,
    paperKey: input.paperKey,
    artifacts,
    pdfSha256: resolved.sha256,
    updatedAt: createdAt
  });
  await access(artifacts.markdownPath);

  return {
    status: "parsed",
    paperKey: input.paperKey,
    pdfSha256: resolved.sha256,
    artifacts,
    quality
  };
}
