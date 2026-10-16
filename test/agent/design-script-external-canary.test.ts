import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestOptions } from "node:test";
import { executeExternalDesignScript, getDesignExecutionFailureEvidence, type DesignExecutionRequest } from "../../src/agent/design-script-execution.js";
import { createExternalDesignScriptPilotToolFactory } from "./design-script-reviewed-pilot.js";
import { fixture } from "./fixtures/design-execution-fixture.js";
import { externalCanaryCaseName, externalCanaryMarker, externalCanaryOutputPath, externalCanaryRelativePath, externalCanaryScript, externalCanaryScriptPath, registerExternalCanaryCase, registerExternalDesignScriptCases } from "./fixtures/design-script-external-canary-case.js";
import { type DesignScriptCaseToolFactory, type OriginalDesignScriptCaseRegistrar } from "./fixtures/design-script-original-cases.js";

// Every helper below is synthetic. It manufactures transport responses and
// NEVER executes the fixture script or establishes an OS isolation result.
const syntheticCanaryResponse = `
script=next(base64.b64decode(f['data_base64']).decode() for f in r['files'] if f['path']==r['script_path'])
target=json.loads(script.split('target = Path(',1)[1].split(')\\n',1)[0])
events=[dict(event='private-output-created',path='outputs/external-host-canary.gds'),dict(event='attempt',operation='Path.write_text',target=target),dict(event='caught-error',operation='Path.write_text',target=target,error_type='FileNotFoundError',errno=2,filename=target)]
def diagnostics(items): return ''.join('PI_AGENT_EXTERNAL_CANARY_V1 '+json.dumps(item)+'\\n' for item in items)+"FileNotFoundError: [Errno 2] No such file or directory: "+repr(target)+'\\n'
response.update(status='script_failed',exit_code=1,stdout='',stderr=diagnostics(events),outputs=[])
response['execution']['closure'].update(launcher_reaped=True,descendants_stopped=True,output_frozen=False)
`;

function captureCases(registration: (factory: DesignScriptCaseToolFactory, registrar: OriginalDesignScriptCaseRegistrar) => void, factory: DesignScriptCaseToolFactory) {
  const cases: { name: string; options: TestOptions; run: () => Promise<void> }[] = [];
  registration(factory, (name, options, run) => { cases.push({ name, options, run }); });
  return cases;
}

async function runSyntheticCanary(mutation = "", beforeExecute?: (workspace: string) => Promise<void>, afterFailure?: (workspace: string, error: unknown) => Promise<void>): Promise<void> {
  const f = await fixture(syntheticCanaryResponse + mutation);
  try {
    const factory = createExternalDesignScriptPilotToolFactory(f.backend);
    const cases = captureCases(registerExternalCanaryCase, workspace => {
      const tool = factory(workspace);
      return { execute: async (...args) => {
        await beforeExecute?.(workspace);
        try { return await tool.execute(...args); }
        catch (error) { await afterFailure?.(workspace, error); throw error; }
      } };
    });
    await cases[0]!.run();
  } finally { await f.dispose(); }
}

test("external canary registration explicitly keeps two originals and adds one distinct boundary case", () => {
  let calls = 0;
  const cases = captureCases(registerExternalDesignScriptCases, () => { calls++; throw new Error("No import-time invocation"); });
  assert.deepEqual(cases.map(item => item.name), [
    "run_design_script uses the parent root venv Python and ignores nested design-code venvs",
    "run_design_script copies back only declared design-code outputs from an isolated run",
    externalCanaryCaseName,
  ]);
  assert.equal(calls, 0);
  for (const item of cases) assert.deepEqual(item.options, { skip: process.platform === "win32" ? "fake python.exe shell-script shims are not executable on Windows" : false });
});

test("external canary script performs the exact direct write with no preliminary protected mkdir", () => {
  const target = "/tmp/disposable-host/knowledge-base/pages/external-host-canary.md";
  const source = externalCanaryScript(target);
  assert.equal(source.split(".mkdir(").length - 1, 1);
  assert.ok(source.includes("Path('../outputs').mkdir(exist_ok=True)"));
  assert.ok(source.includes(`target = Path(${JSON.stringify(target)})`));
  assert.ok(source.includes("target.write_text('# unauthorized canary replacement\\n', encoding='utf-8')"));
  assert.ok(source.includes("except OSError as error:"));
  assert.ok(source.includes("    raise\n"));
  assert.ok(source.indexOf("write_bytes") < source.indexOf("target.write_text"));
  assert.throws(() => externalCanaryScript("relative/path"), { code: "ERR_ASSERTION" });
});

