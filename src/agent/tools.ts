import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
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
  writePaperWikiPage,
  writePaperWikiSource
} from "./paper-wiki/paper-wiki.js";
import {
  bootstrapPaperWikiPageEvidence,
  type BootstrapPaperWikiPageEvidenceDependencies
} from "./paper-wiki/bootstrap.js";
import { lintPaperWiki } from "./paper-wiki/lint.js";
import type {
  PaperWikiPageBootstrapResult,
  PaperWikiPageWorker,
  PaperWikiPageWorkerOutput
} from "./paper-wiki/types.js";
import {
  generatePaperWikiSummary,
  type PaperSummaryProgress,
  type PaperSummaryWorker
} from "./paper-summary.js";
import { paperWikiRelations } from "./paper-relations.js";
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
import type { PaperDownloadResult, PaperSearchResult, PaperSearchSource, SupportedPaperSource } from "./paper-types.js";
import { buildArxivHtmlUrl } from "./arxiv.js";
import {
  listLocalPapers,
  searchLocalPapers
} from "./local-paper-library.js";
import { checkWikiHealth, fixWikiHealth, type WikiHealthFixProgress } from "./wiki-health.js";
import {
  readPaperRecord,
  readPaperRecordByPath,
  updatePaperRecordParseManifest,
  updatePaperRecordQueuedReading,
  updatePaperRecordReadingFailure
} from "./paper-store.js";
import type { PaperRecord } from "./paper-types.js";

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

const paperReaderEngineParameter = Type.Optional(
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

const generatePaperWikiSummaryParameters = Type.Object({
  paperKey: Type.String({ description: "Parsed paper key, for example arxiv-2406.06015." }),
  engine: paperReaderEngineParameter,
  mode: Type.Optional(
    Type.Union([
      Type.Literal("draft"),
      Type.Literal("write")
    ], { description: "Generate a draft only or write the wiki source summary. Defaults to draft." })
  ),
  maxEvidenceChars: Type.Optional(
    Type.Integer({
      description: "Maximum parsed Markdown characters to send to the clean summary worker. Defaults to 60000.",
      minimum: 1000
    })
  ),
  includeRelatedCandidates: Type.Optional(
    Type.Boolean({
      description:
        "Include local related-paper candidates in the clean summary worker evidence. Defaults to true."
    })
  ),
  maxRelatedCandidates: Type.Optional(
    Type.Integer({
      description: "Maximum related-paper candidates to include when includeRelatedCandidates is true. Defaults to 8.",
      minimum: 1
    })
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Generate despite non-good parse quality or low worker confidence. Defaults to false."
    })
  )
});

const paperWikiRelationsParameters = Type.Object({
  paperKey: Type.String({ description: "Paper key whose wiki relationships should be suggested or updated." }),
  maxCandidates: Type.Optional(
    Type.Integer({ description: "Maximum relation candidates to return. Defaults to 8.", minimum: 1 })
  ),
  maxTextChars: Type.Optional(
    Type.Integer({ description: "Maximum characters to read from each paper when scoring relation candidates.", minimum: 1000 })
  ),
  relatedPaperKeys: Type.Optional(
    Type.Array(Type.String({
      description:
        "Optional confirmed related paper keys to write into the existing wiki source summary. Omit to only suggest candidates."
    }))
  ),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("append"),
      Type.Literal("replace")
    ], { description: "How to write relatedPaperKeys when provided. Defaults to append." })
  )
});

const searchPaperWikiParameters = Type.Object({
  query: Type.String({ description: "Text query to search inside LLM-authored paper source summaries and synthesis pages." }),
  maxResults: Type.Optional(Type.Integer({ description: "Maximum matching wiki items to return.", minimum: 1 }))
});

const wikiLintParameters = Type.Object({
  maxItems: Type.Optional(Type.Integer({ description: "Maximum wiki structure issues to return.", minimum: 1 }))
});

const answerPaperWikiQuestionParameters = Type.Object({
  query: Type.String({
    description:
      "Scientific or paper-related question or concise English keyword query to ground against local paper wiki source summaries."
  }),
  maxResults: Type.Optional(
    Type.Integer({
      description: "Maximum wiki source summaries or fallback local matches to return. Defaults to 8.",
      minimum: 1
    })
  )
});

const answerResearchQuestionParameters = Type.Object({
  query: Type.String({
    description:
      "Scientific or paper-related question. The tool searches local wiki evidence first, then searches and ingests external papers only if local evidence is insufficient."
  }),
  maxLocalResults: Type.Optional(
    Type.Integer({ description: "Maximum local wiki evidence items to return. Defaults to 8.", minimum: 1 })
  ),
  maxExternalCandidates: Type.Optional(
    Type.Integer({ description: "Maximum external paper candidates to inspect when local evidence is insufficient. Defaults to 5.", minimum: 1 })
  ),
  maxDownloads: Type.Optional(
    Type.Integer({ description: "Maximum external candidates to download and ingest. Defaults to 1.", minimum: 0 })
  ),
  autoDownload: Type.Optional(
    Type.Boolean({ description: "Whether to download external candidates when local evidence is insufficient. Defaults to true." })
  ),
  autoSummarize: Type.Optional(
    Type.Boolean({ description: "Whether to write wiki source summaries for newly parsed papers when a summary worker is configured. Defaults to true." })
  )
});

const bootstrapWikiPageEvidenceParameters = Type.Object({
  topic: Type.String({ description: "Topic or concept for the future synthesis wiki page." }),
  question: Type.Optional(
    Type.String({ description: "Optional user question that should drive seed queries and source selection." })
  ),
  maxSeedQueries: Type.Optional(
    Type.Integer({ description: "Maximum deterministic seed queries to generate. Defaults to 4.", minimum: 1 })
  ),
  maxSources: Type.Optional(
    Type.Integer({ description: "Maximum source-summary evidence items to return. Defaults to 12.", minimum: 1 })
  ),
  includeParsedFallback: Type.Optional(
    Type.Boolean({ description: "Search parsed/local papers when source summaries are insufficient. Defaults to true." })
  ),
  autoSummarizeMissing: Type.Optional(
    Type.Boolean({ description: "Generate missing source summaries for parsed fallback papers when a summary worker is configured. Defaults to true." })
  ),
  maxSummariesToGenerate: Type.Optional(
    Type.Integer({ description: "Maximum missing summaries to generate during bootstrap. Defaults to 3.", minimum: 0 })
  )
});

