import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { listLocalPapers, type LocalPaperEntry, type LocalPaperParseSummary } from "../paper/storage/local-paper-library.js";
import { downloadPaper, type DownloadPaperOptions } from "../paper/acquisition/paper-manager.js";
import { parsePaper, type ParsePaperOptions } from "../paper/reading/paper-reader.js";
import {
  generatePaperWikiSummary,
  type GeneratePaperWikiSummaryOptions,
  type PaperSummaryProgress,
  type PaperSummaryWorker
} from "./summary.js";
import { backfillWikiSourceManifestFromSummary } from "./manifest-store.js";
import {
  getPaperWikiSourceManifestPath,
  relativeToWorkspace
} from "./store.js";
import { readWikiOperationEvents } from "./journal.js";
import { listTypedWikiPages, type WikiPageDiagnostic } from "./typed-store.js";
import {
  readPaperDownloadJobEvents,
  type PaperDownloadJobEvent
} from "../paper/extension/paper-download-jobs.js";
import {
  updatePaperRecordParseManifest,
  updatePaperRecordReadingFailure,
  writePaperSourceMetadataForRecord,
  writePaperSourceMetadataForSource
} from "../paper/storage/paper-store.js";
import {
  derivePaperKeyForBlocklist,
  findBlockedPaperDownload,
  type PaperBlocklistEntry
} from "../paper/acquisition/paper-blocklist.js";
import type { PaperCitationStatus, PaperRecord, PaperSource, PaperSourceMetadata } from "../paper/types.js";
import type { PaperParseResult } from "../paper/reading/types.js";

export type WikiHealthIssueKind =
  | "needs_download"
  | "needs_authorization"
  | "queued"
  | "parse_missing"
  | "parse_failed"
  | "low_quality"
  | "summary_missing"
  | "source_manifest_missing"
  | "missing_artifact"
  | "download_blocked"
  | "citation_incomplete"
  | "wiki_page_malformed"
  | "wiki_page_evidence_weak"
  | "wiki_operation_interrupted";

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
  path?: string;
  operationId?: string;
  reason: string;
  paths?: string[];
  metadata?: {
    sourcePath?: string;
    citationStatus?: PaperCitationStatus | string;
    missingFields: string[];
  };
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
  summary: Record<string, number>;
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
  paperDownloadWorker?: PaperDownloadWorker;
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

export interface PaperDownloadWorkerMetadataRefreshOptions {
  workspaceDir: string;
  paperKey: string;
  recordPath?: string;
  sourcePath?: string;
  articleUrl?: string;
  title?: string;
}

export interface PaperDownloadWorkerMetadataRefreshResult {
  status: "refreshed" | "skipped";
  message: string;
  sourcePath?: string;
  citationStatus?: PaperCitationStatus | string;
  missingFields?: string[];
}

export interface PaperDownloadWorker {
  downloadPaper(options: DownloadPaperOptions): Promise<Awaited<ReturnType<typeof downloadPaper>>>;
  refreshSourceMetadata(options: PaperDownloadWorkerMetadataRefreshOptions): Promise<PaperDownloadWorkerMetadataRefreshResult>;
}

const ISSUE_KINDS: WikiHealthIssueKind[] = [
  "needs_download",
  "needs_authorization",
  "queued",
  "parse_missing",
  "parse_failed",
  "low_quality",
  "summary_missing",
  "source_manifest_missing",
  "missing_artifact",
  "download_blocked",
  "citation_incomplete",
  "wiki_page_malformed",
  "wiki_page_evidence_weak",
  "wiki_operation_interrupted"
];

const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_LOW_QUALITY_SCORE_THRESHOLD = 0.7;
const DOWNLOAD_BLOCKABLE_ISSUE_KINDS = new Set<WikiHealthIssueKind>([
  "needs_download",
  "needs_authorization"
]);
const TYPED_WIKI_PAGE_TYPES = new Set([
  "paper-source",
  "synthesis",
  "concept",
  "method",
  "finding",
  "dataset",
  "question",
  "design-record",
  "alias"
]);

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

