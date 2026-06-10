import type { PublisherAdapter } from "./types.js";

export const aipAdapter: PublisherAdapter = {
  id: "aip",
  matches(url: URL) {
    return url.hostname === "pubs.aip.org" || url.hostname.endsWith(".pubs.aip.org");
  },
  resolvePdfPathFromHtml(html: string) {
    const citationPdfMatch = html.match(/<meta\b[^>]*\b(?:name|property)=["']citation_pdf_url["'][^>]*\bcontent=["']([^"']*\/doi\/pdf\/10\.1063\/[^"']+)["'][^>]*>/i) ??
      html.match(/<meta\b[^>]*\bcontent=["']([^"']*\/doi\/pdf\/10\.1063\/[^"']+)["'][^>]*\b(?:name|property)=["']citation_pdf_url["'][^>]*>/i);
    if (citationPdfMatch?.[1]) {
      return citationPdfMatch[1].split(/[?#]/, 1)[0];
    }

    const citationDoiMatch = html.match(/<meta\b[^>]*\b(?:name|property)=["'](?:citation_doi|dc\.Identifier)["'][^>]*\bcontent=["'](10\.1063\/[^"'<>\s?#]+)["'][^>]*>/i) ??
      html.match(/<meta\b[^>]*\bcontent=["'](10\.1063\/[^"'<>\s?#]+)["'][^>]*\b(?:name|property)=["'](?:citation_doi|dc\.Identifier)["'][^>]*>/i);
    if (citationDoiMatch?.[1]) {
      return `/doi/pdf/${citationDoiMatch[1].replace(/[).,;]+$/g, "")}`;
    }

    const pdfMatch = html.match(/href=["']([^"']*\/doi\/pdf\/[^"']+)["']/i);
    if (pdfMatch?.[1]) {
      return pdfMatch[1];
    }

    const doiMatch = html.match(/href=["']([^"']*\/doi\/10\.1063\/[^"?#']+)["']/i);
    if (!doiMatch?.[1]) {
      return null;
    }

    return doiMatch[1].replace(/\/doi\/(?!pdf\/)/i, "/doi/pdf/");
  }
} as const;