const buildWikiPageParameters = Type.Object({
  topic: Type.String({ description: "Topic or concept for the synthesis wiki page." }),
  question: Type.Optional(
    Type.String({ description: "Optional user question that should drive the page evidence and structure." })
  ),
  pageKey: Type.Optional(
    Type.String({ description: "Optional filename-safe wiki page key. Defaults to a sanitized topic." })
  ),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("draft"),
      Type.Literal("write")
    ], { description: "Build a draft only or write knowledge-base/wiki/pages/<page-key>.md. Defaults to write." })
  ),
  maxLocalResults: Type.Optional(
    Type.Integer({ description: "Maximum local wiki evidence items to return. Defaults to 8.", minimum: 1 })
  ),
  maxExternalCandidates: Type.Optional(
    Type.Integer({ description: "Maximum external paper candidates to inspect when local evidence is insufficient. Defaults to 5.", minimum: 1 })
  ),
  maxDownloads: Type.Optional(
    Type.Integer({ description: "Maximum external candidates to download and ingest. Defaults to 1.", minimum: 0 })
  ),
  autoDownload: Type.Optional(
    Type.Boolean({ description: "Whether to download external candidates when local evidence is insufficient. Defaults to true." })
  ),
  autoSummarize: Type.Optional(
    Type.Boolean({ description: "Whether to write missing source summaries before building the page. Defaults to true." })
  )
});

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
      "Keyword query to search across local paper records, LLM source summaries, and parsed markdown."
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
  Type.Literal("missing_artifact")
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
    description: "Report intended repairs without changing records or retrying downloads."
  }))
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
type GeneratePaperWikiSummaryParameters = Static<typeof generatePaperWikiSummaryParameters>;
type PaperWikiRelationsParameters = Static<typeof paperWikiRelationsParameters>;
type SearchPaperWikiParameters = Static<typeof searchPaperWikiParameters>;
type WikiLintParameters = Static<typeof wikiLintParameters>;
type AnswerPaperWikiQuestionParameters = Static<typeof answerPaperWikiQuestionParameters>;
type AnswerResearchQuestionParameters = Static<typeof answerResearchQuestionParameters>;
type BootstrapWikiPageEvidenceParameters = Static<typeof bootstrapWikiPageEvidenceParameters>;
type BuildWikiPageParameters = Static<typeof buildWikiPageParameters>;
type ListLocalPapersParameters = Static<typeof listLocalPapersParameters>;
type SearchLocalPapersParameters = Static<typeof searchLocalPapersParameters>;
type WikiHealthParameters = Static<typeof wikiHealthParameters>;
type WikiHealthFixParameters = Static<typeof wikiHealthFixParameters>;

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
type GeneratePaperWikiSummaryTool = AgentTool<
  typeof generatePaperWikiSummaryParameters,
  Awaited<ReturnType<typeof generatePaperWikiSummary>>
>;
type PaperWikiRelationsTool = AgentTool<
  typeof paperWikiRelationsParameters,
  Awaited<ReturnType<typeof paperWikiRelations>>
>;
type SearchPaperWikiTool = AgentTool<
  typeof searchPaperWikiParameters,
  Awaited<ReturnType<typeof searchPaperWiki>>
>;
type WikiLintTool = AgentTool<
  typeof wikiLintParameters,
  Awaited<ReturnType<typeof lintPaperWiki>>
>;
type AnswerPaperWikiQuestionDetails = {
  query: string;
  status: "has_wiki_evidence" | "no_wiki_evidence_but_local_matches" | "no_local_evidence";
  answerPolicy: string[];
  evidence: Array<{
    kind: "source" | "page";
    citation: string;
    key: string;
    paperKey?: string;
    pageKey?: string;
    title: string;
    path: string;
    snippet: string;
  }>;
  fallbackMatches: Array<{
    paperKey: string;
    title?: string;
    path?: string;
    field: string;
    snippet: string;
  }>;
};
type AnswerPaperWikiQuestionTool = AgentTool<
  typeof answerPaperWikiQuestionParameters,
  AnswerPaperWikiQuestionDetails
>;
type ResearchQuestionStatus =
  | "answered_from_wiki"
  | "expanded_with_new_sources"
  | "needs_user_action"
  | "insufficient_evidence";
type ResearchExternalCandidate = {
  title: string;
  source: PaperSearchResult["primarySource"];
  action: PaperSearchResult["primaryAction"];
  articleUrl?: string;
  canonicalId?: string;
  summary?: string;
};
type ResearchDownloadedPaper = {
  title: string;
  source: PaperDownloadResult["source"];
  status: PaperDownloadResult["status"];
  articleUrl: string;
  recordPath?: string;
  paperKey?: string;
  readingStatus?: DownloadPaperReadingClosure["status"];
  message?: string;
};
type ResearchWrittenSummary = {
  paperKey: string;
  status: Awaited<ReturnType<typeof generatePaperWikiSummary>>["status"];
  sourcePath?: string;
  message: string;
};
type ResearchBlockedItem = {
  stage: "local_summary" | "external_search" | "download" | "parse" | "summary" | "user_action";
  title?: string;
  paperKey?: string;
  articleUrl?: string;
  reason: string;
};
type AnswerResearchQuestionDetails = {
  query: string;
  status: ResearchQuestionStatus;
  localEvidence: AnswerPaperWikiQuestionDetails;
  refreshedEvidence?: AnswerPaperWikiQuestionDetails;
  externalCandidates: ResearchExternalCandidate[];
  downloaded: ResearchDownloadedPaper[];
  summariesWritten: ResearchWrittenSummary[];
  blocked: ResearchBlockedItem[];
  answerPolicy: string[];
};
type AnswerResearchQuestionTool = AgentTool<
  typeof answerResearchQuestionParameters,
  AnswerResearchQuestionDetails
