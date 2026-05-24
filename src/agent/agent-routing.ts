import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  DESIGN_SUBAGENT_SYSTEM_PROMPT,
  PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT,
  PAPER_WRITING_WORKER_SYSTEM_PROMPT,
  WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT
} from "./agent-prompts.js";

export type RoutedWorkerRole =
  | "paper-writing-worker"
  | "paper-download-subagent"
  | "wiki-evidence-worker"
  | "design-agent"
  | "design-subagent";

export interface RoutedWorkerPrompt {
  role: RoutedWorkerRole;
  instruction: string;
  reason: "explicit" | "intent";
}

export interface WorkerHandoff {
  role: RoutedWorkerRole;
  instruction: string;
  routeReason: RoutedWorkerPrompt["reason"];
  status: "completed" | "failed";
  changedFiles: string[];
  artifacts: string[];
  sourcePaths: string[];
  pagePaths: string[];
  designRecords: string[];
  toolsUsed: string[];
  failedTools: string[];
  finalResponse: string;
  nextSuggestedOwner:
    | "wiki-agent"
    | "paper-writing-worker"
    | "paper-download-subagent"
    | "wiki-evidence-worker"
    | "design-agent"
    | "design-subagent";
}

export function normalizeWorkerRole(role: RoutedWorkerRole): Exclude<RoutedWorkerRole, "design-subagent"> {
  return role === "design-subagent" ? "design-agent" : role;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parsePaperWritingWorkerCommand(text: string): string | null {
  const route = routeChatPromptToWorker(text);
  return route?.role === "paper-writing-worker" ? route.instruction : null;
}

function matchExplicitWorkerRoute(
  trimmed: string,
  role: RoutedWorkerRole,
  patterns: RegExp[]
): RoutedWorkerPrompt | null {
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const instruction = match?.[1]?.trim();
    if (instruction) {
      return { role, instruction, reason: "explicit" };
    }
  }

  return null;
}

export function routeChatPromptToWorker(text: string): RoutedWorkerPrompt | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const explicit =
    matchExplicitWorkerRoute(trimmed, "paper-writing-worker", [
      /^\/?paper\s+write(?:r)?\s+([\s\S]+)$/i,
      /^\/?paper-writing-worker\s+([\s\S]+)$/i,
      /^\/?论文写作\s+([\s\S]+)$/i
    ]) ??
    matchExplicitWorkerRoute(trimmed, "paper-download-subagent", [
      /^\/?paper\s+(?:download|search|acquire)\s+([\s\S]+)$/i,
      /^\/?(?:download|search)\s+papers?\s+([\s\S]+)$/i,
      /^\/?paper-download-subagent\s+([\s\S]+)$/i,
      /^\/?论文下载\s+([\s\S]+)$/i,
      /^\/?文献下载\s+([\s\S]+)$/i,
      /^\/?论文检索\s+([\s\S]+)$/i,
      /^\/?文献检索\s+([\s\S]+)$/i,
      /^\/?搜索论文\s+([\s\S]+)$/i,
      /^\/?检索论文\s+([\s\S]+)$/i
    ]) ??
    matchExplicitWorkerRoute(trimmed, "wiki-evidence-worker", [
      /^\/?wiki\s+evidence\s+([\s\S]+)$/i,
      /^\/?evidence\s+([\s\S]+)$/i,
      /^\/?wiki-evidence-worker\s+([\s\S]+)$/i,
      /^\/?证据整理\s+([\s\S]+)$/i,
      /^\/?文献总结\s+([\s\S]+)$/i
    ]) ??
    matchExplicitWorkerRoute(trimmed, "design-agent", [
      /^\/?design-agent\s+([\s\S]+)$/i,
      /^\/?design\s+agent\s+([\s\S]+)$/i,
      /^\/?design-subagent\s+([\s\S]+)$/i,
      /^\/?design\s+subagent\s+([\s\S]+)$/i,
      /^\/?design\s+([\s\S]+)$/i,
      /^\/?芯片设计\s+([\s\S]+)$/i,
      /^\/?设计任务\s+([\s\S]+)$/i
    ]);

  if (explicit) {
    return explicit;
  }

  const paperWritingIntent =
    (/(论文|manuscript|main\.tex|latex|paper-projects|paper[-\s]?orchestra|完整论文|conference submission)/i.test(trimmed) &&
      /(修改|润色|改写|重写|编辑|修订|编译|评审|审稿|问题点|问题|polish|revise|rewrite|edit|compile|review|critique|evaluate|issues|problems|写|生成|撰写|投稿|run|generate|draft|outline|refine)/i.test(trimmed)) ||
    /paper[-\s]?orchestra/i.test(trimmed);
  if (paperWritingIntent) {
    return { role: "paper-writing-worker", instruction: trimmed, reason: "intent" };
  }

  const paperDownloadIntent =
    /(论文|文献|paper|papers?|article|articles?|arxiv|doi|超导量子芯片|quantum chip|qubit chip)/i.test(trimmed) &&
    /(下载|获取|检索|搜索|查找|找|最新|download|search|find|fetch|acquire|latest|recent|newest)/i.test(trimmed);
  if (paperDownloadIntent) {
    return { role: "paper-download-subagent", instruction: trimmed, reason: "intent" };
  }

  const wikiEvidenceIntent =
    /(文献|论文|paper|source summaries?|wiki evidence|证据|来源摘要|source summary)/i.test(trimmed) &&
    /(总结|整理|提取|归纳|关系|关联|证据|summary|summarize|relation|relations|ingest|evidence)/i.test(trimmed);
  if (wikiEvidenceIntent) {
    return { role: "wiki-evidence-worker", instruction: trimmed, reason: "intent" };
  }

  const designExecutionIntent =
    /(design[-\s]?agent|design[-\s]?subagent|design-code|gdsfactory|klayout|\bgds\b|版图|layout|chip|qubit|resonator|coupler|python\s*包|依赖|uv\s*环境|uv\s+sync|pyproject\.toml)/i.test(trimmed) &&
    /(安装|同步|更新|添加|声明|运行|生成|检查|验证|仿真|失败|记录|install|sync|update|add|declare|run|generate|check|verify|simulate|failure|record|artifact|benchmark|layout)/i.test(trimmed);
  if (designExecutionIntent) {
    return { role: "design-agent", instruction: trimmed, reason: "intent" };
  }

  return null;
}

