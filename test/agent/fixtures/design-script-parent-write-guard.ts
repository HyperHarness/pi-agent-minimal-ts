import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalDesignJson, designSha256, getDesignExecutionFailureEvidence } from "../../../src/agent/design-script-execution.js";
import type { DesignScriptCaseToolFactory } from "./design-script-original-cases.js";

const parentCallId = "call-run-design-script-parent-write";
const parentScriptPath = "scripts/absolute_parent_write.py";

/** A case-local postcondition around the unchanged broad-regex legacy callback.
 * This creates no global selection and grants no authority to its supplied
 * factory. The reviewed suite supplies its already verified closed-over factory;
 * offline tests supply explicitly synthetic factories. */
export function createExternalParentWriteGuard(factory: DesignScriptCaseToolFactory) {
  const calls = new AsyncLocalStorage<{ attempted: number; verified: number; open: boolean }>();
  return Object.freeze({
    factory: ((workspace: string) => {
      const tool = factory(workspace);
      return { execute: async (id, args, signal) => {
        if (id !== parentCallId) return tool.execute(id, args, signal);
        const record = calls.getStore();
        assert.ok(record?.open, "Parent-write call requires its active case postcondition");
        record.attempted++;
        const project = path.join(workspace, "design-repo", "design-code");
        const target = path.join(workspace, "package.json");
        assert.deepEqual(args, { scriptPath: `design-repo/design-code/${parentScriptPath}`, runner: "python" });
        const expectedScript = [
          "from pathlib import Path", `workspace = Path(${JSON.stringify(workspace)})`,
          "(workspace / 'package.json').write_text('{\"name\":\"mutated\"}\\n')", "",
        ].join("\n");
        const script = await readFile(path.join(project, parentScriptPath), "utf8");
        assert.equal(script, expectedScript, "Parent-write fixture must retain its exact attempted operation");
        const root = await readFile(path.join(workspace, ".venv", "bin", "python"));
        const projectBytes = await readFile(path.join(project, "pyproject.toml"));
        assert.equal(root.toString("utf8"), '#!/bin/sh\nexec python3 "$@"\n', "Parent-write must use the original root shim bytes");
        assert.equal(projectBytes.toString("utf8"), '[project]\nname = "pi-chip-design"\n', "Parent-write must use the original project bytes");
        const rootSha = designSha256(root);
        const manifest = {
          files: [["pyproject.toml", projectBytes], [parentScriptPath, Buffer.from(script)]].map(([name, bytes]) => ({
            path: name as string, executable: false, size: (bytes as Buffer).length, sha256: designSha256(bytes as Buffer),
          })),
          root_entry: { size: root.length, sha256: rootSha },
        };
        try {
          await tool.execute(id, args, signal);
        } catch (error) {
          assert.ok(error instanceof Error);
          const evidence = getDesignExecutionFailureEvidence(error);
          assert.ok(evidence, "Parent-write requires validated adapter evidence");
          assert.equal(evidence.status, "script_failed");
          assert.equal(evidence.exitCode, 1);
          assert.deepEqual(evidence.closure, { launcherReaped: true, descendantsStopped: true, outputFrozen: false });
          assert.equal(evidence.scriptPath, parentScriptPath);
          assert.equal(evidence.scriptSha256, designSha256(script));
          assert.equal(evidence.inputManifestSha256, designSha256(canonicalDesignJson(manifest)));
          assert.equal(evidence.rootEntrySha256, rootSha);
          assert.ok(error.message.startsWith("run_design_script external-agentd script_failed: stderr:\n"));
          const lines = error.message.trimEnd().split("\n");
          assert.equal(lines.at(-1), `FileNotFoundError: [Errno 2] No such file or directory: '${target}'`);
          record.verified++;
          throw error;
        }
        assert.fail("Parent-write unexpectedly completed");
      } };
    }) satisfies DesignScriptCaseToolFactory,
    async run(body: () => Promise<void>): Promise<void> {
      const record = { attempted: 0, verified: 0, open: true };
      try {
        await calls.run(record, body);
        // This assertion is deliberately OUTSIDE the legacy callback. That
        // callback may accept arbitrary errors containing bwrap/tool names.
        assert.deepEqual({ attempted: record.attempted, verified: record.verified }, { attempted: 1, verified: 1 }, "Parent-write did not prove exactly one bound external script failure");
      } finally { record.open = false; }
    },
  });
}
