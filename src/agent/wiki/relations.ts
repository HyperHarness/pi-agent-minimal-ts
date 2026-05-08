import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { listLocalPapers, type LocalPaperEntry } from "../paper/storage/local-paper-library.js";
import {
  ensurePaperWikiScaffold,
  getPaperWikiSourcePath,
  relativeToWorkspace
} from "./store.js";

const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_MAX_TEXT_CHARS = 30000;
const MAX_SNIPPET_LENGTH = 260;

const STOPWORDS = new Set([
  "about",
  "abstract",
  "access",
  "after",
  "also",
  "among",
  "article",
  "author",
  "authors",
  "based",
  "being",
  "been",
  "between",
  "both",
  "components",
  "could",
  "center",
  "contact",
  "directly",
  "distribution",
  "external",
  "field",
  "from",
  "figures",
  "have",
  "holder",
  "https",
  "included",
  "into",
  "journal",
  "maintained",
  "model",
  "more",
  "most",
  "note",
  "obtain",
  "only",
  "open",
  "order",
  "other",
  "paper",
  "parties",
  "permission",
  "phys",
  "proper",
  "provided",
  "published",
  "physics",
  "results",
  "rights",
  "share",
  "show",
  "some",
  "such",
  "than",
  "that",
  "their",
  "then",
  "there",
  "these",
  "this",
  "third",
  "title",
  "through",
  "under",
  "university",
  "using",
  "website",
  "when",
  "where",
  "which",
  "window",
  "with",
  "without",
  "work"
]);

export interface PaperWikiRelationCandidate {
  paperKey: string;
  title?: string;
  source?: string;
  articleUrl?: string;
  score: number;
  sharedTerms: string[];
  reasons: string[];
  snippet?: string;
  hasWikiSummary: boolean;
  parseEngines: string[];
}

export interface FindPaperWikiRelationsOptions {
  workspaceDir: string;
  paperKey: string;
  maxCandidates?: number;
  maxTextChars?: number;
}

export interface UpdatePaperWikiRelationsOptions {
  workspaceDir: string;
  paperKey: string;
  relatedPaperKeys: string[];
  mode?: "append" | "replace";
}

export interface PaperWikiRelationsUpdateResult {
  paperKey: string;
  sourcePath: string;
  previousRelatedPaperKeys: string[];
  relatedPaperKeys: string[];
  mode: "append" | "replace";
}

export interface PaperWikiRelationsOptions extends FindPaperWikiRelationsOptions {
  relatedPaperKeys?: string[];
  mode?: "append" | "replace";
}

