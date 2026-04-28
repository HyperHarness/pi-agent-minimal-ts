import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  getPaperBrowserProfileDir,
  resolveDefaultPaperBrowserSessionFactory,
  type PaperBrowserSession
} from "./browser-session.js";
import {
  PaperDownloadError,
  downloadPaperPdf,
  resolvePublisherCanonicalId,
  resolvePublisherCanonicalIdFromArticleUrl
} from "./paper-download.js";
import {
  downloadPaper,
  registerManualPaperDownload,
  searchPapers
} from "./paper-manager.js";
import {
  inspectPaper,
  parsePaper,
  readPaperSection,
  searchPaperText
} from "./paper-reader/paper-reader.js";
import { savePaperWebPageParse } from "./paper-reader/engines/webpage.js";
import {
  searchPaperWiki,
  writePaperWikiSource
} from "./paper-wiki/paper-wiki.js";
import {
  createPaperExtensionJob,
  type PaperExtensionBridge
} from "./paper-extension-bridge.js";
import {
  createPaperBrowserManagerClient,
  type PaperBrowserManagerClient
} from "./paper-browser-manager-client.js";
import { createPaperBrowserManagerServer, startPaperBrowserManagerHttpServer } from "./paper-browser-manager-server.js";
import { searchApsPapers } from "./aps-search.js";
import { getPublisherAdapter } from "./publisher-adapters/index.js";
import { fetchWebPage } from "./web-fetch.js";
import { fetchPaperWebPage } from "./paper-webpage-fetch.js";
import { searchWeb, type WebSearchResult } from "./web-search.js";
import type { PaperDownloadResult, PaperSearchResult, SupportedPaperSource } from "./paper-types.js";
import { buildArxivHtmlUrl } from "./arxiv.js";

const getTimeParameters = Type.Object({
  timezone: Type.Optional(Type.String({ description: "Optional IANA timezone name." }))
});

const readFileParameters = Type.Object({
  path: Type.String({ description: "Relative UTF-8 text file path inside the workspace." })
});

const webSearchParameters = Type.Object({
  query: Type.String({ description: "Search query string." }),
  maxResults: Type.Optional(
    Type.Integer({ description: "Maximum number of results to return.", minimum: 1 })
  )
});

const fetchUrlParameters = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." })
});

const fetchPaperWebpageParameters = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS scientific paper article page URL to fetch." }),
  paperKey: Type.Optional(
    Type.String({
      description:
        "Optional paper key to use under knowledge-base/wiki/sources/. Defaults to a publisher-derived key such as nature-s41467-025-59778-z."
    })
  ),
  save: Type.Optional(
    Type.Boolean({
      description:
        "Whether to save the extracted webpage parse under knowledge-base/wiki/sources/. Defaults to true."
    })
  ),
  force: Type.Optional(Type.Boolean({ description: "Re-fetch and overwrite the cached webpage parse." })),
  useExtensionFallback: Type.Optional(
    Type.Boolean({
      description:
        "Queue a browser-extension webpage snapshot job when direct HTML fetch is blocked. Defaults to true."
    })
  )
});

const searchPapersParameters = Type.Object({
  query: Type.String({ description: "Search query string for papers." }),
  maxResults: Type.Optional(
    Type.Integer({ description: "Maximum number of results to return.", minimum: 1 })
  )
});

const downloadPaperParameters = Type.Object({
  id: Type.Optional(Type.String({ description: "Paper identifier to download." })),
  url: Type.Optional(Type.String({ description: "Paper URL to download." })),
  title: Type.Optional(
    Type.String({
      description:
        "Paper title for arXiv preprint fallback when a publisher URL cannot be downloaded."
    })
  )
});

const registerManualPaperDownloadParameters = Type.Object({
  url: Type.String({ description: "External article URL that was opened for manual download." }),
  path: Type.String({
    description: "Relative path inside the workspace to the manually downloaded PDF file."
  }),
  title: Type.Optional(Type.String({ description: "Optional paper title to save in the index." }))
});

const openPaperPageForLoginParameters = Type.Object({
  url: Type.String({ description: "Publisher article URL to open for manual login review." })
});

const parsePaperParameters = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Workspace-relative or absolute PDF path under knowledge-base/raw/pdfs/." })
  ),
  recordPath: Type.Optional(
    Type.String({ description: "Workspace-relative or workspace-absolute paper record JSON path." })
  ),
  engine: Type.Optional(
    Type.Union([
      Type.Literal("auto"),
      Type.Literal("opendataloader-local"),
      Type.Literal("opendataloader-hybrid"),
      Type.Literal("docling"),
      Type.Literal("plain-text-baseline")
    ], { description: "Parser engine to use. Defaults to auto." })
  ),
  force: Type.Optional(Type.Boolean({ description: "Re-parse even when a matching cached parse exists." }))
});

const inspectPaperParameters = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Workspace-relative or absolute PDF path under knowledge-base/raw/pdfs/." })
  ),
  recordPath: Type.Optional(
    Type.String({ description: "Workspace-relative or workspace-absolute paper record JSON path." })
  ),
  paperKey: Type.Optional(Type.String({ description: "Parsed paper key, for example arxiv-2406.06015." }))
});

