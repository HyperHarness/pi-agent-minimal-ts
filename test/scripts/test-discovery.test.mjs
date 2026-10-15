import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// npm runs package scripts with /bin/sh, which has no globstar: there `**` behaves like `*`.
// Every `--test` pattern containing a glob must therefore stay quoted so Node's own test
// runner (which implements real globstar, matching zero or more path segments) does the
// matching. Otherwise the shell partially expands the pattern, and suites at zero or two
// directory levels are silently dropped from the run.
const root = fileURLToPath(new URL("../../", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const testScript = packageJson.scripts?.test ?? "";

const DIST_PATTERN = "dist/test/**/*.test.js";
const SCRIPT_TEST_PATTERN = "test/scripts/**/*.test.mjs";
// Source-tree equivalents of the compiled suites, used to describe what the globs must reach.
const SOURCE_PATTERN = "test/**/*.test.ts";
const ZERO_DEPTH_SUITE = "test/index.test.ts";
const ONE_DEPTH_SUITE = "test/agent/tools.test.ts";
const TWO_DEPTH_SUITE = "test/agent/publisher-adapters/index.test.ts";

function tokenize(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

function shellExpand(relativePattern) {
  const output = execFileSync(
    "/bin/sh",
    ["-c", `for f in ${relativePattern}; do printf '%s\\n' "$f"; done`],
    { cwd: root, encoding: "utf8" }
  );
  return output.split("\n").filter((line) => line.length > 0);
}

test("npm test quotes its recursive globs so /bin/sh cannot expand them", () => {
  assert.match(testScript, /^npm run build && node --test\b/);
  assert.ok(testScript.includes(`'${DIST_PATTERN}'`), `${DIST_PATTERN} must be single-quoted`);
  assert.ok(testScript.includes(`'${SCRIPT_TEST_PATTERN}'`), `${SCRIPT_TEST_PATTERN} must be single-quoted`);

  const tokens = tokenize(testScript);
  const testFlagIndex = tokens.indexOf("--test");
  assert.notEqual(testFlagIndex, -1, "test script must invoke the Node test runner");
  const patterns = tokens.slice(testFlagIndex + 1).filter((token) => !token.startsWith("--"));
  assert.deepEqual(patterns, [DIST_PATTERN, SCRIPT_TEST_PATTERN]);
});

test("Node's globstar reaches zero-, one- and two-directory-deep test suites", () => {
  const matched = globSync(SOURCE_PATTERN, { cwd: root });
  assert.ok(matched.includes(ZERO_DEPTH_SUITE), `${ZERO_DEPTH_SUITE} must be discovered`);
  assert.ok(matched.includes(ONE_DEPTH_SUITE), `${ONE_DEPTH_SUITE} must be discovered`);
  assert.ok(matched.includes(TWO_DEPTH_SUITE), `${TWO_DEPTH_SUITE} must be discovered`);
});

test("/bin/sh expansion of an unquoted pattern silently drops the zero- and two-deep suites", (t) => {
  if (!existsSync("/bin/sh")) {
    t.skip("no /bin/sh available to emulate npm script expansion");
    return;
  }

  const shellMatched = shellExpand(SOURCE_PATTERN);
  assert.ok(shellMatched.length > 0, "the unquoted pattern must expand to some files in /bin/sh");
  assert.ok(!shellMatched.includes(ZERO_DEPTH_SUITE), "/bin/sh must not reach the zero-depth suite");
  assert.ok(!shellMatched.includes(TWO_DEPTH_SUITE), "/bin/sh must not reach the two-depth suite");

  // Passing the pattern through untouched (as the quoted script does) lets Node apply the
  // real globstar semantics and recover the suites the shell dropped.
  const nodeMatched = globSync(SOURCE_PATTERN, { cwd: root });
  assert.ok(nodeMatched.includes(ZERO_DEPTH_SUITE));
  assert.ok(nodeMatched.includes(TWO_DEPTH_SUITE));
});
