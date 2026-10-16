import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertDesignScriptExecution, canonicalDesignJson, createAgentdDesignExecution,
  designSha256, executeExternalDesignScript, prepareDesignExecutionRequest,
  type AgentdDesignExecution, type DesignExecutionLimits,
} from "../../src/agent/design-script-execution.js";

import { fixture, limits } from "./fixtures/design-execution-fixture.js";
const python = "/usr/bin/python3";

test("default self sandbox and forged external configuration fail closed", () => {
  assert.doesNotThrow(() => assertDesignScriptExecution(undefined));
  assert.doesNotThrow(() => assertDesignScriptExecution({ mode: "self-sandbox" }));
  assert.throws(() => assertDesignScriptExecution({ mode: "external-agentd", execute: () => ({ status: "completed" }) } as unknown as AgentdDesignExecution), /trusted startup/);
  assert.throws(() => assertDesignScriptExecution({ mode: "off" } as never), /Unverified/);
});

test("mandatory frozen limits reject missing, excessive and inconsistent values", async () => {
  const f = await fixture();
  try {
    for (const policy of [{ ...limits, max_input_bytes: undefined }, { ...limits, max_path_depth: 33 }, { ...limits, max_input_files: -1 }, { ...limits, max_input_file_bytes: limits.max_input_bytes + 1 }]) {
      assert.throws(() => createAgentdDesignExecution({ ...f.configuration, limits: policy as DesignExecutionLimits }), /limit|ceiling/);
    }
    assert.doesNotThrow(() => createAgentdDesignExecution({ ...f.configuration, limits: { ...limits, max_output_files: 0, max_input_directories: 0 } }));
    assert.throws(() => createAgentdDesignExecution({ ...f.configuration, helperTimeoutMs: 150001 }), /deadline/);
    assert.throws(() => createAgentdDesignExecution({ ...f.configuration, pythonExecutable: "python3" }), /configuration/);
  } finally { await f.dispose(); }
});

test("immutable bounded request preserves selected root shim bytes and Unicode hash", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.designCodeDir, ".venv", "bin"), { recursive: true });
    await writeFile(path.join(f.designCodeDir, ".venv", "bin", "python"), "nested-shim-MUST-NOT-SELECT");
    await writeFile(path.join(f.designCodeDir, "😀.txt"), "astral");
    await writeFile(path.join(f.designCodeDir, "é.txt"), "accent");
    await writeFile(path.join(f.designCodeDir, "\uE000.txt"), "private-use");
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, limits }), /relative path/);
    await rm(path.join(f.designCodeDir, "\uE000.txt"));
    const request = await prepareDesignExecutionRequest({ ...f.input, limits });
    assert.equal(Buffer.from(request.root_entry!.data_base64, "base64").toString(), await readFile(f.rootVenvPython, "utf8"));
    assert.equal(request.files.some(file => file.path === ".venv/bin/python"), true);
    assert.equal(Object.isFrozen(request) && Object.isFrozen(request.files) && request.files.every(Object.isFrozen), true);
    assert.equal(canonicalDesignJson(request).includes(f.root), false);
    const pythonHash = execFileSync(python, ["-I", "-S", "-c", "import sys,json,hashlib;r=json.load(sys.stdin);print(hashlib.sha256(json.dumps(r,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest())"], { input: canonicalDesignJson(request), encoding: "utf8" }).trim();
    assert.equal(designSha256(canonicalDesignJson(request)), pythonHash);
  } finally { await f.dispose(); }
});

test("root-entry symlink may resolve selected runtime but design-input symlink cannot", async () => {
  const f = await fixture();
  try {
    const actual = path.join(f.root, "selected-runtime");
    await writeFile(actual, "selected runtime bytes"); await rm(f.rootVenvPython); await symlink(actual, f.rootVenvPython);
    const request = await prepareDesignExecutionRequest({ ...f.input, limits });
    assert.equal(request.root_entry?.sha256, designSha256("selected runtime bytes"));
    await symlink(actual, path.join(f.designCodeDir, "escape"));
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, limits }), /ELOOP/);
  } finally { await f.dispose(); }
});

test("hardlinks and FIFO inputs are rejected without executing or blocking", async () => {
  const f = await fixture();
  try {
    await link(path.join(f.designCodeDir, "entry.py"), path.join(f.designCodeDir, "alias.py"));
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, limits }), /single-link/);
    await rm(path.join(f.designCodeDir, "alias.py"));
    execFileSync("mkfifo", [path.join(f.designCodeDir, "pipe")]);
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, limits }), /ordinary/);
  } finally { await f.dispose(); }
});

test("input count includes root entry and root itself is not an input directory", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, limits: { ...limits, max_input_files: 1 } }), /Too many/);
    await assert.doesNotReject(() => prepareDesignExecutionRequest({ ...f.input, limits: { ...limits, max_input_directories: 0 } }));
    await mkdir(path.join(f.designCodeDir, "sub")); await writeFile(path.join(f.designCodeDir, "sub", "data"), "x");
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, limits: { ...limits, max_input_directories: 0 } }), /directories/);
  } finally { await f.dispose(); }
});