const paperReaderEngineParameter = Type.Optional(
  Type.Union([
    Type.Literal("opendataloader-local"),
    Type.Literal("opendataloader-hybrid"),
    Type.Literal("docling"),
    Type.Literal("plain-text-baseline"),
    Type.Literal("webpage")
  ], { description: "Parsed engine to read from. Defaults to the best available parse." })
);

const readPaperSectionParameters = Type.Object({
  paperKey: Type.String({ description: "Parsed paper key, for example arxiv-2406.06015." }),
  engine: paperReaderEngineParameter,
  sectionId: Type.Optional(Type.String({ description: "Optional section id from inspect_paper." })),
  pageFrom: Type.Optional(Type.Integer({ description: "Optional first page number.", minimum: 1 })),
  pageTo: Type.Optional(Type.Integer({ description: "Optional last page number.", minimum: 1 })),
  maxChars: Type.Optional(Type.Integer({ description: "Maximum characters to return.", minimum: 1 }))
});

const searchPaperTextParameters = Type.Object({
  paperKey: Type.String({ description: "Parsed paper key, for example arxiv-2406.06015." }),
  engine: paperReaderEngineParameter,
  query: Type.String({ description: "Text query to search inside the parsed paper." }),
  maxResults: Type.Optional(Type.Integer({ description: "Maximum matching elements to return.", minimum: 1 }))
});

const writePaperWikiSourceParameters = Type.Object({
  paperKey: Type.String({ description: "Parsed paper key, for example arxiv-2406.06015." }),
  engine: paperReaderEngineParameter,
  title: Type.Optional(Type.String({ description: "Optional display title for the source summary." })),
  summaryMarkdown: Type.String({
    description:
      "LLM-authored grounded markdown summary to save as the retrieval source for this paper."
  }),
  tags: Type.Optional(Type.Array(Type.String({ description: "Short searchable tag." }))),
  keyFindings: Type.Optional(Type.Array(Type.String({ description: "One key grounded finding." }))),
  limitations: Type.Optional(Type.Array(Type.String({ description: "One limitation or caveat." }))),
  openQuestions: Type.Optional(Type.Array(Type.String({ description: "One follow-up question." }))),
  relatedPaperKeys: Type.Optional(Type.Array(Type.String({ description: "Related parsed paper key." })))
});

const searchPaperWikiParameters = Type.Object({
  query: Type.String({ description: "Text query to search inside LLM-authored paper source summaries." }),
  maxResults: Type.Optional(Type.Integer({ description: "Maximum matching source summaries to return.", minimum: 1 }))
});

type GetTimeParameters = Static<typeof getTimeParameters>;
type ReadFileParameters = Static<typeof readFileParameters>;
type WebSearchParameters = Static<typeof webSearchParameters>;
type FetchUrlParameters = Static<typeof fetchUrlParameters>;
type FetchPaperWebpageParameters = Static<typeof fetchPaperWebpageParameters>;
type SearchPapersParameters = Static<typeof searchPapersParameters>;
type DownloadPaperParameters = Static<typeof downloadPaperParameters>;
type RegisterManualPaperDownloadParameters = Static<typeof registerManualPaperDownloadParameters>;
type OpenPaperPageForLoginParameters = Static<typeof openPaperPageForLoginParameters>;
type ParsePaperParameters = Static<typeof parsePaperParameters>;
type InspectPaperParameters = Static<typeof inspectPaperParameters>;
type ReadPaperSectionParameters = Static<typeof readPaperSectionParameters>;
type SearchPaperTextParameters = Static<typeof searchPaperTextParameters>;
type WritePaperWikiSourceParameters = Static<typeof writePaperWikiSourceParameters>;
type SearchPaperWikiParameters = Static<typeof searchPaperWikiParameters>;

function assertPathInsideDirectory(rootDir: string, candidatePath: string): void {
  const relativePath = path.relative(rootDir, candidatePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Requested path is outside the workspace.");
  }
}

