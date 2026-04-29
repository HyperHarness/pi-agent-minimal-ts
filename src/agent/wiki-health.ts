import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { listLocalPapers, type LocalPaperEntry, type LocalPaperParseSummary } from "./local-paper-library.js";
import { downloadPaper, type DownloadPaperOptions } from "./paper-manager.js";
import { parsePaper, type ParsePaperOptions } from "./paper-reader/paper-reader.js";
import {
  generatePaperWikiSummary,
  type GeneratePaperWikiSummaryOptions,
  type PaperSummaryProgress,
  type PaperSummaryWorker
} from "./paper-summary.js";
import {
  updatePaperRecordParseManifest,
  updatePaperRecordReadingFailure
} from "./paper-store.js";
import type { PaperRecord } from "./paper-types.js";
import type { PaperParseResult } from "./paper-reader/types.js";

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

export type WikiHealthFixStatus = "fixed" | "queued" | "skipped" | "failed";

export interface WikiHealthFixItem {
  issue: WikiHealthIssue;
  status: WikiHealthFixStatus;
  action: string;
  message: string;
  details?: unknown;
}

export interface WikiHealthFixOptions extends WikiHealthOptions {
  issueKinds?: WikiHealthIssueKind[];
  dryRun?: boolean;
  downloadPaperImpl?: (options: DownloadPaperOptions) => Promise<Awaited<ReturnType<typeof downloadPaper>>>;
  parsePaperImpl?: (options: ParsePaperOptions) => Promise<PaperParseResult>;
  generatePaperWikiSummaryImpl?: (
    options: GeneratePaperWikiSummaryOptions
  ) => Promise<Awaited<ReturnType<typeof generatePaperWikiSummary>>>;
  paperSummaryWorker?: PaperSummaryWorker;
  onProgress?: WikiHealthFixProgressReporter;
}

export type WikiHealthFixProgressStage =
  | "checking_health"
  | "health_checked"
  | "summary_repair_start"
  | "summary_repair_progress"
  | "summary_repair_done";

export interface WikiHealthFixProgress {
  stage: WikiHealthFixProgressStage;
  paperKey?: string;
  issueKind?: WikiHealthIssueKind;
  index?: number;
  total?: number;
  message: string;
  summaryProgress?: PaperSummaryProgress;
}

export type WikiHealthFixProgressReporter = (
  progress: WikiHealthFixProgress
) => Promise<void> | void;

