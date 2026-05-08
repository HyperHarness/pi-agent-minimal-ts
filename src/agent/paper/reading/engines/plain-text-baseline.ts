import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import type {
  ConcretePaperParseEngine,
  ParsedPaperDocument,
  PaperElement,
  PaperSection
} from "../types.js";

interface PdfObjectMap {
  objects: Map<number, string>;
  bytes: Buffer;
}

interface PdfToken {
  type: "name" | "number" | "operator" | "string" | "hex" | "array";
  value: string;
  next: number;
}

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

function parsePdfObjects(bytes: Buffer): PdfObjectMap {
  const source = bytes.toString("latin1");
  const objects = new Map<number, string>();
  const objectPattern = /(\d+)\s+0\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = objectPattern.exec(source)) !== null) {
    const objectId = Number(match[1]);
    const objectStart = match.index + match[0].length;
    const objectEnd = source.indexOf("endobj", objectStart);
    if (!Number.isFinite(objectId) || objectEnd < 0) {
      continue;
    }
    objects.set(objectId, source.slice(objectStart, objectEnd));
  }
  return { objects, bytes };
}

function findFirstRef(body: string, key: string): number | undefined {
  const match = body.match(new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`));
  const value = match?.[1] ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

function findRefArray(body: string, key: string): number[] {
  const match = body.match(new RegExp(`/${key}\\s*\\[([\\s\\S]*?)\\]`));
  if (!match?.[1]) {
    return [];
  }
  return Array.from(match[1].matchAll(/(\d+)\s+0\s+R/g))
    .map((refMatch) => Number(refMatch[1]))
    .filter(Number.isFinite);
}

function isPageObject(body: string): boolean {
  return /\/Type\s*\/Page\b/.test(body);
}

function findPageContentRefs(map: PdfObjectMap): number[][] {
  const catalogRefMatch = map.bytes.toString("latin1").match(/\/Root\s+(\d+)\s+0\s+R/);
  const catalogRef = catalogRefMatch?.[1] ? Number(catalogRefMatch[1]) : NaN;
  const catalog = Number.isFinite(catalogRef) ? map.objects.get(catalogRef) : undefined;
  const pagesRef = catalog ? findFirstRef(catalog, "Pages") : undefined;
  if (!pagesRef) {
    return [];
  }

  const seen = new Set<number>();
  const visit = (objectId: number): number[][] => {
    if (seen.has(objectId)) {
      return [];
    }
    seen.add(objectId);
    const body = map.objects.get(objectId);
    if (!body) {
      return [];
    }
    if (isPageObject(body)) {
      const contentRefs = findRefArray(body, "Contents");
      const singleContentRef = findFirstRef(body, "Contents");
      return [contentRefs.length > 0 ? contentRefs : singleContentRef ? [singleContentRef] : []];
    }
    return findRefArray(body, "Kids").flatMap(visit);
  };

  return visit(pagesRef).filter((refs) => refs.length > 0);
}

function decodePdfStream(body: string): string | undefined {
  const streamMatch = body.match(/stream\r?\n/);
  if (!streamMatch) {
    return undefined;
  }
  const streamStart = (streamMatch.index ?? 0) + streamMatch[0].length;
  const streamEnd = body.indexOf("endstream", streamStart);
  if (streamEnd < 0) {
    return undefined;
  }
  let raw = Buffer.from(body.slice(streamStart, streamEnd), "latin1");
  if (raw.subarray(-2).toString("latin1") === "\r\n") {
    raw = raw.subarray(0, -2);
  } else if (raw.subarray(-1).toString("latin1") === "\n") {
    raw = raw.subarray(0, -1);
  }
  try {
    const decoded = body.includes("/FlateDecode") ? inflateSync(raw) : raw;
    return decoded.toString("latin1");
  } catch {
    return undefined;
  }
}

function skipWhitespace(content: string, index: number): number {
  let cursor = index;
  while (cursor < content.length && /\s/.test(content[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function parsePdfLiteralString(content: string, index: number): { value: string; next: number } {
  let cursor = index + 1;
  let depth = 1;
  let value = "";
  while (cursor < content.length && depth > 0) {
    const char = content[cursor] ?? "";
    if (char === "\\") {
      const next = content[cursor + 1] ?? "";
      if (/[0-7]/.test(next)) {
        const octal = content.slice(cursor + 1, cursor + 4).match(/^[0-7]{1,3}/)?.[0] ?? "";
        value += String.fromCharCode(Number.parseInt(octal, 8));
        cursor += 1 + octal.length;
        continue;
      }
      const escapes: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "(": "(",
        ")": ")",
        "\\": "\\"
      };
      value += escapes[next] ?? next;
      cursor += 2;
      continue;
    }
    if (char === "(") {
      depth += 1;
      value += char;
      cursor += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth > 0) {
        value += char;
      }
      cursor += 1;
      continue;
    }
    value += char;
    cursor += 1;
  }
  return { value, next: cursor };
}

function parseHexString(content: string, index: number): { value: string; next: number } {
  const end = content.indexOf(">", index + 1);
  if (end < 0) {
    return { value: "", next: content.length };
  }
  const hex = content.slice(index + 1, end).replace(/\s+/g, "");
  const bytes: number[] = [];
  for (let cursor = 0; cursor < hex.length; cursor += 2) {
    const value = Number.parseInt(hex.slice(cursor, cursor + 2).padEnd(2, "0"), 16);
    if (Number.isFinite(value)) {
      bytes.push(value);
    }
  }
  return { value: Buffer.from(bytes).toString("latin1"), next: end + 1 };
}

function readToken(content: string, index: number): PdfToken | undefined {
  const cursor = skipWhitespace(content, index);
  const char = content[cursor];
  if (!char) {
    return undefined;
  }
  if (char === "(") {
    const parsed = parsePdfLiteralString(content, cursor);
    return { type: "string", value: parsed.value, next: parsed.next };
  }
  if (char === "<" && content[cursor + 1] !== "<") {
    const parsed = parseHexString(content, cursor);
    return { type: "hex", value: parsed.value, next: parsed.next };
  }
  if (char === "[") {
    return { type: "array", value: "[", next: cursor + 1 };
  }
  if (char === "/" ) {
    const match = content.slice(cursor).match(/^\/[^\s[\]<>(){}%]+/);
    if (!match) {
      return undefined;
    }
    return { type: "name", value: match[0], next: cursor + match[0].length };
  }
  const numberMatch = content.slice(cursor).match(/^[+-]?(?:\d+\.\d+|\d+|\.\d+)/);
  if (numberMatch) {
    return { type: "number", value: numberMatch[0], next: cursor + numberMatch[0].length };
  }
  const operatorMatch = content.slice(cursor).match(/^[^\s[\]<>(){}%]+/);
  if (!operatorMatch) {
    return undefined;
  }
  return { type: "operator", value: operatorMatch[0], next: cursor + operatorMatch[0].length };
}

function decodeGlyphText(text: string, fontName: string | undefined): string {
  let decoded = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (fontName === "/F6" && code === 1) {
      decoded += "fl";
      continue;
    }
    if (fontName === "/F6" && code === 3) {
      decoded += "fi";
      continue;
    }
    if (fontName === "/F5" && code === 1) {
      decoded += "γ";
      continue;
    }
    if (code === 0x96 || code === 0xad) {
      decoded += "-";
      continue;
    }
    if (code < 32 && !/\s/.test(char)) {
      continue;
    }
    decoded += char;
  }
  return decoded;
}

function cleanExtractedText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseTextArray(content: string, index: number, fontName: string | undefined): {
  text: string;
  next: number;
} {
  let cursor = index + 1;
  let text = "";
  while (cursor < content.length) {
    cursor = skipWhitespace(content, cursor);
    if (content[cursor] === "]") {
      return { text, next: cursor + 1 };
    }
    const token = readToken(content, cursor);
    if (!token) {
      return { text, next: cursor + 1 };
    }
    if (token.type === "string" || token.type === "hex") {
      text += decodeGlyphText(token.value, fontName);
    } else if (token.type === "number" && Number(token.value) < -80 && !text.endsWith(" ")) {
      text += " ";
    }
    cursor = token.next;
  }
  return { text, next: cursor };
}

function peekOperator(content: string, index: number): string | undefined {
  const token = readToken(content, index);
  return token?.type === "operator" ? token.value : undefined;
}

function extractTextFromContentStream(content: string): string {
  let cursor = 0;
  let currentFont: string | undefined;
  let output = "";

  const appendText = (text: string): void => {
    const decoded = text.replace(/\s+/g, " ").trim();
    if (!decoded) {
      return;
    }
    if (output && !/[\s-]$/.test(output) && !/^[,.;:!?)]/.test(decoded)) {
      output += " ";
    }
    output += decoded;
  };

  while (cursor < content.length) {
    const token = readToken(content, cursor);
    if (!token) {
      break;
    }

    if (token.type === "name") {
      const sizeToken = readToken(content, token.next);
      const operatorToken = sizeToken ? readToken(content, sizeToken.next) : undefined;
      if (sizeToken?.type === "number" && operatorToken?.type === "operator" && operatorToken.value === "Tf") {
        currentFont = token.value;
        cursor = operatorToken.next;
        continue;
      }
    }

    if (token.type === "array") {
      const parsed = parseTextArray(content, token.next - 1, currentFont);
      const operator = peekOperator(content, parsed.next);
      if (operator === "TJ") {
        appendText(parsed.text);
        cursor = (readToken(content, parsed.next)?.next ?? parsed.next);
        continue;
      }
      cursor = parsed.next;
      continue;
    }

    if (token.type === "string" || token.type === "hex") {
      const operator = peekOperator(content, token.next);
      if (operator === "Tj" || operator === "'" || operator === "\"") {
        appendText(decodeGlyphText(token.value, currentFont));
        cursor = (readToken(content, token.next)?.next ?? token.next);
        continue;
      }
    }

    if (token.type === "operator" && token.value === "T*") {
      if (!output.endsWith("\n")) {
        output += "\n";
      }
    }

    cursor = token.next;
  }

  return cleanExtractedText(output);
}

function extractPageTextsFromPdf(bytes: Buffer): string[] {
  const objectMap = parsePdfObjects(bytes);
  const pageContentRefs = findPageContentRefs(objectMap);
  const pageTexts = pageContentRefs.map((contentRefs) => {
    const pageText = contentRefs
      .map((ref) => objectMap.objects.get(ref))
      .map((body) => body ? decodePdfStream(body) : undefined)
      .filter((content): content is string => Boolean(content))
      .map(extractTextFromContentStream)
      .filter(Boolean)
      .join("\n\n");
    return cleanExtractedText(pageText);
  }).filter(Boolean);

  if (pageTexts.length > 0) {
    return pageTexts;
  }

  return Array.from(objectMap.objects.values())
    .map(decodePdfStream)
    .filter((content): content is string => typeof content === "string" && content.includes("BT"))
    .map(extractTextFromContentStream)
    .filter((text) => text.length > 20);
}

function createSections(elements: PaperElement[], title: string): PaperSection[] {
  const section: PaperSection = {
    id: "section-0001",
    title,
    level: 1,
    pageFrom: 1,
    pageTo: Math.max(1, ...elements.map((element) => element.page)),
    elementIds: elements.map((element) => element.id)
  };
  return [section];
}

export async function parseWithPlainTextBaseline(input: {
  pdfPath: string;
  paperKey: string;
  pdfSha256: string;
  title?: string;
  createdAt?: string;
}): Promise<{ document: ParsedPaperDocument; markdown: string }> {
  const bytes = await readFile(input.pdfPath);
  const title = input.title ?? input.paperKey;
  const pageTexts = extractPageTextsFromPdf(bytes);
  const text = pageTexts.length > 0
    ? pageTexts.map((pageText, index) => `## Page ${index + 1}\n\n${pageText}`).join("\n\n")
    : extractPrintableText(bytes);
  const sectionId = "section-0001";
  const pageElements: PaperElement[] = pageTexts.length > 0
    ? pageTexts.map((pageText, index) => ({
      id: `el-${String(index + 2).padStart(5, "0")}`,
      type: "paragraph" as const,
      text: pageText,
      page: index + 1,
      sectionId
    }))
    : [{
      id: "el-00002",
      type: "paragraph" as const,
      text,
      page: 1,
      sectionId
    }];
  const elements: PaperElement[] = [
    {
      id: "el-0001",
      type: "heading",
      text: title,
      page: 1,
      sectionId,
      headingLevel: 1
    },
    ...pageElements
  ];
  const sections = createSections(elements, title);
  const engine: ConcretePaperParseEngine = "plain-text-baseline";

  return {
    document: {
      paperKey: input.paperKey,
      engine,
      pdfSha256: input.pdfSha256,
      createdAt: input.createdAt ?? new Date().toISOString(),
      title,
      pages: pageTexts.length || 1,
      elements,
      sections
    },
    markdown: buildDocumentMarkdown(title, text)
  };
}