async function resolveWorkspacePath(workspaceDir: string, requestedPath: string): Promise<string> {
  if (!requestedPath.trim()) {
    throw new Error("Path is required.");
  }

  if (path.isAbsolute(requestedPath)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedPath = path.resolve(resolvedWorkspaceDir, requestedPath);
  assertPathInsideDirectory(resolvedWorkspaceDir, resolvedPath);

  const [realWorkspaceDir, realResolvedPath] = await Promise.all([
    realpath(resolvedWorkspaceDir),
    realpath(resolvedPath)
  ]);
  assertPathInsideDirectory(realWorkspaceDir, realResolvedPath);

  return realResolvedPath;
}

type GetTimeTool = AgentTool<typeof getTimeParameters, { timezone: string }>;
type ReadFileTool = AgentTool<typeof readFileParameters, { path: string }>;
type SearchResultPreview = {
  title: string;
  url?: string;
  summary?: string;
  source?: string;
  action?: string;
  canonicalId?: string;
};
type SearchToolDetails = {
  query: string;
  maxResults: number;
  count: number;
  results: SearchResultPreview[];
};
type WebSearchTool = AgentTool<
  typeof webSearchParameters,
  SearchToolDetails
>;
type FetchUrlTool = AgentTool<typeof fetchUrlParameters, { url: string }>;
type FetchPaperWebpageDetails =
  | (Awaited<ReturnType<typeof fetchPaperWebPage>> & {
      savedParse?: Awaited<ReturnType<typeof savePaperWebPageParse>>;
    })
  | (Awaited<ReturnType<PaperExtensionBridge["submitJob"]>> & {
      purpose: "webpage";
      directFetchError: string;
    });
type FetchPaperWebpageTool = AgentTool<
  typeof fetchPaperWebpageParameters,
  FetchPaperWebpageDetails
>;
type SearchPapersTool = AgentTool<
  typeof searchPapersParameters,
  SearchToolDetails
>;
type DownloadPaperReadingClosure =
  | {
      status: "parsed" | "already_parsed";
      strategy: "pdf" | "webpage";
      paperKey: string;
      engine: Awaited<ReturnType<typeof parsePaper>>["engine"];
      markdownPath: string;
      parsePath: string;
      qualityPath: string;
      chunksPath: string;
      quality: Awaited<ReturnType<typeof parsePaper>>["quality"];
    }
  | {
      status: "queued";
      strategy: "webpage" | "pdf";
      jobId?: string;
      message: string;
    }
  | {
      status: "failed";
      strategy: "webpage" | "pdf";
      message: string;
    };
type DownloadPaperClosedLoopDetails = PaperDownloadResult & {
  reading?: DownloadPaperReadingClosure;
};
type DownloadPaperTool = AgentTool<
  typeof downloadPaperParameters,
  DownloadPaperClosedLoopDetails
>;
type RegisterManualPaperDownloadTool = AgentTool<
  typeof registerManualPaperDownloadParameters,
  Awaited<ReturnType<typeof registerManualPaperDownload>> & {
    reading?: DownloadPaperReadingClosure;
  }
>;
type OpenPaperPageForLoginResult = {
  url?: string;
  openedUrl: string;
  profileDir?: string;
  executablePath?: string;
};
type OpenPaperPageForLoginDependency = (options: {
  workspaceDir: string;
  url: string;
}) => Promise<OpenPaperPageForLoginResult>;
type WritePaperWikiSourceTool = AgentTool<
  typeof writePaperWikiSourceParameters,
  Awaited<ReturnType<typeof writePaperWikiSource>>
>;
type SearchPaperWikiTool = AgentTool<
  typeof searchPaperWikiParameters,
  Awaited<ReturnType<typeof searchPaperWiki>>
>;

const MAX_SEARCH_RESULT_PREVIEWS = 5;
const MAX_SEARCH_PREVIEW_TEXT_LENGTH = 220;

function compactPreviewText(value: string | undefined, maxLength = MAX_SEARCH_PREVIEW_TEXT_LENGTH): string | undefined {
  const compacted = value?.replace(/\s+/g, " ").trim();
  if (!compacted) {
    return undefined;
  }

  return compacted.length > maxLength
    ? `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`
    : compacted;
}

function summarizeWebSearchResults(results: WebSearchResult[]): SearchResultPreview[] {
  return results.slice(0, MAX_SEARCH_RESULT_PREVIEWS).map((result) => ({
    title: compactPreviewText(result.title, 120) ?? "(untitled)",
    url: result.url,
    summary: compactPreviewText(result.snippet)
  }));
}

function summarizePaperSearchResults(results: PaperSearchResult[]): SearchResultPreview[] {
  return results.slice(0, MAX_SEARCH_RESULT_PREVIEWS).map((result) => {
    const primarySource = result.sources[0];
    return {
      title: compactPreviewText(result.title, 120) ?? "(untitled)",
      ...(primarySource?.articleUrl ? { url: primarySource.articleUrl } : {}),
      summary: compactPreviewText(result.summary),
      source: result.primarySource,
      action: result.primaryAction,
      ...(primarySource?.canonicalId ? { canonicalId: primarySource.canonicalId } : {})
    };
  });
}

function summarizeParseResult(
  result: Awaited<ReturnType<typeof parsePaper>>,
  strategy: "pdf" | "webpage"
): DownloadPaperReadingClosure {
  return {
    status: result.status,
    strategy,
    paperKey: result.paperKey,
    engine: result.engine,
    markdownPath: result.artifacts.markdownPath,
    parsePath: result.artifacts.parsePath,
    qualityPath: result.artifacts.qualityPath,
    chunksPath: result.artifacts.chunksPath,
    quality: result.quality
  };
}

function isWebpageFirstPublisher(source: string): source is SupportedPaperSource {
  return source === "aps" || source === "nature" || source === "science";
}

function formatReadingError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
type OpenPaperPageForLoginTool = AgentTool<
  typeof openPaperPageForLoginParameters,
  OpenPaperPageForLoginResult
>;
type ParsePaperTool = AgentTool<
  typeof parsePaperParameters,
  Awaited<ReturnType<typeof parsePaper>>
>;
type InspectPaperTool = AgentTool<
  typeof inspectPaperParameters,
  Awaited<ReturnType<typeof inspectPaper>>
>;
type ReadPaperSectionTool = AgentTool<
  typeof readPaperSectionParameters,
  Awaited<ReturnType<typeof readPaperSection>>
>;
type SearchPaperTextTool = AgentTool<
  typeof searchPaperTextParameters,
  Awaited<ReturnType<typeof searchPaperText>>
>;

function assertSupportedPaperPublisherUrl(input: string): void {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Paper publisher URLs must use http or https.");
  }

  getPublisherAdapter(url.toString());
}

