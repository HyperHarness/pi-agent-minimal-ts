import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { PaperBrowserSession } from "./browser-session.js";
import {
  openPageInSystemChromeForManualLogin,
  resolveDefaultPaperBrowserSessionFactory
} from "./browser-session.js";
import { buildArxivPdfUrl, searchArxiv } from "./arxiv.js";
import { downloadPaperPdf } from "./paper-download.js";
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

const searchArxivParameters = Type.Object({
  query: Type.String({ description: "Search query string for arXiv." }),
  maxResults: Type.Optional(
    Type.Integer({ description: "Maximum number of results to return.", minimum: 1 })
  )
});

const downloadArxivPdfParameters = Type.Object({
  id: Type.String({ description: "arXiv identifier to convert into a PDF URL." })
});

const downloadPaperPdfParameters = Type.Object({
  url: Type.String({ description: "Publisher article URL to download as a PDF." })
});

const openPaperPageForLoginParameters = Type.Object({
  url: Type.String({ description: "Publisher article URL to open for manual login review." })
});

type GetTimeParameters = Static<typeof getTimeParameters>;
type ReadFileParameters = Static<typeof readFileParameters>;
type WebSearchParameters = Static<typeof webSearchParameters>;
type FetchUrlParameters = Static<typeof fetchUrlParameters>;
type SearchArxivParameters = Static<typeof searchArxivParameters>;
type DownloadArxivPdfParameters = Static<typeof downloadArxivPdfParameters>;
type DownloadPaperPdfParameters = Static<typeof downloadPaperPdfParameters>;
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
type SearchArxivTool = AgentTool<
  typeof searchArxivParameters,
  { query: string; maxResults: number; count: number }
>;
type DownloadArxivPdfTool = AgentTool<
  typeof downloadArxivPdfParameters,
  { id: string; pdfUrl: string }
>;
type DownloadPaperPdfResult = Awaited<
  ReturnType<typeof downloadPaperPdf>
>;
type DownloadPaperPdfDependency = (options: {
  workspaceDir: string;
  url: string;
}) => Promise<DownloadPaperPdfResult>;
type OpenPaperPageForLoginResult = Awaited<
  ReturnType<typeof openPageInSystemChromeForManualLogin>
>;
type OpenPaperPageForLoginDependency = (options: {
  workspaceDir: string;
  url: string;
}) => Promise<OpenPaperPageForLoginResult>;
type DownloadPaperPdfTool = AgentTool<
  typeof downloadPaperPdfParameters,
  DownloadPaperPdfResult
>;
type OpenPaperPageForLoginTool = AgentTool<
  typeof openPaperPageForLoginParameters,
  OpenPaperPageForLoginResult
>;

export interface ToolDependencies {
  searchWeb?: typeof searchWeb;
  fetchWebPage?: typeof fetchWebPage;
  searchArxiv?: typeof searchArxiv;
  buildArxivPdfUrl?: typeof buildArxivPdfUrl;
  openPaperPageForLogin?: OpenPaperPageForLoginDependency;
  downloadPaperPdf?: DownloadPaperPdfDependency;
  browserSessionFactory?: ReturnType<typeof resolveDefaultPaperBrowserSessionFactory>;
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
  SearchArxivTool,
  DownloadArxivPdfTool,
  OpenPaperPageForLoginTool,
  DownloadPaperPdfTool
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
  const searchArxivImpl = dependencies.searchArxiv ?? searchArxiv;
  const buildArxivPdfUrlImpl = dependencies.buildArxivPdfUrl ?? buildArxivPdfUrl;
  const browserSessionFactoryImpl =
    dependencies.browserSessionFactory ??
    resolveDefaultPaperBrowserSessionFactory({ workspaceDir: resolvedWorkspaceDir });
  let browserSessionPromise: Promise<PaperBrowserSession> | undefined;
  const getBrowserSession = async (): Promise<PaperBrowserSession> => {
    browserSessionPromise ??= browserSessionFactoryImpl();
    return browserSessionPromise;
  };
  const downloadPaperPdfImpl =
    dependencies.downloadPaperPdf ??
    (async (options: { workspaceDir: string; url: string }) => {
      const browserSession = await getBrowserSession();
      return downloadPaperPdf({
        workspaceDir: options.workspaceDir,
        url: options.url,
        browserSession
      });
    });
  const openPaperPageForLoginImpl =
    dependencies.openPaperPageForLogin ??
    (async (options: { workspaceDir: string; url: string }) =>
      openPageInSystemChromeForManualLogin(options));

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

  const searchArxivTool: SearchArxivTool = {
    name: "search_arxiv",
    label: "Search arXiv",
    description: "Searches arXiv and returns structured paper summaries.",
    parameters: searchArxivParameters,
    execute: async (_toolCallId: string, args: SearchArxivParameters) => {
      const results = await searchArxivImpl({ query: args.query, maxResults: args.maxResults });
      const maxResults = args.maxResults ?? 5;

      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
        details: { query: args.query, maxResults, count: results.length }
      };
    }
  };

  const downloadArxivPdfTool: DownloadArxivPdfTool = {
    name: "download_arxiv_pdf",
    label: "Download arXiv PDF",
    description: "Builds the canonical arXiv PDF URL for a paper identifier.",
    parameters: downloadArxivPdfParameters,
    execute: async (_toolCallId: string, args: DownloadArxivPdfParameters) => {
      const pdfUrl = buildArxivPdfUrlImpl(args.id);

      return {
        content: [{ type: "text", text: pdfUrl }],
        details: { id: args.id, pdfUrl }
      };
    }
  };

  const openPaperPageForLoginTool: OpenPaperPageForLoginTool = {
    name: "open_paper_page_for_login",
    label: "Open Paper Page For Login",
    description:
      "Launches the local Chrome or Edge browser with the shared paper-access profile for manual login review without downloading anything.",
    parameters: openPaperPageForLoginParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: OpenPaperPageForLoginParameters) => {
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

  const downloadPaperPdfTool: DownloadPaperPdfTool = {
    name: "download_paper_pdf",
    label: "Download Paper PDF",
    description:
      "Uses an authorized Chrome browser session to download a paper PDF from a supported publisher.",
    parameters: downloadPaperPdfParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: DownloadPaperPdfParameters) => {
      const result = await downloadPaperPdfImpl({
        workspaceDir: resolvedWorkspaceDir,
        url: args.url
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  let cleanupPromise: Promise<void> | undefined;
  const tools = [
    getTimeTool,
    readFileTool,
    webSearchTool,
    fetchUrlTool,
    searchArxivTool,
    downloadArxivPdfTool,
    openPaperPageForLoginTool,
    downloadPaperPdfTool
  ] as unknown as AgentTools;

  Object.defineProperties(tools, {
    cleanup: {
      enumerable: false,
      value: async () => {
        cleanupPromise ??= (async () => {
          if (browserSessionPromise === undefined) {
            return;
          }

          let browserSession: PaperBrowserSession;
          try {
            browserSession = await browserSessionPromise;
          } catch {
            return;
          }
          await browserSession.dispose?.();
        })();
        await cleanupPromise;
      }
    },
    workspaceDir: {
      enumerable: false,
      value: resolvedWorkspaceDir
    }
  });

  return tools;
}