export interface PaperWikiRelationsResult {
  paperKey: string;
  candidates: PaperWikiRelationCandidate[];
  update?: PaperWikiRelationsUpdateResult;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !/\d/.test(token) && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

function entryMetadata(entry: LocalPaperEntry): string {
  return [
    entry.paperKey,
    entry.title,
    entry.source,
    entry.canonicalId
  ].filter(Boolean).join(" ");
}

async function readWorkspaceFile(
  workspaceDir: string,
  relativePath: string | undefined,
  maxChars: number
): Promise<string> {
  if (!relativePath) {
    return "";
  }
  try {
    const content = await readFile(path.resolve(workspaceDir, relativePath), "utf8");
    return content.slice(0, maxChars);
  } catch {
    return "";
  }
}

function preferredParsePath(entry: LocalPaperEntry): string | undefined {
  const priority = ["webpage", "tex-source", "opendataloader-hybrid", "opendataloader-local", "docling", "plain-text-baseline"];
  const priorityIndex = (engine: string): number => {
    const index = priority.indexOf(engine);
    return index >= 0 ? index : priority.length;
  };
  return entry.parses
    .slice()
    .sort((left, right) => priorityIndex(left.engine) - priorityIndex(right.engine))
    .find((parse) => parse.markdownPath)?.markdownPath;
}

async function buildEntryText(
  workspaceDir: string,
  entry: LocalPaperEntry,
  maxTextChars: number
): Promise<{
  metadata: string;
  title: string;
  body: string;
}> {
  const metadata = entryMetadata(entry);
  const [summaryText, parseText] = await Promise.all([
    readWorkspaceFile(workspaceDir, entry.wikiSummaryPath, maxTextChars),
    readWorkspaceFile(workspaceDir, preferredParsePath(entry), maxTextChars)
  ]);
  return {
    metadata,
    title: entry.title ?? entry.paperKey,
    body: [summaryText, parseText].filter(Boolean).join("\n\n")
  };
}

function createSnippet(text: string, terms: string[]): string | undefined {
  const compact = compactText(text);
  if (!compact) {
    return undefined;
  }
  const lower = compact.toLowerCase();
  const term = terms.find((candidate) => lower.includes(candidate));
  if (!term) {
    return compact.slice(0, MAX_SNIPPET_LENGTH);
  }
  const index = lower.indexOf(term);
  const start = Math.max(0, index - 100);
  const end = Math.min(compact.length, index + term.length + 150);
  return `${start > 0 ? "... " : ""}${compact.slice(start, end)}${end < compact.length ? " ..." : ""}`;
}

function scoreCandidate(input: {
  targetTitleTokens: Set<string>;
  targetBodyTokens: Set<string>;
  candidateTitle: string;
  candidateMetadata: string;
  candidateBody: string;
}): {
  score: number;
  sharedTerms: string[];
  reasons: string[];
} {
  const candidateTitleTokens = tokenize(input.candidateTitle);
  const candidateMetadataTokens = tokenize(input.candidateMetadata);
  const candidateBodyTokens = tokenize(input.candidateBody);
  const titleTitleTokens = candidateTitleTokens.filter((token) => input.targetTitleTokens.has(token));
  const metadataTitleTokens = candidateMetadataTokens.filter((token) => input.targetTitleTokens.has(token));
  const bodyTitleTokens = candidateBodyTokens.filter((token) => input.targetTitleTokens.has(token));
  const titleBodyTokens = candidateTitleTokens.filter((token) =>
    !input.targetTitleTokens.has(token) && input.targetBodyTokens.has(token)
  );
  const bodyBodyTokens = candidateBodyTokens.filter((token) =>
    !input.targetTitleTokens.has(token) && input.targetBodyTokens.has(token)
  );
  const sharedTerms = [...new Set([
    ...titleTitleTokens,
    ...metadataTitleTokens,
    ...bodyTitleTokens,
    ...titleBodyTokens,
    ...bodyBodyTokens
  ])].slice(0, 12);
  const score =
    titleTitleTokens.length * 24 +
    metadataTitleTokens.length * 12 +
    bodyTitleTokens.length * 4 +
    titleBodyTokens.length * 3 +
    Math.min(bodyBodyTokens.length, 15);
  const reasons = [
    titleTitleTokens.length > 0 ? `Shared target-title terms in candidate title: ${titleTitleTokens.slice(0, 6).join(", ")}.` : undefined,
    metadataTitleTokens.length > 0 ? `Shared target-title terms in candidate metadata: ${metadataTitleTokens.slice(0, 6).join(", ")}.` : undefined,
    bodyTitleTokens.length > 0 ? `Shared target-title terms in candidate body: ${bodyTitleTokens.slice(0, 6).join(", ")}.` : undefined,
    titleBodyTokens.length > 0 ? `Candidate title also overlaps target body: ${titleBodyTokens.slice(0, 6).join(", ")}.` : undefined,
    bodyBodyTokens.length > 0 ? `Shared body terms: ${bodyBodyTokens.slice(0, 8).join(", ")}.` : undefined
  ].filter((value): value is string => typeof value === "string");
  return { score, sharedTerms, reasons };
}

function normalizeMaxCandidates(value: number | undefined): number {
  return Math.max(1, Math.trunc(value ?? DEFAULT_MAX_CANDIDATES));
}

function normalizeMaxTextChars(value: number | undefined): number {
  return Math.max(1000, Math.trunc(value ?? DEFAULT_MAX_TEXT_CHARS));
}

export async function findPaperWikiRelations(
  options: FindPaperWikiRelationsOptions
): Promise<{
  paperKey: string;
  candidates: PaperWikiRelationCandidate[];
}> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const maxTextChars = normalizeMaxTextChars(options.maxTextChars);
  const maxCandidates = normalizeMaxCandidates(options.maxCandidates);
  const listed = await listLocalPapers({
    workspaceDir,
    status: "all",
    maxResults: Number.MAX_SAFE_INTEGER
  });
  const target = listed.results.find((entry) => entry.paperKey === options.paperKey);
  if (!target) {
    throw new Error(`No local paper found for ${options.paperKey}.`);
  }

  const targetText = await buildEntryText(workspaceDir, target, maxTextChars);
  const targetTitleTokens = new Set(tokenize([
    targetText.title,
    targetText.metadata
  ].join("\n\n")));
  const targetBodyTokens = new Set(tokenize(targetText.body));
  const candidates: PaperWikiRelationCandidate[] = [];

  for (const candidate of listed.results) {
    if (candidate.paperKey === target.paperKey) {
      continue;
    }
    const candidateText = await buildEntryText(workspaceDir, candidate, maxTextChars);
    const score = scoreCandidate({
      targetTitleTokens,
      targetBodyTokens,
      candidateTitle: candidateText.title,
      candidateMetadata: candidateText.metadata,
      candidateBody: candidateText.body
    });
    if (score.score <= 0) {
      continue;
    }
    candidates.push({
      paperKey: candidate.paperKey,
      ...(candidate.title ? { title: candidate.title } : {}),
      ...(candidate.source ? { source: String(candidate.source) } : {}),
      ...(candidate.articleUrl ? { articleUrl: candidate.articleUrl } : {}),
      score: score.score,
      sharedTerms: score.sharedTerms,
      reasons: score.reasons,
      ...(createSnippet(candidateText.body || candidateText.metadata, score.sharedTerms) ? {
        snippet: createSnippet(candidateText.body || candidateText.metadata, score.sharedTerms)
      } : {}),
      hasWikiSummary: candidate.hasWikiSummary,
      parseEngines: candidate.parses.map((parse) => parse.engine)
    });
  }

