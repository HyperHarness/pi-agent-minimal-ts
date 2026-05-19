import test from "node:test";
import assert from "node:assert/strict";
import {
  getWikiPageTemplate,
  inferWikiPageTypeForEvidence,
  validateRequiredTemplateSections
} from "../../src/agent/wiki/page-templates.js";

test("inferWikiPageTypeForEvidence maps material sources to dataset pages", () => {
  assert.equal(inferWikiPageTypeForEvidence({
    query: "sapphire substrate dielectric constant table",
    sourceKinds: ["material-database"]
  }), "dataset");
});

test("inferWikiPageTypeForEvidence maps software documentation to method pages", () => {
  assert.equal(inferWikiPageTypeForEvidence({
    query: "HFSS eigenmode simulation workflow for package modes",
    sourceKinds: ["software-doc"]
  }), "method");
});

test("inferWikiPageTypeForEvidence maps generic software queries to method pages", () => {
  assert.equal(inferWikiPageTypeForEvidence({
    query: "software documentation",
    sourceKinds: []
  }), "method");
});

test("inferWikiPageTypeForEvidence maps capability-boundary queries to boundary pages", () => {
  assert.equal(inferWikiPageTypeForEvidence({
    query: "superconducting chip design agent capability boundary cannot support tapeout",
    sourceKinds: []
  }), "capability-boundary");
});

test("getWikiPageTemplate returns concrete required sections", () => {
  const template = getWikiPageTemplate("design-record");
  assert.equal(template.pageType, "design-record");
  assert.deepEqual(template.requiredSections, [
    "Decision",
    "Context",
    "Evidence Used",
    "Alternatives Considered",
    "Verification Plan",
    "Status"
  ]);
  assert.match(template.guidance, /uses/);
});

test("getWikiPageTemplate returns capability boundary sections", () => {
  const template = getWikiPageTemplate("capability-boundary");
  assert.deepEqual(template.requiredSections, [
    "Can Support",
    "Cannot Support Yet",
    "Evidence Boundary",
    "Escalation Criteria"
  ]);
  assert.match(template.guidance, /overclaim/i);
});

test("validateRequiredTemplateSections reports missing method inputs and outputs", () => {
  const result = validateRequiredTemplateSections({
    pageType: "method",
    markdown: "# HFSS Eigenmode Simulation\n\n## Goal\n\nFind package modes.\n\n## Procedure\n\nRun eigenmode solve."
  });

  assert.deepEqual(result.missingSections, ["Inputs", "Outputs", "Failure Modes", "Design Use"]);
});
