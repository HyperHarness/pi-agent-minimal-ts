import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ToolDependencies } from "../tool-types.js";
import {
  mergePaperWikiAliases,
  searchPaperWiki,
  writePaperWikiPage,
  writePaperWikiSource
} from "./content.js";
import { resolveWikiPageKey, sanitizeWikiFilename } from "./store.js";
import {
  bootstrapPaperWikiPageEvidence,
  type BootstrapPaperWikiPageEvidenceDependencies
} from "./bootstrap.js";
import { lintPaperWiki } from "./lint.js";
import type {
  PaperWikiPageBootstrapResult,
  PaperWikiPageWorkerOutput
} from "./types.js";
import {
  generatePaperWikiSummary,
  type PaperSummaryProgress
} from "./summary.js";
import { paperWikiRelations } from "./relations.js";
import { buildWikiPageEvidencePack } from "./evidence-pack.js";
import { applyWikiStructurePlan } from "./structure-apply.js";
import { planWikiStructure } from "./structure-plan.js";
import type { WikiStructurePlanAction } from "./structure-plan.js";
import { reviewWikiPageEvidence } from "./review.js";
import {
  planWikiAgentWork,
  type WikiAgentAction,
  type WikiAgentCoordinationPlan
} from "./coordinator.js";
import {
  getWikiPageTemplate,
  inferWikiPageTypeForEvidence,
  validateRequiredTemplateSections
} from "./page-templates.js";
import { isWikiSourceKind, type WikiSourceKind } from "./manifest-store.js";
import type {
  WikiClaimKind,
  WikiEvidenceContract,
  WikiKnowledgeState,
  WikiPageType
} from "./page-schema.js";
import type { PaperSearchResult, PaperSearchSource } from "../paper/types.js";
import { searchLocalPapers } from "../paper/storage/local-paper-library.js";
import {
  paperReaderEngineParameter,
  type DownloadPaperClosedLoopDetails,
  type DownloadPaperReadingClosure
} from "../paper/tools.js";

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
      description: "Maximum parsed Markdown characters to send to the wiki-evidence-worker summary pass. Defaults to 60000.",
      minimum: 1000
    })
  ),
  includeRelatedCandidates: Type.Optional(
    Type.Boolean({
      description:
        "Include local related-paper candidates in the wiki-evidence-worker evidence package. Defaults to true."
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

const wikiSourceKindParameter = Type.Union([
  Type.Literal("paper"),
  Type.Literal("material-database"),
  Type.Literal("software-doc"),
  Type.Literal("vendor-note"),
  Type.Literal("standard"),
  Type.Literal("lab-note"),
  Type.Literal("code-output"),
  Type.Literal("design-artifact"),
  Type.Literal("webpage"),
  Type.Literal("manual")
], { description: "Wiki source manifest kind to include." });

const wikiPageTypeParameter = Type.Union([
  Type.Literal("paper-source"),
  Type.Literal("synthesis"),
  Type.Literal("concept"),
  Type.Literal("method"),
  Type.Literal("finding"),
  Type.Literal("dataset"),
  Type.Literal("question"),
  Type.Literal("capability-boundary"),
  Type.Literal("design-record"),
  Type.Literal("alias")
], { description: "Typed wiki page type to include." });

const wikiClaimKindParameter = Type.Union([
  Type.Literal("quantitative"),
  Type.Literal("qualitative"),
  Type.Literal("assumption"),
  Type.Literal("limitation")
], { description: "Claim provenance kind to include." });

const wikiKnowledgeStateParameter = Type.Union([
  Type.Literal("established"),
  Type.Literal("promising_unverified"),
  Type.Literal("speculative"),
  Type.Literal("disputed")
], { description: "Knowledge state to include." });

const wikiEvidenceContractParameter = Type.Union([
  Type.Literal("paper-backed"),
  Type.Literal("design-backed"),
  Type.Literal("code-backed"),
  Type.Literal("mixed"),
  Type.Literal("none")
], { description: "Evidence contract to include." });

const searchPaperWikiParameters = Type.Object({
  query: Type.String({ description: "Text query to search inside LLM-authored paper source summaries and synthesis pages." }),
  maxResults: Type.Optional(Type.Integer({ description: "Maximum matching wiki items to return.", minimum: 1 })),
  sourceKinds: Type.Optional(Type.Array(wikiSourceKindParameter, {
    description:
      "Limit matches to source manifest kinds such as paper, code-output, software-doc, or material-database."
  })),
  pageTypes: Type.Optional(Type.Array(wikiPageTypeParameter, {
    description: "Limit page matches to typed wiki page types such as finding, method, dataset, or design-record."
  })),
  claimKinds: Type.Optional(Type.Array(wikiClaimKindParameter, {
    description: "Limit typed page matches to pages with at least one claim of these kinds."
  })),
  knowledgeStates: Type.Optional(Type.Array(wikiKnowledgeStateParameter, {
    description: "Limit typed page matches by knowledge state, such as established, speculative, or disputed."
  })),
  evidenceContracts: Type.Optional(Type.Array(wikiEvidenceContractParameter, {
    description: "Limit typed page matches by evidence contract, such as paper-backed, code-backed, or mixed."
  })),
  maxEvidenceAgeDays: Type.Optional(Type.Integer({
    description: "Warn when wiki evidence was last reviewed or updated older than this many days.",
    minimum: 1
  }))
});

const wikiReviewPageParameters = Type.Object({
  pageKey: Type.String({ description: "Typed wiki page key to review." }),
  maxEvidenceAgeDays: Type.Optional(Type.Integer({
    description: "Warn when last_reviewed_at is older than this many days.",
    minimum: 1
  }))
});

const wikiLintParameters = Type.Object({
  maxItems: Type.Optional(Type.Integer({
    description:
      "Maximum wiki structure issues to return after per-issue-kind display caps are applied. Defaults to 30.",
    minimum: 1
  })),
  goal: Type.Optional(Type.String({ description: "Current wiki optimization goal used to rank concept gaps." })),
  focus: Type.Optional(Type.Array(Type.String({ description: "Focus terms used to rank high-value concept gaps." }))),
  includeCoverage: Type.Optional(Type.Boolean({ description: "Include source/page coverage diagnostics in reports." })),
  includeQualityAudit: Type.Optional(Type.Boolean({ description: "Include page evidence-contract and scope-drift diagnostics." })),
  includeAliasCandidates: Type.Optional(Type.Boolean({ description: "Include semantic alias candidate diagnostics." }))
});

const wikiStructurePlanParameters = Type.Object({
  maxItems: Type.Optional(Type.Integer({
    description:
      "Maximum primary maintenance actions to return. Verification actions may be appended beyond this cap.",
    minimum: 1
  })),
  includeMediumRisk: Type.Optional(Type.Boolean({
    description:
      "Include medium-risk actions such as page merges, page promotion drafts, and rebuild recommendations. Defaults to false."
  })),
  goal: Type.Optional(Type.String({
    description: "Optional research or maintenance goal used to prioritize growth actions."
  })),
  focus: Type.Optional(Type.Array(Type.String({
    description: "Optional focus keyword or concept phrase for goal-aware planning."
  }))),
  includeGrowthActions: Type.Optional(Type.Boolean({
    description: "Include goal-aware concept promotion, alias, and scope-note plan actions. Defaults to false."
  })),
  budget: Type.Optional(Type.Object({
    maxPagesToBuild: Type.Optional(Type.Integer({ description: "Maximum concept pages to recommend building.", minimum: 0 })),
    maxAliasesToCreate: Type.Optional(Type.Integer({ description: "Maximum alias pages to recommend creating.", minimum: 0 })),
    maxScopeNotes: Type.Optional(Type.Integer({ description: "Maximum scope-note updates to recommend.", minimum: 0 }))
  }))
});

const wikiStructurePlanActionParameter = Type.Object({
  id: Type.String({ description: "Action id returned by wiki_structure_plan." }),
  type: Type.String({ description: "Planned action type returned by wiki_structure_plan." }),
  priority: Type.String({ description: "Action priority returned by wiki_structure_plan." }),
  risk: Type.String({ description: "Action risk returned by wiki_structure_plan." }),
  issueKind: Type.String({ description: "Original wiki_lint issue kind." }),
  owner: Type.Optional(Type.String({ description: "Worker role that should own this action." })),
  path: Type.Optional(Type.String({ description: "Workspace-relative target path." })),
  target: Type.Optional(Type.String({ description: "Optional target concept, page, or section title." })),
  concept: Type.Optional(Type.String({ description: "Optional concept gap name." })),
  reason: Type.String({ description: "Reason returned by wiki_structure_plan." }),
  recommendedTool: Type.Optional(Type.String({ description: "Tool recommended by wiki_structure_plan." })),
  recommendedArgs: Type.Optional(Type.Object({}, { description: "Recommended arguments for the tool." })),
  verification: Type.Optional(Type.Array(Type.Object({
    tool: Type.String({ description: "Verification tool to run after applying the action." }),
    args: Type.Object({}, { description: "Verification tool arguments." }),
    expected: Type.String({ description: "Expected verification result." })
  })))
});

const wikiApplyStructurePlanParameters = Type.Object({
  actions: Type.Array(wikiStructurePlanActionParameter, {
    description: "Actions returned by wiki_structure_plan. Unsupported or non-low-risk actions are skipped by default."
  }),
  dryRun: Type.Optional(Type.Boolean({ description: "Preview intended changes without writing files. Defaults to true." })),
  requireLowRisk: Type.Optional(Type.Boolean({ description: "Skip medium/high risk actions. Defaults to true." })),
  maxActions: Type.Optional(Type.Integer({ description: "Maximum actions to process. Defaults to 10.", minimum: 1 })),
  runVerification: Type.Optional(Type.Boolean({ description: "Run wiki_lint before and after the operation. Defaults to true." }))
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
  ),
  maxEvidenceAgeDays: Type.Optional(
    Type.Integer({
      description: "Warn when wiki evidence was last reviewed or updated older than this many days.",
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
  maxEvidenceAgeDays: Type.Optional(
    Type.Integer({
      description: "Warn when local wiki evidence was last reviewed or updated older than this many days.",
      minimum: 1
    })
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
    Type.Boolean({ description: "Whether to write wiki source summaries for newly parsed papers when the wiki-evidence-worker summary pass is configured. Defaults to true." })
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
    Type.Boolean({ description: "Generate missing source summaries for parsed fallback papers when the wiki-evidence-worker summary pass is configured. Defaults to true." })
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
  allowSourceDerivedPageKey: Type.Optional(
    Type.Boolean({
      description:
        "Allow page keys derived from individual paper/source identifiers, such as arxiv-2407-02467-source-coverage. Defaults to false so durable pages use semantic concept keys."
    })
  ),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("draft"),
      Type.Literal("write")
    ], { description: "Build a draft only or write knowledge-base/pages/<page-key>.md. Defaults to write." })
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
    Type.Boolean({
      description:
        "Whether page-building may generate missing source summaries as a prerequisite. Defaults to true. For standalone source-summary backfill or summary_missing health repair, use wiki_health_fix or generate_paper_wiki_summary instead."
    })
  ),
  evidenceContract: Type.Optional(Type.Union([
    Type.Literal("paper-backed"),
    Type.Literal("design-backed"),
    Type.Literal("code-backed"),
    Type.Literal("mixed")
  ], { description: "Evidence contract to write into page frontmatter." })),
  minSources: Type.Optional(Type.Integer({
    description: "Minimum citeable source summaries required before writing. Defaults to 1.",
    minimum: 0
  })),
  requiredSourceKeys: Type.Optional(Type.Array(Type.String({
    description: "Paper keys that must be present in selected source evidence before writing."
  }))),
  forbidExternalEvidence: Type.Optional(
    Type.Boolean({ description: "Do not fall back to external evidence acquisition even outside wiki-agent boundary. Defaults to false." })
  ),
  verifyAfterWrite: Type.Optional(
    Type.Boolean({ description: "Run wiki_lint after writing and include verification summary. Defaults to false." })
  )
});

const mergeWikiAliasesParameters = Type.Object({
  aliases: Type.Array(Type.Object({
    alias: Type.String({
      description:
        "Alias page key or concept phrase to redirect, for example eda or cross-resonance-gates."
    }),
    canonical: Type.String({
      description:
        "Existing canonical wiki page key that should own the maintained synthesis content."
    }),
    title: Type.Optional(Type.String({ description: "Optional display title for the alias page." })),
    note: Type.Optional(Type.String({ description: "Optional short reason for the alias mapping." }))
  }), {
    description: "Alias-to-canonical wiki page mappings to create or update."
  }),
  replaceExisting: Type.Optional(Type.Boolean({
    description:
      "Replace an existing non-alias synthesis page with an alias page. Defaults to false; set true only after confirming the duplicate page should be merged."
  }))
});

const clarifyResearchTopicParameters = Type.Object({
  topic: Type.String({ description: "Broad research direction that needs user steering before a research program starts." }),
  userRequest: Type.Optional(
    Type.String({ description: "Original user request or context that triggered the clarification step." })
  )
});

const researchTopicBootstrapParameters = Type.Object({
  topic: Type.String({ description: "Research direction or durable topic to map into wiki pages." }),
  question: Type.Optional(
    Type.String({ description: "Optional user goal or research question that should shape the research map." })
  ),
  maxSeedQueries: Type.Optional(
    Type.Integer({ description: "Maximum deterministic seed queries to generate. Defaults to 5.", minimum: 1 })
  ),
  maxSources: Type.Optional(
    Type.Integer({ description: "Maximum local source-summary evidence items to inspect. Defaults to 12.", minimum: 1 })
  )
});

const expandResearchTopicParameters = Type.Object({
  topic: Type.String({ description: "Research direction or durable topic to actively expand." }),
  question: Type.Optional(
    Type.String({ description: "Optional user goal or research question that should shape the expansion queries." })
  ),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("plan"),
      Type.Literal("search")
    ], {
      description:
        "Expansion depth for this turn. plan maps local gaps only; search also runs external paper search even when local wiki evidence exists. Defaults to search."
    })
  ),
  maxSeedQueries: Type.Optional(
    Type.Integer({ description: "Maximum seed/gap queries to use. Defaults to 5.", minimum: 1 })
  ),
  maxSources: Type.Optional(
    Type.Integer({ description: "Maximum local evidence items to inspect. Defaults to 12.", minimum: 1 })
  ),
  maxExternalCandidates: Type.Optional(
    Type.Integer({ description: "Maximum external paper candidates to return across expansion queries. Defaults to 8.", minimum: 1 })
  )
});

