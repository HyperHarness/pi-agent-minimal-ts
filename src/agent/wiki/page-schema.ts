import { validateWikiDomainBinding } from "./domain-bindings.js";

export type WikiPageType =
  | "paper-source"
  | "synthesis"
  | "concept"
  | "method"
  | "finding"
  | "dataset"
  | "question"
  | "design-record"
  | "alias";

export type WikiEvidenceContract =
  | "paper-backed"
  | "design-backed"
  | "code-backed"
  | "mixed"
  | "none";

export type WikiClaimKind = "quantitative" | "qualitative" | "assumption" | "limitation";
export type WikiClaimConfidence = "high" | "medium" | "low";
export type WikiRelationType =
  | "supports"
  | "contradicts"
  | "extends"
  | "uses"
  | "baseline_of"
  | "open_problem_for"
  | "implementation_of";
export type WikiRelationTargetKind = "page" | "source" | "experiment" | "code";
export type WikiRelationStatus = "confirmed" | "candidate" | "rejected";
export type WikiExperimentStatus = "planned" | "ran" | "failed" | "blocked";
export type WikiReviewerCritiqueSeverity = "high" | "medium" | "low";

export interface WikiClaimEvidence {
  paperKey?: string;
  sourcePath?: string;
  parsePath?: string;
  chunkId?: string;
  elementId?: string;
  sectionId?: string;
  page?: number;
  figure?: string;
  table?: string;
  codeOutputPath?: string;
  quote?: string;
  note?: string;
}

export interface WikiClaimProvenance {
  claimId: string;
  kind: WikiClaimKind;
  statement: string;
  sourceRefs: string[];
  evidence: WikiClaimEvidence[];
  confidence: WikiClaimConfidence;
}

export interface WikiTypedRelation {
  type: WikiRelationType;
  target: string;
  targetKind: WikiRelationTargetKind;
  evidenceRefs: string[];
  status: WikiRelationStatus;
  note?: string;
}

export interface WikiExperimentRef {
  experimentId: string;
  title: string;
  scriptPath?: string;
  command?: string;
  resultPath?: string;
  logPath?: string;
  artifactPaths?: string[];
  status: WikiExperimentStatus;
  createdAt?: string;
  updatedAt?: string;
  note?: string;
}

export interface WikiReviewerCritiqueItem {
  id: string;
  severity: WikiReviewerCritiqueSeverity;
  target?: string;
  reason: string;
  suggestedFix: string;
}

export interface WikiPageMetadata {
  schema_version: 1;
  type: WikiPageType;
  key: string;
  title: string;
  aliases: string[];
  tags: string[];
  evidence_contract: WikiEvidenceContract;
  source_refs: string[];
  related_pages?: string[];
  related_papers?: string[];
  claims?: WikiClaimProvenance[];
  typed_relations?: WikiTypedRelation[];
  experiment_refs?: WikiExperimentRef[];
  reviewer_critique?: WikiReviewerCritiqueItem[];
  canonical_page?: string;
  execution_binding?: string;
  created_at: string;
  updated_at: string;
}

export interface WikiTypedPage {
  path: string;
  metadata: WikiPageMetadata;
  body: string;
}

export interface WikiPageSchemaError {
  code:
    | "missing_frontmatter"
    | "invalid_frontmatter"
    | "invalid_type"
    | "missing_key"
    | "missing_title"
    | "invalid_created_at"
    | "invalid_updated_at"
    | "missing_source_refs"
    | "missing_canonical_page"
    | "unknown_execution_binding"
    | "invalid_claim_provenance"
    | "invalid_typed_relation"
    | "invalid_experiment_ref"
    | "invalid_reviewer_critique";
  message: string;
  path?: string;
}

export interface WikiPageMetadataValidationResult {
  ok: boolean;
  errors: WikiPageSchemaError[];
  metadata?: WikiPageMetadata;
}

export interface WikiPageParseResult {
  ok: boolean;
  errors: WikiPageSchemaError[];
  page?: WikiTypedPage;
}

const WIKI_PAGE_TYPES: readonly WikiPageType[] = [
  "paper-source",
  "synthesis",
  "concept",
  "method",
  "finding",
  "dataset",
  "question",
  "design-record",
  "alias"
];