export interface WikiHealthFixResult {
  checked: WikiHealthResult;
  attempted: number;
  fixed: number;
  queued: number;
  skipped: number;
  failed: number;
  results: WikiHealthFixItem[];
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

function recordUsesPreprintFallback(record: PaperRecord | undefined): boolean {
  return record?.status === "preprint_fallback";
}

function recordIsPublisherPending(record: PaperRecord | undefined): boolean {
  return record?.status === "publisher_pending";
}

function parseIsLowQuality(parse: LocalPaperParseSummary, threshold: number): boolean {
  return (
    parse.status === "poor" ||
    parse.status === "needs_hybrid" ||
    (typeof parse.score === "number" && parse.score < threshold)
  );
}

function parseIsAcceptable(parse: LocalPaperParseSummary, threshold: number): boolean {
  return parse.status === "good" && (parse.score === undefined || parse.score >= threshold);
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
    const usesPreprintFallback = recordUsesPreprintFallback(record);
    const isPublisherPending = recordIsPublisherPending(record);
    const hasAcceptableParse = entry.parses.some((parse) => parseIsAcceptable(parse, threshold));
    const hasUsableParsedReading = entry.hasParsedArtifacts && hasAcceptableParse;
    const needsAuthorization = recordNeedsAuthorization(record) && !hasUsableParsedReading;

    if (!usesPreprintFallback && !isPublisherPending && !needsAuthorization && !hasUsableParsedReading && (entry.status !== "downloaded" || (entry.status === "downloaded" && !pdfExists))) {
      issues.push(baseIssue(
        entry,
        "needs_download",
        "high",
        entry.status === "downloaded"
          ? "Record is downloaded, but the referenced PDF is missing."
          : `Record status is ${entry.status ?? "unknown"}, not downloaded.`
      ));
    }

    if (needsAuthorization) {
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

    if (!usesPreprintFallback && !isPublisherPending && !needsAuthorization) {
      for (const parse of entry.parses.filter((candidate) => !hasAcceptableParse && parseIsLowQuality(candidate, threshold))) {
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
    }

    if (!usesPreprintFallback && !isPublisherPending && !needsAuthorization && entry.hasParsedArtifacts && !entry.hasWikiSummary) {
      issues.push(baseIssue(entry, "summary_missing", "low", "Parsed paper has no wiki source summary."));
    }

    if (!usesPreprintFallback && !isPublisherPending && !needsAuthorization) {
      const missingPaths = await missingArtifactPaths(workspaceDir, entry);
      if (missingPaths.length > 0) {
        issues.push({
          ...baseIssue(entry, "missing_artifact", "high", "One or more indexed artifacts are missing on disk."),
          paths: missingPaths
        });
      }
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

function issueIdentity(issue: WikiHealthIssue): string {
  return issue.recordPath ?? issue.articleUrl ?? issue.paperKey;
}

function isIssueKindSelected(issue: WikiHealthIssue, selectedKinds: Set<WikiHealthIssueKind> | undefined): boolean {
  return selectedKinds === undefined || selectedKinds.has(issue.kind);
}

function parseQualityIsAcceptable(result: PaperParseResult, threshold: number): boolean {
  return result.quality.status === "good" && result.quality.score >= threshold;
}

async function updateRecordWithParseResult(input: {
  workspaceDir: string;
  recordPath: string;
  result: PaperParseResult;
}): Promise<void> {
  const recordPath = toWorkspacePath(input.workspaceDir, input.recordPath) ?? input.recordPath;
  await updatePaperRecordParseManifest({
    workspaceDir: input.workspaceDir,
    recordPath,
    strategy: input.result.engine === "webpage" ? "webpage" : "pdf_parse",
    status: input.result.status,
    paperKey: input.result.paperKey,
    engine: input.result.engine,
    sourceSha256: input.result.pdfSha256,
    artifacts: input.result.artifacts,
    quality: input.result.quality
  });
}

async function fixByParsing(input: {
  workspaceDir: string;
  issue: WikiHealthIssue;
  force: boolean;
  threshold: number;
  parsePaperImpl: NonNullable<WikiHealthFixOptions["parsePaperImpl"]>;
  dryRun: boolean;
}): Promise<WikiHealthFixItem> {
  if (!input.issue.recordPath) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "parse",
      message: "Cannot parse automatically because the issue has no recordPath."
    };
  }
  if (input.dryRun) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "parse",
      message: `Dry run: would ${input.force ? "force re-parse" : "parse"} ${input.issue.recordPath}.`
    };
  }

  try {
    const result = await input.parsePaperImpl({
      workspaceDir: input.workspaceDir,
      recordPath: input.issue.recordPath,
      ...(input.force ? { force: true } : {})
    });
    await updateRecordWithParseResult({
      workspaceDir: input.workspaceDir,
      recordPath: input.issue.recordPath,
      result
    });
    if (input.issue.kind === "low_quality" && !parseQualityIsAcceptable(result, input.threshold)) {
      return {
        issue: input.issue,
        status: "failed",
        action: "parse",
        message:
          `Re-parse completed, but quality is still ${result.quality.status} with score ${result.quality.score}. Manual parser selection or source inspection is needed.`,
        details: result
      };
    }
    return {
      issue: input.issue,
      status: "fixed",
      action: "parse",
      message: `Parsed ${input.issue.paperKey} with ${result.engine}; record manifest updated.`,
      details: result
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Parse failed.";
    await updatePaperRecordReadingFailure({
      workspaceDir: input.workspaceDir,
      recordPath: toWorkspacePath(input.workspaceDir, input.issue.recordPath) ?? input.issue.recordPath,
      strategy: "pdf_parse",
      message
    }).catch(() => {});
    return {
      issue: input.issue,
      status: "failed",
      action: "parse",
      message
    };
  }
}

async function fixByDownload(input: {
  workspaceDir: string;
  issue: WikiHealthIssue;
  downloadPaperImpl: NonNullable<WikiHealthFixOptions["downloadPaperImpl"]>;
  dryRun: boolean;
  blockedByAuthorization: boolean;
}): Promise<WikiHealthFixItem> {
  if (input.blockedByAuthorization) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "download",
      message: "Cannot automatically fix until the user completes publisher login or access authorization."
    };
  }
  if (!input.issue.articleUrl) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "download",
      message: "Cannot retry download automatically because the issue has no articleUrl."
    };
  }
  if (input.dryRun) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "download",
      message: `Dry run: would retry download for ${input.issue.articleUrl}.`
    };
  }

  try {
    const result = await input.downloadPaperImpl({
      workspaceDir: input.workspaceDir,
      url: input.issue.articleUrl,
      ...(input.issue.title ? { title: input.issue.title } : {})
    });
    if (result.status === "downloaded" || result.status === "already_downloaded") {
      return {
        issue: input.issue,
        status: "fixed",
        action: "download",
        message: `Download is available for ${input.issue.paperKey}.`,
        details: result
      };
    }
    if (result.status === "extension_job_queued") {
      return {
        issue: input.issue,
        status: "queued",
        action: "download",
        message: "Browser extension job was queued; finish it in the browser before rerunning wiki_health.",
        details: result
      };
    }
    return {
      issue: input.issue,
      status: "skipped",
      action: "download",
      message: `Download did not complete automatically; resulting status is ${result.status}.`,
      details: result
    };
  } catch (error) {
    return {
      issue: input.issue,
      status: "failed",
      action: "download",
      message: error instanceof Error ? error.message : "Download retry failed."
    };
  }
}

