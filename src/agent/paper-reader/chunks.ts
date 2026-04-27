import type { ParsedPaperDocument } from "./types.js";

export interface PaperChunk {
  id: string;
  paperKey: string;
  engine: string;
  text: string;
  pageFrom: number;
  pageTo: number;
  sectionId?: string;
  elementIds: string[];
}

const DEFAULT_MAX_CHARS = 2400;

function createChunk(input: {
  document: ParsedPaperDocument;
  index: number;
  text: string;
  pageFrom: number;
  pageTo: number;
  sectionId?: string;
  elementIds: string[];
}): PaperChunk {
  return {
    id: `chunk-${String(input.index + 1).padStart(4, "0")}`,
    paperKey: input.document.paperKey,
    engine: input.document.engine,
    text: input.text.trim(),
    pageFrom: input.pageFrom,
    pageTo: input.pageTo,
    ...(input.sectionId ? { sectionId: input.sectionId } : {}),
    elementIds: input.elementIds
  };
}

export function createPaperChunks(
  document: ParsedPaperDocument,
  maxChars = DEFAULT_MAX_CHARS
): PaperChunk[] {
  const chunks: PaperChunk[] = [];
  let currentText = "";
  let currentElementIds: string[] = [];
  let pageFrom = 1;
  let pageTo = 1;
  let currentSectionId: string | undefined;

  const flush = () => {
    if (!currentText.trim()) {
      return;
    }
    chunks.push(createChunk({
      document,
      index: chunks.length,
      text: currentText,
      pageFrom,
      pageTo,
      ...(currentSectionId ? { sectionId: currentSectionId } : {}),
      elementIds: currentElementIds
    }));
    currentText = "";
    currentElementIds = [];
    currentSectionId = undefined;
  };

  for (const element of document.elements) {
    const text = element.text.trim();
    if (!text) {
      continue;
    }

    if (
      currentText &&
      (
        currentText.length + text.length + 2 > maxChars ||
        (currentSectionId !== undefined && element.sectionId !== currentSectionId)
      )
    ) {
      flush();
    }

    if (!currentText) {
      pageFrom = element.page;
      currentSectionId = element.sectionId;
    }

    pageTo = element.page;
    currentElementIds.push(element.id);
    currentText = currentText ? `${currentText}\n\n${text}` : text;
  }

  flush();
  return chunks;
}