function missingCitationFields(entry: LocalPaperEntry, sourceExists: boolean): string[] {
  if (!sourceExists) {
    return ["source.json"];
  }
  const fields = entry.missingCitationFields?.filter((field) => field.trim().length > 0) ?? [];
  if (fields.length > 0) {
    return fields;
  }
  return entry.citationStatus === "incomplete" ? ["unknown"] : [];
}

async function citationIssueForEntry(workspaceDir: string, entry: LocalPaperEntry): Promise<WikiHealthIssue | undefined> {
  if (!entry.sourcePath) {
    return undefined;
  }
  const sourceExists = await pathExists(toWorkspacePath(workspaceDir, entry.sourcePath));
  const fields = missingCitationFields(entry, sourceExists);
  if (fields.length === 0 && entry.citationStatus !== "incomplete") {
    return undefined;
  }
  return {
    ...baseIssue(
      entry,
      "citation_incomplete",
      "medium",
      sourceExists
        ? `Source citation metadata is incomplete; missing fields: ${fields.join(", ")}.`
        : "Source citation metadata file is missing next to the acquisition record."
    ),
    ...(sourceExists ? {} : { paths: [entry.sourcePath] }),
    metadata: {
      sourcePath: entry.sourcePath,
      ...(entry.citationStatus ? { citationStatus: entry.citationStatus } : {}),
      missingFields: fields
    }
  };
}

function textIncludesAccessProblem(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return /authorization|manual[_ -]?login|login|required|access wall|access_limited|access options|credentials|cloudflare|cdn-cgi|captcha|challenge|user verification|publisher verification|verify you are human|verify article access|license does not permit|license[_ -]?not[_ -]?permitted|publisher_license_not_permitted|publisher pdf cannot be downloaded/i.test(value);
}

function textIncludesLicenseProblem(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return /license does not permit|license[_ -]?not[_ -]?permitted|publisher_license_not_permitted|publisher pdf cannot be downloaded/i.test(value);
}

function recordAuthorizationReason(record: PaperRecord | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  const failure = "failure" in record ? record.failure : undefined;
  if (record.status === "manual_fallback_opened") {
    return "Record is in manual fallback mode; complete publisher login or verification in the browser, then retry.";
  }
  for (const value of [
    failure?.message,
    record.reading?.reason,
    record.webpage?.message,
    record.parse?.message,
    failure?.code
  ]) {
    if (textIncludesAccessProblem(value)) {
      return `Record reports: ${value}`;
    }
  }
  return undefined;
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
  if (record?.reading?.status === "ready") {
    return false;
  }

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

function isPaperSource(value: string | undefined): value is PaperSource {
  return value === "arxiv" || value === "science" || value === "nature" || value === "aps" || value === "external";
}

function normalizeArticleUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value.trim();
  }
}

function jobMatchesEntry(entry: LocalPaperEntry, job: PaperDownloadJobEvent): boolean {
  const articleUrl = normalizeArticleUrl(entry.articleUrl);
  return Boolean(
    (job.paperKey && job.paperKey === entry.paperKey) ||
    (articleUrl && normalizeArticleUrl(job.articleUrl) === articleUrl)
  );
}

function findMatchingJobsForEntry(entry: LocalPaperEntry, jobs: PaperDownloadJobEvent[]): PaperDownloadJobEvent[] {
  return jobs.filter((job) => jobMatchesEntry(entry, job)).sort((left, right) =>
    Date.parse(right.recordedAt) - Date.parse(left.recordedAt)
  );
}

function jobAuthorizationReason(job: PaperDownloadJobEvent | undefined): string | undefined {
  if (!job) {
    return undefined;
  }
  if (job.status === "awaiting_user_verification") {
    return job.message
      ? `Browser extension reports: ${job.message}`
      : "Browser extension reports that the publisher page needs user verification.";
  }
  for (const value of [job.message, job.failureCode]) {
    if (textIncludesAccessProblem(value)) {
      return `Browser extension reports: ${value}`;
    }
  }
  return undefined;
}