export function systemPromptForWorker(role: RoutedWorkerRole): string {
  const normalizedRole = normalizeWorkerRole(role);
  if (normalizedRole === "paper-writing-worker") {
    return PAPER_WRITING_WORKER_SYSTEM_PROMPT;
  }
  if (normalizedRole === "paper-download-subagent") {
    return PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT;
  }
  if (normalizedRole === "wiki-evidence-worker") {
    return WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT;
  }
  return DESIGN_SUBAGENT_SYSTEM_PROMPT;
}

function addString(set: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    set.add(value.trim());
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}

export function extractWorkerHandoffPaths(
  toolName: string,
  details: unknown,
  handoff: {
    changedFiles: Set<string>;
    artifacts: Set<string>;
    sourcePaths: Set<string>;
    pagePaths: Set<string>;
    designRecords: Set<string>;
  }
): void {
  if (!isRecord(details)) {
    return;
  }

  if (toolName === "write_file" || toolName === "replace_file_text" || toolName === "delete_file") {
    addString(handoff.changedFiles, details.path);
    return;
  }

  if (toolName === "compile_latex") {
    addString(handoff.artifacts, details.pdfPath);
    return;
  }

  if (toolName === "download_paper" || toolName === "parse_paper" || toolName === "register_manual_paper_download") {
    addString(handoff.artifacts, firstString(details.recordPath, details.path, details.pdfPath));
    addString(handoff.sourcePaths, firstString(details.sourcePath, details.recordPath));
    return;
  }

  if (toolName === "write_design_artifact") {
    addString(handoff.designRecords, details.path);
    addString(handoff.artifacts, details.path);
    return;
  }

  if (toolName === "write_paper_wiki_source") {
    addString(handoff.sourcePaths, firstString(details.sourcePath, details.path));
    return;
  }

  if (toolName === "generate_paper_wiki_summary") {
    const source = isRecord(details.source) ? details.source : undefined;
    addString(handoff.sourcePaths, firstString(source?.sourcePath, details.sourcePath));
    return;
  }

  if (toolName === "build_wiki_page") {
    const page = isRecord(details.page) ? details.page : undefined;
    addString(handoff.pagePaths, firstString(page?.pagePath, details.pagePath));
  }
}

export function nextOwnerForWorker(role: RoutedWorkerRole): WorkerHandoff["nextSuggestedOwner"] {
  const normalizedRole = normalizeWorkerRole(role);
  if (normalizedRole === "paper-writing-worker") {
    return "wiki-agent";
  }
  if (normalizedRole === "design-agent") {
    return "wiki-agent";
  }
  return "wiki-agent";
}

export function createWorkerHandoffMessage(handoff: WorkerHandoff): AssistantMessage {
  return {
    role: "assistant",
    timestamp: Date.now(),
    stopReason: "stop",
    content: [
      {
        type: "text",
        text: [
          "Worker handoff for main-agent continuity. Treat this as a compact record of the routed worker turn, not as a full transcript.",
          "```json",
          JSON.stringify(handoff, null, 2),
          "```"
        ].join("\n")
      }
    ]
  } as AssistantMessage;
}
