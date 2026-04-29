import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  listPaperParseEngines,
  readParsedPaperDocument,
  readPaperSourceByKey,
  resolvePaperParseArtifactPaths
} from "./paper-reader/paper-reader-store.js";
import type {
  ConcretePaperParseEngine,
  PaperParseQualityReport,
  PaperReaderSource
} from "./paper-reader/types.js";
import { PaperReaderError } from "./paper-reader/types.js";
import { writePaperWikiSource } from "./paper-wiki/paper-wiki.js";
import type { PaperWikiSourceResult } from "./paper-wiki/types.js";

const DEFAULT_MAX_EVIDENCE_CHARS = 60000;
const MAX_SECTION_OUTLINE_ITEMS = 80;

export interface PaperSummaryEvidence {
  paperKey: string;
  title?: string;
  engine: ConcretePaperParseEngine;
  pdfSha256: string;
  articleUrl?: string;
  source?: PaperReaderSource;
  paths: {
    parseMarkdown: string;
    parseJson: string;
    qualityJson: string;
  };
  quality?: PaperParseQualityReport;
  sections: Array<{
    id: string;
    title: string;
    level: number;
    pageFrom: number;
    pageTo: number;
  }>;
  markdown: string;
  totalMarkdownChars: number;
  truncated: boolean;
}

export interface PaperSummaryEvidencePreview extends Omit<PaperSummaryEvidence, "markdown"> {
  markdownPreview: string;
}

export interface PaperSummaryWorkerInput {
  evidence: PaperSummaryEvidence;
}

export interface PaperSummaryWorkerOutput {
  title?: string;
  summaryMarkdown: string;
  tags?: string[];
  keyFindings?: string[];
  limitations?: string[];
  openQuestions?: string[];
  relatedPaperKeys?: string[];
  confidence?: "high" | "medium" | "low";
  groundingWarnings?: string[];
}

export type PaperSummaryWorker = (
  input: PaperSummaryWorkerInput
) => Promise<PaperSummaryWorkerOutput>;

export interface BuildPaperSummaryEvidenceOptions {
  workspaceDir: string;
  paperKey: string;
  engine?: ConcretePaperParseEngine;
  maxEvidenceChars?: number;
}

export interface GeneratePaperWikiSummaryOptions extends BuildPaperSummaryEvidenceOptions {
  mode?: "draft" | "write";
  force?: boolean;
  summaryWorker?: PaperSummaryWorker;
}

export type GeneratePaperWikiSummaryStatus =
  | "drafted"
  | "written"
  | "needs_worker"
  | "skipped";

export interface GeneratePaperWikiSummaryResult {
  status: GeneratePaperWikiSummaryStatus;
  paperKey: string;
  engine: ConcretePaperParseEngine;
  title?: string;
  message: string;
  evidence: PaperSummaryEvidencePreview;
  draft?: PaperSummaryWorkerOutput;
  source?: PaperWikiSourceResult;
}

function sortEnginesByPreference(engines: ConcretePaperParseEngine[]): ConcretePaperParseEngine[] {
  const priority: Record<ConcretePaperParseEngine, number> = {
    "webpage": 0,
    "tex-source": 1,
    "opendataloader-hybrid": 2,
    "opendataloader-local": 3,
    "docling": 4,
    "plain-text-baseline": 5
  };
  return engines.slice().sort((left, right) => priority[left] - priority[right]);
}

async function resolveSummaryEngine(input: {
  workspaceDir: string;
  paperKey: string;
  engine?: ConcretePaperParseEngine;
}): Promise<ConcretePaperParseEngine> {
  if (input.engine) {
    await readParsedPaperDocument({
      workspaceDir: input.workspaceDir,
      paperKey: input.paperKey,
      engine: input.engine
    });
    return input.engine;
  }

  const engine = sortEnginesByPreference(
    await listPaperParseEngines({
      workspaceDir: input.workspaceDir,
      paperKey: input.paperKey
    })
  )[0];
  if (!engine) {
    throw new PaperReaderError("paper_not_found", `No parsed paper found for ${input.paperKey}.`);
  }
  return engine;
}