const WIKI_EVIDENCE_CONTRACTS: readonly WikiEvidenceContract[] = [
  "paper-backed",
  "design-backed",
  "code-backed",
  "mixed",
  "none"
];

const WIKI_CLAIM_KINDS: readonly WikiClaimKind[] = [
  "quantitative",
  "qualitative",
  "assumption",
  "limitation"
];

const WIKI_CLAIM_CONFIDENCES: readonly WikiClaimConfidence[] = [
  "high",
  "medium",
  "low"
];

const WIKI_RELATION_TYPES: readonly WikiRelationType[] = [
  "supports",
  "contradicts",
  "extends",
  "uses",
  "baseline_of",
  "open_problem_for",
  "implementation_of"
];

const WIKI_RELATION_TARGET_KINDS: readonly WikiRelationTargetKind[] = [
  "page",
  "source",
  "experiment",
  "code"
];

const WIKI_RELATION_STATUSES: readonly WikiRelationStatus[] = [
  "confirmed",
  "candidate",
  "rejected"
];

const WIKI_EXPERIMENT_STATUSES: readonly WikiExperimentStatus[] = [
  "planned",
  "ran",
  "failed",
  "blocked"
];

const WIKI_REVIEWER_CRITIQUE_SEVERITIES: readonly WikiReviewerCritiqueSeverity[] = [
  "high",
  "medium",
  "low"
];

const SOURCE_REQUIRED_CONTRACTS = new Set<WikiEvidenceContract>([
  "paper-backed",
  "design-backed",
  "code-backed",
  "mixed"
]);

const ARRAY_METADATA_FIELDS = [
  "aliases",
  "tags",
  "source_refs",
  "related_pages",
  "related_papers"
] as const;

type RawWikiPageMetadata = Record<string, unknown>;

function isWikiPageType(value: unknown): value is WikiPageType {
  return typeof value === "string" && WIKI_PAGE_TYPES.includes(value as WikiPageType);
}

function isWikiEvidenceContract(value: unknown): value is WikiEvidenceContract {
  return typeof value === "string" && WIKI_EVIDENCE_CONTRACTS.includes(value as WikiEvidenceContract);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function schemaError(code: WikiPageSchemaError["code"], message: string, path?: string): WikiPageSchemaError {
  return path ? { code, message, path } : { code, message };
}

function hasOwnField(metadata: RawWikiPageMetadata, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(metadata, field);
}

function parseScalarValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === "1") {
    return 1;
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseStringArrayItem(rawValue: string): string {
  const parsed = parseScalarValue(rawValue);
  return typeof parsed === "string" ? parsed.trim() : String(parsed).trim();
}

function parseFrontmatter(frontmatter: string, path?: string): {
  metadata: RawWikiPageMetadata;
  errors: WikiPageSchemaError[];
} {
  const metadata: RawWikiPageMetadata = {};
  const errors: WikiPageSchemaError[] = [];
  const lines = frontmatter.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    const fieldMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (!fieldMatch) {
      errors.push(schemaError("invalid_frontmatter", `Invalid frontmatter line: ${line}`, path));
      continue;
    }

    const key = fieldMatch[1];
    const rawValue = (fieldMatch[2] ?? "").trim();
    if (rawValue === "[]") {
      metadata[key] = [];
      continue;
    }
    if (rawValue !== "") {
      metadata[key] = parseScalarValue(rawValue);
      continue;
    }

    const values: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const itemMatch = lines[cursor].match(/^\s+-\s+(.*)$/);
      if (!itemMatch) {
        break;
      }
      values.push(parseStringArrayItem(itemMatch[1]));
      cursor += 1;
    }

    metadata[key] = values;
    index = cursor - 1;
  }

  return { metadata, errors };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => cleanString(item))
    .filter(Boolean);
}

function cleanOptionalStringArray(value: unknown): string[] | undefined {
  const cleaned = cleanStringArray(value);
  return cleaned.length > 0 ? cleaned : undefined;
}

function isValidIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

