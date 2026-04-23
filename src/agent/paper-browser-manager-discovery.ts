import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PaperBrowserManagerMetadata } from "./paper-browser-manager-types.js";

export function getPaperBrowserManagerMetadataPath(workspaceDir: string): string {
  return path.join(workspaceDir, ".browser-profile", "paper-access-manager.json");
}

export async function writePaperBrowserManagerMetadata(options: {
  workspaceDir: string;
  metadata: PaperBrowserManagerMetadata;
}): Promise<void> {
  const metadataPath = getPaperBrowserManagerMetadataPath(options.workspaceDir);
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(options.metadata, null, 2), "utf8");
}

export async function readPaperBrowserManagerMetadata(options: {
  workspaceDir: string;
}): Promise<PaperBrowserManagerMetadata | null> {
  const metadataPath = getPaperBrowserManagerMetadataPath(options.workspaceDir);
  try {
    const rawMetadata = await readFile(metadataPath, "utf8");
    const parsedMetadata: unknown = JSON.parse(rawMetadata);
    if (!isPaperBrowserManagerMetadata(parsedMetadata)) {
      return null;
    }

    return parsedMetadata;
  } catch {
    return null;
  }
}

export async function clearPaperBrowserManagerMetadata(options: {
  workspaceDir: string;
}): Promise<void> {
  const metadataPath = getPaperBrowserManagerMetadataPath(options.workspaceDir);
  await rm(metadataPath, { force: true });
}

function isPaperBrowserManagerMetadata(value: unknown): value is PaperBrowserManagerMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === "number" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.endpoint === "string" &&
    typeof candidate.profileDir === "string"
  );
}

export async function isPaperBrowserManagerMetadataStale(options: {
  metadata: PaperBrowserManagerMetadata;
  isProcessAlive?: (pid: number) => Promise<boolean>;
}): Promise<boolean> {
  const isProcessAlive = options.isProcessAlive ?? (async () => true);
  return !(await isProcessAlive(options.metadata.pid));
}
