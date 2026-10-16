import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalDesignJson, designSha256, getDesignExecutionFailureEvidence } from "../../../src/agent/design-script-execution.js";
import { registerOriginalDesignScriptCases, type DesignScriptCaseToolFactory, type OriginalDesignScriptCaseRegistrar } from "./design-script-original-cases.js";

export const externalCanaryCaseName = "run_design_script external boundary rejects a direct write to a pre-existing host canary without publishing failed outputs";
export const externalCanaryMarker = "PI_AGENT_EXTERNAL_CANARY_V1 ";
export const externalCanaryScriptPath = "scripts/external_host_canary.py";
export const externalCanaryOutputPath = "outputs/external-host-canary.gds";
export const externalCanaryRelativePath = "knowledge-base/pages/external-host-canary.md";
const originalCaseNames = [
  "run_design_script uses the parent root venv Python and ignores nested design-code venvs",
  "run_design_script copies back only declared design-code outputs from an isolated run",
  "run_design_script restores protected wiki paths when a script writes outside design-code",
];

/** This is a test-only script, not an execution attestation. Its exact bytes,
 * runtime, controller journal, status FD and closure must be pinned/verified
 * independently by the owner-side runner. Printed markers alone prove none of
 * those facts. The only write target outside private outputs is a disposable,
 * writable canary in this case's original host workspace, never runtime files. */
export function externalCanaryScript(target: string): string {
  assert.ok(path.isAbsolute(target));
  return [
    "from pathlib import Path",
    "import json, sys",
    `target = Path(${JSON.stringify(target)})`,
    `marker = ${JSON.stringify(externalCanaryMarker)}`,
    "def emit(event, **fields):",
    "    print(marker + json.dumps(dict(event=event, **fields), sort_keys=True), file=sys.stderr, flush=True)",
    "Path('../outputs').mkdir(exist_ok=True)",
    "Path('../outputs/external-host-canary.gds').write_bytes(b'must not publish failed output')",
    "emit('private-output-created', path='outputs/external-host-canary.gds')",
    "emit('attempt', operation='Path.write_text', target=str(target))",
    "try:",
    "    target.write_text('# unauthorized canary replacement\\n', encoding='utf-8')",
    "except OSError as error:",
    "    emit('caught-error', operation='Path.write_text', target=str(target), error_type=type(error).__name__, errno=error.errno, filename=error.filename)",
    "    raise",
    "emit('unexpected-success', operation='Path.write_text', target=str(target))",
    "",
  ].join("\n");
}

/** Application-level negative assertion only. The production adapter has already
 * rejected failed-response output publication. A matching error is insufficient
 * to establish actual execution, raw nonzero exit or verified process closure. */
export function assertExternalCanaryFailure(error: unknown, target: string, expected: {
  scriptSha256: string; inputManifestSha256: string; rootEntrySha256: string;
}): void {
  assert.ok(error instanceof Error, "The external canary call must reject");
  const evidence = getDesignExecutionFailureEvidence(error);
  assert.ok(evidence, "Require validated adapter failure data, not printed or copied error properties");
  assert.equal(evidence.status, "script_failed");
  assert.equal(evidence.exitCode, 1, "The actual response exit code must be the uncaught Python failure exit");
  assert.deepEqual(evidence.closure, { launcherReaped: true, descendantsStopped: true, outputFrozen: false });
  assert.equal(evidence.scriptPath, externalCanaryScriptPath);
  assert.equal(evidence.scriptSha256, expected.scriptSha256);
  assert.equal(evidence.inputManifestSha256, expected.inputManifestSha256);
  assert.equal(evidence.rootEntrySha256, expected.rootEntrySha256);
  assert.ok(error.message.startsWith("run_design_script external-agentd script_failed: stderr:\n"), "The fixed script must fail with its diagnostics only on stderr, not during setup or admission");
  const lines = error.message.split("\n");
  const markers = lines.filter(line => line.startsWith(externalCanaryMarker)).map(line => {
    try { return JSON.parse(line.slice(externalCanaryMarker.length)) as unknown; }
    catch { assert.fail("Malformed external canary marker"); }
  });
  assert.deepEqual(markers, [
    { event: "private-output-created", path: externalCanaryOutputPath },
    { event: "attempt", operation: "Path.write_text", target },
    { event: "caught-error", operation: "Path.write_text", target, error_type: "FileNotFoundError", errno: 2, filename: target },
  ], "Require the exact direct-write operation, target and ENOENT; generic or setup ENOENT is not evidence");
  assert.ok(lines.some(line => line === `FileNotFoundError: [Errno 2] No such file or directory: '${target}'`), "The caught direct-write failure must remain an uncaught script failure");
}