function isWorkspaceRelativePath(value: string): boolean {
  if (!value.trim() || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }
  return !value.split(/[\\/]+/).includes("..");
}

function cleanOptionalString(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  return cleaned || undefined;
}

function cleanClaimEvidence(value: unknown): WikiClaimEvidence | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const page = typeof value.page === "number" && Number.isFinite(value.page) ? value.page : undefined;
  return {
    ...(cleanOptionalString(value.paperKey) ? { paperKey: cleanOptionalString(value.paperKey) } : {}),
    ...(cleanOptionalString(value.sourcePath) ? { sourcePath: cleanOptionalString(value.sourcePath) } : {}),
    ...(cleanOptionalString(value.parsePath) ? { parsePath: cleanOptionalString(value.parsePath) } : {}),
    ...(cleanOptionalString(value.chunkId) ? { chunkId: cleanOptionalString(value.chunkId) } : {}),
    ...(cleanOptionalString(value.elementId) ? { elementId: cleanOptionalString(value.elementId) } : {}),
    ...(cleanOptionalString(value.sectionId) ? { sectionId: cleanOptionalString(value.sectionId) } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(cleanOptionalString(value.figure) ? { figure: cleanOptionalString(value.figure) } : {}),
    ...(cleanOptionalString(value.table) ? { table: cleanOptionalString(value.table) } : {}),
    ...(cleanOptionalString(value.codeOutputPath) ? { codeOutputPath: cleanOptionalString(value.codeOutputPath) } : {}),
    ...(cleanOptionalString(value.quote) ? { quote: cleanOptionalString(value.quote) } : {}),
    ...(cleanOptionalString(value.note) ? { note: cleanOptionalString(value.note) } : {})
  };
}

function hasConcreteClaimEvidence(evidence: WikiClaimEvidence): boolean {
  return evidence.page !== undefined ||
    Boolean(evidence.figure) ||
    Boolean(evidence.table) ||
    Boolean(evidence.elementId) ||
    Boolean(evidence.chunkId) ||
    Boolean(evidence.codeOutputPath);
}

function cleanClaims(value: unknown): {
  values?: WikiClaimProvenance[];
  invalid: boolean;
} {
  if (value === undefined) {
    return { invalid: false };
  }
  if (!Array.isArray(value)) {
    return { invalid: true };
  }
  const values: WikiClaimProvenance[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return { invalid: true };
    }
    const claimId = cleanString(item.claimId);
    const kind = cleanString(item.kind) as WikiClaimKind;
    const statement = cleanString(item.statement);
    const sourceRefs = cleanStringArray(item.sourceRefs);
    const evidence = Array.isArray(item.evidence)
      ? item.evidence.map((entry) => cleanClaimEvidence(entry))
      : [];
    const confidence = cleanString(item.confidence) as WikiClaimConfidence;
    if (
      !claimId ||
      !WIKI_CLAIM_KINDS.includes(kind) ||
      !statement ||
      sourceRefs.length === 0 ||
      evidence.some((entry) => !entry) ||
      evidence.length === 0 ||
      !WIKI_CLAIM_CONFIDENCES.includes(confidence)
    ) {
      return { invalid: true };
    }
    const cleanedEvidence = evidence.filter((entry): entry is WikiClaimEvidence => Boolean(entry));
    if (kind === "quantitative" && !cleanedEvidence.some((entry) => hasConcreteClaimEvidence(entry))) {
      return { invalid: true };
    }
    values.push({
      claimId,
      kind,
      statement,
      sourceRefs,
      evidence: cleanedEvidence,
      confidence
    });
  }
  return values.length > 0 ? { values, invalid: false } : { invalid: false };
}

