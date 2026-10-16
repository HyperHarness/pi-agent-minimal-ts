// Explicit offline interoperability lane; no real external sandbox or endpoint.
// Usage: node scripts/test-design-cross-language.mjs /absolute/agentd/source
import assert from "node:assert/strict";
import { chmod, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { canonicalDesignJson, createAgentdDesignExecution, designSha256, executeExternalDesignScript } from "../dist/src/agent/design-script-execution.js";
import { fixture, limits } from "../dist/test/agent/fixtures/design-execution-fixture.js";

if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw new Error("Supply the explicit absolute agentd source directory; this lane never auto-discovers it");
const agentdSource = await realpath(process.argv[2]);
await readFile(path.join(agentdSource, "agentd/design_execution_supervisor.py"));
const bridge = await readFile(new URL("../test/agent/fixtures/design-execution-python-supervisor.py", import.meta.url), "utf8");
const policy = {
  protocol: "agentd-design-exec/1", limits, max_calls: 4, timeout_seconds: 1,
  runtime: { python: { mode: "fixture-entry" }, klayout: null },
  client: { python: "/opt/fixture/python", helper: "/opt/fixture/helper.py", sha256: "a".repeat(64) },
};
const pins = { "/opt/fixture/python": "b".repeat(64), "/opt/fixture/helper.py": "a".repeat(64) };

for (const scenario of [
  { name: "success", status: "completed", stdout: "输😀", stderr: "错é", cap: 4 },
  { name: "failed mixed Unicode logs", status: "script_failed", stdout: "输😀", stderr: "错é", cap: 4 },
  { name: "failed empty logs", status: "script_failed", stdout: "", stderr: "", cap: 1 },
  { name: "combined log overflow", status: "completed", stdout: "输😀", stderr: "错é", cap: 3 },
]) {
  test(`actual TS/Python supervisor roundtrip: ${scenario.name} (synthetic OS adapters)`, async () => {
    const f = await fixture();
    try {
      const capturePath = path.join(f.root, "wire-capture.json");
      const settings = { ...scenario, agentd_source: agentdSource, capture_path: capturePath, policy, pins };
      const helper = `# TEST-ONLY SYNTHETIC OS ADAPTERS; NEVER A PRODUCTION HELPER\nimport json\nSETTINGS = json.loads(${JSON.stringify(JSON.stringify(settings))})\n${bridge}`;
      await chmod(f.helperPath, 0o600);
      await writeFile(f.helperPath, helper);
      await chmod(f.helperPath, 0o400);
      const backend = createAgentdDesignExecution({ ...f.configuration, helperSha256: designSha256(helper), capabilitySha256: designSha256(canonicalDesignJson(policy)), helperTimeoutMs: 10000 });
      await writeFile(path.join(f.designCodeDir, "😀.txt"), "accent é and astral 😀");
      const outputPaths = ["输出/😀.gds", "out/a.gds"];
      const input = { ...f.input, backend, outputPaths, maxOutputChars: scenario.cap };
      const script = await readFile(path.join(f.designCodeDir, "entry.py"));
      if (scenario.name === "combined log overflow") {
        await assert.rejects(() => executeExternalDesignScript(input), /environment_unverified: trusted helper exited 1/);
        const capture = JSON.parse(await readFile(capturePath, "utf8"));
        assert.match(capture.rejection, /combined request bound/);
        assert.equal(capture.outputs_published, false);
        assert.equal(capture.gate_closed, true);
      } else {
        if (scenario.status === "completed") {
          const result = await executeExternalDesignScript(input);
          assert.equal(result.stdout, scenario.stdout);
          assert.equal(result.stderr, scenario.stderr);
          for (const relative of outputPaths) {
            assert.deepEqual(await readFile(path.join(f.designCodeDir, relative)), Buffer.concat([Buffer.from([0, 255]), Buffer.from("fixture:"), script, Buffer.from(`:${relative}`)]));
          }
        } else {
          await assert.rejects(() => executeExternalDesignScript(input), { message: scenario.stdout
            ? "run_design_script external-agentd script_failed: stdout:\n输😀\nstderr:\n错é"
            : "run_design_script external-agentd script_failed: no outputs published" });
        }
        const capture = JSON.parse(await readFile(capturePath, "utf8"));
        const raw = Buffer.from(capture.request_base64, "base64");
        const request = JSON.parse(raw.toString());
        assert.equal(raw.toString(), canonicalDesignJson(request));
        assert.equal(designSha256(raw), capture.response.request_sha256);
        assert.equal(capture.input_manifest_sha256, request.input_manifest_sha256);
        assert.equal(capture.response.execution.root_entry_sha256, designSha256(await readFile(f.rootVenvPython)));
        assert.deepEqual(capture.response.execution.closure, { launcher_reaped: true, descendants_stopped: true, output_frozen: scenario.status === "completed" });
        assert.equal(capture.response.stdout, scenario.stdout);
        assert.equal(capture.response.stderr, scenario.stderr);
        assert.equal([...capture.response.stdout].length + [...capture.response.stderr].length <= scenario.cap, true);
        assert.equal(capture.response.outputs.length, scenario.status === "completed" ? outputPaths.length : 0);
      }
      if (scenario.status !== "completed" || scenario.name === "combined log overflow") {
        for (const relative of outputPaths) await assert.rejects(() => readFile(path.join(f.designCodeDir, relative)), /ENOENT/);
      }
      assert.deepEqual(await readFile(path.join(f.designCodeDir, "entry.py")), script);
    } finally { await f.dispose(); }
  });
}
