import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentdDesignExecution, designSha256, type DesignExecutionLimits } from "../../../src/agent/design-script-execution.js";
// These tests use a synthetic controller helper, not a sandbox or authenticated
// controller. Passing this file never qualifies OS isolation or a deployed run.
export const limits: DesignExecutionLimits = {
  max_request_bytes: 65536, max_input_files: 16, max_input_directories: 8,
  max_path_depth: 8, max_path_bytes: 512, max_input_file_bytes: 4096,
  max_input_bytes: 16384, max_output_files: 8, max_output_file_bytes: 4096,
  max_output_bytes: 8192, max_output_chars: 12000,
};
const python = "/usr/bin/python3";
const syntheticHelper = (mutation = "", before = "") => `# TEST-ONLY SYNTHETIC CONTROLLER. NO OS ISOLATION CLAIM.\nimport sys,json,hashlib,base64,os,time\nassert sys.argv[1:]==['--stdio']\nassert 'DESIGN_EXEC_TEST_SECRET' not in os.environ\nr=json.load(sys.stdin)\ndef sha(b): return hashlib.sha256(b).hexdigest()\ndef canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()\n${before}\noutputs=[]\nfor p in r['output_paths']:\n b=('fixture:'+p).encode(); outputs.append(dict(path=p,size=len(b),sha256=sha(b),data_base64=base64.b64encode(b).decode()))\nresponse=dict(protocol=r['protocol'],request_id=r['request_id'],request_sha256=sha(canonical(r)),call_id='a'*32,status='completed',exit_code=0,stdout='synthetic fixture only',stderr='',outputs=outputs,execution=dict(mode='external-agentd',run_id='fixture-run',parent_launch_token='b'*32,capability_sha256='c'*64,input_manifest_sha256=r['input_manifest_sha256'],root_entry_sha256=r['root_entry']['sha256'] if r['root_entry'] else None,boundary=dict(protocol='agentd-design-boundary/1',network='none',write_scope='call-private',nested_userns=False),closure=dict(launcher_reaped=True,descendants_stopped=True,output_frozen=True)))\n${mutation}\nprint(json.dumps(response))\n`;
export async function fixture(mutation = "", before = "", options: { timeout?: number; policy?: DesignExecutionLimits } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "design-contract-test-"));
  const designCodeDir = path.join(root, "design-repo", "design-code");
  const rootVenvPython = path.join(root, ".venv", "bin", "python");
  await mkdir(designCodeDir, { recursive: true });
  await mkdir(path.dirname(rootVenvPython), { recursive: true });
  await writeFile(path.join(designCodeDir, "entry.py"), "raise RuntimeError('MUST NEVER EXECUTE IN THIS TEST')\n");
  await writeFile(rootVenvPython, "#!/bin/sh\necho parent-root-shim\nexit 91\n");
  const helperPath = path.join(root, "synthetic-helper.py");
  const helper = syntheticHelper(mutation, before.replaceAll("$ROOT", root));
  await writeFile(helperPath, helper);
  await chmod(helperPath, 0o400);
  const configuration = { pythonExecutable: await realpath(python), pythonSha256: designSha256(await readFile(python)), helperPath, helperSha256: designSha256(helper), capabilitySha256: "c".repeat(64), limits: options.policy ?? limits, helperTimeoutMs: options.timeout ?? 3000 };
  const backend = createAgentdDesignExecution(configuration);
  const input = { backend, designCodeDir, rootVenvPython, scriptPath: "entry.py", runner: "python" as const, outputPaths: ["out/a.gds"], maxOutputChars: 1000 };
  return { root, designCodeDir, rootVenvPython, helperPath, configuration, backend, input, dispose: () => rm(root, { recursive: true, force: true }) };
}
