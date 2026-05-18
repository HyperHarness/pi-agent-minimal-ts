import { readFile } from "node:fs/promises";
import { readTypedWikiPage, type WikiPageDiagnostic } from "./typed-store.js";
import { getPaperWikiPagePath, relativeToWorkspace } from "./store.js";
import type {
  WikiClaimEvidence,
  WikiClaimProvenance,
  WikiTypedPage
} from "./page-schema.js";

export type WikiReviewFindingKind =
  | "unsupported_claim"
  | "weak_quantitative_provenance"
  | "low_confidence_claim"
  | "unresolved_contradiction"
  | "speculative_knowledge_state"
  | "disputed_knowledge_state"
  | "stale_evidence"
  | "unknown_freshness"
  | "missing_caveat"
  | "missing_experiment_ref"
  | "author_claim_not_validated";

export type WikiReviewFindingSeverity = "high" | "medium" | "low";

export interface WikiReviewFinding {
  kind: WikiReviewFindingKind;
  severity: WikiReviewFindingSeverity;
  message: string;
  target?: string;
}

export interface ReviewWikiPageEvidenceOptions {
  workspaceDir: string;
  pageKey: string;
  maxEvidenceAgeDays?: number;
  now?: Date;
}

export type ReviewWikiPageEvidenceResult =
  | {
    status: "ready";
    pageKey: string;
    relativePath: string;
    findings: WikiReviewFinding[];
    diagnostics: string[];
  }
  | {
    status: "missing" | "malformed";
    pageKey: string;
    findings: WikiReviewFinding[];
    diagnostics: string[];
  };

function diagnosticsToMessages(diagnostics: WikiPageDiagnostic[]): string[] {
  return diagnostics.flatMap((diagnostic) =>
    diagnostic.errors.map((error) => `${diagnostic.relativePath}: ${error.message}`)
  );
}

function pageReadStatus(diagnostics: WikiPageDiagnostic[]): "missing" | "malformed" {
  const isMissing = diagnostics.some((diagnostic) =>
    diagnostic.errors.some((error) => error.code === "missing_frontmatter")
  );
  return isMissing ? "missing" : "malformed";
}

function finding(
  kind: WikiReviewFindingKind,
  severity: WikiReviewFindingSeverity,
  message: string,
  target?: string
): WikiReviewFinding {
  return target ? { kind, severity, message, target } : { kind, severity, message };
}

function hasConcreteEvidence(evidence: WikiClaimEvidence): boolean {
  return evidence.page !== undefined ||
    Boolean(evidence.figure) ||
    Boolean(evidence.table) ||
    Boolean(evidence.elementId) ||
    Boolean(evidence.chunkId) ||
    Boolean(evidence.codeOutputPath);
}

function claimHasConcreteEvidence(claim: WikiClaimProvenance): boolean {
  return claim.evidence.some(hasConcreteEvidence);
}

function textLooksAuthorOnly(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(author|authors|paper|we)\b/.test(normalized) &&
    /\b(claim|claims|argue|argues|suggest|suggests|propose|proposes|assume|assumes|report|reports|reported)\b/.test(normalized);
}

function claimLooksAuthorOnly(claim: WikiClaimProvenance): boolean {
  if (textLooksAuthorOnly(claim.statement)) {
    return true;
  }
  return claim.evidence.some((evidence) =>
    textLooksAuthorOnly(evidence.quote ?? "") ||
    textLooksAuthorOnly(evidence.note ?? "")
  );
}

function hasCaveatSection(body: string): boolean {
  return /^#{1,6}\s+(?:caveats?|limitations?|scope|known uncertaint(?:y|ies)|contradictions|open checks)\b/im.test(body);
}

function hasClaimCaveat(claims: WikiClaimProvenance[]): boolean {
  return claims.some((claim) => claim.kind === "assumption" || claim.kind === "limitation");
}

function reviewKnowledgeState(page: WikiTypedPage, findings: WikiReviewFinding[]): void {
  if (page.metadata.knowledge_state === "speculative") {
    findings.push(finding(
      "speculative_knowledge_state",
      "medium",
      "Page knowledge state is marked speculative."
    ));
  }
  if (page.metadata.knowledge_state === "disputed") {
    findings.push(finding(
      "disputed_knowledge_state",
      "high",
      "Page knowledge state is marked disputed."
    ));
  }
}

function reviewFreshness(
  page: WikiTypedPage,
  findings: WikiReviewFinding[],
  options: ReviewWikiPageEvidenceOptions
): void {
  if (options.maxEvidenceAgeDays === undefined) {
    return;
  }
  if (!page.metadata.last_reviewed_at) {
    findings.push(finding(
      "unknown_freshness",
      "medium",
      "Page has no last_reviewed_at timestamp."
    ));
    return;
  }

  const reviewedAt = new Date(page.metadata.last_reviewed_at);
  const now = options.now ?? new Date();
  const ageMs = now.getTime() - reviewedAt.getTime();
  const maxAgeMs = options.maxEvidenceAgeDays * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    findings.push(finding(
      "stale_evidence",
      "medium",
      `Page evidence was last reviewed more than ${options.maxEvidenceAgeDays} days ago.`
    ));
  }
}

