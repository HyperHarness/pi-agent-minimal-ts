import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { buildArxivPdfUrl, searchArxiv } from "./arxiv.js";
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

type GetTimeParameters = Static<typeof getTimeParameters>;
type ReadFileParameters = Static<typeof readFileParameters>;
type WebSearchParameters = Static<typeof webSearchParameters>;
type FetchUrlParameters = Static<typeof fetchUrlParameters>;
type SearchArxivParameters = Static<typeof searchArxivParameters>;
type DownloadArxivPdfParameters = Static<typeof downloadArxivPdfParameters>;

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

export interface ToolDependencies {
  searchWeb?: typeof searchWeb;
  fetchWebPage?: typeof fetchWebPage;
  searchArxiv?: typeof searchArxiv;
  buildArxivPdfUrl?: typeof buildArxivPdfUrl;
}

export type AgentTools = readonly [
  GetTimeTool,
  ReadFileTool,
  WebSearchTool,
  FetchUrlTool,
  SearchArxivTool,
  DownloadArxivPdfTool
];

export function createTools(workspaceDir: string, dependencies: ToolDependencies = {}): AgentTools {
  const searchWebImpl = dependencies.searchWeb ?? searchWeb;
  const fetchWebPageImpl = dependencies.fetchWebPage ?? fetchWebPage;
  const searchArxivImpl = dependencies.searchArxiv ?? searchArxiv;
  const buildArxivPdfUrlImpl = dependencies.buildArxivPdfUrl ?? buildArxivPdfUrl;

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
      const resolvedPath = await resolveWorkspacePath(workspaceDir, args.path);
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

  return [
    getTimeTool,
    readFileTool,
    webSearchTool,
    fetchUrlTool,
    searchArxivTool,
    downloadArxivPdfTool
  ];
}
