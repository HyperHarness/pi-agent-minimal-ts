import assert from "node:assert/strict";
import { loadReviewedAgentdDesignExecution, type ReviewedAgentdDesignPins } from "../../src/agent/agentd-design-entrypoint.js";
import { assertDesignScriptExecution, type AgentdDesignExecution } from "../../src/agent/design-script-execution.js";
import { createTools } from "../../src/agent/tools.js";
import { type DesignScriptCaseToolFactory, type RunDesignScriptCaseTool } from "./fixtures/design-script-original-cases.js";
import { registerExternalDesignScriptCases } from "./fixtures/design-script-external-canary-case.js";

/** Test-only factory for an explicitly supplied, already configured backend.
 * Factory provenance is checked, but only the reviewed loader/helper and live
 * controller can authenticate execution. Synthetic test helpers are not proof. */
export function createExternalDesignScriptPilotToolFactory(backend: AgentdDesignExecution): DesignScriptCaseToolFactory {
  if (backend?.mode !== "external-agentd") throw new Error("The reviewed pilot requires an explicit external-agentd backend");
  assertDesignScriptExecution(backend);
  return workspace => {
    const tool = createTools(workspace, { toolProfile: "full", designScriptExecution: backend }).find(tool => tool.name === "run_design_script");
    assert.ok(tool);
    assert.equal(typeof tool.execute, "function");
    return tool as RunDesignScriptCaseTool;
  };
}

/** Called with independent code pins by a separately reviewed fixed test entry.
 * This module is deliberately not a *.test file and has no import-time tests,
 * CLI/ENV activation, fallback, or caller-provided loader. Top-level await this
 * function in that entry before Node completes test registration. This selected
 * pilot contains two unchanged originals plus one external-specific direct-write
 * case, never three unchanged originals or a full-suite acceptance result.
 * Owner-side pinned execution, controller journal/status-FD and verified closure
 * are still required; script markers and adapter data alone cannot prove them. */
export async function registerReviewedDesignScriptPilot(pins: ReviewedAgentdDesignPins): Promise<void> {
  const backend = await loadReviewedAgentdDesignExecution(pins);
  registerExternalDesignScriptCases(createExternalDesignScriptPilotToolFactory(backend));
}
