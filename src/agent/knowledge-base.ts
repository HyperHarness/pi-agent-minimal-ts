import path from "node:path";

export interface PaperLibraryPaths {
  workspaceDir: string;
  libraryRoot: string;
  rawRoot: string;
  rawPdfRoot: string;
  recordsRoot: string;
  wikiRoot: string;
  sourceArtifactsRoot: string;
  sourcesRoot: string;
  pagesRoot: string;
  assetsRoot: string;
  manifestsRoot: string;
  stateRoot: string;
  indexPath: string;
  logPath: string;
}

function configuredPaperLibraryRoot(): string | undefined {
  const configured = process.env.PI_KNOWLEDGE_BASE_DIR?.trim();
  return configured ? path.resolve(configured) : undefined;
}

export function resolvePaperLibraryRoot(workspaceDir: string): string {
  return configuredPaperLibraryRoot() ?? path.join(workspaceDir, "knowledge-base");
}

export function resolvePaperLibraryPaths(workspaceDir: string): PaperLibraryPaths {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const libraryRoot = resolvePaperLibraryRoot(resolvedWorkspaceDir);
  const rawRoot = path.join(libraryRoot, "raw");
  const wikiRoot = path.join(libraryRoot, "wiki");

  return {
    workspaceDir: resolvedWorkspaceDir,
    libraryRoot,
    rawRoot,
    rawPdfRoot: path.join(rawRoot, "pdfs"),
    recordsRoot: path.join(libraryRoot, "records"),
    wikiRoot,
    sourcesRoot: path.join(wikiRoot, "sources"),
    sourceArtifactsRoot: path.join(wikiRoot, "sources"),
    pagesRoot: path.join(wikiRoot, "pages"),
    assetsRoot: path.join(wikiRoot, "assets"),
    manifestsRoot: path.join(wikiRoot, "manifests"),
    stateRoot: path.join(wikiRoot, "state"),
    indexPath: path.join(wikiRoot, "index.md"),
    logPath: path.join(wikiRoot, "log.md")
  };
}

export function isPathInsideDirectory(rootDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootDir, candidatePath);
  return (
    relativePath === "" ||
    (
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    )
  );
}

export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of paths) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(candidate);
  }
  return unique;
}
