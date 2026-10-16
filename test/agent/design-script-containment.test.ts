import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolsForBoundary } from "../../src/agent/tools.js";

test("standalone actual bwrap proves script start and denied original workspace writes", { skip: process.platform === "win32" ? "requires Linux bwrap and executable shell fixture" : false }, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "design-live-containment-"));
  const project = path.join(workspace, "design-repo", "design-code");
  const python = path.join(workspace, ".venv", "bin", "python");
  const source = "#!/bin/sh\nexec python3 \"$@\"\n";
  const protectedFiles = [path.join(workspace, "package.json"), python, path.join(workspace, "knowledge-base", "pages", "protected.md")];
  const originals = ["original-package", source, "original-wiki"];
  try {
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "pyproject.toml"), '[project]\nname="containment-fixture"\n');
    for (let i = 0; i < protectedFiles.length; i++) { await mkdir(path.dirname(protectedFiles[i]), { recursive: true }); await writeFile(protectedFiles[i], originals[i]); }
    await chmod(python, 0o755);
    const script = [
      "from pathlib import Path", "import json", "attempts=[]",
      `for filename in ${JSON.stringify(protectedFiles)}:`,
      " try:", "  Path(filename).write_text('MUTATED')", "  attempts.append({'path':filename,'denied':False})",
      " except OSError as error:", "  attempts.append({'path':filename,'denied':True,'errno':error.errno})",
      "Path('execution-proof.txt').write_text('actually ran inside bwrap')",
      "print(json.dumps({'started':True,'attempts':attempts}))", ""
    ].join("\n");
    await writeFile(path.join(project, "probe.py"), script);
    const tool = createToolsForBoundary(workspace, "design-agent").find(tool => tool.name === "run_design_script")!;
    // No fallback, no accepting a bwrap error as proof, and no skip on startup
    // failure: a real returned marker and all attempted writes are required.
    const result = await tool.execute("actual-standalone-containment", { scriptPath: "probe.py", runner: "python", outputPaths: ["execution-proof.txt"] }, undefined);
    const details = result.details as { stdout: string };
    const proof = JSON.parse(details.stdout) as { started: boolean; attempts: Array<{ path: string; denied: boolean; errno: number }> };
    assert.equal(proof.started, true);
    assert.deepEqual(proof.attempts.map(attempt => attempt.path), protectedFiles);
    assert.equal(proof.attempts.every(attempt => attempt.denied && [13, 30].includes(attempt.errno)), true);
    assert.equal(await readFile(path.join(project, "execution-proof.txt"), "utf8"), "actually ran inside bwrap");
    for (let i = 0; i < protectedFiles.length; i++) assert.equal(await readFile(protectedFiles[i], "utf8"), originals[i]);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
