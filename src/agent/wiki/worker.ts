import {
  getEnvApiKey,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolResultMessage,
  type UserMessage
} from "@mariozechner/pi-ai";
import { agentLoop, type AgentContext, type AgentMessage } from "@mariozechner/pi-agent-core";
import { WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT } from "../agent-prompts.js";
import { cleanupTools, createToolsForBoundary } from "../tools.js";
import type {
  PaperSummaryWorker,
  PaperSummaryWorkerOutput
} from "./summary.js";
import type {
  PaperWikiPageWorker,
  PaperWikiPageWorkerOutput
} from "./types.js";

type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;

function isLlmMessage(message: AgentMessage): message is LlmMessage {
  if (typeof message !== "object" || message === null || !("role" in message)) {
    return false;
  }

  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
  );
}

function convertAgentMessagesToLlm(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message) => (isLlmMessage(message) ? [message] : []));
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Summary worker did not return a JSON object.");
  }
}

function parsePaperSummaryWorkerOutput(value: unknown): PaperSummaryWorkerOutput {
  if (!isRecord(value)) {
    throw new Error("Summary worker did not return a JSON object.");
  }
  const summaryMarkdown = value.summaryMarkdown;
  if (typeof summaryMarkdown !== "string" || !summaryMarkdown.trim()) {
    throw new Error("Summary worker JSON must include summaryMarkdown.");
  }

  const readString = (key: string): string | undefined =>
    typeof value[key] === "string" ? value[key] : undefined;
  const readStringList = (key: string): string[] | undefined => {
    const candidate = value[key];
    return Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === "string")
      : undefined;
  };
  const confidence = readString("confidence");

  return {
    summaryMarkdown,
    ...(readString("title") ? { title: readString("title") } : {}),
    ...(readStringList("tags") ? { tags: readStringList("tags") } : {}),
    ...(readStringList("keyFindings") ? { keyFindings: readStringList("keyFindings") } : {}),
    ...(readStringList("limitations") ? { limitations: readStringList("limitations") } : {}),
    ...(readStringList("openQuestions") ? { openQuestions: readStringList("openQuestions") } : {}),
    ...(readStringList("relatedPaperKeys") ? { relatedPaperKeys: readStringList("relatedPaperKeys") } : {}),
    ...(confidence === "high" || confidence === "medium" || confidence === "low" ? { confidence } : {}),
    ...(readStringList("groundingWarnings") ? { groundingWarnings: readStringList("groundingWarnings") } : {})
  };
}

function parsePaperWikiPageWorkerOutput(value: unknown): PaperWikiPageWorkerOutput {
  if (!isRecord(value)) {
    throw new Error("Wiki page worker did not return a JSON object.");
  }
  const title = value.title;
  const pageMarkdown = value.pageMarkdown;
  if (typeof title !== "string" || !title.trim()) {
    throw new Error("Wiki page worker JSON must include title.");
  }
  if (typeof pageMarkdown !== "string" || !pageMarkdown.trim()) {
    throw new Error("Wiki page worker JSON must include pageMarkdown.");
  }

  const readString = (key: string): string | undefined =>
    typeof value[key] === "string" ? value[key] : undefined;
  const readStringList = (key: string): string[] | undefined => {
    const candidate = value[key];
    return Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === "string")
      : undefined;
  };
  const confidence = readString("confidence");

  return {
    title,
    pageMarkdown,
    ...(readStringList("tags") ? { tags: readStringList("tags") } : {}),
    ...(readStringList("openQuestions") ? { openQuestions: readStringList("openQuestions") } : {}),
    ...(readStringList("relatedPageKeys") ? { relatedPageKeys: readStringList("relatedPageKeys") } : {}),
    ...(confidence === "high" || confidence === "medium" || confidence === "low" ? { confidence } : {}),
    ...(readStringList("groundingWarnings") ? { groundingWarnings: readStringList("groundingWarnings") } : {})
  };
}

