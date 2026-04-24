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
import { downloadPaper, searchPapers } from "./paper-manager.js";
import {
  createPaperBrowserManagerClient,
  type PaperBrowserManagerClient
} from "./paper-browser-manager-client.js";
import { createPaperBrowserManagerServer, startPaperBrowserManagerHttpServer } from "./paper-browser-manager-server.js";
import { getPublisherAdapter } from "./publisher-adapters/index.js";
import { fetchWebPage } from "./web-fetch.js";
import { searchWeb } from "./web-search.js";

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

const searchPapersParameters = Type.Object({
  query: Type.String({ description: "Search query string for papers." }),
  maxResults: Type.Optional(
    Type.Integer({ description: "Maximum number of results to return.", minimum: 1 })
  )
});

const downloadPaperParameters = Type.Object({
  id: Type.Optional(Type.String({ description: "Paper identifier to download." })),
  url: Type.Optional(Type.String({ description: "Paper URL to download." }))
});

const openPaperPageForLoginParameters = Type.Object({
  url: Type.String({ description: "Publisher article URL to open for manual login review." })
});

type GetTimeParameters = Static<typeof getTimeParameters>;
type ReadFileParameters = Static<typeof readFileParameters>;
type WebSearchParameters = Static<typeof webSearchParameters>;
type FetchUrlParameters = Static<typeof fetchUrlParameters>;
type SearchPapersParameters = Static<typeof searchPapersParameters>;
type DownloadPaperParameters = Static<typeof downloadPaperParameters>;
type OpenPaperPageForLoginParameters = Static<typeof openPaperPageForLoginParameters>;

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
type WebSearchTool = AgentTool<
  typeof webSearchParameters,
  { query: string; maxResults: number; count: number }
>;
type FetchUrlTool = AgentTool<typeof fetchUrlParameters, { url: string }>;
type SearchPapersTool = AgentTool<
  typeof searchPapersParameters,
  { query: string; maxResults: number; count: number }
>;
type DownloadPaperTool = AgentTool<
  typeof downloadPaperParameters,
  Awaited<ReturnType<typeof downloadPaper>>
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
type OpenPaperPageForLoginTool = AgentTool<
  typeof openPaperPageForLoginParameters,
  OpenPaperPageForLoginResult
>;

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

export interface ToolDependencies {
  searchWeb?: typeof searchWeb;
  fetchWebPage?: typeof fetchWebPage;
  searchPapers?: typeof searchPapers;
  downloadPaper?: typeof downloadPaper;
  openPaperPageForLogin?: OpenPaperPageForLoginDependency;
  browserSessionFactory?: ReturnType<typeof resolveDefaultPaperBrowserSessionFactory>;
  paperBrowserManagerClient?: PaperBrowserManagerClient;
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
  SearchPapersTool,
  DownloadPaperTool,
  OpenPaperPageForLoginTool
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
  const searchPapersImpl = dependencies.searchPapers ?? searchPapers;
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

  const openPaperPageForLoginImpl =
    dependencies.openPaperPageForLogin ??
    (async (options: { workspaceDir: string; url: string }) =>
      paperBrowserManagerClient.openArticle({ url: options.url }));

  let cleanupPromise: Promise<void> | undefined;
  const closePaperManager = async (): Promise<void> => {
    cleanupPromise ??= paperBrowserManagerClient.close();
    await cleanupPromise;
  };

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
        details: { query: args.query, maxResults, count: results.length }
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

  const searchPapersTool: SearchPapersTool = {
    name: "search_papers",
    label: "Search Papers",
    description: "Searches papers and returns unified result summaries.",
    parameters: searchPapersParameters,
    execute: async (_toolCallId: string, args: SearchPapersParameters) => {
      const results = await searchPapersImpl({ query: args.query, maxResults: args.maxResults });
      const maxResults = args.maxResults ?? 5;

      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
        details: { query: args.query, maxResults, count: results.length }
      };
    }
  };

  const downloadPaperTool: DownloadPaperTool = {
    name: "download_paper",
    label: "Download Paper",
    description:
      "Downloads a paper by id or URL through the unified paper manager, reusing the managed browser flow for supported publishers.",
    parameters: downloadPaperParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: DownloadPaperParameters) => {
      const result = await downloadPaperImpl({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.id ? { id: args.id } : {}),
        ...(args.url ? { url: args.url } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
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

  const tools = [
    getTimeTool,
    readFileTool,
    webSearchTool,
    fetchUrlTool,
    searchPapersTool,
    downloadPaperTool,
    openPaperPageForLoginTool
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
