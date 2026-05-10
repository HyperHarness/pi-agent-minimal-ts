import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  listPaperParseEngines,
  readParsedPaperDocument,
  readPaperSourceByKey,
  resolvePaperParseArtifactPaths
} from "../paper/reading/paper-reader-store.js";
import type { ConcretePaperParseEngine } from "../paper/reading/types.js";
import { PaperReaderError } from "../paper/reading/types.js";
import {
  ensurePaperWikiScaffold,
  getPaperWikiDir,
  getPaperWikiIndexPath,
  getPaperWikiLogPath,
  getPaperWikiManifestsDir,
  getPaperWikiPagePath,
  getPaperWikiPagesDir,
  getPaperWikiSourcesDir,
  getPaperWikiSourceManifestPath,
  getPaperWikiSourcePath,
  listPaperWikiPageFiles,
  listPaperWikiSourceFiles,
  paperKeyFromPaperWikiSourcePath,
  relativeToWorkspace,
  sanitizeWikiFilename
} from "./store.js";
import {
  writeWikiSourceManifest,
  type WikiSourceManifest
} from "./manifest-store.js";
import { searchWikiEvidence, type WikiEvidenceSearchResult } from "./retrieval-search.js";
import {
  beginWikiOperation,
  completeWikiOperation
} from "./journal.js";
import type {
  PaperWikiPageInput,
  PaperWikiPageResult,
  PaperWikiAliasMergeInput,
  PaperWikiAliasMergeItem,
  PaperWikiAliasMergeResult,
  PaperWikiPageSourceCitation,
  PaperWikiSearchOptions,
  PaperWikiSearchResult,
  PaperWikiSourceInput,
  PaperWikiSourceResult
} from "./types.js";

const DEFAULT_WIKI_SEARCH_RESULTS = 8;
const MAX_TERM_OCCURRENCES = 6;

interface SearchTerm {
  value: string;
  weight: number;
}

function sortEnginesByPreference(engines: ConcretePaperParseEngine[]): ConcretePaperParseEngine[] {
  const priority: Record<ConcretePaperParseEngine, number> = {
    "webpage": 0,
    "tex-source": 1,
    "opendataloader-hybrid": 2,
    "opendataloader-local": 3,
    "docling": 4,
    "plain-text-baseline": 5
  };
  return engines.slice().sort((left, right) => priority[left] - priority[right]);
}

export async function assertSafePaperWikiWriteTarget(input: {
  workspaceDir: string;
  filePath: string;
  allowedRoot: string;
  label: string;
}): Promise<void> {
  const rootStat = await lstat(input.allowedRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to write ${input.label} because the allowed wiki root is a symlink.`);
  }

  const workspaceRealPath = await realpath(input.workspaceDir);
  const rootRealPath = await realpath(input.allowedRoot);
  const rootRelativeToWorkspace = path.relative(workspaceRealPath, rootRealPath);
  if (rootRelativeToWorkspace.startsWith("..") || path.isAbsolute(rootRelativeToWorkspace)) {
    throw new Error(`Refusing to write ${input.label} because the allowed wiki root escapes the workspace.`);
  }

  const targetStat = await lstat(input.filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  if (targetStat?.isSymbolicLink()) {
    throw new Error(`Refusing to write ${input.label} through a symlink.`);
  }

  const resolvedTarget = targetStat ? await realpath(input.filePath) : await realpath(path.dirname(input.filePath));
  const targetRelativeToWorkspace = path.relative(workspaceRealPath, resolvedTarget);
  if (targetRelativeToWorkspace.startsWith("..") || path.isAbsolute(targetRelativeToWorkspace)) {
    throw new Error(`Refusing to write ${input.label} because the resolved path escapes the workspace.`);
  }

  const relative = path.relative(rootRealPath, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write ${input.label} because the resolved path escapes the allowed wiki directory.`);
  }
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

function cleanStringValues(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function sectionList(title: string, values: string[] | undefined): string {
  const cleaned = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return "";
  }
  return `\n## ${title}\n\n${cleaned.map((value) => `- ${value}`).join("\n")}\n`;
}

