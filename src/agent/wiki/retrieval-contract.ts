import { readFile } from "node:fs/promises";
import {
  getPaperWikiSourcePath,
  listPaperWikiSourceFiles,
  paperKeyFromPaperWikiSourcePath,
  relativeToWorkspace
} from "./store.js";
import {
  getWikiSourceManifestPath,
  normalizeUnknownWikiSourceManifest,
  validateWikiSourceManifestIdentity,
  type WikiSourceKind,
  type WikiSourceManifestV2
} from "./manifest-store.js";
import {
  type WikiClaimProvenance,
  type WikiEvidenceContract,
  type WikiExperimentRef,
  type WikiReviewerCritiqueItem,
  type WikiTypedPage,
  type WikiTypedRelation
} from "./page-schema.js";
import {
  listTypedWikiPages,
  readTypedWikiPage,
  type ReadTypedWikiPageResult,
  type WikiPageDiagnostic
} from "./typed-store.js";

export type WikiEvidenceKind = "source" | "page";
export type WikiEvidenceReadStatus = "ready" | "missing" | "malformed" | "blocked";

export interface WikiEvidenceItem {
  kind: WikiEvidenceKind;
  key: string;
  title: string;
  body: string;
  relativePath: string;
  tags: string[];
  aliases: string[];
  evidenceContract: WikiEvidenceContract;
  sourceRefs: string[];
  sourceKind?: WikiSourceKind;
  sourceKey?: string;
  claims?: WikiClaimProvenance[];
  typedRelations?: WikiTypedRelation[];
  experimentRefs?: WikiExperimentRef[];
  reviewerCritique?: WikiReviewerCritiqueItem[];
  manifest?: WikiSourceManifestV2;
  diagnostics: string[];
}

export interface ReadWikiEvidenceItemOptions {
  workspaceDir: string;
  kind: WikiEvidenceKind;
  key: string;
}

export interface ReadWikiEvidenceItemResult {
  status: WikiEvidenceReadStatus;
  item?: WikiEvidenceItem;
  diagnostics: string[];
}

export interface ListWikiEvidenceItemsOptions {
  workspaceDir: string;
  kinds?: WikiEvidenceKind[];
  tags?: string[];
  sourceRefs?: string[];
  evidenceContracts?: WikiEvidenceContract[];
  keys?: string[];
}

export interface ListWikiEvidenceItemsResult {
  items: WikiEvidenceItem[];
  diagnostics: string[];
}

function stripLeadingFrontmatter(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
}

function diagnosticsFromTypedPage(diagnostics: WikiPageDiagnostic[]): string[] {
  return diagnostics.flatMap((diagnostic) =>
    diagnostic.errors.map((error) => `${diagnostic.relativePath}: ${error.message}`)
  );
}

function pageReadStatus(diagnostics: WikiPageDiagnostic[]): WikiEvidenceReadStatus {
  const messages = diagnostics.flatMap((diagnostic) => diagnostic.errors.map((error) => error.message));
  return messages.some((message) => message.toLowerCase().includes("does not exist"))
    ? "missing"
    : "malformed";
}

function diagnosticForKey(kind: WikiEvidenceKind, key: string, error: unknown): string {
  return `Invalid ${kind} evidence key "${key}": ${error instanceof Error ? error.message : String(error)}`;
}

