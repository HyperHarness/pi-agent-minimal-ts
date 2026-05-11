import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWikiPageMarkdown,
  serializeWikiPageMarkdown,
  validateWikiPageMetadata,
  type WikiEvidenceContract
} from "../../src/agent/wiki/page-schema.js";

function validMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    type: "concept",
    key: "frequency-crowding",
    title: "Frequency crowding",
    aliases: [],
    tags: [],
    evidence_contract: "paper-backed",
    source_refs: ["arxiv-2601.00003"],
    created_at: "2026-05-10T00:00:00.000Z",
    updated_at: "2026-05-10T00:00:00.000Z",
    ...overrides
  };
}

test("parseWikiPageMarkdown parses paper-source metadata and body", () => {
  const markdown = [
    "---",
    'type: "paper-source"',
    'key: "arxiv-2601.00003"',
    'title: "Manifest-backed source"',
    "aliases:",
    '  - "manifest source"',
    "tags:",
    '  - "quantum-simulation"',
    'evidence_contract: "paper-backed"',
    "source_refs:",
    '  - "arxiv-2601.00003"',
    'created_at: "2026-05-10T00:00:00.000Z"',
    'updated_at: "2026-05-10T00:00:00.000Z"',
    "---",
    "",
    "# Manifest-backed source",
    "",
    "Grounded body."
  ].join("\n");

  const parsed = parseWikiPageMarkdown(markdown, "knowledge-base/sources/arxiv-2601.00003/summary.md");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.page?.metadata.type, "paper-source");
  assert.equal(parsed.page?.metadata.key, "arxiv-2601.00003");
  assert.deepEqual(parsed.page?.metadata.tags, ["quantum-simulation"]);
  assert.equal(parsed.page?.body.trim(), "# Manifest-backed source\n\nGrounded body.");
});

test("validateWikiPageMetadata reports malformed pages without throwing", () => {
  const result = validateWikiPageMetadata({
    type: "synthesis",
    key: "",
    title: "",
    aliases: [],
    tags: [],
    evidence_contract: "paper-backed",
    source_refs: [],
    created_at: "not-a-date",
    updated_at: "2026-05-10T00:00:00.000Z"
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), [
    "missing_key",
    "missing_title",
    "invalid_created_at",
    "missing_source_refs"
  ]);
});

test("serializeWikiPageMarkdown preserves the body under normalized metadata", () => {
  const markdown = serializeWikiPageMarkdown({
    metadata: {
      schema_version: 1,
      type: "concept",
      key: "frequency-crowding",
      title: "Frequency crowding",
      aliases: ["crowding"],
      tags: ["superconducting-qubits"],
      evidence_contract: "paper-backed",
      source_refs: ["arxiv-2601.00003"],
      created_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z"
    },
    body: "# Frequency crowding\n\nA typed concept page."
  });

  assert.match(markdown, /^---\n/);
  assert.match(markdown, /schema_version: 1/);
  assert.match(markdown, /type: "concept"/);
  assert.match(markdown, /# Frequency crowding/);
});

test("parseWikiPageMarkdown normalizes missing schema_version to 1", () => {
  const markdown = [
    "---",
    'type: "concept"',
    'key: "frequency-crowding"',
    'title: "Frequency crowding"',
    "aliases: []",
    "tags: []",
    'evidence_contract: "paper-backed"',
    "source_refs:",
    '  - "arxiv-2601.00003"',
    'created_at: "2026-05-10T00:00:00.000Z"',
    'updated_at: "2026-05-10T00:00:00.000Z"',
    "---",
    "",
    "# Frequency crowding"
  ].join("\n");

  const parsed = parseWikiPageMarkdown(markdown, "knowledge-base/pages/frequency-crowding.md");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.page?.metadata.schema_version, 1);
});

test("parseWikiPageMarkdown accepts registered execution_binding metadata", () => {
  const markdown = [
    "---",
    "schema_version: 1",
    "type: concept",
    "key: transmon-frequency",
    "title: Transmon frequency",
    "aliases: []",
    'tags:',
    '  - "superconducting-qubits"',
    "evidence_contract: code-backed",
    "source_refs:",
    '  - "transmon-helper"',
    'execution_binding: "transmon-frequency-estimate"',
    "created_at: 2026-05-10T00:00:00.000Z",
    "updated_at: 2026-05-10T00:00:00.000Z",
    "---",
    "",
    "# Transmon frequency"
  ].join("\n");

  const parsed = parseWikiPageMarkdown(markdown, "knowledge-base/pages/transmon-frequency.md");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.page?.metadata.execution_binding, "transmon-frequency-estimate");
});