function cleanTypedRelations(value: unknown): {
  values?: WikiTypedRelation[];
  invalid: boolean;
} {
  if (value === undefined) {
    return { invalid: false };
  }
  if (!Array.isArray(value)) {
    return { invalid: true };
  }
  const values: WikiTypedRelation[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return { invalid: true };
    }
    const type = cleanString(item.type) as WikiRelationType;
    const target = cleanString(item.target);
    const targetKind = cleanString(item.targetKind) as WikiRelationTargetKind;
    const evidenceRefs = cleanStringArray(item.evidenceRefs);
    const status = cleanString(item.status) as WikiRelationStatus;
    if (
      !WIKI_RELATION_TYPES.includes(type) ||
      !target ||
      !WIKI_RELATION_TARGET_KINDS.includes(targetKind) ||
      !isStringArray(item.evidenceRefs) ||
      !WIKI_RELATION_STATUSES.includes(status)
    ) {
      return { invalid: true };
    }
    values.push({
      type,
      target,
      targetKind,
      evidenceRefs,
      status,
      ...(cleanOptionalString(item.note) ? { note: cleanOptionalString(item.note) } : {})
    });
  }
  return values.length > 0 ? { values, invalid: false } : { invalid: false };
}

function cleanExperimentRefs(value: unknown): {
  values?: WikiExperimentRef[];
  invalid: boolean;
} {
  if (value === undefined) {
    return { invalid: false };
  }
  if (!Array.isArray(value)) {
    return { invalid: true };
  }
  const values: WikiExperimentRef[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return { invalid: true };
    }
    const experimentId = cleanString(item.experimentId);
    const title = cleanString(item.title);
    const status = cleanString(item.status) as WikiExperimentStatus;
    const artifactPaths = cleanStringArray(item.artifactPaths);
    const paths = [
      cleanOptionalString(item.scriptPath),
      cleanOptionalString(item.resultPath),
      cleanOptionalString(item.logPath),
      ...artifactPaths
    ].filter((candidate): candidate is string => Boolean(candidate));
    if (
      !experimentId ||
      !title ||
      !WIKI_EXPERIMENT_STATUSES.includes(status) ||
      (item.artifactPaths !== undefined && !isStringArray(item.artifactPaths)) ||
      paths.some((candidate) => !isWorkspaceRelativePath(candidate))
    ) {
      return { invalid: true };
    }
    values.push({
      experimentId,
      title,
      ...(cleanOptionalString(item.scriptPath) ? { scriptPath: cleanOptionalString(item.scriptPath) } : {}),
      ...(cleanOptionalString(item.command) ? { command: cleanOptionalString(item.command) } : {}),
      ...(cleanOptionalString(item.resultPath) ? { resultPath: cleanOptionalString(item.resultPath) } : {}),
      ...(cleanOptionalString(item.logPath) ? { logPath: cleanOptionalString(item.logPath) } : {}),
      ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
      status,
      ...(cleanOptionalString(item.createdAt) ? { createdAt: cleanOptionalString(item.createdAt) } : {}),
      ...(cleanOptionalString(item.updatedAt) ? { updatedAt: cleanOptionalString(item.updatedAt) } : {}),
      ...(cleanOptionalString(item.note) ? { note: cleanOptionalString(item.note) } : {})
    });
  }
  return values.length > 0 ? { values, invalid: false } : { invalid: false };
}

function cleanReviewerCritique(value: unknown): {
  values?: WikiReviewerCritiqueItem[];
  invalid: boolean;
} {
  if (value === undefined) {
    return { invalid: false };
  }
  if (!Array.isArray(value)) {
    return { invalid: true };
  }
  const values: WikiReviewerCritiqueItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return { invalid: true };
    }
    const id = cleanString(item.id);
    const severity = cleanString(item.severity) as WikiReviewerCritiqueSeverity;
    const reason = cleanString(item.reason);
    const suggestedFix = cleanString(item.suggestedFix);
    if (!id || !WIKI_REVIEWER_CRITIQUE_SEVERITIES.includes(severity) || !reason || !suggestedFix) {
      return { invalid: true };
    }
    values.push({
      id,
      severity,
      ...(cleanOptionalString(item.target) ? { target: cleanOptionalString(item.target) } : {}),
      reason,
      suggestedFix
    });
  }
  return values.length > 0 ? { values, invalid: false } : { invalid: false };
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function serializeStringArray(key: string, values: string[]): string[] {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return [`${key}: []`];
  }
  return [
    `${key}:`,
    ...cleaned.map((value) => `  - ${quoteYamlString(value)}`)
  ];
}

