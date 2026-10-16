import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createExternalDesignScriptPilotToolFactory } from "./design-script-reviewed-pilot.js";
import { fixture } from "./fixtures/design-execution-fixture.js";
import { createFullSuiteMappingLedger, discoverFullSuiteTestFiles, fullSuiteCaseMapping } from "./fixtures/design-script-full-suite-inventory.js";
import { externalContainmentCaseName, registerExternalContainmentCase } from "./fixtures/design-script-external-containment-case.js";
import { createExternalParentWriteGuard } from "./fixtures/design-script-parent-write-guard.js";
import { runSyntheticFullSuiteRegistration, type ScopeScenario } from "./fixtures/design-script-full-suite-harness.js";
import type { DesignScriptCaseToolFactory } from "./fixtures/design-script-original-cases.js";

const exec = promisify(execFile);
const mappedFiles = [...new Set(fullSuiteCaseMapping.map(item => item.file))];
const syntheticContainmentResponse = `
script=next(base64.b64decode(f['data_base64']).decode() for f in r['files'] if f['path']==r['script_path'])
targets=json.loads(script.split('for filename in ',1)[1].split(':\\n',1)[0])
attempts=[dict(path=p,operation='Path.write_text',denied=True,errno=2,error_type='FileNotFoundError',filename=p) for p in targets]
data=b'external containment script completed'
response.update(stdout=json.dumps(dict(started=True,attempts=attempts)),stderr='')
response['outputs']=[dict(path=p,size=len(data),sha256=sha(data),data_base64=base64.b64encode(data).decode()) for p in r['output_paths']]
`;
const syntheticParentResponse = `
script=next(base64.b64decode(f['data_base64']).decode() for f in r['files'] if f['path']==r['script_path'])
workspace=json.loads(script.split('workspace = Path(',1)[1].split(')\\n',1)[0])
target=workspace+'/package.json'
response.update(status='script_failed',exit_code=1,stdout='',stderr="FileNotFoundError: [Errno 2] No such file or directory: "+repr(target)+'\\n',outputs=[])
response['execution']['closure']['output_frozen']=False
`;

async function tempInventory() {
  const root = await mkdtemp(path.join(tmpdir(), "full-suite-inventory-"));
  await mkdir(path.join(root, "test"));
  for (const file of mappedFiles) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), "// fixture\n"); }
  return root;
}

function containmentCase(factory: DesignScriptCaseToolFactory) {
  const cases: { name: string; run: () => Promise<void> }[] = [];
  registerExternalContainmentCase(factory, (name, _options, run) => { cases.push({ name, run }); });
  assert.deepEqual(cases.map(item => item.name), [externalContainmentCaseName]);
  return cases[0]!.run;
}

async function parentFixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), "full-suite-parent-"));
  const project = path.join(workspace, "design-repo", "design-code");
  await mkdir(path.join(project, "scripts"), { recursive: true });
  await mkdir(path.join(workspace, ".venv", "bin"), { recursive: true });
  await writeFile(path.join(workspace, ".venv", "bin", "python"), '#!/bin/sh\nexec python3 "$@"\n');
  await chmod(path.join(workspace, ".venv", "bin", "python"), 0o755);
  await writeFile(path.join(workspace, "package.json"), '{"name":"protected"}\n');
  await writeFile(path.join(project, "pyproject.toml"), '[project]\nname = "pi-chip-design"\n');
  await writeFile(path.join(project, "scripts", "absolute_parent_write.py"), [
    "from pathlib import Path", `workspace = Path(${JSON.stringify(workspace)})`,
    "(workspace / 'package.json').write_text('{\"name\":\"mutated\"}\\n')", "",
  ].join("\n"));
  return { workspace, args: { scriptPath: "design-repo/design-code/scripts/absolute_parent_write.py", runner: "python" as const }, dispose: () => rm(workspace, { recursive: true, force: true }) };
}

