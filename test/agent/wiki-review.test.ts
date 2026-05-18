import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeTypedWikiPage } from "../../src/agent/wiki/typed-store.js";
import { reviewWikiPageEvidence } from "../../src/agent/wiki/review.js";

async function withWorkspace(name: string, run: (workspaceDir: string) => Promise<void>): Promise<void> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), name));
  try {
    await run(workspaceDir);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

test("reviewWikiPageEvidence reports stale speculative low-confidence evidence gaps", async () => {
  await withWorkspace("wiki-review-page-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "finding",
          key: "qldpc-hardware-embedding",
          title: "qLDPC hardware embedding",
          aliases: [],
          tags: ["qldpc"],
          evidence_contract: "mixed",
          source_refs: ["arxiv-2406.06015"],
          knowledge_state: "speculative",
          last_reviewed_at: "2026-01-01T00:00:00.000Z",
          claims: [{
            claimId: "claim-1",
            kind: "quantitative",
            statement: "The design has 1e-3 logical error rate according to author claims.",
            sourceRefs: ["arxiv-2406.06015"],
            evidence: [{ paperKey: "arxiv-2406.06015", page: 3 }],
            confidence: "low"
          }],
          typed_relations: [{
            type: "contradicts",
            target: "surface-code-baseline",
            targetKind: "page",
            evidenceRefs: ["claim-1"],
            status: "candidate"
          }],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# qLDPC hardware embedding\n\nClaim\n\nNo caveat heading here."
      }
    });

    const result = await reviewWikiPageEvidence({
      workspaceDir,
      pageKey: "qldpc-hardware-embedding",
      maxEvidenceAgeDays: 30,
      now: new Date("2026-05-18T00:00:00.000Z")
    });

    assert.equal(result.status, "ready");
    const kinds = result.findings.map((finding) => finding.kind);
    assert.ok(kinds.includes("speculative_knowledge_state"));
    assert.ok(kinds.includes("low_confidence_claim"));
    assert.ok(kinds.includes("unresolved_contradiction"));
    assert.ok(kinds.includes("stale_evidence"));
    assert.ok(kinds.includes("missing_caveat"));
    assert.ok(kinds.includes("missing_experiment_ref"));
    assert.ok(kinds.includes("author_claim_not_validated"));
  });
});

test("reviewWikiPageEvidence reports weak quantitative provenance on malformed typed pages", async () => {
  await withWorkspace("wiki-review-weak-provenance-", async (workspaceDir) => {
    const pagesDir = path.join(workspaceDir, "knowledge-base", "pages");
    await mkdir(pagesDir, { recursive: true });
    await writeFile(path.join(pagesDir, "weak-quantitative.md"), [
      "---",
      "schema_version: 1",
      'type: "finding"',
      'key: "weak-quantitative"',
      'title: "Weak quantitative"',
      "aliases: []",
      "tags: []",
      'evidence_contract: "paper-backed"',
      'source_refs: ["arxiv-2406.06015"]',
      `claims: ${JSON.stringify([{
        claimId: "claim-weak",
        kind: "quantitative",
        statement: "The paper reports a 1e-3 logical error rate.",
        sourceRefs: ["arxiv-2406.06015"],
        evidence: [{
          paperKey: "arxiv-2406.06015",
          quote: "The authors report a 1e-3 logical error rate.",
          note: "Paper claim only."
        }],
        confidence: "medium"
      }])}`,
      'created_at: "2026-05-10T00:00:00.000Z"',
      'updated_at: "2026-05-10T00:00:00.000Z"',
      "---",
      "",
      "# Weak quantitative"
    ].join("\n"), "utf8");

    const result = await reviewWikiPageEvidence({
      workspaceDir,
      pageKey: "weak-quantitative"
    });

    assert.ok(result.status === "ready" || result.status === "malformed");
    const kinds = result.findings.map((finding) => finding.kind);
    assert.ok(kinds.includes("weak_quantitative_provenance"));
  });
});

test("reviewWikiPageEvidence treats singular Known uncertainty as a caveat section", async () => {
  await withWorkspace("wiki-review-known-uncertainty-", async (workspaceDir) => {
    await writeTypedWikiPage({
      workspaceDir,
      page: {
        metadata: {
          schema_version: 1,
          type: "finding",
          key: "known-uncertainty",
          title: "Known uncertainty",
          aliases: [],
          tags: [],
          evidence_contract: "paper-backed",
          source_refs: ["arxiv-2406.06015"],
          claims: [{
            claimId: "claim-1",
            kind: "qualitative",
            statement: "The architecture may reduce routing pressure.",
            sourceRefs: ["arxiv-2406.06015"],
            evidence: [{ paperKey: "arxiv-2406.06015", page: 4 }],
            confidence: "medium"
          }],
          created_at: "2026-05-10T00:00:00.000Z",
          updated_at: "2026-05-10T00:00:00.000Z"
        },
        body: "# Known uncertainty\n\nClaim.\n\n## Known uncertainty\n\nNeeds independent replication."
      }
    });

    const result = await reviewWikiPageEvidence({
      workspaceDir,
      pageKey: "known-uncertainty"
    });

    assert.equal(result.status, "ready");
    const kinds = result.findings.map((finding) => finding.kind);
    assert.equal(kinds.includes("missing_caveat"), false);
  });
});