export function validateWikiPageMetadata(
  metadata: Partial<WikiPageMetadata> & RawWikiPageMetadata,
  path?: string
): WikiPageMetadataValidationResult {
  const errors: WikiPageSchemaError[] = [];

  if (hasOwnField(metadata, "schema_version") && metadata.schema_version !== 1) {
    errors.push(schemaError("invalid_frontmatter", "Wiki page schema_version must be 1 when present.", path));
  }

  if (!isWikiPageType(metadata.type)) {
    errors.push(schemaError("invalid_type", "Wiki page type is missing or invalid.", path));
  }

  const key = cleanString(metadata.key);
  if (!key) {
    errors.push(schemaError("missing_key", "Wiki page key is required.", path));
  }

  const title = cleanString(metadata.title);
  if (!title) {
    errors.push(schemaError("missing_title", "Wiki page title is required.", path));
  }

  const aliases = cleanStringArray(metadata.aliases);
  const tags = cleanStringArray(metadata.tags);
  const sourceRefs = cleanStringArray(metadata.source_refs);
  const relatedPages = cleanOptionalStringArray(metadata.related_pages);
  const relatedPapers = cleanOptionalStringArray(metadata.related_papers);
  const claims = cleanClaims(metadata.claims);
  const typedRelations = cleanTypedRelations(metadata.typed_relations);
  const experimentRefs = cleanExperimentRefs(metadata.experiment_refs);
  const reviewerCritique = cleanReviewerCritique(metadata.reviewer_critique);
  const canonicalPage = cleanString(metadata.canonical_page);
  const executionBinding = cleanString(metadata.execution_binding);

  for (const field of ARRAY_METADATA_FIELDS) {
    if (hasOwnField(metadata, field) && !Array.isArray(metadata[field])) {
      errors.push(schemaError("invalid_frontmatter", `Wiki page ${field} must be an array.`, path));
    }
  }

  if (!isWikiEvidenceContract(metadata.evidence_contract)) {
    errors.push(schemaError("invalid_frontmatter", "Wiki evidence contract is missing or invalid.", path));
  }

  if (claims.invalid) {
    errors.push(schemaError("invalid_claim_provenance", "Wiki claims must include valid provenance; quantitative claims require concrete page, figure, table, element, chunk, or code-output evidence.", path));
  }

  if (typedRelations.invalid) {
    errors.push(schemaError("invalid_typed_relation", "Wiki typed_relations must be valid relation records.", path));
  }

  if (experimentRefs.invalid) {
    errors.push(schemaError("invalid_experiment_ref", "Wiki experiment_refs must be valid records with workspace-relative paths.", path));
  }

  if (reviewerCritique.invalid) {
    errors.push(schemaError("invalid_reviewer_critique", "Wiki reviewer_critique must be valid critique records.", path));
  }

  if (!isValidIsoDate(metadata.created_at)) {
    errors.push(schemaError("invalid_created_at", "Wiki page created_at must be a valid date string.", path));
  }

  if (!isValidIsoDate(metadata.updated_at)) {
    errors.push(schemaError("invalid_updated_at", "Wiki page updated_at must be a valid date string.", path));
  }

  if (
    isWikiEvidenceContract(metadata.evidence_contract) &&
    SOURCE_REQUIRED_CONTRACTS.has(metadata.evidence_contract) &&
    sourceRefs.length === 0
  ) {
    errors.push(schemaError("missing_source_refs", "Wiki page evidence contract requires at least one source_ref.", path));
  }

  if (metadata.type === "alias" && !canonicalPage) {
    errors.push(schemaError("missing_canonical_page", "Alias wiki pages require canonical_page.", path));
  }

  if (hasOwnField(metadata, "execution_binding")) {
    const bindingValidation = validateWikiDomainBinding(executionBinding);
    if (!bindingValidation.ok) {
      errors.push(schemaError(
        "unknown_execution_binding",
        `Wiki page execution_binding is not registered: ${executionBinding}`,
        path
      ));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    metadata: {
      schema_version: 1,
      type: metadata.type as WikiPageType,
      key,
      title,
      aliases,
      tags,
      evidence_contract: metadata.evidence_contract as WikiEvidenceContract,
      source_refs: sourceRefs,
      ...(relatedPages ? { related_pages: relatedPages } : {}),
      ...(relatedPapers ? { related_papers: relatedPapers } : {}),
      ...(claims.values ? { claims: claims.values } : {}),
      ...(typedRelations.values ? { typed_relations: typedRelations.values } : {}),
      ...(experimentRefs.values ? { experiment_refs: experimentRefs.values } : {}),
      ...(reviewerCritique.values ? { reviewer_critique: reviewerCritique.values } : {}),
      ...(canonicalPage ? { canonical_page: canonicalPage } : {}),
      ...(executionBinding ? { execution_binding: executionBinding } : {}),
      created_at: metadata.created_at as string,
      updated_at: metadata.updated_at as string
    }
  };
}

export function parseWikiPageMarkdown(markdown: string, path: string): WikiPageParseResult {
  const normalizedMarkdown = markdown.replace(/\r\n/g, "\n");
  const frontmatterMatch = normalizedMarkdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!frontmatterMatch) {
    return {
      ok: false,
      errors: [
        schemaError("missing_frontmatter", "Wiki page markdown must start with frontmatter.", path)
      ]
    };
  }

  const parsed = parseFrontmatter(frontmatterMatch[1], path);
  const metadata: Partial<WikiPageMetadata> & RawWikiPageMetadata = {
    ...parsed.metadata,
    ...(hasOwnField(parsed.metadata, "schema_version") ? {} : { schema_version: 1 as const })
  };
  const validation = validateWikiPageMetadata(metadata, path);
  const errors = [...parsed.errors, ...validation.errors];
  if (errors.length > 0 || !validation.metadata) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    page: {
      path,
      metadata: validation.metadata,
      body: normalizedMarkdown.slice(frontmatterMatch[0].length)
    }
  };
}