  return {
    paperKey: target.paperKey,
    candidates: candidates
      .sort((left, right) =>
        right.score - left.score ||
        left.paperKey.localeCompare(right.paperKey)
      )
      .slice(0, maxCandidates)
  };
}

function parseExistingRelatedPaperKeys(markdown: string): string[] {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter?.[1]) {
    return [];
  }
  const lines = frontmatter[1].split("\n");
  const start = lines.findIndex((line) => line.trim() === "related_papers: []" || line.startsWith("related_papers:"));
  if (start < 0) {
    return [];
  }
  const inline = lines[start].match(/^related_papers:\s*\[(.*)\]\s*$/);
  if (inline) {
    return inline[1]
      .split(",")
      .map((value) => value.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  - ")) {
      break;
    }
    values.push(line.slice(4).trim().replace(/^["']|["']$/g, ""));
  }
  return values.filter(Boolean);
}

function formatRelatedPaperKeys(keys: string[]): string {
  if (keys.length === 0) {
    return "related_papers: []";
  }
  return `related_papers: \n${keys.map((key) => `  - ${JSON.stringify(key)}`).join("\n")}`;
}

function replaceRelatedPaperKeys(markdown: string, keys: string[], updatedAt: string): string {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter?.[1]) {
    throw new Error("Wiki source summary is missing YAML frontmatter.");
  }
  const lines = frontmatter[1].split("\n");
  const start = lines.findIndex((line) => line.trim() === "related_papers: []" || line.startsWith("related_papers:"));
  const updatedAtIndex = lines.findIndex((line) => line.startsWith("updated_at:"));
  let relationStart = start;
  let linesWithUpdatedAt: string[];
  if (updatedAtIndex >= 0) {
    linesWithUpdatedAt = [
      ...lines.slice(0, updatedAtIndex),
      `updated_at: ${JSON.stringify(updatedAt)}`,
      ...lines.slice(updatedAtIndex + 1)
    ];
  } else if (start >= 0) {
    linesWithUpdatedAt = [
      ...lines.slice(0, start),
      `updated_at: ${JSON.stringify(updatedAt)}`,
      ...lines.slice(start)
    ];
    relationStart = start + 1;
  } else {
    linesWithUpdatedAt = [
      ...lines,
      `updated_at: ${JSON.stringify(updatedAt)}`
    ];
  }
  const replacement = formatRelatedPaperKeys(keys).split("\n");
  let nextLines: string[];
  if (relationStart < 0) {
    nextLines = [...linesWithUpdatedAt, ...replacement];
  } else {
    let end = relationStart + 1;
    while (end < linesWithUpdatedAt.length && linesWithUpdatedAt[end].startsWith("  - ")) {
      end += 1;
    }
    nextLines = [...linesWithUpdatedAt.slice(0, relationStart), ...replacement, ...linesWithUpdatedAt.slice(end)];
  }
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, `---\n${nextLines.join("\n")}\n---\n`);
}

function uniqueKeys(keys: string[], ownPaperKey: string): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter((key) => key && key !== ownPaperKey))];
}

export async function updatePaperWikiRelations(
  options: UpdatePaperWikiRelationsOptions
): Promise<PaperWikiRelationsUpdateResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const mode = options.mode ?? "append";
  await ensurePaperWikiScaffold(workspaceDir);
  const sourcePath = getPaperWikiSourcePath(workspaceDir, options.paperKey);
  const markdown = await readFile(sourcePath, "utf8");
  const previousRelatedPaperKeys = parseExistingRelatedPaperKeys(markdown);
  const relatedPaperKeys = mode === "replace"
    ? uniqueKeys(options.relatedPaperKeys, options.paperKey)
    : uniqueKeys([...previousRelatedPaperKeys, ...options.relatedPaperKeys], options.paperKey);
  const now = new Date().toISOString();
  await writeFile(sourcePath, replaceRelatedPaperKeys(markdown, relatedPaperKeys, now), "utf8");
  return {
    paperKey: options.paperKey,
    sourcePath: relativeToWorkspace(workspaceDir, sourcePath),
    previousRelatedPaperKeys,
    relatedPaperKeys,
    mode
  };
}

export async function paperWikiRelations(
  options: PaperWikiRelationsOptions
): Promise<PaperWikiRelationsResult> {
  const relationCandidates = await findPaperWikiRelations(options);
  const update = options.relatedPaperKeys
    ? await updatePaperWikiRelations({
      workspaceDir: options.workspaceDir,
      paperKey: options.paperKey,
      relatedPaperKeys: options.relatedPaperKeys,
      ...(options.mode ? { mode: options.mode } : {})
    })
    : undefined;
  return {
    ...relationCandidates,
    ...(update ? { update } : {})
  };
}
