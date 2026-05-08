import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentTools, ToolDependencies, ToolSetMetadata } from "./tool-types.js";
export type { AgentTools, ToolDependencies } from "./tool-types.js";
import { createFileTools } from "./file-tools.js";
import { createWebTools } from "./web-tools.js";
import { createDesignTools } from "./design-tools.js";
import { createLibraryHealthTools } from "./library-health-tools.js";
import { createPaperTools } from "./paper-tools.js";
import { createWikiTools } from "./wiki-tools.js";
import {
  getToolBoundaryToolNames as getToolBoundaryToolNamesFromBoundaryModule,
  TOOL_BOUNDARY_NAMES,
  type ToolBoundaryRole
} from "./tool-boundaries.js";

export async function cleanupTools(tools: ReadonlyArray<AgentTool<any>> | undefined): Promise<void> {
  const cleanup = (tools as Partial<ToolSetMetadata> | undefined)?.cleanup;
  if (typeof cleanup === "function") {
    await cleanup();
  }
}

export function getToolsWorkspaceDir(
  tools: ReadonlyArray<AgentTool<any>> | undefined
): string | undefined {
  const workspaceDir = (tools as Partial<ToolSetMetadata> | undefined)?.workspaceDir;
  return typeof workspaceDir === "string" ? workspaceDir : undefined;
}

export function createTools(workspaceDir: string, dependencies: ToolDependencies = {}): AgentTools {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const fileTools = createFileTools({ workspaceDir: resolvedWorkspaceDir });
  const webTools = createWebTools({
    workspaceDir: resolvedWorkspaceDir,
    dependencies
  });
  const designTools = createDesignTools({
    workspaceDir: resolvedWorkspaceDir
  });
  const paperTools = createPaperTools({
    workspaceDir: resolvedWorkspaceDir,
    dependencies
  });
  const wikiTools = createWikiTools({
    workspaceDir: resolvedWorkspaceDir,
    dependencies,
    searchPapersTool: paperTools.toolsByName.searchPapersTool,
    downloadPaperTool: paperTools.toolsByName.downloadPaperTool,
    parsePaperTool: paperTools.toolsByName.parsePaperTool
  });
  const libraryHealthTools = createLibraryHealthTools({
    workspaceDir: resolvedWorkspaceDir,
    dependencies
  });

  const tools = [
    ...fileTools.defaultTools,
    ...webTools.defaultTools,
    ...paperTools.defaultTools,
    ...wikiTools.defaultTools.slice(0, -1),
    ...libraryHealthTools.defaultTools.slice(0, 2),
    ...wikiTools.defaultTools.slice(-1),
    ...libraryHealthTools.defaultTools.slice(2)
  ] as unknown as AgentTools;

  if (dependencies.toolProfile === "full") {
    tools.unshift(...fileTools.prependFullTools);
    tools.push(
      ...wikiTools.fullTools,
      ...designTools.fullTools,
      ...fileTools.tailFullTools,
      ...libraryHealthTools.fullTools,
      ...webTools.fullTools,
      ...paperTools.fullTools
    );
  }

  const cleanupCallbacks = [
    paperTools.cleanup
  ];

  Object.defineProperties(tools, {
    cleanup: {
      enumerable: false,
      value: async () => {
        for (const cleanup of cleanupCallbacks) {
          await cleanup();
        }
      }
    },
    workspaceDir: {
      enumerable: false,
      value: resolvedWorkspaceDir
    }
  });

  return tools;
}

export type { ToolBoundaryRole, ToolProfile } from "./tool-boundaries.js";

export function getToolBoundaryToolNames(role: ToolBoundaryRole): string[] {
  return getToolBoundaryToolNamesFromBoundaryModule(role);
}

export function createToolsForBoundary(
  workspaceDir: string,
  role: ToolBoundaryRole,
  dependencies: ToolDependencies = {}
): AgentTools {
  const boundaryNames = new Set(TOOL_BOUNDARY_NAMES[role]);
  const baseTools = createTools(workspaceDir, {
    ...dependencies,
    toolProfile: "full",
    ...(role === "wiki-agent"
      ? { allowBuildWikiPageExternalEvidence: false }
      : {})
  });
  const toolsByName = new Map(baseTools.map((tool) => [tool.name, tool]));
  const tools = [...boundaryNames]
    .map((name) => toolsByName.get(name))
    .filter((tool): tool is AgentTool<any> => Boolean(tool)) as unknown as AgentTools;

  Object.defineProperties(tools, {
    cleanup: {
      enumerable: false,
      value: baseTools.cleanup
    },
    workspaceDir: {
      enumerable: false,
      value: baseTools.workspaceDir
    }
  });

  return tools;
}