function relativeToWorkspace(workspaceDir: string, filePath: string): string {
  const relative = path.relative(workspaceDir, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : filePath;
}

async function readQualityReport(qualityPath: string): Promise<PaperParseQualityReport | undefined> {
  try {
    return JSON.parse(await readFile(qualityPath, "utf8")) as PaperParseQualityReport;
  } catch {
    return undefined;
  }
}

function normalizeMaxEvidenceChars(value: number | undefined): number {
  return Math.max(1000, Math.trunc(value ?? DEFAULT_MAX_EVIDENCE_CHARS));
}

function previewEvidence(evidence: PaperSummaryEvidence): PaperSummaryEvidencePreview {
  return {
    ...evidence,
    markdownPreview: evidence.markdown.slice(0, 1200)
  };
}

function cleanStringList(values: string[] | undefined): string[] | undefined {
  const cleaned = (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeWorkerOutput(output: PaperSummaryWorkerOutput): PaperSummaryWorkerOutput {
  const summaryMarkdown = output.summaryMarkdown.trim();
  if (!summaryMarkdown) {
    throw new Error("Summary worker returned an empty summaryMarkdown.");
  }
  return {
    summaryMarkdown,
    ...(output.title?.trim() ? { title: output.title.trim() } : {}),
    ...(cleanStringList(output.tags) ? { tags: cleanStringList(output.tags) } : {}),
    ...(cleanStringList(output.keyFindings) ? { keyFindings: cleanStringList(output.keyFindings) } : {}),
    ...(cleanStringList(output.limitations) ? { limitations: cleanStringList(output.limitations) } : {}),
    ...(cleanStringList(output.openQuestions) ? { openQuestions: cleanStringList(output.openQuestions) } : {}),
    ...(cleanStringList(output.relatedPaperKeys) ? { relatedPaperKeys: cleanStringList(output.relatedPaperKeys) } : {}),
    ...(output.confidence ? { confidence: output.confidence } : {}),
    ...(cleanStringList(output.groundingWarnings) ? { groundingWarnings: cleanStringList(output.groundingWarnings) } : {})
  };
}

export async function buildPaperSummaryEvidence(
  options: BuildPaperSummaryEvidenceOptions
): Promise<PaperSummaryEvidence> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const engine = await resolveSummaryEngine({
    workspaceDir,
    paperKey: options.paperKey,
    ...(options.engine ? { engine: options.engine } : {})
  });
  const [source, document] = await Promise.all([
    readPaperSourceByKey({ workspaceDir, paperKey: options.paperKey }),
    readParsedPaperDocument({ workspaceDir, paperKey: options.paperKey, engine })
  ]);
  const artifacts = await resolvePaperParseArtifactPaths({
    workspaceDir,
    paperKey: options.paperKey,
    engine
  });
  const markdown = await readFile(artifacts.markdownPath, "utf8");
  const maxEvidenceChars = normalizeMaxEvidenceChars(options.maxEvidenceChars);
  const quality = await readQualityReport(artifacts.qualityPath);

  return {
    paperKey: options.paperKey,
    ...(document.title || source?.title ? { title: document.title ?? source?.title } : {}),
    engine,
    pdfSha256: document.pdfSha256 ?? "",
    ...(source?.articleUrl ? { articleUrl: source.articleUrl } : {}),
    ...(source ? { source } : {}),
    paths: {
      parseMarkdown: relativeToWorkspace(workspaceDir, artifacts.markdownPath),
      parseJson: relativeToWorkspace(workspaceDir, artifacts.parsePath),
      qualityJson: relativeToWorkspace(workspaceDir, artifacts.qualityPath)
    },
    ...(quality ? { quality } : {}),
    sections: (Array.isArray(document.sections) ? document.sections : [])
      .slice(0, MAX_SECTION_OUTLINE_ITEMS)
      .map((section) => ({
        id: section.id,
        title: section.title,
        level: section.level,
        pageFrom: section.pageFrom,
        pageTo: section.pageTo
      })),
    markdown: markdown.slice(0, maxEvidenceChars),
    totalMarkdownChars: markdown.length,
    truncated: markdown.length > maxEvidenceChars
  };
}

export async function generatePaperWikiSummary(
  options: GeneratePaperWikiSummaryOptions
): Promise<GeneratePaperWikiSummaryResult> {
  const mode = options.mode ?? "draft";
  const evidence = await buildPaperSummaryEvidence(options);
  const evidencePreview = previewEvidence(evidence);
  if (!options.force && evidence.quality && evidence.quality.status !== "good") {
    return {
      status: "skipped",
      paperKey: evidence.paperKey,
      engine: evidence.engine,
      ...(evidence.title ? { title: evidence.title } : {}),
      message: `Skipped summary generation because parse quality is ${evidence.quality.status}.`,
      evidence: evidencePreview
    };
  }

  if (!options.summaryWorker) {
    return {
      status: "needs_worker",
      paperKey: evidence.paperKey,
      engine: evidence.engine,
      ...(evidence.title ? { title: evidence.title } : {}),
      message: "Summary worker is not configured; provide a clean-context summary worker before generating content.",
      evidence: evidencePreview
    };
  }

  const draft = normalizeWorkerOutput(await options.summaryWorker({ evidence }));
  if (!options.force && draft.confidence === "low") {
    return {
      status: "skipped",
      paperKey: evidence.paperKey,
      engine: evidence.engine,
      ...(draft.title ?? evidence.title ? { title: draft.title ?? evidence.title } : {}),
      message: "Skipped writing because the summary worker reported low confidence.",
      evidence: evidencePreview,
      draft
    };
  }

  if (mode === "draft") {
    return {
      status: "drafted",
      paperKey: evidence.paperKey,
      engine: evidence.engine,
      ...(draft.title ?? evidence.title ? { title: draft.title ?? evidence.title } : {}),
      message: "Generated a grounded wiki summary draft without writing it.",
      evidence: evidencePreview,
      draft
    };
  }

  const source = await writePaperWikiSource({
    workspaceDir: path.resolve(options.workspaceDir),
    paperKey: evidence.paperKey,
    engine: evidence.engine,
    summaryMarkdown: draft.summaryMarkdown,
    ...(draft.title ?? evidence.title ? { title: draft.title ?? evidence.title } : {}),
    ...(draft.tags ? { tags: draft.tags } : {}),
    ...(draft.keyFindings ? { keyFindings: draft.keyFindings } : {}),
    ...(draft.limitations ? { limitations: draft.limitations } : {}),
    ...(draft.openQuestions ? { openQuestions: draft.openQuestions } : {}),
    ...(draft.relatedPaperKeys ? { relatedPaperKeys: draft.relatedPaperKeys } : {})
  });

  return {
    status: "written",
    paperKey: evidence.paperKey,
    engine: evidence.engine,
    title: source.title,
    message: `Wrote wiki source summary for ${evidence.paperKey}.`,
    evidence: evidencePreview,
    draft,
    source
  };
}
