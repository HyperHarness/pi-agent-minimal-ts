import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getPaperWikiSourceManifestPath,
  getPaperWikiSourcePath,
  relativeToWorkspace
} from "./store.js";

export type WikiSourceManifestStatus =
  | "ready"
  | "stale"
  | "blocked"
  | "low_quality"
  | "citation_incomplete"
  | "missing_artifact";

export type WikiSourceKind =
  | "paper"
  | "material-database"
  | "software-doc"
  | "vendor-note"
  | "standard"
  | "lab-note"
  | "code-output"
  | "design-artifact"
  | "webpage"
  | "manual";

export type WikiSourceManifestV2Status =
  | WikiSourceManifestStatus
  | "version_unknown"
  | "needs_review";

export type WikiSourceArtifactKind =
  | "raw"
  | "parse"
  | "table"
  | "figure"
  | "script"
  | "result"
  | "log"
  | "snapshot";

export interface WikiSourceArtifact {
  kind: WikiSourceArtifactKind;
  path: string;
  engine?: string;
  markdownPath?: string;
  jsonPath?: string;
  qualityPath?: string;
  sha256?: string;
  note?: string;
}

export interface WikiSourceManifestV2 {
  schemaVersion: 2;
  sourceKind: WikiSourceKind;
  sourceKey: string;
  title: string;
  status: WikiSourceManifestV2Status;
  createdAt: string;
  updatedAt: string;
  summaryPath: string;
  provenance: {
    url?: string;
    doi?: string;
    arxivId?: string;
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
  artifacts: WikiSourceArtifact[];
  tags: string[];
  relatedSourceKeys: string[];
  synthesisPageKeys: string[];
}

const WIKI_SOURCE_KINDS = new Set<string>([
  "paper",
  "material-database",
  "software-doc",
  "vendor-note",
  "standard",
  "lab-note",
  "code-output",
  "design-artifact",
  "webpage",
  "manual"
]);

const WIKI_SOURCE_MANIFEST_STATUSES = new Set<string>([
  "ready",
  "stale",
  "blocked",
  "low_quality",
  "citation_incomplete",
  "missing_artifact"
]);

const WIKI_SOURCE_MANIFEST_V2_STATUSES = new Set<string>([
  ...WIKI_SOURCE_MANIFEST_STATUSES,
  "version_unknown",
  "needs_review"
]);

const WIKI_SOURCE_ARTIFACT_KINDS = new Set<string>([
  "raw",
  "parse",
  "table",
  "figure",
  "script",
  "result",
  "log",
  "snapshot"
]);

const WIKI_SOURCE_ARTIFACT_OPTIONAL_STRING_FIELDS = [
  "engine",
  "markdownPath",
  "jsonPath",
  "qualityPath",
  "sha256",
  "note"
] as const;

const WIKI_SOURCE_PROVENANCE_OPTIONAL_STRING_FIELDS = [
  "url",
  "doi",
  "arxivId",
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

const WIKI_SOURCE_MANIFEST_V1_PROVENANCE_OPTIONAL_STRING_FIELDS = [
  "recordPath",
  "articleUrl",
  "rawPdfPath",
  "pdfSha256"
] as const;

const WIKI_SOURCE_MANIFEST_V1_PARSE_STRING_FIELDS = [
  "engine",
  "markdownPath",
  "jsonPath",
  "qualityPath"
] as const;

export interface WikiSourceManifest {
  schemaVersion: 1;
  kind: "paper-source";
  paperKey: string;
  title: string;
  status: WikiSourceManifestStatus;
  createdAt: string;
  updatedAt: string;
  sourceSummaryPath: string;
  provenance: {
    recordPath?: string;
    articleUrl?: string;
    rawPdfPath?: string;
    pdfSha256?: string;
  };
  parse: {
    engine: string;
    markdownPath: string;
    jsonPath: string;
    qualityPath: string;
  };
  tags: string[];
  relatedPaperKeys: string[];
  synthesisPageKeys: string[];
}

export function getWikiSourceManifestPath(workspaceDir: string, paperKey: string): string {
  return getPaperWikiSourceManifestPath(workspaceDir, paperKey);
}

export function normalizeWikiSourceManifest(
  manifest: WikiSourceManifest | WikiSourceManifestV2
): WikiSourceManifestV2 {
  if (manifest.schemaVersion === 2) {
    return manifest;
  }

  const artifacts: WikiSourceArtifact[] = [];
  if (manifest.provenance.rawPdfPath) {
    artifacts.push({
      kind: "raw",
      path: manifest.provenance.rawPdfPath,
      ...(manifest.provenance.pdfSha256 ? { sha256: manifest.provenance.pdfSha256 } : {})
    });
  }
  if (manifest.parse.markdownPath || manifest.parse.jsonPath || manifest.parse.qualityPath) {
    artifacts.push({
      kind: "parse",
      path: manifest.parse.markdownPath || manifest.parse.jsonPath || manifest.parse.qualityPath,
      engine: manifest.parse.engine,
      ...(manifest.parse.markdownPath ? { markdownPath: manifest.parse.markdownPath } : {}),
      ...(manifest.parse.jsonPath ? { jsonPath: manifest.parse.jsonPath } : {}),
      ...(manifest.parse.qualityPath ? { qualityPath: manifest.parse.qualityPath } : {})
    });
  }

  return {
    schemaVersion: 2,
    sourceKind: "paper",
    sourceKey: manifest.paperKey,
    title: manifest.title,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    summaryPath: manifest.sourceSummaryPath,
    provenance: {
      ...(manifest.provenance.articleUrl ? { url: manifest.provenance.articleUrl } : {}),
      ...(manifest.provenance.recordPath ? { recordPath: manifest.provenance.recordPath } : {}),
      ...(manifest.provenance.rawPdfPath ? { rawPath: manifest.provenance.rawPdfPath } : {}),
      ...(manifest.provenance.pdfSha256 ? { rawSha256: manifest.provenance.pdfSha256 } : {})
    },
    artifacts,
    tags: manifest.tags,
    relatedSourceKeys: manifest.relatedPaperKeys,
    synthesisPageKeys: manifest.synthesisPageKeys
  };
}

export async function writeWikiSourceManifest(input: {
  workspaceDir: string;
  manifest: WikiSourceManifest;
}): Promise<string> {
  const manifestPath = getWikiSourceManifestPath(input.workspaceDir, input.manifest.paperKey);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(input.manifest, null, 2)}\n`, "utf8");
  return relativeToWorkspace(input.workspaceDir, manifestPath);
}

export async function readWikiSourceManifest(input: {
  workspaceDir: string;
  paperKey: string;
}): Promise<WikiSourceManifest | undefined> {
  try {
    return JSON.parse(
      await readFile(getWikiSourceManifestPath(input.workspaceDir, input.paperKey), "utf8")
    ) as WikiSourceManifest;
  } catch {
    return undefined;
  }
}

export async function writeWikiSourceManifestV2(input: {
  workspaceDir: string;
  manifest: WikiSourceManifestV2;
}): Promise<string> {
  const manifestPath = getWikiSourceManifestPath(input.workspaceDir, input.manifest.sourceKey);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(input.manifest, null, 2)}\n`, "utf8");
  return relativeToWorkspace(input.workspaceDir, manifestPath);
}

