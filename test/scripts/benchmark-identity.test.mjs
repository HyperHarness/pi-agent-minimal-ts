import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertResponsesCurrent,
  benchmarkItemId,
  benchmarkItemFingerprint,
  duplicateItemIds,
  freezeItem
} from "../../benchmark/lib.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
// A missing identity check must fail offline rather than invoke a real provider.
const offlineEnv = {
  PATH: process.env.PATH,
  PI_PROVIDER: "benchmark-offline-invalid", PI_MODEL: "unused",
  BENCH_PROVIDER: "benchmark-offline-invalid", BENCH_MODEL: "unused",
};

function candidate(overrides = {}) {
  return {
    category: "numerical",
    question: "In arXiv:2305.02907 by Jin et al., what SQUID self-resonance frequency is cited for the shared coupler?",
    gold_answer: "above 20 GHz",
    gold_sources: ["arxiv-2305.02907"],
    evidence: [{ sourceKey: "arxiv-2305.02907", quote: "self-resonance frequency above 20 GHz" }],
    ...overrides
  };
}

test("freezeItem derives ids from content, so re-freezes cannot shift them", () => {
  const items = [
    candidate({ question: "What is the mixing-chamber base temperature?" }),
    candidate({ question: "What is the qubit anharmonicity?" }),
    candidate({ question: "What is the readout resonator linewidth?" })
  ];
  const full = items.map((item) => freezeItem(item));
  // a re-verify that drops the middle candidate must not shift the survivors' ids
  const afterDrop = [items[0], items[2]].map((item) => freezeItem(item));
  assert.equal(afterDrop[0].id, full[0].id);
  assert.equal(afterDrop[1].id, full[2].id);
  // distinct questions get distinct ids
  assert.equal(new Set(full.map((item) => item.id)).size, full.length);
  for (const item of full) {
    assert.match(item.id, /^sq-[0-9a-f]{24}$/);
    assert.equal(item.id, benchmarkItemId(item));
    assert.ok(item.split === "dev" || item.split === "holdout", "split must stay hash-derived");
  }
  // freezing is deterministic
  assert.deepEqual(freezeItem(items[1]), full[1]);
});

test("fingerprints track gold/evidence changes under an unchanged question", () => {
  const item = freezeItem(candidate());
  const fingerprint = benchmarkItemFingerprint(item);
  assert.equal(fingerprint, benchmarkItemFingerprint(freezeItem(candidate())));
  // grading-relevant edits keep the id (it pins the question) but change the fingerprint
  const edits = [
    { gold_answer: "above 19 GHz" },
    { gold_sources: ["arxiv-2210.15293"] },
    { evidence: [{ sourceKey: "arxiv-2305.02907", quote: "self-resonance frequency above 19 GHz" }] },
    { rubric: [{ sourceKey: "arxiv-2305.02907", point: "mentions the coupler self-resonance" }] },
    { absence_claim: "not reported" }
  ];
  for (const edit of edits) {
    const edited = { ...item, ...edit };
    assert.equal(edited.id, item.id, "id pins the question, not the gold content");
    assert.notEqual(
      benchmarkItemFingerprint(edited),
      fingerprint,
      `fingerprint must change when ${Object.keys(edit)[0]} changes`
    );
  }
  // a changed question changes the id itself
  assert.notEqual(benchmarkItemId({ ...item, question: "A different question entirely?" }), item.id);
  // property order in the item object is irrelevant
  const reordered = {
    absence_claim: item.absence_claim,
    rubric: item.rubric,
    evidence: item.evidence,
    gold_sources: item.gold_sources,
    gold_answer: item.gold_answer,
    question: item.question,
    category: item.category,
    id: item.id
  };
  assert.equal(benchmarkItemFingerprint(reordered), fingerprint);
  // the legacy evidence_quote + anchor_source pair normalizes to the same content
  const legacy = freezeItem({
    ...candidate(),
    evidence: undefined,
    evidence_quote: "self-resonance frequency above 20 GHz",
    anchor_source: "arxiv-2305.02907"
  });
  assert.equal(legacy.id, item.id);
  assert.equal(benchmarkItemFingerprint(legacy), fingerprint);
});

test("assertResponsesCurrent accepts bound records and returns the resume set", () => {
  const benchmark = [
    freezeItem(candidate()),
    freezeItem(candidate({ question: "What T1 do the auxiliary transmons report?" }))
  ];
  const responses = benchmark.map((item) => ({
    id: item.id,
    fingerprint: benchmarkItemFingerprint(item),
    answer: "some answer"
  }));
  const done = assertResponsesCurrent(responses, benchmark, "results/agent-dev.jsonl");
  assert.deepEqual([...done].sort(), benchmark.map((item) => item.id).sort());
});

test("assertResponsesCurrent rejects stale response files instead of silently joining", () => {
  const benchmark = [
    freezeItem(candidate()),
    freezeItem(candidate({ question: "What T1 do the auxiliary transmons report?" }))
  ];
  const item = benchmark[0];
  const fresh = { id: item.id, fingerprint: benchmarkItemFingerprint(item), answer: "some answer" };

  // id gone from the benchmark: the file predates this freeze
  assert.throws(
    () => assertResponsesCurrent([{ ...fresh }, { id: "sq-oldbeef", fingerprint: "0", answer: "?" }], benchmark, "old.jsonl"),
    (error) => error instanceof Error && error.message.includes("stale responses in old.jsonl") && error.message.includes("sq-oldbeef")
  );

  // same id, gold answer edited since the run
  const editedGold = { ...item, gold_answer: "above 19 GHz" };
  assert.throws(
    () => assertResponsesCurrent([{ id: item.id, fingerprint: benchmarkItemFingerprint(editedGold), answer: "?" }], benchmark, "drift.jsonl"),
    (error) => error instanceof Error && error.message.includes("stale responses in drift.jsonl") && error.message.includes(item.id)
  );

  // legacy records without a fingerprint cannot be bound to any content
  assert.throws(
    () => assertResponsesCurrent([{ id: item.id, answer: "?" }], benchmark, "legacy.jsonl"),
    /stale responses in legacy\.jsonl/
  );
});

