import test from "node:test";
import assert from "node:assert/strict";

import {
  downloadPaper,
  parsePaper,
  resolvePaperLibraryPaths,
  writePaperRecord
} from "../../src/agent/paper/index.js";

test("paper domain facade exposes acquisition, parsing, and storage APIs", () => {
  assert.equal(typeof downloadPaper, "function");
  assert.equal(typeof parsePaper, "function");
  assert.equal(typeof resolvePaperLibraryPaths, "function");
  assert.equal(typeof writePaperRecord, "function");
});
