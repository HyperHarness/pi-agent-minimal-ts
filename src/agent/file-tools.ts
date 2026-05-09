import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { sanitizeWikiFilename } from "./wiki/store.js";

const execFileAsync = promisify(execFile);

const DEFAULT_READ_FILE_MAX_BYTES = 256 * 1024;
const HARD_READ_FILE_MAX_BYTES = 1024 * 1024;

const getTimeParameters = Type.Object({
  timezone: Type.Optional(Type.String({ description: "Optional IANA timezone name." }))
});

const loadPaperWritingSkillParameters = Type.Object({
  skillName: Type.Optional(
    Type.String({
      description: "Worker-local skill name under skills/paper-writing-worker/. Defaults to sciwrite."
    })
  )
});

const readFileParameters = Type.Object({
  path: Type.String({
    description: "UTF-8 text file path inside the workspace. Relative paths and workspace-absolute paths are accepted."
  }),
  offsetBytes: Type.Optional(
    Type.Integer({
      description: "Byte offset to start reading from. Defaults to 0.",
      minimum: 0
    })
  ),
  maxBytes: Type.Optional(
    Type.Integer({
      description:
        `Maximum bytes to return. Defaults to ${DEFAULT_READ_FILE_MAX_BYTES}; values above ${HARD_READ_FILE_MAX_BYTES} are clamped.`,
      minimum: 1
    })
  )
});

const listFilesParameters = Type.Object({
  path: Type.String({
    description:
      "Directory or file path inside the workspace to inspect. Relative paths and workspace-absolute paths are accepted."
  }),
  maxDepth: Type.Optional(
    Type.Integer({
      description: "Maximum recursive directory depth to list. Defaults to 2.",
      minimum: 0
    })
  ),
  maxEntries: Type.Optional(
    Type.Integer({
      description: "Maximum number of entries to return. Defaults to 200.",
      minimum: 1
    })
  )
});

const writeFileParameters = Type.Object({
  path: Type.String({
    description:
      "UTF-8 text file path inside the workspace to create or overwrite. Relative paths and workspace-absolute paths are accepted."
  }),
  content: Type.String({ description: "Full UTF-8 file content to write." })
});

const replaceFileTextParameters = Type.Object({
  path: Type.String({
    description:
      "UTF-8 text file path inside the workspace. Relative paths and workspace-absolute paths are accepted."
  }),
  search: Type.String({ description: "Exact existing text block to replace." }),
  replacement: Type.String({ description: "Replacement text." }),
  replaceAll: Type.Optional(
    Type.Boolean({
      description:
        "Replace every occurrence. Defaults to false; when false, the search text must occur exactly once."
    })
  )
});

const deleteFileParameters = Type.Object({
  path: Type.String({
    description:
      "Workspace-relative or workspace-absolute path to a text or LaTeX-related file to delete. Directories, .git paths, and binary files are rejected."
  })
});

const compileLatexParameters = Type.Object({
  texPath: Type.String({
    description:
      "Workspace-relative or workspace-absolute path to the main .tex file, for example paper-projects/current/manuscript/main.tex."
  }),
  runBibtex: Type.Optional(Type.Boolean({ description: "Run bibtex after the first pdflatex pass. Defaults to true." })),
  maxOutputChars: Type.Optional(
    Type.Integer({ description: "Maximum combined compiler output characters to return. Defaults to 12000.", minimum: 1000 })
  )
});

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

type GetTimeParameters = Static<typeof getTimeParameters>;
type LoadPaperWritingSkillParameters = Static<typeof loadPaperWritingSkillParameters>;
type ReadFileParameters = Static<typeof readFileParameters>;
type ListFilesParameters = Static<typeof listFilesParameters>;
type WriteFileParameters = Static<typeof writeFileParameters>;
type ReplaceFileTextParameters = Static<typeof replaceFileTextParameters>;
type DeleteFileParameters = Static<typeof deleteFileParameters>;
type CompileLatexParameters = Static<typeof compileLatexParameters>;
type WriteDesignArtifactParameters = Static<typeof writeDesignArtifactParameters>;

const DESIGN_ARTIFACT_DIRECTORIES: Record<WriteDesignArtifactParameters["artifactType"], string> = {
  design_record: "design-records",
  verification_report: "verification-reports",
  failure_record: "failures",
  benchmark_case: "benchmark-cases"
};

function assertPathInsideDirectory(rootDir: string, candidatePath: string): void {
  const relativePath = path.relative(rootDir, candidatePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Requested path is outside the workspace.");
  }
}