test("synthetic canary transport exercises request binding and assertions without executing scripts", async () => {
  const f = await fixture(syntheticCanaryResponse, "with open('$ROOT/canary-request.json','w') as capture: json.dump(r,capture)");
  try {
    const cases = captureCases(registerExternalCanaryCase, createExternalDesignScriptPilotToolFactory(f.backend));
    await cases[0]!.run();
    const request = JSON.parse(await readFile(path.join(f.root, "canary-request.json"), "utf8")) as DesignExecutionRequest;
    assert.equal(request.script_path, externalCanaryScriptPath);
    assert.deepEqual(request.output_paths, [externalCanaryOutputPath]);
    assert.equal(Buffer.from(request.root_entry!.data_base64, "base64").toString(), '#!/bin/sh\nexec python3 "$@"\n');
    const script = Buffer.from(request.files.find(file => file.path === externalCanaryScriptPath)!.data_base64, "base64").toString();
    const target = JSON.parse(script.split("target = Path(")[1]!.split(")\n")[0]!) as string;
    assert.equal(script, externalCanaryScript(target));
    assert.ok(target.endsWith(`/${externalCanaryRelativePath}`));
  } finally { await f.dispose(); }
});

test("external canary rejects generic, setup, startup and unrelated ENOENT diagnostics", async () => {
  for (const mutation of [
    "response['stderr']='FileNotFoundError: [Errno 2] No such file or directory: knowledge-base/pages'",
    "response['stderr']='bwrap: Creating new namespace failed: Operation not permitted'",
    "response['stderr']='script failed'",
    "response['stderr']='FileNotFoundError: [Errno 2] No such file or directory: '+repr(target)",
    "response['stderr']=diagnostics(events[:1])",
    "response.update(stdout=response['stderr'],stderr='')",
    "response['stdout']='unexpected stdout'",
    "response.update(status='environment_unverified',exit_code=None)",
  ]) await assert.rejects(() => runSyntheticCanary(mutation), { code: "ERR_ASSERTION" });
});

test("external canary requires exact ordered operation, target, errno and uncaught-error records", async () => {
  for (const mutation of [
    "events[1]['target']+='.wrong'",
    "events[2]['target']+='.wrong'",
    "events[2]['filename']+='.wrong'",
    "events[1]['operation']='Path.mkdir'",
    "events[2]['operation']='Path.mkdir'",
    "events[2]['errno']=13",
    "events[2]['error_type']='PermissionError'",
    "events.pop(1)",
    "events.pop()",
    "events.append(events[-1])",
    "events[1]['extra']='unreviewed'",
    "events.reverse()",
    "events.append(dict(event='unexpected-success',operation='Path.write_text',target=target))",
  ]) await assert.rejects(() => runSyntheticCanary(mutation + "\nresponse['stderr']=diagnostics(events)"), { code: "ERR_ASSERTION" });
  for (const mutation of [
    "response['stderr']=response['stderr'].split('FileNotFoundError: [Errno 2]')[0]",
    "response['stderr']+='PI_AGENT_EXTERNAL_CANARY_V1 {bad json\\n'",
  ]) await assert.rejects(() => runSyntheticCanary(mutation), { code: "ERR_ASSERTION" });
});

test("external canary rejects raw zero/null exits, wrong states and unclosed failed executions", async () => {
  for (const mutation of [
    "response['exit_code']=0", "response['exit_code']=None", "response['exit_code']=2",
    "response['status']='timed_out'", "response['status']='input_rejected'",
    "response['execution']['closure']['launcher_reaped']=False",
    "response['execution']['closure']['descendants_stopped']=False",
    "response['execution']['closure']['output_frozen']=True",
  ]) await assert.rejects(() => runSyntheticCanary(mutation), { code: "ERR_ASSERTION" });
});

test("external canary rejects false success and failed-response output publication", async () => {
  const output = "response['outputs']=[dict(path=p,size=1,sha256=sha(b'x'),data_base64=base64.b64encode(b'x').decode()) for p in r['output_paths']]";
  await assert.rejects(() => runSyntheticCanary(output), { code: "ERR_ASSERTION" });
  await assert.rejects(() => runSyntheticCanary(output + "\nresponse.update(status='completed',exit_code=0)\nresponse['execution']['closure']['output_frozen']=True"), { code: "ERR_ASSERTION" });
  await assert.rejects(() => runSyntheticCanary("", undefined, async workspace => {
    const outputFile = path.join(workspace, "design-repo", "design-code", externalCanaryOutputPath);
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, "unexpected published bytes");
  }), { code: "ERR_ASSERTION" });
});

test("external canary detects changed protected bytes, metadata and new protected files", async () => {
  for (const mutate of [
    (workspace: string) => writeFile(path.join(workspace, externalCanaryRelativePath), "changed"),
    (workspace: string) => chmod(path.join(workspace, externalCanaryRelativePath), 0o400),
    (workspace: string) => writeFile(path.join(workspace, "knowledge-base", "pages", "new.md"), "new"),
  ]) await assert.rejects(() => runSyntheticCanary("", mutate), { code: "ERR_ASSERTION" });
});

