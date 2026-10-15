import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// `node --test --experimental-test-isolation=none` requires Node >= 22.8.0. On older
// runtimes Node aborts with "node: bad option" before a single test runs, so the
// requirement has to be declared rather than discovered at test time.
const MINIMUM_NODE = [22, 8, 0];
const MINIMUM_NODE_RANGE = ">=22.8.0";

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const lockfile = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseMinimum(range) {
  const match = /^>=\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(String(range).trim());
  if (match === null) {
    return null;
  }
  const segment = (value) => (value === undefined || value === "x" || value === "*" ? 0 : Number(value));
  return [Number(match[1]), segment(match[2]), segment(match[3])];
}

function satisfiesMinimum(range, version) {
  const minimum = parseMinimum(range);
  const parsed = parseVersion(version);
  assert.notEqual(minimum, null, `unsupported range: ${range}`);
  assert.notEqual(parsed, null, `unsupported version: ${version}`);
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] !== minimum[index]) {
      return parsed[index] > minimum[index];
    }
  }
  return true;
}

test("test script depends on a Node flag that requires >= 22.8.0", () => {
  const testScript = packageJson.scripts?.test ?? "";

  assert.match(testScript, /--experimental-test-isolation=none/);
  assert.deepEqual(parseMinimum(packageJson.engines?.node), MINIMUM_NODE);
  assert.equal(packageJson.engines?.node, MINIMUM_NODE_RANGE);
});

test("declared engines reject the runtimes that abort with a bad option", () => {
  const engines = packageJson.engines?.node;

  assert.equal(satisfiesMinimum(engines, "20.19.0"), false);
  assert.equal(satisfiesMinimum(engines, "22.7.0"), false);
  assert.equal(satisfiesMinimum(engines, "22.8.0"), true);
  assert.equal(satisfiesMinimum(engines, "22.22.0"), true);
  assert.equal(satisfiesMinimum(engines, "24.0.0"), true);
});

test("lockfile root engines match the declared package engines", () => {
  const lockfileRoot = lockfile.packages?.[""];

  assert.notEqual(lockfileRoot, undefined);
  assert.equal(lockfileRoot.engines?.node, packageJson.engines?.node);
});