export async function resolveWorkspacePath(workspaceDir: string, requestedPath: string): Promise<string> {
  if (!requestedPath.trim()) {
    throw new Error("Path is required.");
  }

  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(resolvedWorkspaceDir, requestedPath);
  assertPathInsideDirectory(resolvedWorkspaceDir, resolvedPath);

  const [realWorkspaceDir, realResolvedPath] = await Promise.all([
    realpath(resolvedWorkspaceDir),
    realpath(resolvedPath)
  ]);
  assertPathInsideDirectory(realWorkspaceDir, realResolvedPath);

  return realResolvedPath;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await stat(candidatePath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function resolveWorkspaceWritablePath(workspaceDir: string, requestedPath: string): Promise<string> {
  if (!requestedPath.trim()) {
    throw new Error("Path is required.");
  }

  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(resolvedWorkspaceDir, requestedPath);
  assertPathInsideDirectory(resolvedWorkspaceDir, resolvedPath);

  const parentDir = path.dirname(resolvedPath);
  await mkdir(parentDir, { recursive: true });

  const [realWorkspaceDir, realParentDir] = await Promise.all([
    realpath(resolvedWorkspaceDir),
    realpath(parentDir)
  ]);
  assertPathInsideDirectory(realWorkspaceDir, realParentDir);

  if (await pathExists(resolvedPath)) {
    const realResolvedPath = await realpath(resolvedPath);
    assertPathInsideDirectory(realWorkspaceDir, realResolvedPath);
    return realResolvedPath;
  }

  return resolvedPath;
}

const DELETABLE_TEXT_FILE_EXTENSIONS = new Set([
  ".aux",
  ".bbl",
  ".bib",
  ".blg",
  ".bst",
  ".cls",
  ".csv",
  ".fdb_latexmk",
  ".fls",
  ".json",
  ".jsonl",
  ".log",
  ".lof",
  ".lot",
  ".md",
  ".nav",
  ".out",
  ".py",
  ".rst",
  ".snm",
  ".sty",
  ".tex",
  ".toc",
  ".toml",
  ".tsv",
  ".txt",
  ".vrb",
  ".yaml",
  ".yml"
]);

function hasGitPathSegment(candidatePath: string): boolean {
  return candidatePath.split(path.sep).some((segment) => segment === ".git");
}

function isDeletableTextFilePath(candidatePath: string): boolean {
  return DELETABLE_TEXT_FILE_EXTENSIONS.has(path.extname(candidatePath).toLowerCase());
}

async function resolveWorkspaceDeletableFilePath(workspaceDir: string, requestedPath: string): Promise<{
  resolvedPath: string;
  size: number;
}> {
  if (!requestedPath.trim()) {
    throw new Error("Path is required.");
  }

  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(resolvedWorkspaceDir, requestedPath);
  assertPathInsideDirectory(resolvedWorkspaceDir, resolvedPath);

  const relativePath = path.relative(resolvedWorkspaceDir, resolvedPath);
  if (hasGitPathSegment(relativePath)) {
    throw new Error("Deleting .git paths is not allowed.");
  }

  const parentDir = path.dirname(resolvedPath);
  const [realWorkspaceDir, realParentDir] = await Promise.all([
    realpath(resolvedWorkspaceDir),
    realpath(parentDir)
  ]);
  assertPathInsideDirectory(realWorkspaceDir, realParentDir);

  const entryStats = await lstat(resolvedPath);
  if (entryStats.isSymbolicLink()) {
    throw new Error("delete_file does not delete symbolic links.");
  }
  if (!entryStats.isFile()) {
    throw new Error("delete_file only deletes files, not directories.");
  }
  if (!isDeletableTextFilePath(resolvedPath)) {
    throw new Error("delete_file only deletes text or LaTeX-related files.");
  }

  const realResolvedPath = await realpath(resolvedPath);
  assertPathInsideDirectory(realWorkspaceDir, realResolvedPath);
  if (hasGitPathSegment(path.relative(realWorkspaceDir, realResolvedPath))) {
    throw new Error("Deleting .git paths is not allowed.");
  }

  return { resolvedPath: realResolvedPath, size: entryStats.size };
}

export function relativeWorkspacePath(workspaceDir: string, filePath: string): string {
  return path.relative(path.resolve(workspaceDir), filePath).split(path.sep).join("/");
}

function isWikiSynthesisPagePath(relativePath: string): boolean {
  return relativePath === "knowledge-base/wiki/pages" ||
    relativePath.startsWith("knowledge-base/wiki/pages/");
}

function countOccurrences(text: string, search: string): number {
  if (!search) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (true) {
    const nextIndex = text.indexOf(search, index);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    index = nextIndex + search.length;
  }
}

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 120)).trimEnd()}\n\n[output truncated to ${maxChars} chars]`;
}

async function runLatexCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  maxOutputChars: number;
}): Promise<string> {
  const commandLine = `$ ${[input.command, ...input.args].join(" ")}`;
  try {
    const { stdout, stderr } = await execFileAsync(input.command, input.args, {
      cwd: input.cwd,
      timeout: 120000,
      maxBuffer: Math.max(input.maxOutputChars * 2, 1024 * 1024)
    }) as { stdout: string | Buffer; stderr: string | Buffer };

    const output = [
      commandLine,
      stdout.toString(),
      stderr.toString()
    ].filter((part) => part.trim().length > 0).join("\n");
    return truncateOutput(output, input.maxOutputChars);
  } catch (error) {
    const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const output = [
      commandLine,
      failed.stdout?.toString() ?? "",
      failed.stderr?.toString() ?? "",
      failed.message ?? String(error)
    ].filter((part) => part.trim().length > 0).join("\n");
    throw new Error(truncateOutput(output, input.maxOutputChars));
  }
}

async function compileLatexDocument(input: {
  workspaceDir: string;
  texPath: string;
  runBibtex: boolean;
  maxOutputChars: number;
}): Promise<{
  texPath: string;
  pdfPath: string;
  commands: string[];
  output: string;
}> {
  const resolvedTexPath = await resolveWorkspacePath(input.workspaceDir, input.texPath);
  if (path.extname(resolvedTexPath).toLowerCase() !== ".tex") {
    throw new Error("compile_latex requires a .tex file.");
  }

  const workingDir = path.dirname(resolvedTexPath);
  const texFile = path.basename(resolvedTexPath);
  const baseName = path.basename(resolvedTexPath, path.extname(resolvedTexPath));
  const pdfPath = path.join(workingDir, `${baseName}.pdf`);
  const commands: string[] = [];
  const outputs: string[] = [];
  const remainingOutput = () => Math.max(1000, input.maxOutputChars - outputs.join("\n\n").length);

  const runCommand = async (command: string, args: string[]) => {
    commands.push([command, ...args].join(" "));
    outputs.push(await runLatexCommand({
      command,
      args,
      cwd: workingDir,
      maxOutputChars: remainingOutput()
    }));
  };

  await runCommand("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", texFile]);
  if (input.runBibtex && await pathExists(path.join(workingDir, `${baseName}.aux`))) {
    await runCommand("bibtex", [baseName]);
  }
  await runCommand("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", texFile]);
  await runCommand("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", texFile]);

  if (!await pathExists(pdfPath)) {
    throw new Error(`LaTeX finished without producing ${path.basename(pdfPath)}.`);
  }

  return {
    texPath: relativeWorkspacePath(input.workspaceDir, resolvedTexPath),
    pdfPath: relativeWorkspacePath(input.workspaceDir, pdfPath),
    commands,
    output: truncateOutput(outputs.join("\n\n"), input.maxOutputChars)
  };
}

function fileTypeFromDirent(entry: import("node:fs").Dirent): ListFilesEntry["type"] {
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}

async function listWorkspaceFiles(input: {
  workspaceDir: string;
  requestedPath: string;
  maxDepth: number;
  maxEntries: number;
}): Promise<ListFilesDetails> {
  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);
  const resolvedPath = await resolveWorkspacePath(resolvedWorkspaceDir, input.requestedPath);
  const rootStats = await stat(resolvedPath);
  const entries: ListFilesEntry[] = [];
  let truncated = false;

  const pushEntry = (entryPath: string, type: ListFilesEntry["type"]) => {
    if (entries.length >= input.maxEntries) {
      truncated = true;
      return false;
    }

    entries.push({
      path: path.relative(resolvedWorkspaceDir, entryPath).split(path.sep).join("/"),
      type
    });
    return true;
  };

  const visitDirectory = async (directoryPath: string, depth: number): Promise<void> => {
    if (entries.length >= input.maxEntries) {
      truncated = true;
      return;
    }

    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    directoryEntries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    for (const entry of directoryEntries) {
      const entryPath = path.join(directoryPath, entry.name);
      const type = fileTypeFromDirent(entry);
      if (!pushEntry(entryPath, type)) {
        return;
      }
      if (type === "directory" && depth < input.maxDepth) {
        await visitDirectory(entryPath, depth + 1);
      }
    }
  };

  if (!rootStats.isDirectory()) {
    pushEntry(resolvedPath, rootStats.isFile() ? "file" : "other");
  } else {
    await visitDirectory(resolvedPath, 0);
  }

  return {
    path: input.requestedPath,
    resolvedPath,
    entries,
    truncated,
    maxDepth: input.maxDepth,
    maxEntries: input.maxEntries
  };
}

async function readWorkspaceTextFileRange(input: {
  resolvedPath: string;
  requestedPath: string;
  offsetBytes?: number;
  maxBytes?: number;
}): Promise<{ content: string; details: ReadFileDetails }> {
  const fileStats = await stat(input.resolvedPath);
  if (!fileStats.isFile()) {
    throw new Error(`read_file path is not a file: ${input.requestedPath}`);
  }

  const offsetBytes = Math.max(0, Math.trunc(input.offsetBytes ?? 0));
  const requestedMaxBytes = Math.max(1, Math.trunc(input.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES));
  const maxBytes = Math.min(requestedMaxBytes, HARD_READ_FILE_MAX_BYTES);
  const availableBytes = Math.max(0, fileStats.size - offsetBytes);
  const bytesToRead = Math.min(maxBytes, availableBytes);

  if (bytesToRead === 0) {
    return {
      content: "",
      details: {
        path: input.requestedPath,
        sizeBytes: fileStats.size,
        offsetBytes,
        requestedMaxBytes,
        maxBytes,
        returnedBytes: 0,
        truncated: false
      }
    };
  }

  const buffer = Buffer.alloc(bytesToRead);
  const fileHandle = await open(input.resolvedPath, "r");
  try {
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offsetBytes);
    const nextOffsetBytes = offsetBytes + bytesRead;
    const truncated = nextOffsetBytes < fileStats.size;

    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      details: {
        path: input.requestedPath,
        sizeBytes: fileStats.size,
        offsetBytes,
        requestedMaxBytes,
        maxBytes,
        returnedBytes: bytesRead,
        truncated,
        ...(truncated ? { nextOffsetBytes } : {})
      }
    };
  } finally {
    await fileHandle.close();
  }
}

async function loadPaperWritingSkill(input: {
  workspaceDir: string;
  skillName?: string;
}): Promise<{ prompt: string; details: PaperWritingSkillDetails }> {
  const skillName = input.skillName?.trim() || "sciwrite";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skillName)) {
    throw new Error("Paper-writing skill name must contain only letters, numbers, underscores, and hyphens.");
  }

  const promptPath = `skills/paper-writing-worker/${skillName}/prompt.md`;
  const resolvedPromptPath = await resolveWorkspacePath(input.workspaceDir, promptPath);
  const promptStats = await stat(resolvedPromptPath);
  if (!promptStats.isFile()) {
    throw new Error(`Paper-writing skill prompt is not a file: ${promptPath}`);
  }

  const attributionPath = `skills/paper-writing-worker/${skillName}/ATTRIBUTION.md`;
  const resolvedAttributionPath = path.resolve(input.workspaceDir, attributionPath);
  const hasAttribution = await pathExists(resolvedAttributionPath);
  if (hasAttribution) {
    const realWorkspaceDir = await realpath(input.workspaceDir);
    const realAttributionPath = await realpath(resolvedAttributionPath);
    assertPathInsideDirectory(realWorkspaceDir, realAttributionPath);
  }

  return {
    prompt: await readFile(resolvedPromptPath, "utf8"),
    details: {
      skillName,
      promptPath,
      ...(hasAttribution ? { attributionPath } : {}),
      bytes: promptStats.size
    }
  };
}

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

type GetTimeTool = AgentTool<typeof getTimeParameters, { timezone: string }>;
type LoadPaperWritingSkillTool = AgentTool<typeof loadPaperWritingSkillParameters, PaperWritingSkillDetails>;
type ReadFileTool = AgentTool<typeof readFileParameters, ReadFileDetails>;
type ListFilesTool = AgentTool<typeof listFilesParameters, ListFilesDetails>;
type WriteFileTool = AgentTool<typeof writeFileParameters, { path: string; bytes: number }>;
type ReplaceFileTextTool = AgentTool<
  typeof replaceFileTextParameters,
  { path: string; replacements: number; bytes: number }
>;
type DeleteFileTool = AgentTool<typeof deleteFileParameters, { path: string; bytes: number }>;
type CompileLatexTool = AgentTool<
  typeof compileLatexParameters,
  {
    status: "compiled";
    texPath: string;
    pdfPath: string;
    commands: string[];
    output: string;
  }
>;
type WriteDesignArtifactTool = AgentTool<
  typeof writeDesignArtifactParameters,
  Awaited<ReturnType<typeof writeDesignArtifact>>
>;

interface ListFilesEntry {
  path: string;
  type: "directory" | "file" | "symlink" | "other";
}

interface ListFilesDetails {
  path: string;
  resolvedPath: string;
  entries: ListFilesEntry[];
  truncated: boolean;
  maxDepth: number;
  maxEntries: number;
}

interface ReadFileDetails {
  path: string;
  sizeBytes: number;
  offsetBytes: number;
  requestedMaxBytes: number;
  maxBytes: number;
  returnedBytes: number;
  truncated: boolean;
  nextOffsetBytes?: number;
}

interface PaperWritingSkillDetails {
  skillName: string;
  promptPath: string;
  attributionPath?: string;
  bytes: number;
}

export function createFileTools(input: {
  workspaceDir: string;
}): {
  defaultTools: AgentTool<any>[];
  prependFullTools: AgentTool<any>[];
  artifactFullTools: AgentTool<any>[];
  tailFullTools: AgentTool<any>[];
} {
  const resolvedWorkspaceDir = path.resolve(input.workspaceDir);

  const getTimeTool: GetTimeTool = {
    name: "get_time",
    label: "Get Time",
    description: "Returns the current time, optionally formatted for a specific timezone.",
    parameters: getTimeParameters,
    execute: async (_toolCallId: string, args: GetTimeParameters) => {
      const timezone = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const formatter = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: args.timezone
      });

      return {
        content: [{ type: "text", text: formatter.format(new Date()) }],
        details: { timezone }
      };
    }
  };

  const loadPaperWritingSkillTool: LoadPaperWritingSkillTool = {
    name: "load_paper_writing_skill",
    label: "Load Paper Writing Skill",
    description:
      "Loads a paper-writing-worker prompt module, such as sciwrite, from skills/paper-writing-worker/<skillName>/prompt.md. Use this before manuscript writing-quality review or prose cleanup.",
    parameters: loadPaperWritingSkillParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: LoadPaperWritingSkillParameters) => {
      const result = await loadPaperWritingSkill({
        workspaceDir: resolvedWorkspaceDir,
        skillName: args.skillName
      });

      return {
        content: [{ type: "text", text: result.prompt }],
        details: result.details
      };
    }
  };

  const readFileTool: ReadFileTool = {
    name: "read_file",
    label: "Read File",
    description:
      "Reads a bounded UTF-8 text-file segment from inside the workspace. Use offsetBytes and maxBytes to page through large files, and list_files first when the user gives a directory.",
    parameters: readFileParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: ReadFileParameters) => {
      const resolvedPath = await resolveWorkspacePath(resolvedWorkspaceDir, args.path);
      const result = await readWorkspaceTextFileRange({
        resolvedPath,
        requestedPath: args.path,
        offsetBytes: args.offsetBytes,
        maxBytes: args.maxBytes
      });

      return {
        content: [{ type: "text", text: result.content }],
        details: result.details
      };
    }
  };

  const listFilesTool: ListFilesTool = {
    name: "list_files",
    label: "List Files",
    description:
      "Lists files and directories under a workspace path. Use this before asking clarification when the user points at a local writing project directory such as paper-projects.",
    parameters: listFilesParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: ListFilesParameters) => {
      const maxDepth = Math.max(0, Math.trunc(args.maxDepth ?? 2));
      const maxEntries = Math.max(1, Math.trunc(args.maxEntries ?? 200));
      const result = await listWorkspaceFiles({
        workspaceDir: resolvedWorkspaceDir,
        requestedPath: args.path,
        maxDepth,
        maxEntries
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const writeFileTool: WriteFileTool = {
    name: "write_file",
    label: "Write File",
    description:
      "Creates or overwrites a UTF-8 text file inside the workspace. Use this when the user asks you to actually edit a local writing project or manuscript file. This tool does not write knowledge-base/wiki/pages/ synthesis pages; use build_wiki_page for evidence-grounded wiki page writes or read_file plus replace_file_text for a precise edit to an existing page.",
    parameters: writeFileParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: WriteFileParameters) => {
      const resolvedPath = await resolveWorkspaceWritablePath(resolvedWorkspaceDir, args.path);
      const relativePath = relativeWorkspacePath(resolvedWorkspaceDir, resolvedPath);
      if (isWikiSynthesisPagePath(relativePath)) {
        throw new Error(
          "write_file cannot create or overwrite synthesis wiki pages under knowledge-base/wiki/pages/. Use build_wiki_page for evidence-grounded wiki page writes, or read_file plus replace_file_text for a precise edit to an existing page."
        );
      }
      await writeFile(resolvedPath, args.content, "utf8");

      return {
        content: [{ type: "text", text: `Wrote ${relativePath}.` }],
        details: {
          path: relativePath,
          bytes: Buffer.byteLength(args.content, "utf8")
        }
      };
    }
  };

  const replaceFileTextTool: ReplaceFileTextTool = {
    name: "replace_file_text",
    label: "Replace File Text",
    description:
      "Replaces an exact text block inside a UTF-8 workspace file. Use read_file first, then replace the smallest exact block that implements the requested manuscript edit.",
    parameters: replaceFileTextParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: ReplaceFileTextParameters) => {
      if (!args.search) {
        throw new Error("Search text is required.");
      }

      const resolvedPath = await resolveWorkspacePath(resolvedWorkspaceDir, args.path);
      const original = await readFile(resolvedPath, "utf8");
      const occurrences = countOccurrences(original, args.search);
      if (occurrences === 0) {
        throw new Error("Search text was not found in the file.");
      }
      if (!args.replaceAll && occurrences !== 1) {
        throw new Error(`Search text occurs ${occurrences} times; set replaceAll=true or use a more specific block.`);
      }

      const updated = args.replaceAll
        ? original.split(args.search).join(args.replacement)
        : original.replace(args.search, args.replacement);
      await writeFile(resolvedPath, updated, "utf8");
      const relativePath = relativeWorkspacePath(resolvedWorkspaceDir, resolvedPath);

      return {
        content: [{ type: "text", text: `Replaced text in ${relativePath}.` }],
        details: {
          path: relativePath,
          replacements: args.replaceAll ? occurrences : 1,
          bytes: Buffer.byteLength(updated, "utf8")
        }
      };
    }
  };

  const deleteFileTool: DeleteFileTool = {
    name: "delete_file",
    label: "Delete File",
    description:
      "Deletes a text, script, or LaTeX-related file inside the workspace. Use this for intentional manuscript or temporary-file cleanup after inspecting the target; it rejects directories, .git paths, symlinks, and binary files.",
    parameters: deleteFileParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: DeleteFileParameters) => {
      const { resolvedPath, size } = await resolveWorkspaceDeletableFilePath(resolvedWorkspaceDir, args.path);
      await unlink(resolvedPath);
      const relativePath = relativeWorkspacePath(resolvedWorkspaceDir, resolvedPath);

      return {
        content: [{ type: "text", text: `Deleted ${relativePath}.` }],
        details: {
          path: relativePath,
          bytes: size
        }
      };
    }
  };

  const compileLatexTool: CompileLatexTool = {
    name: "compile_latex",
    label: "Compile LaTeX",
    description:
      "Compiles a workspace LaTeX manuscript with pdflatex, bibtex, and two more pdflatex passes. Use this after editing a paper when the user asks for the compiled PDF.",
    parameters: compileLatexParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: CompileLatexParameters) => {
      const result = await compileLatexDocument({
        workspaceDir: resolvedWorkspaceDir,
        texPath: args.texPath,
        runBibtex: args.runBibtex ?? true,
        maxOutputChars: Math.max(1000, Math.trunc(args.maxOutputChars ?? 12000))
      });

      return {
        content: [{ type: "text", text: `Compiled ${result.pdfPath}.` }],
        details: {
          status: "compiled",
          ...result
        }
      };
    }
  };

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
    defaultTools: [
      listFilesTool,
      readFileTool,
      writeFileTool,
      replaceFileTextTool,
      deleteFileTool,
      compileLatexTool
    ],
    prependFullTools: [
      getTimeTool
    ],
    artifactFullTools: [
      writeDesignArtifactTool
    ],
    tailFullTools: [
      loadPaperWritingSkillTool
    ]
  };
}