function yamlSourceCitations(values: PaperWikiPageSourceCitation[]): string {
  const cleaned = values.filter((value) => value.paperKey.trim() && value.path.trim());
  if (cleaned.length === 0) {
    return "[]";
  }
  return `\n${cleaned.map((value) => [
    `  - paper_key: ${quoteYaml(value.paperKey)}`,
    ...(value.title ? [`    title: ${quoteYaml(value.title)}`] : []),
    `    path: ${quoteYaml(value.path)}`
  ].join("\n")).join("\n")}`;
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

function isAliasPage(markdown: string): boolean {
  return extractFrontmatterValue(markdown, "type") === "wiki-alias-page" ||
    Boolean(extractFrontmatterValue(markdown, "canonical_page"));
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

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[_/]+/g, " ")
    .replace(/-/g, " ")
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addSearchTerm(terms: Map<string, SearchTerm>, value: string, weight: number): void {
  const normalized = normalizeSearchText(value);
  if (!normalized || normalized.length < 2) {
    return;
  }
  const previous = terms.get(normalized);
  if (!previous || previous.weight < weight) {
    terms.set(normalized, { value: normalized, weight });
  }
}

function addSearchTerms(terms: Map<string, SearchTerm>, values: string[], weight: number): void {
  for (const value of values) {
    addSearchTerm(terms, value, weight);
  }
}

function buildWikiSearchTerms(query: string): SearchTerm[] {
  const lowerQuery = query.toLowerCase();
  const normalizedQuery = normalizeSearchText(query);
  const terms = new Map<string, SearchTerm>();
  addSearchTerm(terms, normalizedQuery, 8);

  for (const token of normalizedQuery.match(/[a-z0-9]{3,}/g) ?? []) {
    addSearchTerm(terms, token, token.length >= 5 ? 3 : 2);
  }

  if (/\bqldpc\b/i.test(lowerQuery)) {
    addSearchTerms(terms, [
      "qldpc",
      "qldpc codes",
      "quantum ldpc",
      "quantum ldpc codes",
      "quantum low density parity check",
      "quantum low-density parity-check",
      "low density parity check",
      "low-density parity-check",
      "ldpc"
    ], 10);
  }
  if (/\bldpc\b/i.test(lowerQuery) || /低密度|校验/.test(query)) {
    addSearchTerms(terms, [
      "ldpc",
      "ldpc codes",
      "low density parity check",
      "low-density parity-check"
    ], 7);
  }
  if (/超导|superconduct/i.test(query)) {
    addSearchTerms(terms, [
      "superconducting",
      "superconducting qubits",
      "superconducting circuits",
      "superconducting chip",
      "flip chip",
      "flip-chip"
    ], 7);
  }
  if (/芯片|chip/i.test(query)) {
    addSearchTerms(terms, [
      "chip",
      "layout",
      "architecture",
      "flip chip",
      "flip-chip"
    ], 4);
  }
  if (/实现|实验|难点|挑战|瓶颈|困难|implement|experiment|challenge/i.test(query)) {
    addSearchTerms(terms, [
      "implementation",
      "implement",
      "near term experiments",
      "hardware challenges",
      "non local connectivity",
      "non-local connectivity",
      "long range couplers",
      "long-range couplers",
      "couplers",
      "crosstalk",
      "leakage",
      "measurement overhead",
      "error",
      "limitations",
      "open questions"
    ], 5);
  }

  return [...terms.values()].sort((left, right) => right.weight - left.weight || right.value.length - left.value.length);
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let index = text.indexOf(term);
  while (index >= 0 && count < MAX_TERM_OCCURRENCES) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function extractFrontmatter(markdown: string): string {
  return markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
}

function scoreWikiDocument(markdown: string, title: string, key: string, query: string, terms: SearchTerm[]): number {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedFrontmatter = normalizeSearchText(extractFrontmatter(markdown));
  const normalizedBody = normalizeSearchText(markdown.replace(/^---\n[\s\S]*?\n---\n/, ""));
  const normalizedKey = normalizeSearchText(key);
  let score = 0;

  if (normalizedQuery && normalizedBody.includes(normalizedQuery)) {
    score += 80;
  }
  if (normalizedQuery && normalizedFrontmatter.includes(normalizedQuery)) {
    score += 120;
  }

  for (const term of terms) {
    const titleMatches = countOccurrences(normalizedTitle, term.value);
    const frontmatterMatches = countOccurrences(normalizedFrontmatter, term.value);
    const bodyMatches = countOccurrences(normalizedBody, term.value);
    const keyMatches = countOccurrences(normalizedKey, term.value);
    score += titleMatches * term.weight * 10;
    score += frontmatterMatches * term.weight * 6;
    score += bodyMatches * term.weight * 2;
    score += keyMatches * term.weight * 8;
  }

  return score;
}

function createBestSnippet(text: string, query: string, terms: SearchTerm[]): string {
  const exactSnippet = createSnippet(text, query);
  const compact = text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/\s+/g, " ").trim();
  if (compact.toLowerCase().includes(query.toLowerCase())) {
    return exactSnippet;
  }
  const firstMatchingTerm = terms.find((term) => compact.toLowerCase().includes(term.value));
  return firstMatchingTerm ? createSnippet(text, firstMatchingTerm.value) : exactSnippet;
}

async function rewriteWikiIndex(workspaceDir: string): Promise<void> {
  const sourceFiles = await listPaperWikiSourceFiles(workspaceDir);
  const pageFiles = await listPaperWikiPageFiles(workspaceDir);
  const pageRows = await Promise.all(pageFiles.map(async (filePath) => {
    const markdown = await readFile(filePath, "utf8");
    const pageKey = path.basename(filePath, ".md");
    const title = extractTitle(markdown, pageKey);
    const relativePath = path.relative(getPaperWikiDir(workspaceDir), filePath).split(path.sep).join("/");
    return `- [${title}](${relativePath}) - \`${pageKey}\``;
  }));

  const content = [
    "# Paper LLM Wiki Index",
    "",
    "## Knowledge Entries",
    "",
    pageRows.length > 0 ? pageRows.join("\n") : "No knowledge entries yet.",
    "",
    "## Source Layer",
    "",
    `- Source summaries: ${sourceFiles.length}`,
    "- Evidence directory: [sources/](sources/)",
    "- Promote repeated concepts into durable pages with `build_wiki_page`.",
    ""
  ].join("\n");
  const indexPath = getPaperWikiIndexPath(workspaceDir);
  await assertSafePaperWikiWriteTarget({
    workspaceDir,
    filePath: indexPath,
    allowedRoot: getPaperWikiDir(workspaceDir),
    label: "wiki index"
  });
  await writeFile(indexPath, content, "utf8");
}

export async function rewritePaperWikiIndex(workspaceDir: string): Promise<void> {
  await rewriteWikiIndex(workspaceDir);
}

export async function writePaperWikiSource(input: PaperWikiSourceInput): Promise<PaperWikiSourceResult> {
  const summaryMarkdown = input.summaryMarkdown.trim();
  if (!summaryMarkdown) {
    throw new Error("summaryMarkdown is required.");
  }

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
  const manifestPath = getPaperWikiSourceManifestPath(input.workspaceDir, input.paperKey);
  const indexPath = getPaperWikiIndexPath(input.workspaceDir);
  const now = new Date().toISOString();
  const sourcePathRelative = relativeToWorkspace(input.workspaceDir, sourcePath);
  const manifestPathRelative = relativeToWorkspace(input.workspaceDir, manifestPath);
  const indexPathRelative = relativeToWorkspace(input.workspaceDir, indexPath);
  const logPathRelative = relativeToWorkspace(input.workspaceDir, getPaperWikiLogPath(input.workspaceDir));
  await Promise.all([
    mkdir(getPaperWikiSourcesDir(input.workspaceDir), { recursive: true }),
    mkdir(getPaperWikiManifestsDir(input.workspaceDir), { recursive: true }),
    mkdir(getPaperWikiDir(input.workspaceDir), { recursive: true })
  ]);
  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: sourcePath,
    allowedRoot: getPaperWikiSourcesDir(input.workspaceDir),
    label: "wiki source summary"
  });
  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: manifestPath,
    allowedRoot: getPaperWikiManifestsDir(input.workspaceDir),
    label: "wiki source manifest"
  });
  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: indexPath,
    allowedRoot: getPaperWikiDir(input.workspaceDir),
    label: "wiki index"
  });
  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: getPaperWikiLogPath(input.workspaceDir),
    allowedRoot: getPaperWikiDir(input.workspaceDir),
    label: "wiki log"
  });
  const operation = await beginWikiOperation({
    workspaceDir: input.workspaceDir,
    intent: "write_source_summary",
    owner: "wiki-agent",
    plannedFiles: [
      sourcePathRelative,
      manifestPathRelative,
      indexPathRelative,
      logPathRelative
    ],
    inputs: {
      paperKey: input.paperKey,
      engine,
      title
    }
  });
  await ensurePaperWikiScaffold(input.workspaceDir);

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

  const manifest: WikiSourceManifest = {
    schemaVersion: 1,
    kind: "paper-source",
    paperKey: input.paperKey,
    title,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    sourceSummaryPath: sourcePathRelative,
    provenance: {
      ...(source?.recordPath ? { recordPath: relativeToWorkspace(input.workspaceDir, source.recordPath) } : {}),
      ...(source?.articleUrl ? { articleUrl: source.articleUrl } : {}),
      ...(source?.pdfPath ? { rawPdfPath: relativeToWorkspace(input.workspaceDir, source.pdfPath) } : {}),
      ...(document.pdfSha256 ? { pdfSha256: document.pdfSha256 } : {})
    },
    parse: {
      engine,
      markdownPath: relativeToWorkspace(input.workspaceDir, artifacts.markdownPath),
      jsonPath: relativeToWorkspace(input.workspaceDir, artifacts.parsePath),
      qualityPath: relativeToWorkspace(input.workspaceDir, artifacts.qualityPath)
    },
    tags: cleanStringValues(input.tags),
    relatedPaperKeys: cleanStringValues(input.relatedPaperKeys),
    synthesisPageKeys: []
  };

  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, markdown.trimEnd() + "\n", "utf8");
  await writeWikiSourceManifest({
    workspaceDir: input.workspaceDir,
    manifest
  });
  await rewriteWikiIndex(input.workspaceDir);
  await completeWikiOperation({
    workspaceDir: input.workspaceDir,
    operationId: operation.operationId,
    writtenFiles: [
      sourcePathRelative,
      manifestPathRelative,
      indexPathRelative,
      logPathRelative
    ]
  });

  return {
    paperKey: input.paperKey,
    title,
    sourcePath: sourcePathRelative,
    manifestPath: manifestPathRelative,
    operationId: operation.operationId,
    operationJournalPath: operation.journalPath,
    indexPath: indexPathRelative,
    logPath: logPathRelative
  };
}

