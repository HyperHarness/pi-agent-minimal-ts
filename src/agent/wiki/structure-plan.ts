import { lintPaperWiki, type PaperWikiLintIssue } from "./lint.js";

export type WikiStructureActionType =
  | "merge_duplicate_pages"
  | "create_alias"
  | "fix_duplicate_section"
  | "fix_rendered_wiki_link"
  | "rebuild_weak_page"
  | "promote_concept";

export type WikiStructureRisk = "low" | "medium" | "high";
export type WikiStructurePriority = "high" | "medium" | "low";

export interface WikiStructurePlanAction {
  id: string;
  type: WikiStructureActionType;
  priority: WikiStructurePriority;
  risk: WikiStructureRisk;
  issueKind: PaperWikiLintIssue["kind"];
  path?: string;
  target?: string;
  concept?: string;
  reason: string;
  recommendedTool?: "merge_wiki_aliases" | "build_wiki_page" | "replace_file_text";
  recommendedArgs?: unknown;
}

export interface WikiStructurePlanOptions {
  workspaceDir: string;
  maxItems?: number;
  includeMediumRisk?: boolean;
}

export interface WikiStructurePlanResult {
  status: "planned";
  lintSummary: Awaited<ReturnType<typeof lintPaperWiki>>["summary"];
  actionCount: number;
  actions: WikiStructurePlanAction[];
  warnings: string[];
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

function actionForIssue(issue: PaperWikiLintIssue, index: number): WikiStructurePlanAction | undefined {
  const id = `wiki-structure-${String(index + 1).padStart(3, "0")}`;
  if (issue.kind === "duplicate_page_title") {
    return {
      id,
      type: "merge_duplicate_pages",
      priority: "high",
      risk: "medium",
      issueKind: issue.kind,
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "merge_wiki_aliases",
      recommendedArgs: {
        aliases: [],
        replaceExisting: false
      }
    };
  }
  if (issue.kind === "near_duplicate_page") {
    return {
      id,
      type: "create_alias",
      priority: priorityForIssue(issue),
      risk: "low",
      issueKind: issue.kind,
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "merge_wiki_aliases",
      recommendedArgs: {
        aliases: [],
        replaceExisting: false
      }
    };
  }
  if (issue.kind === "duplicate_section") {
    return {
      id,
      type: "fix_duplicate_section",
      priority: priorityForIssue(issue),
      risk: "low",
      issueKind: issue.kind,
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "replace_file_text"
    };
  }
  if (issue.kind === "rendered_wiki_link") {
    return {
      id,
      type: "fix_rendered_wiki_link",
      priority: "high",
      risk: "low",
      issueKind: issue.kind,
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
      path: issue.path,
      reason: issue.reason,
      recommendedTool: "build_wiki_page"
    };
  }
  if (issue.kind === "concept_gap" && issue.concept) {
    return {
      id,
      type: "promote_concept",
      priority: issue.count && issue.count >= 5 ? "medium" : "low",
      risk: "medium",
      issueKind: issue.kind,
      concept: issue.concept,
      target: issue.target,
      reason: issue.reason,
      recommendedTool: "build_wiki_page",
      recommendedArgs: {
        topic: issue.concept.replace(/-/g, " "),
        pageKey: issue.concept,
        mode: "draft",
        maxLocalResults: 8,
        maxDownloads: 0,
        autoDownload: false,
        autoSummarize: false
      }
    };
  }
  return undefined;
}

export async function planWikiStructure(options: WikiStructurePlanOptions): Promise<WikiStructurePlanResult> {
  const maxItems = Math.max(1, Math.trunc(options.maxItems ?? 50));
  const lint = await lintPaperWiki({
    workspaceDir: options.workspaceDir,
    maxItems
  });
  const includeMediumRisk = options.includeMediumRisk ?? false;
  const actions = lint.issues
    .map((issue, index) => actionForIssue(issue, index))
    .filter((action): action is WikiStructurePlanAction => Boolean(action))
    .filter((action) => includeMediumRisk || action.risk === "low")
    .slice(0, maxItems);

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
