import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDependencies } from "../tool-types.js";
import { resolveWorkspacePath } from "../file-tools.js";
import {
  getPaperBrowserProfileDir,
  resolveDefaultPaperBrowserSessionFactory,
  type PaperBrowserSession
} from "./browser/browser-session.js";
import {
  PaperDownloadError,
  downloadPaperPdf,
  resolvePublisherCanonicalId,
  resolvePublisherCanonicalIdFromArticleUrl
} from "./acquisition/paper-download.js";
import {
  downloadPaper,
  registerManualPaperDownload,
  searchPapers
} from "./acquisition/paper-manager.js";
import {
  inspectPaper,
  parsePaper,
  readPaperSection,
  searchPaperText
} from "./reading/paper-reader.js";
import { savePaperWebPageParse } from "./reading/engines/webpage.js";
import { createPaperExtensionJob } from "./extension/paper-extension-bridge.js";
import { createPaperBrowserManagerClient } from "./browser/paper-browser-manager-client.js";
import {
  createPaperBrowserManagerServer,
  startPaperBrowserManagerHttpServer
} from "./browser/paper-browser-manager-server.js";
import { searchApsPapers } from "./acquisition/aps-search.js";
import { getPublisherAdapter } from "./acquisition/publisher-adapters/index.js";
import { fetchPaperWebPage } from "./acquisition/paper-webpage-fetch.js";
import type { PaperDownloadResult, PaperSearchResult, SupportedPaperSource } from "./types.js";
import { buildArxivHtmlUrls } from "./acquisition/arxiv.js";
import {
  blockPaperDownload,
  type PaperBlockReasonCode
} from "./acquisition/paper-blocklist.js";
import {
  readPaperRecordByPath,
  updatePaperRecordParseManifest,
  updatePaperRecordQueuedReading,
  updatePaperRecordReadingFailure
} from "./storage/paper-store.js";
import type { PaperRecord } from "./types.js";

const MAX_SEARCH_RESULT_PREVIEWS = 5;
const MAX_SEARCH_PREVIEW_TEXT_LENGTH = 220;

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
        "Optional paper title for exact-title arXiv preprint fallback when a publisher URL cannot be downloaded. If omitted, the manager tries to derive the title from publisher page metadata."
    })
  )
});

