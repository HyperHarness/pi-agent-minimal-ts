import type { PublisherAdapter } from "./types.js";

export const natureAdapter: PublisherAdapter = {
  id: "nature",
  matches(url: URL) {
    return url.hostname === "www.nature.com" || url.hostname === "nature.com";
  },
  resolvePdfPathFromHtml(html: string) {
    const match = html.match(/href="([^"]*\/articles\/[^"]+\.pdf[^"]*)"/i);
    return match?.[1] ?? null;
  }
} as const;
