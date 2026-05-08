export type ToolProfile = "default" | "full";

export type ToolBoundaryRole =
  | "wiki-agent"
  | "paper-download-subagent"
  | "wiki-evidence-worker"
  | "design-subagent"
  | "paper-writing-worker";

type ToolName =
  | "answer_paper_wiki_question"
  | "answer_research_question"
  | "block_paper_download"
  | "bootstrap_wiki_page_evidence"
  | "build_wiki_page"
  | "clarify_research_topic"
  | "compile_latex"
  | "delete_file"
  | "download_paper"
  | "expand_research_topic"
  | "fetch_paper_webpage"
  | "fetch_url"
  | "generate_paper_wiki_summary"
  | "get_time"
  | "inspect_paper"
  | "list_files"
  | "list_local_papers"
  | "load_paper_writing_skill"
  | "merge_wiki_aliases"
  | "open_paper_page_for_login"
  | "paper_wiki_relations"
  | "parse_paper"
  | "read_file"
  | "read_paper_section"
  | "register_manual_paper_download"
  | "replace_file_text"
  | "research_topic_bootstrap"
  | "search_local_papers"
  | "search_paper_text"
  | "search_paper_wiki"
  | "search_papers"
  | "web_search"
  | "wiki_health"
  | "wiki_health_fix"
  | "wiki_lint"
  | "write_design_artifact"
  | "write_file"
  | "write_paper_wiki_source";

export const TOOL_BOUNDARY_NAMES: Record<ToolBoundaryRole, readonly ToolName[]> = {
  "wiki-agent": [
    "list_files",
    "read_file",
    "replace_file_text",
    "answer_paper_wiki_question",
    "bootstrap_wiki_page_evidence",
    "build_wiki_page",
    "merge_wiki_aliases",
    "clarify_research_topic",
    "research_topic_bootstrap",
    "expand_research_topic",
    "search_local_papers",
    "search_paper_wiki",
    "wiki_health",
    "wiki_lint"
  ],
  "paper-download-subagent": [
    "get_time",
    "web_search",
    "fetch_url",
    "search_papers",
    "download_paper",
    "block_paper_download",
    "inspect_paper",
    "read_paper_section",
    "search_paper_text",
    "search_local_papers",
    "list_local_papers",
    "fetch_paper_webpage",
    "register_manual_paper_download",
    "open_paper_page_for_login",
    "parse_paper",
    "wiki_health",
    "wiki_health_fix"
  ],
  "wiki-evidence-worker": [
    "inspect_paper",
    "read_paper_section",
    "search_paper_text",
    "search_local_papers",
    "list_local_papers",
    "write_paper_wiki_source",
    "generate_paper_wiki_summary",
    "paper_wiki_relations"
  ],
  "design-subagent": [
    "answer_paper_wiki_question",
    "search_paper_wiki",
    "search_local_papers",
    "list_local_papers",
    "write_design_artifact"
  ],
  "paper-writing-worker": [
    "load_paper_writing_skill",
    "list_files",
    "read_file",
    "write_file",
    "replace_file_text",
    "compile_latex",
    "answer_paper_wiki_question",
    "search_paper_wiki",
    "wiki_lint"
  ]
};

export function getToolBoundaryToolNames(role: ToolBoundaryRole): string[] {
  return [...TOOL_BOUNDARY_NAMES[role]];
}
