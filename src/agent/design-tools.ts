import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  relativeWorkspacePath,
  resolveWorkspaceWritablePath
} from "./file-tools.js";
import { sanitizeWikiFilename } from "./wiki/store.js";

const writeDesignArtifactParameters = Type.Object({
  artifactType: Type.Union([
    Type.Literal("design_record"),
    Type.Literal("verification_report"),
    Type.Literal("failure_record"),
    Type.Literal("benchmark_case")
  ], {
    description:
      "Design artifact type. Use design_record for proposals, verification_report for checks, failure_record for failed attempts, and benchmark_case for reusable evaluation tasks."
  }),
  title: Type.String({ description: "Human-readable artifact title." }),
  artifactKey: Type.Optional(
    Type.String({
      description:
        "Optional filename-safe artifact key. Defaults to a sanitized title."
    })
  ),
  status: Type.Optional(
    Type.Union([
      Type.Literal("proposed"),
      Type.Literal("source-supported"),
      Type.Literal("tool-verified"),
      Type.Literal("expert-approved"),
      Type.Literal("assumed"),
      Type.Literal("unsupported"),
      Type.Literal("failed")
    ], {
      description:
        "Verification status for the artifact. Defaults to proposed."
    })
  ),
  contentMarkdown: Type.String({
    description:
      "Full grounded markdown body. Include design goal, assumptions, evidence, checks, failure mode/root cause when applicable, reusable lesson, and open questions."
  }),
  relatedWikiPages: Type.Optional(
    Type.Array(Type.String({ description: "Related wiki synthesis page key." }))
  ),
  sourceKeys: Type.Optional(
    Type.Array(Type.String({ description: "Related wiki source summary or parsed paper key." }))
  )
});

type WriteDesignArtifactParameters = Static<typeof writeDesignArtifactParameters>;

const DESIGN_ARTIFACT_DIRECTORIES: Record<WriteDesignArtifactParameters["artifactType"], string> = {
  design_record: "design-records",
  verification_report: "verification-reports",
  failure_record: "failures",
  benchmark_case: "benchmark-cases"
};

function formatFrontmatterString(value: string): string {
  return JSON.stringify(value);
}

function formatFrontmatterList(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) {
    return "[]";
  }
  return `\n${values.map((value) => `  - ${formatFrontmatterString(value)}`).join("\n")}`;
}

function formatDesignArtifactMarkdown(args: WriteDesignArtifactParameters): string {
  const status = args.status ?? "proposed";
  const relatedWikiPages = args.relatedWikiPages ?? [];
  const sourceKeys = args.sourceKeys ?? [];
  return `---
type: ${args.artifactType}
title: ${formatFrontmatterString(args.title)}
status: ${status}
created_at: ${new Date().toISOString()}
related_wiki_pages:${formatFrontmatterList(relatedWikiPages)}
source_keys:${formatFrontmatterList(sourceKeys)}
---

# ${args.title}

${args.contentMarkdown.trimEnd()}
`;
}

async function writeDesignArtifact(
  workspaceDir: string,
  args: WriteDesignArtifactParameters
): Promise<{ artifactType: WriteDesignArtifactParameters["artifactType"]; path: string; bytes: number; title: string }> {
  const artifactKey = sanitizeWikiFilename(args.artifactKey ?? args.title);
  const directory = DESIGN_ARTIFACT_DIRECTORIES[args.artifactType];
  const relativePath = `knowledge-base/design-records/${directory}/${artifactKey}.md`;
  const resolvedPath = await resolveWorkspaceWritablePath(workspaceDir, relativePath);
  const content = formatDesignArtifactMarkdown(args);
  await writeFile(resolvedPath, content, "utf8");
  return {
    artifactType: args.artifactType,
    path: relativeWorkspacePath(workspaceDir, resolvedPath),
    bytes: Buffer.byteLength(content, "utf8"),
    title: args.title
  };
}

type WriteDesignArtifactTool = AgentTool<
  typeof writeDesignArtifactParameters,
  Awaited<ReturnType<typeof writeDesignArtifact>>
>;

export function createDesignTools(input: {
  workspaceDir: string;
}): {
  fullTools: AgentTool<any>[];
} {
  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);
  const writeDesignArtifactTool: WriteDesignArtifactTool = {
    name: "write_design_artifact",
    label: "Write Design Artifact",
    description:
      "Writes a structured chip-design artifact under knowledge-base/design-records/. Use this for minimal design-subagent outputs: design records, verification reports, failure records, and benchmark cases. This tool cannot write wiki pages, paper source summaries, or arbitrary workspace files.",
    parameters: writeDesignArtifactParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: WriteDesignArtifactParameters) => {
      const result = await writeDesignArtifact(resolvedWorkspaceDir, args);

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  return {
    fullTools: [writeDesignArtifactTool]
  };
}
