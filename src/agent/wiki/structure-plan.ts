import { lintPaperWiki, type PaperWikiLintIssue } from "./lint.js";

export type WikiStructureActionType =
  | "merge_duplicate_pages"
  | "create_alias"
  | "fix_duplicate_section"
  | "fix_rendered_wiki_link"
  | "rebuild_weak_page"
  | "promote_concept"
  | "update_scope_note"
  | "rebuild_index"
  | "verify";

export type WikiStructureRisk = "low" | "medium" | "high";
export type WikiStructurePriority = "high" | "medium" | "low";
export type WikiStructureOwner = "wiki-agent" | "paper-download-subagent" | "wiki-evidence-worker";
export type WikiStructureRecommendedTool =
  | "merge_wiki_aliases"
  | "build_wiki_page"
  | "replace_file_text"
  | "wiki_apply_structure_plan"
  | "wiki_lint"
  | "wiki_health"
  | "wiki_health_fix";

export interface WikiStructurePlanVerification {
  tool: "wiki_lint" | "wiki_health" | "search_paper_wiki" | "answer_paper_wiki_question";
  args: unknown;
  expected: string;
}

export interface WikiStructurePlanAction {
  id: string;
  type: WikiStructureActionType;
  priority: WikiStructurePriority;
  risk: WikiStructureRisk;
  issueKind: PaperWikiLintIssue["kind"];
  owner: WikiStructureOwner;
  path?: string;
  target?: string;
  concept?: string;
  reason: string;
  recommendedTool?: WikiStructureRecommendedTool;
  recommendedArgs?: unknown;
  verification?: WikiStructurePlanVerification[];
}

export interface WikiStructurePlanBudget {
  maxPagesToBuild?: number;
  maxAliasesToCreate?: number;
  maxScopeNotes?: number;
}

export interface WikiStructurePlanOptions {
  workspaceDir: string;
  maxItems?: number;
  includeMediumRisk?: boolean;
  goal?: string;
  focus?: string[];
  includeGrowthActions?: boolean;
  budget?: WikiStructurePlanBudget;
}

export interface WikiStructurePlanResult {
  status: "planned";
  lintSummary: Awaited<ReturnType<typeof lintPaperWiki>>["summary"];
  actionCount: number;
  actions: WikiStructurePlanAction[];
  warnings: string[];
}

const DEFAULT_BUDGET: Required<WikiStructurePlanBudget> = {
  maxPagesToBuild: 3,
  maxAliasesToCreate: 10,
  maxScopeNotes: 3
};

function singularizeSimpleAliasToken(token: string): string {
  const stems: Record<string, string> = {
    architectures: "architecture",
    codes: "code",
    collisions: "collision",
    gates: "gate",
    processors: "processor",
    qubits: "qubit",
    systems: "system"
  };
  if (stems[token]) {
    return stems[token];
  }
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function compactSimpleAliasKey(value: string, singularize: boolean): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split(/-+/)
    .filter(Boolean)
    .map((token) => singularize ? singularizeSimpleAliasToken(token) : token)
    .join("");
}

function isSimpleWikiAliasDuplicate(left: string, right: string): boolean {
  if (!left.trim() || !right.trim()) {
    return false;
  }
  const leftRaw = compactSimpleAliasKey(left, false);
  const rightRaw = compactSimpleAliasKey(right, false);
  if (!leftRaw || !rightRaw || (leftRaw === rightRaw && left.trim().toLowerCase() === right.trim().toLowerCase())) {
    return false;
  }
  return leftRaw === rightRaw || compactSimpleAliasKey(left, true) === compactSimpleAliasKey(right, true);
}

function priorityForIssue(issue: PaperWikiLintIssue): WikiStructurePriority {
  if (issue.severity === "high") {
    return "high";
  }
  if (issue.kind === "duplicate_section" || issue.kind === "weak_synthesis_page" || issue.kind === "near_duplicate_page") {
    return "medium";
  }
  return "low";
}

