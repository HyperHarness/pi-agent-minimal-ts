import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ToolDependencies } from "./tool-types.js";
import {
  listLocalPapers,
  searchLocalPapers
} from "./paper/storage/local-paper-library.js";
import { downloadPaper } from "./paper/acquisition/paper-manager.js";
import { generatePaperWikiSummary } from "./wiki/summary.js";
import {
  checkWikiHealth,
  fixWikiHealth,
  type WikiHealthFixProgress
} from "./wiki/health.js";

const MAX_SEARCH_PREVIEW_TEXT_LENGTH = 220;
const MAX_WIKI_HEALTH_FIX_RESULT_PREVIEWS = 80;

const listLocalPapersParameters = Type.Object({
  query: Type.Optional(Type.String({ description: "Optional metadata query to filter local papers." })),
  status: Type.Optional(
    Type.Union([
      Type.Literal("all"),
      Type.Literal("downloaded"),
      Type.Literal("parsed"),
      Type.Literal("summarized")
    ], { description: "Which local paper layer to list. Defaults to all." })
  ),
  maxResults: Type.Optional(Type.Integer({ description: "Maximum local papers to return.", minimum: 1 }))
});

const searchLocalPapersParameters = Type.Object({
  query: Type.String({
    description:
      "Keyword query to search across local paper acquisition files, LLM source summaries, and parsed markdown."
  }),
  maxResults: Type.Optional(Type.Integer({ description: "Maximum local paper matches to return.", minimum: 1 }))
});

const wikiHealthParameters = Type.Object({
  maxItems: Type.Optional(Type.Integer({ description: "Maximum health issues to return.", minimum: 1 })),
  lowQualityScoreThreshold: Type.Optional(
    Type.Number({
      description:
        "Parse quality score below which parsed papers are reported as low quality. Defaults to 0.7.",
      minimum: 0,
      maximum: 1
    })
  )
});

const wikiHealthIssueKindParameters = Type.Union([
  Type.Literal("needs_download"),
  Type.Literal("needs_authorization"),
  Type.Literal("queued"),
  Type.Literal("parse_missing"),
  Type.Literal("parse_failed"),
  Type.Literal("low_quality"),
  Type.Literal("summary_missing"),
  Type.Literal("missing_artifact"),
  Type.Literal("download_blocked"),
  Type.Literal("citation_incomplete")
]);

const wikiHealthFixParameters = Type.Object({
  maxItems: Type.Optional(Type.Integer({ description: "Maximum health issues to consider.", minimum: 1 })),
  lowQualityScoreThreshold: Type.Optional(
    Type.Number({
      description:
        "Parse quality score below which parsed papers are considered low quality. Defaults to 0.7.",
      minimum: 0,
      maximum: 1
    })
  ),
  issueKinds: Type.Optional(Type.Array(wikiHealthIssueKindParameters, {
    description: "Optional issue kinds to repair or explain. Defaults to all reported issue kinds."
  })),
  dryRun: Type.Optional(Type.Boolean({
    description: "Report intended repairs without changing acquisition files or retrying downloads."
  }))
});

type ListLocalPapersParameters = Static<typeof listLocalPapersParameters>;
type SearchLocalPapersParameters = Static<typeof searchLocalPapersParameters>;
type WikiHealthParameters = Static<typeof wikiHealthParameters>;
type WikiHealthFixParameters = Static<typeof wikiHealthFixParameters>;

type ListLocalPapersTool = AgentTool<
  typeof listLocalPapersParameters,
  Awaited<ReturnType<typeof listLocalPapers>>
>;
type SearchLocalPapersTool = AgentTool<
  typeof searchLocalPapersParameters,
  Awaited<ReturnType<typeof searchLocalPapers>>
>;
type WikiHealthTool = AgentTool<
  typeof wikiHealthParameters,
  Awaited<ReturnType<typeof checkWikiHealth>>
>;
type WikiHealthFixTool = AgentTool<
  typeof wikiHealthFixParameters,
  Awaited<ReturnType<typeof fixWikiHealth>>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function emitToolProgress(
  onUpdate: AgentToolUpdateCallback<any> | undefined,
  progress: WikiHealthFixProgress
): void {
  onUpdate?.({
    content: [{ type: "text", text: progress.message }],
    details: { progress }
  });
}

