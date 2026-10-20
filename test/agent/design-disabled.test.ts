import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentContext } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { main as designMain } from "../../src/design-agent.js";
import { main, resolveAgentEntrypointProfile } from "../../src/agent/agent-cli.js";
import { runAgentTurn } from "../../src/agent/agent-runtime.js";
import { routeChatPromptToWorker, systemPromptForWorker } from "../../src/agent/agent-routing.js";
import { createFileTools } from "../../src/agent/file-tools.js";
import { cleanupTools, createTools, createToolsForBoundary } from "../../src/agent/tools.js";
import { RETIRED_DESIGN_TOOL_NAMES } from "../../src/agent/tool-types.js";

test("legacy design entries reject before model selection, including help", async () => {
  await assert.rejects(main({ profile: "design-agent", argv: ["--help"] }), /disabled/);
  await assert.rejects(designMain({ argv: ["--help"] }), /disabled/);
  assert.throws(() => resolveAgentEntrypointProfile("design-agent", "/unused", undefined as unknown as Model<Api>), /disabled/);
  const result = spawnSync(process.execPath, [new URL("../../src/design-agent.js", import.meta.url).pathname, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dedicated tools are disabled/);
  assert.equal(result.stdout, "");
});

test("all built-in tool factories omit design tools and reject legacy boundaries", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-design-disabled-"));
  try {
    const groups = createFileTools({ workspaceDir: workspace });
    const direct = Object.values(groups).flat();
    for (const name of RETIRED_DESIGN_TOOL_NAMES) assert.equal(direct.some(tool => tool.name === name), false, name);
    for (const toolProfile of ["default", "full"] as const) {
      const tools = createTools(workspace, { toolProfile });
      try {
        for (const name of RETIRED_DESIGN_TOOL_NAMES) assert.equal(tools.some(tool => tool.name === name), false, name);
        assert.ok(tools.some(tool => tool.name === "read_file"));
      } finally { await cleanupTools(tools); }
    }
    for (const role of ["design-agent", "design-subagent"] as const) {
      assert.throws(() => createToolsForBoundary(workspace, role), /disabled/);
      assert.throws(() => systemPromptForWorker(role), /disabled/);
    }
    for (const prompt of ["design-agent run layout", "/design-subagent run layout", "design write failure record", "请运行 design-code 脚本", "安装 gdsfactory python 包"]) {
      assert.equal(routeChatPromptToWorker(prompt), null, prompt);
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("a cached or injected retired tool is rejected before any model call", async () => {
  for (const name of RETIRED_DESIGN_TOOL_NAMES) {
    const context = { systemPrompt: "legacy", messages: [], tools: [{ name }] } as unknown as AgentContext;
    await assert.rejects(runAgentTurn({ model: undefined as unknown as Model<Api>, workspaceDir: "/unused", context, prompt: "run" }), /disabled/);
    assert.deepEqual(context.messages, []);
  }
});
