import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

const compiledPattern = "dist/test/**/*.test.js";
const sourcePattern = "test/**/*.test.mjs";

function discover(pattern) {
  return globSync(pattern, { cwd: root }).map(name => name.replaceAll("\\", "/")).sort();
}

test("npm test passes recursive patterns intact to Node on POSIX and Windows shells", () => {
  for (const pattern of [compiledPattern, sourcePattern]) {
    assert.ok(packageJson.scripts.test.includes(`"${pattern}"`));
  }
});

test("npm test globs discover the complete recursive compiled and source test inventory", () => {
  const compiledSources = discover("test/**/*.test.ts");
  const sourceTests = discover("test/**/*.test.mjs");
  const expectedCompiled = compiledSources.map(name => `dist/${name.replace(/\.ts$/, ".js")}`);

  assert.ok(compiledSources.length > 0, "compiled TypeScript test sources must exist");
  assert.ok(sourceTests.length > 0, "source .test.mjs suites must exist");

  const commandGlobs = [...packageJson.scripts.test.matchAll(/"([^"]*\*[^"]*)"/g)].map(match => match[1]);
  const discovered = commandGlobs.flatMap(discover);

  // Exact set equality against the recursive inventory: every compiled TypeScript
  // suite and every source .test.mjs suite is discovered, and nothing else is.
  assert.deepEqual([...new Set(discovered)].sort(), [...new Set([...expectedCompiled, ...sourceTests])].sort());

  for (const expected of [
    "dist/test/index.test.js",
    "dist/test/agent/publisher-adapters/index.test.js",
    "test/browser-extension/paper-downloader.test.mjs",
  ]) {
    assert.ok(discovered.includes(expected), `${expected} must be discovered by npm test`);
  }

  // The previous narrow source glob silently skipped browser-extension suites.
  assert.ok(!discover("test/scripts/**/*.test.mjs").includes("test/browser-extension/paper-downloader.test.mjs"));
});

test("the test command preserves glob arguments through npm's POSIX shell", { skip: !existsSync("/bin/sh") }, () => {
  const command = packageJson.scripts.test.replace(/^npm run build && node /, 'printf "%s\\n" ');
  const args = execFileSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(args, ["--test", "--experimental-test-isolation=none", compiledPattern, sourcePattern]);
});