test("parseWikiPageMarkdown rejects unknown execution_binding metadata without throwing", () => {
  const markdown = [
    "---",
    "schema_version: 1",
    "type: concept",
    "key: unknown-helper-page",
    "title: Unknown helper page",
    "aliases: []",
    "tags: []",
    "evidence_contract: code-backed",
    "source_refs:",
    '  - "helper-source"',
    'execution_binding: "unknown-helper"',
    "created_at: 2026-05-10T00:00:00.000Z",
    "updated_at: 2026-05-10T00:00:00.000Z",
    "---",
    "",
    "# Unknown helper page"
  ].join("\n");

  assert.doesNotThrow(() => parseWikiPageMarkdown(markdown, "knowledge-base/pages/unknown-helper-page.md"));

  const parsed = parseWikiPageMarkdown(markdown, "knowledge-base/pages/unknown-helper-page.md");

  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.errors.map((error) => error.code), ["unknown_execution_binding"]);
});

test("parseWikiPageMarkdown accepts unquoted scalars and empty array literals", () => {
  const markdown = [
    "---",
    "schema_version: 1",
    "type: question",
    "key: open-question",
    "title: Open question",
    "aliases: []",
    "tags: []",
    "evidence_contract: none",
    "source_refs: []",
    "created_at: 2026-05-10T00:00:00.000Z",
    "updated_at: 2026-05-10T00:00:00.000Z",
    "---",
    "",
    "# Open question"
  ].join("\n");

  const parsed = parseWikiPageMarkdown(markdown, "knowledge-base/pages/open-question.md");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.page?.metadata.type, "question");
  assert.equal(parsed.page?.metadata.title, "Open question");
  assert.deepEqual(parsed.page?.metadata.aliases, []);
  assert.deepEqual(parsed.page?.metadata.tags, []);
  assert.deepEqual(parsed.page?.metadata.source_refs, []);
});

