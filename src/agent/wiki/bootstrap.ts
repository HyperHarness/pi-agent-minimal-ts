import { readFile } from "node:fs/promises";
import path from "node:path";
import { searchLocalPapers, type SearchLocalPapersResult } from "../paper/storage/local-paper-library.js";
import { searchPaperWiki } from "./content.js";
import {
  readKnowledgeSourceMetadata,
  type WikiSourceKind
} from "./source-metadata-store.js";
import {
  searchWikiEvidence,
  type WikiEvidenceSearchResult
} from "./retrieval-search.js";
import {
  listPaperWikiSourceFiles,
  paperKeyFromPaperWikiSourcePath,
  relativeToWorkspace,
  sanitizeWikiFilename
} from "./store.js";
import type {
  PaperWikiPageBootstrapEvidence,
  PaperWikiPageBootstrapMissingSummary,
  PaperWikiPageBootstrapOptions,
  PaperWikiPageBootstrapParsedFallback,
  PaperWikiPageBootstrapResult,
  PaperWikiSearchResult
} from "./types.js";

const DEFAULT_MAX_SEED_QUERIES = 4;
const DEFAULT_MAX_SOURCES = 12;
const RELATED_EXPANSION_LIMIT = 4;

interface SourceSummaryDocument {
  paperKey: string;
  title: string;
  path: string;
  body: string;
  tags: string[];
  relatedPaperKeys: string[];
  sourceKind?: WikiSourceKind;
}

export interface BootstrapPaperWikiPageEvidenceDependencies {
  searchPaperWikiImpl?: typeof searchPaperWiki;
  searchWikiEvidenceImpl?: typeof searchWikiEvidence;
  searchLocalPapersImpl?: typeof searchLocalPapers;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[_/]+/g, " ")
    .replace(/-/g, " ")
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addSeedQuery(queries: string[], value: string | undefined): void {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return;
  }
  if (!queries.some((query) => normalizeText(query) === normalizeText(trimmed))) {
    queries.push(trimmed);
  }
}

export function buildWikiPageSeedQueries(input: {
  topic: string;
  question?: string;
  maxSeedQueries?: number;
}): string[] {
  const maxSeedQueries = Math.max(1, Math.trunc(input.maxSeedQueries ?? DEFAULT_MAX_SEED_QUERIES));
  const combined = [input.topic, input.question].filter(Boolean).join(" ");
  const queries: string[] = [];
  addSeedQuery(queries, input.question);
  addSeedQuery(queries, input.topic);

  const lowerCombined = combined.toLowerCase();
  const hasQldpc = /\bqldpc\b/i.test(combined) || /量子.*ldpc|低密度/.test(combined);
  const hasSuperconducting = /超导|superconduct/i.test(combined);
  const hasImplementation = /实现|实验|难点|挑战|瓶颈|困难|implement|experiment|challenge/i.test(combined);

  if (hasQldpc && hasSuperconducting && hasImplementation) {
    addSeedQuery(queries, "qLDPC superconducting chip implementation challenges");
    addSeedQuery(queries, "quantum LDPC superconducting architecture non-local connectivity couplers crosstalk");
  } else {
    if (hasQldpc) {
      addSeedQuery(queries, "quantum LDPC qLDPC codes");
    }
    if (hasSuperconducting) {
      addSeedQuery(queries, "superconducting qubits chip architecture");
    }
    if (hasImplementation) {
      addSeedQuery(queries, "implementation challenges hardware limitations");
    }
  }

  const asciiTerms = lowerCombined.match(/[a-z][a-z0-9+.-]{2,}/g)?.join(" ");
  addSeedQuery(queries, asciiTerms);
  return queries.slice(0, maxSeedQueries);
}

function extractFrontmatter(markdown: string): string {
  return markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
}

function bodyWithoutFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

function extractTitle(markdown: string, fallback: string): string {
  const frontmatter = extractFrontmatter(markdown);
  const titleLine = frontmatter.split("\n").find((line) => line.startsWith("title:"));
  const rawTitle = titleLine?.slice("title:".length).trim();
  if (rawTitle) {
    try {
      const parsed = JSON.parse(rawTitle);
      if (typeof parsed === "string" && parsed.trim()) {
        return parsed.trim();
      }
    } catch {
      return rawTitle.replace(/^"|"$/g, "").trim();
    }
  }
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function extractYamlStringValues(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) {
    const inline = lines.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
    if (!inline || inline === "[]") {
      return [];
    }
    try {
      const parsed = JSON.parse(inline);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : typeof parsed === "string"
          ? [parsed]
          : [];
    } catch {
      return [inline.replace(/^"|"$/g, "")];
    }
  }

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const value = line.match(/^\s*-\s+(.+)$/)?.[1]?.trim();
    if (!value) {
      continue;
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") {
        values.push(parsed);
      }
    } catch {
      values.push(value.replace(/^"|"$/g, ""));
    }
  }
  return values;
}