test("path traversal, drive paths, hidden git and prefix output conflicts are rejected", async () => {
  const f = await fixture();
  try {
    for (const output of ["../escape", "/host", "C:host", "a//b", "a/./b", "a\\b", ".GIT/config", "a/\u202Eevil", "x".repeat(256)]) {
      await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, outputPaths: [output], limits }), /relative path/);
    }
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, outputPaths: ["a", "a/b"], limits }), /prefix conflict/);
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, outputPaths: ["a", "a"], limits }), /Duplicate/);
  } finally { await f.dispose(); }
});

test("request byte, individual file, aggregate input and missing-root bounds", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, limits: { ...limits, max_request_bytes: 1 } }), /request exceeds/);
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, limits: { ...limits, max_input_file_bytes: 1 } }), /bounded/);
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, limits: { ...limits, max_input_bytes: 1 } }), /bounded/);
    await assert.rejects(() => prepareDesignExecutionRequest({ ...f.input, rootVenvPython: undefined, limits }), /Root .venv/);
    const klayout = await prepareDesignExecutionRequest({ ...f.input, runner: "klayout", limits });
    assert.equal(klayout.root_entry, null);
  } finally { await f.dispose(); }
});

test("synthetic helper publishes exactly declared frozen bytes; no direct script/root execution", async () => {
  const f = await fixture();
  const previous = process.env.DESIGN_EXEC_TEST_SECRET;
  process.env.DESIGN_EXEC_TEST_SECRET = "must-not-be-inherited";
  try {
    const original = await readFile(path.join(f.designCodeDir, "entry.py"), "utf8");
    const result = await executeExternalDesignScript(f.input);
    assert.deepEqual(result.outputs, [{ path: "design-repo/design-code/out/a.gds", bytes: 17 }]);
    assert.equal(await readFile(path.join(f.designCodeDir, "out", "a.gds"), "utf8"), "fixture:out/a.gds");
    assert.equal(await readFile(path.join(f.designCodeDir, "entry.py"), "utf8"), original);
    assert.equal(result.stdout, "synthetic fixture only");
  } finally { if (previous === undefined) delete process.env.DESIGN_EXEC_TEST_SECRET; else process.env.DESIGN_EXEC_TEST_SECRET = previous; await f.dispose(); }
});

for (const [name, mutation, error] of [
  ["request digest", "response['request_sha256']='0'*64", /binding/],
  ["request identity", "response['request_id']='0'*32", /binding/],
  ["input manifest", "response['execution']['input_manifest_sha256']='0'*64", /binding/],
  ["root runtime", "response['execution']['root_entry_sha256']='0'*64", /binding/],
  ["network boundary", "response['execution']['boundary']['network']='host'", /boundary/],
  ["write boundary", "response['execution']['boundary']['write_scope']='workspace'", /boundary/],
  ["descendant closure", "response['execution']['closure']['descendants_stopped']=False", /cleanup_unverified/],
  ["output freeze", "response['execution']['closure']['output_frozen']=False", /cleanup_unverified/],
  ["output digest", "response['outputs'][0]['sha256']='0'*64", /digest/],
  ["output size", "response['outputs'][0]['size']+=1", /size/],
  ["undeclared output", "response['outputs'][0]['path']='other.gds'", /unexpected/],
  ["missing output", "response['outputs']=[]", /output set/],
  ["unknown fields", "response['host_path']='/tmp/escape'", /fields/],
  ["wrong exit code", "response['exit_code']=3", /nonzero/],
  ["oversized logs", "response['stdout']='x'*1001", /logs/],
] as const) {
  test(`rejects synthetic forged ${name} before publishing`, async () => {
    const f = await fixture(mutation);
    try { await assert.rejects(() => executeExternalDesignScript(f.input), error); await assert.rejects(() => readFile(path.join(f.designCodeDir, "out", "a.gds")), /ENOENT/); }
    finally { await f.dispose(); }
  });
}
for (const state of ["script_failed", "input_rejected", "environment_unverified", "resource_limit", "timed_out", "cancelled", "cleanup_unverified"]) {
  test(`terminal ${state} never publishes or retries locally`, async () => {
    const f = await fixture(`response['status']='${state}'; response['outputs']=[]`);
    try { await assert.rejects(() => executeExternalDesignScript(f.input), new RegExp(state)); await assert.rejects(() => readFile(path.join(f.designCodeDir, "out", "a.gds")), /ENOENT/); }
    finally { await f.dispose(); }
  });
}

test("failed calls preserve both bounded Unicode log streams", async () => {
  const f = await fixture("response.update(status='script_failed',exit_code=7,outputs=[],stdout='输😀',stderr='错é')");
  try {
    await assert.rejects(() => executeExternalDesignScript({ ...f.input, maxOutputChars: 4 }),
      { message: "run_design_script external-agentd script_failed: stdout:\n输😀\nstderr:\n错é" });
    await assert.rejects(() => readFile(path.join(f.designCodeDir, "out", "a.gds")), /ENOENT/);
  } finally { await f.dispose(); }
});

