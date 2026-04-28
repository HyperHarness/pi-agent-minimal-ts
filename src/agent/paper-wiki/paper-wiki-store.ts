import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePaperLibraryPaths } from "../knowledge-base.js";

export function getPapersDir(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).libraryRoot;
}

export function getRawPapersDir(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).rawPdfRoot;
}

export function getPaperWikiDir(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).wikiRoot;
}

export function getPaperWikiSourcesDir(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).sourcesRoot;
}

export function getPaperWikiPagesDir(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).pagesRoot;
}

export function getPaperWikiAssetsDir(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).assetsRoot;
}

export function getPaperWikiManifestsDir(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).manifestsRoot;
}

export function getPaperWikiStateDir(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).stateRoot;
}

export function getPaperWikiSchemaPath(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).schemaPath;
}

export function getPaperWikiIndexPath(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).indexPath;
}

export function getPaperWikiLogPath(workspaceDir: string): string {
  return resolvePaperLibraryPaths(workspaceDir).logPath;
}

export function sanitizeWikiFilename(value: string): string {
  const sanitized = value
    .trim()
    .replace(/\.[Mm][Dd]$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "");
  if (!sanitized) {
    throw new Error("paperKey must contain at least one filename-safe character.");
  }
  return sanitized;
}

export function getPaperWikiSourcePath(workspaceDir: string, paperKey: string): string {
  return path.join(getPaperWikiSourcesDir(workspaceDir), `${sanitizeWikiFilename(paperKey)}.md`);
}

export function relativeToWorkspace(workspaceDir: string, filePath: string): string {
  return path.relative(workspaceDir, filePath).split(path.sep).join("/");
}

const SCHEMA_MARKDOWN = `# Paper LLM Wiki Schema

This directory is maintained by the agent as a compact scientific-paper wiki.

## Layers

- Raw PDFs live in \`../raw/pdfs/\` and are immutable acquisition artifacts.
- Parsed PDF output lives in \`sources/<paper-key>/\` and is derived evidence for that source.
- LLM-authored retrieval summaries live in \`sources/<paper-key>.md\`.
- Higher-level synthesis pages can live in \`pages/\` when the source layer is stable.
- Source manifests can live in \`manifests/\` for migration and audit tooling.

## Conventions

- Keep source pages grounded in parsed paper text and cite page numbers when possible.
- Prefer short, searchable claims over long copied passages.
- Preserve provenance in frontmatter: paper key, PDF hash, parser engine, raw PDF path, and parse paths.
- Update \`index.md\` on every source write and append chronological events to \`log.md\`.
`;

const INITIAL_INDEX = `# Paper LLM Wiki Index

## Sources

No source summaries yet.
`;

const INITIAL_LOG = `# Paper LLM Wiki Log
`;

export async function ensurePaperWikiScaffold(workspaceDir: string): Promise<void> {
  await Promise.all([
    mkdir(getRawPapersDir(workspaceDir), { recursive: true }),
    mkdir(getPaperWikiSourcesDir(workspaceDir), { recursive: true }),
    mkdir(getPaperWikiPagesDir(workspaceDir), { recursive: true }),
    mkdir(getPaperWikiAssetsDir(workspaceDir), { recursive: true }),
    mkdir(getPaperWikiManifestsDir(workspaceDir), { recursive: true }),
    mkdir(getPaperWikiStateDir(workspaceDir), { recursive: true })
  ]);

  await Promise.all([
    writeIfMissing(getPaperWikiSchemaPath(workspaceDir), SCHEMA_MARKDOWN),
    writeIfMissing(getPaperWikiIndexPath(workspaceDir), INITIAL_INDEX),
    writeIfMissing(getPaperWikiLogPath(workspaceDir), INITIAL_LOG)
  ]);
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await readFile(filePath, "utf8");
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${content.trimEnd()}\n`, "utf8");
  }
}

export async function listPaperWikiSourceFiles(workspaceDir: string): Promise<string[]> {
  const sourcesDir = getPaperWikiSourcesDir(workspaceDir);
  try {
    const entries = await readdir(sourcesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(sourcesDir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}