function resolveExtensionPaperSource(input: string): SupportedPaperSource | "external" {
  try {
    return getPublisherAdapter(input).id;
  } catch {
    return "external";
  }
}

const PAPER_DOWNLOAD_ERROR_CODES = new Set<PaperDownloadError["code"]>([
  "unsupported_publisher",
  "browser_session_unavailable",
  "manual_login_required",
  "authorization_failed",
  "pdf_not_found",
  "download_failed"
]);

function normalizePaperDownloadError(error: unknown): unknown {
  if (error instanceof PaperDownloadError) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    PAPER_DOWNLOAD_ERROR_CODES.has(error.code as PaperDownloadError["code"])
  ) {
    const message =
      error instanceof Error ? error.message : `Paper download failed with code ${error.code}.`;
    return new PaperDownloadError(error.code as PaperDownloadError["code"], message);
  }

  return error;
}

async function assertDownloadedFileIsPdf(pdfPath: string): Promise<void> {
  const fileBytes = await readFile(pdfPath);
  if (!fileBytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new PaperDownloadError("download_failed", "Downloaded file is not a valid PDF.");
  }
}

export interface ToolDependencies {
  searchWeb?: typeof searchWeb;
  fetchWebPage?: typeof fetchWebPage;
  fetchPaperWebPage?: typeof fetchPaperWebPage;
  savePaperWebPageParse?: typeof savePaperWebPageParse;
  searchPapers?: typeof searchPapers;
  searchApsPapers?: typeof searchApsPapers;
  downloadPaper?: typeof downloadPaper;
  registerManualPaperDownload?: typeof registerManualPaperDownload;
  parsePaper?: typeof parsePaper;
  inspectPaper?: typeof inspectPaper;
  readPaperSection?: typeof readPaperSection;
  searchPaperText?: typeof searchPaperText;
  writePaperWikiSource?: typeof writePaperWikiSource;
  searchPaperWiki?: typeof searchPaperWiki;
  openPaperPageForLogin?: OpenPaperPageForLoginDependency;
  browserSessionFactory?: ReturnType<typeof resolveDefaultPaperBrowserSessionFactory>;
  paperBrowserManagerClient?: PaperBrowserManagerClient;
  extensionBridge?: PaperExtensionBridge;
  usePlaywrightPaperFallback?: boolean;
}

interface ToolSetMetadata {
  cleanup: () => Promise<void>;
  workspaceDir: string;
}

export type AgentTools = [
  GetTimeTool,
  ReadFileTool,
  WebSearchTool,
  FetchUrlTool,
  FetchPaperWebpageTool,
  SearchPapersTool,
  DownloadPaperTool,
  RegisterManualPaperDownloadTool,
  OpenPaperPageForLoginTool,
  ParsePaperTool,
  InspectPaperTool,
  ReadPaperSectionTool,
  SearchPaperTextTool,
  WritePaperWikiSourceTool,
  SearchPaperWikiTool
] & ToolSetMetadata;

export async function cleanupTools(tools: ReadonlyArray<AgentTool<any>> | undefined): Promise<void> {
  const cleanup = (tools as Partial<ToolSetMetadata> | undefined)?.cleanup;
  if (typeof cleanup === "function") {
    await cleanup();
  }
}

export function getToolsWorkspaceDir(
  tools: ReadonlyArray<AgentTool<any>> | undefined
): string | undefined {
  const workspaceDir = (tools as Partial<ToolSetMetadata> | undefined)?.workspaceDir;
  return typeof workspaceDir === "string" ? workspaceDir : undefined;
}

