import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestOptions } from "node:test";
import type { AgentdDesignExecution, DesignExecutionRequest } from "../../src/agent/design-script-execution.js";
import { createExternalDesignScriptPilotToolFactory, registerReviewedDesignScriptPilot } from "./design-script-reviewed-pilot.js";
import { fixture } from "./fixtures/design-execution-fixture.js";
import { registerOriginalDesignScriptCases, type DesignScriptCaseToolFactory } from "./fixtures/design-script-original-cases.js";

const names = [
  "run_design_script uses the parent root venv Python and ignores nested design-code venvs",
  "run_design_script copies back only declared design-code outputs from an isolated run",
  "run_design_script restores protected wiki paths when a script writes outside design-code",
];

function captureCases(factory: DesignScriptCaseToolFactory) {
  const cases: { name: string; options: TestOptions; run: () => Promise<void> }[] = [];
  registerOriginalDesignScriptCases(factory, (name, options, run) => { cases.push({ name, options, run }); });
  return cases;
}

test("pilot registration preserves exactly the original three names/options without invoking a tool", () => {
  let calls = 0;
  const cases = captureCases(() => { calls++; throw new Error("Registration must not invoke a tool"); });
  assert.deepEqual(cases.map(item => item.name), names);
  assert.equal(new Set(cases.map(item => item.name)).size, 3);
  assert.equal(calls, 0);
  for (const item of cases) {
    assert.deepEqual(item.options, { skip: process.platform === "win32" ? "fake python.exe shell-script shims are not executable on Windows" : false });
    assert.equal(typeof item.run, "function");
  }
});

test("reviewed pilot is opt-in and excluded from default test filename discovery", async () => {
  const entry = new URL("./design-script-reviewed-pilot.js", import.meta.url);
  assert.equal(/\.test\.[cm]?js$/.test(entry.pathname), false);
  const source = await readFile(entry, "utf8");
  assert.doesNotMatch(source, /process\.(?:env|argv)/);
  assert.doesNotMatch(source, /^(?:await\s+)?register(?:OriginalDesignScriptCases|ReviewedDesignScriptPilot)\(/m);
});

test("pilot factory rejects absent, default, forged and cloned external backends", async () => {
  const f = await fixture();
  try {
    for (const backend of [undefined, { mode: "self-sandbox" }, { mode: "external-agentd" }, { ...f.backend }]) {
      assert.throws(() => createExternalDesignScriptPilotToolFactory(backend as AgentdDesignExecution), /explicit external-agentd|Unverified design script backend/);
    }
    assert.equal(typeof createExternalDesignScriptPilotToolFactory(f.backend), "function");
  } finally { await f.dispose(); }
});

test("reviewed pilot rejects invalid independent pins before registering or invoking cases", async () => {
  await assert.rejects(() => registerReviewedDesignScriptPilot({
    pythonPath: "relative/python", pythonSha256: "0".repeat(64),
    helperSha256: "0".repeat(64), capabilitySha256: "0".repeat(64),
  }), /Independent reviewed launch pins are required/);
});

// These tests execute the original JavaScript fixture/assertion callbacks, but
// the helper only manufactures wire responses. It NEVER executes fixture Python
// or proves a protected write, OS boundary, admission, or actual pilot success.
test("synthetic pilot transport exercises shared callback routing and exact root-entry bytes; no scripts run", async () => {
  const f = await fixture(`
assert r['runner']=='python'
script=r['script_path']
if script=='scripts/absolute_leak.py':
 response.update(status='script_failed',exit_code=1,stdout='',stderr='Permission denied: synthetic fixture only',outputs=[])
else:
 assert script in ('scripts/generate_gds.py','scripts/generate_isolated_gds.py')
 data=b'root venv gds' if script=='scripts/generate_gds.py' else b'isolated gds'
 response.update(stdout='script complete\\n',stderr='root-venv-python-used\\n' if script=='scripts/generate_gds.py' else '')
 response['outputs']=[dict(path=p,size=len(data),sha256=sha(data),data_base64=base64.b64encode(data).decode()) for p in r['output_paths']]
`, `with open('$ROOT/pilot-requests.jsonl','a') as capture: capture.write(json.dumps(r)+'\\n')`);
  try {
    const cases = captureCases(createExternalDesignScriptPilotToolFactory(f.backend));
    assert.deepEqual(cases.map(item => item.name), names);
    for (const item of cases) await item.run();
    const requests: DesignExecutionRequest[] = (await readFile(path.join(f.root, "pilot-requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(requests.map(item => item.script_path), ["scripts/generate_gds.py", "scripts/generate_isolated_gds.py", "scripts/absolute_leak.py"]);
    assert.deepEqual(requests.map(item => item.output_paths), [["outputs/from-root-venv.gds"], ["outputs/isolated.gds"], ["outputs/absolute-leak.gds"]]);
    assert.equal(Buffer.from(requests[0]!.root_entry!.data_base64, "base64").toString(), '#!/bin/sh\necho root-venv-python-used >&2\nexec python3 "$@"\n');
    for (const request of requests.slice(1)) {
      assert.equal(Buffer.from(request.root_entry!.data_base64, "base64").toString(), '#!/bin/sh\nexec python3 "$@"\n');
    }
    const nested = requests[0]!.files.find(file => file.path === ".venv/bin/python")!;
    assert.equal(Buffer.from(nested.data_base64, "base64").toString(), '#!/bin/sh\necho nested-venv-python-used >&2\nexec python3 "$@"\n');
    const absoluteScript = requests[2]!.files.find(file => file.path === "scripts/absolute_leak.py")!;
    assert.match(Buffer.from(absoluteScript.data_base64, "base64").toString(), /workspace = Path\(".+pi-agent-tools-[^"]+"\)/);
  } finally { await f.dispose(); }
});

test("unchanged protected-write assertion rejects ENOENT, startup failure, generic failure and false success", async () => {
  for (const error of [
    new Error("FileNotFoundError: [Errno 2] No such file or directory: knowledge-base/pages"),
    new Error("bwrap: Creating new namespace failed: Operation not permitted"),
    new Error("environment_unverified: helper did not start"),
    new Error("script failed"),
    undefined,
  ]) {
    const cases = captureCases(() => ({ execute: async () => { if (error) throw error; return { details: { status: "completed" } }; } }));
    await assert.rejects(() => cases[2]!.run(), { code: "ERR_ASSERTION" });
  }
});

test("external pilot factory does not fall back when its synthetic helper rejects the environment", async () => {
  const f = await fixture("response.update(status='environment_unverified',exit_code=None,stdout='',stderr='synthetic unavailable environment',outputs=[])");
  try {
    const cases = captureCases(createExternalDesignScriptPilotToolFactory(f.backend));
    await assert.rejects(() => cases[0]!.run(), /external-agentd environment_unverified/);
  } finally { await f.dispose(); }
});