export async function readNormalizedWikiSourceManifest(input: {
  workspaceDir: string;
  sourceKey: string;
}): Promise<WikiSourceManifestV2 | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(getWikiSourceManifestPath(input.workspaceDir, input.sourceKey), "utf8")
    ) as unknown;
    if (isWikiSourceManifestV2(manifest)) {
      return manifest;
    }
    if (isWikiSourceManifestV1(manifest)) {
      const normalized = normalizeWikiSourceManifest(manifest);
      return isWikiSourceManifestV2(normalized) ? normalized : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
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

function hasStringFields<T extends readonly string[]>(
  value: Record<string, unknown>,
  fields: T
): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

function isWikiSourceArtifact(value: unknown): value is WikiSourceArtifact {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    WIKI_SOURCE_ARTIFACT_KINDS.has(value.kind) &&
    typeof value.path === "string" &&
    hasOptionalStringFields(value, WIKI_SOURCE_ARTIFACT_OPTIONAL_STRING_FIELDS)
  );
}

function isWikiSourceProvenance(value: unknown): value is WikiSourceManifestV2["provenance"] {
  return (
    isRecord(value) &&
    hasOptionalStringFields(value, WIKI_SOURCE_PROVENANCE_OPTIONAL_STRING_FIELDS)
  );
}

