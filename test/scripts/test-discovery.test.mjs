import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("npm test passes recursive patterns intact to Node on POSIX and Windows shells", () => {
  for (const pattern of ["dist/test/**/*.test.js", "test/scripts/**/*.test.mjs"]) {
    assert.ok(packageJson.scripts.test.includes(`"${pattern}"`));
  }
});

test("recursive discovery includes root, nested and deeply nested suites", () => {
  const matched = globSync("dist/test/**/*.test.js", { cwd: root }).map(name => name.replaceAll("\\", "/"));
  for (const expected of ["dist/test/index.test.js", "dist/test/agent/tools.test.js", "dist/test/agent/publisher-adapters/index.test.js"]) {
    assert.ok(matched.includes(expected), `${expected} must be discovered`);
  }
});

test("the test command preserves glob arguments through npm's POSIX shell", { skip: !existsSync("/bin/sh") }, () => {
  const command = packageJson.scripts.test.replace(/^npm run build && node /, 'printf "%s\\n" ');
  const args = execFileSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(args, ["--test", "--experimental-test-isolation=none", "dist/test/**/*.test.js", "test/scripts/**/*.test.mjs"]);
});
