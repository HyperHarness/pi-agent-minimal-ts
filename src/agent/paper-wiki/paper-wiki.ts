import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  listPaperParseEngines,
  readParsedPaperDocument,
  readPaperSourceByKey,
  resolvePaperParseArtifactPaths
} from "../paper-reader/paper-reader-store.js";
import type { ConcretePaperParseEngine } from "../paper-reader/types.js";
import { PaperReaderError } from "../paper-reader/types.js";
import {
  ensurePaperWikiScaffold,
  getPaperWikiIndexPath,
  getPaperWikiLogPath,
  getPaperWikiSchemaPath,
  getPaperWikiSourcePath,
  listPaperWikiSourceFiles,
  relativeToWorkspace
} from "./paper-wiki-store.js";
import type {
  PaperWikiSearchOptions,
  PaperWikiSearchResult,
  PaperWikiSourceInput,
  PaperWikiSourceResult
} from "./types.js";

const DEFAULT_WIKI_SEARCH_RESULTS = 8;

function sortEnginesByPreference(engines: ConcretePaperParseEngine[]): ConcretePaperParseEngine[] {
  const priority: Record<ConcretePaperParseEngine, number> = {
    "webpage": 0,
    "opendataloader-hybrid": 1,
    "opendataloader-local": 2,
    "docling": 3,
    "plain-text-baseline": 4
  };
  return engines.slice().sort((left, right) => priority[left] - priority[right]);
}

async function resolveWikiEngine(input: {
  workspaceDir: string;
  paperKey: string;
  engine?: ConcretePaperParseEngine;
}): Promise<ConcretePaperParseEngine> {
  if (input.engine) {
    await readParsedPaperDocument({
      workspaceDir: input.workspaceDir,
      paperKey: input.paperKey,
      engine: input.engine
    });
    return input.engine;
  }

  const engine = sortEnginesByPreference(
    await listPaperParseEngines({
      workspaceDir: input.workspaceDir,
      paperKey: input.paperKey
    })
  )[0];
  if (!engine) {
    throw new PaperReaderError("paper_not_found", `No parsed paper found for ${input.paperKey}.`);
  }
  return engine;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: string[] | undefined): string {
  const cleaned = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return "[]";
  }
  return `\n${cleaned.map((value) => `  - ${quoteYaml(value)}`).join("\n")}`;
}

function sectionList(title: string, values: string[] | undefined): string {
  const cleaned = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return "";
  }
  return `\n## ${title}\n\n${cleaned.map((value) => `- ${value}`).join("\n")}\n`;
}

function extractFrontmatterValue(markdown: string, key: string): string | undefined {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch?.[1]) {
    return undefined;
  }
  const line = frontmatterMatch[1]
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}:`));
  const raw = line?.slice(key.length + 1).trim();
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return raw;
  }
}

function extractTitle(markdown: string, fallback: string): string {
  return extractFrontmatterValue(markdown, "title") ??
    markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    fallback;
}

function createSnippet(text: string, query: string): string {
  const compact = text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/\s+/g, " ").trim();
  const lowerText = compact.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index < 0) {
    return compact.slice(0, 260);
  }
  const start = Math.max(0, index - 100);
  const end = Math.min(compact.length, index + query.length + 160);
  return `${start > 0 ? "... " : ""}${compact.slice(start, end)}${end < compact.length ? " ..." : ""}`;
}

async function rewriteWikiIndex(workspaceDir: string): Promise<void> {
  const sourceFiles = await listPaperWikiSourceFiles(workspaceDir);
  const rows = await Promise.all(sourceFiles.map(async (filePath) => {
    const markdown = await readFile(filePath, "utf8");
    const paperKey = path.basename(filePath, ".md");
    const title = extractTitle(markdown, paperKey);
    const relativePath = relativeToWorkspace(workspaceDir, filePath);
    return `- [${title}](${relativePath}) - \`${paperKey}\``;
  }));

  const content = [
    "# Paper LLM Wiki Index",
    "",
    "## Sources",
    "",
    rows.length > 0 ? rows.join("\n") : "No source summaries yet.",
    ""
  ].join("\n");
  await writeFile(getPaperWikiIndexPath(workspaceDir), content, "utf8");
}