export function createTools(workspaceDir: string, dependencies: ToolDependencies = {}): AgentTools {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const searchWebImpl = dependencies.searchWeb ?? searchWeb;
  const fetchWebPageImpl = dependencies.fetchWebPage ?? fetchWebPage;
  const fetchPaperWebPageImpl = dependencies.fetchPaperWebPage ?? fetchPaperWebPage;
  const savePaperWebPageParseImpl = dependencies.savePaperWebPageParse ?? savePaperWebPageParse;
  const searchApsPapersImpl = dependencies.searchApsPapers ?? searchApsPapers;
  const searchPapersImpl =
    dependencies.searchPapers ??
    ((options: Parameters<typeof searchPapers>[0]) =>
      searchPapers({
        ...options,
        searchApsPapersImpl
      }));
  const writePaperWikiSourceImpl = dependencies.writePaperWikiSource ?? writePaperWikiSource;
  const searchPaperWikiImpl = dependencies.searchPaperWiki ?? searchPaperWiki;
  const browserSessionFactoryImpl =
    dependencies.browserSessionFactory ??
    resolveDefaultPaperBrowserSessionFactory({ workspaceDir: resolvedWorkspaceDir });
  let browserSessionPromise: Promise<PaperBrowserSession> | undefined;
  let paperManagerServerClose: (() => Promise<void>) | undefined;

  const getBrowserSession = async (): Promise<PaperBrowserSession> => {
    if (browserSessionPromise === undefined) {
      const sessionPromise = browserSessionFactoryImpl().catch((error: unknown) => {
        if (browserSessionPromise === sessionPromise) {
          browserSessionPromise = undefined;
        }

        throw error;
      });
      browserSessionPromise = sessionPromise;
    }

    return browserSessionPromise;
  };

  const disposeBrowserSession = async (): Promise<void> => {
    if (browserSessionPromise === undefined) {
      return;
    }

    const cachedBrowserSessionPromise = browserSessionPromise;
    browserSessionPromise = undefined;

    let browserSession: PaperBrowserSession;
    try {
      browserSession = await cachedBrowserSessionPromise;
    } catch {
      return;
    }

    await browserSession.dispose?.();
  };

  const isBrowserSessionAlive = async (browserSession: PaperBrowserSession): Promise<boolean> => {
    if (browserSession.isAlive === undefined) {
      return true;
    }

    try {
      return await browserSession.isAlive();
    } catch {
      return false;
    }
  };

  const ensureLiveBrowserSession = async (): Promise<PaperBrowserSession> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const browserSession = await getBrowserSession();
      if (await isBrowserSessionAlive(browserSession)) {
        return browserSession;
      }

      await disposeBrowserSession();
    }

    throw new Error("Paper browser session is unavailable.");
  };

  const spawnPaperManager = async () => {
    const manager = createPaperBrowserManagerServer({
      workspaceDir: resolvedWorkspaceDir,
      browserController: {
        async ensureBrowser(): Promise<void> {
          await ensureLiveBrowserSession();
        },
        async health() {
          const browserSession = await getBrowserSession();
          return {
            browserConnected: await isBrowserSessionAlive(browserSession),
            profileDir: getPaperBrowserProfileDir(resolvedWorkspaceDir)
          };
        },
        async openArticle(request) {
          const browserSession = await getBrowserSession();
          const response = await browserSession.openPageForManualLogin(request.url);
          return {
            openedUrl: response.openedUrl
          };
        },
        async downloadPaperPdf(request) {
          const browserSession = await getBrowserSession();
          const result = await downloadPaperPdf({
            workspaceDir: request.workspaceDir,
            url: request.url,
            browserSession
          });
          return {
            status: "downloaded",
            ...result
          };
        },
        async close() {
          await disposeBrowserSession();
        }
      }
    });
    const server = await startPaperBrowserManagerHttpServer({
      workspaceDir: resolvedWorkspaceDir,
      manager
    });
    paperManagerServerClose = server.close;
    return {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      endpoint: server.endpoint,
      profileDir: getPaperBrowserProfileDir(resolvedWorkspaceDir)
    };
  };

  const paperBrowserManagerClient =
    dependencies.paperBrowserManagerClient ??
    createPaperBrowserManagerClient({
      workspaceDir: resolvedWorkspaceDir,
      spawnManager: spawnPaperManager,
      disposeManager: async () => {
        if (paperManagerServerClose === undefined) {
          return;
        }

        const close = paperManagerServerClose;
        paperManagerServerClose = undefined;
        await close();
      }
    });

  const downloadPaperImpl =
    dependencies.downloadPaper ??
    ((options: Parameters<typeof downloadPaper>[0]) =>
      downloadPaper({
        ...options,
        extensionBridge: dependencies.extensionBridge,
        usePlaywrightFallback: dependencies.usePlaywrightPaperFallback === true,
        downloadPublisherPaperImpl: async (downloadOptions) => {
          let result;
          try {
            result = await paperBrowserManagerClient.downloadPaperPdf(downloadOptions);
          } catch (error) {
            throw normalizePaperDownloadError(error);
          }

          await assertDownloadedFileIsPdf(result.path);
          const canonicalId =
            resolvePublisherCanonicalIdFromArticleUrl({
              publisher: result.publisher,
              articleUrl: result.finalArticleUrl
            }) ??
            resolvePublisherCanonicalId({
              publisher: result.publisher,
              url: result.finalPdfUrl
            }) ??
            resolvePublisherCanonicalId({
              publisher: result.publisher,
              url: result.articleUrl
            });

          if (!canonicalId) {
            throw new PaperDownloadError(
              "download_failed",
              "Unable to resolve a canonical paper identifier from the publisher article URL."
            );
          }

          return {
            ...result,
            canonicalId
          };
        },
        openPublisherForLoginImpl: async (openOptions) =>
          paperBrowserManagerClient.openArticle({ url: openOptions.url })
      }));
  const registerManualPaperDownloadImpl =
    dependencies.registerManualPaperDownload ?? registerManualPaperDownload;
  const parsePaperImpl = dependencies.parsePaper ?? parsePaper;
  const inspectPaperImpl = dependencies.inspectPaper ?? inspectPaper;
  const readPaperSectionImpl = dependencies.readPaperSection ?? readPaperSection;
  const searchPaperTextImpl = dependencies.searchPaperText ?? searchPaperText;

  const openPaperPageForLoginImpl =
    dependencies.openPaperPageForLogin ??
    (async (options: { workspaceDir: string; url: string }) =>
      paperBrowserManagerClient.openArticle({ url: options.url }));

  const parseDownloadedPdfForReading = async (
    recordPath: string
  ): Promise<DownloadPaperReadingClosure> => {
    try {
      return summarizeParseResult(
        await parsePaperImpl({
          workspaceDir: resolvedWorkspaceDir,
          recordPath
        }),
        "pdf"
      );
    } catch (error) {
      return {
        status: "failed",
        strategy: "pdf",
        message: formatReadingError(error, "Downloaded PDF could not be parsed into markdown.")
      };
    }
  };

  const parseArxivWebpageForReading = async (
    canonicalId: string
  ): Promise<DownloadPaperReadingClosure | undefined> => {
    try {
      const extraction = await fetchPaperWebPageImpl({
        url: buildArxivHtmlUrl(canonicalId)
      });
      return summarizeParseResult(
        await savePaperWebPageParseImpl({
          workspaceDir: resolvedWorkspaceDir,
          extraction,
          paperKey: `arxiv-${canonicalId}`
        }),
        "webpage"
      );
    } catch {
      return undefined;
    }
  };

  const describeDownloadReadingClosure = async (
    result: PaperDownloadResult
  ): Promise<DownloadPaperReadingClosure | undefined> => {
    if (result.status === "downloaded" || result.status === "already_downloaded") {
      if (result.source === "arxiv") {
        return (
          await parseArxivWebpageForReading(result.canonicalId)
        ) ?? parseDownloadedPdfForReading(result.recordPath);
      }

      if (result.source === "external") {
        return parseDownloadedPdfForReading(result.recordPath);
      }

      if (isWebpageFirstPublisher(result.source)) {
        if (dependencies.extensionBridge === undefined) {
          return {
            status: "failed",
            strategy: "webpage",
            message:
              "Publisher papers are read from webpage markdown first, but no browser extension bridge is configured to capture the article page."
          };
        }

        try {
          const queued = await dependencies.extensionBridge.submitJob(
            createPaperExtensionJob({
              articleUrl: result.articleUrl,
              source: result.source,
              purpose: "webpage",
              autoClose: true
            })
          );
          return {
            status: "queued",
            strategy: "webpage",
            jobId: queued.jobId,
            message:
              "Publisher PDF is downloaded. Browser extension webpage capture was queued so the reading source markdown can be generated."
          };
        } catch (error) {
          return {
            status: "failed",
            strategy: "webpage",
            message: formatReadingError(error, "Publisher webpage markdown capture could not be queued.")
          };
        }
      }
    }

    if (result.status === "extension_job_queued" && isWebpageFirstPublisher(result.source)) {
      return {
        status: "queued",
        strategy: "webpage",
        jobId: result.jobId,
        message:
          "Browser extension will capture the publisher webpage markdown and download the PDF. The download is complete only after markdown artifacts are saved."
      };
    }

    return undefined;
  };

  let cleanupPromise: Promise<void> | undefined;
  const closePaperManager = async (): Promise<void> => {
    cleanupPromise ??= paperBrowserManagerClient.close();
    await cleanupPromise;
  };

  const shouldDescribeDownloadReadingClosure =
    dependencies.downloadPaper === undefined ||
    dependencies.fetchPaperWebPage !== undefined ||
    dependencies.savePaperWebPageParse !== undefined ||
    dependencies.parsePaper !== undefined;

  const getTimeTool: GetTimeTool = {
    name: "get_time",
    label: "Get Time",
    description: "Returns the current time, optionally formatted for a specific timezone.",
    parameters: getTimeParameters,
    execute: async (_toolCallId: string, args: GetTimeParameters) => {
      const timezone = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const formatter = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: args.timezone
      });

      return {
        content: [{ type: "text", text: formatter.format(new Date()) }],
        details: { timezone }
      };
    }
  };

  const readFileTool: ReadFileTool = {
    name: "read_file",
    label: "Read File",
    description: "Reads a UTF-8 text file from inside the workspace.",
    parameters: readFileParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: ReadFileParameters) => {
      const resolvedPath = await resolveWorkspacePath(resolvedWorkspaceDir, args.path);
      const content = await readFile(resolvedPath, "utf8");

      return {
        content: [{ type: "text", text: content }],
        details: { path: args.path }
      };
    }
  };

  const webSearchTool: WebSearchTool = {
    name: "web_search",
    label: "Web Search",
    description: "Searches the web and returns structured result summaries.",
    parameters: webSearchParameters,
    execute: async (_toolCallId: string, args: WebSearchParameters) => {
      const results = await searchWebImpl({ query: args.query, maxResults: args.maxResults });
      const maxResults = args.maxResults ?? 5;

      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
        details: {
          query: args.query,
          maxResults,
          count: results.length,
          results: summarizeWebSearchResults(results)
        }
      };
    }
  };

  const fetchUrlTool: FetchUrlTool = {
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetches a web page and returns its extracted text.",
    parameters: fetchUrlParameters,
    execute: async (_toolCallId: string, args: FetchUrlParameters) => {
      const text = await fetchWebPageImpl({ url: args.url });

      return {
        content: [{ type: "text", text: JSON.stringify(text) }],
        details: { url: args.url }
      };
    }
  };

  const fetchPaperWebpageTool: FetchPaperWebpageTool = {
    name: "fetch_paper_webpage",
    label: "Fetch Paper Webpage",
    description:
      "Fetches a scientific paper article page and returns untruncated article markdown with navigation, header, footer, sharing, advertising, and recommendation noise removed. Prefer this over fetch_url when reading a publisher article webpage.",
    parameters: fetchPaperWebpageParameters,
    execute: async (_toolCallId: string, args: FetchPaperWebpageParameters) => {
      try {
        const result = await fetchPaperWebPageImpl({ url: args.url });
        const savedParse = args.save === false
          ? undefined
          : await savePaperWebPageParseImpl({
            workspaceDir: resolvedWorkspaceDir,
            extraction: result,
            ...(args.paperKey ? { paperKey: args.paperKey } : {}),
            ...(args.force !== undefined ? { force: args.force } : {})
          });
        const output = {
          ...result,
          ...(savedParse ? { savedParse } : {})
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          details: output
        };
      } catch (error) {
        if (args.useExtensionFallback === false || dependencies.extensionBridge === undefined) {
          throw error;
        }

        const source = resolveExtensionPaperSource(args.url);
        const queued = await dependencies.extensionBridge.submitJob(
          createPaperExtensionJob({
            articleUrl: args.url,
            source,
            purpose: "webpage",
            autoClose: true
          })
        );
        const output = {
          ...queued,
          purpose: "webpage" as const,
          directFetchError: error instanceof Error ? error.message : "Direct paper webpage fetch failed."
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          details: output
        };
      }
    }
  };

  const searchPapersTool: SearchPapersTool = {
    name: "search_papers",
    label: "Search Papers",
    description:
      "Searches papers across arXiv, APS/Physical Review metadata, and web results, then returns unified result summaries. Use download_paper with a returned id or URL to download one selected paper.",
    parameters: searchPapersParameters,
    execute: async (_toolCallId: string, args: SearchPapersParameters) => {
      const results = await searchPapersImpl({ query: args.query, maxResults: args.maxResults });
      const maxResults = args.maxResults ?? 5;

      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
        details: {
          query: args.query,
          maxResults,
          count: results.length,
          results: summarizePaperSearchResults(results)
        }
      };
    }
  };

  const downloadPaperTool: DownloadPaperTool = {
    name: "download_paper",
    label: "Download Paper",
    description:
      "Downloads a paper by id or URL through the unified paper manager and closes the reading loop by generating or queuing markdown artifacts. APS, Nature, and Science use browser-extension webpage capture first; arXiv and other PDFs are parsed after download. When downloading a publisher URL from search_papers, pass the returned title so the manager can try an exact-title arXiv preprint fallback if the publisher download fails.",
    parameters: downloadPaperParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: DownloadPaperParameters) => {
      const rawResult = await downloadPaperImpl({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.id ? { id: args.id } : {}),
        ...(args.url ? { url: args.url } : {}),
        ...(args.title ? { title: args.title } : {})
      });
      const reading = shouldDescribeDownloadReadingClosure
        ? await describeDownloadReadingClosure(rawResult)
        : undefined;
      const result: DownloadPaperClosedLoopDetails = {
        ...rawResult,
        ...(reading ? { reading } : {})
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const registerManualPaperDownloadTool: RegisterManualPaperDownloadTool = {
    name: "register_manual_paper_download",
    label: "Register Manual Paper Download",
    description:
      "Registers a manually downloaded external PDF into the local paper index so future downloads for the same URL are skipped.",
    parameters: registerManualPaperDownloadParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: RegisterManualPaperDownloadParameters) => {
      const resolvedPdfPath = await resolveWorkspacePath(resolvedWorkspaceDir, args.path);
      const result = await registerManualPaperDownloadImpl({
        workspaceDir: resolvedWorkspaceDir,
        url: args.url,
        pdfPath: resolvedPdfPath,
        ...(args.title ? { title: args.title } : {})
      });
      const reading = dependencies.registerManualPaperDownload === undefined
        ? await parseDownloadedPdfForReading(result.recordPath)
        : undefined;
      const output = {
        ...result,
        ...(reading ? { reading } : {})
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        details: output
      };
    }
  };

  const openPaperPageForLoginTool: OpenPaperPageForLoginTool = {
    name: "open_paper_page_for_login",
    label: "Open Paper Page For Login",
    description:
      "Opens the paper article in the managed browser session for manual login review without downloading anything.",
    parameters: openPaperPageForLoginParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: OpenPaperPageForLoginParameters) => {
      assertSupportedPaperPublisherUrl(args.url);
      const result = await openPaperPageForLoginImpl({
        workspaceDir: resolvedWorkspaceDir,
        url: args.url
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const parsePaperTool: ParsePaperTool = {
    name: "parse_paper",
    label: "Parse Paper",
    description:
      "Parses a downloaded PDF from knowledge-base/raw/pdfs/ into structured reading artifacts. Use a path or recordPath returned by download_paper. The default auto engine starts with OpenDataLoader, falls back to Docling when advanced parsing fails, then uses the plain text baseline as the final fallback.",
    parameters: parsePaperParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: ParsePaperParameters) => {
      const result = await parsePaperImpl({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.path ? { path: args.path } : {}),
        ...(args.recordPath ? { recordPath: args.recordPath } : {}),
        ...(args.engine ? { engine: args.engine } : {}),
        ...(args.force !== undefined ? { force: args.force } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const inspectPaperTool: InspectPaperTool = {
    name: "inspect_paper",
    label: "Inspect Paper",
    description:
      "Inspects parsed paper artifacts, including available parser engines, parse quality, and section previews. It does not return the full paper body.",
    parameters: inspectPaperParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: InspectPaperParameters) => {
      const result = await inspectPaperImpl({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.path ? { path: args.path } : {}),
        ...(args.recordPath ? { recordPath: args.recordPath } : {}),
        ...(args.paperKey ? { paperKey: args.paperKey } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const readPaperSectionTool: ReadPaperSectionTool = {
    name: "read_paper_section",
    label: "Read Paper Section",
    description:
      "Reads bounded text from a parsed paper by section id and/or page range, with source element metadata.",
    parameters: readPaperSectionParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: ReadPaperSectionParameters) => {
      const result = await readPaperSectionImpl({
        workspaceDir: resolvedWorkspaceDir,
        paperKey: args.paperKey,
        ...(args.engine ? { engine: args.engine } : {}),
        ...(args.sectionId ? { sectionId: args.sectionId } : {}),
        ...(args.pageFrom !== undefined ? { pageFrom: args.pageFrom } : {}),
        ...(args.pageTo !== undefined ? { pageTo: args.pageTo } : {}),
        ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const searchPaperTextTool: SearchPaperTextTool = {
    name: "search_paper_text",
    label: "Search Paper Text",
    description:
      "Searches inside a parsed paper and returns snippets with page, section, and element metadata.",
    parameters: searchPaperTextParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: SearchPaperTextParameters) => {
      const result = await searchPaperTextImpl({
        workspaceDir: resolvedWorkspaceDir,
        paperKey: args.paperKey,
        ...(args.engine ? { engine: args.engine } : {}),
        query: args.query,
        ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const writePaperWikiSourceTool: WritePaperWikiSourceTool = {
    name: "write_paper_wiki_source",
    label: "Write Paper Wiki Source",
    description:
      "Saves an LLM-authored, provenance-tracked paper summary into knowledge-base/wiki/sources/ for later knowledge retrieval. Use after parse_paper and grounded reading.",
    parameters: writePaperWikiSourceParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: WritePaperWikiSourceParameters) => {
      const result = await writePaperWikiSourceImpl({
        workspaceDir: resolvedWorkspaceDir,
        paperKey: args.paperKey,
        summaryMarkdown: args.summaryMarkdown,
        ...(args.engine ? { engine: args.engine } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
        ...(args.keyFindings ? { keyFindings: args.keyFindings } : {}),
        ...(args.limitations ? { limitations: args.limitations } : {}),
        ...(args.openQuestions ? { openQuestions: args.openQuestions } : {}),
        ...(args.relatedPaperKeys ? { relatedPaperKeys: args.relatedPaperKeys } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const searchPaperWikiTool: SearchPaperWikiTool = {
    name: "search_paper_wiki",
    label: "Search Paper Wiki",
    description:
      "Searches LLM-authored paper source summaries under knowledge-base/wiki/sources/. Use this for knowledge retrieval after paper summaries have been written.",
    parameters: searchPaperWikiParameters,
    execute: async (_toolCallId: string, args: SearchPaperWikiParameters) => {
      const result = await searchPaperWikiImpl({
        workspaceDir: resolvedWorkspaceDir,
        query: args.query,
        ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const tools = [
    getTimeTool,
    readFileTool,
    webSearchTool,
    fetchUrlTool,
    fetchPaperWebpageTool,
    searchPapersTool,
    downloadPaperTool,
    registerManualPaperDownloadTool,
    openPaperPageForLoginTool,
    parsePaperTool,
    inspectPaperTool,
    readPaperSectionTool,
    searchPaperTextTool,
    writePaperWikiSourceTool,
    searchPaperWikiTool
  ] as unknown as AgentTools;

  Object.defineProperties(tools, {
    cleanup: {
      enumerable: false,
      value: async () => {
        await closePaperManager();
      }
    },
    workspaceDir: {
      enumerable: false,
      value: resolvedWorkspaceDir
    }
  });

  return tools;
}
