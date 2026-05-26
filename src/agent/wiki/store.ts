import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWikiWorkspaceContract, wikiPathForLifecycle } from "./workspace-contract.js";

export function getPapersDir(workspaceDir: string): string {
  return path.dirname(resolveWikiWorkspaceContract(workspaceDir).roots.sourceRecords.absolutePath);
}

export function getRawPapersDir(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).roots.rawInputs.absolutePath;
}

export function getPaperWikiDir(workspaceDir: string): string {
  return path.dirname(resolveWikiWorkspaceContract(workspaceDir).files.index.absolutePath);
}

export function getPaperWikiSourcesDir(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).roots.sourceSummaries.absolutePath;
}

export function getPaperWikiPagesDir(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).roots.synthesisPages.absolutePath;
}

export function getPaperWikiAssetsDir(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).roots.assets.absolutePath;
}

export function getPaperWikiStateDir(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).roots.runtimeState.absolutePath;
}

export function getKnowledgeSourceMetadataPath(workspaceDir: string, sourceKey: string): string {
  return wikiPathForLifecycle(
    resolveWikiWorkspaceContract(workspaceDir),
    "sourceRecords",
    `${sanitizeWikiFilename(sourceKey)}/metadata.json`
  ).absolutePath;
}

export function getPaperWikiOperationJournalPath(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).files.operationJournal.absolutePath;
}

export function getPaperWikiIndexPath(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).files.index.absolutePath;
}

export function getPaperWikiLogPath(workspaceDir: string): string {
  return resolveWikiWorkspaceContract(workspaceDir).files.humanLog.absolutePath;
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

function slugifyWikiPageKey(value: string): string | undefined {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/\.[Mm][Dd]$/, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || undefined;
}

export function isSourceDerivedWikiPageKey(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const startsWithPaperSourceKey =
    /^arxiv-\d{4}-\d{4,5}(?:v\d+)?(?:-|$)/.test(normalized) ||
    /^(?:science|nature|aps)-[a-z0-9]+(?:-[a-z0-9]+)+(?:-|$)/.test(normalized);
  return startsWithPaperSourceKey &&
    /(?:^|-)(?:paper|record|source|summary|coverage|synthesis)(?:-|$)/.test(normalized);
}

export function resolveWikiPageKey(input: {
  topic: string;
  pageKey?: string;
  title?: string;
  allowSourceDerivedPageKey?: boolean;
}): string {
  const requested = sanitizeWikiFilename(input.pageKey ?? input.topic);
  if (input.allowSourceDerivedPageKey || !isSourceDerivedWikiPageKey(requested)) {
    return requested;
  }

  const semanticPageKey = slugifyWikiPageKey(input.title ?? "");
  if (semanticPageKey && !isSourceDerivedWikiPageKey(semanticPageKey)) {
    return semanticPageKey;
  }

  throw new Error(
    `Refusing source-derived wiki page key "${requested}". Provide a semantic pageKey or title for the durable page.`
  );
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