const blockPaperDownloadParameters = Type.Object({
  paperKey: Type.Optional(Type.String({ description: "Optional local paper key to block." })),
  source: Type.Optional(
    Type.Union([
      Type.Literal("arxiv"),
      Type.Literal("science"),
      Type.Literal("nature"),
      Type.Literal("aps"),
      Type.Literal("external")
    ], { description: "Optional paper source." })
  ),
  canonicalId: Type.Optional(Type.String({ description: "Optional DOI, arXiv id, or publisher canonical id." })),
  articleUrl: Type.Optional(Type.String({ description: "Optional article URL to block." })),
  title: Type.Optional(Type.String({ description: "Optional exact paper title to block." })),
  reasonCode: Type.Union([
    Type.Literal("irrelevant"),
    Type.Literal("license_denied"),
    Type.Literal("not_a_paper"),
    Type.Literal("download_failed"),
    Type.Literal("duplicate"),
    Type.Literal("other")
  ], { description: "Reason this paper should not be downloaded again." }),
  note: Type.Optional(Type.String({ description: "Optional human-readable note." }))
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
      Type.Literal("tex-source"),
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

export const paperReaderEngineParameter = Type.Optional(
  Type.Union([
    Type.Literal("opendataloader-local"),
    Type.Literal("opendataloader-hybrid"),
    Type.Literal("docling"),
    Type.Literal("tex-source"),
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

type SearchPapersParameters = Static<typeof searchPapersParameters>;
type DownloadPaperParameters = Static<typeof downloadPaperParameters>;
type BlockPaperDownloadParameters = Static<typeof blockPaperDownloadParameters>;
type RegisterManualPaperDownloadParameters = Static<typeof registerManualPaperDownloadParameters>;
type OpenPaperPageForLoginParameters = Static<typeof openPaperPageForLoginParameters>;
type ParsePaperParameters = Static<typeof parsePaperParameters>;
type InspectPaperParameters = Static<typeof inspectPaperParameters>;
type ReadPaperSectionParameters = Static<typeof readPaperSectionParameters>;
type SearchPaperTextParameters = Static<typeof searchPaperTextParameters>;

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
type SearchPapersTool = AgentTool<
  typeof searchPapersParameters,
  SearchToolDetails
>;
export type DownloadPaperReadingClosure =
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
export type DownloadPaperClosedLoopDetails = PaperDownloadResult & {
  reading?: DownloadPaperReadingClosure;
};
type DownloadPaperTool = AgentTool<
  typeof downloadPaperParameters,
  DownloadPaperClosedLoopDetails
>;
type BlockPaperDownloadTool = AgentTool<
  typeof blockPaperDownloadParameters,
  Awaited<ReturnType<typeof blockPaperDownload>>
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

function compactPreviewText(value: string | undefined, maxLength = MAX_SEARCH_PREVIEW_TEXT_LENGTH): string | undefined {
  const compacted = value?.replace(/\s+/g, " ").trim();
  if (!compacted) {
    return undefined;
  }

  return compacted.length > maxLength
    ? `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`
    : compacted;
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

function summarizeReadyRecordReading(record: PaperRecord): DownloadPaperReadingClosure | undefined {
  if (record.reading?.status !== "ready") {
    return undefined;
  }

  const artifact = record.reading.preferredSource === "webpage" ? record.webpage : record.parse;
  if (
    !artifact?.paperKey ||
    !artifact.engine ||
    !artifact.markdownPath ||
    !artifact.parsePath ||
    !artifact.qualityPath ||
    !artifact.chunksPath ||
    !artifact.quality
  ) {
    return undefined;
  }

  return {
    status: "already_parsed",
    strategy: record.reading.preferredSource === "webpage" ? "webpage" : "pdf",
    paperKey: artifact.paperKey,
    engine: artifact.engine as Awaited<ReturnType<typeof parsePaper>>["engine"],
    markdownPath: artifact.markdownPath,
    parsePath: artifact.parsePath,
    qualityPath: artifact.qualityPath,
    chunksPath: artifact.chunksPath,
    quality: artifact.quality as Awaited<ReturnType<typeof parsePaper>>["quality"]
  };
}

async function readReadyRecordReading(input: {
  workspaceDir: string;
  recordPath: string;
}): Promise<DownloadPaperReadingClosure | undefined> {
  try {
    const saved = await readPaperRecordByPath(input);
    return saved ? summarizeReadyRecordReading(saved.record) : undefined;
  } catch {
    return undefined;
  }
}

async function updateRecordWithParseResult(input: {
  workspaceDir: string;
  recordPath: string;
  strategy: "pdf" | "webpage";
  result: Awaited<ReturnType<typeof parsePaper>>;
}): Promise<void> {
  await updatePaperRecordParseManifest({
    workspaceDir: input.workspaceDir,
    recordPath: input.recordPath,
    strategy: input.strategy === "webpage" ? "webpage" : "pdf_parse",
    status: input.result.status,
    paperKey: input.result.paperKey,
    engine: input.result.engine,
    sourceSha256: input.result.pdfSha256,
    artifacts: input.result.artifacts,
    quality: input.result.quality
  }).catch(() => {});
}

function isWebpageFirstPublisher(source: string): source is SupportedPaperSource {
  return source === "aps" || source === "nature" || source === "science";
}

function formatReadingError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function assertSupportedPaperPublisherUrl(input: string): void {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Paper publisher URLs must use http or https.");
  }

  getPublisherAdapter(url.toString());
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

export function createPaperTools(input: {
  workspaceDir: string;
  dependencies: ToolDependencies;
}): {
  defaultTools: AgentTool<any>[];
  fullTools: AgentTool<any>[];
  toolsByName: {
    searchPapersTool: SearchPapersTool;
    downloadPaperTool: DownloadPaperTool;
    parsePaperTool: ParsePaperTool;
  };
  cleanup: () => Promise<void>;
} {
  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);
  const dependencies = input.dependencies;
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
      const result = await parsePaperImpl({
        workspaceDir: resolvedWorkspaceDir,
        recordPath
      });
      await updateRecordWithParseResult({
        workspaceDir: resolvedWorkspaceDir,
        recordPath,
        strategy: "pdf",
        result
      });
      return summarizeParseResult(result, "pdf");
    } catch (error) {
      await updatePaperRecordReadingFailure({
        workspaceDir: resolvedWorkspaceDir,
        recordPath,
        strategy: "pdf_parse",
        message: formatReadingError(error, "Downloaded PDF could not be parsed into markdown.")
      }).catch(() => {});
      return {
        status: "failed",
        strategy: "pdf",
        message: formatReadingError(error, "Downloaded PDF could not be parsed into markdown.")
      };
    }
  };

  const parseDownloadedTexSourceForReading = async (
    recordPath: string
  ): Promise<DownloadPaperReadingClosure | undefined> => {
    try {
      const result = await parsePaperImpl({
        workspaceDir: resolvedWorkspaceDir,
        recordPath,
        engine: "tex-source"
      });
      await updateRecordWithParseResult({
        workspaceDir: resolvedWorkspaceDir,
        recordPath,
        strategy: "pdf",
        result
      });
      return summarizeParseResult(result, "pdf");
    } catch {
      return undefined;
    }
  };

  const parseArxivWebpageForReading = async (
    canonicalId: string,
    recordPath: string
  ): Promise<DownloadPaperReadingClosure | undefined> => {
    for (const url of buildArxivHtmlUrls(canonicalId)) {
      try {
        const extraction = await fetchPaperWebPageImpl({ url });
        const result = await savePaperWebPageParseImpl({
          workspaceDir: resolvedWorkspaceDir,
          extraction,
          paperKey: `arxiv-${canonicalId}`
        });
        await updateRecordWithParseResult({
          workspaceDir: resolvedWorkspaceDir,
          recordPath,
          strategy: "webpage",
          result
        });
        return summarizeParseResult(result, "webpage");
      } catch {
        // Try the next arXiv HTML mirror before falling back to TeX/PDF parsing.
      }
    }
    return undefined;
  };

  const describeDownloadReadingClosure = async (
    result: PaperDownloadResult
  ): Promise<DownloadPaperReadingClosure | undefined> => {
    if (result.status === "downloaded" || result.status === "already_downloaded") {
      const ready = await readReadyRecordReading({
        workspaceDir: resolvedWorkspaceDir,
        recordPath: result.recordPath
      });
      if (ready) {
        return ready;
      }

      if (result.source === "arxiv") {
        return (
          await parseArxivWebpageForReading(result.canonicalId, result.recordPath)
        ) ?? (
          await parseDownloadedTexSourceForReading(result.recordPath)
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
          await updatePaperRecordQueuedReading({
            workspaceDir: resolvedWorkspaceDir,
            recordPath: result.recordPath,
            strategy: "webpage",
            jobId: queued.jobId,
            message:
              "Publisher PDF is downloaded. Browser extension webpage capture was queued so the reading source markdown can be generated."
          }).catch(() => {});
          return {
            status: "queued",
            strategy: "webpage",
            jobId: queued.jobId,
            message:
              "Publisher PDF is downloaded. Browser extension webpage capture was queued so the reading source markdown can be generated."
          };
        } catch (error) {
          await updatePaperRecordReadingFailure({
            workspaceDir: resolvedWorkspaceDir,
            recordPath: result.recordPath,
            strategy: "webpage",
            message: formatReadingError(error, "Publisher webpage markdown capture could not be queued.")
          }).catch(() => {});
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
          "Browser extension will first capture and parse the publisher webpage. PDF download starts only if the webpage markdown quality is good; otherwise the job waits for user login or access verification."
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
      "Downloads a paper by id or URL through the unified paper manager and closes the reading loop by generating or queuing markdown artifacts. Before downloading, it checks the local paper blocklist and returns blocked for known irrelevant, license-denied, non-paper, duplicate, or repeatedly failed papers. APS, Nature, Science, and arXiv use webpage markdown first; arXiv falls back to TeX source and then PDF parsing, while other PDFs are parsed after download. If a non-arXiv publisher download is blocked, incomplete, or unavailable, the manager tries an exact-title arXiv preprint fallback, deriving the title from publisher metadata when the caller did not pass one. For APS short DOIs, use the exact URL returned by search_papers or a DOI resolver URL such as https://link.aps.org/doi/<doi>; do not fabricate https://journals.aps.org/doi/<doi> URLs.",
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

  const blockPaperDownloadTool: BlockPaperDownloadTool = {
    name: "block_paper_download",
    label: "Block Paper Download",
    description:
      "Adds a paper to the local download blocklist so future download_paper calls stop before using the browser extension, network, or parser. Use for papers the user marks irrelevant, license-denied, non-paper, duplicate, or not worth retrying.",
    parameters: blockPaperDownloadParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: BlockPaperDownloadParameters) => {
      const result = await blockPaperDownload({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.paperKey ? { paperKey: args.paperKey } : {}),
        ...(args.source ? { source: args.source } : {}),
        ...(args.canonicalId ? { canonicalId: args.canonicalId } : {}),
        ...(args.articleUrl ? { articleUrl: args.articleUrl } : {}),
        ...(args.title ? { title: args.title } : {}),
        reasonCode: args.reasonCode as PaperBlockReasonCode,
        ...(args.note ? { note: args.note } : {})
      });

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
      "Inspects parsed paper artifacts, available parser engines, parse quality, localPdf presence, and section previews. A webpage parse is not proof that a PDF was downloaded; check localPdf.hasPdf and parse sourceKind before answering PDF-download questions.",
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

  return {
    defaultTools: [
      searchPapersTool,
      downloadPaperTool,
      blockPaperDownloadTool,
      inspectPaperTool,
      readPaperSectionTool,
      searchPaperTextTool
    ],
    fullTools: [
      registerManualPaperDownloadTool,
      openPaperPageForLoginTool,
      parsePaperTool
    ],
    toolsByName: {
      searchPapersTool,
      downloadPaperTool,
      parsePaperTool
    },
    cleanup: closePaperManager
  };
}
