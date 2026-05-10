export type WikiAgentIntent =
  | "answer_scientific_question"
  | "build_topic_page"
  | "maintenance_session";

export type WikiAgentDecision =
  | "answer_from_local_wiki"
  | "acquire_then_summarize"
  | "build_from_fixed_evidence"
  | "plan_maintenance"
  | "report_blocked_or_insufficient";

export type WikiAgentAction =
  | "search_local_evidence"
  | "read_selected_evidence"
  | "search_external_candidates"
  | "download_candidate_papers"
  | "generate_source_summaries"
  | "rerun_local_retrieval"
  | "answer_with_citations"
  | "bootstrap_topic_evidence"
  | "write_synthesis_page"
  | "run_health_and_lint"
  | "produce_structure_plan"
  | "apply_low_risk_repairs"
  | "summarize_remaining_risks";

export interface WikiAgentCoordinationStep {
  action: WikiAgentAction;
  owner: "wiki-agent" | "paper-download-subagent" | "wiki-evidence-worker" | "wiki-synthesis-worker";
  reason: string;
}

export interface WikiAgentCoordinationPlan {
  decision: WikiAgentDecision;
  intent: WikiAgentIntent;
  query?: string;
  steps: WikiAgentCoordinationStep[];
  handoff: Record<string, unknown>;
}

export interface PlanWikiAgentWorkOptions {
  workspaceDir: string;
  intent: WikiAgentIntent;
  query?: string;
  topic?: string;
  localEvidenceCount?: number;
  fixedEvidenceCount?: number;
  hasBlockedAcquisition?: boolean;
  maintenanceIssueCount?: number;
}

interface NormalizedPlanWikiAgentWorkOptions extends PlanWikiAgentWorkOptions {
  localEvidenceCount: number;
  fixedEvidenceCount: number;
  hasBlockedAcquisition: boolean;
  maintenanceIssueCount: number;
}

const actionOwners: Record<WikiAgentAction, WikiAgentCoordinationStep["owner"]> = {
  search_local_evidence: "wiki-evidence-worker",
  read_selected_evidence: "wiki-evidence-worker",
  search_external_candidates: "paper-download-subagent",
  download_candidate_papers: "paper-download-subagent",
  generate_source_summaries: "wiki-evidence-worker",
  rerun_local_retrieval: "wiki-evidence-worker",
  answer_with_citations: "wiki-agent",
  bootstrap_topic_evidence: "wiki-evidence-worker",
  write_synthesis_page: "wiki-synthesis-worker",
  run_health_and_lint: "wiki-agent",
  produce_structure_plan: "wiki-synthesis-worker",
  apply_low_risk_repairs: "wiki-agent",
  summarize_remaining_risks: "wiki-agent"
};

const actionReasons: Record<WikiAgentAction, string> = {
  search_local_evidence: "Check existing wiki evidence before escalating work.",
  read_selected_evidence: "Use selected local evidence as the cited basis for the response.",
  search_external_candidates: "Find candidate papers only when local evidence is insufficient.",
  download_candidate_papers: "Acquire missing papers through the paper download boundary.",
  generate_source_summaries: "Convert acquired papers into reusable wiki source summaries.",
  rerun_local_retrieval: "Refresh local retrieval after new summaries are available.",
  answer_with_citations: "Respond from wiki evidence with explicit citations.",
  bootstrap_topic_evidence: "Prepare the evidence set needed for a topic synthesis page.",
  write_synthesis_page: "Create the topic page from fixed or newly summarized evidence.",
  run_health_and_lint: "Collect deterministic wiki maintenance findings.",
  produce_structure_plan: "Turn maintenance findings into a structure plan.",
  apply_low_risk_repairs: "Apply only low-risk deterministic repairs.",
  summarize_remaining_risks: "Report blocked work, gaps, or risks that remain."
};

function buildSteps(actions: WikiAgentAction[]): WikiAgentCoordinationStep[] {
  return actions.map((action) => ({
    action,
    owner: actionOwners[action],
    reason: actionReasons[action]
  }));
}

function normalizeCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return value;
}

function normalizeOptions(options: PlanWikiAgentWorkOptions): NormalizedPlanWikiAgentWorkOptions {
  return {
    ...options,
    localEvidenceCount: normalizeCount(options.localEvidenceCount),
    fixedEvidenceCount: normalizeCount(options.fixedEvidenceCount),
    hasBlockedAcquisition: options.hasBlockedAcquisition ?? false,
    maintenanceIssueCount: normalizeCount(options.maintenanceIssueCount)
  };
}

function buildHandoff(options: NormalizedPlanWikiAgentWorkOptions): Record<string, unknown> {
  return {
    workspaceDir: options.workspaceDir,
    query: options.query,
    topic: options.topic,
    localEvidenceCount: options.localEvidenceCount,
    fixedEvidenceCount: options.fixedEvidenceCount,
    hasBlockedAcquisition: options.hasBlockedAcquisition,
    maintenanceIssueCount: options.maintenanceIssueCount
  };
}

function createPlan(
  options: NormalizedPlanWikiAgentWorkOptions,
  decision: WikiAgentDecision,
  actions: WikiAgentAction[]
): WikiAgentCoordinationPlan {
  return {
    decision,
    intent: options.intent,
    query: options.query ?? options.topic,
    steps: buildSteps(actions),
    handoff: buildHandoff(options)
  };
}

export async function planWikiAgentWork(
  options: PlanWikiAgentWorkOptions
): Promise<WikiAgentCoordinationPlan> {
  const normalized = normalizeOptions(options);

  if (normalized.intent === "maintenance_session") {
    return createPlan(normalized, "plan_maintenance", [
      "run_health_and_lint",
      "produce_structure_plan",
      "apply_low_risk_repairs",
      "summarize_remaining_risks"
    ]);
  }

  if (normalized.intent === "build_topic_page") {
    if (normalized.fixedEvidenceCount > 0) {
      return createPlan(normalized, "build_from_fixed_evidence", [
        "bootstrap_topic_evidence",
        "read_selected_evidence",
        "write_synthesis_page"
      ]);
    }

    return createPlan(normalized, "acquire_then_summarize", [
      "bootstrap_topic_evidence",
      "search_external_candidates",
      "download_candidate_papers",
      "generate_source_summaries",
      "rerun_local_retrieval",
      "write_synthesis_page"
    ]);
  }

  if (normalized.localEvidenceCount > 0) {
    return createPlan(normalized, "answer_from_local_wiki", [
      "search_local_evidence",
      "read_selected_evidence",
      "answer_with_citations"
    ]);
  }

  if (normalized.hasBlockedAcquisition) {
    return createPlan(normalized, "report_blocked_or_insufficient", [
      "search_local_evidence",
      "summarize_remaining_risks"
    ]);
  }

  return createPlan(normalized, "acquire_then_summarize", [
    "search_local_evidence",
    "search_external_candidates",
    "download_candidate_papers",
    "generate_source_summaries",
    "rerun_local_retrieval",
    "answer_with_citations"
  ]);
}
