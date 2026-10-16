import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestOptions } from "node:test";
import { loadReviewedAgentdDesignExecution, type ReviewedAgentdDesignPins } from "../../src/agent/agentd-design-entrypoint.js";
import { createExternalDesignScriptPilotToolFactory } from "./design-script-reviewed-pilot.js";
import { registerOriginalDesignScriptCases, type DesignScriptCaseToolFactory, type OriginalDesignScriptCaseRegistrar } from "./fixtures/design-script-original-cases.js";
import { registerExternalCanaryCase } from "./fixtures/design-script-external-canary-case.js";
import { registerExternalContainmentCase } from "./fixtures/design-script-external-containment-case.js";
import { createExternalParentWriteGuard } from "./fixtures/design-script-parent-write-guard.js";
import { createFullSuiteMappingLedger, discoverFullSuiteTestFiles } from "./fixtures/design-script-full-suite-inventory.js";

type MappingLedger = ReturnType<typeof createFullSuiteMappingLedger>;
type ParentGuard = ReturnType<typeof createExternalParentWriteGuard>;
type RegistrationScope = {
  readonly file: string; readonly url: string; readonly ledger: MappingLedger;
  readonly guard: ParentGuard; open: boolean; factoryCaptured: boolean;
};
// Neither this store nor a setter/backend/loader override is exported. Each
// awaited import has its own scope, explicitly closed even for inherited async
// callbacks. Test callbacks use captured factories, never registration state.
const registration = new AsyncLocalStorage<RegistrationScope>();
const standaloneRegistrations = new Set<string>();
let entryStarted = false;

function scopeFor(moduleUrl: string): RegistrationScope | undefined {
  const scope = registration.getStore();
  if (scope) {
    assert.ok(scope.open, "Design registration scope is closed");
    assert.equal(moduleUrl, scope.url, "Unmatched design registration module");
  } else {
    standaloneRegistrations.add(moduleUrl);
  }
  return scope;
}

/** Capture at module registration, not while a test callback executes. */
export function captureDesignScriptTestToolFactory(moduleUrl: string, standalone: DesignScriptCaseToolFactory): DesignScriptCaseToolFactory {
  const scope = scopeFor(moduleUrl);
  if (!scope) return standalone;
  assert.equal(scope.file, "dist/test/agent/tools.test.js", "Unexpected design factory registration");
  assert.equal(scope.factoryCaptured, false, "Duplicate design factory registration");
  scope.factoryCaptured = true;
  return scope.guard.factory;
}

/** Only the real tools.test registration site calls this; the shared original
 * fixture and its own offline callback tests remain entirely context-free. */
export function registerFullSuiteOriginalDesignCases(moduleUrl: string, standalone: DesignScriptCaseToolFactory): void {
  const scope = scopeFor(moduleUrl);
  if (!scope) { registerOriginalDesignScriptCases(standalone); return; }
  assert.ok(scope.factoryCaptured, "Design factory must be captured before case registration");
  registerOriginalDesignScriptCases(scope.guard.factory, (name, options, body) => {
    const mapped = scope.ledger.claim(scope.file, name);
    if (mapped.kind === "shared-positive") test(name, options, body);
    else {
      assert.equal(mapped.kind, "external-canary");
      registerSingleReplacement(registerExternalCanaryCase, scope, mapped.external);
    }
  });
}

function registerSingleReplacement(
  register: (factory: DesignScriptCaseToolFactory, register: OriginalDesignScriptCaseRegistrar) => void,
  scope: RegistrationScope, name: string,
): void {
  let count = 0;
  register(scope.guard.factory, (actual, options, body) => {
    assert.equal(actual, name, "Unmatched external replacement name");
    assert.equal(++count, 1, "Duplicate external replacement");
    test(actual, options, body);
  });
  assert.equal(count, 1, "Missing external replacement");
}

/** Wrap registration only; default callback bodies and assertions are retained. */
export function registerFullSuiteDesignCase(moduleUrl: string, name: string, options: TestOptions, body: () => Promise<void>): void {
  const scope = scopeFor(moduleUrl);
  if (!scope) { test(name, options, body); return; }
  const mapped = scope.ledger.claim(scope.file, name);
  if (mapped.kind === "external-containment") registerSingleReplacement(registerExternalContainmentCase, scope, mapped.external);
  else {
    assert.ok(scope.factoryCaptured, "Design factory must be captured before routed registration");
    if (mapped.kind === "unchanged-parent-write") test(name, options, () => scope.guard.run(body));
    else { assert.equal(mapped.kind, "unchanged-preflight"); test(name, options, body); }
  }
}

/** Explicit reviewed complete-suite entry. A separately pinned owner launch
 * module top-level-awaits this function with independent code pins, in a fresh
 * process with --test --experimental-test-isolation=none. No argv/ENV selection,
 * injectable loader/importer/factory/root, fallback or automatic activation.
 * Any discovery/import/mapping failure rejects the entry and fails the run,
 * even if Node has already begun executing registered cases. */
export async function registerReviewedDesignScriptFullSuite(pins: ReviewedAgentdDesignPins) {
  try {
    assert.equal(entryStarted, false, "Reviewed full suite may only start once in a fresh process");
    assert.equal(standaloneRegistrations.size, 0, "Standalone design modules were already registered; start a fresh process");
    entryStarted = true;
    const backend = await loadReviewedAgentdDesignExecution(pins);
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files = await discoverFullSuiteTestFiles(root);
    const ledger = createFullSuiteMappingLedger(files.map(item => item.path));
    const guard = createExternalParentWriteGuard(createExternalDesignScriptPilotToolFactory(backend));
    let factoryCaptured = false;
    for (const item of files) {
      const scope: RegistrationScope = { file: item.path, url: pathToFileURL(path.join(root, item.path)).href, ledger, guard, open: true, factoryCaptured: false };
      try { await registration.run(scope, () => import(scope.url)); }
      finally { scope.open = false; }
      if (item.path === "dist/test/agent/tools.test.js") factoryCaptured = scope.factoryCaptured;
    }
    assert.ok(factoryCaptured, "Missing design factory registration (possibly preloaded module)");
    return Object.freeze({ files, mapping: ledger.finish() });
  } catch (error) {
    // Node's isolation=none runner can discard a late entry-import rejection
    // after other tests registered. A failing test makes that outcome explicit
    // in TAP and the process exit; rejection alone is not a fail-closed gate.
    test("reviewed full-suite registration failed", () => { throw error; });
    throw error;
  }
}
