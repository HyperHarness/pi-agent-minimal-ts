import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ConcretePaperParseEngine,
  PaperElement,
  PaperElementType,
  PaperSection,
  ParsedPaperDocument
} from "../types.js";
import { PaperReaderError } from "../types.js";

export interface OpenDataLoaderParseOptions {
  pdfPath: string;
  paperKey: string;
  pdfSha256: string;
  engine: Extract<ConcretePaperParseEngine, "opendataloader-local" | "opendataloader-hybrid">;
  title?: string;
  bin?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function normalizeElementType(value: unknown): PaperElementType {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("heading") || normalized === "title") {
    return "heading";
  }
  if (normalized.includes("table")) {
    return "table";
  }
  if (normalized.includes("list")) {
    return "list";
  }
  if (normalized.includes("caption")) {
    return "caption";
  }
  if (normalized.includes("image") || normalized.includes("figure") || normalized.includes("picture")) {
    return "figure";
  }
  if (normalized.includes("formula") || normalized.includes("equation")) {
    return "formula";
  }
  if (normalized.includes("reference")) {
    return "reference";
  }
  if (normalized.includes("paragraph") || normalized.includes("text")) {
    return "paragraph";
  }
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function parseBbox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 4) {
    return undefined;
  }
  const numbers = value.slice(0, 4).map((item) => Number(item));
  if (numbers.some((item) => !Number.isFinite(item))) {
    return undefined;
  }
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 0];
}

function collectCandidateRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectCandidateRecords);
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const childKeys = ["elements", "items", "children", "content", "blocks", "pages", "kids"];
  const ownText = firstString(record, ["text", "content", "markdown", "html"]);
  const ownRecords = ownText ? [record] : [];
  return [
    ...ownRecords,
    ...childKeys.flatMap((key) => collectCandidateRecords(record[key]))
  ];
}

function createSections(elements: PaperElement[], title: string): PaperSection[] {
  const sections: PaperSection[] = [];
  let current: PaperSection | undefined;

  for (const element of elements) {
    if (element.type === "heading") {
      current = {
        id: `section-${String(sections.length + 1).padStart(4, "0")}`,
        title: element.text,
        level: element.headingLevel ?? 1,
        pageFrom: element.page,
        pageTo: element.page,
        elementIds: []
      };
      sections.push(current);
    }

    if (!current) {
      current = {
        id: "section-0001",
        title,
        level: 1,
        pageFrom: element.page,
        pageTo: element.page,
        elementIds: []
      };
      sections.push(current);
    }

    element.sectionId = current.id;
    current.pageTo = Math.max(current.pageTo, element.page);
    current.elementIds.push(element.id);
  }

  return sections;
}

function normalizeOpenDataLoaderJson(input: {
  raw: unknown;
  paperKey: string;
  engine: Extract<ConcretePaperParseEngine, "opendataloader-local" | "opendataloader-hybrid">;
  pdfSha256: string;
  title?: string;
}): ParsedPaperDocument {
  const root = asRecord(input.raw);
  const records = collectCandidateRecords(input.raw);
  const title = input.title ??
    (root ? firstString(root, ["title", "document_title", "name"]) : undefined) ??
    input.paperKey;
  const elements = records
    .map((record, index): PaperElement | undefined => {
      const text = firstString(record, ["text", "content", "markdown"]);
      if (!text) {
        return undefined;
      }
      const type = normalizeElementType(record.type ?? record.label ?? record.category);
      const page = Math.max(1, Math.trunc(firstNumber(record, ["page", "page_number", "pageNumber", "page number"]) ?? 1));
      const bbox = parseBbox(record.bbox ?? record.bounding_box ?? record["bounding box"] ?? record.box);
      const headingLevel = firstNumber(record, ["headingLevel", "heading_level", "heading level", "level"]);
      return {
        id: `el-${String(index + 1).padStart(5, "0")}`,
        type,
        text,
        page,
        ...(bbox ? { bbox } : {}),
        ...(headingLevel ? { headingLevel } : {})
      };
    })
    .filter((element): element is PaperElement => element !== undefined);

  if (elements.length === 0) {
    throw new PaperReaderError("parse_failed", "OpenDataLoader output did not contain text elements.");
  }

  const pages = Math.max(
    1,
    Math.trunc((root ? firstNumber(root, ["pages", "page_count", "num_pages", "number of pages"]) : undefined) ?? 0),
    ...elements.map((element) => element.page)
  );
  const sections = createSections(elements, title);

  return {
    paperKey: input.paperKey,
    engine: input.engine,
    pdfSha256: input.pdfSha256,
    createdAt: new Date().toISOString(),
    title,
    pages,
    elements,
    sections
  };
}

function runCommand(input: {
  bin: string;
  args: string[];
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.bin, input.args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new PaperReaderError("parse_failed", "OpenDataLoader parser timed out."));
    }, input.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new PaperReaderError(
          "parser_not_installed",
          "opendataloader-pdf was not found on PATH. Install it or set PI_PAPER_READER_OPENDATALOADER_BIN."
        ));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const output = `${stderr}\n${stdout}`.toLowerCase();
      if (output.includes("java") && (output.includes("not found") || output.includes("no such"))) {
        reject(new PaperReaderError("java_missing", "OpenDataLoader requires Java 11+ on PATH."));
        return;
      }
      if (output.includes("connection refused") || output.includes("hybrid")) {
        reject(new PaperReaderError("hybrid_server_unavailable", "OpenDataLoader hybrid server is unavailable."));
        return;
      }
      reject(new PaperReaderError(
        "parse_failed",
        `OpenDataLoader exited with code ${code ?? "unknown"}: ${stderr.trim() || stdout.trim()}`
      ));
    });
  });
}

async function findFirstFile(dir: string, extension: string): Promise<string | undefined> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const matches = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  return matches[0];
}

export async function parseWithOpenDataLoader(
  options: OpenDataLoaderParseOptions
): Promise<{ document: ParsedPaperDocument; markdown: string }> {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "pi-paper-reader-"));
  const bin =
    options.bin ??
    process.env.PI_PAPER_READER_OPENDATALOADER_BIN ??
    "opendataloader-pdf";
  const timeoutMs =
    options.timeoutMs ??
    (Number(process.env.PI_PAPER_READER_TIMEOUT_MS || "") ||
    DEFAULT_TIMEOUT_MS);

  const args = [
    options.pdfPath,
    "--output-dir",
    outputDir,
    "--format",
    "markdown,json"
  ];
  if (options.engine === "opendataloader-hybrid") {
    args.unshift("--hybrid", "docling-fast", "--hybrid-mode", "full");
  }

  try {
    await runCommand({ bin, args, timeoutMs });
    const jsonPath = await findFirstFile(outputDir, ".json");
    if (!jsonPath) {
      throw new PaperReaderError("parse_failed", "OpenDataLoader did not write a JSON output file.");
    }
    const markdownPath = await findFirstFile(outputDir, ".md");
    const raw = JSON.parse(await readFile(jsonPath, "utf8")) as unknown;
    const markdown = markdownPath ? await readFile(markdownPath, "utf8") : "";
    const document = normalizeOpenDataLoaderJson({
      raw,
      paperKey: options.paperKey,
      engine: options.engine,
      pdfSha256: options.pdfSha256,
      ...(options.title ? { title: options.title } : {})
    });

    return {
      document,
      markdown: markdown.trim() ? markdown : document.elements.map((element) => element.text).join("\n\n")
    };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
