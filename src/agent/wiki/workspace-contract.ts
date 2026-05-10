import path from "node:path";
import { resolvePaperLibraryPaths } from "../knowledge-base.js";

export type WikiLifecycleKind =
  | "rawInputs"
  | "sourceRecords"
  | "parseArtifacts"
  | "sourceSummaries"
  | "synthesisPages"
  | "assets"
  | "manifests"
  | "runtimeState";

export interface WikiWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

export interface WikiWorkspaceContract {
  schemaVersion: 1;
  workspaceDir: string;
  rootRelativePath: string;
  roots: Record<WikiLifecycleKind, WikiWorkspacePath>;
  files: {
    index: WikiWorkspacePath;
    humanLog: WikiWorkspacePath;
    operationJournal: WikiWorkspacePath;
  };
}

function toWikiPath(workspaceDir: string, absolutePath: string): WikiWorkspacePath {
  return {
    absolutePath,
    relativePath: path.relative(workspaceDir, absolutePath).split(path.sep).join("/")
  };
}

export function resolveWikiWorkspaceContract(workspaceDir: string): WikiWorkspaceContract {
  const paths = resolvePaperLibraryPaths(workspaceDir);
  const statePath = paths.stateRoot;
  return {
    schemaVersion: 1,
    workspaceDir,
    rootRelativePath: toWikiPath(workspaceDir, paths.libraryRoot).relativePath,
    roots: {
      rawInputs: toWikiPath(workspaceDir, paths.rawPdfRoot),
      sourceRecords: toWikiPath(workspaceDir, paths.sourcesRoot),
      parseArtifacts: toWikiPath(workspaceDir, paths.sourcesRoot),
      sourceSummaries: toWikiPath(workspaceDir, paths.sourcesRoot),
      synthesisPages: toWikiPath(workspaceDir, paths.pagesRoot),
      assets: toWikiPath(workspaceDir, paths.assetsRoot),
      manifests: toWikiPath(workspaceDir, paths.manifestsRoot),
      runtimeState: toWikiPath(workspaceDir, statePath)
    },
    files: {
      index: toWikiPath(workspaceDir, paths.indexPath),
      humanLog: toWikiPath(workspaceDir, paths.logPath),
      operationJournal: toWikiPath(workspaceDir, path.join(statePath, "wiki-operations.jsonl"))
    }
  };
}

export function wikiPathForLifecycle(
  contract: WikiWorkspaceContract,
  lifecycle: WikiLifecycleKind,
  childPath: string
): WikiWorkspacePath {
  const absolutePath = path.join(contract.roots[lifecycle].absolutePath, childPath);
  return {
    absolutePath,
    relativePath: path.relative(contract.workspaceDir, absolutePath).split(path.sep).join("/")
  };
}
