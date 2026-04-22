export interface PublisherAdapter {
  id: "science" | "nature" | "aps";
  matches(url: URL): boolean;
  resolvePdfPathFromHtml(html: string): string | null;
}
