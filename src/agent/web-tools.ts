import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDependencies } from "./tool-types.js";
import {
  createPaperExtensionJob,
  type PaperExtensionBridge
} from "./paper-extension-bridge.js";
import { fetchPaperWebPage } from "./paper-webpage-fetch.js";
import { savePaperWebPageParse } from "./paper-reader/engines/webpage.js";
import {
  readPaperRecord,
  updatePaperRecordParseManifest
} from "./paper-store.js";
import {
  resolvePublisherCanonicalIdFromArticleUrl
} from "./paper-download.js";
import type { SupportedPaperSource } from "./paper-types.js";
import { getPublisherAdapter } from "./publisher-adapters/index.js";
import { fetchWebPage } from "./web-fetch.js";
import { searchWeb, type WebSearchResult } from "./web-search.js";

const MAX_SEARCH_RESULT_PREVIEWS = 5;
const MAX_SEARCH_PREVIEW_TEXT_LENGTH = 220;

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

type WebSearchParameters = Static<typeof webSearchParameters>;
type FetchUrlParameters = Static<typeof fetchUrlParameters>;
type FetchPaperWebpageParameters = Static<typeof fetchPaperWebpageParameters>;

type SearchResultPreview = {
  title: string;
  url?: string;
  summary?: string;
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

async function updateRecordWithParseResult(input: {
  workspaceDir: string;
  recordPath: string;
  strategy: "webpage";
  result: Awaited<ReturnType<typeof savePaperWebPageParse>>;
}): Promise<void> {
  await updatePaperRecordParseManifest({
    workspaceDir: input.workspaceDir,
    recordPath: input.recordPath,
    strategy: "webpage",
    status: input.result.status,
    paperKey: input.result.paperKey,
    engine: input.result.engine,
    sourceSha256: input.result.pdfSha256,
    artifacts: input.result.artifacts,
    quality: input.result.quality
  }).catch(() => {});
}

function resolveExtensionPaperSource(input: string): SupportedPaperSource | "external" {
  try {
    return getPublisherAdapter(input).id;
  } catch {
    return "external";
  }
}

async function resolveRecordPathForArticleUrl(input: {
  workspaceDir: string;
  url: string;
}): Promise<string | undefined> {
  const source = resolveExtensionPaperSource(input.url);
  if (source === "external") {
    return (await readPaperRecord({
      workspaceDir: input.workspaceDir,
      source,
      articleUrl: input.url
    }))?.recordPath;
  }

  const canonicalId = resolvePublisherCanonicalIdFromArticleUrl({
    publisher: source,
    articleUrl: input.url
  });
  if (!canonicalId) {
    return undefined;
  }

  return (await readPaperRecord({
    workspaceDir: input.workspaceDir,
    source,
    canonicalId,
    articleUrl: input.url
  }))?.recordPath;
}

export function createWebTools(input: {
  workspaceDir: string;
  dependencies: ToolDependencies;
}): {
  defaultTools: AgentTool<any>[];
  fullTools: AgentTool<any>[];
} {
  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);
  const dependencies = input.dependencies;
  const searchWebImpl = dependencies.searchWeb ?? searchWeb;
  const fetchWebPageImpl = dependencies.fetchWebPage ?? fetchWebPage;
  const fetchPaperWebPageImpl = dependencies.fetchPaperWebPage ?? fetchPaperWebPage;
  const savePaperWebPageParseImpl = dependencies.savePaperWebPageParse ?? savePaperWebPageParse;

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
        if (savedParse) {
          const recordPath = await resolveRecordPathForArticleUrl({
            workspaceDir: resolvedWorkspaceDir,
            url: result.url
          });
          if (recordPath) {
            await updateRecordWithParseResult({
              workspaceDir: resolvedWorkspaceDir,
              recordPath,
              strategy: "webpage",
              result: savedParse
            });
          }
        }
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

  return {
    defaultTools: [webSearchTool, fetchUrlTool],
    fullTools: [fetchPaperWebpageTool]
  };
}
