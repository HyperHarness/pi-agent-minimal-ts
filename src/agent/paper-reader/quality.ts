import type {
  PaperParseQualityReport,
  ParsedPaperDocument
} from "./types.js";

function countByPage(document: ParsedPaperDocument): Map<number, number> {
  const counts = new Map<number, number>();
  for (const element of document.elements) {
    counts.set(element.page, (counts.get(element.page) ?? 0) + element.text.trim().length);
  }
  return counts;
}

export function evaluateParseQuality(document: ParsedPaperDocument): PaperParseQualityReport {
  const totalTextLength = document.elements.reduce(
    (sum, element) => sum + element.text.trim().length,
    0
  );
  const textByPage = countByPage(document);
  let emptyPageCount = 0;
  for (let page = 1; page <= Math.max(1, document.pages); page += 1) {
    if ((textByPage.get(page) ?? 0) < 20) {
      emptyPageCount += 1;
    }
  }

  const headingCount = document.elements.filter((element) => element.type === "heading").length;
  const tableCount = document.elements.filter((element) => element.type === "table").length;
  const figureOrCaptionCount = document.elements.filter(
    (element) => element.type === "figure" || element.type === "caption"
  ).length;
  const replacementCharacterCount = document.elements.reduce(
    (sum, element) => sum + (element.text.match(/\uFFFD/g)?.length ?? 0),
    0
  );
  const pdfObjectDumpCount = document.elements.reduce(
    (sum, element) => sum +
      (element.text.match(/(?:%PDF-| endobj | endstream | xref | trailer )/g)?.length ?? 0),
    0
  );
  const referenceTextLength = document.elements
    .filter((element) => element.type === "reference")
    .reduce((sum, element) => sum + element.text.trim().length, 0);
  const hasMainBodySection = document.sections.some((section) => {
    if (/^supplementary materials?$/i.test(section.title.trim())) {
      return false;
    }

    return /(?:introduction|background|results?|discussion|methods?|materials|conclusion|data availability)/i
      .test(section.title);
  });

  const warnings: string[] = [];
  if (totalTextLength < 1500) {
    warnings.push("Extracted text is short for a scientific paper.");
  }
  if (emptyPageCount > Math.max(1, Math.floor(document.pages / 3))) {
    warnings.push("Many pages have little or no extracted text.");
  }
  if (headingCount === 0) {
    warnings.push("No headings were detected.");
  }
  if (replacementCharacterCount > 20) {
    warnings.push("Extracted text contains many replacement characters.");
  }
  if (pdfObjectDumpCount > 5) {
    warnings.push("Extracted text looks like raw PDF object syntax rather than paper body text.");
  }
  if (document.engine === "webpage" && !hasMainBodySection && totalTextLength < 8000) {
    warnings.push("No main body sections were detected; the webpage may expose only abstract, references, or access-limited text.");
  }
  if (
    document.engine === "webpage" &&
    totalTextLength > 0 &&
    referenceTextLength / totalTextLength > 0.65
  ) {
    warnings.push("References dominate the extracted webpage text; article body access may be limited.");
  }

  let score = 1;
  if (totalTextLength < 1500) {
    score -= 0.35;
  }
  if (headingCount === 0) {
    score -= 0.15;
  }
  if (emptyPageCount > 0) {
    score -= Math.min(0.25, emptyPageCount / Math.max(1, document.pages) * 0.5);
  }
  if (replacementCharacterCount > 20) {
    score -= 0.2;
  }
  if (pdfObjectDumpCount > 5) {
    score -= 0.8;
  }
  if (document.engine === "webpage" && !hasMainBodySection && totalTextLength < 8000) {
    score -= 0.35;
  }
  if (
    document.engine === "webpage" &&
    totalTextLength > 0 &&
    referenceTextLength / totalTextLength > 0.65
  ) {
    score -= 0.2;
  }
  score = Math.max(0, Number(score.toFixed(2)));

  const status =
    score >= 0.7 ? "good" : score >= 0.4 ? "needs_hybrid" : "poor";

  return {
    status,
    score,
    pages: document.pages,
    totalTextLength,
    emptyPageCount,
    headingCount,
    tableCount,
    figureOrCaptionCount,
    warnings
  };
}