function findAccessProblemJobForEntry(
  entry: LocalPaperEntry,
  jobs: PaperDownloadJobEvent[]
): PaperDownloadJobEvent | undefined {
  const accessJobs = findMatchingJobsForEntry(entry, jobs).filter((job) => jobAuthorizationReason(job));
  return accessJobs.find((job) =>
    textIncludesLicenseProblem(job.failureCode) ||
    textIncludesLicenseProblem(job.message)
  ) ?? accessJobs[0];
}

function entryIsSupportedPublisher(entry: LocalPaperEntry): boolean {
  return entry.source === "science" || entry.source === "nature" || entry.source === "aps";
}

async function findBlockedEntry(workspaceDir: string, entry: LocalPaperEntry): Promise<PaperBlocklistEntry | undefined> {
  const source = isPaperSource(entry.source) ? entry.source : undefined;
  return findBlockedPaperDownload({
    workspaceDir,
    lookup: {
      paperKey: entry.paperKey,
      ...(source ? { source } : {}),
      ...(entry.canonicalId ? { canonicalId: entry.canonicalId } : {}),
      ...(entry.articleUrl ? { articleUrl: entry.articleUrl } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(!entry.paperKey && source && entry.canonicalId
        ? { paperKey: derivePaperKeyForBlocklist({ source, canonicalId: entry.canonicalId }) }
        : {})
    }
  });
}

function downloadBlockedIssue(entry: LocalPaperEntry, blocked: PaperBlocklistEntry): WikiHealthIssue {
  return baseIssue(
    entry,
    "download_blocked",
    "low",
    blocked.note
      ? `Paper download is blocked by the local download blocklist (${blocked.reasonCode}): ${blocked.note}`
      : `Paper download is blocked by the local download blocklist (${blocked.reasonCode}); download and authorization health issues are downgraded.`
  );
}

function diagnosticReason(diagnostic: WikiPageDiagnostic): string {
  return diagnostic.errors.map((error) => error.message).join(" ");
}

function diagnosticPaths(workspaceDir: string, diagnostic: WikiPageDiagnostic): string[] {
  const paths = new Set<string>([diagnostic.relativePath]);
  for (const error of diagnostic.errors) {
    if (!error.path) {
      continue;
    }
    paths.add(path.isAbsolute(error.path) ? relativeToWorkspace(workspaceDir, error.path) : error.path);
  }
  return [...paths];
}

function extractFrontmatter(markdown: string): string {
  return markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? "";
}

function parseFrontmatterScalar(frontmatter: string, key: string): string | undefined {
  const rawValue = frontmatter
    .split("\n")
    .find((line) => line.startsWith(`${key}:`))
    ?.slice(key.length + 1)
    .trim();
  if (!rawValue) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawValue);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return rawValue.replace(/^"|"$/g, "").trim();
  }
}

function frontmatterOptsIntoTypedSchema(frontmatter: string): boolean {
  if (/^schema_version:/m.test(frontmatter)) {
    return true;
  }
  const type = parseFrontmatterScalar(frontmatter, "type");
  return Boolean(type && TYPED_WIKI_PAGE_TYPES.has(type));
}

async function diagnosticOptsIntoTypedSchema(diagnostic: WikiPageDiagnostic): Promise<boolean> {
  const markdown = await readFile(diagnostic.path, "utf8").catch(() => "");
  return frontmatterOptsIntoTypedSchema(extractFrontmatter(markdown));
}

function diagnosticHasOnlyMissingSourceRefs(diagnostic: WikiPageDiagnostic): boolean {
  return diagnostic.errors.length > 0 && diagnostic.errors.every((error) => error.code === "missing_source_refs");
}

function typedDiagnosticIssue(workspaceDir: string, diagnostic: WikiPageDiagnostic): WikiHealthIssue {
  const kind: WikiHealthIssueKind = diagnosticHasOnlyMissingSourceRefs(diagnostic)
    ? "wiki_page_evidence_weak"
    : "wiki_page_malformed";
  return {
    kind,
    severity: "medium",
    paperKey: diagnostic.relativePath,
    path: diagnostic.relativePath,
    reason: diagnosticReason(diagnostic),
    paths: diagnosticPaths(workspaceDir, diagnostic)
  };
}