type WritePaperWikiSourceParameters = Static<typeof writePaperWikiSourceParameters>;
type GeneratePaperWikiSummaryParameters = Static<typeof generatePaperWikiSummaryParameters>;
type PaperWikiRelationsParameters = Static<typeof paperWikiRelationsParameters>;
type SearchPaperWikiParameters = Static<typeof searchPaperWikiParameters>;
type WikiReviewPageParameters = Static<typeof wikiReviewPageParameters>;
type WikiLintParameters = Static<typeof wikiLintParameters>;
type WikiStructurePlanParameters = Static<typeof wikiStructurePlanParameters>;
type WikiApplyStructurePlanParameters = Static<typeof wikiApplyStructurePlanParameters>;
type AnswerPaperWikiQuestionParameters = Static<typeof answerPaperWikiQuestionParameters>;
type AnswerResearchQuestionParameters = Static<typeof answerResearchQuestionParameters>;
type BootstrapWikiPageEvidenceParameters = Static<typeof bootstrapWikiPageEvidenceParameters>;
type BuildWikiPageParameters = Static<typeof buildWikiPageParameters>;
type MergeWikiAliasesParameters = Static<typeof mergeWikiAliasesParameters>;
type ClarifyResearchTopicParameters = Static<typeof clarifyResearchTopicParameters>;
type ResearchTopicBootstrapParameters = Static<typeof researchTopicBootstrapParameters>;
type ExpandResearchTopicParameters = Static<typeof expandResearchTopicParameters>;

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
type WikiReviewPageTool = AgentTool<
  typeof wikiReviewPageParameters,
  Awaited<ReturnType<typeof reviewWikiPageEvidence>>
>;
type WikiLintTool = AgentTool<
  typeof wikiLintParameters,
  Awaited<ReturnType<typeof lintPaperWiki>>
>;
type WikiStructurePlanTool = AgentTool<
  typeof wikiStructurePlanParameters,
  Awaited<ReturnType<typeof planWikiStructure>>
