import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
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
