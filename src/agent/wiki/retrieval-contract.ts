import { readFile } from "node:fs/promises";
import {
  getPaperWikiSourcePath,
  listPaperWikiSourceFiles,
  paperKeyFromPaperWikiSourcePath,
  relativeToWorkspace
} from "./store.js";
import {
  getKnowledgeSourceMetadataPath,
  readKnowledgeSourceMetadata,
  type KnowledgeSourceMetadata,
  type WikiSourceKind
} from "./source-metadata-store.js";
import {
  type WikiClaimProvenance,
  type WikiEvidenceContract,
  type WikiExperimentRef,
  type WikiKnowledgeState,
  type WikiPageType,
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
  pageType?: WikiPageType;
  knowledgeState?: WikiKnowledgeState;
  lastReviewedAt?: string;
  updatedAt?: string;
  sourceRefs: string[];
  sourceKind?: WikiSourceKind;
  sourceKey?: string;
  claims?: WikiClaimProvenance[];
  typedRelations?: WikiTypedRelation[];
  experimentRefs?: WikiExperimentRef[];
  reviewerCritique?: WikiReviewerCritiqueItem[];
  metadata?: KnowledgeSourceMetadata;
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

async function readSourceMetadataForEvidence(input: {
  workspaceDir: string;
  expectedSourceKey: string;
  expectedSummaryPath: string;
}): Promise<{
  metadata?: KnowledgeSourceMetadata;
  missing: boolean;
  malformed: boolean;
  diagnostics: string[];
}> {
  const metadataPath = getKnowledgeSourceMetadataPath(input.workspaceDir, input.expectedSourceKey);
  const relativeMetadataPath = relativeToWorkspace(input.workspaceDir, metadataPath);
  const result = await readKnowledgeSourceMetadata({
    workspaceDir: input.workspaceDir,
    sourceKey: input.expectedSourceKey,
    summaryPath: input.expectedSummaryPath
  });
  if (result.status === "ready") {
    return {
      metadata: result.metadata,
      missing: false,
      malformed: false,
      diagnostics: []
    };
  }
  if (result.status === "missing") {
    return {
      missing: true,
      malformed: false,
      diagnostics: [`${relativeMetadataPath}: missing metadata for source summary.`]
    };
  }
  return {
    missing: false,
    malformed: true,
    diagnostics: result.diagnostics.length > 0
      ? result.diagnostics.map((diagnostic) => `${relativeMetadataPath}: malformed metadata: ${diagnostic}`)
      : [`${relativeMetadataPath}: malformed metadata.`]
  };
}

async function readSourceEvidenceItem(options: ReadWikiEvidenceItemOptions): Promise<ReadWikiEvidenceItemResult> {
  let sourcePath: string;
  try {
    sourcePath = getPaperWikiSourcePath(options.workspaceDir, options.key);
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

  const metadataResult = await readSourceMetadataForEvidence({
    workspaceDir: options.workspaceDir,
    expectedSourceKey: options.key,
    expectedSummaryPath: relativeToWorkspace(options.workspaceDir, sourcePath)
  });
  const diagnostics = metadataResult.diagnostics;
  const metadata = metadataResult.metadata;

  const sourceRefs = metadata ? [metadata.sourceKey ?? options.key] : [];
  const item: WikiEvidenceItem = {
    kind: "source",
    key: metadata?.sourceKey ?? options.key,
    title: metadata?.title ?? options.key,
    body: stripLeadingFrontmatter(markdown).trim(),
    relativePath: relativeToWorkspace(options.workspaceDir, sourcePath),
    tags: metadata?.tags ?? [],
    aliases: [],
    evidenceContract: metadata ? "mixed" : "none",
    sourceRefs,
    ...(metadata
      ? {
          sourceKind: metadata.sourceKind,
          sourceKey: metadata.sourceKey ?? options.key,
          updatedAt: metadata.updatedAt,
          metadata
        }
      : {}),
    diagnostics
  };

  return {
    status: metadataResult.malformed ? "malformed" : metadata?.status === "blocked" ? "blocked" : "ready",
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
    pageType: page.metadata.type,
    ...(page.metadata.knowledge_state ? { knowledgeState: page.metadata.knowledge_state } : {}),
    ...(page.metadata.last_reviewed_at ? { lastReviewedAt: page.metadata.last_reviewed_at } : {}),
    updatedAt: page.metadata.updated_at,
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
