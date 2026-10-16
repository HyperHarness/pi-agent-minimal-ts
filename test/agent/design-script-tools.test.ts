import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTools, createToolsForBoundary } from "../../src/agent/tools.js";
import { fixture } from "./fixtures/design-execution-fixture.js";

// Project-seam tests use a synthetic helper. They do not test OS containment.
test("createTools forwards only trusted external backend and preserves root venv command/result", async () => {
  const f = await fixture("response['stderr']=base64.b64decode(r['root_entry']['data_base64']).decode()");
  try {
    await writeFile(path.join(f.designCodeDir, "pyproject.toml"), '[project]\nname="fixture"\n');
    await mkdir(path.join(f.designCodeDir, ".venv", "bin"), { recursive: true });
    await writeFile(path.join(f.designCodeDir, ".venv", "bin", "python"), "nested shim must not be selected");
    const tool = createTools(f.root, { toolProfile: "full", designScriptExecution: f.backend }).find(tool => tool.name === "run_design_script")!;
    assert.deepEqual(Object.keys(tool.parameters.properties), ["scriptPath", "runner", "outputPaths", "maxOutputChars"]);
    const result = await tool.execute("test-only-external", { scriptPath: "design-repo/design-code/entry.py", runner: "python", outputPaths: ["design-repo/design-code/out/a.gds"] }, undefined);
    assert.deepEqual(result.details, {
      status: "completed", runner: "python", scriptPath: "design-repo/design-code/entry.py",
      command: "../../.venv/bin/python entry.py", exitCode: 0, stdout: "synthetic fixture only",
      stderr: await readFile(f.rootVenvPython, "utf8"), outputs: [{ path: "design-repo/design-code/out/a.gds", bytes: 17 }]
    });
  } finally { await f.dispose(); }
});

test("external project seam preserves missing parent root venv error despite nested shim", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.designCodeDir, "pyproject.toml"), '[project]\nname="fixture"\n');
    await mkdir(path.join(f.designCodeDir, ".venv", "bin"), { recursive: true });
    await writeFile(path.join(f.designCodeDir, ".venv", "bin", "python"), "nested");
    await rm(f.rootVenvPython);
    const tool = createToolsForBoundary(f.root, "design-agent", { designScriptExecution: f.backend }).find(tool => tool.name === "run_design_script")!;
    await assert.rejects(() => tool.execute("missing-root", { scriptPath: "entry.py", runner: "python" }, undefined), /Root .venv Python was not found/);
  } finally { await f.dispose(); }
});

