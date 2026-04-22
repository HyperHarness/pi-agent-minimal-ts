import type { PublisherAdapter } from "./types.js";

export const apsAdapter: PublisherAdapter = {
  id: "aps",
  matches(url: URL) {
    return url.hostname === "journals.aps.org" || url.hostname === "aps.org";
  },
  resolvePdfPathFromHtml(html: string) {
    const match = html.match(/href="([^"]*\/(?:doi|[a-z]+)\/pdf\/[^"]+)"/i);
    return match?.[1] ?? null;
  }
} as const;
