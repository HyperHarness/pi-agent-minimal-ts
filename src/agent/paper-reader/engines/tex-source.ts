import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolvePaperLibraryPaths } from "../../knowledge-base.js";
import type {
  PaperElement,
  PaperElementType,
  PaperSection,
  ParsedPaperDocument
} from "../types.js";
import { PaperReaderError } from "../types.js";

export interface TexSourceParseOptions {
  workspaceDir: string;
  paperKey: string;
  pdfSha256: string;
  title?: string;
  latexmlBin?: string;
  pandocBin?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const execFileAsync = promisify(execFile);

function arxivIdFromPaperKey(paperKey: string): string | undefined {
  const match = paperKey.match(/^arxiv-(.+)$/);
  return match?.[1];
}

async function findFirstFile(dir: string, extension: string): Promise<string | undefined> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const matches = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  return matches[0];
}

async function resolveMainTexPath(input: {
  workspaceDir: string;
  paperKey: string;
}): Promise<string> {
  const arxivId = arxivIdFromPaperKey(input.paperKey);
  if (!arxivId) {
    throw new PaperReaderError("tex_source_not_found", "TeX source parsing is currently supported for arXiv paper keys.");
  }

  const sourceDir = path.join(resolvePaperLibraryPaths(input.workspaceDir).rawRoot, "arxiv-sources", arxivId);
  const readmePath = path.join(sourceDir, "00README.json");
  try {
    const readme = JSON.parse(await readFile(readmePath, "utf8")) as {
      sources?: Array<{ usage?: string; filename?: string }>;
    };
    const topLevel = readme.sources?.find((source) => source.usage === "toplevel" && source.filename?.trim());
    if (topLevel?.filename) {
      const texPath = path.resolve(sourceDir, topLevel.filename);
      await access(texPath);
      return texPath;
    }
  } catch {
    // Fall back to the first TeX file below.
  }

  const texPath = await findFirstFile(sourceDir, ".tex");
  if (!texPath) {
    throw new PaperReaderError("tex_source_not_found", `No TeX source found under ${sourceDir}.`);
  }
  return texPath;
}

async function runCommand(input: {
  bin: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(input.bin, input.args, {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8"
    });
    return { stdout, stderr };
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      code?: string | number;
      signal?: string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (commandError.code === "ENOENT") {
      throw new PaperReaderError(
        "parser_not_installed",
        `${input.bin} was not found on PATH. Install latexml and pandoc, or set PI_PAPER_READER_LATEXML_BIN/PI_PAPER_READER_PANDOC_BIN.`
      );
    }
    if (commandError.killed || commandError.signal === "SIGTERM") {
      throw new PaperReaderError("parse_failed", `${input.bin} timed out.`);
    }
    throw new PaperReaderError(
      "parse_failed",
      `${input.bin} exited with code ${commandError.code ?? "unknown"}: ${
        commandError.stderr?.trim() || commandError.stdout?.trim() || commandError.message
      }`
    );
  }
}

async function convertTexToHtml(input: {
  texPath: string;
  outputPath: string;
  latexmlBin: string;
  timeoutMs: number;
}): Promise<void> {
  await runCommand({
    bin: input.latexmlBin,
    args: [
      "--dest",
      input.outputPath,
      "--nocomments",
      "--quiet",
      input.texPath
    ],
    cwd: path.dirname(input.texPath),
    timeoutMs: input.timeoutMs
  });
}

async function convertHtmlToMarkdown(input: {
  htmlPath: string;
  outputPath: string;
  pandocBin: string;
  timeoutMs: number;
}): Promise<string> {
  await runCommand({
    bin: input.pandocBin,
    args: [
      "--from",
      "html",
      "--to",
      "gfm",
      "--wrap=none",
      "--output",
      input.outputPath,
      input.htmlPath
    ],
    timeoutMs: input.timeoutMs
  });
  return readFile(input.outputPath, "utf8");
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    if (lower === "nbsp") return " ";
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function sanitizeLatexmlMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const firstHeadingIndex = normalized.search(/^#\s+/m);
  const body = firstHeadingIndex >= 0 ? normalized.slice(firstHeadingIndex) : normalized;
  return decodeHtmlEntities(
    body
      .replace(/<span\b[^>]*class="[^"]*\bltx_ERROR\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "")
      .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_match, alt: string) => alt ? `![${alt}]()` : "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?[a-z][^>]*>/gi, "")
      .replace(/^[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function stripMarkdownSyntax(value: string): string {
  return compactText(
    decodeHtmlEntities(value)
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/[`*_~>#-]+/g, " ")
  );
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const heading = markdown.split("\n").find((line) => /^#\s+/.test(line));
  return heading ? stripMarkdownSyntax(heading.replace(/^#\s+/, "")) : fallback;
}

function markdownToElements(markdown: string): PaperElement[] {
  const elements: PaperElement[] = [];
  const blocks = markdown
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const heading = block.match(/^(#{1,6})\s+(.+)$/);
    const text = stripMarkdownSyntax(heading ? heading[2] ?? "" : block);
    if (!text) {
      continue;
    }
    const type: PaperElementType = heading ? "heading" : block.startsWith("![") ? "figure" : "paragraph";
    elements.push({
      id: `el-${String(elements.length + 1).padStart(5, "0")}`,
      type,
      text,
      page: 1,
      ...(heading ? { headingLevel: Math.max(1, heading[1]?.length ?? 1) } : {})
    });
  }

  return elements;
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

export async function parseWithTexSource(
  options: TexSourceParseOptions
): Promise<{ document: ParsedPaperDocument; markdown: string }> {
  const texPath = await resolveMainTexPath({
    workspaceDir: options.workspaceDir,
    paperKey: options.paperKey
  });
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "pi-paper-reader-tex-source-"));
  const latexmlBin = options.latexmlBin ?? process.env.PI_PAPER_READER_LATEXML_BIN ?? "latexmlc";
  const pandocBin = options.pandocBin ?? process.env.PI_PAPER_READER_PANDOC_BIN ?? "pandoc";
  const timeoutMs =
    options.timeoutMs ??
    (Number(process.env.PI_PAPER_READER_TEX_SOURCE_TIMEOUT_MS || "") ||
    Number(process.env.PI_PAPER_READER_TIMEOUT_MS || "") ||
    DEFAULT_TIMEOUT_MS);

  try {
    const htmlPath = path.join(outputDir, "document.html");
    const markdownPath = path.join(outputDir, "document.md");
    await convertTexToHtml({
      texPath,
      outputPath: htmlPath,
      latexmlBin,
      timeoutMs
    });
    const markdown = sanitizeLatexmlMarkdown(await convertHtmlToMarkdown({
      htmlPath,
      outputPath: markdownPath,
      pandocBin,
      timeoutMs
    }));
    if (!markdown) {
      throw new PaperReaderError("parse_failed", "pandoc did not produce markdown from LaTeXML HTML.");
    }

    const title = options.title ?? titleFromMarkdown(markdown, options.paperKey);
    const elements = markdownToElements(markdown);
    if (elements.length === 0) {
      throw new PaperReaderError("parse_failed", "TeX source markdown did not contain readable text.");
    }
    const sections = createSections(elements, title);
    return {
      document: {
        paperKey: options.paperKey,
        engine: "tex-source",
        pdfSha256: options.pdfSha256,
        createdAt: new Date().toISOString(),
        title,
        pages: 1,
        elements,
        sections
      },
      markdown
    };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
