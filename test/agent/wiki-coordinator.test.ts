import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { planWikiAgentWork } from "../../src/agent/wiki/coordinator.js";
import type {
  WikiAgentCoordinationPlan,
  WikiAgentCoordinationStep
} from "../../src/agent/wiki/coordinator.js";

function assertStepPlan(
  plan: WikiAgentCoordinationPlan,
  expected: Array<Pick<WikiAgentCoordinationStep, "action" | "owner">>
): void {
  assert.equal(plan.steps.length, expected.length);
  for (const [index, expectedStep] of expected.entries()) {
    assert.equal(plan.steps[index]?.action, expectedStep.action);
    assert.equal(plan.steps[index]?.owner, expectedStep.owner);
    assert.equal(typeof plan.steps[index]?.reason, "string");
    assert.notEqual(plan.steps[index]?.reason.trim(), "");
  }
}

test("coordinator answers locally when evidence is sufficient", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-coordinator-local-"));
  try {
    const plan = await planWikiAgentWork({
      workspaceDir: workspace,
      intent: "answer_scientific_question",
      query: "frequency allocation",
      localEvidenceCount: 3,
      hasBlockedAcquisition: false
    });

    assert.equal(plan.decision, "answer_from_local_wiki");
    assertStepPlan(plan, [
      { action: "search_local_evidence", owner: "wiki-evidence-worker" },
      { action: "read_selected_evidence", owner: "wiki-evidence-worker" },
      { action: "answer_with_citations", owner: "wiki-agent" }
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coordinator requests acquisition only for evidence gaps", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-coordinator-gap-"));
  try {
    const plan = await planWikiAgentWork({
      workspaceDir: workspace,
      intent: "answer_scientific_question",
      query: "frequency allocation",
      localEvidenceCount: 0,
      hasBlockedAcquisition: false
    });

    assert.equal(plan.decision, "acquire_then_summarize");
    assertStepPlan(plan, [
      { action: "search_local_evidence", owner: "wiki-evidence-worker" },
      { action: "search_external_candidates", owner: "paper-download-subagent" },
      { action: "download_candidate_papers", owner: "paper-download-subagent" },
      { action: "generate_source_summaries", owner: "wiki-evidence-worker" },
      { action: "rerun_local_retrieval", owner: "wiki-evidence-worker" },
      { action: "answer_with_citations", owner: "wiki-agent" }
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coordinator normalizes invalid counts in handoff metadata", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-coordinator-normalized-"));
  try {
    const plan = await planWikiAgentWork({
      workspaceDir: workspace,
      intent: "maintenance_session",
      localEvidenceCount: -3,
      fixedEvidenceCount: Number.NaN,
      maintenanceIssueCount: Number.NEGATIVE_INFINITY
    });

    assert.equal(plan.handoff.localEvidenceCount, 0);
    assert.equal(plan.handoff.fixedEvidenceCount, 0);
    assert.equal(plan.handoff.maintenanceIssueCount, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coordinator treats undefined blocked acquisition as false", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-coordinator-unblocked-default-"));
  try {
    const plan = await planWikiAgentWork({
      workspaceDir: workspace,
      intent: "answer_scientific_question",
      query: "frequency allocation",
      localEvidenceCount: 0
    });

    assert.equal(plan.decision, "acquire_then_summarize");
    assert.equal(plan.handoff.hasBlockedAcquisition, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coordinator reports blocked acquisition without retrying downloads", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-coordinator-blocked-"));
  try {
    const plan = await planWikiAgentWork({
      workspaceDir: workspace,
      intent: "answer_scientific_question",
      query: "frequency allocation",
      localEvidenceCount: 0,
      hasBlockedAcquisition: true
    });

    assert.equal(plan.decision, "report_blocked_or_insufficient");
    assertStepPlan(plan, [
      { action: "search_local_evidence", owner: "wiki-evidence-worker" },
      { action: "summarize_remaining_risks", owner: "wiki-agent" }
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coordinator builds topic pages from fixed evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-coordinator-topic-fixed-"));
  try {
    const plan = await planWikiAgentWork({
      workspaceDir: workspace,
      intent: "build_topic_page",
      topic: "frequency allocation",
      fixedEvidenceCount: 2
    });

    assert.equal(plan.decision, "build_from_fixed_evidence");
    assertStepPlan(plan, [
      { action: "bootstrap_topic_evidence", owner: "wiki-evidence-worker" },
      { action: "read_selected_evidence", owner: "wiki-evidence-worker" },
      { action: "write_synthesis_page", owner: "wiki-synthesis-worker" }
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coordinator acquires evidence before building topic pages when fixed evidence is absent", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-coordinator-topic-gap-"));
  try {
    const plan = await planWikiAgentWork({
      workspaceDir: workspace,
      intent: "build_topic_page",
      topic: "frequency allocation",
      fixedEvidenceCount: 0
    });

    assert.equal(plan.decision, "acquire_then_summarize");
    assertStepPlan(plan, [
      { action: "bootstrap_topic_evidence", owner: "wiki-evidence-worker" },
      { action: "search_external_candidates", owner: "paper-download-subagent" },
      { action: "download_candidate_papers", owner: "paper-download-subagent" },
      { action: "generate_source_summaries", owner: "wiki-evidence-worker" },
      { action: "rerun_local_retrieval", owner: "wiki-evidence-worker" },
      { action: "write_synthesis_page", owner: "wiki-synthesis-worker" }
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coordinator plans deterministic maintenance sessions", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-coordinator-maintenance-"));
  try {
    const plan = await planWikiAgentWork({
      workspaceDir: workspace,
      intent: "maintenance_session",
      maintenanceIssueCount: 4
    });

    assert.equal(plan.decision, "plan_maintenance");
    assertStepPlan(plan, [
      { action: "run_health_and_lint", owner: "wiki-agent" },
      { action: "produce_structure_plan", owner: "wiki-synthesis-worker" },
      { action: "apply_low_risk_repairs", owner: "wiki-agent" },
      { action: "summarize_remaining_risks", owner: "wiki-agent" }
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
