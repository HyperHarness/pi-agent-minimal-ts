import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  checkPaperOrchestraDraft,
  computePaperOrchestraScoreDelta,
  preparePaperOrchestraWorkspace,
  snapshotPaperOrchestraProvenance,
  type DraftGateResult,
  type PreparePaperOrchestraWorkspaceResult,
  type ProvenanceResult,
  type ScoreDeltaResult,
} from "./paper-orchestra.js";

const paperOrchestraPrepareWorkspaceParameters = Type.Object({
  workspacePath: Type.String({
    description:
      "Workspace-relative PaperOrchestra writing workspace path, for example paper-projects/current/paper-orchestra.",
  }),
  createMissing: Type.Optional(
    Type.Boolean({
      description: "Create the controlled PaperOrchestra directory layout before validating inputs. Defaults to false.",
    }),
  ),
});

const paperOrchestraCheckDraftParameters = Type.Object({
  workspacePath: Type.String({
    description: "Workspace-relative PaperOrchestra writing workspace path.",
  }),
  texPath: Type.Optional(
    Type.String({
      description:
        "Optional workspace-relative draft .tex path. Defaults to <workspacePath>/drafts/paper.tex and must stay inside workspacePath.",
    }),
  ),
  bibPath: Type.Optional(
    Type.String({
      description:
        "Optional workspace-relative BibTeX path. Defaults to <workspacePath>/refs.bib and must stay inside workspacePath.",
    }),
  ),
});

const paperOrchestraScoreDeltaParameters = Type.Object({
  previousScorePath: Type.String({
    description: "Workspace-relative JSON score file for the previous accepted draft.",
  }),
  currentScorePath: Type.String({
    description: "Workspace-relative JSON score file for the current draft.",
  }),
  plateauThreshold: Type.Optional(
    Type.Number({
      description:
        "Absolute overall-score delta below which the refinement loop counts a small improvement. Defaults to 1.",
      minimum: 0,
    }),
  ),
  plateauStreak: Type.Optional(
    Type.Integer({
      description: "Number of consecutive small deltas that should halt the refinement loop. Defaults to 3.",
      minimum: 1,
    }),
  ),
  consecutiveSmall: Type.Optional(
    Type.Integer({
      description: "Current consecutive-small-delta streak before comparing these two scores. Defaults to 0.",
      minimum: 0,
    }),
  ),
});

const paperOrchestraSnapshotProvenanceParameters = Type.Object({
  workspacePath: Type.String({
    description: "Workspace-relative PaperOrchestra writing workspace path.",
  }),
});

type PaperOrchestraPrepareWorkspaceParameters = Static<typeof paperOrchestraPrepareWorkspaceParameters>;
type PaperOrchestraCheckDraftParameters = Static<typeof paperOrchestraCheckDraftParameters>;
type PaperOrchestraScoreDeltaParameters = Static<typeof paperOrchestraScoreDeltaParameters>;
type PaperOrchestraSnapshotProvenanceParameters = Static<typeof paperOrchestraSnapshotProvenanceParameters>;

type PaperOrchestraPrepareWorkspaceTool = AgentTool<
  typeof paperOrchestraPrepareWorkspaceParameters,
  PreparePaperOrchestraWorkspaceResult
>;
type PaperOrchestraCheckDraftTool = AgentTool<typeof paperOrchestraCheckDraftParameters, DraftGateResult>;
type PaperOrchestraScoreDeltaTool = AgentTool<typeof paperOrchestraScoreDeltaParameters, ScoreDeltaResult>;
type PaperOrchestraSnapshotProvenanceTool = AgentTool<
  typeof paperOrchestraSnapshotProvenanceParameters,
  ProvenanceResult
>;

export function createWritingTools(input: {
  workspaceDir: string;
}): {
  fullTools: AgentTool<any>[];
} {
  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);

  const prepareWorkspaceTool: PaperOrchestraPrepareWorkspaceTool = {
    name: "paper_orchestra_prepare_workspace",
    label: "Prepare PaperOrchestra Workspace",
    description:
      "Creates and validates the controlled PaperOrchestra writing workspace layout. It only touches manuscript workspace files and never downloads papers or writes wiki pages.",
    parameters: paperOrchestraPrepareWorkspaceParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: PaperOrchestraPrepareWorkspaceParameters) => {
      const result = await preparePaperOrchestraWorkspace({
        workspaceDir: resolvedWorkspaceDir,
        workspacePath: args.workspacePath,
        createMissing: args.createMissing ?? false,
      });
      const text = result.ready
        ? `PaperOrchestra workspace ready: ${result.workspacePath}.`
        : `PaperOrchestra workspace ${result.workspacePath} is missing ${result.missingInputs.length} required input(s): ${result.missingInputs.join(", ")}.`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  };

  const checkDraftTool: PaperOrchestraCheckDraftTool = {
    name: "paper_orchestra_check_draft",
    label: "Check PaperOrchestra Draft",
    description:
      "Runs deterministic writing gates on a PaperOrchestra LaTeX draft: orphan citations, lightweight LaTeX sanity, and anonymous anti-leakage checks.",
    parameters: paperOrchestraCheckDraftParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: PaperOrchestraCheckDraftParameters) => {
      const result = await checkPaperOrchestraDraft({
        workspaceDir: resolvedWorkspaceDir,
        workspacePath: args.workspacePath,
        texPath: args.texPath,
        bibPath: args.bibPath,
      });
      return {
        content: [{ type: "text", text: `PaperOrchestra draft gates ${result.status} for ${result.texPath}.` }],
        details: result,
      };
    },
  };

  const scoreDeltaTool: PaperOrchestraScoreDeltaTool = {
    name: "paper_orchestra_score_delta",
    label: "PaperOrchestra Score Delta",
    description:
      "Applies PaperOrchestra refinement-loop accept, revert, and plateau halt rules to two reviewer score JSON files.",
    parameters: paperOrchestraScoreDeltaParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: PaperOrchestraScoreDeltaParameters) => {
      const result = await computePaperOrchestraScoreDelta({
        workspaceDir: resolvedWorkspaceDir,
        previousScorePath: args.previousScorePath,
        currentScorePath: args.currentScorePath,
        plateauThreshold: args.plateauThreshold,
        plateauStreak: args.plateauStreak,
        consecutiveSmall: args.consecutiveSmall,
      });
      return {
        content: [{ type: "text", text: `PaperOrchestra refinement decision: ${result.decision} (${result.reason}).` }],
        details: result,
      };
    },
  };

  const snapshotProvenanceTool: PaperOrchestraSnapshotProvenanceTool = {
    name: "paper_orchestra_snapshot_provenance",
    label: "Snapshot PaperOrchestra Provenance",
    description:
      "Writes provenance.json for a PaperOrchestra writing workspace by hashing inputs, figures, refs.bib, and final artifacts.",
    parameters: paperOrchestraSnapshotProvenanceParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: PaperOrchestraSnapshotProvenanceParameters) => {
      const result = await snapshotPaperOrchestraProvenance({
        workspaceDir: resolvedWorkspaceDir,
        workspacePath: args.workspacePath,
      });
      return {
        content: [{ type: "text", text: `Wrote ${result.provenancePath}.` }],
        details: result,
      };
    },
  };

  return {
    fullTools: [
      prepareWorkspaceTool,
      checkDraftTool,
      scoreDeltaTool,
      snapshotProvenanceTool,
    ],
  };
}
