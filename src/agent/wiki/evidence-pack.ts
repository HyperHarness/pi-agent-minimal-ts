import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolvePaperParseArtifactPaths } from "../paper/reading/paper-reader-store.js";
import type { ConcretePaperParseEngine } from "../paper/reading/types.js";
import { readWikiEvidenceItem, type WikiEvidenceItem } from "./retrieval-contract.js";
import { relativeToWorkspace } from "./store.js";
import type {
  PaperWikiPageEvidencePack,
  PaperWikiPageWorkerInput
} from "./types.js";

const MAX_SUMMARY_CHARS = 4000;
const MAX_CHUNK_CHARS = 1800;
const MAX_CHUNKS_PER_SOURCE = 3;
const MAX_TOTAL_CHUNKS = 10;

const CONCRETE_PARSE_ENGINES = new Set<string>([
  "tex-source",
  "opendataloader-local",
  "opendataloader-hybrid",
  "docling",
  "plain-text-baseline",
  "webpage"
]);

type SelectedEvidence = PaperWikiPageWorkerInput["evidence"][number];

interface PaperChunkRecord {
  id: string;
  paperKey?: string;
  engine?: string;
  text: string;
  pageFrom?: number;
  pageTo?: number;
  sectionId?: string;
}

function compactText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxChars
    ? `${compacted.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`
    : compacted;
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

function queryTerms(query: string): string[] {
  const terms = normalizeSearchText(query)
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return [...new Set(terms)];
}

function scoreChunk(text: string, terms: string[]): number {
  const normalized = normalizeSearchText(text);
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function isPaperChunkRecord(value: unknown): value is PaperChunkRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.text === "string";
}

async function readChunkJsonl(filePath: string): Promise<PaperChunkRecord[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isPaperChunkRecord);
}