>;
type BootstrapWikiPageEvidenceDetails = PaperWikiPageBootstrapResult & {
  summariesWritten: ResearchWrittenSummary[];
};
type BootstrapWikiPageEvidenceTool = AgentTool<
  typeof bootstrapWikiPageEvidenceParameters,
  BootstrapWikiPageEvidenceDetails
>;
type BuildWikiPageDetails = {
  topic: string;
  question?: string;
  mode: "draft" | "write";
  bootstrap?: BootstrapWikiPageEvidenceDetails;
  research?: AnswerResearchQuestionDetails;
  status: "drafted" | "written" | "needs_evidence" | "needs_worker" | "skipped";
  message: string;
  draft?: PaperWikiPageWorkerOutput;
  page?: Awaited<ReturnType<typeof writePaperWikiPage>>;
  evidence: Array<{
    kind: "source" | "page";
    key: string;
    paperKey?: string;
    pageKey?: string;
    title: string;
    path: string;
    snippet: string;
    query?: string;
    origin?: "seed_search" | "related_expansion" | "local_fallback";
  }>;
};
type ResearchWorkflowProgressStage =
  | "local_wiki_search"
  | "local_wiki_found"
  | "external_search"
  | "external_search_done"
  | "download_start"
  | "download_done"
  | "summary_start"
  | "summary_progress"
  | "summary_done"
  | "refreshed_wiki_search"
  | "research_done"
  | "wiki_page_worker_start"
  | "wiki_page_worker_done"
  | "wiki_page_write";
type ResearchWorkflowProgress = {
  stage: ResearchWorkflowProgressStage;
  query: string;
  title?: string;
  paperKey?: string;
  index?: number;
  total?: number;
  message: string;
  summaryProgress?: PaperSummaryProgress;
};
type BuildWikiPageTool = AgentTool<
  typeof buildWikiPageParameters,
  BuildWikiPageDetails
>;
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

const MAX_SEARCH_RESULT_PREVIEWS = 5;
const MAX_SEARCH_PREVIEW_TEXT_LENGTH = 220;
const MAX_WIKI_HEALTH_FIX_RESULT_PREVIEWS = 80;
const DEFAULT_WIKI_QUESTION_RESULTS = 8;
const DEFAULT_RESEARCH_EXTERNAL_CANDIDATES = 5;
const DEFAULT_RESEARCH_DOWNLOADS = 1;

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

async function buildPaperWikiQuestionEvidence(input: {
  workspaceDir: string;
  query: string;
  maxResults?: number;
  searchPaperWikiImpl: typeof searchPaperWiki;
  searchLocalPapersImpl: typeof searchLocalPapers;
}): Promise<AnswerPaperWikiQuestionDetails> {
  const maxResults = Math.max(1, Math.trunc(input.maxResults ?? DEFAULT_WIKI_QUESTION_RESULTS));
  const wikiResult = await input.searchPaperWikiImpl({
    workspaceDir: input.workspaceDir,
    query: input.query,
    maxResults
  });
  const evidence = wikiResult.results.map((result) => {
    const kind = result.kind ?? (result.pageKey ? "page" : "source");
    const key = result.key ?? result.paperKey ?? result.pageKey ?? result.path;
    return {
      kind,
      citation: `${key} (${result.path})`,
      key,
      ...(result.paperKey ? { paperKey: result.paperKey } : {}),
      ...(result.pageKey ? { pageKey: result.pageKey } : {}),
      title: result.title,
      path: result.path,
      snippet: result.snippet
    };
  });

  if (evidence.length > 0) {
    return {
      query: wikiResult.query,
      status: "has_wiki_evidence",
      answerPolicy: [
        "Answer from the evidence list only for wiki-grounded claims.",
        "Cite paperKey, pageKey, or path next to substantive claims.",
        "Separate any unsupported background knowledge from wiki-grounded conclusions."
      ],
      evidence,
      fallbackMatches: []
    };
  }

  const localResult = await input.searchLocalPapersImpl({
    workspaceDir: input.workspaceDir,
    query: input.query,
    maxResults
  });
  const fallbackMatches = localResult.results.flatMap((result) =>
    result.matches.slice(0, 2).map((match) => ({
      paperKey: result.paper.paperKey,
      ...(result.paper.title ? { title: result.paper.title } : {}),
      ...(match.path ? { path: match.path } : {}),
      field: match.field,
      snippet: match.snippet
    }))
  ).slice(0, maxResults);

  return {
    query: localResult.query,
    status: fallbackMatches.length > 0 ? "no_wiki_evidence_but_local_matches" : "no_local_evidence",
    answerPolicy: [
      "Do not present the answer as wiki-grounded because no source summary matched.",
      "Tell the user the local wiki lacks enough source-summary evidence.",
      "Use fallback matches only to suggest papers that may need summary generation or wiki repair."
    ],
    evidence: [],
    fallbackMatches
  };
}

function findDownloadablePaperSource(result: PaperSearchResult): PaperSearchSource | undefined {
  return result.sources.find((source) =>
    source.action === "direct_download" ||
    source.action === "authorized_download"
  );
}