export async function writePaperWikiPage(input: PaperWikiPageInput): Promise<PaperWikiPageResult> {
  const pageMarkdown = input.pageMarkdown.trim();
  if (!pageMarkdown) {
    throw new Error("pageMarkdown is required.");
  }
  if (input.sourceCitations.length === 0) {
    throw new Error("sourceCitations must include at least one source summary.");
  }

  const pageKey = sanitizeWikiFilename(input.pageKey ?? input.topic);
  const pagePath = getPaperWikiPagePath(input.workspaceDir, pageKey);
  const indexPath = getPaperWikiIndexPath(input.workspaceDir);
  const logPath = getPaperWikiLogPath(input.workspaceDir);
  const title = input.title?.trim() || input.topic.trim() || pageKey;
  const now = new Date().toISOString();
  const pagePathRelative = relativeToWorkspace(input.workspaceDir, pagePath);
  const indexPathRelative = relativeToWorkspace(input.workspaceDir, indexPath);
  const logPathRelative = relativeToWorkspace(input.workspaceDir, logPath);
  await Promise.all([
    mkdir(getPaperWikiPagesDir(input.workspaceDir), { recursive: true }),
    mkdir(getPaperWikiDir(input.workspaceDir), { recursive: true })
  ]);
  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: pagePath,
    allowedRoot: getPaperWikiPagesDir(input.workspaceDir),
    label: "wiki page"
  });
  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: indexPath,
    allowedRoot: getPaperWikiDir(input.workspaceDir),
    label: "wiki index"
  });
  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: logPath,
    allowedRoot: getPaperWikiDir(input.workspaceDir),
    label: "wiki log"
  });
  const operation = await beginWikiOperation({
    workspaceDir: input.workspaceDir,
    intent: "write_synthesis_page",
    owner: "wiki-agent",
    plannedFiles: [
      pagePathRelative,
      indexPathRelative,
      logPathRelative
    ],
    inputs: {
      pageKey,
      title,
      topic: input.topic,
      sourceCount: input.sourceCitations.length
    }
  });
  await ensurePaperWikiScaffold(input.workspaceDir);
  const markdown = `---
type: "wiki-synthesis-page"
page_key: ${quoteYaml(pageKey)}
title: ${quoteYaml(title)}
topic: ${quoteYaml(input.topic)}
evidence_contract: ${quoteYaml(input.evidenceContract ?? "paper-backed")}
created_at: ${quoteYaml(now)}
updated_at: ${quoteYaml(now)}
tags: ${yamlList(input.tags)}
sources: ${yamlSourceCitations(input.sourceCitations)}
related_pages: ${yamlList(input.relatedPageKeys)}
---

# ${title}

${pageMarkdown}
${sectionList("Open Questions", input.openQuestions)}
## Sources

${input.sourceCitations.map((source) =>
  `- \`${source.paperKey}\`${source.title ? ` - ${source.title}` : ""} (${source.path})`
).join("\n")}
`;

  await writeFile(pagePath, markdown.trimEnd() + "\n", "utf8");
  await rewriteWikiIndex(input.workspaceDir);
  await appendFile(
    logPath,
    `\n## [${now.slice(0, 10)}] page | ${title}\n\n- pageKey: \`${pageKey}\`\n- path: \`${pagePathRelative}\`\n- sources: ${input.sourceCitations.map((source) => `\`${source.paperKey}\``).join(", ")}\n`,
    "utf8"
  );
  await completeWikiOperation({
    workspaceDir: input.workspaceDir,
    operationId: operation.operationId,
    writtenFiles: [
      pagePathRelative,
      indexPathRelative,
      logPathRelative
    ]
  });

  return {
    pageKey,
    title,
    pagePath: pagePathRelative,
    operationId: operation.operationId,
    operationJournalPath: operation.journalPath,
    indexPath: indexPathRelative,
    logPath: logPathRelative,
    sourceCount: input.sourceCitations.length
  };
}

