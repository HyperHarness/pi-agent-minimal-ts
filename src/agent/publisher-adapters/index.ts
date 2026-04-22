import { scienceAdapter } from "./science.js";
import { natureAdapter } from "./nature.js";
import { apsAdapter } from "./aps.js";
import type { PublisherAdapter } from "./types.js";

const adapters = [scienceAdapter, natureAdapter, apsAdapter] as const;

export function getPublisherAdapter(input: string): PublisherAdapter {
  const url = new URL(input);
  const adapter = adapters.find((candidate) => candidate.matches(url));
  if (!adapter) {
    throw new Error(`Unsupported publisher for URL: ${url.hostname}`);
  }

  return adapter;
}

export function resolvePdfPathFromHtml(
  publisherId: "science" | "nature" | "aps",
  html: string
): string | null {
  const adapter = adapters.find((candidate) => candidate.id === publisherId);
  if (!adapter) {
    throw new Error(`Unsupported publisher id: ${publisherId}`);
  }

  return adapter.resolvePdfPathFromHtml(html);
}

export type { PublisherAdapter } from "./types.js";
