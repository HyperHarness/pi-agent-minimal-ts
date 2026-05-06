const DEFAULT_MAX_CHARS = 4000;
const LABEL_RESERVE_CHARS = 32;

function normalizeMaxChars(maxChars: number): number {
  return Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
}

function splitOversizedPart(part: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = part;

  while (remaining.length > maxChars) {
    chunks.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function splitBody(text: string, maxChars: number): string[] {
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [text];
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    if (line.length > maxChars) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      for (const chunk of splitOversizedPart(line, maxChars)) {
        if (chunk.trim()) {
          chunks.push(chunk.trim());
        }
      }
      continue;
    }

    if (current && current.length + line.length > maxChars) {
      chunks.push(current.trim());
      current = line;
      continue;
    }

    current += line;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

export function splitLongTextForFeishu(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  const safeMaxChars = normalizeMaxChars(maxChars);
  if (normalized.length <= safeMaxChars) {
    return [normalized];
  }

  let bodyMaxChars = Math.max(1, safeMaxChars - LABEL_RESERVE_CHARS);
  let chunks = splitBody(normalized, bodyMaxChars);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const widestLabelLength = `(${chunks.length}/${chunks.length})\n`.length;
    const nextBodyMaxChars = Math.max(1, safeMaxChars - widestLabelLength);
    const nextChunks = splitBody(normalized, nextBodyMaxChars);
    if (nextChunks.length === chunks.length && nextBodyMaxChars === bodyMaxChars) {
      break;
    }
    chunks = nextChunks;
    bodyMaxChars = nextBodyMaxChars;
  }

  if (chunks.length === 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
}