test("failed calls with empty logs retain a useful no-publication diagnostic", async () => {
  const f = await fixture("response.update(status='script_failed',exit_code=7,outputs=[],stdout='',stderr='')");
  try {
    await assert.rejects(() => executeExternalDesignScript(f.input),
      { message: "run_design_script external-agentd script_failed: no outputs published" });
  } finally { await f.dispose(); }
});

test("failed logs share one Unicode codepoint budget across both streams", async () => {
  const f = await fixture("response.update(status='script_failed',exit_code=7,outputs=[],stdout='输😀',stderr='错é')");
  try { await assert.rejects(() => executeExternalDesignScript({ ...f.input, maxOutputChars: 3 }), /oversized execution logs/); }
  finally { await f.dispose(); }
});

test("helper tampering, symlink substitution, unavailable helper and timeout fail closed", async () => {
  const f = await fixture();
  try {
    await chmod(f.helperPath, 0o600); await writeFile(f.helperPath, "raise RuntimeError('tampered')");
    await assert.rejects(() => executeExternalDesignScript(f.input), /digest mismatch/);
    await rm(f.helperPath); await symlink(path.join(f.designCodeDir, "entry.py"), f.helperPath);
    await assert.rejects(() => executeExternalDesignScript(f.input), /ELOOP/);
    await rm(f.helperPath); await assert.rejects(() => executeExternalDesignScript(f.input), /ENOENT/);
  } finally { await f.dispose(); }
  const slow = await fixture("", "time.sleep(10)", { timeout: 30 });
  try { await assert.rejects(() => executeExternalDesignScript(slow.input), /completion is unverified/); }
  finally { await slow.dispose(); }
});

test("all output destinations preflight before any replacement", async () => {
  const before = "os.symlink('/tmp', '$ROOT/design-repo/design-code/late-link')";
  const f = await fixture("", before);
  try {
    await writeFile(path.join(f.designCodeDir, "first.gds"), "original");
    await assert.rejects(() => executeExternalDesignScript({ ...f.input, outputPaths: ["first.gds", "late-link/escape.gds"] }), /publication failed; published=\[\]/);
    assert.equal(await readFile(path.join(f.designCodeDir, "first.gds"), "utf8"), "original");
  } finally { await f.dispose(); }
});

test("separate calls use fresh ids and concurrent calls cannot share a backend", async () => {
  const f = await fixture("", "time.sleep(0.15)");
  try {
    const first = await prepareDesignExecutionRequest({ ...f.input, limits });
    const second = await prepareDesignExecutionRequest({ ...f.input, limits });
    assert.notEqual(first.request_id, second.request_id);
    assert.equal(first.input_manifest_sha256, second.input_manifest_sha256);
    const active = executeExternalDesignScript(f.input);
    await assert.rejects(() => executeExternalDesignScript(f.input), /already has an active/);
    await active;
    await assert.doesNotReject(() => executeExternalDesignScript(f.input));
  } finally { await f.dispose(); }
});

test("interpreter replacement and capability mismatch cannot authorize execution", async () => {
  const badInterpreter = await fixture();
  try {
    const backend = createAgentdDesignExecution({ ...badInterpreter.configuration, pythonSha256: "0".repeat(64) });
    await assert.rejects(() => executeExternalDesignScript({ ...badInterpreter.input, backend }), /interpreter digest mismatch/);
  } finally { await badInterpreter.dispose(); }
  const badCapability = await fixture("response['execution']['capability_sha256']='0'*64");
  try { await assert.rejects(() => executeExternalDesignScript(badCapability.input), /evidence binding/); }
  finally { await badCapability.dispose(); }
});

test("file and aggregate frozen-output budgets are enforced before publication", async () => {
  const f = await fixture("", "", { policy: { ...limits, max_output_file_bytes: 16, max_output_bytes: 32 } });
  try { await assert.rejects(() => executeExternalDesignScript(f.input), /byte envelope/); }
  finally { await f.dispose(); }
  const g = await fixture("", "", { policy: { ...limits, max_output_file_bytes: 32, max_output_bytes: 32 } });
  try { await assert.rejects(() => executeExternalDesignScript({ ...g.input, outputPaths: ["out/a.gds", "out/b.gds"] }), /total size/); }
  finally { await g.dispose(); }
});

test("shared canonical Unicode fixture retains exact Python-compatible request/manifest hashes", async () => {
  const request = JSON.parse(await readFile("test/agent/fixtures/design-execution-unicode-request.json", "utf8"));
  const expected = JSON.parse(await readFile("test/agent/fixtures/design-execution-unicode-hashes.json", "utf8"));
  const manifest = { files: request.files.map(({ data_base64: _ignored, ...file }: { data_base64: string }) => file), root_entry: { size: request.root_entry.size, sha256: request.root_entry.sha256 } };
  assert.equal(designSha256(canonicalDesignJson(manifest)), expected.input_manifest_sha256);
  assert.equal(designSha256(canonicalDesignJson(request)), expected.request_sha256);
  assert.deepEqual(request.files.map((file: { path: string }) => file.path), ["é.py", "Ｚ.txt", "😀.txt"]);
});