test("validateWikiPageMetadata reports unknown type without throwing", () => {
  assert.doesNotThrow(() => validateWikiPageMetadata(validMetadata({ type: "unknown-page-type" })));

  const result = validateWikiPageMetadata(validMetadata({ type: "unknown-page-type" }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["invalid_type"]);
});

test("validateWikiPageMetadata reports unknown evidence_contract without throwing", () => {
  assert.doesNotThrow(() => validateWikiPageMetadata(validMetadata({ evidence_contract: "unsupported" })));

  const result = validateWikiPageMetadata(validMetadata({ evidence_contract: "unsupported" }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["invalid_frontmatter"]);
});

test("validateWikiPageMetadata requires source_refs for non-none evidence contracts", () => {
  const requiredContracts: WikiEvidenceContract[] = ["design-backed", "code-backed", "mixed"];

  for (const evidenceContract of requiredContracts) {
    const result = validateWikiPageMetadata(validMetadata({
      evidence_contract: evidenceContract,
      source_refs: []
    }));

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((error) => error.code), ["missing_source_refs"]);
  }
});

test("validateWikiPageMetadata allows none evidence contract without source_refs", () => {
  const result = validateWikiPageMetadata(validMetadata({
    evidence_contract: "none",
    source_refs: []
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.metadata?.source_refs, []);
});

test("parseWikiPageMarkdown accepts evidence audit metadata", () => {
  const markdown = [
    "---",
    "schema_version: 1",
    'type: "concept"',
    'key: "logical-error-rate"',
    'title: "Logical error rate"',
    "aliases: []",
    "tags: []",
    'evidence_contract: "mixed"',
    "source_refs:",
    '  - "arxiv-2406.06015"',
    'claims: [{"claimId":"claim-1","kind":"quantitative","statement":"The fitted threshold is 0.016.","sourceRefs":["arxiv-2406.06015"],"evidence":[{"paperKey":"arxiv-2406.06015","page":1,"figure":"16","elementId":"el-00555","quote":"fit parameters"}],"confidence":"high"}]',
    'typed_relations: [{"type":"supports","target":"surface-code","targetKind":"page","evidenceRefs":["claim-1"],"status":"confirmed","note":"Uses surface-code scaling."}]',
    'experiment_refs: [{"experimentId":"exp-1","title":"Scaling fit reproduction","scriptPath":"experiments/scaling-fit/run.ts","resultPath":"experiments/scaling-fit/result.json","status":"planned"}]',
    'reviewer_critique: [{"id":"critique-1","severity":"medium","target":"claim-1","reason":"Fit assumptions need checking.","suggestedFix":"Link the simulation configuration."}]',
    'created_at: "2026-05-10T00:00:00.000Z"',
    'updated_at: "2026-05-10T00:00:00.000Z"',
    "---",
    "",
    "# Logical error rate"
  ].join("\n");

  const parsed = parseWikiPageMarkdown(markdown, "knowledge-base/pages/logical-error-rate.md");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.page?.metadata.claims?.[0].claimId, "claim-1");
  assert.equal(parsed.page?.metadata.typed_relations?.[0].type, "supports");
  assert.equal(parsed.page?.metadata.experiment_refs?.[0].scriptPath, "experiments/scaling-fit/run.ts");
  assert.equal(parsed.page?.metadata.reviewer_critique?.[0].severity, "medium");

  const serialized = serializeWikiPageMarkdown({
    metadata: { ...parsed.page!.metadata },
    body: parsed.page!.body
  });
  assert.match(serialized, /claims: \[/);
  assert.match(serialized, /typed_relations: \[/);
  assert.match(serialized, /experiment_refs: \[/);
  assert.match(serialized, /reviewer_critique: \[/);
});

test("validateWikiPageMetadata rejects quantitative claims without concrete provenance", () => {
  const result = validateWikiPageMetadata(validMetadata({
    claims: [{
      claimId: "claim-1",
      kind: "quantitative",
      statement: "The threshold is 0.016.",
      sourceRefs: ["arxiv-2406.06015"],
      evidence: [{
        paperKey: "arxiv-2406.06015",
        quote: "fit parameters"
      }],
      confidence: "high"
    }]
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["invalid_claim_provenance"]);
});

test("validateWikiPageMetadata requires canonical_page for alias pages", () => {
  const missingCanonicalPage = validateWikiPageMetadata(validMetadata({
    type: "alias",
    evidence_contract: "none",
    source_refs: []
  }));
  const withCanonicalPage = validateWikiPageMetadata(validMetadata({
    type: "alias",
    canonical_page: "frequency-crowding",
    evidence_contract: "none",
    source_refs: []
  }));

  assert.equal(missingCanonicalPage.ok, false);
  assert.deepEqual(missingCanonicalPage.errors.map((error) => error.code), ["missing_canonical_page"]);
  assert.equal(withCanonicalPage.ok, true);
  assert.equal(withCanonicalPage.metadata?.canonical_page, "frequency-crowding");
});

test("parseWikiPageMarkdown rejects unsupported inline and scalar array fields", () => {
  const inlineArray = parseWikiPageMarkdown([
    "---",
    "schema_version: 1",
    "type: concept",
    "key: malformed-aliases",
    "title: Malformed aliases",
    "aliases: [bad]",
    "tags: []",
    "evidence_contract: paper-backed",
    "source_refs:",
    '  - "arxiv-2601.00003"',
    "created_at: 2026-05-10T00:00:00.000Z",
    "updated_at: 2026-05-10T00:00:00.000Z",
    "---",
    "",
    "# Malformed aliases"
  ].join("\n"), "knowledge-base/pages/malformed-aliases.md");
  const scalarArray = parseWikiPageMarkdown([
    "---",
    "schema_version: 1",
    "type: concept",
    "key: malformed-tags",
    "title: Malformed tags",
    "aliases: []",
    "tags: not-array",
    "evidence_contract: paper-backed",
    "source_refs:",
    '  - "arxiv-2601.00003"',
    "created_at: 2026-05-10T00:00:00.000Z",
    "updated_at: 2026-05-10T00:00:00.000Z",
    "---",
    "",
    "# Malformed tags"
  ].join("\n"), "knowledge-base/pages/malformed-tags.md");

  assert.equal(inlineArray.ok, false);
  assert.ok(inlineArray.errors.map((error) => error.code).includes("invalid_frontmatter"));
  assert.equal(scalarArray.ok, false);
  assert.ok(scalarArray.errors.map((error) => error.code).includes("invalid_frontmatter"));
});

test("validateWikiPageMetadata rejects present non-array metadata fields", () => {
  const result = validateWikiPageMetadata(validMetadata({
    related_pages: "not-array",
    related_papers: "[bad]"
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), [
    "invalid_frontmatter",
    "invalid_frontmatter"
  ]);
});

test("parseWikiPageMarkdown rejects explicit unsupported schema_version", () => {
  const versionTwo = parseWikiPageMarkdown([
    "---",
    "schema_version: 2",
    "type: concept",
    "key: schema-v2",
    "title: Schema v2",
    "aliases: []",
    "tags: []",
    "evidence_contract: none",
    "source_refs: []",
    "created_at: 2026-05-10T00:00:00.000Z",
    "updated_at: 2026-05-10T00:00:00.000Z",
    "---",
    "",
    "# Schema v2"
  ].join("\n"), "knowledge-base/pages/schema-v2.md");
  const nonNumeric = parseWikiPageMarkdown([
    "---",
    "schema_version: beta",
    "type: concept",
    "key: schema-beta",
    "title: Schema beta",
    "aliases: []",
    "tags: []",
    "evidence_contract: none",
    "source_refs: []",
    "created_at: 2026-05-10T00:00:00.000Z",
    "updated_at: 2026-05-10T00:00:00.000Z",
    "---",
    "",
    "# Schema beta"
  ].join("\n"), "knowledge-base/pages/schema-beta.md");

  assert.equal(versionTwo.ok, false);
  assert.ok(versionTwo.errors.map((error) => error.code).includes("invalid_frontmatter"));
  assert.equal(nonNumeric.ok, false);
  assert.ok(nonNumeric.errors.map((error) => error.code).includes("invalid_frontmatter"));
});

test("serializeWikiPageMarkdown rejects explicit unsupported schema_version", () => {
  assert.throws(
    () => serializeWikiPageMarkdown({
      metadata: validMetadata({ schema_version: 2 }),
      body: "# Invalid schema version"
    }),
    /invalid_frontmatter/
  );
});