function actionForIssue(
  issue: PaperWikiLintIssue,
  index: number,
  options: WikiStructurePlanOptions
): WikiStructurePlanAction | undefined {
  const id = `wiki-structure-${String(index + 1).padStart(3, "0")}`;
  if (issue.kind === "duplicate_page_title") {
    return {
      id,
      type: "merge_duplicate_pages",
      priority: "high",
      risk: "medium",
      issueKind: issue.kind,
      owner: "wiki-agent",
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "merge_wiki_aliases"
    };
  }
  if (issue.kind === "near_duplicate_page") {
    const aliasPageKey = issue.path ? pathBasenameWithoutMarkdownExtension(issue.path) : undefined;
    if (issue.target && aliasPageKey) {
      return {
        id,
        type: "merge_duplicate_pages",
        priority: priorityForIssue(issue),
        risk: issue.severity === "low" ? "low" : "medium",
        issueKind: issue.kind,
        owner: "wiki-agent",
        path: issue.path,
        target: issue.target,
        reason: issue.reason,
        recommendedTool: "wiki_apply_structure_plan",
        recommendedArgs: {
          canonical: issue.target,
          redundant: aliasPageKey,
          alias: aliasPageKey,
          note: issue.reason
        }
      };
    }
    return {
      id,
      type: "create_alias",
      priority: priorityForIssue(issue),
      risk: "low",
      issueKind: issue.kind,
      owner: "wiki-agent",
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "merge_wiki_aliases"
    };
  }
  if (issue.kind === "duplicate_section") {
    return {
      id,
      type: "fix_duplicate_section",
      priority: priorityForIssue(issue),
      risk: "low",
      issueKind: issue.kind,
      owner: "wiki-agent",
      path: issue.path,
      target: issue.target,
      reason: issue.reason,
      recommendedTool: "wiki_apply_structure_plan"
    };
  }
  if (issue.kind === "rendered_wiki_link") {
    return {
      id,
      type: "fix_rendered_wiki_link",
      priority: "high",
      risk: "low",
      issueKind: issue.kind,
      owner: "wiki-agent",
      path: issue.path,
      target: issue.target,
      reason: issue.reason,
      recommendedTool: "replace_file_text"
    };
  }
  if (issue.kind === "weak_synthesis_page") {
    return {
      id,
      type: "rebuild_weak_page",
      priority: priorityForIssue(issue),
      risk: "medium",
      issueKind: issue.kind,
      owner: "wiki-agent",
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "build_wiki_page"
    };
  }
  if (issue.kind === "semantic_alias_candidate" && issue.path && issue.target) {
    const aliasPageKey = pathBasenameWithoutMarkdownExtension(issue.path);
    if (!aliasPageKey) {
      return undefined;
    }
    if (isSimpleWikiAliasDuplicate(aliasPageKey, issue.target)) {
      return {
        id,
        type: "merge_duplicate_pages",
        priority: priorityForIssue(issue),
        risk: "low",
        issueKind: issue.kind,
        owner: "wiki-agent",
        path: issue.path,
        target: issue.target,
        reason: issue.reason,
        recommendedTool: "wiki_apply_structure_plan",
        recommendedArgs: {
          canonical: issue.target,
          redundant: aliasPageKey,
          alias: aliasPageKey,
          note: issue.reason
        }
      };
    }
    return {
      id,
      type: "create_alias",
      priority: priorityForIssue(issue),
      risk: "medium",
      issueKind: issue.kind,
      owner: "wiki-agent",
      path: issue.path,
      target: issue.target,
      reason: issue.reason,
      recommendedTool: "merge_wiki_aliases",
      recommendedArgs: {
        aliases: [{
          alias: aliasPageKey,
          canonical: issue.target,
          note: issue.reason
        }]
      }
    };
  }
  if (issue.kind === "scope_drift" && issue.path) {
    return {
      id,
      type: "update_scope_note",
      priority: priorityForIssue(issue),
      risk: "low",
      issueKind: issue.kind,
      owner: "wiki-agent",
      path: issue.path,
      target: issue.target,
      reason: issue.reason,
      recommendedTool: "wiki_apply_structure_plan",
      recommendedArgs: {
        pagePath: issue.path,
        // wiki_apply_structure_plan will handle scope-note application in Task 4.
        scopeNote: scopeNoteForGoal(options.goal)
      }
    };
  }
  if (
    options.includeGrowthActions === true &&
    (issue.kind === "concept_gap" || issue.kind === "high_value_concept_gap") &&
    issue.concept
  ) {
    return {
      id,
      type: "promote_concept",
      priority: issue.kind === "high_value_concept_gap" ? "high" : issue.count && issue.count >= 5 ? "medium" : "low",
      risk: "medium",
      issueKind: issue.kind,
      owner: "wiki-agent",
      concept: issue.concept,
      target: issue.target,
      reason: issue.reason,
      recommendedTool: "build_wiki_page",
      recommendedArgs: {
        topic: issue.concept,
        pageKey: issue.concept,
        mode: "draft",
        maxLocalResults: 8
      },
      verification: [{
        tool: "wiki_lint",
        args: {
          maxItems: 50,
          ...(options.goal?.trim() ? { goal: options.goal } : {}),
          ...(hasFocus(options.focus) ? { focus: options.focus } : {}),
          includeCoverage: true
        },
        expected: `Concept gap for ${issue.concept} should be reduced after page promotion.`
      }]
    };
  }
  return undefined;
}

function pathBasenameWithoutMarkdownExtension(filePath: string): string | undefined {
  const basename = filePath.split(/[\\/]/).pop()?.replace(/\.md$/i, "");
  return basename?.trim() || undefined;
}

