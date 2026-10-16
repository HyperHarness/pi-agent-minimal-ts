import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DesignScriptCaseToolFactory, OriginalDesignScriptCaseRegistrar } from "./design-script-original-cases.js";

export const externalContainmentCaseName = "external boundary proves script start, three unexposed host writes and declared output publication";
export const externalContainmentOutput = "execution-proof.txt";
export const externalContainmentProof = "external containment script completed";

export function externalContainmentScript(targets: readonly string[]): string {
  assert.equal(targets.length, 3);
  assert.equal(new Set(targets).size, 3);
  assert.ok(targets.every(target => path.isAbsolute(target)));
  return [
    "from pathlib import Path", "import json", "attempts=[]",
    `for filename in ${JSON.stringify(targets)}:`,
    " try:", "  Path(filename).write_text('MUTATED')",
    "  attempts.append({'path':filename,'operation':'Path.write_text','denied':False})",
    " except OSError as error:",
    "  attempts.append({'path':filename,'operation':'Path.write_text','denied':True,'errno':error.errno,'error_type':type(error).__name__,'filename':error.filename})",
    `Path('${externalContainmentOutput}').write_text('${externalContainmentProof}')`,
    "print(json.dumps({'started':True,'attempts':attempts}))", "",
  ].join("\n");
}

async function snapshot(files: readonly string[]) {
  return Promise.all(files.map(async filename => {
    const info = await lstat(filename, { bigint: true });
    return { bytes: await readFile(filename), dev: info.dev, ino: info.ino, nlink: info.nlink, uid: info.uid, gid: info.gid, mode: info.mode, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
  }));
}

/** External-specific counterpart of the standalone three-target test. Success
 * requires all three attempted writes, exact ENOENT for each unexposed original
 * target, unchanged bytes/metadata and one declared output. Printed data remains
 * application assertions, never independent controller/OS attestation. */
export function registerExternalContainmentCase(
  factory: DesignScriptCaseToolFactory,
  register: OriginalDesignScriptCaseRegistrar = test,
): void {
  register(externalContainmentCaseName, { skip: process.platform === "win32" ? "requires Linux bwrap and executable shell fixture" : false }, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "design-external-containment-"));
    const project = path.join(workspace, "design-repo", "design-code");
    const python = path.join(workspace, ".venv", "bin", "python");
    const source = '#!/bin/sh\nexec python3 "$@"\n';
    const targets = [path.join(workspace, "package.json"), python, path.join(workspace, "knowledge-base", "pages", "protected.md")];
    const originals = ["original-package", source, "original-wiki"];
    try {
      await mkdir(project, { recursive: true });
      await writeFile(path.join(project, "pyproject.toml"), '[project]\nname="containment-fixture"\n');
      for (let i = 0; i < targets.length; i++) {
        await mkdir(path.dirname(targets[i]!), { recursive: true });
        await writeFile(targets[i]!, originals[i]!);
      }
      await chmod(python, 0o755);
      await writeFile(path.join(project, "probe.py"), externalContainmentScript(targets));
      const before = await snapshot(targets);
      const result = await factory(workspace).execute("actual-external-containment", {
        scriptPath: "probe.py", runner: "python", outputPaths: [externalContainmentOutput], maxOutputChars: 12000,
      }, undefined);
      const details = result.details as { status: string; runner: string; scriptPath: string; command: string; exitCode: number; stdout: string; stderr: string; outputs: unknown[] };
      assert.deepEqual(details, {
        status: "completed", runner: "python", scriptPath: "design-repo/design-code/probe.py",
        command: "../../.venv/bin/python probe.py", exitCode: 0, stdout: details.stdout, stderr: "",
        outputs: [{ path: `design-repo/design-code/${externalContainmentOutput}`, bytes: Buffer.byteLength(externalContainmentProof) }],
      });
      assert.deepEqual(JSON.parse(details.stdout), { started: true, attempts: targets.map(target => ({
        path: target, operation: "Path.write_text", denied: true, errno: 2, error_type: "FileNotFoundError", filename: target,
      })) });
      assert.equal(await readFile(path.join(project, externalContainmentOutput), "utf8"), externalContainmentProof);
      assert.deepEqual(await snapshot(targets), before, "All three original host files must keep their bytes and stable metadata");
      for (let i = 0; i < targets.length; i++) assert.equal(await readFile(targets[i]!, "utf8"), originals[i]);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
}