function compactWikiHealthFixContent(result: Awaited<ReturnType<typeof fixWikiHealth>>): string {
  const orderedResults = [
    ...result.results.filter((item) => item.status !== "fixed"),
    ...result.results.filter((item) => item.status === "fixed")
  ];
  const previewResults = orderedResults.slice(0, MAX_WIKI_HEALTH_FIX_RESULT_PREVIEWS).map((item) => {
    const details = isRecord(item.details) ? item.details : undefined;
    return {
      paperKey: item.issue.paperKey,
      issueKind: item.issue.kind,
      status: item.status,
      action: item.action,
      message: item.message,
      ...(details && typeof details.status === "string" ? { detailStatus: details.status } : {}),
      ...(details && typeof details.message === "string" ? { detailMessage: compactPreviewText(details.message, 240) } : {}),
      ...(details && isRecord(details.source) && typeof details.source.sourcePath === "string"
        ? { sourcePath: details.source.sourcePath }
        : details && typeof details.sourcePath === "string"
          ? { sourcePath: details.sourcePath }
        : {})
    };
  });

  return JSON.stringify({
    checked: {
      totalPapers: result.checked.totalPapers,
      issueCount: result.checked.issueCount,
      summary: result.checked.summary
    },
    attempted: result.attempted,
    fixed: result.fixed,
    queued: result.queued,
    skipped: result.skipped,
    failed: result.failed,
    results: previewResults,
    omittedResults: Math.max(0, orderedResults.length - previewResults.length)
  });
}

export function createLibraryHealthTools(input: {
  workspaceDir: string;
  dependencies: ToolDependencies;
}): {
  defaultTools: AgentTool<any>[];
  fullTools: AgentTool<any>[];
} {
  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);
  const dependencies = input.dependencies;
  const listLocalPapersImpl = dependencies.listLocalPapers ?? listLocalPapers;
  const searchLocalPapersImpl = dependencies.searchLocalPapers ?? searchLocalPapers;
  const checkWikiHealthImpl = dependencies.checkWikiHealth ?? checkWikiHealth;
  const fixWikiHealthImpl = dependencies.fixWikiHealth ?? fixWikiHealth;
  const generatePaperWikiSummaryImpl = dependencies.generatePaperWikiSummary ?? generatePaperWikiSummary;

  const listLocalPapersTool: ListLocalPapersTool = {
    name: "list_local_papers",
    label: "List Local Papers",
    description:
      "Lists papers already known in the local knowledge base across acquisition files, raw PDFs, parsed artifacts, and LLM source summaries.",
    parameters: listLocalPapersParameters,
    execute: async (_toolCallId: string, args: ListLocalPapersParameters) => {
      const result = await listLocalPapersImpl({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.query ? { query: args.query } : {}),
        ...(args.status ? { status: args.status } : {}),
        ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const searchLocalPapersTool: SearchLocalPapersTool = {
    name: "search_local_papers",
    label: "Search Local Papers",
    description:
      "Searches across the local knowledge base, including acquisition files, LLM source summaries, and parsed markdown for all downloaded or parsed papers.",
    parameters: searchLocalPapersParameters,
    execute: async (_toolCallId: string, args: SearchLocalPapersParameters) => {
      const result = await searchLocalPapersImpl({
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

  const wikiHealthTool: WikiHealthTool = {
    name: "wiki_health",
    label: "Wiki Health",
    description:
      "Diagnoses local paper knowledge-base health across acquisition files, downloads, authorization state, parse quality, source citation metadata, wiki summaries, and missing artifacts.",
    parameters: wikiHealthParameters,
    execute: async (_toolCallId: string, args: WikiHealthParameters) => {
      const result = await checkWikiHealthImpl({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
        ...(args.lowQualityScoreThreshold !== undefined
          ? { lowQualityScoreThreshold: args.lowQualityScoreThreshold }
          : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const wikiHealthFixTool: WikiHealthFixTool = {
    name: "wiki_health_fix",
    label: "Wiki Health Fix",
    description:
      "Attempts wiki health repairs. Download and citation-metadata repairs go through the paper-download-subagent boundary, parsing repairs update ingestion artifacts, and missing summaries go through the wiki-evidence-worker summary pass; reports why unresolved issues need user action.",
    parameters: wikiHealthFixParameters,
    execute: async (
      _toolCallId: string,
      args: WikiHealthFixParameters,
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<any> | undefined
    ) => {
      const result = await fixWikiHealthImpl({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
        ...(args.lowQualityScoreThreshold !== undefined
          ? { lowQualityScoreThreshold: args.lowQualityScoreThreshold }
          : {}),
        ...(args.issueKinds !== undefined ? { issueKinds: args.issueKinds } : {}),
        ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
        ...(dependencies.extensionBridge
          ? {
              downloadPaperImpl: (downloadOptions) =>
                downloadPaper({
                  ...downloadOptions,
                  extensionBridge: dependencies.extensionBridge
                })
            }
          : {}),
        ...(dependencies.paperDownloadWorker
          ? { paperDownloadWorker: dependencies.paperDownloadWorker }
          : {}),
        ...(dependencies.paperSummaryWorker ? { paperSummaryWorker: dependencies.paperSummaryWorker } : {}),
        generatePaperWikiSummaryImpl,
        onProgress: (progress) => emitToolProgress(onUpdate, progress)
      });

      return {
        content: [{ type: "text", text: compactWikiHealthFixContent(result) }],
        details: result
      };
    }
  };

  return {
    defaultTools: [
      searchLocalPapersTool,
      wikiHealthTool,
      wikiHealthFixTool
    ],
    fullTools: [
      listLocalPapersTool
    ]
  };
}
