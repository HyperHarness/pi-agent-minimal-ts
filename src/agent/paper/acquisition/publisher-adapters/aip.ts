import type { PublisherAdapter } from "./types.js";

export const aipAdapter: PublisherAdapter = {
  id: "aip",
  matches(url: URL) {
    return url.hostname === "pubs.aip.org" || url.hostname.endsWith(".pubs.aip.org");
  },
  resolvePdfPathFromHtml(html: string) {
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
