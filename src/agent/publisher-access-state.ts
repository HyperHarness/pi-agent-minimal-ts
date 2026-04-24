import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupportedPaperSource } from "./paper-types.js";

export const DEFAULT_CLOUDFLARE_COOLDOWN_MS = 30 * 60 * 1000;

export interface PublisherAccessState {
  cloudflareBlocks?: Partial<Record<SupportedPaperSource, { blockedAt: string }>>;
}

export function getPublisherAccessStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, ".browser-profile", "paper-access-state.json");
}

export function resolveCloudflareCooldownMs(options: {
  env?: NodeJS.ProcessEnv;
} = {}): number {
  const rawValue = options.env?.PI_PAPER_CLOUDFLARE_COOLDOWN_MS?.trim();
  if (!rawValue) {
    return DEFAULT_CLOUDFLARE_COOLDOWN_MS;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("PI_PAPER_CLOUDFLARE_COOLDOWN_MS must be a non-negative number.");
  }

  return Math.floor(value);
}

export async function readPublisherAccessState(options: {
  workspaceDir: string;
}): Promise<PublisherAccessState> {
  try {
    const rawState = await readFile(getPublisherAccessStatePath(options.workspaceDir), "utf8");
    const parsed = JSON.parse(rawState) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as PublisherAccessState;
  } catch {
    return {};
  }
}

export async function writePublisherAccessState(options: {
  workspaceDir: string;
  state: PublisherAccessState;
}): Promise<void> {
  const statePath = getPublisherAccessStatePath(options.workspaceDir);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(options.state, null, 2)}\n`, "utf8");
}

export function getRecentCloudflareBlock(input: {
  state: PublisherAccessState;
  publisher: SupportedPaperSource;
  now: Date;
  cooldownMs: number;
}): string | null {
  const blockedAt = input.state.cloudflareBlocks?.[input.publisher]?.blockedAt;
  if (!blockedAt) {
    return null;
  }

  const blockedAtTime = Date.parse(blockedAt);
  if (!Number.isFinite(blockedAtTime)) {
    return null;
  }

  return input.now.getTime() - blockedAtTime <= input.cooldownMs ? blockedAt : null;
}

export function setCloudflareBlock(input: {
  state: PublisherAccessState;
  publisher: SupportedPaperSource;
  blockedAt: string;
}): PublisherAccessState {
  return {
    ...input.state,
    cloudflareBlocks: {
      ...input.state.cloudflareBlocks,
      [input.publisher]: {
        blockedAt: input.blockedAt
      }
    }
  };
}