test("fake AGENTD environment never enables external mode or a direct-exec fallback", async () => {
  const f = await fixture();
  const previous = { PATH: process.env.PATH, AGENTD_DESIGN_EXECUTION: process.env.AGENTD_DESIGN_EXECUTION };
  try {
    await writeFile(path.join(f.designCodeDir, "pyproject.toml"), '[project]\nname="fixture"\n');
    process.env.PATH = "/definitely-no-bwrap";
    process.env.AGENTD_DESIGN_EXECUTION = "external-agentd";
    const tool = createTools(f.root, { toolProfile: "full" }).find(tool => tool.name === "run_design_script")!;
    await assert.rejects(() => tool.execute("default-sandbox", { scriptPath: "entry.py", runner: "python", sandbox: "off", mode: "external-agentd" }, undefined), /requires the bwrap sandbox/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.dispose();
  }
});

test("external helper failure does not fall back to available self-sandbox execution", async () => {
  const f = await fixture("response['status']='environment_unverified'; response['outputs']=[]");
  try {
    await writeFile(path.join(f.designCodeDir, "pyproject.toml"), '[project]\nname="fixture"\n');
    const tool = createTools(f.root, { toolProfile: "full", designScriptExecution: f.backend }).find(tool => tool.name === "run_design_script")!;
    await assert.rejects(() => tool.execute("no-fallback", { scriptPath: "entry.py", runner: "python", outputPaths: ["out/a.gds"] }, undefined), /external-agentd environment_unverified/);
    await assert.rejects(() => readFile(path.join(f.designCodeDir, "out", "a.gds")), /ENOENT/);
  } finally { await f.dispose(); }
});

test("programmatic design-agent profile carries trusted backend without a CLI mode switch", async () => {
  const { resolveAgentEntrypointProfile, main } = await import("../../src/agent/agent-cli.js");
  const f = await fixture();
  try {
    await writeFile(path.join(f.designCodeDir, "pyproject.toml"), '[project]\nname="fixture"\n');
    const profile = resolveAgentEntrypointProfile("design-agent", f.root, {} as never, { designScriptExecution: f.backend });
    assert.equal(profile.workerRouting, "none");
    const tool = profile.createTools().find(tool => tool.name === "run_design_script")!;
    const result = await tool.execute("entrypoint-test", { scriptPath: "entry.py", runner: "python", outputPaths: [] }, undefined);
    assert.equal((result.details as { stdout: string }).stdout, "synthetic fixture only");
    assert.throws(() => resolveAgentEntrypointProfile("wiki-agent", f.root, {} as never, { designScriptExecution: f.backend }), /requires the design-agent/);
    await assert.rejects(() => main({ profile: "design-agent", argv: ["--worker-routing", "all"], designScriptExecution: f.backend }), /routed worker/);
  } finally { await f.dispose(); }
});

test("external context workspace change cannot silently recreate default self-sandbox tools", async () => {
  const { runAgentTurn } = await import("../../src/agent/agent-runtime.js");
  const f = await fixture();
  try {
    const tools = createToolsForBoundary(f.root, "design-agent", { designScriptExecution: f.backend });
    await assert.rejects(() => runAgentTurn({ model: {} as never, workspaceDir: `${f.root}/different`, context: { systemPrompt: "test", messages: [], tools }, prompt: "not sent to any model", workerRouting: "none" }), /without fresh trusted tool configuration/);
  } finally { await f.dispose(); }
});

test("reviewed launcher config cannot select its own helper, interpreter or authority pins", async () => {
  const { bindReviewedAgentdClientDocument } = await import("../../src/agent/agentd-design-entrypoint.js");
  const { assertDesignScriptExecution } = await import("../../src/agent/design-script-execution.js");
  const f = await fixture();
  try {
    const pins = { pythonPath: f.configuration.pythonExecutable, pythonSha256: f.configuration.pythonSha256, helperSha256: f.configuration.helperSha256, capabilitySha256: f.configuration.capabilitySha256 };
    const document = { protocol: "agentd-design-exec/1", mode: "external-agentd", pythonPath: pins.pythonPath, helperPath: "/run/agentd-design-client.py", helperSha256: pins.helperSha256, capabilitySha256: pins.capabilitySha256, limits: f.configuration.limits, timeoutSeconds: 120 };
    assert.doesNotThrow(() => assertDesignScriptExecution(bindReviewedAgentdClientDocument(document, pins)));
    for (const change of [{ helperPath: f.helperPath }, { pythonPath: "/tmp/fake-python" }, { helperSha256: "0".repeat(64) }, { capabilitySha256: "0".repeat(64) }, { timeoutSeconds: 121 }, { arbitraryArgv: ["--shell"] }]) {
      assert.throws(() => bindReviewedAgentdClientDocument({ ...document, ...change }, pins), /document/);
    }
  } finally { await f.dispose(); }
});

test("reviewed loader fails closed without matching immutable controller mounts", async () => {
  const { loadReviewedAgentdDesignExecution } = await import("../../src/agent/agentd-design-entrypoint.js");
  const f = await fixture();
  try {
    await assert.rejects(() => loadReviewedAgentdDesignExecution({ pythonPath: f.configuration.pythonExecutable, pythonSha256: f.configuration.pythonSha256, helperSha256: f.configuration.helperSha256, capabilitySha256: f.configuration.capabilitySha256 }), /environment_unverified|does not match independent launch pins/);
  } finally { await f.dispose(); }
});

test("fixed-config reader accepts sealed memfd nlink-zero representation but rejects writable mounts", async () => {
  const { READ_FIXED_CONTROLLER_DOCUMENT } = await import("../../src/agent/agentd-design-entrypoint.js");
  const { execFileSync } = await import("node:child_process");
  // Representation-only test: real memfd/regular descriptors, synthetic mount
  // flags. No mount/namespace is created and this is not an OS qualification.
  const harness = `import os,sys,json,fcntl,tempfile,types
source=sys.stdin.read()
config=os.memfd_create('synthetic-config',os.MFD_ALLOW_SEALING)
os.write(config,b'{"fixture":"sealed-config"}')
fcntl.fcntl(config,fcntl.F_ADD_SEALS,15)
assert os.fstat(config).st_nlink==0
helper=tempfile.TemporaryFile()
# TemporaryFile may use O_TMPFILE (nlink0), so use NamedTemporaryFile for the
# independently pinned file-based helper representation expected by policy.
helper=tempfile.NamedTemporaryFile()
helper.write(b'# fixture helper');helper.flush()
real_open=os.open
ro_config=real_open('/proc/self/fd/'+str(config),os.O_RDONLY)
ro_helper=real_open(helper.name,os.O_RDONLY)
def fixed_open(name,flags,*args):
 if name=='/run/agentd-design-client.json': return os.dup(ro_config)
 if name=='/run/agentd-design-client.py': return os.dup(ro_helper)
 raise AssertionError('unexpected bootstrap path')
os.open=fixed_open
os.fstatvfs=lambda fd:types.SimpleNamespace(f_flag=os.ST_RDONLY if sys.argv[1]=='readonly' else 0)
exec(compile(source,'fixed-bootstrap','exec'))
`;
  const options = { input: READ_FIXED_CONTROLLER_DOCUMENT, encoding: "utf8" as const };
  assert.equal(execFileSync("/usr/bin/python3", ["-I", "-S", "-c", harness, "readonly"], options), '{"fixture":"sealed-config"}');
  assert.throws(() => execFileSync("/usr/bin/python3", ["-I", "-S", "-c", harness, "writable"], { ...options, stdio: ["pipe", "pipe", "pipe"] }), /AGENTD_FIXED_CONFIG_UNVERIFIED/);
});
