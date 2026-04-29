import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { listLocalPapers, type LocalPaperEntry, type LocalPaperParseSummary } from "./local-paper-library.js";
import type { PaperRecord } from "./paper-types.js";

export type WikiHealthIssueKind =
  | "needs_download"
  | "needs_authorization"
  | "queued"
  | "parse_missing"
  | "parse_failed"
  | "low_quality"
  | "summary_missing"
  | "missing_artifact";

export type WikiHealthSeverity = "high" | "medium" | "low";

export interface WikiHealthIssue {
  kind: WikiHealthIssueKind;
  severity: WikiHealthSeverity;
  paperKey: string;
  title?: string;
  source?: string;
  status?: string;
  articleUrl?: string;
  recordPath?: string;
  reason: string;
  paths?: string[];
  quality?: {
    engine: string;
    status?: string;
    score?: number;
    warnings: string[];
  };
}

export interface WikiHealthOptions {
  workspaceDir: string;
  maxItems?: number;
  lowQualityScoreThreshold?: number;
}

export interface WikiHealthResult {
  totalPapers: number;
  issueCount: number;
  summary: Record<WikiHealthIssueKind, number>;
  issues: WikiHealthIssue[];
  actions: string[];
}

const ISSUE_KINDS: WikiHealthIssueKind[] = [
  "needs_download",
  "needs_authorization",
  "queued",
  "parse_missing",
  "parse_failed",
  "low_quality",
  "summary_missing",
  "missing_artifact"
];

const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_LOW_QUALITY_SCORE_THRESHOLD = 0.7;

function toWorkspacePath(workspaceDir: string, filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const uncWslMatch = filePath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+\\(.+)$/i);
  if (uncWslMatch?.[1]) {
    return path.posix.join("/", ...uncWslMatch[1].split(/[\\/]+/).filter(Boolean));
  }
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspaceDir, filePath);
}

async function pathExists(filePath: string | undefined): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readRecord(workspaceDir: string, entry: LocalPaperEntry): Promise<PaperRecord | undefined> {
  const recordPath = toWorkspacePath(workspaceDir, entry.recordPath);
  if (!recordPath) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(recordPath, "utf8")) as PaperRecord;
  } catch {
    return undefined;
  }
}

function baseIssue(
  entry: LocalPaperEntry,
  kind: WikiHealthIssueKind,
  severity: WikiHealthSeverity,
  reason: string
): WikiHealthIssue {
  return {
    kind,
    severity,
    paperKey: entry.paperKey,
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    ...(entry.articleUrl ? { articleUrl: entry.articleUrl } : {}),
    ...(entry.recordPath ? { recordPath: entry.recordPath } : {}),
    reason
  };
}

function textIncludesAccessProblem(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return /authorization|manual[_ -]?login|login|required|access wall|access_limited|credentials/i.test(value);
}

function recordNeedsAuthorization(record: PaperRecord | undefined): boolean {
  if (!record) {
    return false;
  }
  const failure = "failure" in record ? record.failure : undefined;
  return (
    record.status === "manual_fallback_opened" ||
    textIncludesAccessProblem(failure?.code) ||
    textIncludesAccessProblem(failure?.message) ||
    textIncludesAccessProblem(record.reading?.reason) ||
    textIncludesAccessProblem(record.webpage?.message) ||
    textIncludesAccessProblem(record.parse?.message)
  );
}

function recordIsQueued(record: PaperRecord | undefined): boolean {
  return (
    record?.reading?.status === "queued" ||
    record?.download?.status === "queued" ||
    record?.webpage?.status === "queued" ||
    record?.parse?.status === "queued"
  );
}

function recordParseFailed(record: PaperRecord | undefined): boolean {
  return (
    record?.reading?.status === "failed" ||
    record?.webpage?.status === "failed" ||
    record?.parse?.status === "failed"
  );
}

function parseIsLowQuality(parse: LocalPaperParseSummary, threshold: number): boolean {
  return (
    parse.status === "poor" ||
    parse.status === "needs_hybrid" ||
    (typeof parse.score === "number" && parse.score < threshold)
  );
}

async function missingArtifactPaths(workspaceDir: string, entry: LocalPaperEntry): Promise<string[]> {
  const paths = [
    entry.pdfPath,
    entry.wikiSummaryPath,
    ...entry.parses.flatMap((parse) => [
      parse.markdownPath,
      parse.parsePath,
      parse.qualityPath,
      parse.chunksPath
    ])
  ];
  const missing: string[] = [];
  for (const candidate of paths) {
    if (candidate && !(await pathExists(toWorkspacePath(workspaceDir, candidate)))) {
      missing.push(candidate);
    }
  }
  return missing;
}

