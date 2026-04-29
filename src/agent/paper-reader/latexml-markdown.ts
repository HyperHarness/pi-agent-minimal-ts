export function decodeHtmlEntities(value: string): string {
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

function getHtmlAttribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function sanitizeLatexmlMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const firstHeadingIndex = normalized.search(/^#\s+/m);
  const body = firstHeadingIndex >= 0 ? normalized.slice(firstHeadingIndex) : normalized;
  return decodeHtmlEntities(
    body
      .replace(/<span\b[^>]*class="[^"]*\bltx_ERROR\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "")
      .replace(/<img\b[^>]*>/gi, (match: string) => {
        const alt = getHtmlAttribute(match, "alt") ?? "";
        const src = getHtmlAttribute(match, "src") ?? "";
        return alt || src ? `![${alt}](${src})` : "";
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?[a-z][^>]*>/gi, "")
      .replace(/Generated on [^\n]* by LaTeXML!\[Mascot Sammy]\(data:image\/png;base64,[^)]+\)/gi, "")
      .replace(/^[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
