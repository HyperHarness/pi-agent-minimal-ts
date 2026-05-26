export type PaperParseEngine =
  | "auto"
  | "tex-source"
  | "opendataloader-local"
  | "opendataloader-hybrid"
  | "docling"
  | "plain-text-baseline"
  | "webpage";

export type ConcretePaperParseEngine = Exclude<PaperParseEngine, "auto">;

export type PaperElementType =
  | "heading"
  | "paragraph"
  | "table"
  | "list"
  | "caption"
  | "figure"
  | "formula"
  | "reference"
  | "unknown";

export type PaperParseQualityStatus = "good" | "needs_hybrid" | "poor";

export interface PaperElement {
  id: string;
  type: PaperElementType;
  text: string;
  page: number;
  bbox?: [number, number, number, number];
  sectionId?: string;
  headingLevel?: number;
}

export interface PaperSection {
  id: string;
  title: string;
  level: number;
  pageFrom: number;
  pageTo: number;
  elementIds: string[];
}

export interface ParsedPaperDocument {
  paperKey: string;
  engine: ConcretePaperParseEngine;
  pdfSha256: string;
  createdAt: string;
  title?: string;
  pages: number;
  elements: PaperElement[];
  sections: PaperSection[];
}

export interface PaperParseQualityReport {
  status: PaperParseQualityStatus;
  score: number;
  pages: number;
  totalTextLength: number;
  emptyPageCount: number;
  headingCount: number;
  tableCount: number;
  figureOrCaptionCount: number;
  warnings: string[];
}

export interface PaperReaderSource {
  paperKey: string;
  pdfPath?: string;
  pdfSha256?: string;
  createdAt: string;
  recordPath?: string;
  source?: string;
  canonicalId?: string;
  articleUrl?: string;
  title?: string;
}

export interface PaperParseArtifactPaths {
  metadataPath?: string;
  sourcePath?: string;
  parsePath: string;
  markdownPath: string;
  qualityPath: string;
  chunksPath: string;
}

export interface PaperParseResult {
  status: "parsed" | "already_parsed";
  paperKey: string;
  engine: ConcretePaperParseEngine;
  pdfSha256: string;
  artifacts: PaperParseArtifactPaths;
  quality: PaperParseQualityReport;
  sections: Array<{
    id: string;
    title: string;
    level: number;
    pageFrom: number;
    pageTo: number;
  }>;
}

export interface PaperInspectionResult {
  paperKey: string;
  source?: PaperReaderSource;
  localPdf: {
    hasPdf: boolean;
    path?: string;
    sha256?: string;
  };
  parses: Array<{
    engine: ConcretePaperParseEngine;
    sourceKind: "pdf" | "webpage";
    sourceSha256: string;
    pdfSha256: string;
    createdAt: string;
    markdownPath: string;
    parsePath: string;
    qualityPath: string;
    chunksPath: string;
    quality: PaperParseQualityReport;
    sections: Array<{
      id: string;
      title: string;
      level: number;
      pageFrom: number;
      pageTo: number;
    }>;
  }>;
}

export interface PaperSectionReadResult {
  paperKey: string;
  engine: ConcretePaperParseEngine;
  sectionId?: string;
  pageFrom?: number;
  pageTo?: number;
  maxChars: number;
  text: string;
  truncated: boolean;
  elements: Array<{
    id: string;
    type: PaperElementType;
    page: number;
    bbox?: [number, number, number, number];
    sectionId?: string;
  }>;
}

export interface PaperTextSearchResult {
  paperKey: string;
  engine: ConcretePaperParseEngine;
  query: string;
  results: Array<{
    elementId: string;
    type: PaperElementType;
    page: number;
    sectionId?: string;
    bbox?: [number, number, number, number];
    snippet: string;
  }>;
}

export interface PaperReaderErrorDetails {
  code:
    | "paper_not_found"
    | "pdf_outside_papers_dir"
    | "invalid_pdf"
    | "parser_not_installed"
    | "tex_source_not_found"
    | "java_missing"
    | "hybrid_server_unavailable"
    | "parse_failed"
    | "parse_quality_poor";
  message: string;
}

export class PaperReaderError extends Error {
  readonly code: PaperReaderErrorDetails["code"];

  constructor(code: PaperReaderErrorDetails["code"], message: string) {
    super(message);
    this.name = "PaperReaderError";
    this.code = code;
  }
}
