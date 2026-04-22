import type { PublisherAdapter } from "./types.js";

export const scienceAdapter: PublisherAdapter = {
  id: "science",
  matches(url: URL) {
    return url.hostname === "www.science.org" || url.hostname === "science.org";
  },
  resolvePdfPathFromHtml(html: string) {
    const match = html.match(/href="([^"]*\/doi\/pdf\/[^"]+)"/i);
    return match?.[1] ?? null;
  }
} as const;