export function createWikiEvidenceWorker(model: Model<Api>, workspaceDir: string): {
  paperSummaryWorker: PaperSummaryWorker;
  paperWikiPageWorker: PaperWikiPageWorker;
} {
  const createWikiEvidenceWorkerTools = () => {
    const recursiveToolNames = new Set(["generate_paper_wiki_summary", "write_paper_wiki_source", "build_wiki_page"]);
    const tools = createToolsForBoundary(workspaceDir, "wiki-evidence-worker");
    const filteredTools = tools.filter((tool) => !recursiveToolNames.has(tool.name)) as typeof tools;
    Object.defineProperties(filteredTools, {
      cleanup: {
        enumerable: false,
        value: tools.cleanup
      },
      workspaceDir: {
        enumerable: false,
        value: tools.workspaceDir
      }
    });
    return filteredTools;
  };

  const paperSummaryWorker: PaperSummaryWorker = async (input) => {
    const prompt: UserMessage = {
      role: "user",
      timestamp: Date.now(),
      content: [
        "Create a grounded paper wiki source summary from the evidence JSON below.",
        "Use only the supplied evidence. Do not invent claims, metrics, or citations.",
        "Return only a JSON object with these fields: title, summaryMarkdown, tags, keyFindings, limitations, openQuestions, relatedPaperKeys, confidence, groundingWarnings.",
        "summaryMarkdown should be concise Markdown suitable for a retrieval source page, normally 3 to 6 paragraphs.",
        "keyFindings, limitations, openQuestions, tags, relatedPaperKeys, and groundingWarnings must be arrays of strings.",
        "If relatedCandidates are supplied, choose relatedPaperKeys only from those candidate paperKey values when there is a real conceptual or methodological connection.",
        "confidence must be high, medium, or low.",
        JSON.stringify({
          paperKey: input.evidence.paperKey,
          title: input.evidence.title,
          engine: input.evidence.engine,
          articleUrl: input.evidence.articleUrl,
          quality: input.evidence.quality,
          sections: input.evidence.sections,
          paths: input.evidence.paths,
          relatedCandidates: input.evidence.relatedCandidates,
          totalMarkdownChars: input.evidence.totalMarkdownChars,
          truncated: input.evidence.truncated,
          markdown: input.evidence.markdown
        })
      ].join("\n\n")
    };
    const context: AgentContext = {
      systemPrompt: WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT,
      messages: [],
      tools: createWikiEvidenceWorkerTools()
    };
    try {
      const stream = agentLoop(
        [prompt],
        context,
        {
          model,
          convertToLlm: convertAgentMessagesToLlm,
          getApiKey: (provider) => getEnvApiKey(provider),
          toolExecution: "sequential"
        }
      );
      const resultPromise = stream.result();
      for await (const _event of stream) {
        // Drain the stream; this internal wiki-evidence-worker subtask does not emit UI events.
      }
      const messages = await resultPromise;
      const assistant = messages
        .filter((message): message is AssistantMessage => message.role === "assistant")
        .at(-1);
      const text = assistant ? getAssistantText(assistant) : "";
      return parsePaperSummaryWorkerOutput(extractJsonObject(text));
    } finally {
      await cleanupTools(context.tools);
    }
  };

  const paperWikiPageWorker: PaperWikiPageWorker = async (input) => {
    const prompt: UserMessage = {
      role: "user",
      timestamp: Date.now(),
      content: [
        "Create a grounded topic wiki synthesis page from the evidence JSON below.",
        "Use only the supplied source-summary evidence. Do not invent papers, metrics, or unsupported claims.",
        "Return only a JSON object with these fields: title, pageMarkdown, tags, openQuestions, relatedPageKeys, confidence, groundingWarnings.",
        "pageMarkdown should be concise but structured Markdown with sections such as Overview, Key Concepts, Evidence, Challenges, and Representative Papers when appropriate.",
        "Do not include an Open Questions section in pageMarkdown; put open questions only in the openQuestions array.",
        "Every substantive claim should cite supplied paper keys inline, for example [arxiv-2507.09690].",
        "tags, openQuestions, relatedPageKeys, and groundingWarnings must be arrays of strings.",
        "confidence must be high, medium, or low.",
        JSON.stringify({
          topic: input.topic,
          question: input.question,
          evidence: input.evidence
        })
      ].join("\n\n")
    };
    const context: AgentContext = {
      systemPrompt: WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT,
      messages: [],
      tools: createWikiEvidenceWorkerTools()
    };
    try {
      const stream = agentLoop(
        [prompt],
        context,
        {
          model,
          convertToLlm: convertAgentMessagesToLlm,
          getApiKey: (provider) => getEnvApiKey(provider),
          toolExecution: "sequential"
        }
      );
      const resultPromise = stream.result();
      for await (const _event of stream) {
        // Drain the stream; this internal wiki-evidence-worker subtask does not emit UI events.
      }
      const messages = await resultPromise;
      const assistant = messages
        .filter((message): message is AssistantMessage => message.role === "assistant")
        .at(-1);
      const text = assistant ? getAssistantText(assistant) : "";
      return parsePaperWikiPageWorkerOutput(extractJsonObject(text));
    } finally {
      await cleanupTools(context.tools);
    }
  };

  return { paperSummaryWorker, paperWikiPageWorker };
}