// All helpers manufacture response bytes; no Python fixture script is executed.
test("full-suite inventory recursively includes candidate-added compiled and source tests", async () => {
  const root = await tempInventory();
  try {
    for (const file of ["dist/test/new/deeper/extra.test.js", "test/new/deeper/extra.test.mjs", "test/browser-extension/browser.test.mjs", "dist/test/ignored.js", "test/ignored.ts"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), file);
    }
    const files = await discoverFullSuiteTestFiles(root);
    assert.deepEqual(files.map(item => item.path), [...mappedFiles, "dist/test/new/deeper/extra.test.js", "test/new/deeper/extra.test.mjs", "test/browser-extension/browser.test.mjs"].sort());
    assert.ok(files.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.ok(Object.isFrozen(files) && files.every(Object.isFrozen));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("full-suite inventory rejects missing modules, symlinks and duplicate inode aliases", async () => {
  for (const kind of ["missing", "symlink-file", "symlink-dir", "hardlink"]) {
    const root = await tempInventory();
    try {
      if (kind === "missing") await rm(path.join(root, mappedFiles[0]!));
      if (kind === "symlink-file") await symlink(path.join(root, mappedFiles[0]!), path.join(root, "test", "alias.test.mjs"));
      if (kind === "symlink-dir") await symlink(path.join(root, "dist", "test"), path.join(root, "test", "alias"));
      if (kind === "hardlink") await link(path.join(root, mappedFiles[0]!), path.join(root, "test", "alias.test.mjs"));
      await assert.rejects(() => discoverFullSuiteTestFiles(root), /Missing mapped|Symlink|Duplicate test file identity/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("full-suite ledger requires four mapped cases plus parent-write and missing-root coverage exactly once", () => {
  const ledger = createFullSuiteMappingLedger(mappedFiles);
  assert.equal(fullSuiteCaseMapping.filter(item => !item.kind.startsWith("unchanged-")).length, 4);
  assert.throws(() => ledger.finish(), /Missing design test registrations/);
  assert.throws(() => ledger.claim(mappedFiles[0]!, "stale unsupported case"), /Unmatched/);
  assert.throws(() => ledger.claim("dist/test/wrong.test.js", fullSuiteCaseMapping[0]!.original), /Unmatched/);
  for (const item of fullSuiteCaseMapping) ledger.claim(item.file, item.original);
  assert.throws(() => ledger.claim(fullSuiteCaseMapping[0]!.file, fullSuiteCaseMapping[0]!.original), /Duplicate/);
  assert.deepEqual(ledger.finish(), fullSuiteCaseMapping);
  assert.throws(() => createFullSuiteMappingLedger([...mappedFiles, mappedFiles[0]!]), /Duplicate/);
});

test("fixed full-suite entry rejects invalid pins in a fresh process before registration", async () => {
  const source = await readFile(new URL("./design-script-reviewed-full-suite.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.(?:env|argv)/);
  assert.doesNotMatch(source, /^(?:await\s+)?registerReviewedDesignScriptFullSuite\(/m);
  const url = new URL("./design-script-reviewed-full-suite.js", import.meta.url).href;
  const code = `import assert from 'node:assert/strict'; const {registerReviewedDesignScriptFullSuite:run}=await import(${JSON.stringify(url)}); await assert.rejects(()=>run({pythonPath:'relative',pythonSha256:'0'.repeat(64),helperSha256:'0'.repeat(64),capabilitySha256:'0'.repeat(64)}), /Independent reviewed launch pins/);`;
  await assert.rejects(() => exec(process.execPath, ["--input-type=module", "-e", code]), error => {
    assert.match((error as { stdout: string }).stdout, /reviewed full-suite registration failed/);
    return true;
  });
});

test("synthetic external containment preserves all three attempted host targets and declared output", async () => {
  const f = await fixture(syntheticContainmentResponse);
  try { await containmentCase(createExternalDesignScriptPilotToolFactory(f.backend))(); }
  finally { await f.dispose(); }
});

test("external containment rejects missing, wrong, reordered, readonly-errno and false-success evidence", async () => {
  for (const mutation of [
    "attempts.pop()", "attempts[0]['path']='/wrong'", "attempts.reverse()", "attempts[1]['errno']=13",
    "attempts[2]['denied']=False", "attempts[0]['operation']='mkdir'", "attempts[0]['filename']='/wrong'", "attempts[0]['error_type']='PermissionError'",
  ]) {
    const f = await fixture(syntheticContainmentResponse + "\n" + mutation + "\nresponse['stdout']=json.dumps(dict(started=True,attempts=attempts))");
    try { await assert.rejects(containmentCase(createExternalDesignScriptPilotToolFactory(f.backend)), { code: "ERR_ASSERTION" }); }
    finally { await f.dispose(); }
  }
});

test("external containment rejects startup errors, no-start marker, wrong output and changed original bytes", async () => {
  for (const mutation of [
    "response.update(status='environment_unverified',exit_code=None,stdout='',stderr='bwrap unavailable',outputs=[])",
    "response['stdout']=json.dumps(dict(started=False,attempts=attempts))",
    "data=b'wrong';response['outputs']=[dict(path=p,size=len(data),sha256=sha(data),data_base64=base64.b64encode(data).decode()) for p in r['output_paths']]",
  ]) {
    const f = await fixture(syntheticContainmentResponse + "\n" + mutation);
    try { await assert.rejects(containmentCase(createExternalDesignScriptPilotToolFactory(f.backend))); }
    finally { await f.dispose(); }
  }
  const f = await fixture(syntheticContainmentResponse);
  try {
    const factory = createExternalDesignScriptPilotToolFactory(f.backend);
    await assert.rejects(containmentCase(workspace => {
      const tool = factory(workspace);
      return { execute: async (...args) => { const result = await tool.execute(...args); await writeFile(path.join(workspace, "package.json"), "changed"); return result; } };
    }), { code: "ERR_ASSERTION" });
  } finally { await f.dispose(); }
});

test("synthetic parent-write postcondition requires one exact bound raw script failure", async () => {
  const f = await fixture(syntheticParentResponse);
  const p = await parentFixture();
  try {
    const guard = createExternalParentWriteGuard(createExternalDesignScriptPilotToolFactory(f.backend));
    await guard.run(async () => {
      await assert.rejects(() => guard.factory(p.workspace).execute("call-run-design-script-parent-write", p.args, undefined), /Read-only file system|Permission denied|bwrap|run_design_script/);
    });
    assert.equal(await readFile(path.join(p.workspace, "package.json"), "utf8"), '{"name":"protected"}\n');
  } finally { await f.dispose(); await p.dispose(); }
});

test("parent-write postcondition cannot be swallowed by the unchanged broad regex callback", async () => {
  for (const mutation of [
    "response.update(status='environment_unverified',exit_code=None,stderr='bwrap failed before startup')",
    "response['stderr']='run_design_script generic failure'", "response['exit_code']=2", "response['exit_code']=0", "response['exit_code']=None",
    "response['execution']['closure']['launcher_reaped']=False", "response['execution']['closure']['descendants_stopped']=False",
    "response['execution']['closure']['output_frozen']=True", "response['stderr']=response['stderr'].replace('package.json','wrong.json')",
    "response['execution']['input_manifest_sha256']='0'*64", "response['execution']['root_entry_sha256']='0'*64",
  ]) {
    const f = await fixture(syntheticParentResponse + "\n" + mutation);
    const p = await parentFixture();
    try {
      const guard = createExternalParentWriteGuard(createExternalDesignScriptPilotToolFactory(f.backend));
      // Stronger than the legacy regex: swallow EVERY tool error deliberately.
      await assert.rejects(() => guard.run(async () => { try { await guard.factory(p.workspace).execute("call-run-design-script-parent-write", p.args, undefined); } catch {} }), /did not prove exactly one/);
    } finally { await f.dispose(); await p.dispose(); }
  }
});

test("parent-write guard rejects absent, duplicated and out-of-case execution", async () => {
  const f = await fixture(syntheticParentResponse);
  const p = await parentFixture();
  try {
    const guard = createExternalParentWriteGuard(createExternalDesignScriptPilotToolFactory(f.backend));
    await assert.rejects(() => guard.run(async () => {}), /did not prove exactly one/);
    await assert.rejects(() => guard.factory(p.workspace).execute("call-run-design-script-parent-write", p.args, undefined), /active case/);
    await assert.rejects(() => guard.run(async () => {
      for (let i = 0; i < 2; i++) await assert.rejects(() => guard.factory(p.workspace).execute("call-run-design-script-parent-write", p.args, undefined));
    }), /did not prove exactly one/);
    for (const file of [".venv/bin/python", "design-repo/design-code/pyproject.toml"]) {
      const target = path.join(p.workspace, file);
      const original = await readFile(target);
      await writeFile(target, file.endsWith("python") ? '#!/bin/sh\necho "run_design_script fake traceback" >&2\nexit 1\n' : '[project]\nname="replaced"\n');
      await assert.rejects(() => guard.run(async () => {
        try { await guard.factory(p.workspace).execute("call-run-design-script-parent-write", p.args, undefined); } catch {}
      }), /did not prove exactly one/);
      await writeFile(target, original);
    }
  } finally { await f.dispose(); await p.dispose(); }
});


test("source-instrumented synthetic full-suite entry imports every extra file and closes inherited scopes", async context => {
  const result = await runSyntheticFullSuiteRegistration("complete");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.loaderCount, 1);
  assert.equal(result.instrumentation.substitutions, 1);
  context.diagnostic("SYNTHETIC_LOADER_INSTRUMENTATION " + JSON.stringify(result.instrumentation));
  assert.notEqual(result.instrumentation.originalSha256, result.instrumentation.transformedSha256);
  const line = result.stdout.split("\n").find(line => line.includes("SYNTHETIC_REGISTRATION_INVENTORY "))!;
  const inventory = JSON.parse(line.split("SYNTHETIC_REGISTRATION_INVENTORY ")[1]!);
  assert.deepEqual(inventory.files.map((item: { path: string }) => item.path), [
    ...mappedFiles, "dist/test/zzz/deep/extra.test.js", "test/extra/deep/source.test.mjs",
  ].sort());
  assert.deepEqual(inventory.mapping, fullSuiteCaseMapping);
  assert.deepEqual(result.requests.map(request => request.script_path).sort(), [
    "scripts/generate_gds.py", "scripts/generate_isolated_gds.py", "scripts/external_host_canary.py", "probe.py", "scripts/absolute_parent_write.py",
  ].sort());
  context.diagnostic("SYNTHETIC_SUBMITTED_REQUESTS " + JSON.stringify(result.requests.map(request => request.script_path)));
  assert.match(result.stdout, /# tests 8/);
  assert.match(result.stdout, /# pass 8/);
  assert.match(result.stdout, /# skipped 0/);
});

test("source-instrumented actual registration rejects missing, duplicate, stale, preloaded and late failed imports", async context => {
  const scenarios: [ScopeScenario, RegExp][] = [
    ["missing-module", /Missing mapped test module/], ["missing", /Missing design test registrations/], ["duplicate", /Duplicate design test registration/],
    ["unmatched", /Unmatched design test registration/], ["preloaded", /already registered/],
    ["late-import-error", /synthetic late import failure/], ["late-after-execution", /synthetic late import failure/],
  ];
  for (const [scenario, expected] of scenarios) {
    const result = await runSyntheticFullSuiteRegistration(scenario);
    assert.notEqual(result.code, 0, scenario + result.stdout + result.stderr);
    context.diagnostic("SYNTHETIC_NEGATIVE_ENTRY " + JSON.stringify({ scenario, exitCode: result.code, loaderCount: result.loaderCount, requestsBeforeLateFailure: result.requestsBeforeLateFailure }));
    assert.match(result.stdout + result.stderr, expected);
    assert.doesNotMatch(result.stdout, /SYNTHETIC_REGISTRATION_INVENTORY/);
    assert.equal(result.loaderCount, scenario === "preloaded" ? 0 : 1);
    if (scenario === "late-after-execution") assert.ok(result.requestsBeforeLateFailure > 0, "Require actual synthetic calls before the late import fails");
  }
});

test("source-instrumented failed import still closes the inherited registration scope", async () => {
  const result = await runSyntheticFullSuiteRegistration("stale-after-error");
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /not ok .*reviewed full-suite registration failed/);
  assert.match(result.stdout, /ok .*closed inherited registration scope/);
  assert.doesNotMatch(result.stdout, /SYNTHETIC_REGISTRATION_INVENTORY/);
});