function createSnippet(markdown: string): string {
  return bodyWithoutFrontmatter(markdown).replace(/\s+/g, " ").trim().slice(0, 320);
}

async function readSourceSummaryDocuments(workspaceDir: string): Promise<Map<string, SourceSummaryDocument>> {
  const files = await listPaperWikiSourceFiles(workspaceDir);
  const documents = new Map<string, SourceSummaryDocument>();
  for (const filePath of files) {
    const markdown = await readFile(filePath, "utf8").catch(() => undefined);
    if (!markdown) {
      continue;
    }
    const paperKey = paperKeyFromPaperWikiSourcePath(filePath);
    const metadata = await readKnowledgeSourceMetadata({
      workspaceDir,
      sourceKey: paperKey,
      summaryPath: relativeToWorkspace(workspaceDir, filePath)
    });
    const frontmatter = extractFrontmatter(markdown);
    documents.set(paperKey, {
      paperKey,
      title: metadata.metadata?.title ?? extractTitle(markdown, paperKey),
      path: relativeToWorkspace(workspaceDir, filePath),
      body: bodyWithoutFrontmatter(markdown),
      tags: metadata.metadata?.tags ?? extractYamlStringValues(frontmatter, "tags"),
      relatedPaperKeys: metadata.metadata?.relatedSourceKeys ?? extractYamlStringValues(frontmatter, "related_papers"),
      ...(metadata.metadata?.sourceKind ? { sourceKind: metadata.metadata.sourceKind } : {})
    });
  }
  return documents;
}

function toSourceEvidence(
  document: SourceSummaryDocument,
  origin: PaperWikiPageBootstrapEvidence["origin"],
  query?: string,
  snippet?: string
): PaperWikiPageBootstrapEvidence {
  return {
    kind: "source",
    key: document.paperKey,
    paperKey: document.paperKey,
    title: document.title,
    path: document.path,
    snippet: snippet ?? document.body.replace(/\s+/g, " ").trim().slice(0, 320),
    ...(query ? { query } : {}),
    origin,
    ...(document.sourceKind ? { sourceKind: document.sourceKind } : {}),
    tags: document.tags,
    relatedPaperKeys: document.relatedPaperKeys
  };
}

function toGeneralizedSourceEvidence(
  result: WikiEvidenceSearchResult,
  query: string
): PaperWikiPageBootstrapEvidence | undefined {
  if (result.item.kind !== "source") {
    return undefined;
  }

  const sourceKey = result.item.sourceKey ?? result.item.key;
  return {
    kind: "source",
    key: sourceKey,
    paperKey: sourceKey,
    title: result.item.title,
    path: result.item.relativePath,
    snippet: createSnippet(result.item.body),
    query,
    origin: "seed_search",
    ...(result.item.sourceKind ? { sourceKind: result.item.sourceKind } : {}),
    tags: result.item.tags,
    relatedPaperKeys: result.item.metadata?.relatedSourceKeys ?? []
  };
}

function addEvidence(
  items: PaperWikiPageBootstrapEvidence[],
  seenKeys: Set<string>,
  item: PaperWikiPageBootstrapEvidence,
  maxItems: number
): void {
  const dedupeKey = `${item.kind}:${item.key}`;
  if (seenKeys.has(dedupeKey) || items.length >= maxItems) {
    return;
  }
  seenKeys.add(dedupeKey);
  items.push(item);
}

function collectSearchEvidence(input: {
  wikiResults: PaperWikiSearchResult[];
  generalizedResults: Array<{ query: string; results: WikiEvidenceSearchResult[] }>;
  sourceDocuments: Map<string, SourceSummaryDocument>;
  maxSources: number;
}): {
  sourceEvidence: PaperWikiPageBootstrapEvidence[];
  pageContext: PaperWikiPageBootstrapEvidence[];
} {
  const sourceEvidence: PaperWikiPageBootstrapEvidence[] = [];
  const pageContext: PaperWikiPageBootstrapEvidence[] = [];
  const seenSources = new Set<string>();
  const seenPages = new Set<string>();

  for (const resultSet of input.wikiResults) {
    for (const result of resultSet.results) {
      const kind = result.kind ?? (result.pageKey ? "page" : "source");
      if (kind === "page") {
        const pageKey = result.key ?? result.pageKey ?? result.path;
        addEvidence(pageContext, seenPages, {
          kind: "page",
          key: pageKey,
          ...(result.pageKey ? { pageKey: result.pageKey } : {}),
          title: result.title,
          path: result.path,
          snippet: result.snippet,
          query: resultSet.query,
          origin: "seed_search"
        }, input.maxSources);
        continue;
      }

      const paperKey = result.paperKey ?? result.key;
      if (!paperKey) {
        continue;
      }
      const document = input.sourceDocuments.get(paperKey);
      const evidence = document
        ? toSourceEvidence(document, "seed_search", resultSet.query, result.snippet)
        : {
            kind: "source" as const,
            key: paperKey,
            paperKey,
            title: result.title,
            path: result.path,
            snippet: result.snippet,
            query: resultSet.query,
            origin: "seed_search" as const,
            ...(result.sourceKind ? { sourceKind: result.sourceKind } : {})
          };
      addEvidence(sourceEvidence, seenSources, evidence, input.maxSources);
    }
  }

  for (const resultSet of input.generalizedResults) {
    for (const result of resultSet.results) {
      const evidence = toGeneralizedSourceEvidence(result, resultSet.query);
      if (!evidence) {
        continue;
      }
      addEvidence(sourceEvidence, seenSources, evidence, input.maxSources);
    }
  }

  return { sourceEvidence, pageContext };
}

