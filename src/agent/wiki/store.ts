import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

export function getPaperWikiSourceManifestPath(workspaceDir: string, paperKey: string): string {
  return path.join(getPaperWikiManifestsDir(workspaceDir), `${sanitizeWikiFilename(paperKey)}.json`);
}

export function getPaperWikiOperationJournalPath(workspaceDir: string): string {
  return path.join(getPaperWikiStateDir(workspaceDir), "wiki-operations.jsonl");
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
  return path.join(getPaperWikiSourcesDir(workspaceDir), sanitizeWikiFilename(paperKey), "summary.md");
}

export function paperKeyFromPaperWikiSourcePath(filePath: string): string {
  if (path.basename(filePath) !== "summary.md") {
    throw new Error("paper source summary path must end with summary.md.");
  }
  return sanitizeWikiFilename(path.basename(path.dirname(filePath)));
}

export function getPaperWikiPagePath(workspaceDir: string, pageKey: string): string {
  return path.join(getPaperWikiPagesDir(workspaceDir), `${sanitizeWikiFilename(pageKey)}.md`);
}

export function relativeToWorkspace(workspaceDir: string, filePath: string): string {
  return path.relative(workspaceDir, filePath).split(path.sep).join("/");
}

const INITIAL_INDEX = `# Paper LLM Wiki Index

## Knowledge Entries

No knowledge entries yet.

## Source Layer

Source summaries are citeable evidence under [sources/](sources/). Promote repeated concepts into durable pages with \`build_wiki_page\`.
`;

const INITIAL_LOG = `# Paper LLM Wiki Log

This log tracks durable synthesis-page operations under \`pages/\`. Paper downloads are tracked in per-source \`sources/<paperKey>/acquisition.json\` files; source-summary evidence under \`sources/\` is not logged here.
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
    const summaryPaths = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const summaryPath = path.join(sourcesDir, entry.name, "summary.md");
        try {
          await access(summaryPath);
          return summaryPath;
        } catch {
          return undefined;
        }
      }));
    return summaryPaths
      .filter((summaryPath): summaryPath is string => Boolean(summaryPath))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function listPaperWikiPageFiles(workspaceDir: string): Promise<string[]> {
  const pagesDir = getPaperWikiPagesDir(workspaceDir);
  try {
    const entries = await readdir(pagesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(pagesDir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}