function parseEvidenceAnchorClaims(item: WikiEvidenceItem): PaperWikiPageEvidencePack["claimProvenance"] {
  const anchorSection = item.body.match(/(?:^|\n)##\s+Evidence Anchors\s*\n([\s\S]*?)(?=\n##\s+|$)/)?.[1];
  if (!anchorSection) {
    return [];
  }

  const claims: PaperWikiPageEvidencePack["claimProvenance"] = [];
  const blocks = anchorSection
    .split(/\n(?=-\s+)/)
    .map((block) => block.trim())
    .filter(Boolean);
  for (const block of blocks) {
    const statement = block.match(/^-\s+(.+)$/m)?.[1]?.trim();
    if (!statement) {
      continue;
    }
    const quote = block.match(/^\s+-\s+Quote:\s+"([\s\S]*?)"\s*$/m)?.[1]?.trim();
    const locator = block.match(/^\s+-\s+Locator:\s+(.+)$/m)?.[1]?.trim();
    const fields = new Map<string, string>();
    for (const part of locator?.split(";") ?? []) {
      const [rawKey, ...rawValue] = part.split("=");
      const key = rawKey?.trim();
      const value = rawValue.join("=").trim();
      if (key && value) {
        fields.set(key, value);
      }
    }
    const sourceRef = fields.get("paper") ?? item.sourceKey ?? item.key;
    claims.push({
      sourceKey: item.sourceKey ?? item.key,
      statement,
      sourceRefs: sourceRef ? [sourceRef] : [],
      evidence: [{
        ...(sourceRef ? { paperKey: sourceRef } : {}),
        ...(fields.get("section") ? { sectionId: fields.get("section") } : {}),
        ...(fields.get("chunk") ? { chunkId: fields.get("chunk") } : {}),
        ...(fields.get("element") ? { elementId: fields.get("element") } : {}),
        ...(fields.get("figure") ? { figure: fields.get("figure") } : {}),
        ...(fields.get("table") ? { table: fields.get("table") } : {}),
        ...(fields.get("page") && Number.isFinite(Number(fields.get("page")))
          ? { page: Number(fields.get("page")) }
          : {}),
        ...(quote ? { quote } : {})
      }]
    });
  }
  return claims;
}

function anchorChunkIds(claims: PaperWikiPageEvidencePack["claimProvenance"]): Set<string> {
  return new Set(claims.flatMap((claim) =>
    claim.evidence.flatMap((evidence) => evidence.chunkId ? [evidence.chunkId] : [])
  ));
}

async function sourceChunkPathCandidates(item: WikiEvidenceItem, workspaceDir: string): Promise<Array<{
  path: string;
  relativePath: string;
}>> {
  const candidates: Array<{ path: string; relativePath: string }> = [];
  for (const artifact of item.metadata?.artifacts ?? []) {
    if (artifact.kind !== "parse" || !artifact.engine || !CONCRETE_PARSE_ENGINES.has(artifact.engine)) {
      continue;
    }
    const artifacts = await resolvePaperParseArtifactPaths({
      workspaceDir,
      paperKey: item.sourceKey ?? item.key,
      engine: artifact.engine as ConcretePaperParseEngine
    });
    candidates.push({
      path: artifacts.chunksPath,
      relativePath: relativeToWorkspace(workspaceDir, artifacts.chunksPath)
    });
  }
  return candidates;
}

async function selectedChunksForSource(input: {
  workspaceDir: string;
  source: WikiEvidenceItem;
  claims: PaperWikiPageEvidencePack["claimProvenance"];
  terms: string[];
  diagnostics: string[];
}): Promise<PaperWikiPageEvidencePack["selectedRawChunks"]> {
  const candidates = await sourceChunkPathCandidates(input.source, input.workspaceDir);
  if (candidates.length === 0) {
    return [];
  }

  const chunkIds = anchorChunkIds(input.claims);
  for (const candidate of candidates) {
    let chunks: PaperChunkRecord[];
    try {
      chunks = await readChunkJsonl(candidate.path);
    } catch (error) {
      input.diagnostics.push(
        `${candidate.relativePath}: unable to read raw chunks: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    const ranked = chunks
      .map((chunk, index) => ({
        chunk,
        index,
        matchedBy: chunkIds.has(chunk.id) ? "anchor" as const : "query" as const,
        score: chunkIds.has(chunk.id) ? 1000 : scoreChunk(chunk.text, input.terms)
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, MAX_CHUNKS_PER_SOURCE);

    return ranked.map(({ chunk, matchedBy }) => ({
      sourceKey: input.source.sourceKey ?? input.source.key,
      chunkId: chunk.id,
      path: candidate.relativePath,
      text: compactText(chunk.text, MAX_CHUNK_CHARS),
      ...(chunk.pageFrom !== undefined ? { pageFrom: chunk.pageFrom } : {}),
      ...(chunk.pageTo !== undefined ? { pageTo: chunk.pageTo } : {}),
      ...(chunk.sectionId ? { sectionId: chunk.sectionId } : {}),
      matchedBy
    }));
  }
  return [];
}

function pageClaimProvenance(item: WikiEvidenceItem): PaperWikiPageEvidencePack["claimProvenance"] {
  return (item.claims ?? []).map((claim) => ({
    pageKey: item.key,
    claimId: claim.claimId,
    statement: claim.statement,
    confidence: claim.confidence,
    sourceRefs: claim.sourceRefs,
    evidence: claim.evidence
  }));
}

function pageContradictionNotes(item: WikiEvidenceItem): PaperWikiPageEvidencePack["contradictionNotes"] {
  return (item.typedRelations ?? [])
    .filter((relation) => relation.type === "contradicts")
    .map((relation) => ({
      pageKey: item.key,
      target: relation.target,
      status: relation.status,
      evidenceRefs: relation.evidenceRefs,
      ...(relation.note ? { note: relation.note } : {})
    }));
}

export async function buildWikiPageEvidencePack(input: {
  workspaceDir: string;
  query: string;
  evidence: SelectedEvidence[];
}): Promise<PaperWikiPageEvidencePack> {
  const diagnostics: string[] = [];
  const candidateSummaries: PaperWikiPageEvidencePack["candidateSummaries"] = [];
  const selectedRawChunks: PaperWikiPageEvidencePack["selectedRawChunks"] = [];
  const claimProvenance: PaperWikiPageEvidencePack["claimProvenance"] = [];
  const contradictionNotes: PaperWikiPageEvidencePack["contradictionNotes"] = [];
  const terms = queryTerms(input.query);

  for (const selected of input.evidence) {
    const key = selected.paperKey ?? selected.pageKey ?? selected.key;
    if (!key) {
      continue;
    }
    const result = await readWikiEvidenceItem({
      workspaceDir: input.workspaceDir,
      kind: selected.kind ?? (selected.pageKey ? "page" : "source"),
      key
    });
    diagnostics.push(...result.diagnostics);
    if (result.status !== "ready" || !result.item) {
      continue;
    }

    if (result.item.kind === "source") {
      const sourceClaims = parseEvidenceAnchorClaims(result.item);
      candidateSummaries.push({
        sourceKey: result.item.sourceKey ?? result.item.key,
        title: result.item.title,
        path: result.item.relativePath,
        summary: compactText(result.item.body, MAX_SUMMARY_CHARS),
        ...(result.item.tags.length > 0 ? { tags: result.item.tags } : {}),
        ...(result.item.sourceKind ? { sourceKind: result.item.sourceKind } : {})
      });
      claimProvenance.push(...sourceClaims);
      selectedRawChunks.push(...await selectedChunksForSource({
        workspaceDir: input.workspaceDir,
        source: result.item,
        claims: sourceClaims,
        terms,
        diagnostics
      }));
      continue;
    }

    claimProvenance.push(...pageClaimProvenance(result.item));
    contradictionNotes.push(...pageContradictionNotes(result.item));
  }

  return {
    candidateSummaries,
    selectedRawChunks: selectedRawChunks.slice(0, MAX_TOTAL_CHUNKS),
    claimProvenance,
    contradictionNotes,
    diagnostics
  };
}