>;
type WikiApplyStructurePlanTool = AgentTool<
  typeof wikiApplyStructurePlanParameters,
  Awaited<ReturnType<typeof applyWikiStructurePlan>>
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
    warnings?: string[];
    matchReasons?: string[];
    knowledgeState?: string;
    lastReviewedAt?: string;
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
type ResearchEvidenceStatus =
  | "local_evidence"
  | "newly_acquired_evidence"
  | "blocked_acquisition"
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
  source: DownloadPaperClosedLoopDetails["source"];
  status: DownloadPaperClosedLoopDetails["status"];
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
  coordination: WikiAgentCoordinationPlan;
  localEvidence: AnswerPaperWikiQuestionDetails;
  refreshedEvidence?: AnswerPaperWikiQuestionDetails;
  evidenceStatus: ResearchEvidenceStatus;
  localEvidenceItems: AnswerPaperWikiQuestionDetails["evidence"];
  newEvidence: AnswerPaperWikiQuestionDetails["evidence"];
  limitations: string[];
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
  coordination: WikiAgentCoordinationPlan;
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
  coordination: WikiAgentCoordinationPlan;
  bootstrap?: BootstrapWikiPageEvidenceDetails;
  research?: AnswerResearchQuestionDetails;
  status: "drafted" | "written" | "needs_evidence" | "needs_worker" | "skipped";
  message: string;
  draft?: PaperWikiPageWorkerOutput;
  evidencePack?: Awaited<ReturnType<typeof buildWikiPageEvidencePack>>;
  page?: Awaited<ReturnType<typeof writePaperWikiPage>>;
  verification?: {
    lintAfter?: Awaited<ReturnType<typeof lintPaperWiki>>;
  };
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
type ClarifyResearchTopicDetails = {
  topic: string;
  userRequest?: string;
  role: "research_assistant";
  userLeads: true;
  status: "needs_user_focus";
  questions: Array<{
    id: string;
    question: string;
    why: string;
  }>;
  defaultAssumptions: string[];
  nextStep: string;
};
type ResearchSuggestedPage = {
  pageKey: string;
  title: string;
  reason: string;
  seedQuery: string;
};
type ResearchGap = {
  id: string;
  title: string;
  reason: string;
  seedQuery: string;
};
type ResearchTopicMap = {
  topic: string;
  question?: string;
  recommendedPageKey: string;
  seedQueries: string[];
  localEvidenceCount: number;
  localPageCount: number;
  missingSummaryCount: number;
  gaps: ResearchGap[];
  suggestedPages: ResearchSuggestedPage[];
  nextActions: string[];
};
type ResearchTopicBootstrapDetails = ResearchTopicMap & {
  bootstrap: BootstrapWikiPageEvidenceDetails;
};
type ExpandResearchTopicDetails = ResearchTopicMap & {
  mode: "plan" | "search";
  bootstrap: BootstrapWikiPageEvidenceDetails;
  externalCandidates: ResearchExternalCandidate[];
  searchedQueries: string[];
  blocked: ResearchBlockedItem[];
  status: "planned" | "searched" | "needs_external_search" | "needs_user_action";
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
  | "research_topic_bootstrap"
  | "research_topic_expand"
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
type MergeWikiAliasesTool = AgentTool<
  typeof mergeWikiAliasesParameters,
  Awaited<ReturnType<typeof mergePaperWikiAliases>>
>;
type ClarifyResearchTopicTool = AgentTool<
  typeof clarifyResearchTopicParameters,
  ClarifyResearchTopicDetails
>;
type ResearchTopicBootstrapTool = AgentTool<
  typeof researchTopicBootstrapParameters,
  ResearchTopicBootstrapDetails
>;
type ExpandResearchTopicTool = AgentTool<
  typeof expandResearchTopicParameters,
  ExpandResearchTopicDetails
>;

const MAX_SEARCH_PREVIEW_TEXT_LENGTH = 220;
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

function describeResearchBlockedItem(item: ResearchBlockedItem): string {
  const subject = item.title ?? item.paperKey ?? item.articleUrl;
  const stage = item.stage.replace(/_/g, " ");
  return subject
    ? `${stage}: ${subject} - ${item.reason}`
    : `${stage}: ${item.reason}`;
}

function buildResearchLimitations(
  blocked: ResearchBlockedItem[],
  localEvidence: AnswerPaperWikiQuestionDetails,
  refreshedEvidence?: AnswerPaperWikiQuestionDetails
): string[] {
  if (localEvidence.evidence.length > 0 || (refreshedEvidence?.evidence.length ?? 0) > 0) {
    return [];
  }
  if (blocked.length > 0) {
    return blocked.map(describeResearchBlockedItem);
  }
  return [
    "Local wiki search found no citeable evidence, and acquisition produced no newly summarized wiki evidence."
  ];
}

async function buildPaperWikiQuestionEvidence(input: {
  workspaceDir: string;
  query: string;
  maxResults?: number;
  maxEvidenceAgeDays?: number;
  searchPaperWikiImpl: typeof searchPaperWiki;
  searchLocalPapersImpl: typeof searchLocalPapers;
}): Promise<AnswerPaperWikiQuestionDetails> {
  const maxResults = Math.max(1, Math.trunc(input.maxResults ?? DEFAULT_WIKI_QUESTION_RESULTS));
  const wikiResult = await input.searchPaperWikiImpl({
    workspaceDir: input.workspaceDir,
    query: input.query,
    maxResults,
    ...(input.maxEvidenceAgeDays !== undefined ? { maxEvidenceAgeDays: input.maxEvidenceAgeDays } : {})
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
      snippet: result.snippet,
      ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
      ...(result.matchReasons !== undefined ? { matchReasons: result.matchReasons } : {}),
      ...(result.knowledgeState !== undefined ? { knowledgeState: result.knowledgeState } : {}),
      ...(result.lastReviewedAt !== undefined ? { lastReviewedAt: result.lastReviewedAt } : {})
    };
  });

  if (evidence.length > 0) {
    const answerPolicy = [
      "Answer from the evidence list only for wiki-grounded claims.",
      "Cite paperKey, pageKey, or path next to substantive claims.",
      "Separate any unsupported background knowledge from wiki-grounded conclusions."
    ];
    if (evidence.some((item) => (item.warnings?.length ?? 0) > 0)) {
      answerPolicy.push(
        "Report evidence warnings such as stale, speculative, disputed, or low-confidence status before drawing conclusions."
      );
    }
    return {
      query: wikiResult.query,
      status: "has_wiki_evidence",
      answerPolicy,
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

function researchCandidateKey(candidate: ResearchExternalCandidate): string {
  return [
    candidate.canonicalId,
    candidate.articleUrl,
    candidate.title.toLowerCase().replace(/\s+/g, " ").trim()
  ].find((value) => value !== undefined && value.length > 0) ?? candidate.title;
}

type ToolProgress = PaperSummaryProgress | ResearchWorkflowProgress;

function emitToolProgress(
  onUpdate: AgentToolUpdateCallback<any> | undefined,
  progress: ToolProgress
): void {
  onUpdate?.({
    content: [{ type: "text", text: progress.message }],
    details: { progress }
  });
}

function normalizePaperEvidenceKey(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueSourceEvidenceByPaperKey<T extends { paperKey: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = normalizePaperEvidenceKey(item.paperKey);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function inferWikiSourceKindsForTemplate(evidence: BuildWikiPageDetails["evidence"]): WikiSourceKind[] {
  const sourceKinds: WikiSourceKind[] = [];
  for (const item of evidence) {
    if (item.kind === "page" || (!item.paperKey && item.kind !== "source")) {
      continue;
    }

    const sourceKind = (item as { sourceKind?: unknown }).sourceKind;
    if (isWikiSourceKind(sourceKind)) {
      sourceKinds.push(sourceKind);
      continue;
    }

    const evidenceKey = item.paperKey ?? item.key ?? "";
    if (evidenceKey.startsWith("material-")) {
      sourceKinds.push("material-database");
    } else if (evidenceKey.startsWith("software-doc-")) {
      sourceKinds.push("software-doc");
    } else {
      sourceKinds.push("paper");
    }
  }
  return [...new Set(sourceKinds)];
}

function formatWikiPageTemplateGuidance(
  template: ReturnType<typeof getWikiPageTemplate>
): string {
  return [
    "Wiki page template guidance:",
    `Page type: ${template.pageType}`,
    "Required sections:",
    ...template.requiredSections.map((section) => `- ${section}`),
    template.guidance
  ].join("\n");
}

function normalizeMarkdownSectionTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasSecondLevelMarkdownSection(markdown: string, title: string): boolean {
  const expected = normalizeMarkdownSectionTitle(title);
  return [...markdown.matchAll(/^##\s+(.+?)\s*#*\s*$/gm)]
    .some((match) => normalizeMarkdownSectionTitle(match[1] ?? "") === expected);
}

function markdownBulletSection(title: string, values: string[], emptyText: string): string {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  const body = cleaned.length > 0
    ? cleaned.map((value) => `- ${value}`).join("\n")
    : emptyText;
  return `\n\n## ${title}\n\n${body}`;
}

function normalizeWikiPageDraftForTemplate(
  draft: PaperWikiPageWorkerOutput,
  template: ReturnType<typeof getWikiPageTemplate>
): PaperWikiPageWorkerOutput {
  if (template.pageType !== "concept") {
    return draft;
  }

  let pageMarkdown = draft.pageMarkdown.trimEnd();
  if (!hasSecondLevelMarkdownSection(pageMarkdown, "Open Questions")) {
    pageMarkdown += markdownBulletSection(
      "Open Questions",
      draft.openQuestions ?? [],
      "No open questions recorded yet."
    );
  }
  if (!hasSecondLevelMarkdownSection(pageMarkdown, "Related Pages")) {
    pageMarkdown += markdownBulletSection(
      "Related Pages",
      (draft.relatedPageKeys ?? []).map((pageKey) => `[[${pageKey}]]`),
      "No related pages recorded yet."
    );
  }

  return {
    ...draft,
    pageMarkdown
  };
}

function markCoordinationInsufficient(
  coordination: WikiAgentCoordinationPlan,
  reason: string,
  handoff: Record<string, unknown> = {},
  actions: WikiAgentAction[] = [
    "search_local_evidence",
    "summarize_remaining_risks"
  ]
): WikiAgentCoordinationPlan {
  const existingSteps = new Map(coordination.steps.map((step) => [step.action, step]));
  const steps = actions.map((action) => existingSteps.get(action) ?? {
    action,
    owner: coordinationOwnerForAction(action),
    reason: action === "summarize_remaining_risks"
      ? reason
      : "Record the workflow step that ran before reporting remaining risks."
  });

  return {
    ...coordination,
    decision: "report_blocked_or_insufficient",
    steps,
    handoff: {
      ...coordination.handoff,
      ...handoff,
      reason
    }
  };
}

function coordinationOwnerForAction(
  action: WikiAgentAction
): WikiAgentCoordinationPlan["steps"][number]["owner"] {
  if (action === "search_external_candidates" || action === "download_candidate_papers") {
    return "paper-download-subagent";
  }
  if (
    action === "search_local_evidence" ||
    action === "read_selected_evidence" ||
    action === "generate_source_summaries" ||
    action === "rerun_local_retrieval" ||
    action === "bootstrap_topic_evidence"
  ) {
    return "wiki-evidence-worker";
  }
  if (action === "write_synthesis_page" || action === "produce_structure_plan") {
    return "wiki-synthesis-worker";
  }
  return "wiki-agent";
}

function assertWikiCoordinationWorkerBoundaries(
  coordination: WikiAgentCoordinationPlan
): WikiAgentCoordinationPlan {
  for (const step of coordination.steps) {
    if (step.action === "download_candidate_papers" && step.owner !== "paper-download-subagent") {
      throw new Error("Wiki coordination boundary violation: download_candidate_papers must be owned by paper-download-subagent.");
    }
    if (step.action === "generate_source_summaries" && step.owner !== "wiki-evidence-worker") {
      throw new Error("Wiki coordination boundary violation: generate_source_summaries must be owned by wiki-evidence-worker.");
    }
    if (step.owner === "wiki-agent" && step.action === "download_candidate_papers") {
      throw new Error("Wiki coordination boundary violation: wiki-agent cannot own download_candidate_papers.");
    }
  }

  return coordination;
}

function compactBuildWikiPageResult(result: BuildWikiPageDetails): Record<string, unknown> {
  return {
    topic: result.topic,
    ...(result.question ? { question: result.question } : {}),
    mode: result.mode,
    status: result.status,
    message: result.message,
    coordination: {
      intent: result.coordination.intent,
      decision: result.coordination.decision,
      steps: result.coordination.steps.map((step) => ({
        action: step.action,
        owner: step.owner
      }))
    },
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
    ...(result.evidencePack ? {
      evidencePack: {
        candidateSummaryCount: result.evidencePack.candidateSummaries.length,
        selectedRawChunkCount: result.evidencePack.selectedRawChunks.length,
        claimProvenanceCount: result.evidencePack.claimProvenance.length,
        contradictionNoteCount: result.evidencePack.contradictionNotes.length,
        diagnostics: result.evidencePack.diagnostics
      }
    } : {}),
    ...(result.page ? { page: result.page } : {}),
    ...(result.verification?.lintAfter ? { verification: { lintAfter: result.verification.lintAfter } } : {}),
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

function buildResearchClarification(topic: string, userRequest?: string): ClarifyResearchTopicDetails {
  return {
    topic,
    ...(userRequest ? { userRequest } : {}),
    role: "research_assistant",
    userLeads: true,
    status: "needs_user_focus",
    questions: [
      {
        id: "research_goal",
        question: "你希望我优先回答哪类问题：入门理解、前沿进展、关键论文谱系、技术路线比较、工程落地，还是某个具体瓶颈？",
        why: "宽泛方向需要先确定研究目标，否则会把综述、教材背景和前沿论文混在一起。"
      },
      {
        id: "scope_boundary",
        question: "这个方向的边界要怎么划：只研究超导硬件本身，还是连同量子纠错、低温电子学、制造工艺、控制软件和系统架构一起研究？",
        why: "边界决定 wiki page 树和外部检索关键词。"
      },
      {
        id: "depth_level",
        question: "你希望研究深度到什么层级：概念框架、能读懂论文、能复现实验/仿真，还是能做选题判断？",
        why: "不同深度对应不同证据标准和阅读队列规模。"
      },
      {
        id: "time_window",
        question: "文献时间范围要偏经典奠基、近五年前沿，还是两者都要但分层组织？",
        why: "研究助手需要区分 foundational papers、milestone experiments 和最新候选论文。"
      },
      {
        id: "deliverable",
        question: "你希望本轮产出是什么：研究路线图、阅读清单、若干 wiki page、对比表，还是围绕一个开放问题的证据包？",
        why: "产出形式决定是否立刻写 page、只建 reading queue，或先继续追引用。"
      }
    ],
    defaultAssumptions: [
      "如果用户不指定，我会先建立研究路线图，而不是直接下载大量论文。",
      "用户是研究主导者；agent 负责提出分支、证据缺口和下一步建议，但不替用户决定长期研究重点。",
      "候选论文必须先进入 source summary，之后才能支撑 wiki page 中的知识性结论。"
    ],
    nextStep:
      "等待用户选择关注点；收到回答后，再运行 research_topic_bootstrap 和 expand_research_topic，并把确认后的范围写入后续 wiki page。"
  };
}

function uniqueStrings(values: string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const compacted = value.replace(/\s+/g, " ").trim();
    const key = compacted.toLowerCase();
    if (!compacted || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(compacted);
    if (unique.length >= maxItems) {
      break;
    }
  }

  return unique;
}

function makeResearchGap(id: string, title: string, topic: string, reason: string): ResearchGap {
  return {
    id,
    title,
    reason,
    seedQuery: `${topic} ${title} recent review benchmark limitations`
  };
}

function makeSuggestedPage(title: string, topic: string, reason: string): ResearchSuggestedPage {
  return {
    pageKey: sanitizeWikiFilename(title.toLowerCase()),
    title,
    reason,
    seedQuery: `${topic} ${title} review experiment roadmap`
  };
}

function inferResearchGaps(topic: string, bootstrap: BootstrapWikiPageEvidenceDetails): ResearchGap[] {
  const text = [
    topic,
    ...bootstrap.seedQueries,
    ...bootstrap.sourceEvidence.map((item) => `${item.title} ${item.snippet}`),
    ...bootstrap.pageContext.map((item) => `${item.title} ${item.snippet}`),
    ...bootstrap.missingSummaries.map((item) => `${item.title} ${item.reason}`)
  ].join(" ").toLowerCase();
  const gaps = [
    makeResearchGap("foundations", "core mechanisms and vocabulary", topic, "A durable direction page needs a stable conceptual baseline before deeper branches."),
    makeResearchGap("frontier", "state-of-the-art experiments and benchmarks", topic, "The wiki should track what results define the current frontier."),
    makeResearchGap("scaling", "scaling bottlenecks and engineering constraints", topic, "Research understanding is incomplete without resource and systems limits."),
    makeResearchGap("errors", "dominant error mechanisms and mitigation", topic, "A useful research map should separate intrinsic noise, correlated errors, and mitigation strategies."),
    makeResearchGap("open-problems", "open questions and competing approaches", topic, "The agent needs explicit frontier questions to drive future page expansion.")
  ];

  if (text.includes("superconduct") || text.includes("超导")) {
    gaps.push(
      makeResearchGap("surface-code", "surface-code logical operations on superconducting processors", topic, "Surface-code demonstrations anchor the error-correction path for this platform."),
      makeResearchGap("cryogenic-control", "cryogenic control electronics and wiring limits", topic, "Control-stack scaling is a central bottleneck beyond qubit count."),
      makeResearchGap("correlated-errors", "correlated errors from radiation and cosmic rays", topic, "Correlated error channels can violate assumptions behind standard thresholds."),
      makeResearchGap("modular-scaling", "modular superconducting quantum computing architectures", topic, "Large systems may require interconnects, modules, and packaging strategies.")
    );
  }

  return gaps;
}

function inferSuggestedPages(topic: string, bootstrap: BootstrapWikiPageEvidenceDetails): ResearchSuggestedPage[] {
  const text = [
    topic,
    ...bootstrap.seedQueries,
    ...bootstrap.sourceEvidence.map((item) => `${item.title} ${item.snippet}`)
  ].join(" ").toLowerCase();
  const pages = [
    makeSuggestedPage(topic, topic, "Root synthesis page for the research direction."),
    makeSuggestedPage(`${topic} research roadmap`, topic, "Tracks frontier questions, evidence gaps, and next reading queues."),
    makeSuggestedPage(`${topic} scaling bottlenecks`, topic, "Separates physics limits from engineering and control-system limits."),
    makeSuggestedPage(`${topic} error mechanisms`, topic, "Collects evidence about decoherence, correlated errors, leakage, and mitigation.")
  ];

  if (text.includes("superconduct") || text.includes("超导")) {
    pages.push(
      makeSuggestedPage("surface code on superconducting processors", topic, "Core branch for threshold, logical-qubit, and cycle-time evidence."),
      makeSuggestedPage("cryogenic control electronics for superconducting qubits", topic, "Needed for million-qubit scaling and wiring constraints."),
      makeSuggestedPage("correlated errors in superconducting qubits", topic, "Needed to understand radiation, cosmic rays, and non-independent faults."),
      makeSuggestedPage("random circuit sampling superconducting benchmarks", topic, "Captures supremacy-style benchmarks and their limits."),
      makeSuggestedPage("modular superconducting quantum computing", topic, "Captures interconnect, packaging, and distributed scaling strategies.")
    );
  }

  return uniqueStrings(pages.map((page) => page.pageKey), 12).map((pageKey) =>
    pages.find((page) => page.pageKey === pageKey) as ResearchSuggestedPage
  );
}

function buildResearchTopicMap(input: {
  topic: string;
  question?: string;
  bootstrap: BootstrapWikiPageEvidenceDetails;
  maxSeedQueries: number;
}): ResearchTopicMap {
  const gaps = inferResearchGaps(input.topic, input.bootstrap);
  const suggestedPages = inferSuggestedPages(input.topic, input.bootstrap);
  const gapQueries = gaps.map((gap) => gap.seedQuery);
  const seedQueries = uniqueStrings([
    ...input.bootstrap.seedQueries,
    ...(input.question ? [input.question] : []),
    ...gapQueries
  ], input.maxSeedQueries);
  const nextActions = [
    "Run expand_research_topic in search mode to collect external paper candidates even if the local wiki already has evidence.",
    "Download, parse, and summarize the highest-value candidates into knowledge-base/sources/ before turning them into claims.",
    "Use build_wiki_page for the root page and the highest-priority suggestedPages once enough citeable source summaries exist.",
    "Repeat expansion from gaps and from newly discovered references until suggestedPages have source-backed pages and wiki_lint no longer reports major concept gaps."
  ];

  return {
    topic: input.topic,
    ...(input.question ? { question: input.question } : {}),
    recommendedPageKey: input.bootstrap.recommendedPageKey || sanitizeWikiFilename(input.topic.toLowerCase()),
    seedQueries,
    localEvidenceCount: input.bootstrap.sourceEvidence.length,
    localPageCount: input.bootstrap.pageContext.length,
    missingSummaryCount: input.bootstrap.missingSummaries.length,
    gaps,
    suggestedPages,
    nextActions
  };
}

function compactResearchTopicResult(result: ResearchTopicBootstrapDetails | ExpandResearchTopicDetails): Record<string, unknown> {
  return {
    topic: result.topic,
    ...(result.question ? { question: result.question } : {}),
    recommendedPageKey: result.recommendedPageKey,
    seedQueries: result.seedQueries,
    localEvidenceCount: result.localEvidenceCount,
    localPageCount: result.localPageCount,
    missingSummaryCount: result.missingSummaryCount,
    gaps: result.gaps,
    suggestedPages: result.suggestedPages,
    ...("mode" in result ? {
      mode: result.mode,
      status: result.status,
      searchedQueries: result.searchedQueries,
      externalCandidates: result.externalCandidates,
      blocked: result.blocked
    } : {}),
    nextActions: result.nextActions
  };
}

export function createWikiTools(input: {
  workspaceDir: string;
  dependencies: ToolDependencies;
  searchPapersTool: AgentTool<any>;
  downloadPaperTool: AgentTool<any>;
  parsePaperTool: AgentTool<any>;
}): {
  defaultTools: AgentTool<any>[];
  defaultToolGroups: {
    coreTools: AgentTool<any>[];
    lintTools: AgentTool<any>[];
  };
  fullTools: AgentTool<any>[];
} {
  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);
  const dependencies = input.dependencies;
  const writePaperWikiSourceImpl = dependencies.writePaperWikiSource ?? writePaperWikiSource;
  const writePaperWikiPageImpl = dependencies.writePaperWikiPage ?? writePaperWikiPage;
  const generatePaperWikiSummaryImpl = dependencies.generatePaperWikiSummary ?? generatePaperWikiSummary;
  const paperWikiRelationsImpl = dependencies.paperWikiRelations ?? paperWikiRelations;
  const bootstrapPaperWikiPageEvidenceImpl = dependencies.bootstrapPaperWikiPageEvidence ?? bootstrapPaperWikiPageEvidence;
  const lintPaperWikiImpl = dependencies.lintPaperWiki ?? lintPaperWiki;
  const planWikiStructureImpl = dependencies.planWikiStructure ?? planWikiStructure;
  const applyWikiStructurePlanImpl = dependencies.applyWikiStructurePlan ?? applyWikiStructurePlan;
  const searchPaperWikiImpl = dependencies.searchPaperWiki ?? searchPaperWiki;
  const searchLocalPapersImpl = dependencies.searchLocalPapers ?? searchLocalPapers;

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

    const coordination = assertWikiCoordinationWorkerBoundaries(await planWikiAgentWork({
      workspaceDir: resolvedWorkspaceDir,
      intent: "build_topic_page",
      topic: args.topic,
      query: args.question ?? args.topic,
      fixedEvidenceCount: bootstrap.sourceEvidence.length,
      hasBlockedAcquisition: bootstrap.blocked.length > 0
    }));

    return {
      ...bootstrap,
      coordination,
      summariesWritten
    };
  };

  const paperSearchTool = input.searchPapersTool;
  const paperDownloadTool = input.downloadPaperTool;
  void input.parsePaperTool;

  const searchPapersImpl = async (args: {
    query: string;
    maxResults?: number;
  }): Promise<PaperSearchResult[]> => {
    const result = await paperSearchTool.execute("internal-search-papers", args, undefined);
    const textItem = result.content?.find((item): item is { type: "text"; text: string } =>
      item.type === "text" && "text" in item && typeof item.text === "string"
    );
    const text = textItem?.text;
    if (text === undefined) {
      throw new Error("search_papers did not return JSON text content.");
    }
    return JSON.parse(text) as PaperSearchResult[];
  };

  const downloadPaperImpl = async (args: {
    workspaceDir?: string;
    id?: string;
    url?: string;
    title?: string;
  }): Promise<DownloadPaperClosedLoopDetails> => {
    const { workspaceDir: _workspaceDir, ...toolArgs } = args;
    const result = await paperDownloadTool.execute("internal-download-paper", toolArgs, undefined);
    if (result.details === undefined || result.details === null) {
      throw new Error("download_paper did not return details.");
    }
    return result.details as DownloadPaperClosedLoopDetails;
  };

  const writePaperWikiSourceTool: WritePaperWikiSourceTool = {
    name: "write_paper_wiki_source",
    label: "Write Paper Wiki Source",
    description:
      "Saves an LLM-authored, provenance-tracked paper summary into knowledge-base/sources/ for later knowledge retrieval. Use after download_paper has produced reading Markdown and the paper has been grounded with read_paper_section/search_paper_text.",
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
      "Builds a bounded evidence package from parsed paper Markdown, sends it to the wiki-evidence-worker summary pass, and optionally writes the grounded wiki source summary.",
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
      "Searches LLM-authored paper source summaries and synthesis pages under knowledge-base/. Use this for knowledge retrieval after paper summaries or wiki pages have been written.",
    parameters: searchPaperWikiParameters,
    execute: async (_toolCallId: string, args: SearchPaperWikiParameters) => {
      const result = await searchPaperWikiImpl({
        workspaceDir: resolvedWorkspaceDir,
        query: args.query,
        ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}),
        ...(args.sourceKinds?.length ? { sourceKinds: args.sourceKinds as WikiSourceKind[] } : {}),
        ...(args.pageTypes?.length ? { pageTypes: args.pageTypes as WikiPageType[] } : {}),
        ...(args.claimKinds?.length ? { claimKinds: args.claimKinds as WikiClaimKind[] } : {}),
        ...(args.knowledgeStates?.length ? { knowledgeStates: args.knowledgeStates as WikiKnowledgeState[] } : {}),
        ...(args.evidenceContracts?.length ? { evidenceContracts: args.evidenceContracts as WikiEvidenceContract[] } : {}),
        ...(args.maxEvidenceAgeDays !== undefined ? { maxEvidenceAgeDays: args.maxEvidenceAgeDays } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const wikiReviewPageTool: WikiReviewPageTool = {
    name: "wiki_review_page",
    label: "Review Wiki Page",
    description:
      "Reviews a typed wiki page for evidence-contract risks such as unsupported claims, stale evidence, speculative or disputed state, and missing caveats.",
    parameters: wikiReviewPageParameters,
    execute: async (_toolCallId: string, args: WikiReviewPageParameters) => {
      const result = await reviewWikiPageEvidence({
        workspaceDir: resolvedWorkspaceDir,
        pageKey: args.pageKey,
        ...(args.maxEvidenceAgeDays !== undefined ? { maxEvidenceAgeDays: args.maxEvidenceAgeDays } : {})
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
        ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.focus !== undefined ? { focus: args.focus } : {}),
        ...(args.includeCoverage !== undefined ? { includeCoverage: args.includeCoverage } : {}),
        ...(args.includeQualityAudit !== undefined ? { includeQualityAudit: args.includeQualityAudit } : {}),
        ...(args.includeAliasCandidates !== undefined ? { includeAliasCandidates: args.includeAliasCandidates } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const wikiStructurePlanTool: WikiStructurePlanTool = {
    name: "wiki_structure_plan",
    label: "Wiki Structure Plan",
    description:
      "Creates a reviewable structural maintenance plan from wiki_lint findings. It suggests low-risk actions by default and does not rewrite wiki content.",
    parameters: wikiStructurePlanParameters,
    execute: async (_toolCallId: string, args: WikiStructurePlanParameters) => {
      const result = await planWikiStructureImpl({
        workspaceDir: resolvedWorkspaceDir,
        ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
        ...(args.includeMediumRisk !== undefined ? { includeMediumRisk: args.includeMediumRisk } : {}),
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.focus !== undefined ? { focus: args.focus } : {}),
        ...(args.includeGrowthActions !== undefined ? { includeGrowthActions: args.includeGrowthActions } : {}),
        ...(args.budget !== undefined ? { budget: args.budget } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const wikiApplyStructurePlanTool: WikiApplyStructurePlanTool = {
    name: "wiki_apply_structure_plan",
    label: "Apply Wiki Structure Plan",
    description:
      "Applies approved wiki_structure_plan actions with dry-run and low-risk safeguards, including deterministic duplicate-section cleanup, safe duplicate-page merges, alias creation, index rebuilds, and constrained scope-note updates.",
    parameters: wikiApplyStructurePlanParameters,
    execute: async (_toolCallId: string, args: WikiApplyStructurePlanParameters) => {
      const result = await applyWikiStructurePlanImpl({
        workspaceDir: resolvedWorkspaceDir,
        actions: args.actions as WikiStructurePlanAction[],
        ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
        ...(args.requireLowRisk !== undefined ? { requireLowRisk: args.requireLowRisk } : {}),
        ...(args.maxActions !== undefined ? { maxActions: args.maxActions } : {}),
        ...(args.runVerification !== undefined ? { runVerification: args.runVerification } : {})
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
        ...(args.maxEvidenceAgeDays !== undefined ? { maxEvidenceAgeDays: args.maxEvidenceAgeDays } : {}),
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
        ...(args.maxEvidenceAgeDays !== undefined ? { maxEvidenceAgeDays: args.maxEvidenceAgeDays } : {}),
        searchPaperWikiImpl,
        searchLocalPapersImpl
      });

      if (localEvidence.status === "has_wiki_evidence") {
        emitToolProgress(onUpdate, {
          stage: "local_wiki_found",
          query: args.query,
          message: `Found ${localEvidence.evidence.length} local wiki evidence item(s).`
        });
        const coordination = assertWikiCoordinationWorkerBoundaries(await planWikiAgentWork({
          workspaceDir: resolvedWorkspaceDir,
          intent: "answer_scientific_question",
          query: args.query,
          localEvidenceCount: localEvidence.evidence.length
        }));
        const result: AnswerResearchQuestionDetails = {
          query: args.query,
          status: "answered_from_wiki",
          coordination,
          localEvidence,
          evidenceStatus: "local_evidence",
          localEvidenceItems: localEvidence.evidence,
          newEvidence: [],
          limitations: [],
          externalCandidates: [],
          downloaded: [],
          summariesWritten: [],
          blocked: [],
          answerPolicy: [
            "Answer from localEvidence.evidence.",
            "Cite paperKey or source path next to substantive claims.",
            "Preserve and report any local evidence warnings before presenting conclusions.",
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
            const reading = downloadResult.reading;
            const paperKey = reading && "paperKey" in reading ? reading.paperKey : undefined;
            downloaded.push({
              title: item.candidate.title,
              source: downloadResult.source,
              status: downloadResult.status,
              articleUrl: downloadResult.articleUrl ?? item.source.articleUrl,
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
          ...(args.maxEvidenceAgeDays !== undefined ? { maxEvidenceAgeDays: args.maxEvidenceAgeDays } : {}),
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
      const newEvidence = refreshedEvidence?.status === "has_wiki_evidence"
        ? refreshedEvidence.evidence
        : [];
      const hasRefreshedEvidence = newEvidence.length > 0;
      const evidenceStatus: ResearchEvidenceStatus = hasRefreshedEvidence
        ? "newly_acquired_evidence"
        : blocked.length > 0
          ? "blocked_acquisition"
          : "insufficient_evidence";
      const acquisitionAttemptDisabled = !autoDownload || maxDownloads === 0;
      const baseCoordination = assertWikiCoordinationWorkerBoundaries(await planWikiAgentWork({
        workspaceDir: resolvedWorkspaceDir,
        intent: "answer_scientific_question",
        query: args.query,
        localEvidenceCount: 0,
        hasBlockedAcquisition: blocked.length > 0 && !hasRefreshedEvidence
      }));
      const downloadWasAttempted = downloaded.length > 0 || blocked.some((item) =>
        item.stage === "download" ||
        item.stage === "parse" ||
        item.stage === "summary" ||
        item.stage === "user_action"
      );
      const insufficientResearchActions: WikiAgentAction[] = [
        "search_local_evidence",
        "search_external_candidates",
        ...(downloadWasAttempted ? ["download_candidate_papers" as const] : []),
        ...(summariesWritten.length > 0 ? ["generate_source_summaries" as const] : []),
        ...(refreshedEvidence ? ["rerun_local_retrieval" as const] : []),
        "summarize_remaining_risks"
      ];
      const coordination = assertWikiCoordinationWorkerBoundaries(
        !hasRefreshedEvidence
          ? markCoordinationInsufficient(
              baseCoordination,
              acquisitionAttemptDisabled
                ? !autoDownload
                  ? "autoDownload is false; no paper download acquisition was attempted."
                  : "maxDownloads is 0; no paper download acquisition was attempted."
                : blocked.length > 0
                  ? "Research workflow ended with blocked acquisition and no refreshed wiki evidence."
                  : "Research workflow found insufficient evidence after local and external checks.",
              acquisitionAttemptDisabled
                ? {
                    autoDownload,
                    maxDownloads
                  }
                : {},
              insufficientResearchActions
            )
          : baseCoordination
      );
      const result: AnswerResearchQuestionDetails = {
        query: args.query,
        status,
        coordination,
        localEvidence,
        ...(refreshedEvidence ? { refreshedEvidence } : {}),
        evidenceStatus,
        localEvidenceItems: localEvidence.evidence,
        newEvidence,
        limitations: buildResearchLimitations(blocked, localEvidence, refreshedEvidence),
        externalCandidates,
        downloaded,
        summariesWritten,
        blocked,
        answerPolicy: refreshedEvidence?.status === "has_wiki_evidence"
          ? [
              "Answer from refreshedEvidence.evidence.",
              "Cite newly written or existing wiki source paths.",
              "Preserve and report any local evidence warnings before presenting conclusions.",
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
      "Builds a higher-level synthesis page under knowledge-base/pages/ from evidence-first research results. Use this when the user wants the agent to organize accumulated paper evidence into a durable topic wiki page. Do not use this for standalone source-summary backfill or summary_missing health repair.",
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
      const buildCoordination = async (options: {
        selectedEvidenceCount: number;
        hasBlockedAcquisition?: boolean;
        insufficientReason?: string;
        handoff?: Record<string, unknown>;
      }): Promise<WikiAgentCoordinationPlan> => {
        const insufficientActions = (): WikiAgentAction[] => {
          const actions: WikiAgentAction[] = ["bootstrap_topic_evidence"];
          if (options.selectedEvidenceCount > 0) {
            actions.push("read_selected_evidence");
          }
          if (research) {
            for (const step of research.coordination.steps) {
              if (step.action !== "answer_with_citations" && step.action !== "summarize_remaining_risks") {
                actions.push(step.action);
              }
            }
          }
          actions.push("summarize_remaining_risks");
          return [...new Set(actions)];
        };
        const plan = assertWikiCoordinationWorkerBoundaries(await planWikiAgentWork({
          workspaceDir: resolvedWorkspaceDir,
          intent: "build_topic_page",
          topic: args.topic,
          query,
          fixedEvidenceCount: options.selectedEvidenceCount,
          hasBlockedAcquisition: options.hasBlockedAcquisition ?? false
        }));

        return assertWikiCoordinationWorkerBoundaries(options.insufficientReason
          ? markCoordinationInsufficient(plan, options.insufficientReason, options.handoff, insufficientActions())
          : plan);
      };

      const allowExternalEvidence =
        (dependencies.allowBuildWikiPageExternalEvidence ?? true) && args.forbidExternalEvidence !== true;
      const needsExternalEvidenceForWrite = sourceEvidence.length === 0 && mode !== "draft";
      const needsAnyEvidenceForDraft = evidence.length === 0 && mode === "draft";

      if ((needsExternalEvidenceForWrite || needsAnyEvidenceForDraft) && !allowExternalEvidence) {
        const coordination = await buildCoordination({
          selectedEvidenceCount: evidence.length,
          hasBlockedAcquisition: bootstrap.blocked.length > 0,
          insufficientReason:
            mode === "draft"
              ? "External evidence acquisition is disabled and no local wiki evidence is available for a draft."
              : "External evidence acquisition is disabled and no citeable source summaries are available for writing.",
          handoff: {
            allowExternalEvidence: false,
            forbidExternalEvidence: args.forbidExternalEvidence === true
          }
        });
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          coordination,
          bootstrap,
          status: "needs_evidence",
          message:
            mode === "draft"
              ? "Cannot build a wiki page draft because no local wiki evidence is available and external evidence acquisition is disabled for this tool boundary."
              : "Cannot write a wiki page because no citeable source summaries are available and external evidence acquisition is disabled for this tool boundary.",
          evidence
        };
        return {
          content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
          details: result
        };
      }

      if (sourceEvidence.length === 0 && allowExternalEvidence) {
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

      sourceEvidence = uniqueSourceEvidenceByPaperKey(sourceEvidence);
      evidence = [
        ...sourceEvidence,
        ...evidence.filter((item) => item.kind !== "source")
      ];

      if (evidence.length === 0) {
        const coordination = await buildCoordination({
          selectedEvidenceCount: 0,
          hasBlockedAcquisition: (research?.blocked.length ?? bootstrap.blocked.length) > 0,
          insufficientReason: "No citeable local wiki evidence is available after bootstrap and research workflows."
        });
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          coordination,
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
        const coordination = await buildCoordination({
          selectedEvidenceCount: evidence.length,
          hasBlockedAcquisition: (research?.blocked.length ?? bootstrap.blocked.length) > 0,
          insufficientReason: "Available evidence came from synthesis pages only; source citations are required before writing."
        });
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          coordination,
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

      const minSources = Math.max(0, Math.trunc(args.minSources ?? 1));
      const requiredSourceKeys = new Set((args.requiredSourceKeys ?? []).map(normalizePaperEvidenceKey));
      const presentSourceKeys = new Set(sourceEvidence.map((item) => normalizePaperEvidenceKey(item.paperKey)));
      const missingRequiredSourceKeys = [...requiredSourceKeys]
        .filter((paperKey) => !presentSourceKeys.has(paperKey));
      const evidenceContract = args.evidenceContract;
      if (mode !== "draft" && sourceEvidence.length < minSources) {
        const coordination = await buildCoordination({
          selectedEvidenceCount: evidence.length,
          hasBlockedAcquisition: (research?.blocked.length ?? bootstrap.blocked.length) > 0,
          insufficientReason: `Minimum source count ${minSources} is not met; found ${sourceEvidence.length}.`,
          handoff: {
            minSources,
            sourceEvidenceCount: sourceEvidence.length
          }
        });
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          coordination,
          bootstrap,
          ...(research ? { research } : {}),
          status: "needs_evidence",
          message: `Cannot write a wiki page because minimum source count ${minSources} is not met; found ${sourceEvidence.length}.`,
          evidence
        };
        return {
          content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
          details: result
        };
      }
      if (mode !== "draft" && missingRequiredSourceKeys.length > 0) {
        const coordination = await buildCoordination({
          selectedEvidenceCount: evidence.length,
          hasBlockedAcquisition: (research?.blocked.length ?? bootstrap.blocked.length) > 0,
          insufficientReason: `Required source keys are missing: ${missingRequiredSourceKeys.join(", ")}.`,
          handoff: {
            missingRequiredSourceKeys
          }
        });
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          coordination,
          bootstrap,
          ...(research ? { research } : {}),
          status: "needs_evidence",
          message: `Cannot write a wiki page because required source keys are missing: ${missingRequiredSourceKeys.join(", ")}.`,
          evidence
        };
        return {
          content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
          details: result
        };
      }

      if (!dependencies.paperWikiPageWorker) {
        const coordination = await buildCoordination({
          selectedEvidenceCount: evidence.length,
          hasBlockedAcquisition: (research?.blocked.length ?? bootstrap.blocked.length) > 0,
          insufficientReason: "Wiki page worker is not configured; synthesis cannot be completed automatically."
        });
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          coordination,
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
      const template = getWikiPageTemplate(inferWikiPageTypeForEvidence({
        query: [args.topic, args.question].filter(Boolean).join("\n"),
        sourceKinds: inferWikiSourceKindsForTemplate(evidence)
      }));
      const evidencePack = await buildWikiPageEvidencePack({
        workspaceDir: resolvedWorkspaceDir,
        query,
        evidence
      });
      const rawDraft = await dependencies.paperWikiPageWorker({
        topic: args.topic,
        ...(args.question ? { question: args.question } : {}),
        templateGuidance: formatWikiPageTemplateGuidance(template),
        evidence,
        evidencePack
      });
      const draft = normalizeWikiPageDraftForTemplate(rawDraft, template);
      emitToolProgress(onUpdate, {
        stage: "wiki_page_worker_done",
        query,
        message: `Wiki page worker produced draft "${draft.title}".`
      });
      if (mode === "draft") {
        const coordination = await buildCoordination({
          selectedEvidenceCount: evidence.length,
          hasBlockedAcquisition: (research?.blocked.length ?? bootstrap.blocked.length) > 0
        });
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          coordination,
          bootstrap,
          ...(research ? { research } : {}),
          status: "drafted",
          message: "Built a wiki page draft without writing it.",
          draft,
          evidencePack,
          evidence
        };
        return {
          content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
          details: result
        };
      }

      const missingTemplateSections = validateRequiredTemplateSections({
        pageType: template.pageType,
        markdown: draft.pageMarkdown
      }).missingSections;
      if (missingTemplateSections.length > 0) {
        const coordination = await buildCoordination({
          selectedEvidenceCount: evidence.length,
          hasBlockedAcquisition: (research?.blocked.length ?? bootstrap.blocked.length) > 0,
          insufficientReason: `Wiki page draft is missing required ${template.pageType} section${
            missingTemplateSections.length === 1 ? "" : "s"
          }: ${missingTemplateSections.join(", ")}.`,
          handoff: {
            pageType: template.pageType,
            missingTemplateSections
          }
        });
        const result: BuildWikiPageDetails = {
          topic: args.topic,
          ...(args.question ? { question: args.question } : {}),
          mode,
          coordination,
          bootstrap,
          ...(research ? { research } : {}),
          status: "needs_worker",
          message: `Cannot write a wiki page because the draft is missing required ${template.pageType} sections: ${missingTemplateSections.join(", ")}.`,
          draft,
          evidencePack,
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
      const pageKey = resolveWikiPageKey({
        topic: args.topic,
        ...(args.pageKey ? { pageKey: args.pageKey } : {}),
        title: draft.title,
        ...(args.allowSourceDerivedPageKey ? { allowSourceDerivedPageKey: true } : {})
      });
      const page = await writePaperWikiPageImpl({
        workspaceDir: resolvedWorkspaceDir,
        topic: args.topic,
        pageKey,
        ...(args.allowSourceDerivedPageKey ? { allowSourceDerivedPageKey: true } : {}),
        title: draft.title,
        pageMarkdown: draft.pageMarkdown,
        ...(draft.tags ? { tags: draft.tags } : {}),
        ...(draft.openQuestions ? { openQuestions: draft.openQuestions } : {}),
        ...(draft.relatedPageKeys ? { relatedPageKeys: draft.relatedPageKeys } : {}),
        ...(evidenceContract ? { evidenceContract } : {}),
        sourceCitations: sourceEvidence.map((item) => ({
          paperKey: item.paperKey,
          title: item.title,
          path: item.path
        }))
      });
      const verification = args.verifyAfterWrite
        ? { lintAfter: await lintPaperWiki({ workspaceDir: resolvedWorkspaceDir, maxItems: 100 }) }
        : undefined;
      const result: BuildWikiPageDetails = {
        topic: args.topic,
        ...(args.question ? { question: args.question } : {}),
        mode,
        coordination: await buildCoordination({
          selectedEvidenceCount: evidence.length,
          hasBlockedAcquisition: (research?.blocked.length ?? bootstrap.blocked.length) > 0
        }),
        bootstrap,
        ...(research ? { research } : {}),
        status: "written",
        message: `Wrote wiki page ${page.pagePath}.`,
        draft,
        evidencePack,
        page,
        ...(verification ? { verification } : {}),
        evidence
      };
      return {
        content: [{ type: "text", text: JSON.stringify(compactBuildWikiPageResult(result)) }],
        details: result
      };
    }
  };

  const mergeWikiAliasesTool: MergeWikiAliasesTool = {
    name: "merge_wiki_aliases",
    label: "Merge Wiki Aliases",
    description:
      "Creates or updates lightweight alias pages under knowledge-base/pages/ that point deliberate acronyms or synonyms to an existing canonical synthesis page. For existing duplicate pages, including simple plurals or compact spellings such as surface-codes/surface-code or su2/su-2, use wiki_lint, wiki_structure_plan, and wiki_apply_structure_plan so the redundant page is merged and deleted instead of kept as an alias page. It refuses to overwrite existing non-alias synthesis pages unless replaceExisting=true.",
    parameters: mergeWikiAliasesParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: MergeWikiAliasesParameters) => {
      const result = await mergePaperWikiAliases({
        workspaceDir: resolvedWorkspaceDir,
        aliases: args.aliases,
        ...(args.replaceExisting !== undefined ? { replaceExisting: args.replaceExisting } : {})
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const clarifyResearchTopicTool: ClarifyResearchTopicTool = {
    name: "clarify_research_topic",
    label: "Clarify Research Topic",
    description:
      "Asks focused steering questions before starting a broad research program. Use this when the user gives a wide research direction but has not specified focus, boundary, depth, time window, or desired output.",
    parameters: clarifyResearchTopicParameters,
    execute: async (_toolCallId: string, args: ClarifyResearchTopicParameters) => {
      const result = buildResearchClarification(args.topic, args.userRequest);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const researchTopicBootstrapTool: ResearchTopicBootstrapTool = {
    name: "research_topic_bootstrap",
    label: "Research Topic Bootstrap",
    description:
      "Maps a research direction into local evidence, gaps, seed queries, and suggested durable wiki pages. Use this before running a long-horizon research program.",
    parameters: researchTopicBootstrapParameters,
    executionMode: "sequential",
    execute: async (
      _toolCallId: string,
      args: ResearchTopicBootstrapParameters,
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<any> | undefined
    ) => {
      const maxSeedQueries = Math.max(1, Math.trunc(args.maxSeedQueries ?? 5));
      emitToolProgress(onUpdate, {
        stage: "research_topic_bootstrap",
        query: args.question ?? args.topic,
        message: `Bootstrapping research map for ${args.topic}.`
      });
      const bootstrap = await runBootstrapWikiPageEvidence({
        topic: args.topic,
        ...(args.question ? { question: args.question } : {}),
        maxSeedQueries,
        ...(args.maxSources !== undefined ? { maxSources: args.maxSources } : {}),
        autoSummarizeMissing: false
      }, onUpdate);
      const topicMap = buildResearchTopicMap({
        topic: args.topic,
        ...(args.question ? { question: args.question } : {}),
        bootstrap,
        maxSeedQueries
      });
      const result: ResearchTopicBootstrapDetails = {
        ...topicMap,
        bootstrap
      };

      return {
        content: [{ type: "text", text: JSON.stringify(compactResearchTopicResult(result)) }],
        details: result
      };
    }
  };

  const expandResearchTopicTool: ExpandResearchTopicTool = {
    name: "expand_research_topic",
    label: "Expand Research Topic",
    description:
      "Actively expands a research direction. Unlike answer_research_question, search mode runs external paper search even when local wiki evidence already exists, so the wiki can keep growing.",
    parameters: expandResearchTopicParameters,
    executionMode: "sequential",
    execute: async (
      _toolCallId: string,
      args: ExpandResearchTopicParameters,
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<any> | undefined
    ) => {
      const mode = args.mode ?? "search";
      const maxSeedQueries = Math.max(1, Math.trunc(args.maxSeedQueries ?? 5));
      const maxExternalCandidates = Math.max(
        1,
        Math.trunc(args.maxExternalCandidates ?? Math.max(DEFAULT_RESEARCH_EXTERNAL_CANDIDATES, 8))
      );
      emitToolProgress(onUpdate, {
        stage: "research_topic_expand",
        query: args.question ?? args.topic,
        message: `Expanding research topic ${args.topic} in ${mode} mode.`
      });
      const bootstrap = await runBootstrapWikiPageEvidence({
        topic: args.topic,
        ...(args.question ? { question: args.question } : {}),
        maxSeedQueries,
        ...(args.maxSources !== undefined ? { maxSources: args.maxSources } : {}),
        autoSummarizeMissing: false
      }, onUpdate);
      const topicMap = buildResearchTopicMap({
        topic: args.topic,
        ...(args.question ? { question: args.question } : {}),
        bootstrap,
        maxSeedQueries
      });
      const blocked: ResearchBlockedItem[] = [];
      const externalCandidates: ResearchExternalCandidate[] = [];
      const seenCandidates = new Set<string>();
      const searchedQueries: string[] = [];

      if (mode === "search") {
        for (const query of topicMap.seedQueries) {
          if (externalCandidates.length >= maxExternalCandidates) {
            break;
          }
          searchedQueries.push(query);
          emitToolProgress(onUpdate, {
            stage: "external_search",
            query,
            message: `Searching external papers for research expansion: ${query}`
          });
          try {
            const remaining = Math.max(1, maxExternalCandidates - externalCandidates.length);
            const paperResults = await searchPapersImpl({
              query,
              maxResults: Math.min(DEFAULT_RESEARCH_EXTERNAL_CANDIDATES, remaining)
            });
            for (const candidate of paperResults.map(summarizeResearchCandidate)) {
              const key = researchCandidateKey(candidate);
              if (seenCandidates.has(key)) {
                continue;
              }
              seenCandidates.add(key);
              externalCandidates.push(candidate);
              if (externalCandidates.length >= maxExternalCandidates) {
                break;
              }
            }
          } catch (error) {
            blocked.push({
              stage: "external_search",
              reason: error instanceof Error ? error.message : `External paper search failed for query: ${query}`
            });
          }
        }
        emitToolProgress(onUpdate, {
          stage: "external_search_done",
          query: args.question ?? args.topic,
          message: `Research expansion found ${externalCandidates.length} external paper candidate(s).`
        });
      }

      const result: ExpandResearchTopicDetails = {
        ...topicMap,
        mode,
        bootstrap,
        externalCandidates,
        searchedQueries,
        blocked,
        status: mode === "plan"
          ? "planned"
          : externalCandidates.length > 0
            ? "searched"
            : blocked.length > 0
              ? "needs_user_action"
              : "needs_external_search"
      };

      return {
        content: [{ type: "text", text: JSON.stringify(compactResearchTopicResult(result)) }],
        details: result
      };
    }
  };
  const coreTools = [
    answerPaperWikiQuestionTool,
    answerResearchQuestionTool,
    bootstrapWikiPageEvidenceTool,
    buildWikiPageTool,
    mergeWikiAliasesTool,
    clarifyResearchTopicTool,
    researchTopicBootstrapTool,
    expandResearchTopicTool,
    wikiReviewPageTool
  ];
  const lintTools = [wikiLintTool, wikiStructurePlanTool, wikiApplyStructurePlanTool];

  return {
    defaultTools: [
      ...coreTools,
      ...lintTools
    ],
    defaultToolGroups: {
      coreTools,
      lintTools
    },
    fullTools: [
      writePaperWikiSourceTool,
      generatePaperWikiSummaryTool,
      paperWikiRelationsTool,
      searchPaperWikiTool
    ]
  };
}
