import { readFile } from "node:fs/promises";
import type {
  ConcretePaperParseEngine,
  ParsedPaperDocument,
  PaperElement,
  PaperSection
} from "../types.js";

function extractPrintableText(bytes: Buffer): string {
  return bytes
    .toString("latin1")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDocumentMarkdown(title: string, text: string): string {
  return `# ${title}\n\n${text}`;
}

export async function parseWithPlainTextBaseline(input: {
  pdfPath: string;
  paperKey: string;
  pdfSha256: string;
  title?: string;
  createdAt?: string;
}): Promise<{ document: ParsedPaperDocument; markdown: string }> {
  const bytes = await readFile(input.pdfPath);
  const text = extractPrintableText(bytes);
  const title = input.title ?? input.paperKey;
  const sectionId = "section-0001";
  const elements: PaperElement[] = [
    {
      id: "el-0001",
      type: "heading",
      text: title,
      page: 1,
      sectionId,
      headingLevel: 1
    },
    {
      id: "el-0002",
      type: "paragraph",
      text,
      page: 1,
      sectionId
    }
  ];
  const sections: PaperSection[] = [
    {
      id: sectionId,
      title,
      level: 1,
      pageFrom: 1,
      pageTo: 1,
      elementIds: elements.map((element) => element.id)
    }
  ];
  const engine: ConcretePaperParseEngine = "plain-text-baseline";

  return {
    document: {
      paperKey: input.paperKey,
      engine,
      pdfSha256: input.pdfSha256,
      createdAt: input.createdAt ?? new Date().toISOString(),
      title,
      pages: 1,
      elements,
      sections
    },
    markdown: buildDocumentMarkdown(title, text)
  };
}
