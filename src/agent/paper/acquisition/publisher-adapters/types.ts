import type { SupportedPaperSource } from "../../types.js";

export interface PublisherAdapter {
  id: SupportedPaperSource;
  matches(url: URL): boolean;
  resolvePdfPathFromHtml(html: string): string | null;
}