test("duplicateItemIds flags identical category+question pairs", () => {
  const sameQuestionTwice = [candidate(), candidate({ gold_answer: "above 21 GHz" })].map((item) => freezeItem(item));
  assert.deepEqual(duplicateItemIds(sameQuestionTwice), [benchmarkItemId(candidate())]);
  const distinct = [candidate(), candidate({ question: "A different question entirely?" })].map((item) => freezeItem(item));
  assert.deepEqual(duplicateItemIds(distinct), []);
  assert.throws(() => assertResponsesCurrent([], sameQuestionTwice, "empty.jsonl"), /Duplicate benchmark ids/);
});

test("fingerprints are stable across nested object key order and track answerability", () => {
  const item = freezeItem(candidate({ rubric: [{ point: "The coupler exceeds 20 GHz", sourceKey: "paper" }] }));
  const reordered = { ...item, rubric: [{ sourceKey: "paper", point: "The coupler exceeds 20 GHz" }] };
  assert.equal(benchmarkItemFingerprint(item), benchmarkItemFingerprint(reordered));
  assert.notEqual(benchmarkItemFingerprint(item), benchmarkItemFingerprint({ ...item, answerable: false }));
});

function writeStaleFixtures() {
  const dir = mkdtempSync(path.join(tmpdir(), "benchmark-identity-"));
  const item = freezeItem(candidate());
  const benchmarkPath = path.join(dir, "benchmark.jsonl");
  writeFileSync(benchmarkPath, `${JSON.stringify(item)}\n`, "utf8");
  return { dir, item, benchmarkPath };
}

test("run.mjs refuses to resume from a stale results file", () => {
  const { dir, item, benchmarkPath } = writeStaleFixtures();
  try {
    const outPath = path.join(dir, "agent-dev.jsonl");
    // recorded against an earlier freeze whose gold answer differed
    const stale = {
      id: item.id,
      fingerprint: benchmarkItemFingerprint({ ...item, gold_answer: "above 19 GHz" }),
      category: item.category,
      mode: "agent",
      answer: "old answer"
    };
    writeFileSync(outPath, `${JSON.stringify(stale)}\n`, "utf8");
    const run = spawnSync(
      process.execPath,
      ["benchmark/run.mjs", "--benchmark", benchmarkPath, "--out", outPath, "--split", "all"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, env: offlineEnv }
    );
    assert.notEqual(run.status, 0, `expected non-zero exit, got ${run.status}; stderr: ${run.stderr}`);
    assert.match(run.stderr, /stale responses/);
    assert.ok(run.stderr.includes(outPath), "the error must name the stale file");
    assert.ok(run.stderr.includes(item.id), "the error must name the drifted item");
    // nothing was appended to or rewritten in the rejected file
    assert.equal(readFileSync(outPath, "utf8"), `${JSON.stringify(stale)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grade.mjs refuses to grade responses whose item is gone from the benchmark", () => {
  const { dir, benchmarkPath } = writeStaleFixtures();
  try {
    const responsesPath = path.join(dir, "agent-dev.jsonl");
    const stale = { id: "sq-0000ffff", fingerprint: "0", mode: "agent", answer: "orphaned answer" };
    writeFileSync(responsesPath, `${JSON.stringify(stale)}\n`, "utf8");
    const grade = spawnSync(
      process.execPath,
      ["benchmark/grade.mjs", "--responses", responsesPath, "--benchmark", benchmarkPath],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, env: offlineEnv }
    );
    assert.notEqual(grade.status, 0, `expected non-zero exit, got ${grade.status}; stderr: ${grade.stderr}`);
    assert.match(grade.stderr, /stale responses/);
    assert.ok(grade.stderr.includes(responsesPath), "the error must name the responses file");
    assert.ok(grade.stderr.includes("sq-0000ffff"), "the error must name the unknown id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grade.mjs rejects a stale comparison file before resolving or calling a judge model", () => {
  const { dir, item, benchmarkPath } = writeStaleFixtures();
  try {
    const responsesPath = path.join(dir, "agent.jsonl");
    const comparisonPath = path.join(dir, "baseline.jsonl");
    writeFileSync(responsesPath, `${JSON.stringify({ id: item.id, fingerprint: benchmarkItemFingerprint(item), answer: "answer" })}\n`);
    writeFileSync(comparisonPath, `${JSON.stringify({ id: item.id, fingerprint: "stale", answer: "old answer" })}\n`);
    const grade = spawnSync(process.execPath, ["benchmark/grade.mjs", "--responses", responsesPath, "--compare", comparisonPath, "--benchmark", benchmarkPath], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, env: offlineEnv,
    });
    assert.notEqual(grade.status, 0);
    assert.match(grade.stderr, /stale responses/);
    assert.ok(grade.stderr.includes(comparisonPath));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
