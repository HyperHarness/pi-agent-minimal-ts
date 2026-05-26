import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getPaperWikiSourcePath,
  getPaperWikiSourcesDir,
  relativeToWorkspace,
  sanitizeWikiFilename
} from "./store.js";

export type WikiSourceKind =
  | "paper"
  | "material-database"
  | "software-doc"
  | "vendor-note"
  | "standard"
  | "lab-note"
  | "code-output"
  | "webpage"
  | "manual";

export type KnowledgeSourceStatus =
  | "ready"
  | "stale"
  | "blocked"
  | "low_quality"
  | "citation_incomplete"
  | "missing_artifact"
  | "version_unknown"
  | "needs_review";

export type KnowledgeSourceArtifactKind =
  | "raw"
  | "parse"
  | "chunk"
  | "table"
  | "figure"
  | "script"
  | "result"
  | "log"
  | "snapshot";

export interface KnowledgeSourceArtifact {
  kind: KnowledgeSourceArtifactKind;
  path: string;
  engine?: string;
  markdownPath?: string;
  jsonPath?: string;
  qualityPath?: string;
  sha256?: string;
  note?: string;
}

export interface KnowledgeSourceCitation {
  citationStatus: string;
  missingFields: string[];
  note?: string;
}

export interface KnowledgeSourceMetadata {
  schemaVersion: 1;
  sourceKind: WikiSourceKind;
  sourceKey: string;
  title: string;
  status: KnowledgeSourceStatus;
  createdAt: string;
  updatedAt: string;
  summaryPath: string;
  citation: KnowledgeSourceCitation;
  provenance: {
    acquisitionPath?: string;
    url?: string;
    doi?: string;
    arxivId?: string;
    source?: string;
    canonicalId?: string;
    recordPath?: string;
    rawPath?: string;
    rawSha256?: string;
    retrievedAt?: string;
    version?: string;
    softwareName?: string;
    softwareVersion?: string;
    vendor?: string;
    license?: string;
  };
  artifacts: KnowledgeSourceArtifact[];
  tags: string[];
  relatedSourceKeys: string[];
  synthesisPageKeys: string[];
}

export type ReadKnowledgeSourceMetadataResult =
  | {
      status: "ready";
      metadata: KnowledgeSourceMetadata;
      diagnostics: string[];
    }
  | {
      status: "missing";
      metadata?: undefined;
      diagnostics: string[];
    }
  | {
      status: "malformed";
      metadata?: undefined;
      diagnostics: string[];
    };

export const WIKI_SOURCE_KINDS: readonly WikiSourceKind[] = [
  "paper",
  "material-database",
  "software-doc",
  "vendor-note",
  "standard",
  "lab-note",
  "code-output",
  "webpage",
  "manual"
];

const WIKI_SOURCE_KIND_SET = new Set<string>(WIKI_SOURCE_KINDS);

export function isWikiSourceKind(value: unknown): value is WikiSourceKind {
  return typeof value === "string" && WIKI_SOURCE_KIND_SET.has(value);
}

const KNOWLEDGE_SOURCE_STATUSES = new Set<string>([
  "ready",
  "stale",
  "blocked",
  "low_quality",
  "citation_incomplete",
  "missing_artifact",
  "version_unknown",
  "needs_review"
]);

const KNOWLEDGE_SOURCE_ARTIFACT_KINDS = new Set<string>([
  "raw",
  "parse",
  "chunk",
  "table",
  "figure",
  "script",
  "result",
  "log",
  "snapshot"
]);

const KNOWLEDGE_SOURCE_ARTIFACT_OPTIONAL_STRING_FIELDS = [
  "engine",
  "markdownPath",
  "jsonPath",
  "qualityPath",
  "sha256",
  "note"
] as const;

const KNOWLEDGE_SOURCE_PROVENANCE_OPTIONAL_STRING_FIELDS = [
  "acquisitionPath",
  "url",
  "doi",
  "arxivId",
  "source",
  "canonicalId",
  "recordPath",
  "rawPath",
  "rawSha256",
  "retrievedAt",
  "version",
  "softwareName",
  "softwareVersion",
  "vendor",
  "license"
] as const;

