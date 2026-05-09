import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPaperSummaryEvidence,
  applyWikiStructurePlan,
  bootstrapPaperWikiPageEvidence,
  checkWikiHealth,
  lintPaperWiki,
  planWikiStructure,
  searchPaperWiki,
  writePaperWikiPage,
  writePaperWikiSource
} from "../../src/agent/wiki/index.js";

test("wiki domain facade exposes source, page, health, and evidence APIs", () => {
  assert.equal(typeof writePaperWikiSource, "function");
  assert.equal(typeof writePaperWikiPage, "function");
  assert.equal(typeof searchPaperWiki, "function");
  assert.equal(typeof bootstrapPaperWikiPageEvidence, "function");
  assert.equal(typeof buildPaperSummaryEvidence, "function");
  assert.equal(typeof checkWikiHealth, "function");
  assert.equal(typeof lintPaperWiki, "function");
  assert.equal(typeof planWikiStructure, "function");
  assert.equal(typeof applyWikiStructurePlan, "function");
});