function uniqueAliasInputs(aliases: PaperWikiAliasMergeInput["aliases"]): PaperWikiAliasMergeInput["aliases"] {
  const seen = new Set<string>();
  const unique: PaperWikiAliasMergeInput["aliases"] = [];
  for (const alias of aliases) {
    const aliasPageKey = sanitizeWikiFilename(alias.alias.toLowerCase());
    if (seen.has(aliasPageKey)) {
      continue;
    }
    seen.add(aliasPageKey);
    unique.push(alias);
  }
  return unique;
}

interface WritableAliasCandidate {
  pagePath: string;
  markdown: string;
}

export async function mergePaperWikiAliases(input: PaperWikiAliasMergeInput): Promise<PaperWikiAliasMergeResult> {
  if (input.aliases.length === 0) {
    throw new Error("At least one alias mapping is required.");
  }

  await Promise.all([
    mkdir(getPaperWikiPagesDir(input.workspaceDir), { recursive: true }),
    mkdir(getPaperWikiDir(input.workspaceDir), { recursive: true })
  ]);
  const now = new Date().toISOString();
  const pageFiles = await listPaperWikiPageFiles(input.workspaceDir);
  const pageKeys = new Set(pageFiles.map((filePath) => path.basename(filePath, ".md")));
  const items: PaperWikiAliasMergeItem[] = [];
  const writableAliases: WritableAliasCandidate[] = [];
  const candidateTitles = new Map<string, string>();

  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: getPaperWikiIndexPath(input.workspaceDir),
    allowedRoot: getPaperWikiDir(input.workspaceDir),
    label: "wiki index"
  });
  await assertSafePaperWikiWriteTarget({
    workspaceDir: input.workspaceDir,
    filePath: getPaperWikiLogPath(input.workspaceDir),
    allowedRoot: getPaperWikiDir(input.workspaceDir),
    label: "wiki log"
  });

  for (const aliasInput of uniqueAliasInputs(input.aliases)) {
    const aliasPageKey = sanitizeWikiFilename(aliasInput.alias.toLowerCase());
    const canonicalPageKey = sanitizeWikiFilename(aliasInput.canonical.toLowerCase());
    const pagePath = getPaperWikiPagePath(input.workspaceDir, aliasPageKey);
    const pagePathRelative = relativeToWorkspace(input.workspaceDir, pagePath);
    if (aliasPageKey === canonicalPageKey) {
      items.push({
        aliasPageKey,
        canonicalPageKey,
        title: aliasInput.title?.trim() || aliasInput.alias.trim() || aliasPageKey,
        pagePath: pagePathRelative,
        status: "skipped",
        reason: "Alias and canonical page keys are identical."
      });
      continue;
    }
    if (!pageKeys.has(canonicalPageKey)) {
      items.push({
        aliasPageKey,
        canonicalPageKey,
        title: aliasInput.title?.trim() || aliasInput.alias.trim() || aliasPageKey,
        pagePath: pagePathRelative,
        status: "skipped",
        reason: "Canonical wiki page does not exist; build the canonical page before creating aliases."
      });
      continue;
    }

    await assertSafePaperWikiWriteTarget({
      workspaceDir: input.workspaceDir,
      filePath: pagePath,
      allowedRoot: getPaperWikiPagesDir(input.workspaceDir),
      label: "wiki alias page"
    });
    const existing = await readFile(pagePath, "utf8").catch(() => undefined);
    if (existing && !isAliasPage(existing) && input.replaceExisting !== true) {
      items.push({
        aliasPageKey,
        canonicalPageKey,
        title: extractTitle(existing, aliasInput.title?.trim() || aliasPageKey),
        pagePath: pagePathRelative,
        status: "skipped",
        reason: "Alias page already exists as a synthesis page; set replaceExisting=true only after confirming it should be merged."
      });
      continue;
    }

    const canonicalPath = getPaperWikiPagePath(input.workspaceDir, canonicalPageKey);
    const canonicalMarkdown = await readFile(canonicalPath, "utf8").catch(() => undefined);
    const canonicalTitle = canonicalMarkdown
      ? extractTitle(canonicalMarkdown, canonicalPageKey)
      : candidateTitles.get(canonicalPageKey) ?? canonicalPageKey;
    const title = aliasInput.title?.trim() || aliasInput.alias.trim() || aliasPageKey;
    const note = aliasInput.note?.trim();
    const createdAt = existing ? extractFrontmatterValue(existing, "created_at") ?? now : now;
    const markdown = `---
type: "wiki-alias-page"
page_key: ${quoteYaml(aliasPageKey)}
title: ${quoteYaml(title)}
canonical_page: ${quoteYaml(canonicalPageKey)}
created_at: ${quoteYaml(createdAt)}
updated_at: ${quoteYaml(now)}
tags:
  - "alias"
related_pages:
  - ${quoteYaml(canonicalPageKey)}
---

# ${title}

This page is an alias for [${canonicalTitle}](knowledge-base/pages/${canonicalPageKey}.md).

Use the canonical page for maintained synthesis content.

## Alias

- Canonical page: \`${canonicalPageKey}\`
${note ? `- Note: ${note}\n` : ""}`;
    pageKeys.add(aliasPageKey);
    candidateTitles.set(aliasPageKey, title);
    writableAliases.push({ pagePath, markdown: markdown.trimEnd() + "\n" });
    items.push({
      aliasPageKey,
      canonicalPageKey,
      title,
      pagePath: pagePathRelative,
      status: "written"
    });
  }

  const writtenItems = items.filter((item) => item.status === "written");
  let operation: Awaited<ReturnType<typeof beginWikiOperation>> | undefined;
  if (writtenItems.length > 0) {
    operation = await beginWikiOperation({
      workspaceDir: input.workspaceDir,
      intent: "merge_aliases",
      owner: "wiki-agent",
      plannedFiles: [
        ...writtenItems.map((item) => item.pagePath),
        relativeToWorkspace(input.workspaceDir, getPaperWikiIndexPath(input.workspaceDir)),
        relativeToWorkspace(input.workspaceDir, getPaperWikiLogPath(input.workspaceDir))
      ],
      inputs: {
        aliases: writtenItems.map((item) => ({
          aliasPageKey: item.aliasPageKey,
          canonicalPageKey: item.canonicalPageKey
        }))
      }
    });
    await ensurePaperWikiScaffold(input.workspaceDir);
    for (const alias of writableAliases) {
      await writeFile(alias.pagePath, alias.markdown, "utf8");
    }
    await rewriteWikiIndex(input.workspaceDir);
    await assertSafePaperWikiWriteTarget({
      workspaceDir: input.workspaceDir,
      filePath: getPaperWikiLogPath(input.workspaceDir),
      allowedRoot: getPaperWikiDir(input.workspaceDir),
      label: "wiki log"
    });
    await appendFile(
      getPaperWikiLogPath(input.workspaceDir),
      `\n## [${now.slice(0, 10)}] aliases\n\n${items
        .filter((item) => item.status === "written")
        .map((item) => `- \`${item.aliasPageKey}\` -> \`${item.canonicalPageKey}\` (${item.pagePath})`)
        .join("\n")}\n`,
      "utf8"
    );
    await completeWikiOperation({
      workspaceDir: input.workspaceDir,
      operationId: operation.operationId,
      writtenFiles: [
        ...writtenItems.map((item) => item.pagePath),
        relativeToWorkspace(input.workspaceDir, getPaperWikiIndexPath(input.workspaceDir)),
        relativeToWorkspace(input.workspaceDir, getPaperWikiLogPath(input.workspaceDir))
      ]
    });
  }

  const writtenCount = writtenItems.length;
  return {
    status: writtenCount === 0 ? "blocked" : writtenCount === items.length ? "written" : "partial",
    aliases: items,
    ...(operation ? {
      operationId: operation.operationId,
      operationJournalPath: operation.journalPath
    } : {}),
    indexPath: relativeToWorkspace(input.workspaceDir, getPaperWikiIndexPath(input.workspaceDir)),
    logPath: relativeToWorkspace(input.workspaceDir, getPaperWikiLogPath(input.workspaceDir))
  };
}

async function searchPaperWikiWithLegacyScoring(options: PaperWikiSearchOptions): Promise<PaperWikiSearchResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("query is required.");
  }

  const maxResults = Math.max(1, Math.trunc(options.maxResults ?? DEFAULT_WIKI_SEARCH_RESULTS));
  const [sourceFiles, pageFiles] = await Promise.all([
    listPaperWikiSourceFiles(options.workspaceDir),
    listPaperWikiPageFiles(options.workspaceDir)
  ]);
  const searchTerms = buildWikiSearchTerms(query);
  const matches: Array<{
    kind: "source" | "page";
    key: string;
    paperKey?: string;
    pageKey?: string;
    title: string;
    path: string;
    snippet: string;
    score: number;
  }> = [];
  for (const filePath of sourceFiles) {
    const markdown = await readFile(filePath, "utf8");
    const paperKey = paperKeyFromPaperWikiSourcePath(filePath);
    const title = extractTitle(markdown, paperKey);
    const score = scoreWikiDocument(markdown, title, paperKey, query, searchTerms);
    if (score <= 0) {
      continue;
    }
    matches.push({
      kind: "source",
      key: paperKey,
      paperKey,
      title,
      path: relativeToWorkspace(options.workspaceDir, filePath),
      snippet: createBestSnippet(markdown, query, searchTerms),
      score
    });
  }
  for (const filePath of pageFiles) {
    const markdown = await readFile(filePath, "utf8");
    const pageKey = path.basename(filePath, ".md");
    const title = extractTitle(markdown, pageKey);
    const score = scoreWikiDocument(markdown, title, pageKey, query, searchTerms);
    if (score <= 0) {
      continue;
    }
    matches.push({
      kind: "page",
      key: pageKey,
      pageKey,
      title,
      path: relativeToWorkspace(options.workspaceDir, filePath),
      snippet: createBestSnippet(markdown, query, searchTerms),
      score
    });
  }

  return {
    query,
    results: matches
      .sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key))
      .slice(0, maxResults)
      .map(({ score: _score, ...result }) => result)
  };
}

function isMeaningfulStructuredSearchResult(result: WikiEvidenceSearchResult): boolean {
  if (result.matchReasons.some((reason) => reason !== "body")) {
    return true;
  }
  return result.score >= 2;
}

export async function searchPaperWiki(options: PaperWikiSearchOptions): Promise<PaperWikiSearchResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("query is required.");
  }

  await ensurePaperWikiScaffold(options.workspaceDir);
  const maxResults = Math.max(1, Math.trunc(options.maxResults ?? DEFAULT_WIKI_SEARCH_RESULTS));
  const structured = await searchWikiEvidence({
    workspaceDir: options.workspaceDir,
    query,
    preferredKinds: ["source", "page"],
    maxResults
  });

  if (structured.status === "ready" && structured.results.some(isMeaningfulStructuredSearchResult)) {
    const meaningfulResults = structured.results.filter(isMeaningfulStructuredSearchResult);
    return {
      query,
      results: meaningfulResults.map((result) => ({
        kind: result.item.kind,
        key: result.item.key,
        ...(result.item.kind === "source" ? { paperKey: result.item.key } : { pageKey: result.item.key }),
        title: result.item.title,
        path: result.item.relativePath,
        snippet: createBestSnippet(result.item.body, query, buildWikiSearchTerms(query))
      }))
    };
  }

  return searchPaperWikiWithLegacyScoring({
    workspaceDir: options.workspaceDir,
    query,
    maxResults
  });
}
