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
  canonical_page?: string;
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
    | "missing_canonical_page";
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
  const canonicalPage = cleanString(metadata.canonical_page);

  for (const field of ARRAY_METADATA_FIELDS) {
    if (hasOwnField(metadata, field) && !Array.isArray(metadata[field])) {
      errors.push(schemaError("invalid_frontmatter", `Wiki page ${field} must be an array.`, path));
    }
  }

  if (!isWikiEvidenceContract(metadata.evidence_contract)) {
    errors.push(schemaError("invalid_frontmatter", "Wiki evidence contract is missing or invalid.", path));
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
      ...(canonicalPage ? { canonical_page: canonicalPage } : {}),
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
    ...(metadata.canonical_page ? [`canonical_page: ${quoteYamlString(metadata.canonical_page)}`] : []),
    `created_at: ${quoteYamlString(metadata.created_at)}`,
    `updated_at: ${quoteYamlString(metadata.updated_at)}`,
    "---",
    "",
    page.body.trimEnd()
  ];

  return `${lines.join("\n")}\n`;
}
