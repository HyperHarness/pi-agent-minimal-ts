import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeChatPromptToWorker } from "../../src/agent/agent-routing.js";
import { createTools, createToolsForBoundary, getToolBoundaryToolNames } from "../../src/agent/tools.js";

type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
};

type PaperOrchestraPrepareWorkspaceTool = {
  execute: (
    toolCallId: string,
    args: { workspacePath: string; createMissing?: boolean },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type PaperOrchestraCheckDraftTool = {
  execute: (
    toolCallId: string,
    args: { workspacePath: string; texPath?: string; bibPath?: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type PaperOrchestraScoreDeltaTool = {
  execute: (
    toolCallId: string,
    args: {
      previousScorePath: string;
      currentScorePath: string;
      plateauThreshold?: number;
      plateauStreak?: number;
      consecutiveSmall?: number;
    },
    signal: undefined,
  ) => Promise<ToolResult>;
};

type PaperOrchestraSnapshotProvenanceTool = {
  execute: (
    toolCallId: string,
    args: { workspacePath: string },
    signal: undefined,
  ) => Promise<ToolResult>;
};

function getPaperOrchestraPrepareWorkspaceTool(workspace: string): PaperOrchestraPrepareWorkspaceTool {
  const tools = createTools(workspace, { toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: PaperOrchestraPrepareWorkspaceTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "paper_orchestra_prepare_workspace");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as PaperOrchestraPrepareWorkspaceTool;
}

function getPaperOrchestraCheckDraftTool(workspace: string): PaperOrchestraCheckDraftTool {
  const tools = createTools(workspace, { toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: PaperOrchestraCheckDraftTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "paper_orchestra_check_draft");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as PaperOrchestraCheckDraftTool;
}

function getPaperOrchestraScoreDeltaTool(workspace: string): PaperOrchestraScoreDeltaTool {
  const tools = createTools(workspace, { toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: PaperOrchestraScoreDeltaTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "paper_orchestra_score_delta");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as PaperOrchestraScoreDeltaTool;
}

function getPaperOrchestraSnapshotProvenanceTool(workspace: string): PaperOrchestraSnapshotProvenanceTool {
  const tools = createTools(workspace, { toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: PaperOrchestraSnapshotProvenanceTool["execute"];
  }>;
  const tool = tools.find((candidate) => candidate.name === "paper_orchestra_snapshot_provenance");
  assert.ok(tool);
  assert.equal(typeof tool.execute, "function");
  return tool as PaperOrchestraSnapshotProvenanceTool;
}

test("paper_orchestra_prepare_workspace creates the controlled workspace layout and reports missing required inputs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-paper-orchestra-"));

  try {
    const tool = getPaperOrchestraPrepareWorkspaceTool(workspace);
    const result = await tool.execute(
      "call-prepare",
      { workspacePath: "paper-projects/demo/paper-orchestra", createMissing: true },
      undefined,
    );

    assert.deepEqual(result.details, {
      workspacePath: "paper-projects/demo/paper-orchestra",
      createdDirectories: [
        "paper-projects/demo/paper-orchestra/inputs",
        "paper-projects/demo/paper-orchestra/inputs/figures",
        "paper-projects/demo/paper-orchestra/figures",
        "paper-projects/demo/paper-orchestra/drafts",
        "paper-projects/demo/paper-orchestra/refinement",
        "paper-projects/demo/paper-orchestra/final",
      ],
      requiredInputs: [
        "inputs/idea.md",
        "inputs/experimental_log.md",
        "inputs/template.tex",
        "inputs/conference_guidelines.md",
      ],
      missingInputs: [
        "inputs/idea.md",
        "inputs/experimental_log.md",
        "inputs/template.tex",
        "inputs/conference_guidelines.md",
      ],
      ready: false,
    });
    assert.match(result.content?.[0]?.text ?? "", /missing 4 required input/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("paper_orchestra_check_draft reports citation, latex, and anonymity gate failures without editing files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-paper-orchestra-"));
  const draftDir = path.join(workspace, "paper-projects", "demo", "paper-orchestra", "drafts");
  await mkdir(draftDir, { recursive: true });
  const paperPath = path.join(draftDir, "paper.tex");
  await writeFile(
    paperPath,
    [
      "\\section{Method}",
      "Contact corresponding author at author@example.com.",
      "This uses prior work \\cite{missingKey}.",
      "\\begin{figure}",
      "\\caption{Unclosed environment}",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(workspace, "paper-projects", "demo", "paper-orchestra", "refs.bib"), "", "utf8");

  try {
    const tool = getPaperOrchestraCheckDraftTool(workspace);
    const result = await tool.execute(
      "call-check",
      {
        workspacePath: "paper-projects/demo/paper-orchestra",
        texPath: "paper-projects/demo/paper-orchestra/drafts/paper.tex",
        bibPath: "paper-projects/demo/paper-orchestra/refs.bib",
      },
      undefined,
    );

    assert.deepEqual(result.details, {
      workspacePath: "paper-projects/demo/paper-orchestra",
      texPath: "paper-projects/demo/paper-orchestra/drafts/paper.tex",
      bibPath: "paper-projects/demo/paper-orchestra/refs.bib",
      status: "failed",
      checks: {
        orphanCitations: {
          status: "failed",
          missingKeys: ["missingKey"],
          citedKeys: ["missingKey"],
          bibKeys: [],
        },
        latexSanity: {
          status: "failed",
          errors: ["Unclosed LaTeX environment: figure"],
        },
        antiLeakage: {
          status: "failed",
          matches: ["email address", "corresponding author"],
        },
      },
    });
    assert.equal(await readFile(paperPath, "utf8"), [
      "\\section{Method}",
      "Contact corresponding author at author@example.com.",
      "This uses prior work \\cite{missingKey}.",
      "\\begin{figure}",
      "\\caption{Unclosed environment}",
    ].join("\n"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("paper_orchestra_score_delta applies PaperOrchestra accept, revert, and plateau decisions", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-paper-orchestra-"));
  const scoreDir = path.join(workspace, "paper-projects", "demo", "paper-orchestra", "refinement");
  await mkdir(scoreDir, { recursive: true });
  await writeFile(
    path.join(scoreDir, "previous.json"),
    JSON.stringify({
      overall_score: 70,
      axis_scores: {
        scientific_depth: { score: 70 },
        writing_clarity: { score: 70 },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(scoreDir, "current.json"),
    JSON.stringify({
      overall_score: 70.5,
      axis_scores: {
        scientific_depth: { score: 70 },
        writing_clarity: { score: 70.5 },
      },
    }),
    "utf8",
  );

  try {
    const tool = getPaperOrchestraScoreDeltaTool(workspace);
    const result = await tool.execute(
      "call-delta",
      {
        previousScorePath: "paper-projects/demo/paper-orchestra/refinement/previous.json",
        currentScorePath: "paper-projects/demo/paper-orchestra/refinement/current.json",
        plateauThreshold: 1,
        plateauStreak: 3,
        consecutiveSmall: 2,
      },
      undefined,
    );

    assert.deepEqual(result.details, {
      decision: "halt_plateau",
      reason: "accepted_but_plateau_reached",
      previousOverall: 70,
      currentOverall: 70.5,
      overallDelta: 0.5,
      netSubaxisDelta: 0.5,
      consecutiveSmall: 3,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("paper_orchestra_snapshot_provenance writes hashes for inputs and final artifacts", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-paper-orchestra-"));
  const orchestraDir = path.join(workspace, "paper-projects", "demo", "paper-orchestra");
  await mkdir(path.join(orchestraDir, "inputs"), { recursive: true });
  await mkdir(path.join(orchestraDir, "final"), { recursive: true });
  await writeFile(path.join(orchestraDir, "inputs", "idea.md"), "## Problem Statement\nDemo.\n", "utf8");
  await writeFile(path.join(orchestraDir, "inputs", "experimental_log.md"), "# Experimental Log\n", "utf8");
  await writeFile(path.join(orchestraDir, "inputs", "template.tex"), "\\documentclass{article}\n", "utf8");
  await writeFile(path.join(orchestraDir, "inputs", "conference_guidelines.md"), "Page limit: 8\n", "utf8");
  await writeFile(path.join(orchestraDir, "refs.bib"), "@article{demo2026,title={Demo}}\n", "utf8");
  await writeFile(path.join(orchestraDir, "final", "paper.tex"), "\\section{Demo}\n", "utf8");

  try {
    const tool = getPaperOrchestraSnapshotProvenanceTool(workspace);
    const result = await tool.execute(
      "call-provenance",
      { workspacePath: "paper-projects/demo/paper-orchestra" },
      undefined,
    );

    assert.match(result.content?.[0]?.text ?? "", /Wrote/);
    assert.deepEqual(result.details, {
      workspacePath: "paper-projects/demo/paper-orchestra",
      provenancePath: "paper-projects/demo/paper-orchestra/provenance.json",
      inputCount: 4,
      figureCount: 0,
      finalCount: 1,
      bibEntryCount: 1,
    });

    const provenance = JSON.parse(await readFile(path.join(orchestraDir, "provenance.json"), "utf8"));
    assert.equal(provenance.inputs["idea.md"].bytes, Buffer.byteLength("## Problem Statement\nDemo.\n"));
    assert.match(provenance.inputs["idea.md"].sha256, /^[0-9a-f]{64}$/);
    assert.equal(provenance.refs_bib.n_entries, 1);
    assert.equal(provenance.skill_versions["paper-orchestra"], "PaperOrchestra-inspired controlled writing workflow");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("paper-writing-worker boundary exposes PaperOrchestra writing tools without acquisition or wiki-page permissions", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-paper-orchestra-"));

  try {
    const names = getToolBoundaryToolNames("paper-writing-worker");
    assert.ok(names.includes("paper_orchestra_prepare_workspace"));
    assert.ok(names.includes("paper_orchestra_check_draft"));
    assert.ok(names.includes("paper_orchestra_score_delta"));
    assert.ok(names.includes("paper_orchestra_snapshot_provenance"));
    assert.ok(!names.includes("web_search"));
    assert.ok(!names.includes("download_paper"));
    assert.ok(!names.includes("build_wiki_page"));

    const boundaryTools = createToolsForBoundary(workspace, "paper-writing-worker");
    assert.deepEqual(boundaryTools.map((tool) => tool.name), names);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("PaperOrchestra paper generation requests route to the paper-writing worker", () => {
  assert.deepEqual(routeChatPromptToWorker("run PaperOrchestra on paper-projects/demo"), {
    role: "paper-writing-worker",
    instruction: "run PaperOrchestra on paper-projects/demo",
    reason: "intent",
  });
  assert.deepEqual(routeChatPromptToWorker("请用paper-orchestra写完整论文"), {
    role: "paper-writing-worker",
    instruction: "请用paper-orchestra写完整论文",
    reason: "intent",
  });
});
