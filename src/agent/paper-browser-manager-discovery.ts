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
    return JSON.parse(rawMetadata) as PaperBrowserManagerMetadata;
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

export function isPaperBrowserManagerMetadataStale(options: {
  metadata: PaperBrowserManagerMetadata;
  isProcessAlive?: (pid: number) => boolean;
}): boolean {
  const isProcessAlive = options.isProcessAlive ?? (() => true);
  return !isProcessAlive(options.metadata.pid);
}
