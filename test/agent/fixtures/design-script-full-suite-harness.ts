// Source-instrumented OFFLINE registration harness. It never changes the shipped
// reviewed entry API, installs a real controller, or executes fixture scripts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { designSha256 } from "../../../src/agent/design-script-execution.js";

const exec = promisify(execFile);
export type ScopeScenario = "complete" | "missing-module" | "missing" | "duplicate" | "unmatched" | "preloaded" | "late-import-error" | "late-after-execution" | "stale-after-error";

function extractRegistration(source: string, name: string): string {
  const marker = `registerFullSuiteDesignCase(import.meta.url, ${JSON.stringify(name)},`;
  assert.equal(source.split(marker).length, 2);
  const start = source.indexOf(marker);
  const end = source.indexOf("\n});", start);
  assert.ok(end > start);
  return source.slice(start, end + 4);
}

export async function runSyntheticFullSuiteRegistration(scenario: ScopeScenario) {
  const originalRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), "synthetic-full-suite-scope-"));
  try {
    await cp(path.join(originalRoot, "dist"), path.join(root, "dist"), {
      recursive: true, filter: source => !source.endsWith(".test.js"),
    });
    await symlink(path.join(originalRoot, "node_modules"), path.join(root, "node_modules"), "dir");
    await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
    const directory = path.join(root, "dist", "test", "agent");
    const entry = path.join(directory, "design-script-reviewed-full-suite.js");
    const original = await readFile(entry, "utf8");
    const loaderImport = 'from "../../src/agent/agentd-design-entrypoint.js"';
    assert.equal(original.split(loaderImport).length, 2, "Instrument exactly one fixed-loader import");
    const transformed = original.replace(loaderImport, 'from "./synthetic-reviewed-loader.js"');
    assert.equal(transformed.replace('from "./synthetic-reviewed-loader.js"', loaderImport), original);
    await writeFile(entry, transformed);
    const instrumentation = { originalSha256: designSha256(original), transformedSha256: designSha256(transformed), substitutions: 1 };
    // This helper manufactures matching responses; it does not run Python
    // inputs/root entries, create OS isolation, or authenticate any controller.
    const mutation = `
script=next(base64.b64decode(f['data_base64']).decode() for f in r['files'] if f['path']==r['script_path'])
if r['script_path'] in ('scripts/generate_gds.py','scripts/generate_isolated_gds.py'):
 data=b'root venv gds' if r['script_path']=='scripts/generate_gds.py' else b'isolated gds'
 response.update(stdout='script complete\\n',stderr='root-venv-python-used\\n' if r['script_path']=='scripts/generate_gds.py' else '')
 response['outputs']=[dict(path=p,size=len(data),sha256=sha(data),data_base64=base64.b64encode(data).decode()) for p in r['output_paths']]
elif r['script_path']=='scripts/external_host_canary.py':
 target=json.loads(script.split('target = Path(',1)[1].split(')\\n',1)[0])
 events=[dict(event='private-output-created',path='outputs/external-host-canary.gds'),dict(event='attempt',operation='Path.write_text',target=target),dict(event='caught-error',operation='Path.write_text',target=target,error_type='FileNotFoundError',errno=2,filename=target)]
 diagnostic=''.join('PI_AGENT_EXTERNAL_CANARY_V1 '+json.dumps(e)+'\\n' for e in events)+"FileNotFoundError: [Errno 2] No such file or directory: "+repr(target)+'\\n'
 response.update(status='script_failed',exit_code=1,stdout='',stderr=diagnostic,outputs=[])
 response['execution']['closure']['output_frozen']=False
elif r['script_path']=='probe.py':
 targets=json.loads(script.split('for filename in ',1)[1].split(':\\n',1)[0])
 attempts=[dict(path=p,operation='Path.write_text',denied=True,errno=2,error_type='FileNotFoundError',filename=p) for p in targets]
 data=b'external containment script completed'
 response.update(stdout=json.dumps(dict(started=True,attempts=attempts)),stderr='')
 response['outputs']=[dict(path=p,size=len(data),sha256=sha(data),data_base64=base64.b64encode(data).decode()) for p in r['output_paths']]
elif r['script_path']=='scripts/absolute_parent_write.py':
 target=json.loads(script.split('workspace = Path(',1)[1].split(')\\n',1)[0])+'/package.json'
 response.update(status='script_failed',exit_code=1,stdout='',stderr="FileNotFoundError: [Errno 2] No such file or directory: "+repr(target)+'\\n',outputs=[])
 response['execution']['closure']['output_frozen']=False
else: raise AssertionError('unexpected synthetic request')
`;
    await writeFile(path.join(directory, "synthetic-reviewed-loader.js"), `
import { fixture } from './fixtures/design-execution-fixture.js';
import { appendFile, readFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
export async function loadReviewedAgentdDesignExecution() {
 await appendFile(${JSON.stringify(path.join(root, "loader-count"))}, 'loaded\\n');
 const f=await fixture(${JSON.stringify(mutation)}, ${JSON.stringify(`with open(${JSON.stringify(path.join(root, "requests.jsonl"))},'a') as capture: capture.write(json.dumps(r)+'\\n')`)});
 process.on('exit',()=>rmSync(f.root,{recursive:true,force:true}));
 return f.backend;
}
`);
    const compiledTools = await readFile(path.join(originalRoot, "dist", "test", "agent", "tools.test.js"), "utf8");
    const preflightName = "run_design_script rejects Python scripts when the root venv Python is missing";
    const parentName = "run_design_script cannot mutate absolute parent workspace paths";
    const header = `
import assert from 'node:assert/strict';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os'; import path from 'node:path';
import {captureDesignScriptTestToolFactory,registerFullSuiteOriginalDesignCases,registerFullSuiteDesignCase} from './design-script-reviewed-full-suite.js';
const rootVenvPythonPath=workspace=>path.join(workspace,'.venv','bin','python');
async function writeFakePythonExecutable(filename,lines){await writeFile(filename,[...lines,''].join('\\n'),'utf8');await chmod(filename,0o755);}
const getRunDesignScriptTool=captureDesignScriptTestToolFactory(import.meta.url,()=>{throw new Error('Synthetic harness must never invoke standalone execution');});
`;
    let tools = header + extractRegistration(compiledTools, preflightName) + "\nregisterFullSuiteOriginalDesignCases(import.meta.url,getRunDesignScriptTool);\n";
    if (scenario !== "missing") tools += extractRegistration(compiledTools, parentName);
    if (scenario === "duplicate") tools += "\nregisterFullSuiteOriginalDesignCases(import.meta.url,getRunDesignScriptTool);\n";
    if (scenario === "unmatched") tools += "\nregisterFullSuiteDesignCase(import.meta.url,'stale unsupported registration',{},async()=>{});\n";
    if (scenario === "preloaded") tools = header;
    await writeFile(path.join(directory, "tools.test.js"), tools);
    await cp(path.join(originalRoot, "dist", "test", "agent", "design-script-containment.test.js"), path.join(directory, "design-script-containment.test.js"));
    if (scenario === "missing-module") await rm(path.join(directory, "design-script-containment.test.js"));
    await mkdir(path.join(root, "dist", "test", "zzz", "deep"), { recursive: true });
    await mkdir(path.join(root, "test", "extra", "deep"), { recursive: true });
    const lateFile = path.join(root, "dist", "test", "zzz", "deep", "extra.test.js");
    const stale = `
import assert from 'node:assert/strict'; import test from 'node:test';
import {captureDesignScriptTestToolFactory} from '../../agent/design-script-reviewed-full-suite.js';
test('synthetic extra compiled test and closed inherited registration scope',async()=>{
 await new Promise(resolve=>setTimeout(resolve,1000));
 assert.throws(()=>captureDesignScriptTestToolFactory(import.meta.url,()=>{}),/scope is closed/);
});
`;
    await writeFile(lateFile, stale + (["late-import-error", "late-after-execution", "stale-after-error"].includes(scenario) ? `
import {readFile,writeFile} from 'node:fs/promises';
let earlier='';
const deadline=Date.now()+5000;
do {
 try{earlier=await readFile(${JSON.stringify(path.join(root, "requests.jsonl"))},'utf8');}catch{}
 if(earlier.trim()||${JSON.stringify(scenario)}!=='late-after-execution')break;
 await new Promise(resolve=>setTimeout(resolve,20));
} while(Date.now()<deadline);
await writeFile(${JSON.stringify(path.join(root, "requests-before-late-failure"))},String(earlier.trim()?earlier.trim().split('\\n').length:0));
throw new Error('synthetic late import failure');
` : ""));
    await writeFile(path.join(root, "test", "extra", "deep", "source.test.mjs"), "import test from 'node:test'; test('synthetic extra source MJS test',()=>{});\n");
    let bootstrap = `import {registerReviewedDesignScriptFullSuite} from './dist/test/agent/design-script-reviewed-full-suite.js';\n`;
    if (scenario === "preloaded") bootstrap += "await import('./dist/test/agent/tools.test.js');\n";
    if (scenario === "stale-after-error") bootstrap += "import assert from 'node:assert/strict'; await assert.rejects(()=>registerReviewedDesignScriptFullSuite({}),/synthetic late import failure/);\n";
    else bootstrap += "const inventory=await registerReviewedDesignScriptFullSuite({}); console.log('SYNTHETIC_REGISTRATION_INVENTORY '+JSON.stringify(inventory));\n";
    await writeFile(path.join(root, "entry.mjs"), bootstrap);
    let stdout = "", stderr = "", code = 0;
    try {
      ({ stdout, stderr } = await exec(process.execPath, (scenario === "late-after-execution" ? ["--test-reporter=tap", "entry.mjs"] : ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", "entry.mjs"]), { cwd: root, maxBuffer: 2 * 1024 * 1024, timeout: 30000 }));
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(typeof failure.code, "number", "Synthetic subprocess must terminate normally");
      ({ code, stdout, stderr } = failure);
    }
    let loaderCount = 0;
    try { loaderCount = (await readFile(path.join(root, "loader-count"), "utf8")).trim().split("\n").length; } catch {}
    let requests: { script_path: string }[] = [];
    try { requests = (await readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch {}
    let requestsBeforeLateFailure = 0;
    try { requestsBeforeLateFailure = Number(await readFile(path.join(root, "requests-before-late-failure"), "utf8")); } catch {}
    return { code, stdout, stderr, loaderCount, instrumentation, requests, requestsBeforeLateFailure };
  } finally { await rm(root, { recursive: true, force: true }); }
}