async function fixBySummary(input: {
  workspaceDir: string;
  issue: WikiHealthIssue;
  index: number;
  total: number;
  generatePaperWikiSummaryImpl: NonNullable<WikiHealthFixOptions["generatePaperWikiSummaryImpl"]>;
  paperSummaryWorker?: PaperSummaryWorker;
  dryRun: boolean;
  onProgress?: WikiHealthFixProgressReporter;
}): Promise<WikiHealthFixItem> {
  if (input.dryRun) {
    await input.onProgress?.({
      stage: "summary_repair_done",
      paperKey: input.issue.paperKey,
      issueKind: input.issue.kind,
      index: input.index,
      total: input.total,
      message: `Dry run: would generate summary ${input.index}/${input.total} for ${input.issue.paperKey}.`
    });
    return {
      issue: input.issue,
      status: "skipped",
      action: "summary",
      message: `Dry run: would generate a grounded wiki source summary for ${input.issue.paperKey}.`
    };
  }

  try {
    await input.onProgress?.({
      stage: "summary_repair_start",
      paperKey: input.issue.paperKey,
      issueKind: input.issue.kind,
      index: input.index,
      total: input.total,
      message: `Generating summary ${input.index}/${input.total} for ${input.issue.paperKey}.`
    });
    const result = await input.generatePaperWikiSummaryImpl({
      workspaceDir: input.workspaceDir,
      paperKey: input.issue.paperKey,
      mode: "write",
      ...(input.paperSummaryWorker ? { summaryWorker: input.paperSummaryWorker } : {}),
      onProgress: async (summaryProgress) => {
        await input.onProgress?.({
          stage: "summary_repair_progress",
          paperKey: input.issue.paperKey,
          issueKind: input.issue.kind,
          index: input.index,
          total: input.total,
          message: `Summary ${input.index}/${input.total}: ${summaryProgress.message}`,
          summaryProgress
        });
      }
    });
    await input.onProgress?.({
      stage: "summary_repair_done",
      paperKey: input.issue.paperKey,
      issueKind: input.issue.kind,
      index: input.index,
      total: input.total,
      message: `Finished summary ${input.index}/${input.total} for ${input.issue.paperKey}: ${result.status}.`
    });
    if (result.status === "written") {
      return {
        issue: input.issue,
        status: "fixed",
        action: "summary",
        message: result.message,
        details: result
      };
    }
    return {
      issue: input.issue,
      status: "skipped",
      action: "summary",
      message: result.message,
      details: result
    };
  } catch (error) {
    await input.onProgress?.({
      stage: "summary_repair_done",
      paperKey: input.issue.paperKey,
      issueKind: input.issue.kind,
      index: input.index,
      total: input.total,
      message: `Failed summary ${input.index}/${input.total} for ${input.issue.paperKey}.`
    });
    return {
      issue: input.issue,
      status: "failed",
      action: "summary",
      message: error instanceof Error ? error.message : "Summary generation failed."
    };
  }
}