function isWikiSourceManifestV1Provenance(value: unknown): value is WikiSourceManifest["provenance"] {
  return (
    isRecord(value) &&
    hasOptionalStringFields(value, WIKI_SOURCE_MANIFEST_V1_PROVENANCE_OPTIONAL_STRING_FIELDS)
  );
}

function isWikiSourceManifestV1Parse(value: unknown): value is WikiSourceManifest["parse"] {
  return (
    isRecord(value) &&
    hasStringFields(value, WIKI_SOURCE_MANIFEST_V1_PARSE_STRING_FIELDS)
  );
}

function isWikiSourceManifestV2(value: unknown): value is WikiSourceManifestV2 {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    typeof value.sourceKind === "string" &&
    WIKI_SOURCE_KINDS.has(value.sourceKind) &&
    typeof value.sourceKey === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    WIKI_SOURCE_MANIFEST_V2_STATUSES.has(value.status) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.summaryPath === "string" &&
    isWikiSourceProvenance(value.provenance) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isWikiSourceArtifact) &&
    isStringArray(value.tags) &&
    isStringArray(value.relatedSourceKeys) &&
    isStringArray(value.synthesisPageKeys)
  );
}

function isWikiSourceManifestV1(value: unknown): value is WikiSourceManifest {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.kind === "paper-source" &&
    typeof value.paperKey === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    WIKI_SOURCE_MANIFEST_STATUSES.has(value.status) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.sourceSummaryPath === "string" &&
    isWikiSourceManifestV1Provenance(value.provenance) &&
    isWikiSourceManifestV1Parse(value.parse) &&
    isStringArray(value.tags) &&
    isStringArray(value.relatedPaperKeys) &&
    isStringArray(value.synthesisPageKeys)
  );
}

function extractFrontmatter(markdown: string): string {
  return markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
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

export async function backfillWikiSourceManifestFromSummary(input: {
  workspaceDir: string;
  paperKey: string;
}): Promise<string> {
  const sourceSummaryPath = getPaperWikiSourcePath(input.workspaceDir, input.paperKey);
  const markdown = await readFile(sourceSummaryPath, "utf8");
  const frontmatter = extractFrontmatter(markdown);
  const now = new Date().toISOString();
  const title =
    readFrontmatterString(frontmatter, "title") ??
    markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    input.paperKey;
  const parseEngine = readFrontmatterString(frontmatter, "parse_engine") ?? "unknown";
  const manifest: WikiSourceManifest = {
    schemaVersion: 1,
    kind: "paper-source",
    paperKey: readFrontmatterString(frontmatter, "paper_key") ?? input.paperKey,
    title,
    status: "ready",
    createdAt: readFrontmatterString(frontmatter, "created_at") ?? now,
    updatedAt: readFrontmatterString(frontmatter, "updated_at") ?? now,
    sourceSummaryPath: relativeToWorkspace(input.workspaceDir, sourceSummaryPath),
    provenance: {
      ...(readFrontmatterString(frontmatter, "record") ? { recordPath: readFrontmatterString(frontmatter, "record") } : {}),
      ...(readFrontmatterString(frontmatter, "article_url") ? { articleUrl: readFrontmatterString(frontmatter, "article_url") } : {}),
      ...(readFrontmatterString(frontmatter, "raw_pdf") ? { rawPdfPath: readFrontmatterString(frontmatter, "raw_pdf") } : {}),
      ...(readFrontmatterString(frontmatter, "pdf_sha256") ? { pdfSha256: readFrontmatterString(frontmatter, "pdf_sha256") } : {})
    },
    parse: {
      engine: parseEngine,
      markdownPath: readFrontmatterString(frontmatter, "parse_markdown") ?? "",
      jsonPath: readFrontmatterString(frontmatter, "parse_json") ?? "",
      qualityPath: readFrontmatterString(frontmatter, "quality_json") ?? ""
    },
    tags: readFrontmatterList(frontmatter, "tags"),
    relatedPaperKeys: readFrontmatterList(frontmatter, "related_papers"),
    synthesisPageKeys: []
  };
  return writeWikiSourceManifest({
    workspaceDir: input.workspaceDir,
    manifest
  });
}
