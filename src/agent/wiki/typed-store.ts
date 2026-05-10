import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getPaperWikiPagePath,
  listPaperWikiPageFiles,
  listPaperWikiSourceFiles,
  relativeToWorkspace
} from "./store.js";
import {
  parseWikiPageMarkdown,
  serializeWikiPageMarkdown,
  type WikiEvidenceContract,
  type WikiPageSchemaError,
  type WikiPageType,
  type WikiTypedPage
} from "./page-schema.js";

export interface WikiPageDiagnostic {
  path: string;
  relativePath: string;
  errors: WikiPageSchemaError[];
}

export interface ListTypedWikiPagesOptions {
  workspaceDir: string;
  includeSources?: boolean;
  includePages?: boolean;
  types?: WikiPageType[];
  tags?: string[];
  sourceRefs?: string[];
  evidenceContracts?: WikiEvidenceContract[];
}

export interface ListTypedWikiPagesResult {
  pages: WikiTypedPage[];
  diagnostics: WikiPageDiagnostic[];
}

export interface ReadTypedWikiPageOptions {
  workspaceDir: string;
  key: string;
}

export interface ReadTypedWikiPageResult {
  page?: WikiTypedPage;
  diagnostics: WikiPageDiagnostic[];
}

export interface WriteTypedWikiPageOptions {
  workspaceDir: string;
  page: {
    metadata: WikiTypedPage["metadata"];
    body: string;
  };
}

export interface WriteTypedWikiPageResult {
  path: string;
  relativePath: string;
}

function diagnosticFor(
  workspaceDir: string,
  filePath: string,
  errors: WikiPageSchemaError[]
): WikiPageDiagnostic {
  return {
    path: filePath,
    relativePath: relativeToWorkspace(workspaceDir, filePath),
    errors
  };
}

function storeError(
  code: WikiPageSchemaError["code"],
  message: string,
  filePath: string
): WikiPageSchemaError {
  return { code, message, path: filePath };
}

async function readTypedWikiPageFile(
  workspaceDir: string,
  filePath: string
): Promise<ReadTypedWikiPageResult> {
  let markdown: string;
  try {
    markdown = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing_frontmatter"
      : "invalid_frontmatter";
    const message = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "Wiki page file does not exist."
      : `Unable to read wiki page file: ${error instanceof Error ? error.message : String(error)}`;
    return {
      diagnostics: [
        diagnosticFor(workspaceDir, filePath, [
          storeError(code, message, filePath)
        ])
      ]
    };
  }

  const parsed = parseWikiPageMarkdown(markdown, filePath);
  if (!parsed.ok || !parsed.page) {
    return {
      diagnostics: [
        diagnosticFor(workspaceDir, filePath, parsed.errors)
      ]
    };
  }

  return {
    page: parsed.page,
    diagnostics: []
  };
}

function pageMatchesFilters(page: WikiTypedPage, options: ListTypedWikiPagesOptions): boolean {
  const metadata = page.metadata;
  if (options.types && !options.types.includes(metadata.type)) {
    return false;
  }
  if (options.evidenceContracts && !options.evidenceContracts.includes(metadata.evidence_contract)) {
    return false;
  }
  if (options.tags && !options.tags.every((tag) => metadata.tags.includes(tag))) {
    return false;
  }
  if (options.sourceRefs && !options.sourceRefs.every((sourceRef) => metadata.source_refs.includes(sourceRef))) {
    return false;
  }
  return true;
}

export async function listTypedWikiPages(options: ListTypedWikiPagesOptions): Promise<ListTypedWikiPagesResult> {
  const includeSources = options.includeSources ?? true;
  const includePages = options.includePages ?? true;
  const filePaths = [
    ...(includeSources ? await listPaperWikiSourceFiles(options.workspaceDir) : []),
    ...(includePages ? await listPaperWikiPageFiles(options.workspaceDir) : [])
  ];
  const pages: WikiTypedPage[] = [];
  const diagnostics: WikiPageDiagnostic[] = [];

  for (const filePath of filePaths) {
    const result = await readTypedWikiPageFile(options.workspaceDir, filePath);
    diagnostics.push(...result.diagnostics);
    if (result.page && pageMatchesFilters(result.page, options)) {
      pages.push(result.page);
    }
  }

  return { pages, diagnostics };
}

export async function readTypedWikiPage(options: ReadTypedWikiPageOptions): Promise<ReadTypedWikiPageResult> {
  const filePath = getPaperWikiPagePath(options.workspaceDir, options.key);
  return readTypedWikiPageFile(options.workspaceDir, filePath);
}

export async function writeTypedWikiPage(options: WriteTypedWikiPageOptions): Promise<WriteTypedWikiPageResult> {
  if (options.page.metadata.type === "paper-source") {
    throw new Error("writeTypedWikiPage cannot write paper-source pages; source summaries use the sources store.");
  }

  const filePath = getPaperWikiPagePath(options.workspaceDir, options.page.metadata.key);
  const markdown = serializeWikiPageMarkdown({
    metadata: { ...options.page.metadata },
    body: options.page.body
  });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, markdown, "utf8");

  return {
    path: filePath,
    relativePath: relativeToWorkspace(options.workspaceDir, filePath)
  };
}