function expandRelatedSources(input: {
  selected: PaperWikiPageBootstrapEvidence[];
  sourceDocuments: Map<string, SourceSummaryDocument>;
  maxSources: number;
}): PaperWikiPageBootstrapEvidence[] {
  const selectedPaperKeys = new Set(input.selected.flatMap((item) => item.paperKey ? [item.paperKey] : []));
  const selectedTags = new Set(input.selected.flatMap((item) => item.tags ?? []).map((tag) => normalizeText(tag)));
  const candidates = [...input.sourceDocuments.values()]
    .filter((document) => !selectedPaperKeys.has(document.paperKey))
    .map((document) => {
      const tagOverlap = document.tags.filter((tag) => selectedTags.has(normalizeText(tag))).length;
      const relatedHit = document.relatedPaperKeys.some((paperKey) => selectedPaperKeys.has(paperKey))
        || [...selectedPaperKeys].some((paperKey) => {
          const selectedDocument = input.sourceDocuments.get(paperKey);
          return selectedDocument?.relatedPaperKeys.includes(document.paperKey) === true;
        });
      const score = tagOverlap * 3 + (relatedHit ? 8 : 0);
      return { document, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.document.paperKey.localeCompare(right.document.paperKey))
    .slice(0, Math.min(RELATED_EXPANSION_LIMIT, Math.max(0, input.maxSources - input.selected.length)));

  return candidates.map((candidate) => toSourceEvidence(candidate.document, "related_expansion"));
}

function collectParsedFallbacks(input: {
  results: SearchLocalPapersResult[];
  existingSourceKeys: Set<string>;
}): {
  parsedFallbackMatches: PaperWikiPageBootstrapParsedFallback[];
  missingSummaries: PaperWikiPageBootstrapMissingSummary[];
  fallbackSourceEvidence: PaperWikiPageBootstrapEvidence[];
} {
  const parsedFallbackMatches: PaperWikiPageBootstrapParsedFallback[] = [];
  const missingByPaper = new Map<string, PaperWikiPageBootstrapMissingSummary>();
  const fallbackSourceEvidence: PaperWikiPageBootstrapEvidence[] = [];
  const seenFallbackSources = new Set<string>();

  for (const resultSet of input.results) {
    for (const result of resultSet.results) {
      const matches = result.matches.slice(0, 2).map((match) => ({
        paperKey: result.paper.paperKey,
        ...(result.paper.title ? { title: result.paper.title } : {}),
        field: match.field,
        ...(match.path ? { path: match.path } : {}),
        snippet: match.snippet
      }));
      parsedFallbackMatches.push(...matches);

      if (result.paper.hasWikiSummary && result.paper.wikiSummaryPath && !seenFallbackSources.has(result.paper.paperKey)) {
        seenFallbackSources.add(result.paper.paperKey);
        fallbackSourceEvidence.push({
          kind: "source",
          key: result.paper.paperKey,
          paperKey: result.paper.paperKey,
          title: result.paper.title ?? result.paper.paperKey,
          path: result.paper.wikiSummaryPath,
          snippet: matches[0]?.snippet ?? "",
          query: resultSet.query,
          origin: "local_fallback"
        });
      }

      if (!result.paper.hasParsedArtifacts || result.paper.hasWikiSummary || input.existingSourceKeys.has(result.paper.paperKey)) {
        continue;
      }
      const previous = missingByPaper.get(result.paper.paperKey);
      if (previous) {
        previous.matches.push(...matches);
      } else {
        missingByPaper.set(result.paper.paperKey, {
          paperKey: result.paper.paperKey,
          ...(result.paper.title ? { title: result.paper.title } : {}),
          reason: "Parsed paper matched the topic but has no wiki source summary.",
          matches: [...matches]
        });
      }
    }
  }

  return {
    parsedFallbackMatches,
    missingSummaries: [...missingByPaper.values()],
    fallbackSourceEvidence
  };
}

export async function bootstrapPaperWikiPageEvidence(
  options: PaperWikiPageBootstrapOptions,
  dependencies: BootstrapPaperWikiPageEvidenceDependencies = {}
): Promise<PaperWikiPageBootstrapResult> {
  const topic = options.topic.trim();
  if (!topic) {
    throw new Error("topic is required.");
  }
  const workspaceDir = path.resolve(options.workspaceDir);
  const maxSources = Math.max(1, Math.trunc(options.maxSources ?? DEFAULT_MAX_SOURCES));
  const seedQueries = buildWikiPageSeedQueries({
    topic,
    ...(options.question ? { question: options.question } : {}),
    ...(options.maxSeedQueries !== undefined ? { maxSeedQueries: options.maxSeedQueries } : {})
  });
  const searchPaperWikiImpl = dependencies.searchPaperWikiImpl ?? searchPaperWiki;
  const searchWikiEvidenceImpl = dependencies.searchWikiEvidenceImpl ?? searchWikiEvidence;
  const searchLocalPapersImpl = dependencies.searchLocalPapersImpl ?? searchLocalPapers;
  const blocked: PaperWikiPageBootstrapResult["blocked"] = [];
  const sourceDocuments = await readSourceSummaryDocuments(workspaceDir);
  const wikiResults: PaperWikiSearchResult[] = [];
  const generalizedResults: Array<{ query: string; results: WikiEvidenceSearchResult[] }> = [];

  for (const query of seedQueries) {
    try {
      wikiResults.push(await searchPaperWikiImpl({
        workspaceDir,
        query,
        maxResults: maxSources
      }));
    } catch (error) {
      blocked.push({
        stage: "seed_search",
        reason: error instanceof Error ? error.message : `Wiki seed search failed for ${query}.`
      });
    }
    try {
      const result = await searchWikiEvidenceImpl({
        workspaceDir,
        query,
        preferredKinds: ["source"],
        maxResults: maxSources,
        itemFilter: (item) => item.kind === "source" && item.sourceKind !== undefined && item.sourceKind !== "paper"
      });
      if (result.status === "ready") {
        generalizedResults.push({
          query: result.query,
          results: result.results
        });
      }
    } catch (error) {
      blocked.push({
        stage: "seed_search",
        reason: error instanceof Error ? error.message : `Generalized wiki evidence search failed for ${query}.`
      });
    }
  }

  const { sourceEvidence, pageContext } = collectSearchEvidence({
    wikiResults,
    generalizedResults,
    sourceDocuments,
    maxSources
  });
  const seenSourceKeys = new Set(sourceEvidence.map((item) => item.key));
  const expandedSources = expandRelatedSources({
    selected: sourceEvidence,
    sourceDocuments,
    maxSources
  });
  for (const item of expandedSources) {
    addEvidence(sourceEvidence, seenSourceKeys, item, maxSources);
  }

  let parsedFallbackMatches: PaperWikiPageBootstrapParsedFallback[] = [];
  let missingSummaries: PaperWikiPageBootstrapMissingSummary[] = [];
  if ((options.includeParsedFallback ?? true) && sourceEvidence.length < maxSources) {
    const localResults: SearchLocalPapersResult[] = [];
    for (const query of seedQueries) {
      try {
        localResults.push(await searchLocalPapersImpl({
          workspaceDir,
          query,
          maxResults: maxSources
        }));
      } catch (error) {
        blocked.push({
          stage: "parsed_fallback",
          reason: error instanceof Error ? error.message : `Parsed fallback search failed for ${query}.`
        });
      }
    }
    const fallback = collectParsedFallbacks({
      results: localResults,
      existingSourceKeys: seenSourceKeys
    });
    parsedFallbackMatches = fallback.parsedFallbackMatches;
    missingSummaries = fallback.missingSummaries;
    for (const item of fallback.fallbackSourceEvidence) {
      addEvidence(sourceEvidence, seenSourceKeys, item, maxSources);
    }
  }

  const status: PaperWikiPageBootstrapResult["status"] =
    sourceEvidence.length > 0
      ? "ready"
      : missingSummaries.length > 0
        ? "needs_summary"
        : "insufficient_evidence";

  return {
    status,
    topic,
    ...(options.question ? { question: options.question } : {}),
    recommendedPageKey: sanitizeWikiFilename(topic.toLowerCase()),
    seedQueries,
    sourceEvidence,
    pageContext,
    expandedSources,
    parsedFallbackMatches,
    missingSummaries,
    blocked
  };
}