export function serializeWikiPageMarkdown(page: {
  metadata: Partial<WikiPageMetadata> & RawWikiPageMetadata;
  body: string;
}): string {
  const metadataInput: Partial<WikiPageMetadata> & RawWikiPageMetadata = {
    ...page.metadata,
    ...(hasOwnField(page.metadata, "schema_version") ? {} : { schema_version: 1 as const })
  };
  const validation = validateWikiPageMetadata(metadataInput);
  if (!validation.metadata) {
    const codes = validation.errors.map((error) => error.code).join(", ");
    throw new Error(`Cannot serialize invalid wiki page metadata: ${codes}`);
  }

  const metadata = validation.metadata;
  const lines = [
    "---",
    "schema_version: 1",
    `type: ${quoteYamlString(metadata.type)}`,
    `key: ${quoteYamlString(metadata.key)}`,
    `title: ${quoteYamlString(metadata.title)}`,
    ...serializeStringArray("aliases", metadata.aliases),
    ...serializeStringArray("tags", metadata.tags),
    `evidence_contract: ${quoteYamlString(metadata.evidence_contract)}`,
    ...serializeStringArray("source_refs", metadata.source_refs),
    ...(metadata.related_pages ? serializeStringArray("related_pages", metadata.related_pages) : []),
    ...(metadata.related_papers ? serializeStringArray("related_papers", metadata.related_papers) : []),
    ...(metadata.claims ? [`claims: ${JSON.stringify(metadata.claims)}`] : []),
    ...(metadata.typed_relations ? [`typed_relations: ${JSON.stringify(metadata.typed_relations)}`] : []),
    ...(metadata.experiment_refs ? [`experiment_refs: ${JSON.stringify(metadata.experiment_refs)}`] : []),
    ...(metadata.reviewer_critique ? [`reviewer_critique: ${JSON.stringify(metadata.reviewer_critique)}`] : []),
    ...(metadata.canonical_page ? [`canonical_page: ${quoteYamlString(metadata.canonical_page)}`] : []),
    ...(metadata.execution_binding ? [`execution_binding: ${quoteYamlString(metadata.execution_binding)}`] : []),
    `created_at: ${quoteYamlString(metadata.created_at)}`,
    `updated_at: ${quoteYamlString(metadata.updated_at)}`,
    "---",
    "",
    page.body.trimEnd()
  ];

  return `${lines.join("\n")}\n`;
}