export function getKnowledgeSourceMetadataPath(workspaceDir: string, sourceKey: string): string {
  return path.join(
    getPaperWikiSourcesDir(workspaceDir),
    sanitizeWikiFilename(sourceKey),
    "metadata.json"
  );
}

export async function writeKnowledgeSourceMetadata(input: {
  workspaceDir: string;
  metadata: KnowledgeSourceMetadata;
}): Promise<string> {
  const metadataPath = getKnowledgeSourceMetadataPath(input.workspaceDir, input.metadata.sourceKey);
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify(input.metadata, null, 2)}\n`, "utf8");
  return relativeToWorkspace(input.workspaceDir, metadataPath);
}

export async function readKnowledgeSourceMetadata(input: {
  workspaceDir: string;
  sourceKey: string;
  summaryPath?: string;
}): Promise<ReadKnowledgeSourceMetadataResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(getKnowledgeSourceMetadataPath(input.workspaceDir, input.sourceKey), "utf8")
    ) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: "missing", diagnostics: [] };
    }
    return { status: "malformed", diagnostics: ["malformed metadata JSON"] };
  }

  if (!isKnowledgeSourceMetadata(parsed)) {
    return { status: "malformed", diagnostics: ["malformed metadata shape"] };
  }

  const diagnostics = validateKnowledgeSourceMetadataIdentity({
    metadata: parsed,
    sourceKey: input.sourceKey,
    summaryPath: input.summaryPath
  });
  if (diagnostics.length > 0) {
    return { status: "malformed", diagnostics };
  }

  return { status: "ready", metadata: parsed, diagnostics: [] };
}

export function validateKnowledgeSourceMetadataIdentity(input: {
  metadata: KnowledgeSourceMetadata;
  sourceKey: string;
  summaryPath?: string;
}): string[] {
  const diagnostics: string[] = [];
  if (input.metadata.sourceKey !== input.sourceKey) {
    diagnostics.push(
      `sourceKey mismatch: metadata sourceKey "${input.metadata.sourceKey}" does not match requested source key "${input.sourceKey}".`
    );
  }
  if (
    input.summaryPath !== undefined &&
    normalizeMetadataRelativePath(input.metadata.summaryPath) !== normalizeMetadataRelativePath(input.summaryPath)
  ) {
    diagnostics.push(
      `summaryPath mismatch: metadata summaryPath "${input.metadata.summaryPath}" does not match source summary path "${input.summaryPath}".`
    );
  }
  return diagnostics;
}

function normalizeMetadataRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasOptionalStringFields<T extends readonly string[]>(
  value: Record<string, unknown>,
  fields: T
): boolean {
  return fields.every((field) => value[field] === undefined || typeof value[field] === "string");
}

function isKnowledgeSourceCitation(value: unknown): value is KnowledgeSourceCitation {
  return (
    isRecord(value) &&
    typeof value.citationStatus === "string" &&
    isStringArray(value.missingFields) &&
    (value.note === undefined || typeof value.note === "string")
  );
}

function isKnowledgeSourceProvenance(value: unknown): value is KnowledgeSourceMetadata["provenance"] {
  return (
    isRecord(value) &&
    hasOptionalStringFields(value, KNOWLEDGE_SOURCE_PROVENANCE_OPTIONAL_STRING_FIELDS)
  );
}

function isKnowledgeSourceArtifact(value: unknown): value is KnowledgeSourceArtifact {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    KNOWLEDGE_SOURCE_ARTIFACT_KINDS.has(value.kind) &&
    typeof value.path === "string" &&
    hasOptionalStringFields(value, KNOWLEDGE_SOURCE_ARTIFACT_OPTIONAL_STRING_FIELDS)
  );
}

function isKnowledgeSourceMetadata(value: unknown): value is KnowledgeSourceMetadata {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isWikiSourceKind(value.sourceKind) &&
    typeof value.sourceKey === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    KNOWLEDGE_SOURCE_STATUSES.has(value.status) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.summaryPath === "string" &&
    isKnowledgeSourceCitation(value.citation) &&
    isKnowledgeSourceProvenance(value.provenance) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isKnowledgeSourceArtifact) &&
    isStringArray(value.tags) &&
    isStringArray(value.relatedSourceKeys) &&
    isStringArray(value.synthesisPageKeys)
  );
}

function extractFrontmatter(markdown: string): string {
  return markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? "";
}

function parseYamlString(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || value === "[]") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return value.replace(/^"|"$/g, "");
  }
}

function readFrontmatterString(frontmatter: string, key: string): string | undefined {
  const raw = frontmatter
    .split("\n")
    .find((line) => line.startsWith(`${key}:`))
    ?.slice(key.length + 1);
  return parseYamlString(raw);
}

function readFrontmatterList(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) {
    const inline = lines.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
    if (!inline || inline === "[]") {
      return [];
    }
    if (inline.startsWith("[") && inline.endsWith("]")) {
      try {
        const parsed = JSON.parse(inline);
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
      } catch {
        return [];
      }
    }
    const value = parseYamlString(inline);
    return value ? [value] : [];
  }

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const value = parseYamlString(line.match(/^\s*-\s+(.+)$/)?.[1]);
    if (value) {
      values.push(value);
    }
  }
  return values;
}

export async function backfillKnowledgeSourceMetadataFromSummary(input: {
  workspaceDir: string;
  sourceKey: string;
}): Promise<string> {
  const summaryAbsolutePath = getPaperWikiSourcePath(input.workspaceDir, input.sourceKey);
  const markdown = await readFile(summaryAbsolutePath, "utf8");
  const frontmatter = extractFrontmatter(markdown);
  const now = new Date().toISOString();
  const sourceKey = readFrontmatterString(frontmatter, "paper_key") ?? input.sourceKey;
  const title =
    readFrontmatterString(frontmatter, "title") ??
    markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    sourceKey;
  const parseEngine = readFrontmatterString(frontmatter, "parse_engine");
  const parseMarkdown = readFrontmatterString(frontmatter, "parse_markdown");
  const parseJson = readFrontmatterString(frontmatter, "parse_json");
  const qualityJson = readFrontmatterString(frontmatter, "quality_json");
  const parsePath = parseMarkdown ?? parseJson ?? qualityJson;
  const artifacts: KnowledgeSourceArtifact[] = parsePath
    ? [{
        kind: "parse",
        path: parsePath,
        ...(parseEngine ? { engine: parseEngine } : {}),
        ...(parseMarkdown ? { markdownPath: parseMarkdown } : {}),
        ...(parseJson ? { jsonPath: parseJson } : {}),
        ...(qualityJson ? { qualityPath: qualityJson } : {})
      }]
    : [];

  return writeKnowledgeSourceMetadata({
    workspaceDir: input.workspaceDir,
    metadata: {
      schemaVersion: 1,
      sourceKind: "paper",
      sourceKey,
      title,
      status: (readFrontmatterString(frontmatter, "status") as KnowledgeSourceStatus | undefined) ?? "ready",
      createdAt: readFrontmatterString(frontmatter, "created_at") ?? now,
      updatedAt: readFrontmatterString(frontmatter, "updated_at") ?? now,
      summaryPath: relativeToWorkspace(input.workspaceDir, summaryAbsolutePath),
      citation: {
        citationStatus: "complete",
        missingFields: []
      },
      provenance: {
        ...(readFrontmatterString(frontmatter, "record") ? { acquisitionPath: readFrontmatterString(frontmatter, "record") } : {}),
        ...(readFrontmatterString(frontmatter, "article_url") ? { url: readFrontmatterString(frontmatter, "article_url") } : {}),
        ...(readFrontmatterString(frontmatter, "raw_pdf") ? { rawPath: readFrontmatterString(frontmatter, "raw_pdf") } : {}),
        ...(readFrontmatterString(frontmatter, "pdf_sha256") ? { rawSha256: readFrontmatterString(frontmatter, "pdf_sha256") } : {})
      },
      artifacts,
      tags: readFrontmatterList(frontmatter, "tags"),
      relatedSourceKeys: readFrontmatterList(frontmatter, "related_papers"),
      synthesisPageKeys: []
    }
  });
}