function summarizeActions(issues: WikiHealthIssue[]): string[] {
  const counts = new Map<WikiHealthIssueKind, number>();
  for (const issue of issues) {
    counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  }
  return [
    ["needs_authorization", "Open/login through the paper browser or extension, then retry the affected downloads."],
    ["needs_download", "Retry or manually import papers that have no usable downloaded artifact."],
    ["queued", "Process queued browser-extension jobs before judging download or parse health."],
    ["parse_failed", "Re-run parsing or switch parser engines for failed records."],
    ["low_quality", "Inspect low-quality parses and prefer webpage/TeX/Docling alternatives where available."],
    ["parse_missing", "Parse downloaded papers that do not yet have reading artifacts."],
    ["summary_missing", "Write wiki source summaries for parsed papers without a summary page."],
    ["missing_artifact", "Repair or regenerate records that point at missing files."]
  ].flatMap(([kind, text]) => {
    const count = counts.get(kind as WikiHealthIssueKind) ?? 0;
    return count > 0 ? [`${count}: ${text}`] : [];
  });
}

export async function checkWikiHealth(options: WikiHealthOptions): Promise<WikiHealthResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const maxItems = Math.max(1, Math.trunc(options.maxItems ?? DEFAULT_MAX_ITEMS));
  const threshold = options.lowQualityScoreThreshold ?? DEFAULT_LOW_QUALITY_SCORE_THRESHOLD;
  const localPapers = await listLocalPapers({
    workspaceDir,
    status: "all",
    maxResults: Number.MAX_SAFE_INTEGER
  });
  const issues: WikiHealthIssue[] = [];

  for (const entry of localPapers.results) {
    const record = await readRecord(workspaceDir, entry);
    const pdfExists = await pathExists(toWorkspacePath(workspaceDir, entry.pdfPath));

    if (entry.status !== "downloaded" || (entry.status === "downloaded" && !pdfExists)) {
      issues.push(baseIssue(
        entry,
        "needs_download",
        "high",
        entry.status === "downloaded"
          ? "Record is downloaded, but the referenced PDF is missing."
          : `Record status is ${entry.status ?? "unknown"}, not downloaded.`
      ));
    }

    if (recordNeedsAuthorization(record)) {
      issues.push(baseIssue(entry, "needs_authorization", "high", "Record indicates login, authorization, or access-wall handling is needed."));
    }

    if (recordIsQueued(record)) {
      issues.push(baseIssue(entry, "queued", "medium", "Record has queued download, webpage, parse, or reading work."));
    }

    if (entry.status === "downloaded" && pdfExists && !entry.hasParsedArtifacts && record?.reading?.status !== "queued") {
      issues.push(baseIssue(entry, "parse_missing", "medium", "Downloaded paper has no parsed reading artifacts."));
    }

    if (recordParseFailed(record)) {
      issues.push(baseIssue(entry, "parse_failed", "high", record?.reading?.reason ?? "Record has failed parse, webpage, or reading status."));
    }

    for (const parse of entry.parses.filter((candidate) => parseIsLowQuality(candidate, threshold))) {
      issues.push({
        ...baseIssue(entry, "low_quality", "medium", `Parse quality is ${parse.status ?? "unknown"}${typeof parse.score === "number" ? ` with score ${parse.score}` : ""}.`),
        quality: {
          engine: parse.engine,
          ...(parse.status ? { status: parse.status } : {}),
          ...(typeof parse.score === "number" ? { score: parse.score } : {}),
          warnings: parse.warnings
        }
      });
    }

    if (entry.hasParsedArtifacts && !entry.hasWikiSummary) {
      issues.push(baseIssue(entry, "summary_missing", "low", "Parsed paper has no wiki source summary."));
    }

    const missingPaths = await missingArtifactPaths(workspaceDir, entry);
    if (missingPaths.length > 0) {
      issues.push({
        ...baseIssue(entry, "missing_artifact", "high", "One or more indexed artifacts are missing on disk."),
        paths: missingPaths
      });
    }
  }

  const summary = Object.fromEntries(ISSUE_KINDS.map((kind) => [kind, 0])) as Record<WikiHealthIssueKind, number>;
  for (const issue of issues) {
    summary[issue.kind] += 1;
  }

  const sortedIssues = issues.sort((left, right) => {
    const severityRank: Record<WikiHealthSeverity, number> = { high: 0, medium: 1, low: 2 };
    return (
      severityRank[left.severity] - severityRank[right.severity] ||
      left.kind.localeCompare(right.kind) ||
      left.paperKey.localeCompare(right.paperKey)
    );
  });

  return {
    totalPapers: localPapers.total,
    issueCount: issues.length,
    summary,
    issues: sortedIssues.slice(0, maxItems),
    actions: summarizeActions(issues)
  };
}