async function protectedSnapshot(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  async function visit(relative: string): Promise<void> {
    const filename = path.join(root, relative);
    const stat = await lstat(filename, { bigint: true });
    // Reading files/directories can update atime. All other stable identity,
    // ownership, permission, size and nanosecond time fields remain protected.
    const metadata = {
      dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink,
      uid: stat.uid, gid: stat.gid, rdev: stat.rdev, size: stat.size,
      blksize: stat.blksize, blocks: stat.blocks,
      mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, birthtimeNs: stat.birthtimeNs,
    };
    entries.push({ path: relative, metadata,
      bytes: stat.isFile() ? await readFile(filename) : null,
      link: stat.isSymbolicLink() ? await readlink(filename) : null });
    if (stat.isDirectory()) for (const name of (await readdir(filename)).sort()) await visit(path.join(relative, name));
  }
  await visit("");
  return entries;
}

export function registerExternalCanaryCase(
  getRunDesignScriptTool: DesignScriptCaseToolFactory,
  register: OriginalDesignScriptCaseRegistrar = test,
): void {
  register(externalCanaryCaseName, { skip: process.platform === "win32" ? "fake python.exe shell-script shims are not executable on Windows" : false }, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-external-canary-"));
    const projectDir = path.join(workspace, "design-repo", "design-code");
    const target = path.join(workspace, externalCanaryRelativePath);
    const rootEntry = path.join(workspace, ".venv", "bin", "python");
    try {
      await mkdir(path.join(projectDir, "scripts"), { recursive: true });
      await mkdir(path.dirname(rootEntry), { recursive: true });
      await mkdir(path.dirname(target), { recursive: true });
      const rootEntryBytes = '#!/bin/sh\nexec python3 "$@"\n';
      const projectBytes = '[project]\nname = "pi-chip-design"\n';
      const scriptBytes = externalCanaryScript(target);
      await writeFile(rootEntry, rootEntryBytes);
      await chmod(rootEntry, 0o755);
      await writeFile(path.join(projectDir, "pyproject.toml"), projectBytes);
      await writeFile(target, "# disposable protected host canary\n", { mode: 0o600 });
      await chmod(target, 0o600);
      await writeFile(path.join(projectDir, externalCanaryScriptPath), scriptBytes);
      const rootEntrySha256 = designSha256(rootEntryBytes);
      const manifest = {
        files: [["pyproject.toml", projectBytes], [externalCanaryScriptPath, scriptBytes]].map(([filePath, bytes]) => ({
          path: filePath!, executable: false, size: Buffer.byteLength(bytes!), sha256: designSha256(bytes!),
        })),
        root_entry: { size: Buffer.byteLength(rootEntryBytes), sha256: rootEntrySha256 },
      };
      const expected = { scriptSha256: designSha256(scriptBytes), inputManifestSha256: designSha256(canonicalDesignJson(manifest)), rootEntrySha256 };
      const before = await protectedSnapshot(path.join(workspace, "knowledge-base"));
      const tool = getRunDesignScriptTool(workspace);
      await assert.rejects(() => tool.execute("call-run-design-script-external-canary", {
        scriptPath: `design-repo/design-code/${externalCanaryScriptPath}`,
        runner: "python",
        outputPaths: [`design-repo/design-code/${externalCanaryOutputPath}`],
        maxOutputChars: 12000,
      }, undefined), error => { assertExternalCanaryFailure(error, target, expected); return true; });
      assert.deepEqual(await protectedSnapshot(path.join(workspace, "knowledge-base")), before,
        "Protected canary bytes/metadata and the complete protected file set must be unchanged");
      await assert.rejects(() => lstat(path.join(projectDir, externalCanaryOutputPath)), { code: "ENOENT" }, "A failed call must not publish its private output");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

/** Explicit external mapping: two unchanged original callbacks and one new
 * boundary-specific case. The standalone suite retains all three originals. */
export function registerExternalDesignScriptCases(
  getRunDesignScriptTool: DesignScriptCaseToolFactory,
  register: OriginalDesignScriptCaseRegistrar = test,
): void {
  const originals: Parameters<OriginalDesignScriptCaseRegistrar>[] = [];
  registerOriginalDesignScriptCases(getRunDesignScriptTool, (...args) => { originals.push(args); });
  assert.deepEqual(originals.map(([name]) => name), originalCaseNames);
  for (const args of originals.slice(0, 2)) register(...args);
  registerExternalCanaryCase(getRunDesignScriptTool, register);
}