async function readSourceManifestForEvidence(input: {
  workspaceDir: string;
  manifestPath: string;
  expectedSourceKey: string;
  expectedSummaryPath: string;
}): Promise<{
  manifest?: WikiSourceManifestV2;
  missing: boolean;
  malformed: boolean;
  diagnostics: string[];
}> {
  const relativeManifestPath = relativeToWorkspace(input.workspaceDir, input.manifestPath);
  try {
    const rawManifest = await readFile(input.manifestPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawManifest);
    } catch (error) {
      return {
        missing: false,
        malformed: true,
        diagnostics: [
          `${relativeManifestPath}: malformed manifest JSON: ${error instanceof Error ? error.message : String(error)}`
        ]
      };
    }

    const manifest = normalizeUnknownWikiSourceManifest(parsed);
    if (!manifest) {
      return {
        missing: false,
        malformed: true,
        diagnostics: [`${relativeManifestPath}: malformed manifest shape.`]
      };
    }

    const identityDiagnostics = validateWikiSourceManifestIdentity({
      manifest,
      sourceKey: input.expectedSourceKey,
      summaryPath: input.expectedSummaryPath
    });
    if (identityDiagnostics.length > 0) {
      return {
        missing: false,
        malformed: true,
        diagnostics: identityDiagnostics.map((diagnostic) => `${relativeManifestPath}: malformed manifest identity: ${diagnostic}`)
      };
    }

    return {
      manifest,
      missing: false,
      malformed: false,
      diagnostics: []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        missing: true,
        malformed: false,
        diagnostics: [`${relativeManifestPath}: missing manifest for source summary.`]
      };
    }
    return {
      missing: false,
      malformed: true,
      diagnostics: [
        `${relativeManifestPath}: malformed manifest: ${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
}

async function readSourceEvidenceItem(options: ReadWikiEvidenceItemOptions): Promise<ReadWikiEvidenceItemResult> {
  let sourcePath: string;
  let manifestPath: string;
  try {
    sourcePath = getPaperWikiSourcePath(options.workspaceDir, options.key);
    manifestPath = getWikiSourceManifestPath(options.workspaceDir, options.key);
  } catch (error) {
    return {
      status: "malformed",
      diagnostics: [diagnosticForKey("source", options.key, error)]
    };
  }

  let markdown: string;
  try {
    markdown = await readFile(sourcePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "missing",
        diagnostics: [`${relativeToWorkspace(options.workspaceDir, sourcePath)}: source summary is missing.`]
      };
    }
    return {
      status: "malformed",
      diagnostics: [
        `${relativeToWorkspace(options.workspaceDir, sourcePath)}: unable to read source summary: ${
          error instanceof Error ? error.message : String(error)
        }`
      ]
    };
  }

  const manifestResult = await readSourceManifestForEvidence({
    workspaceDir: options.workspaceDir,
    manifestPath,
    expectedSourceKey: options.key,
    expectedSummaryPath: relativeToWorkspace(options.workspaceDir, sourcePath)
  });
  const diagnostics = manifestResult.diagnostics;
  const manifest = manifestResult.manifest;

  const sourceRefs = manifest ? [manifest.sourceKey] : [];
  const item: WikiEvidenceItem = {
    kind: "source",
    key: manifest?.sourceKey ?? options.key,
    title: manifest?.title ?? options.key,
    body: stripLeadingFrontmatter(markdown).trim(),
    relativePath: relativeToWorkspace(options.workspaceDir, sourcePath),
    tags: manifest?.tags ?? [],
    aliases: [],
    evidenceContract: manifest ? "mixed" : "none",
    sourceRefs,
    ...(manifest
      ? {
          sourceKind: manifest.sourceKind,
          sourceKey: manifest.sourceKey,
          manifest
        }
      : {}),
    diagnostics
  };

  return {
    status: manifestResult.malformed ? "malformed" : manifest?.status === "blocked" ? "blocked" : "ready",
    item,
    diagnostics
  };
}

function mapTypedPageToEvidenceItem(workspaceDir: string, page: WikiTypedPage): WikiEvidenceItem {
  return {
    kind: "page",
    key: page.metadata.key,
    title: page.metadata.title,
    body: page.body,
    relativePath: relativeToWorkspace(workspaceDir, page.path),
    tags: page.metadata.tags,
    aliases: page.metadata.aliases,
    evidenceContract: page.metadata.evidence_contract,
    sourceRefs: page.metadata.source_refs,
    ...(page.metadata.claims ? { claims: page.metadata.claims } : {}),
    ...(page.metadata.typed_relations ? { typedRelations: page.metadata.typed_relations } : {}),
    ...(page.metadata.experiment_refs ? { experimentRefs: page.metadata.experiment_refs } : {}),
    ...(page.metadata.reviewer_critique ? { reviewerCritique: page.metadata.reviewer_critique } : {}),
    diagnostics: []
  };
}

async function readPageEvidenceItem(options: ReadWikiEvidenceItemOptions): Promise<ReadWikiEvidenceItemResult> {
  let result: ReadTypedWikiPageResult;
  try {
    result = await readTypedWikiPage({
      workspaceDir: options.workspaceDir,
      key: options.key
    });
  } catch (error) {
    return {
      status: "malformed",
      diagnostics: [diagnosticForKey("page", options.key, error)]
    };
  }
  const diagnostics = diagnosticsFromTypedPage(result.diagnostics);
  if (!result.page) {
    return {
      status: pageReadStatus(result.diagnostics),
      diagnostics
    };
  }

  const item = mapTypedPageToEvidenceItem(options.workspaceDir, result.page);
  return {
    status: "ready",
    item: {
      ...item,
      diagnostics
    },
    diagnostics
  };
}

export async function readWikiEvidenceItem(options: ReadWikiEvidenceItemOptions): Promise<ReadWikiEvidenceItemResult> {
  if (options.kind === "source") {
    return readSourceEvidenceItem(options);
  }
  return readPageEvidenceItem(options);
}

function matchesAllFilters(item: WikiEvidenceItem, options: ListWikiEvidenceItemsOptions): boolean {
  if (options.keys && !options.keys.includes(item.key)) {
    return false;
  }
  if (options.tags && !options.tags.every((tag) => item.tags.includes(tag))) {
    return false;
  }
  if (options.sourceRefs && !options.sourceRefs.every((sourceRef) => item.sourceRefs.includes(sourceRef))) {
    return false;
  }
  if (options.evidenceContracts && !options.evidenceContracts.includes(item.evidenceContract)) {
    return false;
  }
  return true;
}

export async function listWikiEvidenceItems(options: ListWikiEvidenceItemsOptions): Promise<ListWikiEvidenceItemsResult> {
  const kinds = options.kinds ?? ["source", "page"];
  const items: WikiEvidenceItem[] = [];
  const diagnostics: string[] = [];

  if (kinds.includes("source")) {
    const sourceFiles = await listPaperWikiSourceFiles(options.workspaceDir);
    for (const sourceFile of sourceFiles) {
      const paperKey = paperKeyFromPaperWikiSourcePath(sourceFile);
      if (options.keys && !options.keys.includes(paperKey)) {
        continue;
      }
      const result = await readSourceEvidenceItem({
        workspaceDir: options.workspaceDir,
        kind: "source",
        key: paperKey
      });
      diagnostics.push(...result.diagnostics);
      if (result.item && matchesAllFilters(result.item, options)) {
        items.push(result.item);
      }
    }
  }

  if (kinds.includes("page")) {
    const result = await listTypedWikiPages({
      workspaceDir: options.workspaceDir,
      includeSources: false,
      includePages: true,
      tags: options.tags,
      sourceRefs: options.sourceRefs,
      evidenceContracts: options.evidenceContracts
    });
    diagnostics.push(...diagnosticsFromTypedPage(result.diagnostics));
    for (const page of result.pages) {
      const item = mapTypedPageToEvidenceItem(options.workspaceDir, page);
      if (matchesAllFilters(item, options)) {
        items.push(item);
      }
    }
  }

  return { items, diagnostics };
}
