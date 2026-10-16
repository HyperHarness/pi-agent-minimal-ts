import assert from "node:assert/strict";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { designSha256 } from "../../../src/agent/design-script-execution.js";
import { externalCanaryCaseName } from "./design-script-external-canary-case.js";
import { externalContainmentCaseName } from "./design-script-external-containment-case.js";

const toolsFile = "dist/test/agent/tools.test.js";
export const fullSuiteCaseMapping = Object.freeze([
  { file: toolsFile, original: "run_design_script uses the parent root venv Python and ignores nested design-code venvs", external: "run_design_script uses the parent root venv Python and ignores nested design-code venvs", kind: "shared-positive" },
  { file: toolsFile, original: "run_design_script copies back only declared design-code outputs from an isolated run", external: "run_design_script copies back only declared design-code outputs from an isolated run", kind: "shared-positive" },
  { file: toolsFile, original: "run_design_script restores protected wiki paths when a script writes outside design-code", external: externalCanaryCaseName, kind: "external-canary" },
  { file: "dist/test/agent/design-script-containment.test.js", original: "standalone actual bwrap proves script start and denied original workspace writes", external: externalContainmentCaseName, kind: "external-containment" },
  { file: toolsFile, original: "run_design_script cannot mutate absolute parent workspace paths", external: "run_design_script cannot mutate absolute parent workspace paths", kind: "unchanged-parent-write" },
  { file: toolsFile, original: "run_design_script rejects Python scripts when the root venv Python is missing", external: "run_design_script rejects Python scripts when the root venv Python is missing", kind: "unchanged-preflight" },
].map(item => Object.freeze(item)));

/** Pure accounting only: this object contains no backend, factory or activation. */
export function createFullSuiteMappingLedger(files: readonly string[]) {
  assert.equal(new Set(files).size, files.length, "Duplicate test inventory path");
  for (const item of fullSuiteCaseMapping) assert.ok(files.includes(item.file), `Missing mapped test module: ${item.file}`);
  const seen = new Set<string>();
  return {
    claim(file: string, original: string) {
      const item = fullSuiteCaseMapping.find(item => item.file === file && item.original === original);
      assert.ok(item, `Unmatched design test registration: ${file}: ${original}`);
      const key = `${file}\0${original}`;
      assert.ok(!seen.has(key), `Duplicate design test registration: ${original}`);
      seen.add(key);
      return item;
    },
    finish() {
      assert.deepEqual([...seen].sort(), fullSuiteCaseMapping.map(item => `${item.file}\0${item.original}`).sort(), "Missing design test registrations");
      return fullSuiteCaseMapping;
    },
  };
}

/** Match the existing explicit recursive suite: compiled dist/test JS plus
 * source test MJS, including every extra candidate subdirectory. No public-file
 * allowlist, shell glob, stale dist-offline tree or dependency tree is used. */
export async function discoverFullSuiteTestFiles(root: string): Promise<readonly Readonly<{ path: string; sha256: string }>[]> {
  const found: { path: string; sha256: string }[] = [];
  const identities = new Set<string>();
  async function visit(relative: string, suffix: string): Promise<void> {
    const filename = path.join(root, relative);
    const info = await lstat(filename);
    assert.ok(!info.isSymbolicLink(), `Symlink in test inventory: ${relative}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(filename)).sort()) await visit(`${relative}/${name}`, suffix);
    } else if (relative.endsWith(suffix)) {
      assert.ok(info.isFile(), `Non-regular test file: ${relative}`);
      assert.equal(await realpath(filename), filename, `Aliased test path: ${relative}`);
      const identity = `${info.dev}:${info.ino}`;
      assert.ok(!identities.has(identity), `Duplicate test file identity: ${relative}`);
      identities.add(identity);
      found.push({ path: relative, sha256: designSha256(await readFile(filename)) });
    }
  }
  root = path.resolve(root);
  assert.equal(await realpath(root), root, "Candidate root must not be an alias");
  await visit("dist/test", ".test.js");
  await visit("test", ".test.mjs");
  found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  createFullSuiteMappingLedger(found.map(item => item.path));
  return Object.freeze(found.map(item => Object.freeze(item)));
}
