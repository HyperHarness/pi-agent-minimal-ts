import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getPaperWikiSourcesDir,
  relativeToWorkspace,
  sanitizeWikiFilename
} from "./store.js";
import { isPathInsideDirectory } from "../knowledge-base.js";

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
    downloadPath?: string;
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
  "downloadPath",
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
  const metadata = normalizeKnowledgeSourceMetadataPaths(input.workspaceDir, input.metadata);
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return relativeToWorkspace(input.workspaceDir, metadataPath);
}

function normalizePortableFilePath(filePath: string): string {
  const drivePathMatch = filePath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drivePathMatch?.[1] && drivePathMatch[2]) {
    return path.posix.join(
      "/mnt",
      drivePathMatch[1].toLowerCase(),
      ...drivePathMatch[2].split(/[\\/]+/).filter(Boolean)
    );
  }

  const uncWslMatch = filePath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+\\(.+)$/i);
  if (uncWslMatch?.[1]) {
    return path.posix.join("/", ...uncWslMatch[1].split(/[\\/]+/).filter(Boolean));
  }

  if (filePath.startsWith("\\") && !filePath.startsWith("\\\\")) {
    return path.posix.join("/", ...filePath.split(/[\\/]+/).filter(Boolean));
  }

  return filePath.includes("\\") ? filePath.replace(/\\/g, "/") : filePath;
}

function toWorkspaceRelativePath(workspaceDir: string, filePath: string): string {
  const normalizedPath = normalizePortableFilePath(filePath);
  if (!path.isAbsolute(normalizedPath)) {
    return normalizedPath;
  }

  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedPath = path.resolve(normalizedPath);
  return isPathInsideDirectory(resolvedWorkspaceDir, resolvedPath)
    ? path.relative(resolvedWorkspaceDir, resolvedPath)
    : normalizedPath;
}

function normalizeOptionalPathField(workspaceDir: string, value: unknown): unknown {
  return typeof value === "string" ? toWorkspaceRelativePath(workspaceDir, value) : value;
}

function normalizeKnowledgeSourceMetadataPaths(
  workspaceDir: string,
  metadata: KnowledgeSourceMetadata
): KnowledgeSourceMetadata {
  const provenance = metadata.provenance as KnowledgeSourceMetadata["provenance"] & {
    downloadPath?: string;
  };
  const normalizedArtifacts = metadata.artifacts.map((artifact) => ({
    ...artifact,
    path: toWorkspaceRelativePath(workspaceDir, artifact.path),
    markdownPath: normalizeOptionalPathField(workspaceDir, artifact.markdownPath) as string | undefined,
    jsonPath: normalizeOptionalPathField(workspaceDir, artifact.jsonPath) as string | undefined,
    qualityPath: normalizeOptionalPathField(workspaceDir, artifact.qualityPath) as string | undefined
  }));
  if (metadata.sourceKind === "paper") {
    return {
      ...metadata,
      summaryPath: toWorkspaceRelativePath(workspaceDir, metadata.summaryPath),
      provenance: {
        ...(provenance.url ? { url: provenance.url } : {}),
        ...(provenance.doi ? { doi: provenance.doi } : {}),
        ...(provenance.arxivId ? { arxivId: provenance.arxivId } : {}),
        ...(provenance.acquisitionPath ? {
          acquisitionPath: normalizeOptionalPathField(workspaceDir, provenance.acquisitionPath) as string | undefined
        } : {}),
        ...(provenance.retrievedAt ? { retrievedAt: provenance.retrievedAt } : {}),
        ...(provenance.version ? { version: provenance.version } : {})
      },
      artifacts: normalizedArtifacts.filter((artifact) => artifact.kind === "parse")
    };
  }
  const normalizedProvenance = {
    ...provenance,
    acquisitionPath: normalizeOptionalPathField(workspaceDir, provenance.acquisitionPath) as string | undefined,
    recordPath: normalizeOptionalPathField(workspaceDir, provenance.recordPath) as string | undefined,
    rawPath: normalizeOptionalPathField(workspaceDir, provenance.rawPath) as string | undefined,
    downloadPath: normalizeOptionalPathField(workspaceDir, provenance.downloadPath) as string | undefined
  };
  return {
    ...metadata,
    summaryPath: toWorkspaceRelativePath(workspaceDir, metadata.summaryPath),
    provenance: normalizedProvenance,
    artifacts: normalizedArtifacts
  };
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
