import test from "node:test";
import assert from "node:assert/strict";
import {
  listWikiDomainBindings,
  validateWikiDomainBinding
} from "../../src/agent/wiki/domain-bindings.js";

test("domain bindings expose validated helper metadata without executing arbitrary code", () => {
  const bindings = listWikiDomainBindings();
  assert.ok(bindings.some((binding) => binding.key === "transmon-frequency-estimate"));
  const binding = bindings.find((candidate) => candidate.key === "transmon-frequency-estimate");
  assert.equal(binding?.domain, "superconducting-qubits");
  assert.equal(binding?.executionMode, "deterministic-local");
});

test("validateWikiDomainBinding accepts known bindings and rejects unknown bindings", () => {
  assert.deepEqual(validateWikiDomainBinding("transmon-frequency-estimate"), {
    ok: true,
    key: "transmon-frequency-estimate"
  });
  assert.deepEqual(validateWikiDomainBinding("unknown-helper"), {
    ok: false,
    key: "unknown-helper",
    reason: "unknown_binding"
  });
});

test("listWikiDomainBindings protects registry schemas from caller mutation", () => {
  const [binding] = listWikiDomainBindings();
  const required = binding.inputSchema.required;
  assert.ok(Array.isArray(required));

  binding.inputSchema.type = "mutated";
  required.push("mutated-field");

  const [freshBinding] = listWikiDomainBindings();

  assert.deepEqual(freshBinding.inputSchema, { type: "object", required: ["ej", "ec"] });
  assert.deepEqual(freshBinding.outputSchema, { type: "object", required: ["frequencyGhz"] });
});