export async function writePaperWikiSource(input: PaperWikiSourceInput): Promise<PaperWikiSourceResult> {
  const summaryMarkdown = input.summaryMarkdown.trim();
  if (!summaryMarkdown) {
    throw new Error("summaryMarkdown is required.");
  }

  await ensurePaperWikiScaffold(input.workspaceDir);
  const engine = await resolveWikiEngine(input);
  const [source, document] = await Promise.all([
    readPaperSourceByKey({ workspaceDir: input.workspaceDir, paperKey: input.paperKey }),
    readParsedPaperDocument({
      workspaceDir: input.workspaceDir,
      paperKey: input.paperKey,
      engine
    })
  ]);
  const title = input.title?.trim() || document.title || source?.title || input.paperKey;
  const artifacts = await resolvePaperParseArtifactPaths({
    workspaceDir: input.workspaceDir,
    paperKey: input.paperKey,
    engine
  });
  const sourcePath = getPaperWikiSourcePath(input.workspaceDir, input.paperKey);
  const now = new Date().toISOString();

  const markdown = `---
type: "paper-source-summary"
paper_key: ${quoteYaml(input.paperKey)}
title: ${quoteYaml(title)}
created_at: ${quoteYaml(now)}
updated_at: ${quoteYaml(now)}
pdf_sha256: ${quoteYaml(document.pdfSha256)}
raw_pdf: ${quoteYaml(source?.pdfPath ? relativeToWorkspace(input.workspaceDir, source.pdfPath) : "")}
record: ${quoteYaml(source?.recordPath ? relativeToWorkspace(input.workspaceDir, source.recordPath) : "")}
article_url: ${quoteYaml(source?.articleUrl ?? "")}
parse_engine: ${quoteYaml(engine)}
parse_markdown: ${quoteYaml(relativeToWorkspace(input.workspaceDir, artifacts.markdownPath))}
parse_json: ${quoteYaml(relativeToWorkspace(input.workspaceDir, artifacts.parsePath))}
quality_json: ${quoteYaml(relativeToWorkspace(input.workspaceDir, artifacts.qualityPath))}
tags: ${yamlList(input.tags)}
related_papers: ${yamlList(input.relatedPaperKeys)}
---

# ${title}

${summaryMarkdown}
${sectionList("Key Findings", input.keyFindings)}
${sectionList("Limitations", input.limitations)}
${sectionList("Open Questions", input.openQuestions)}
## Provenance

- Paper key: \`${input.paperKey}\`
- Parser: \`${engine}\`
- PDF SHA-256: \`${document.pdfSha256}\`
- Parsed markdown: \`${relativeToWorkspace(input.workspaceDir, artifacts.markdownPath)}\`
`;

  await writeFile(sourcePath, markdown.trimEnd() + "\n", "utf8");
  await rewriteWikiIndex(input.workspaceDir);
  await appendFile(
    getPaperWikiLogPath(input.workspaceDir),
    `\n## [${now.slice(0, 10)}] source | ${title}\n\n- paperKey: \`${input.paperKey}\`\n- path: \`${relativeToWorkspace(input.workspaceDir, sourcePath)}\`\n`,
    "utf8"
  );

  return {
    paperKey: input.paperKey,
    title,
    sourcePath: relativeToWorkspace(input.workspaceDir, sourcePath),
    indexPath: relativeToWorkspace(input.workspaceDir, getPaperWikiIndexPath(input.workspaceDir)),
    logPath: relativeToWorkspace(input.workspaceDir, getPaperWikiLogPath(input.workspaceDir)),
    schemaPath: relativeToWorkspace(input.workspaceDir, getPaperWikiSchemaPath(input.workspaceDir))
  };
}

export async function searchPaperWiki(options: PaperWikiSearchOptions): Promise<PaperWikiSearchResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("query is required.");
  }

  await ensurePaperWikiScaffold(options.workspaceDir);
  const maxResults = Math.max(1, Math.trunc(options.maxResults ?? DEFAULT_WIKI_SEARCH_RESULTS));
  const sourceFiles = await listPaperWikiSourceFiles(options.workspaceDir);
  const lowerQuery = query.toLowerCase();
  const matches = [];
  for (const filePath of sourceFiles) {
    const markdown = await readFile(filePath, "utf8");
    if (!markdown.toLowerCase().includes(lowerQuery)) {
      continue;
    }
    const paperKey = path.basename(filePath, ".md");
    matches.push({
      paperKey,
      title: extractTitle(markdown, paperKey),
      path: relativeToWorkspace(options.workspaceDir, filePath),
      snippet: createSnippet(markdown, query)
    });
    if (matches.length >= maxResults) {
      break;
    }
  }

  return {
    query,
    results: matches
  };
}
