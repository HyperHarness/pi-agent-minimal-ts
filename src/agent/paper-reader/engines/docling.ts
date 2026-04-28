import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PaperElement,
  PaperElementType,
  PaperSection,
  ParsedPaperDocument
} from "../types.js";
import { PaperReaderError } from "../types.js";

export interface DoclingParseOptions {
  pdfPath: string;
  paperKey: string;
  pdfSha256: string;
  title?: string;
  bin?: string;
  artifactsPath?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

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

function normalizeElementType(label: unknown): PaperElementType {
  const normalized = String(label ?? "").toLowerCase();
  if (normalized.includes("section_header") || normalized.includes("title") || normalized.includes("heading")) {
    return "heading";
  }
  if (normalized.includes("caption")) {
    return "caption";
  }
  if (normalized.includes("list")) {
    return "list";
  }
  if (normalized.includes("formula")) {
    return "formula";
  }
  if (normalized.includes("reference")) {
    return "reference";
  }
  if (normalized.includes("table")) {
    return "table";
  }
  if (normalized.includes("picture") || normalized.includes("figure")) {
    return "figure";
  }
  return "paragraph";
}

function parsePage(record: Record<string, unknown>): number {
  const prov = record.prov;
  if (Array.isArray(prov)) {
    const firstProv = asRecord(prov[0]);
    const pageNo = Number(firstProv?.page_no ?? firstProv?.page ?? 1);
    if (Number.isFinite(pageNo)) {
      return Math.max(1, Math.trunc(pageNo));
    }
  }
  return 1;
}

function parseBbox(record: Record<string, unknown>): [number, number, number, number] | undefined {
  const prov = record.prov;
  const firstProv = Array.isArray(prov) ? asRecord(prov[0]) : undefined;
  const bbox = asRecord(firstProv?.bbox);
  if (!bbox) {
    return undefined;
  }
  const values = [bbox.l, bbox.t, bbox.r, bbox.b].map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) {
    return undefined;
  }
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0];
}

function shouldSkipText(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  return (
    compact === "1234567890():,;" ||
    compact === "Article" ||
    /^Nature Communications\|/.test(compact)
  );
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

function normalizeDoclingJson(input: {
  raw: unknown;
  paperKey: string;
  pdfSha256: string;
  title?: string;
}): ParsedPaperDocument {
  const root = asRecord(input.raw);
  const texts = Array.isArray(root?.texts) ? root.texts : [];
  const elements = texts
    .map((item, index): PaperElement | undefined => {
      const record = asRecord(item);
      if (!record) {
        return undefined;
      }
      const text = firstString(record, ["text", "orig"]);
      if (!text || shouldSkipText(text)) {
        return undefined;
      }
      const type = normalizeElementType(record.label);
      const headingLevelValue = Number(record.level);
      const headingLevel = Number.isFinite(headingLevelValue)
        ? Math.max(1, Math.trunc(headingLevelValue))
        : undefined;
      return {
        id: `el-${String(index + 1).padStart(5, "0")}`,
        type,
        text,
        page: parsePage(record),
        ...(parseBbox(record) ? { bbox: parseBbox(record) } : {}),
        ...(type === "heading" ? { headingLevel: headingLevel ?? 1 } : {})
      };
    })
    .filter((element): element is PaperElement => element !== undefined);

  if (elements.length === 0) {
    throw new PaperReaderError("parse_failed", "Docling output did not contain text elements.");
  }

  const pagesRecord = asRecord(root?.pages);
  const pages = Math.max(
    1,
    pagesRecord ? Object.keys(pagesRecord).length : 0,
    ...elements.map((element) => element.page)
  );
  const title = input.title ??
    elements.find((element) =>
      element.type === "heading" &&
      !/^https?:\/\//i.test(element.text)
    )?.text ??
    (root ? firstString(root, ["name"]) : undefined) ??
    input.paperKey;
  const sections = createSections(elements, title);

  return {
    paperKey: input.paperKey,
    engine: "docling",
    pdfSha256: input.pdfSha256,
    createdAt: new Date().toISOString(),
    title,
    pages,
    elements,
    sections
  };
}

function buildMarkdown(document: ParsedPaperDocument): string {
  const lines = [`# ${document.title ?? document.paperKey}`];
  for (const element of document.elements) {
    if (element.type === "heading") {
      const level = Math.min(6, Math.max(2, element.headingLevel ?? 2));
      lines.push("", `${"#".repeat(level)} ${element.text}`);
    } else {
      lines.push("", element.text);
    }
  }
  return `${lines.join("\n").trim()}\n`;
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
      reject(new PaperReaderError("parse_failed", "Docling parser timed out."));
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
          "docling was not found on PATH. Install it or set PI_PAPER_READER_DOCLING_BIN."
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
      reject(new PaperReaderError(
        "parse_failed",
        `Docling exited with code ${code ?? "unknown"}: ${stderr.trim() || stdout.trim()}`
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

async function resolveDefaultArtifactsPath(): Promise<string | undefined> {
  const cachePath = path.join(os.homedir(), ".cache", "docling", "models");
  try {
    await access(cachePath);
    return cachePath;
  } catch {
    return undefined;
  }
}

export async function parseWithDocling(
  options: DoclingParseOptions
): Promise<{ document: ParsedPaperDocument; markdown: string }> {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "pi-paper-reader-docling-"));
  const bin =
    options.bin ??
    process.env.PI_PAPER_READER_DOCLING_BIN ??
    "docling";
  const timeoutMs =
    options.timeoutMs ??
    (Number(process.env.PI_PAPER_READER_DOCLING_TIMEOUT_MS || "") ||
    Number(process.env.PI_PAPER_READER_TIMEOUT_MS || "") ||
    DEFAULT_TIMEOUT_MS);
  const artifactsPath =
    options.artifactsPath ??
    process.env.PI_PAPER_READER_DOCLING_ARTIFACTS_PATH ??
    await resolveDefaultArtifactsPath();

  const args = [
    "--from",
    "pdf",
    "--to",
    "json",
    "--image-export-mode",
    "placeholder",
    "--no-ocr",
    "--no-tables",
    "--device",
    process.env.PI_PAPER_READER_DOCLING_DEVICE ?? "cpu",
    "--document-timeout",
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    "--output",
    outputDir
  ];
  if (artifactsPath) {
    args.push("--artifacts-path", artifactsPath);
  }
  args.push(options.pdfPath);

  try {
    await runCommand({ bin, args, timeoutMs });
    const jsonPath = await findFirstFile(outputDir, ".json");
    if (!jsonPath) {
      throw new PaperReaderError("parse_failed", "Docling did not write a JSON output file.");
    }
    const raw = JSON.parse(await readFile(jsonPath, "utf8")) as unknown;
    const document = normalizeDoclingJson({
      raw,
      paperKey: options.paperKey,
      pdfSha256: options.pdfSha256,
      ...(options.title ? { title: options.title } : {})
    });

    return {
      document,
      markdown: buildMarkdown(document)
    };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