function entryHasOnlyWebpageReading(entry: LocalPaperEntry): boolean {
  return entry.hasParsedArtifacts && entry.parses.every((parse) => parse.engine === "webpage");
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
    ["parse_failed", "Re-run parsing or switch parser engines for failed acquisitions."],
    ["low_quality", "Inspect low-quality parses and prefer webpage/TeX/Docling alternatives where available."],
    ["parse_missing", "Parse downloaded papers that do not yet have reading artifacts."],
    ["summary_missing", "Write wiki source summaries for parsed papers without a summary page."],
    ["source_manifest_missing", "Backfill source manifests for existing wiki source summaries."],
    ["missing_artifact", "Repair or regenerate acquisition files that point at missing files."],
    ["download_blocked", "No repair needed for download-blocklisted papers unless the paper is removed from the local download blocklist."],
    ["citation_incomplete", "Refresh source citation metadata through the paper-download-subagent metadata pass."],
    ["wiki_page_malformed", "Repair malformed typed wiki page frontmatter before relying on the page in retrieval or synthesis."],
    ["wiki_page_evidence_weak", "Add source_refs to paper-backed typed wiki pages or weaken the evidence contract."],
    ["wiki_operation_interrupted", "Inspect the wiki operation journal and rerun or repair interrupted multi-file wiki writes."]
  ].flatMap(([kind, text]) => {
    const count = counts.get(kind as WikiHealthIssueKind) ?? 0;
    return count > 0 ? [`${count}: ${text}`] : [];
  });
}

