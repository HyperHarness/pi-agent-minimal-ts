import type { PublisherAdapter } from "./types.js";

export const scienceAdapter: PublisherAdapter = {
  id: "science",
  matches(url: URL) {
    return url.hostname === "www.science.org" || url.hostname === "science.org";
  },
  resolvePdfPathFromHtml(html: string) {
    const pdfMatch = html.match(/href="([^"]*\/doi\/pdf\/[^"]+)"/i);
    if (pdfMatch?.[1]) {
      return pdfMatch[1];
    }

    const epdfMatch = html.match(/href="([^"]*\/doi\/epdf\/([^"?/#]+(?:\/[^"?#]+)*))[^"]*"/i);
    if (!epdfMatch?.[2]) {
      return null;
    }

    return `/doi/pdf/${epdfMatch[2]}?download=true`;
  }
} as const;