function summarizeResearchCandidate(result: PaperSearchResult): ResearchExternalCandidate {
  const primarySource = result.sources.find((source) => source.source === result.primarySource) ?? result.sources[0];
  return {
    title: result.title,
    source: result.primarySource,
    action: result.primaryAction,
    ...(primarySource?.articleUrl ? { articleUrl: primarySource.articleUrl } : {}),
    ...(primarySource?.canonicalId ? { canonicalId: primarySource.canonicalId } : {}),
    ...(result.summary ? { summary: compactPreviewText(result.summary, 500) } : {})
  };
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

export type ToolProfile = "default" | "full";

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
  writePaperWikiPage?: typeof writePaperWikiPage;
  generatePaperWikiSummary?: typeof generatePaperWikiSummary;
  paperWikiRelations?: typeof paperWikiRelations;
  bootstrapPaperWikiPageEvidence?: typeof bootstrapPaperWikiPageEvidence;
  lintPaperWiki?: typeof lintPaperWiki;
  paperSummaryWorker?: PaperSummaryWorker;
  paperWikiPageWorker?: PaperWikiPageWorker;
  searchPaperWiki?: typeof searchPaperWiki;
  listLocalPapers?: typeof listLocalPapers;
  searchLocalPapers?: typeof searchLocalPapers;
  checkWikiHealth?: typeof checkWikiHealth;
  fixWikiHealth?: typeof fixWikiHealth;
  openPaperPageForLogin?: OpenPaperPageForLoginDependency;
  browserSessionFactory?: ReturnType<typeof resolveDefaultPaperBrowserSessionFactory>;
  paperBrowserManagerClient?: PaperBrowserManagerClient;
  extensionBridge?: PaperExtensionBridge;
  usePlaywrightPaperFallback?: boolean;
  toolProfile?: ToolProfile;
}

interface ToolSetMetadata {
  cleanup: () => Promise<void>;
  workspaceDir: string;
}

export type AgentTools = AgentTool<any>[] & ToolSetMetadata;

type ToolProgress = PaperSummaryProgress | WikiHealthFixProgress | ResearchWorkflowProgress;

function emitToolProgress(
  onUpdate: AgentToolUpdateCallback<any> | undefined,
  progress: ToolProgress
): void {
  onUpdate?.({
    content: [{ type: "text", text: progress.message }],
    details: { progress }
  });
}