function reviewClaims(page: WikiTypedPage, findings: WikiReviewFinding[]): void {
  for (const claim of page.metadata.claims ?? []) {
    if (claim.sourceRefs.length === 0 && claim.evidence.length === 0) {
      findings.push(finding(
        "unsupported_claim",
        "high",
        "Claim has neither source references nor evidence records.",
        claim.claimId
      ));
    }
    if (claim.kind === "quantitative" && !claimHasConcreteEvidence(claim)) {
      findings.push(finding(
        "weak_quantitative_provenance",
        "high",
        "Quantitative claim lacks concrete evidence locators.",
        claim.claimId
      ));
    }
    if (claim.confidence === "low") {
      findings.push(finding(
        "low_confidence_claim",
        "medium",
        "Claim confidence is low.",
        claim.claimId
      ));
    }
    if (claimLooksAuthorOnly(claim)) {
      findings.push(finding(
        "author_claim_not_validated",
        "medium",
        "Claim appears to rely on author statements without independent validation.",
        claim.claimId
      ));
    }
  }
}

function reviewRelations(page: WikiTypedPage, findings: WikiReviewFinding[]): void {
  for (const relation of page.metadata.typed_relations ?? []) {
    if (relation.type === "contradicts" && relation.status === "candidate") {
      findings.push(finding(
        "unresolved_contradiction",
        "medium",
        `Candidate contradiction with ${relation.target} is unresolved.`,
        relation.target
      ));
    }
  }
}

function reviewPageLevelGaps(page: WikiTypedPage, findings: WikiReviewFinding[]): void {
  const claims = page.metadata.claims ?? [];
  if (claims.length > 0 && !hasCaveatSection(page.body) && !hasClaimCaveat(claims)) {
    findings.push(finding(
      "missing_caveat",
      "medium",
      "Page has claims but no caveat, limitation, scope, known uncertainty, contradiction, or open checks section."
    ));
  }

  if (
    (page.metadata.evidence_contract === "code-backed" || page.metadata.evidence_contract === "mixed") &&
    (page.metadata.experiment_refs ?? []).length === 0
  ) {
    findings.push(finding(
      "missing_experiment_ref",
      "medium",
      "Code-backed or mixed page has no experiment_refs."
    ));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawEvidenceHasConcreteLocator(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.page === "number" ||
    typeof value.figure === "string" ||
    typeof value.table === "string" ||
    typeof value.elementId === "string" ||
    typeof value.chunkId === "string" ||
    typeof value.codeOutputPath === "string";
}

function extractFrontmatter(markdown: string): string | undefined {
  const normalized = markdown.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  return match?.[1];
}

function parseJsonFrontmatterField(frontmatter: string, field: string): unknown {
  const fieldPattern = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const match = fieldPattern.exec(frontmatter);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

async function reviewMalformedPageClaims(
  options: ReviewWikiPageEvidenceOptions,
  findings: WikiReviewFinding[]
): Promise<void> {
  let markdown: string;
  try {
    markdown = await readFile(getPaperWikiPagePath(options.workspaceDir, options.pageKey), "utf8");
  } catch {
    return;
  }
  const frontmatter = extractFrontmatter(markdown);
  if (!frontmatter) {
    return;
  }
  const claims = parseJsonFrontmatterField(frontmatter, "claims");
  if (!Array.isArray(claims)) {
    return;
  }

  for (const claim of claims) {
    if (!isRecord(claim) || claim.kind !== "quantitative") {
      continue;
    }
    const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
    if (!evidence.some(rawEvidenceHasConcreteLocator)) {
      findings.push(finding(
        "weak_quantitative_provenance",
        "high",
        "Quantitative claim lacks concrete evidence locators.",
        typeof claim.claimId === "string" ? claim.claimId : undefined
      ));
    }
  }
}

export async function reviewWikiPageEvidence(
  options: ReviewWikiPageEvidenceOptions
): Promise<ReviewWikiPageEvidenceResult> {
  const readResult = await readTypedWikiPage({
    workspaceDir: options.workspaceDir,
    key: options.pageKey
  });
  const diagnostics = diagnosticsToMessages(readResult.diagnostics);

  if (!readResult.page) {
    const status = pageReadStatus(readResult.diagnostics);
    const findings: WikiReviewFinding[] = [];
    if (status === "malformed") {
      await reviewMalformedPageClaims(options, findings);
    }
    return {
      status,
      pageKey: options.pageKey,
      findings,
      diagnostics
    };
  }

  const findings: WikiReviewFinding[] = [];
  reviewKnowledgeState(readResult.page, findings);
  reviewFreshness(readResult.page, findings, options);
  reviewClaims(readResult.page, findings);
  reviewRelations(readResult.page, findings);
  reviewPageLevelGaps(readResult.page, findings);

  return {
    status: "ready",
    pageKey: readResult.page.metadata.key,
    relativePath: relativeToWorkspace(options.workspaceDir, readResult.page.path),
    findings,
    diagnostics
  };
}