function skippedFix(issue: WikiHealthIssue, message: string): WikiHealthFixItem {
  return {
    issue,
    status: "skipped",
    action: issue.kind,
    message
  };
}

export async function fixWikiHealth(options: WikiHealthFixOptions): Promise<WikiHealthFixResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const threshold = options.lowQualityScoreThreshold ?? DEFAULT_LOW_QUALITY_SCORE_THRESHOLD;
  await options.onProgress?.({
    stage: "checking_health",
    message: "Checking wiki health before repair."
  });
  const checked = await checkWikiHealth(options);
  const selectedKinds = options.issueKinds ? new Set(options.issueKinds) : undefined;
  const issues = checked.issues.filter((issue) => isIssueKindSelected(issue, selectedKinds));
  const summaryIssues = issues.filter((issue) => issue.kind === "summary_missing");
  let summaryIssueIndex = 0;
  await options.onProgress?.({
    stage: "health_checked",
    total: summaryIssues.length,
    message: `Wiki health check found ${checked.issueCount} issues; ${summaryIssues.length} summary repairs selected.`
  });
  const authorizationBlocked = new Set(
    checked.issues
      .filter((issue) => issue.kind === "needs_authorization")
      .map(issueIdentity)
  );
  const parseAttempted = new Set<string>();
  const downloadAttempted = new Set<string>();
  const results: WikiHealthFixItem[] = [];

  for (const issue of issues) {
    const identity = issueIdentity(issue);
    if (issue.kind === "parse_missing" || issue.kind === "parse_failed" || issue.kind === "low_quality") {
      if (parseAttempted.has(identity)) {
        results.push(skippedFix(issue, "Skipped duplicate parse repair for the same paper."));
        continue;
      }
      parseAttempted.add(identity);
      results.push(await fixByParsing({
        workspaceDir,
        issue,
        force: issue.kind !== "parse_missing",
        threshold,
        parsePaperImpl: options.parsePaperImpl ?? parsePaper,
        dryRun: options.dryRun === true
      }));
      continue;
    }

    if (issue.kind === "needs_download") {
      if (downloadAttempted.has(identity)) {
        results.push(skippedFix(issue, "Skipped duplicate download repair for the same paper."));
        continue;
      }
      downloadAttempted.add(identity);
      results.push(await fixByDownload({
        workspaceDir,
        issue,
        downloadPaperImpl: options.downloadPaperImpl ?? downloadPaper,
        dryRun: options.dryRun === true,
        blockedByAuthorization: authorizationBlocked.has(identity)
      }));
      continue;
    }

    if (issue.kind === "needs_authorization") {
      results.push(skippedFix(issue, "Requires user login or publisher authorization in the browser; this cannot be completed automatically."));
      continue;
    }
    if (issue.kind === "queued") {
      results.push(skippedFix(issue, "Queued browser-extension work must finish in the browser/native host before automatic repair can continue."));
      continue;
    }
    if (issue.kind === "summary_missing") {
      summaryIssueIndex += 1;
      results.push(await fixBySummary({
        workspaceDir,
        issue,
        index: summaryIssueIndex,
        total: summaryIssues.length,
        generatePaperWikiSummaryImpl: options.generatePaperWikiSummaryImpl ?? generatePaperWikiSummary,
        ...(options.paperSummaryWorker ? { paperSummaryWorker: options.paperSummaryWorker } : {}),
        dryRun: options.dryRun === true,
        ...(options.onProgress ? { onProgress: options.onProgress } : {})
      }));
      continue;
    }
    if (issue.kind === "missing_artifact") {
      results.push(skippedFix(issue, "Missing artifacts require regenerating the owning download, parse, or summary artifact; rerun targeted repair after inspecting the missing paths."));
    }
  }

  return {
    checked,
    attempted: results.length,
    fixed: results.filter((result) => result.status === "fixed").length,
    queued: results.filter((result) => result.status === "queued").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    failed: results.filter((result) => result.status === "failed").length,
    results
  };
}