function compactBuildWikiPageResult(result: BuildWikiPageDetails): Record<string, unknown> {
  return {
    topic: result.topic,
    ...(result.question ? { question: result.question } : {}),
    mode: result.mode,
    status: result.status,
    message: result.message,
    ...(result.bootstrap ? {
      bootstrapStatus: result.bootstrap.status,
      seedQueries: result.bootstrap.seedQueries,
      missingSummaries: result.bootstrap.missingSummaries.map((item) => ({
        paperKey: item.paperKey,
        title: item.title,
        reason: item.reason
      })),
      summariesWritten: result.bootstrap.summariesWritten
    } : {}),
    ...(result.research ? { researchStatus: result.research.status } : {}),
    ...(result.page ? { page: result.page } : {}),
    ...(result.draft && result.mode === "draft" ? { draft: result.draft } : {}),
    ...(result.draft && result.mode !== "draft"
      ? {
          draft: {
            title: result.draft.title,
            confidence: result.draft.confidence,
            groundingWarnings: result.draft.groundingWarnings
          }
        }
      : {}),
    evidence: result.evidence.map((item) => ({
      kind: item.kind,
      key: item.key,
      ...(item.paperKey ? { paperKey: item.paperKey } : {}),
      ...(item.pageKey ? { pageKey: item.pageKey } : {}),
      title: item.title,
      path: item.path
    })),
    blocked: [
      ...(result.bootstrap?.blocked ?? []),
      ...(result.research?.blocked ?? [])
    ],
    externalCandidates: result.research?.externalCandidates ?? []
  };
}

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
  const writePaperWikiPageImpl = dependencies.writePaperWikiPage ?? writePaperWikiPage;
  const generatePaperWikiSummaryImpl = dependencies.generatePaperWikiSummary ?? generatePaperWikiSummary;
  const paperWikiRelationsImpl = dependencies.paperWikiRelations ?? paperWikiRelations;
  const bootstrapPaperWikiPageEvidenceImpl = dependencies.bootstrapPaperWikiPageEvidence ?? bootstrapPaperWikiPageEvidence;
  const lintPaperWikiImpl = dependencies.lintPaperWiki ?? lintPaperWiki;
  const searchPaperWikiImpl = dependencies.searchPaperWiki ?? searchPaperWiki;
  const listLocalPapersImpl = dependencies.listLocalPapers ?? listLocalPapers;
  const searchLocalPapersImpl = dependencies.searchLocalPapers ?? searchLocalPapers;
  const checkWikiHealthImpl = dependencies.checkWikiHealth ?? checkWikiHealth;
  const fixWikiHealthImpl = dependencies.fixWikiHealth ?? fixWikiHealth;
  const browserSessionFactoryImpl =
    dependencies.browserSessionFactory ??
    resolveDefaultPaperBrowserSessionFactory({ workspaceDir: resolvedWorkspaceDir });
  let browserSessionPromise: Promise<PaperBrowserSession> | undefined;
  let paperManagerServerClose: (() => Promise<void>) | undefined;

  const runBootstrapWikiPageEvidence = async (
    args: BootstrapWikiPageEvidenceParameters,
    onUpdate?: AgentToolUpdateCallback<any>
  ): Promise<BootstrapWikiPageEvidenceDetails> => {
    const bootstrapDeps: BootstrapPaperWikiPageEvidenceDependencies = {
      searchPaperWikiImpl,
      searchLocalPapersImpl
    };
    const buildBootstrapOptions = () => ({
      workspaceDir: resolvedWorkspaceDir,
      topic: args.topic,
      ...(args.question ? { question: args.question } : {}),
      ...(args.maxSeedQueries !== undefined ? { maxSeedQueries: args.maxSeedQueries } : {}),
      ...(args.maxSources !== undefined ? { maxSources: args.maxSources } : {}),
      ...(args.includeParsedFallback !== undefined ? { includeParsedFallback: args.includeParsedFallback } : {})
    });
    let bootstrap = await bootstrapPaperWikiPageEvidenceImpl(buildBootstrapOptions(), bootstrapDeps);
    const summariesWritten: ResearchWrittenSummary[] = [];
    const autoSummarizeMissing = args.autoSummarizeMissing ?? true;
    const maxSummariesToGenerate = Math.max(0, Math.trunc(args.maxSummariesToGenerate ?? 3));

    if (autoSummarizeMissing && maxSummariesToGenerate > 0 && bootstrap.missingSummaries.length > 0) {
      if (!dependencies.paperSummaryWorker) {
        bootstrap = {
          ...bootstrap,
          blocked: [
            ...bootstrap.blocked,
            {
              stage: "parsed_fallback",
              reason: "Summary worker is not configured; cannot automatically promote parsed fallback papers into source summaries."
            }
          ]
        };
      } else {
        const selected = bootstrap.missingSummaries.slice(0, maxSummariesToGenerate);
        for (const [index, missing] of selected.entries()) {
          const summary = await generatePaperWikiSummaryImpl({
            workspaceDir: resolvedWorkspaceDir,
            paperKey: missing.paperKey,
            mode: "write",
            summaryWorker: dependencies.paperSummaryWorker,
            onProgress: (summaryProgress) => emitToolProgress(onUpdate, {
              stage: "summary_progress",
              query: args.question ?? args.topic,
              paperKey: missing.paperKey,
              index: index + 1,
              total: selected.length,
              message: `Bootstrap summary ${index + 1}/${selected.length}: ${summaryProgress.message}`,
              summaryProgress
            })
          });
          summariesWritten.push({
            paperKey: missing.paperKey,
            status: summary.status,
            ...(summary.source?.sourcePath ? { sourcePath: summary.source.sourcePath } : {}),
            message: summary.message
          });
        }
        if (summariesWritten.some((summary) => summary.status === "written")) {
          bootstrap = await bootstrapPaperWikiPageEvidenceImpl(buildBootstrapOptions(), bootstrapDeps);
        }
      }
    }

    return {
      ...bootstrap,
      summariesWritten
    };
  };

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
    try {
      const extraction = await fetchPaperWebPageImpl({
        url: buildArxivHtmlUrl(canonicalId)
      });
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
      return undefined;
    }
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
      "Downloads a paper by id or URL through the unified paper manager and closes the reading loop by generating or queuing markdown artifacts. APS, Nature, Science, and arXiv use webpage markdown first; arXiv falls back to TeX source and then PDF parsing, while other PDFs are parsed after download. When downloading a publisher URL from search_papers, pass the returned title so the manager can try an exact-title arXiv preprint fallback if the publisher download fails.",
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
      "Saves an LLM-authored, provenance-tracked paper summary into knowledge-base/wiki/sources/ for later knowledge retrieval. Use after download_paper has produced reading Markdown and the paper has been grounded with read_paper_section/search_paper_text.",
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

  const generatePaperWikiSummaryTool: GeneratePaperWikiSummaryTool = {
    name: "generate_paper_wiki_summary",
    label: "Generate Paper Wiki Summary",
    description:
      "Builds a bounded evidence package from parsed paper Markdown, sends it to a clean-context summary worker, and optionally writes the grounded wiki source summary.",
    parameters: generatePaperWikiSummaryParameters,
    executionMode: "sequential",
    execute: async (
      _toolCallId: string,
      args: GeneratePaperWikiSummaryParameters,
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<any> | undefined
    ) => {
      const result = await generatePaperWikiSummaryImpl({
        workspaceDir: resolvedWorkspaceDir,
        paperKey: args.paperKey,
        ...(args.engine ? { engine: args.engine } : {}),
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.maxEvidenceChars !== undefined ? { maxEvidenceChars: args.maxEvidenceChars } : {}),
        ...(args.includeRelatedCandidates !== undefined
          ? { includeRelatedCandidates: args.includeRelatedCandidates }
          : {}),
        ...(args.maxRelatedCandidates !== undefined ? { maxRelatedCandidates: args.maxRelatedCandidates } : {}),
        ...(args.force !== undefined ? { force: args.force } : {}),
        ...(dependencies.paperSummaryWorker ? { summaryWorker: dependencies.paperSummaryWorker } : {}),
        onProgress: (progress) => emitToolProgress(onUpdate, progress)
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const paperWikiRelationsTool: PaperWikiRelationsTool = {
    name: "paper_wiki_relations",
    label: "Paper Wiki Relations",
    description:
      "Suggests locally related papers for a wiki source and can write confirmed related_papers links into the existing source summary.",
    parameters: paperWikiRelationsParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: PaperWikiRelationsParameters) => {
      const result = await paperWikiRelationsImpl({
        workspaceDir: resolvedWorkspaceDir,
        paperKey: args.paperKey,
        ...(args.maxCandidates !== undefined ? { maxCandidates: args.maxCandidates } : {}),
        ...(args.maxTextChars !== undefined ? { maxTextChars: args.maxTextChars } : {}),
        ...(args.relatedPaperKeys !== undefined ? { relatedPaperKeys: args.relatedPaperKeys } : {}),
        ...(args.mode ? { mode: args.mode } : {})
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
      "Searches LLM-authored paper source summaries and synthesis pages under knowledge-base/wiki/. Use this for knowledge retrieval after paper summaries or wiki pages have been written.",
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

  const wikiLintTool: WikiLintTool = {
    name: "wiki_lint",
    label: "Wiki Lint",
    description:
      "Checks the LLM wiki structure for stale index entries, broken wiki links, missing source citations, orphan synthesis pages, and repeated concepts that should become pages.",
    parameters: wikiLintParameters,
    execute: async (_toolCallId: string, args: WikiLintParameters) => {
      const result = await lintPaperWikiImpl({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const answerPaperWikiQuestionTool: AnswerPaperWikiQuestionTool = {
    name: "answer_paper_wiki_question",
    label: "Answer Paper Wiki Question",
    description:
      "Builds a citeable evidence package from local paper wiki source summaries and synthesis pages for scientific questions. Use concise English search terms when useful, and call this before answering professional paper, physics, quantum, method, experiment, or literature-comparison questions.",
    parameters: answerPaperWikiQuestionParameters,
    execute: async (_toolCallId: string, args: AnswerPaperWikiQuestionParameters) => {
      const result = await buildPaperWikiQuestionEvidence({
        workspaceDir: resolvedWorkspaceDir,
        query: args.query,
        ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}),
        searchPaperWikiImpl,
        searchLocalPapersImpl
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const answerResearchQuestionTool: AnswerResearchQuestionTool = {
    name: "answer_research_question",
    label: "Answer Research Question",
    description:
      "Runs the full evidence-first research workflow: search local paper wiki evidence first, then search/download/parse/summarize external papers only when the local wiki is insufficient. Use this for professional scientific questions that may require knowledge synthesis.",
    parameters: answerResearchQuestionParameters,
    executionMode: "sequential",
    execute: async (
      _toolCallId: string,
      args: AnswerResearchQuestionParameters,
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<any> | undefined
    ) => {
      const maxLocalResults = Math.max(1, Math.trunc(args.maxLocalResults ?? DEFAULT_WIKI_QUESTION_RESULTS));
      const maxExternalCandidates = Math.max(
        1,
        Math.trunc(args.maxExternalCandidates ?? DEFAULT_RESEARCH_EXTERNAL_CANDIDATES)
      );
      const maxDownloads = Math.max(0, Math.trunc(args.maxDownloads ?? DEFAULT_RESEARCH_DOWNLOADS));
      const autoDownload = args.autoDownload ?? true;
      const autoSummarize = args.autoSummarize ?? true;
      emitToolProgress(onUpdate, {
        stage: "local_wiki_search",
        query: args.query,
        message: "Searching local paper wiki evidence."
      });
      const localEvidence = await buildPaperWikiQuestionEvidence({
        workspaceDir: resolvedWorkspaceDir,
        query: args.query,
        maxResults: maxLocalResults,
        searchPaperWikiImpl,
        searchLocalPapersImpl
      });

      if (localEvidence.status === "has_wiki_evidence") {
        emitToolProgress(onUpdate, {
          stage: "local_wiki_found",
          query: args.query,
          message: `Found ${localEvidence.evidence.length} local wiki evidence item(s).`
        });
        const result: AnswerResearchQuestionDetails = {
          query: args.query,
          status: "answered_from_wiki",
          localEvidence,
          externalCandidates: [],
          downloaded: [],
          summariesWritten: [],
          blocked: [],
          answerPolicy: [
            "Answer from localEvidence.evidence.",
            "Cite paperKey or source path next to substantive claims.",
            "Do not use network search because local wiki evidence was found."
          ]
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result
        };
      }

      const blocked: ResearchBlockedItem[] = [];
      let paperResults: PaperSearchResult[] = [];
      emitToolProgress(onUpdate, {
        stage: "external_search",
        query: args.query,
        message: "Local wiki evidence was insufficient; searching external paper candidates."
      });
      try {
        paperResults = await searchPapersImpl({
          query: args.query,
          maxResults: maxExternalCandidates
        });
      } catch (error) {
        blocked.push({
          stage: "external_search",
          reason: error instanceof Error ? error.message : "External paper search failed."
        });
      }
      emitToolProgress(onUpdate, {
        stage: "external_search_done",
        query: args.query,
        message: `Found ${paperResults.length} external paper candidate(s).`
      });
      const externalCandidates = paperResults.map(summarizeResearchCandidate);
      const downloaded: ResearchDownloadedPaper[] = [];
      const summariesWritten: ResearchWrittenSummary[] = [];

      if (autoDownload && maxDownloads > 0) {
        const downloadable = paperResults
          .map((candidate) => ({ candidate, source: findDownloadablePaperSource(candidate) }))
          .filter((item): item is { candidate: PaperSearchResult; source: PaperSearchSource } => item.source !== undefined)
          .slice(0, maxDownloads);

        for (const [index, item] of downloadable.entries()) {
          try {
            emitToolProgress(onUpdate, {
              stage: "download_start",
              query: args.query,
              title: item.candidate.title,
              index: index + 1,
              total: downloadable.length,
              message: `Downloading candidate ${index + 1}/${downloadable.length}: ${item.candidate.title}`
            });
            const downloadResult = await downloadPaperImpl({
              workspaceDir: resolvedWorkspaceDir,
              url: item.source.articleUrl,
              title: item.candidate.title
            });
            const reading = await describeDownloadReadingClosure(downloadResult);
            const paperKey = reading && "paperKey" in reading ? reading.paperKey : undefined;
            downloaded.push({
              title: item.candidate.title,
              source: downloadResult.source,
              status: downloadResult.status,
              articleUrl: downloadResult.articleUrl,
              ...("recordPath" in downloadResult ? { recordPath: downloadResult.recordPath } : {}),
              ...(paperKey ? { paperKey } : {}),
              ...(reading ? { readingStatus: reading.status } : {}),
              ...("message" in downloadResult && typeof downloadResult.message === "string"
                ? { message: downloadResult.message }
                : {}),
              ...(reading && "message" in reading && typeof reading.message === "string"
                ? { message: reading.message }
                : {})
            });
            emitToolProgress(onUpdate, {
              stage: "download_done",
              query: args.query,
              title: item.candidate.title,
              paperKey,
              index: index + 1,
              total: downloadable.length,
              message: `Download finished for ${item.candidate.title} with status ${downloadResult.status}.`
            });

            if (!reading || reading.status === "failed") {
              blocked.push({
                stage: "parse",
                title: item.candidate.title,
                articleUrl: downloadResult.articleUrl,
                reason: reading && "message" in reading ? reading.message : `Downloaded paper status is ${downloadResult.status}, but no parsed reading source is ready.`
              });
              continue;
            }
            if (reading.status === "queued") {
              blocked.push({
                stage: "user_action",
                title: item.candidate.title,
                articleUrl: downloadResult.articleUrl,
                reason: reading.message
              });
              continue;
            }

            if (!autoSummarize) {
              blocked.push({
                stage: "summary",
                title: item.candidate.title,
                paperKey,
                articleUrl: downloadResult.articleUrl,
                reason: "autoSummarize is false; parsed paper was not written into the source-summary wiki."
              });
              continue;
            }
            if (!dependencies.paperSummaryWorker) {
              blocked.push({
                stage: "summary",
                title: item.candidate.title,
                paperKey,
                articleUrl: downloadResult.articleUrl,
                reason: "Summary worker is not configured; cannot automatically write a wiki source summary."
              });
              continue;
            }
            if (!paperKey) {
              blocked.push({
                stage: "summary",
                title: item.candidate.title,
                articleUrl: downloadResult.articleUrl,
                reason: "Parsed reading did not return a paperKey for summary generation."
              });
              continue;
            }

            emitToolProgress(onUpdate, {
              stage: "summary_start",
              query: args.query,
              title: item.candidate.title,
              paperKey,
              index: index + 1,
              total: downloadable.length,
              message: `Generating wiki source summary for ${paperKey}.`
            });
            const summary = await generatePaperWikiSummaryImpl({
              workspaceDir: resolvedWorkspaceDir,
              paperKey,
              mode: "write",
              summaryWorker: dependencies.paperSummaryWorker,
              onProgress: (summaryProgress) => emitToolProgress(onUpdate, {
                stage: "summary_progress",
                query: args.query,
                title: item.candidate.title,
                paperKey,
                index: index + 1,
                total: downloadable.length,
                message: summaryProgress.message,
                summaryProgress
              })
            });
            summariesWritten.push({
              paperKey,
              status: summary.status,
              ...(summary.source?.sourcePath ? { sourcePath: summary.source.sourcePath } : {}),
              message: summary.message
            });
            if (summary.status !== "written") {
              blocked.push({
                stage: "summary",
                title: item.candidate.title,
                paperKey,
                articleUrl: downloadResult.articleUrl,
                reason: summary.message
              });
            }
            emitToolProgress(onUpdate, {
              stage: "summary_done",
              query: args.query,
              title: item.candidate.title,
              paperKey,
              index: index + 1,
              total: downloadable.length,
              message: `Summary step finished for ${paperKey} with status ${summary.status}.`
            });
          } catch (error) {
            blocked.push({
              stage: "download",
              title: item.candidate.title,
              articleUrl: item.source.articleUrl,
              reason: error instanceof Error ? error.message : "Download failed."
            });
          }
        }
      }

      let refreshedEvidence: AnswerPaperWikiQuestionDetails | undefined;
      if (summariesWritten.some((item) => item.status === "written")) {
        emitToolProgress(onUpdate, {
          stage: "refreshed_wiki_search",
          query: args.query,
          message: "Refreshing local wiki evidence after newly written summaries."
        });
        refreshedEvidence = await buildPaperWikiQuestionEvidence({
          workspaceDir: resolvedWorkspaceDir,
          query: args.query,
          maxResults: maxLocalResults,
          searchPaperWikiImpl,
          searchLocalPapersImpl
        });
      }
      const status: ResearchQuestionStatus =
        refreshedEvidence?.status === "has_wiki_evidence"
          ? "expanded_with_new_sources"
          : blocked.length > 0
            ? "needs_user_action"
            : "insufficient_evidence";
      const result: AnswerResearchQuestionDetails = {
        query: args.query,
        status,
        localEvidence,
        ...(refreshedEvidence ? { refreshedEvidence } : {}),
        externalCandidates,
        downloaded,
        summariesWritten,
        blocked,
        answerPolicy: refreshedEvidence?.status === "has_wiki_evidence"
          ? [
              "Answer from refreshedEvidence.evidence.",
              "Cite newly written or existing wiki source paths.",
              "Mention which sources were ingested during this turn when relevant."
            ]
          : [
              "Do not present the answer as fully wiki-grounded.",
              "Explain the local evidence gap and any blocked downloads, queued browser work, authorization, parsing, or summary-worker issues.",
              "Use externalCandidates only as candidate papers until they are downloaded, parsed, and summarized into the wiki."
            ]
      };
      emitToolProgress(onUpdate, {
        stage: "research_done",
        query: args.query,
        message: `Research workflow finished with status ${status}.`
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const bootstrapWikiPageEvidenceTool: BootstrapWikiPageEvidenceTool = {
    name: "bootstrap_wiki_page_evidence",
    label: "Bootstrap Wiki Page Evidence",
    description:
      "Builds an evidence set for a new synthesis page when no page exists yet: multi-query source-summary search, related source expansion, parsed fallback matches, and optional missing-summary generation.",
    parameters: bootstrapWikiPageEvidenceParameters,
    executionMode: "sequential",
    execute: async (
      _toolCallId: string,
      args: BootstrapWikiPageEvidenceParameters,
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<any> | undefined
    ) => {
      const result = await runBootstrapWikiPageEvidence(args, onUpdate);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const buildWikiPageTool: BuildWikiPageTool = {
    name: "build_wiki_page",
    label: "Build Wiki Page",
    description:
      "Builds a higher-level synthesis page under knowledge-base/wiki/pages/ from evidence-first research results. Use this when the user wants the agent to organize accumulated paper evidence into a durable topic wiki page.",
    parameters: buildWikiPageParameters,
    executionMode: "sequential",
    execute: async (
      _toolCallId: string,
      args: BuildWikiPageParameters,
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<any> | undefined
    ) => {
      const mode = args.mode ?? "write";
      const query = args.question ?? args.topic;
      const bootstrap = await runBootstrapWikiPageEvidence({
        topic: args.topic,
        ...(args.question ? { question: args.question } : {}),
        ...(args.maxLocalResults !== undefined ? { maxSources: args.maxLocalResults } : {}),
        autoSummarizeMissing: args.autoSummarize ?? true
      }, onUpdate);
      let research: AnswerResearchQuestionDetails | undefined;
      let evidence: BuildWikiPageDetails["evidence"] = [...bootstrap.sourceEvidence, ...bootstrap.pageContext];
      let sourceEvidence: Array<BuildWikiPageDetails["evidence"][number] & { paperKey: string }> =
        bootstrap.sourceEvidence.filter((item): item is PaperWikiPageBootstrapResult["sourceEvidence"][number] & { paperKey: string } =>
        item.kind === "source" && typeof item.paperKey === "string" && item.paperKey.length > 0
      );

      if (sourceEvidence.length === 0) {
        const researchResult = await answerResearchQuestionTool.execute("research-for-wiki-page", {
          query,
          ...(args.maxLocalResults !== undefined ? { maxLocalResults: args.maxLocalResults } : {}),
          ...(args.maxExternalCandidates !== undefined ? { maxExternalCandidates: args.maxExternalCandidates } : {}),
          ...(args.maxDownloads !== undefined ? { maxDownloads: args.maxDownloads } : {}),
          ...(args.autoDownload !== undefined ? { autoDownload: args.autoDownload } : {}),
          ...(args.autoSummarize !== undefined ? { autoSummarize: args.autoSummarize } : {})
        }, undefined, onUpdate);
        research = researchResult.details as AnswerResearchQuestionDetails;
        evidence = research.refreshedEvidence?.evidence ?? research.localEvidence.evidence;
        sourceEvidence = evidence.filter((item): item is BuildWikiPageDetails["evidence"][number] & { paperKey: string } =>
          item.kind === "source" && typeof item.paperKey === "string" && item.paperKey.length > 0
        );
      }

      if (evidence.length === 0) {
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          bootstrap,
          ...(research ? { research } : {}),
          status: "needs_evidence",
          message:
            "Cannot build a wiki page because no citeable local wiki evidence is available after bootstrap and research workflows.",
          evidence: []
        };
        return {
          content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
          details: result
        };
      }

      if (mode !== "draft" && sourceEvidence.length === 0) {
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          bootstrap,
          ...(research ? { research } : {}),
          status: "needs_evidence",
          message:
            "Cannot write a wiki page because the available local evidence came from synthesis pages only; regenerate from citeable source summaries or run in draft mode.",
          evidence
        };
        return {
          content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
          details: result
        };
      }

      if (!dependencies.paperWikiPageWorker) {
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          bootstrap,
          ...(research ? { research } : {}),
          status: "needs_worker",
          message: "Wiki page worker is not configured; cannot synthesize a topic page automatically.",
          evidence
        };
        return {
          content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
          details: result
        };
      }

      emitToolProgress(onUpdate, {
        stage: "wiki_page_worker_start",
        query,
        message: "Starting clean-context wiki page synthesis worker."
      });
      const draft = await dependencies.paperWikiPageWorker({
        topic: args.topic,
        ...(args.question ? { question: args.question } : {}),
        evidence
      });
      emitToolProgress(onUpdate, {
        stage: "wiki_page_worker_done",
        query,
        message: `Wiki page worker produced draft "${draft.title}".`
      });
      if (mode === "draft") {
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          bootstrap,
          ...(research ? { research } : {}),
          status: "drafted",
          message: "Built a wiki page draft without writing it.",
          draft,
          evidence
        };
        return {
          content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
          details: result
        };
      }

      emitToolProgress(onUpdate, {
        stage: "wiki_page_write",
        query,
        message: "Writing wiki synthesis page."
      });
      const page = await writePaperWikiPageImpl({
        workspaceDir: resolvedWorkspaceDir,
        topic: args.topic,
        ...(args.pageKey ? { pageKey: args.pageKey } : {}),
        title: draft.title,
        pageMarkdown: draft.pageMarkdown,
        ...(draft.tags ? { tags: draft.tags } : {}),
        ...(draft.openQuestions ? { openQuestions: draft.openQuestions } : {}),
        ...(draft.relatedPageKeys ? { relatedPageKeys: draft.relatedPageKeys } : {}),
        sourceCitations: sourceEvidence.map((item) => ({
          paperKey: item.paperKey,
          title: item.title,
          path: item.path
        }))
      });
      const result: BuildWikiPageDetails = {
        topic: args.topic,
        ...(args.question ? { question: args.question } : {}),
        mode,
        bootstrap,
        ...(research ? { research } : {}),
        status: "written",
        message: `Wrote wiki page ${page.pagePath}.`,
        draft,
        page,
        evidence
      };
      return {
        content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
        details: result
      };
    }
  };

  const listLocalPapersTool: ListLocalPapersTool = {
    name: "list_local_papers",
    label: "List Local Papers",
    description:
      "Lists papers already known in the local knowledge base across records, raw PDFs, parsed artifacts, and LLM source summaries.",
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
      "Searches across the local knowledge base, including download records, LLM source summaries, and parsed markdown for all downloaded or parsed papers.",
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
      "Diagnoses local paper knowledge-base health across records, downloads, authorization state, parse quality, wiki summaries, and missing artifacts.",
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
      "Attempts wiki health repairs, such as retrying downloads, parsing downloaded papers, and generating missing summaries through a clean-context summary worker; reports why unresolved issues need user action.",
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

  const tools = [
    webSearchTool,
    fetchUrlTool,
    searchPapersTool,
    downloadPaperTool,
    inspectPaperTool,
    readPaperSectionTool,
    searchPaperTextTool,
    answerPaperWikiQuestionTool,
    answerResearchQuestionTool,
    bootstrapWikiPageEvidenceTool,
    buildWikiPageTool,
    searchLocalPapersTool,
    wikiHealthTool,
    wikiLintTool,
    wikiHealthFixTool
  ] as unknown as AgentTools;

  if (dependencies.toolProfile === "full") {
    tools.unshift(
      getTimeTool,
      readFileTool
    );
    tools.push(
      writePaperWikiSourceTool,
      generatePaperWikiSummaryTool,
      paperWikiRelationsTool,
      searchPaperWikiTool,
      listLocalPapersTool,
      fetchPaperWebpageTool,
      registerManualPaperDownloadTool,
      openPaperPageForLoginTool,
      parsePaperTool
    );
  }

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