function scopeNoteForGoal(goal: string | undefined): string {
  const trimmedGoal = goal?.trim();
  if (trimmedGoal) {
    return `Scope note: Reframe this page around ${trimmedGoal} and keep stale roadmap language as context.`;
  }
  return "Scope note: Reframe this page around the current wiki scope and keep stale roadmap language as context.";
}

function hasFocus(focus: string[] | undefined): boolean {
  return focus?.some((item) => item.trim().length > 0) ?? false;
}

function normalizeBudget(budget: WikiStructurePlanBudget | undefined): Required<WikiStructurePlanBudget> {
  return {
    maxPagesToBuild: normalizeBudgetValue(budget?.maxPagesToBuild, DEFAULT_BUDGET.maxPagesToBuild),
    maxAliasesToCreate: normalizeBudgetValue(budget?.maxAliasesToCreate, DEFAULT_BUDGET.maxAliasesToCreate),
    maxScopeNotes: normalizeBudgetValue(budget?.maxScopeNotes, DEFAULT_BUDGET.maxScopeNotes)
  };
}

function normalizeBudgetValue(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function applyBudget(
  actions: WikiStructurePlanAction[],
  budget: Required<WikiStructurePlanBudget>
): WikiStructurePlanAction[] {
  let pages = 0;
  let aliases = 0;
  let scopes = 0;
  return actions.filter((action) => {
    if (action.type === "promote_concept") {
      pages += 1;
      return pages <= budget.maxPagesToBuild;
    }
    if (action.type === "create_alias") {
      aliases += 1;
      return aliases <= budget.maxAliasesToCreate;
    }
    if (action.type === "update_scope_note") {
      scopes += 1;
      return scopes <= budget.maxScopeNotes;
    }
    return true;
  });
}

function appendVerificationAction(
  actions: WikiStructurePlanAction[],
  options: WikiStructurePlanOptions
): WikiStructurePlanAction[] {
  const hasWriteCapableAction = actions.some((action) =>
    action.recommendedTool && action.recommendedTool !== "wiki_lint" && action.recommendedTool !== "wiki_health"
  );
  if (!hasWriteCapableAction) {
    return actions;
  }
  return [
    ...actions,
    {
      id: nextActionId(actions),
      type: "verify",
      priority: "high",
      risk: "low",
      issueKind: "stale_index",
      owner: "wiki-agent",
      reason: "Verify wiki structure after applying approved maintenance actions.",
      recommendedTool: "wiki_lint",
      recommendedArgs: {
        maxItems: 100,
        ...(options.goal?.trim() ? { goal: options.goal } : {}),
        ...(hasFocus(options.focus) ? { focus: options.focus } : {}),
        includeCoverage: true,
        includeQualityAudit: true,
        includeAliasCandidates: true
      }
    }
  ];
}

function nextActionId(actions: WikiStructurePlanAction[]): string {
  const maxId = actions.reduce((maxValue, action) => {
    const numericId = Number(action.id.match(/^wiki-structure-(\d+)$/)?.[1] ?? 0);
    return Number.isFinite(numericId) ? Math.max(maxValue, numericId) : maxValue;
  }, 0);
  return `wiki-structure-${String(maxId + 1).padStart(3, "0")}`;
}

export async function planWikiStructure(options: WikiStructurePlanOptions): Promise<WikiStructurePlanResult> {
  const maxItems = Math.max(1, Math.trunc(options.maxItems ?? 50));
  const includeGrowthActions = options.includeGrowthActions ?? false;
  const lintMaxItems = Math.max(200, maxItems * 5);
  const lint = await lintPaperWiki({
    workspaceDir: options.workspaceDir,
    maxItems: lintMaxItems,
    ...(includeGrowthActions && options.goal?.trim() ? { goal: options.goal } : {}),
    ...(includeGrowthActions && hasFocus(options.focus) ? { focus: options.focus } : {}),
    ...(includeGrowthActions ? {
      includeCoverage: true,
      includeQualityAudit: true,
      includeAliasCandidates: true
    } : {})
  });
  const includeMediumRisk = options.includeMediumRisk ?? false;
  const budget = normalizeBudget(options.budget);
  const plannedActions = applyBudget(lint.issues
    .map((issue, index) => actionForIssue(issue, index, options))
    .filter((action): action is WikiStructurePlanAction => Boolean(action))
    .filter((action) => includeMediumRisk || action.risk === "low"), budget);
  const actions = appendVerificationAction(plannedActions.slice(0, maxItems), options);

  return {
    status: "planned",
    lintSummary: lint.summary,
    actionCount: actions.length,
    actions,
    warnings: [
      "This tool only plans structural changes. Use existing wiki write tools for approved actions.",
      "Medium-risk merge and rebuild actions should be reviewed before applying."
    ]
  };
}
