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