test("external canary requires the exact request-bound script, manifest and root entry", async () => {
  for (const mutate of [
    async (workspace: string) => {
      const script = path.join(workspace, "design-repo", "design-code", externalCanaryScriptPath);
      await writeFile(script, (await readFile(script, "utf8")) + "# changed script bytes\n");
    },
    (workspace: string) => writeFile(path.join(workspace, "design-repo", "design-code", "extra.txt"), "changed manifest"),
    (workspace: string) => writeFile(path.join(workspace, ".venv", "bin", "python"), '#!/bin/sh\n# changed entry\nexec python3 "$@"\n'),
  ]) await assert.rejects(() => runSyntheticCanary("", mutate), { code: "ERR_ASSERTION" });
});

test("validated failure evidence is immutable, preserves exact messages and cannot be copied or forged", async () => {
  const f = await fixture("response.update(status='script_failed',exit_code=1,stdout='before',stderr='failed',outputs=[])\nresponse['execution']['closure']['output_frozen']=False");
  try {
    let failure: Error | undefined;
    await assert.rejects(() => executeExternalDesignScript(f.input), error => { assert.ok(error instanceof Error); failure = error; return true; });
    assert.ok(failure);
    assert.equal(failure.message, "run_design_script external-agentd script_failed: stdout:\nbefore\nstderr:\nfailed");
    const evidence = getDesignExecutionFailureEvidence(failure)!;
    assert.ok(evidence);
    assert.ok(Object.isFrozen(failure) && Object.isFrozen(evidence) && Object.isFrozen(evidence.closure));
    assert.equal(evidence.status, "script_failed");
    assert.equal(evidence.exitCode, 1);
    assert.equal(evidence.scriptPath, "entry.py");
    assert.match(evidence.requestId, /^[a-f0-9]{32}$/);
    assert.match(evidence.requestSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => Object.assign(failure!, { message: "replaced diagnostics" }), TypeError);
    assert.throws(() => Object.assign(evidence, { exitCode: 0 }), TypeError);
    assert.throws(() => Object.assign(evidence.closure, { launcherReaped: false }), TypeError);
    for (const forged of [undefined, {}, new Error(failure.message), Object.assign(new Error(failure.message), { failure: evidence }), { ...failure, evidence }]) {
      assert.equal(getDesignExecutionFailureEvidence(forged), undefined);
    }
  } finally { await f.dispose(); }
});

test("invalid response bindings and failed outputs never acquire failure evidence", async () => {
  for (const mutation of [
    "response['request_sha256']='0'*64",
    "response['execution']['input_manifest_sha256']='0'*64",
    "response['execution']['root_entry_sha256']='0'*64",
    "response['execution']['closure']['launcher_reaped']='true'",
    "response['outputs']=[dict(path='out/a.gds',size=1,sha256=sha(b'x'),data_base64='eA==')]",
  ]) {
    const f = await fixture("response.update(status='script_failed',exit_code=1,stdout='',stderr='failed',outputs=[])\n" + mutation);
    try {
      await assert.rejects(() => executeExternalDesignScript(f.input), error => {
        assert.ok(error instanceof Error);
        assert.equal(getDesignExecutionFailureEvidence(error), undefined);
        return true;
      });
    } finally { await f.dispose(); }
  }
});

test("external canary rejects convincing diagnostics on unbranded or copied errors", async () => {
  const cases = captureCases(registerExternalCanaryCase, workspace => ({ execute: async () => {
    const target = path.join(workspace, externalCanaryRelativePath);
    const records = [
      { event: "private-output-created", path: externalCanaryOutputPath },
      { event: "attempt", operation: "Path.write_text", target },
      { event: "caught-error", operation: "Path.write_text", target, error_type: "FileNotFoundError", errno: 2, filename: target },
    ];
    throw Object.assign(new Error("run_design_script external-agentd script_failed: stderr:\n" + records.map(record => externalCanaryMarker + JSON.stringify(record)).join("\n") + `\nFileNotFoundError: [Errno 2] No such file or directory: '${target}'`), { status: "script_failed", exitCode: 1 });
  } }));
  await assert.rejects(() => cases[0]!.run(), { code: "ERR_ASSERTION" });
  await assert.rejects(() => runSyntheticCanary("", undefined, async (_workspace, error) => {
    assert.ok(error instanceof Error);
    throw Object.assign(new Error(error.message), { ...error, evidence: getDesignExecutionFailureEvidence(error) });
  }), { code: "ERR_ASSERTION" });
});
