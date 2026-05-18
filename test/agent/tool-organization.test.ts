import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";

import {
  createPaperTools,
  paperReaderEngineParameter
} from "../../src/agent/paper/tools.js";
import { createLibraryHealthTools } from "../../src/agent/library-health-tools.js";
import { createWikiTools } from "../../src/agent/wiki/tools.js";

const stubTool = (name: string): AgentTool<any> => ({
  name,
  label: name,
  description: name,
  parameters: { type: "object", properties: {} },
  execute: async () => ({
    content: [{ type: "text", text: "{}" }],
    details: {}
  })
});

test("paper tool adapter is exported from the paper domain directory", () => {
  assert.equal(typeof createPaperTools, "function");
  assert.equal(paperReaderEngineParameter.anyOf?.length, 6);
});

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(entryPath);
    }
    return entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

test("tool adapters avoid obsolete top-level compatibility files", () => {
  const legacyPaperToolsPath = path.join(process.cwd(), "src/agent/paper-tools.ts");
  const legacyDesignToolsPath = path.join(process.cwd(), "src/agent/design-tools.ts");
  const legacyToolBoundariesPath = path.join(process.cwd(), "src/agent/tool-boundaries.ts");
  const sourceFiles = listTypeScriptFiles(path.join(process.cwd(), "src"));

  assert.equal(existsSync(legacyPaperToolsPath), false);
  assert.equal(existsSync(legacyDesignToolsPath), false);
  assert.equal(existsSync(legacyToolBoundariesPath), false);
  assert.ok(sourceFiles.length <= 108, `expected at most 108 src files, found ${sourceFiles.length}`);
});

test("wiki and library health tool factories expose named default groups for registry assembly", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tool-organization-"));

  try {
    const wikiTools = createWikiTools({
      workspaceDir: workspace,
      dependencies: {},
      searchPapersTool: stubTool("search_papers"),
      downloadPaperTool: stubTool("download_paper"),
      parsePaperTool: stubTool("parse_paper")
    });
    const libraryHealthTools = createLibraryHealthTools({
      workspaceDir: workspace,
      dependencies: {}
    });

    assert.deepEqual(
      wikiTools.defaultToolGroups.coreTools.map((tool) => tool.name),
      wikiTools.defaultTools
        .slice(0, -wikiTools.defaultToolGroups.lintTools.length)
        .map((tool) => tool.name)
    );
    assert.deepEqual(
      wikiTools.defaultToolGroups.lintTools.map((tool) => tool.name),
      ["wiki_lint", "wiki_structure_plan", "wiki_apply_structure_plan"]
    );
    assert.deepEqual(
      libraryHealthTools.defaultToolGroups.searchTools.map((tool) => tool.name),
      ["search_local_papers"]
    );
    assert.deepEqual(
      libraryHealthTools.defaultToolGroups.healthCheckTools.map((tool) => tool.name),
      ["wiki_health"]
    );
    assert.deepEqual(
      libraryHealthTools.defaultToolGroups.healthRepairTools.map((tool) => tool.name),
      ["wiki_health_fix"]
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