async function interruptedWikiOperationIssues(workspaceDir: string): Promise<WikiHealthIssue[]> {
  const events = await readWikiOperationEvents(workspaceDir);
  const groups = new Map<string, {
    begin?: Extract<(typeof events)[number], { phase: "begin" }>;
    complete?: Extract<(typeof events)[number], { phase: "complete" }>;
  }>();

  for (const event of events) {
    const group = groups.get(event.operationId) ?? {};
    if (event.phase === "begin") {
      group.begin = event;
    } else if (event.phase === "complete") {
      group.complete = event;
    }
    groups.set(event.operationId, group);
  }

  const issues: WikiHealthIssue[] = [];
  for (const [operationId, group] of groups) {
    if (!group.begin || group.complete) {
      continue;
    }
    issues.push({
      kind: "wiki_operation_interrupted",
      severity: "medium",
      paperKey: operationId,
      operationId,
      path: "knowledge-base/state/wiki-operations.jsonl",
      paths: ["knowledge-base/state/wiki-operations.jsonl", ...group.begin.plannedFiles],
      reason: `Wiki operation ${operationId} (${group.begin.intent}) began at ${group.begin.startedAt} but has no complete event.`
    });
  }
  return issues;
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
  const jobEvents = await readPaperDownloadJobEvents({ workspaceDir });
  const issues: WikiHealthIssue[] = [];

  for (const entry of localPapers.results) {
    const entryIssues: WikiHealthIssue[] = [];
    const blocked = await findBlockedEntry(workspaceDir, entry);
    const record = await readRecord(workspaceDir, entry);
    const citationIssue = await citationIssueForEntry(workspaceDir, entry);
    const pdfExists = await pathExists(toWorkspacePath(workspaceDir, entry.pdfPath));
    const usesPreprintFallback = recordUsesPreprintFallback(record);
    const isPublisherPending = recordIsPublisherPending(record);
    const hasAcceptableParse = entry.parses.some((parse) => parseIsAcceptable(parse, threshold));
    const hasUsableParsedReading = entry.hasParsedArtifacts && hasAcceptableParse;
    const recordAccessReason = recordAuthorizationReason(record);
    const authorizationReason =
      (recordAccessReason && !hasUsableParsedReading ? recordAccessReason : undefined) ??
      (!pdfExists ? jobAuthorizationReason(findAccessProblemJobForEntry(entry, jobEvents)) : undefined);
    const needsAuthorization = Boolean(authorizationReason);
    const authorizationSeverity: WikiHealthSeverity = hasUsableParsedReading ? "medium" : "high";

    if (!usesPreprintFallback && !isPublisherPending && !needsAuthorization && !hasUsableParsedReading && (entry.status !== "downloaded" || (entry.status === "downloaded" && !pdfExists))) {
      entryIssues.push(baseIssue(
        entry,
        "needs_download",
        "high",
        entry.status === "downloaded"
          ? "Record is downloaded, but the referenced PDF is missing."
          : `Record status is ${entry.status ?? "unknown"}, not downloaded.`
      ));
    }

    if (
      !usesPreprintFallback &&
      !isPublisherPending &&
      !needsAuthorization &&
      entryIsSupportedPublisher(entry) &&
      entryHasOnlyWebpageReading(entry) &&
      !pdfExists
    ) {
      entryIssues.push(baseIssue(
        entry,
        "needs_download",
        "medium",
        "Publisher webpage parsing artifacts exist, but no local PDF file has been downloaded. Webpage parsing is not a successful PDF download."
      ));
    }

    if (needsAuthorization) {
      entryIssues.push(baseIssue(
        entry,
        "needs_authorization",
        authorizationSeverity,
        authorizationReason ?? "Record indicates login, authorization, or access-wall handling is needed."
      ));
    }

    if (recordIsQueued(record)) {
      entryIssues.push(baseIssue(entry, "queued", "medium", "Record has queued download, webpage, parse, or reading work."));
    }

    if (entry.status === "downloaded" && pdfExists && !entry.hasParsedArtifacts && record?.reading?.status !== "queued") {
      entryIssues.push(baseIssue(entry, "parse_missing", "medium", "Downloaded paper has no parsed reading artifacts."));
    }

    if (recordParseFailed(record)) {
      entryIssues.push(baseIssue(entry, "parse_failed", "high", record?.reading?.reason ?? "Record has failed parse, webpage, or reading status."));
    }

    if (!usesPreprintFallback && !isPublisherPending && !needsAuthorization) {
      for (const parse of entry.parses.filter((candidate) => !hasAcceptableParse && parseIsLowQuality(candidate, threshold))) {
        entryIssues.push({
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

    if (!usesPreprintFallback && !isPublisherPending && hasUsableParsedReading && !entry.hasWikiSummary) {
      entryIssues.push(baseIssue(entry, "summary_missing", "low", "Parsed paper has no wiki source summary."));
    }

    if (entry.hasWikiSummary && !(await pathExists(getPaperWikiSourceManifestPath(workspaceDir, entry.paperKey)))) {
      entryIssues.push({
        ...baseIssue(entry, "source_manifest_missing", "low", "Wiki source summary has no durable source manifest."),
        paths: [relativeToWorkspace(workspaceDir, getPaperWikiSourceManifestPath(workspaceDir, entry.paperKey))]
      });
    }

    if (!usesPreprintFallback && !isPublisherPending && !needsAuthorization) {
      const missingPaths = await missingArtifactPaths(workspaceDir, entry);
      if (missingPaths.length > 0) {
        entryIssues.push({
          ...baseIssue(entry, "missing_artifact", "high", "One or more indexed artifacts are missing on disk."),
          paths: missingPaths
        });
      }
    }

    if (citationIssue) {
      entryIssues.push(citationIssue);
    }

    const blockedDownloadIssues = entryIssues.filter((issue) => DOWNLOAD_BLOCKABLE_ISSUE_KINDS.has(issue.kind));
    const remainingIssues = entryIssues.filter((issue) => !DOWNLOAD_BLOCKABLE_ISSUE_KINDS.has(issue.kind));
    if (blocked && blockedDownloadIssues.length > 0) {
      issues.push(downloadBlockedIssue(entry, blocked), ...remainingIssues);
    } else {
      issues.push(...entryIssues);
    }
  }

  const typedPages = await listTypedWikiPages({
    workspaceDir,
    includeSources: false,
    includePages: true
  });
  for (const diagnostic of typedPages.diagnostics) {
    if (!(await diagnosticOptsIntoTypedSchema(diagnostic))) {
      continue;
    }
    issues.push(typedDiagnosticIssue(workspaceDir, diagnostic));
  }
  for (const page of typedPages.pages) {
    if (page.metadata.evidence_contract === "paper-backed" && page.metadata.source_refs.length === 0) {
      const relativePath = relativeToWorkspace(workspaceDir, page.path);
      issues.push({
        kind: "wiki_page_evidence_weak",
        severity: "medium",
        paperKey: relativePath,
        path: relativePath,
        reason: "Paper-backed wiki page has no source_refs."
      });
    }
  }

  issues.push(...await interruptedWikiOperationIssues(workspaceDir));

  const summary = Object.fromEntries(ISSUE_KINDS.map((kind) => [kind, 0])) as Record<string, number>;
  for (const issue of issues) {
    summary[issue.kind] = (summary[issue.kind] ?? 0) + 1;
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
  paperDownloadWorker: PaperDownloadWorker;
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
    const result = await input.paperDownloadWorker.downloadPaper({
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

async function fixByCitationMetadata(input: {
  workspaceDir: string;
  issue: WikiHealthIssue;
  paperDownloadWorker: PaperDownloadWorker;
  dryRun: boolean;
}): Promise<WikiHealthFixItem> {
  if (input.dryRun) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "metadata_refresh",
      message: `Dry run: would refresh source citation metadata for ${input.issue.paperKey} through the paper-download-subagent.`
    };
  }

  try {
    const result = await input.paperDownloadWorker.refreshSourceMetadata({
      workspaceDir: input.workspaceDir,
      paperKey: input.issue.paperKey,
      ...(input.issue.recordPath ? { recordPath: input.issue.recordPath } : {}),
      ...(input.issue.metadata?.sourcePath ? { sourcePath: input.issue.metadata.sourcePath } : {}),
      ...(input.issue.articleUrl ? { articleUrl: input.issue.articleUrl } : {}),
      ...(input.issue.title ? { title: input.issue.title } : {})
    });
    const isComplete = result.citationStatus === "complete" || (result.missingFields?.length ?? 0) === 0;
    return {
      issue: input.issue,
      status: result.status === "refreshed" && isComplete ? "fixed" : "skipped",
      action: "metadata_refresh",
      message: result.message,
      details: {
        status: result.status,
        ...(result.sourcePath ? { sourcePath: result.sourcePath } : {}),
        ...(result.citationStatus ? { citationStatus: result.citationStatus } : {}),
        ...(result.missingFields ? { missingFields: result.missingFields } : {})
      }
    };
  } catch (error) {
    return {
      issue: input.issue,
      status: "failed",
      action: "metadata_refresh",
      message: error instanceof Error ? error.message : "Source citation metadata refresh failed."
    };
  }
}

async function fixByAuthorization(input: {
  workspaceDir: string;
  issue: WikiHealthIssue;
  paperDownloadWorker?: PaperDownloadWorker;
  dryRun: boolean;
}): Promise<WikiHealthFixItem> {
  if (!input.issue.articleUrl) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "authorize",
      message: "Cannot open publisher login because the issue has no articleUrl."
    };
  }
  if (input.dryRun) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "authorize",
      message: `Dry run: would open publisher login/download page for ${input.issue.articleUrl}.`
    };
  }
  if (!input.paperDownloadWorker) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "authorize",
      message: "Cannot open publisher login automatically because no browser extension download opener is configured."
    };
  }

  try {
    const result = await input.paperDownloadWorker.downloadPaper({
      workspaceDir: input.workspaceDir,
      url: input.issue.articleUrl,
      ...(input.issue.title ? { title: input.issue.title } : {})
    });
    if (result.status === "downloaded" || result.status === "already_downloaded") {
      return {
        issue: input.issue,
        status: "fixed",
        action: "authorize",
        message: `Download is available for ${input.issue.paperKey}.`,
        details: result
      };
    }
    if (result.status === "extension_job_queued") {
      return {
        issue: input.issue,
        status: "queued",
        action: "authorize",
        message: "Browser extension job was queued/opened for publisher login or verification; complete it in the browser, then rerun wiki_health_fix.",
        details: result
      };
    }
    return {
      issue: input.issue,
      status: "skipped",
      action: "authorize",
      message: `Publisher login/open attempt did not queue; resulting status is ${result.status}.`,
      details: result
    };
  } catch (error) {
    return {
      issue: input.issue,
      status: "failed",
      action: "authorize",
      message: error instanceof Error ? error.message : "Publisher login/open attempt failed."
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

async function fixBySourceManifestBackfill(input: {
  workspaceDir: string;
  issue: WikiHealthIssue;
  dryRun: boolean;
}): Promise<WikiHealthFixItem> {
  if (input.dryRun) {
    return {
      issue: input.issue,
      status: "skipped",
      action: "source_manifest_backfill",
      message: `Dry run: would backfill source manifest for ${input.issue.paperKey}.`
    };
  }
  try {
    const manifestPath = await backfillWikiSourceManifestFromSummary({
      workspaceDir: input.workspaceDir,
      paperKey: input.issue.paperKey
    });
    return {
      issue: input.issue,
      status: "fixed",
      action: "source_manifest_backfill",
      message: `Backfilled source manifest for ${input.issue.paperKey}.`,
      details: { manifestPath }
    };
  } catch (error) {
    return {
      issue: input.issue,
      status: "failed",
      action: "source_manifest_backfill",
      message: error instanceof Error ? error.message : "Source manifest backfill failed."
    };
  }
}

async function readSourceMetadata(sourcePath: string): Promise<Partial<PaperSourceMetadata> | undefined> {
  try {
    return JSON.parse(await readFile(sourcePath, "utf8")) as Partial<PaperSourceMetadata>;
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveMetadataRefreshPaths(options: PaperDownloadWorkerMetadataRefreshOptions): Promise<{
  recordPath?: string;
  sourcePath?: string;
  recordExists: boolean;
}> {
  const recordPath = options.recordPath
    ? toWorkspacePath(options.workspaceDir, options.recordPath) ?? options.recordPath
    : undefined;
  const sourcePath = options.sourcePath
    ? toWorkspacePath(options.workspaceDir, options.sourcePath) ?? options.sourcePath
    : undefined;
  return {
    ...(recordPath ? { recordPath } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    recordExists: recordPath ? await fileExists(recordPath) : false
  };
}

async function refreshSourceCitationMetadata(input: {
  workspaceDir: string;
  recordPath?: string;
  sourcePath?: string;
  recordExists: boolean;
}): Promise<string> {
  const recordSiblingSourcePath = input.recordPath
    ? path.join(path.dirname(input.recordPath), "source.json")
    : undefined;
  if (
    input.sourcePath &&
    (!input.recordPath ||
      !input.recordExists ||
      path.resolve(input.sourcePath) !== path.resolve(recordSiblingSourcePath ?? ""))
  ) {
    return writePaperSourceMetadataForSource({
      workspaceDir: input.workspaceDir,
      sourcePath: input.sourcePath,
      enrichCitationMetadata: true
    });
  }

  if (input.recordPath && input.recordExists) {
    const record = JSON.parse(await readFile(input.recordPath, "utf8")) as PaperRecord;
    return writePaperSourceMetadataForRecord({
      workspaceDir: input.workspaceDir,
      record,
      recordPath: input.recordPath,
      enrichCitationMetadata: true
    });
  }

  if (input.sourcePath || recordSiblingSourcePath) {
    return writePaperSourceMetadataForSource({
      workspaceDir: input.workspaceDir,
      sourcePath: input.sourcePath ?? recordSiblingSourcePath!,
      enrichCitationMetadata: true
    });
  }

  throw new Error("Cannot refresh source citation metadata because no source metadata path could be resolved.");
}

function createDefaultPaperDownloadWorker(input: {
  downloadPaperImpl: NonNullable<WikiHealthFixOptions["downloadPaperImpl"]>;
}): PaperDownloadWorker {
  return {
    downloadPaper: input.downloadPaperImpl,
    refreshSourceMetadata: async (options) => {
      const paths = await resolveMetadataRefreshPaths(options);
      if (!paths.recordPath && !paths.sourcePath) {
        return {
          status: "skipped",
          message: "Cannot refresh source citation metadata because the issue has no acquisition recordPath or sourcePath."
        };
      }
      const refreshedSourcePath = await refreshSourceCitationMetadata({
        workspaceDir: options.workspaceDir,
        ...paths
      });
      const source = await readSourceMetadata(refreshedSourcePath);
      const missingFields = Array.isArray(source?.missingFields)
        ? source.missingFields.filter((field): field is string => typeof field === "string" && field.trim().length > 0)
        : [];
      const citationStatus = source?.citationStatus;
      return {
        status: "refreshed",
        sourcePath: refreshedSourcePath,
        ...(citationStatus ? { citationStatus } : {}),
        missingFields,
        message: missingFields.length === 0
          ? `Source citation metadata was refreshed from ${source?.resolvedFrom ?? "available metadata"}.`
          : `Source citation metadata was refreshed from available metadata, but still misses: ${missingFields.join(", ")}.`
      };
    }
  };
}

export async function fixWikiHealth(options: WikiHealthFixOptions): Promise<WikiHealthFixResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const maxItems = Math.max(1, Math.trunc(options.maxItems ?? DEFAULT_MAX_ITEMS));
  const threshold = options.lowQualityScoreThreshold ?? DEFAULT_LOW_QUALITY_SCORE_THRESHOLD;
  const paperDownloadWorker =
    options.paperDownloadWorker ??
    createDefaultPaperDownloadWorker({ downloadPaperImpl: options.downloadPaperImpl ?? downloadPaper });
  await options.onProgress?.({
    stage: "checking_health",
    message: "Checking wiki health before repair."
  });
  const checked = await checkWikiHealth({
    ...options,
    maxItems: Number.MAX_SAFE_INTEGER
  });
  const selectedKinds = options.issueKinds ? new Set(options.issueKinds) : undefined;
  const selectedIssues = checked.issues.filter((issue) => isIssueKindSelected(issue, selectedKinds));
  const issues = selectedIssues.slice(0, maxItems);
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
        paperDownloadWorker,
        dryRun: options.dryRun === true,
        blockedByAuthorization: authorizationBlocked.has(identity)
      }));
      continue;
    }

    if (issue.kind === "citation_incomplete") {
      results.push(await fixByCitationMetadata({
        workspaceDir,
        issue,
        paperDownloadWorker,
        dryRun: options.dryRun === true
      }));
      continue;
    }

    if (issue.kind === "needs_authorization") {
      results.push(await fixByAuthorization({
        workspaceDir,
        issue,
        paperDownloadWorker,
        dryRun: options.dryRun === true
      }));
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
    if (issue.kind === "source_manifest_missing") {
      results.push(await fixBySourceManifestBackfill({
        workspaceDir,
        issue,
        dryRun: options.dryRun === true
      }));
      continue;
    }
    if (issue.kind === "missing_artifact") {
      results.push(skippedFix(issue, "Missing artifacts require regenerating the owning download, parse, or summary artifact; rerun targeted repair after inspecting the missing paths."));
      continue;
    }
    if (issue.kind === "download_blocked") {
      results.push(skippedFix(issue, "Paper is on the local download blocklist; remove it from the blocklist before running automatic repair."));
      continue;
    }
    if (issue.kind === "wiki_page_malformed" || issue.kind === "wiki_page_evidence_weak") {
      results.push(skippedFix(issue, "Typed wiki page issues must be fixed by editing the page metadata."));
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
