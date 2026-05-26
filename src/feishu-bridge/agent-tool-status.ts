import type { PiEvent } from './pi-client.js';

export interface AgentToolStatus {
  phase: 'start' | 'progress' | 'end';
  toolName: string;
  text: string;
  isError: boolean;
}

const FILE_TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  list_files: '列出目录',
  write_file: '写入文件',
  replace_file_text: '修改文件',
  delete_file: '删除文件',
  compile_latex: '编译 LaTeX',
};

const WIKI_TOOL_LABELS: Record<string, string> = {
  write_paper_wiki_source: '写入 wiki 来源摘要',
  generate_paper_wiki_summary: '生成 wiki 来源摘要',
  paper_wiki_relations: '更新 wiki 关系',
  search_paper_wiki: '检索 wiki',
  wiki_lint: '检查 wiki',
  answer_paper_wiki_question: '回答 wiki 问题',
  answer_research_question: '研究问答',
  bootstrap_wiki_page_evidence: '构建 wiki 页面证据',
  build_wiki_page: '生成 wiki 页面',
  clarify_research_topic: '澄清研究主题',
  research_topic_bootstrap: '初始化研究主题',
  expand_research_topic: '扩展研究主题',
  list_local_papers: '列出本地论文',
  search_local_papers: '检索本地论文',
  write_design_artifact: '写入设计记录',
  submit_design_simulation: '提交设计仿真',
  load_paper_writing_skill: '加载论文写作技能',
  paper_orchestra_prepare_workspace: '准备论文写作工作区',
  paper_orchestra_check_draft: '检查论文草稿',
  paper_orchestra_score_delta: '评估修订分数',
  paper_orchestra_snapshot_provenance: '记录论文 provenance',
  wiki_health: '检查 wiki 健康状态',
  wiki_health_fix: '修复 wiki 健康问题',
};

const VISIBLE_TOOL_LABELS: Record<string, string> = {
  ...FILE_TOOL_LABELS,
  ...WIKI_TOOL_LABELS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function compactText(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) {
    return undefined;
  }

  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1).trimEnd()}…` : compacted;
}

function getStringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  return record ? compactText(record[key]) : undefined;
}

function summarizeArgs(args: unknown): string {
  if (!isRecord(args)) {
    return '';
  }

  const fields = ['path', 'workspacePath', 'texPath', 'query', 'topic', 'question', 'paperKey']
    .map((key) => getStringField(args, key))
    .filter((value): value is string => Boolean(value));

  return fields.length > 0 ? `：${fields.join('，')}` : '';
}

function extractDetails(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isRecord(value.details) ? value.details : undefined;
}

function summarizeResult(result: unknown): string {
  const details = extractDetails(result);
  if (!details) {
    return '';
  }

  const directMessage = getStringField(details, 'message');
  if (directMessage) {
    return `：${directMessage}`;
  }

  const fields = ['path', 'pdfPath', 'pagePath', 'sourcePath', 'recordPath', 'status', 'count', 'replacements', 'bytes']
    .map((key) => {
      const value = details[key];
      if (typeof value === 'number') {
        return `${key}=${value}`;
      }
      return getStringField(details, key);
    })
    .filter((value): value is string => Boolean(value));

  return fields.length > 0 ? `：${fields.join('，')}` : '';
}

function summarizeProgress(partialResult: unknown): string {
  const details = extractDetails(partialResult);
  const progress = details && isRecord(details.progress) ? details.progress : undefined;
  const progressMessage = getStringField(progress, 'message');
  if (progressMessage) {
    return `：${progressMessage}`;
  }

  if (!isRecord(partialResult) || !Array.isArray(partialResult.content)) {
    return '';
  }

  const text = partialResult.content
    .filter(isRecord)
    .find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  const compacted = compactText(text);
  return compacted ? `：${compacted}` : '';
}

function getToolLabel(toolName: string): string | undefined {
  return VISIBLE_TOOL_LABELS[toolName];
}

export function formatAgentToolStatus(event: PiEvent): AgentToolStatus | null {
  const toolName = typeof event.toolName === 'string' ? event.toolName : '';
  const label = getToolLabel(toolName);
  if (!label) {
    return null;
  }

  if (event.type === 'tool_execution_start') {
    return {
      phase: 'start',
      toolName,
      text: `开始${label}${summarizeArgs(event.args)}`,
      isError: false,
    };
  }

  if (event.type === 'tool_execution_update') {
    return {
      phase: 'progress',
      toolName,
      text: `${label}中${summarizeProgress(event.partialResult)}`,
      isError: false,
    };
  }

  if (event.type === 'tool_execution_end') {
    const isError = event.isError === true;
    return {
      phase: 'end',
      toolName,
      text: `${isError ? '失败' : '完成'}${label}${summarizeResult(event.result)}`,
      isError,
    };
  }

  return null;
}

export function buildAgentToolProgressText(statuses: readonly AgentToolStatus[]): string {
  if (statuses.length === 0) {
    return '正在执行工具...';
  }

  const lines = statuses.slice(-8).map((status) => {
    const marker = status.isError ? '[error]' : status.phase === 'end' ? '[ok]' : '[...]';
    return `${marker} ${status.text}`;
  });

  return ['正在执行工具', ...lines].join('\n');
}
