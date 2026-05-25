import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { sanitizeWikiFilename } from "./wiki/store.js";

const execFileAsync = promisify(execFile);

const DEFAULT_READ_FILE_MAX_BYTES = 256 * 1024;
const HARD_READ_FILE_MAX_BYTES = 1024 * 1024;
const HARD_DESIGN_SCRIPT_OUTPUT_CHARS = 120_000;

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

const writeDesignCodeFileParameters = Type.Object({
  path: Type.String({
    description:
      "UTF-8 text file path under knowledge-base/design-code. Accepts design-code-relative paths or knowledge-base/design-code/... paths."
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

const replaceDesignCodeFileTextParameters = Type.Object({
  path: Type.String({
    description:
      "UTF-8 text file path under knowledge-base/design-code. Accepts design-code-relative paths or knowledge-base/design-code/... paths."
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

const runDesignScriptParameters = Type.Object({
  scriptPath: Type.String({
    description:
      "Workspace-relative or workspace-absolute Python layout/verification script to run. Use KLayout scripts with runner=klayout."
  }),
  runner: Type.Optional(
    Type.Union([
      Type.Literal("auto"),
      Type.Literal("python"),
      Type.Literal("klayout")
    ], {
      description:
        "Script runner. Defaults to auto; auto uses klayout for filenames containing 'klayout' and python otherwise."
    })
  ),
  outputPaths: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "Expected generated workspace file path, such as single_xmon_concept.gds. Each path is verified after the script completes."
      })
    )
  ),
  maxOutputChars: Type.Optional(
    Type.Integer({
      description: "Maximum combined stdout/stderr characters to return. Defaults to 12000.",
      minimum: 1000
    })
  )
});

const syncDesignEnvironmentParameters = Type.Object({
  projectPath: Type.Optional(
    Type.String({
      description:
        "Design-code project path. Defaults to knowledge-base/design-code and must resolve exactly to that directory."
    })
  ),
  maxOutputChars: Type.Optional(
    Type.Integer({
      description: "Maximum combined stdout/stderr characters to return. Defaults to 12000.",
      minimum: 1000
    })
  )
});

const verifyDesignPythonImportParameters = Type.Object({
  moduleName: Type.String({
    description: "Python module name to import with the repository root .venv Python, such as gdsfactory."
  }),
  maxOutputChars: Type.Optional(
    Type.Integer({
      description: "Maximum combined stdout/stderr characters to return. Defaults to 12000.",
      minimum: 1000
    })
  )
});

const updateDesignDependencyParameters = Type.Object({
  name: Type.String({
    description: "Python dependency package name to declare in knowledge-base/design-code/pyproject.toml."
  }),
  specifier: Type.Optional(
    Type.String({
      description: "Optional Python version specifier, such as >=0.29 or ==1.2.3."
    })
  ),
  group: Type.Optional(
    Type.Union([Type.Literal("main"), Type.Literal("dev")], {
      description: "Dependency group to update. Defaults to main."
    })
  )
});

type GetTimeParameters = Static<typeof getTimeParameters>;
type LoadPaperWritingSkillParameters = Static<typeof loadPaperWritingSkillParameters>;
type ReadFileParameters = Static<typeof readFileParameters>;
type ListFilesParameters = Static<typeof listFilesParameters>;
type WriteFileParameters = Static<typeof writeFileParameters>;
type WriteDesignCodeFileParameters = Static<typeof writeDesignCodeFileParameters>;
type ReplaceFileTextParameters = Static<typeof replaceFileTextParameters>;
type ReplaceDesignCodeFileTextParameters = Static<typeof replaceDesignCodeFileTextParameters>;
type DeleteFileParameters = Static<typeof deleteFileParameters>;
type CompileLatexParameters = Static<typeof compileLatexParameters>;
type WriteDesignArtifactParameters = Static<typeof writeDesignArtifactParameters>;
type RunDesignScriptParameters = Static<typeof runDesignScriptParameters>;
type SyncDesignEnvironmentParameters = Static<typeof syncDesignEnvironmentParameters>;
type VerifyDesignPythonImportParameters = Static<typeof verifyDesignPythonImportParameters>;
type UpdateDesignDependencyParameters = Static<typeof updateDesignDependencyParameters>;
type ResolvedDesignScriptRunner = "python" | "klayout";
type ProtectedPathSnapshot = {
  rootDir: string;
  rootExisted: boolean;
  files: Map<string, Buffer>;
  dirs: Set<string>;
};

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
  return relativePath === "knowledge-base/pages" ||
    relativePath.startsWith("knowledge-base/pages/");
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

function truncateSeparatedOutput(input: {
  stdout: string;
  stderr: string;
  maxChars: number;
}): { stdout: string; stderr: string } {
  const stdoutBudget = Math.floor(input.maxChars / 2);
  const stdout = truncateOutput(input.stdout, stdoutBudget);
  const stderrBudget = input.maxChars - stdout.length;
  const stderr = stderrBudget > 0 ? truncateOutput(input.stderr, stderrBudget) : "";
  return { stdout, stderr };
}

function normalizeDesignToolOutputChars(value: number | undefined): number {
  return Math.min(HARD_DESIGN_SCRIPT_OUTPUT_CHARS, Math.max(1000, Math.trunc(value ?? 12000)));
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

function resolveDesignScriptRunner(
  requestedRunner: RunDesignScriptParameters["runner"] | undefined,
  scriptPath: string
): ResolvedDesignScriptRunner {
  if (requestedRunner === "python" || requestedRunner === "klayout") {
    return requestedRunner;
  }

  const scriptName = path.basename(scriptPath).toLowerCase();
  return scriptName.includes("klayout") ? "klayout" : "python";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile();
  } catch {
    return false;
  }
}

function rootVenvDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".venv");
}

function rootVenvPythonCandidates(workspaceDir: string): string[] {
  const venvDir = rootVenvDir(workspaceDir);
  if (process.platform === "win32") {
    return [path.join(venvDir, "Scripts", "python.exe")];
  }

  return [path.join(venvDir, "bin", "python")];
}

async function findRootVenvPython(workspaceDir: string): Promise<string | undefined> {
  assertPathInsideDirectory(workspaceDir, workspaceDir);

  for (const candidate of rootVenvPythonCandidates(workspaceDir)) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function designCodeProjectDir(workspaceDir: string): string {
  return path.join(workspaceDir, "knowledge-base", "design-code");
}

function normalizeWorkspaceRelativePath(workspaceDir: string, resolvedPath: string): string {
  const relativePath = path.relative(workspaceDir, resolvedPath);
  return relativePath.length > 0 ? relativePath.split(path.sep).join("/") : ".";
}

async function resolveDesignCodeProjectPath(workspaceDir: string, requestedPath: string | undefined): Promise<string> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const expectedProjectDir = path.resolve(designCodeProjectDir(resolvedWorkspaceDir));
  const candidateProjectDir = path.isAbsolute(requestedPath ?? "")
    ? path.resolve(requestedPath ?? "")
    : path.resolve(resolvedWorkspaceDir, requestedPath ?? "knowledge-base/design-code");
  assertPathInsideDirectory(resolvedWorkspaceDir, candidateProjectDir);

  if (candidateProjectDir !== expectedProjectDir) {
    throw new Error("sync_design_environment only runs for knowledge-base/design-code.");
  }

  const projectStats = await lstat(expectedProjectDir).catch(() => undefined);
  if (!projectStats?.isDirectory() || projectStats.isSymbolicLink()) {
    throw new Error("sync_design_environment requires knowledge-base/design-code to be a real directory.");
  }

  const [resolvedProjectDir, resolvedExpectedProjectDir] = await Promise.all([
    resolveWorkspacePath(workspaceDir, requestedPath ?? "knowledge-base/design-code"),
    realpath(expectedProjectDir)
  ]);
  if (resolvedProjectDir !== resolvedExpectedProjectDir) {
    throw new Error("sync_design_environment only runs for knowledge-base/design-code.");
  }

  const pyprojectPath = path.join(resolvedProjectDir, "pyproject.toml");
  if (!(await fileExists(pyprojectPath))) {
    throw new Error("sync_design_environment requires knowledge-base/design-code/pyproject.toml.");
  }

  return resolvedProjectDir;
}

function assertPathInsideDesignCodeProject(rootDir: string, candidatePath: string): void {
  try {
    assertPathInsideDirectory(rootDir, candidatePath);
  } catch {
    throw new Error("design-code file tools only write under knowledge-base/design-code.");
  }
}

function designCodeRelativeRequestedPath(requestedPath: string): string {
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath) {
    throw new Error("Path is required.");
  }
  if (path.isAbsolute(trimmedPath) || path.win32.isAbsolute(trimmedPath)) {
    throw new Error("design-code file tools only write under knowledge-base/design-code.");
  }

  const platformPath = trimmedPath.split(/[\\/]+/).join(path.sep);
  const designCodePrefix = path.join("knowledge-base", "design-code");
  if (platformPath === designCodePrefix) {
    throw new Error("Path is required.");
  }

  return platformPath.startsWith(`${designCodePrefix}${path.sep}`)
    ? platformPath.slice(designCodePrefix.length + 1)
    : platformPath;
}

async function resolveDesignCodeWritableFilePath(workspaceDir: string, requestedPath: string): Promise<string> {
  const designCodeDir = await resolveDesignCodeProjectPath(workspaceDir, "knowledge-base/design-code");
  const realDesignCodeDir = await realpath(designCodeDir);
  const projectRelativePath = designCodeRelativeRequestedPath(requestedPath);
  const resolvedPath = path.resolve(realDesignCodeDir, projectRelativePath);
  assertPathInsideDesignCodeProject(realDesignCodeDir, resolvedPath);

  const parentDir = path.dirname(resolvedPath);
  let existingAncestorDir = parentDir;
  while (!(await pathExists(existingAncestorDir))) {
    const nextAncestorDir = path.dirname(existingAncestorDir);
    if (nextAncestorDir === existingAncestorDir) {
      throw new Error("design-code file tools only write under knowledge-base/design-code.");
    }
    existingAncestorDir = nextAncestorDir;
  }
  const realExistingAncestorDir = await realpath(existingAncestorDir);
  assertPathInsideDesignCodeProject(realDesignCodeDir, realExistingAncestorDir);

  await mkdir(parentDir, { recursive: true });
  const realParentDir = await realpath(parentDir);
  assertPathInsideDesignCodeProject(realDesignCodeDir, realParentDir);

  if (await pathExists(resolvedPath)) {
    const realResolvedPath = await realpath(resolvedPath);
    assertPathInsideDesignCodeProject(realDesignCodeDir, realResolvedPath);
    return realResolvedPath;
  }

  return resolvedPath;
}

async function resolveDesignCodeExistingFilePath(workspaceDir: string, requestedPath: string): Promise<string> {
  const designCodeDir = await resolveDesignCodeProjectPath(workspaceDir, "knowledge-base/design-code");
  const realDesignCodeDir = await realpath(designCodeDir);
  const projectRelativePath = designCodeRelativeRequestedPath(requestedPath);
  const resolvedPath = path.resolve(realDesignCodeDir, projectRelativePath);
  assertPathInsideDesignCodeProject(realDesignCodeDir, resolvedPath);

  const realResolvedPath = await realpath(resolvedPath);
  assertPathInsideDesignCodeProject(realDesignCodeDir, realResolvedPath);
  return realResolvedPath;
}

function formatCommandLine(input: {
  command: string;
  args: readonly string[];
  cwd: string;
}): string {
  const displayCommand = path.isAbsolute(input.command)
    ? path.relative(input.cwd, input.command)
    : input.command;
  return [displayCommand || input.command, ...input.args].join(" ");
}

async function designScriptCommandForRunner(input: {
  runner: ResolvedDesignScriptRunner;
  scriptFile: string;
  workingDir: string;
  workspaceDir: string;
}): Promise<{
  command: string;
  args: string[];
  commandLine: string;
}> {
  if (input.runner === "klayout") {
    const args = ["-b", "-r", input.scriptFile];
    return {
      command: "klayout",
      args,
      commandLine: formatCommandLine({
        command: "klayout",
        args,
        cwd: input.workingDir
      })
    };
  }

  const venvPython = await findRootVenvPython(input.workspaceDir);
  if (!venvPython) {
    throw new Error("Root .venv Python was not found. Run sync_design_environment first.");
  }
  const command = venvPython;
  const args = [input.scriptFile];
  return {
    command,
    args,
    commandLine: formatCommandLine({
      command,
      args,
      cwd: input.workingDir
    })
  };
}

async function createIsolatedDesignScriptWorkspace(workspaceDir: string): Promise<{
  tempRootDir: string;
  tempWorkspaceDir: string;
  tempDesignCodeDir: string;
}> {
  const sourceDesignCodeDir = await resolveDesignCodeProjectPath(workspaceDir, "knowledge-base/design-code");
  const tempRootDir = await mkdtemp(path.join(tmpdir(), "pi-agent-design-script-"));
  const tempWorkspaceDir = path.join(tempRootDir, "workspace");
  const tempDesignCodeDir = designCodeProjectDir(tempWorkspaceDir);

  await mkdir(path.dirname(tempDesignCodeDir), { recursive: true });
  await cp(sourceDesignCodeDir, tempDesignCodeDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git"
  });

  return { tempRootDir, tempWorkspaceDir, tempDesignCodeDir };
}

async function collectAndCopyDesignScriptOutputs(input: {
  sourceWorkspaceDir: string;
  destinationWorkspaceDir: string;
  outputPaths: readonly string[] | undefined;
}): Promise<Array<{ path: string; bytes: number }>> {
  const outputs: Array<{ path: string; bytes: number }> = [];

  for (const outputPath of input.outputPaths ?? []) {
    const sourceOutputPath = await resolveDesignCodeExistingFilePath(input.sourceWorkspaceDir, outputPath);
    const destinationOutputPath = await resolveDesignCodeWritableFilePath(input.destinationWorkspaceDir, outputPath);
    const sourceOutputStats = await stat(sourceOutputPath);
    if (!sourceOutputStats.isFile()) {
      throw new Error(`Expected design script output is not a file: ${outputPath}`);
    }

    await mkdir(path.dirname(destinationOutputPath), { recursive: true });
    await cp(sourceOutputPath, destinationOutputPath, { force: true });
    const destinationOutputStats = await stat(destinationOutputPath);
    outputs.push({
      path: relativeWorkspacePath(input.destinationWorkspaceDir, destinationOutputPath),
      bytes: destinationOutputStats.size
    });
  }

  return outputs;
}

async function snapshotProtectedPath(rootDir: string): Promise<ProtectedPathSnapshot> {
  const rootExisted = await pathExists(rootDir);
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();

  async function visit(currentPath: string): Promise<void> {
    const currentStats = await lstat(currentPath).catch(() => undefined);
    if (!currentStats) {
      return;
    }

    const relativePath = path.relative(rootDir, currentPath);
    if (relativePath.length > 0) {
      if (currentStats.isDirectory()) {
        dirs.add(relativePath);
      } else if (currentStats.isFile()) {
        files.set(relativePath, await readFile(currentPath));
      }
    }

    if (!currentStats.isDirectory()) {
      return;
    }

    const entries = await readdir(currentPath);
    for (const entry of entries) {
      await visit(path.join(currentPath, entry));
    }
  }

  await visit(rootDir);
  return { rootDir, rootExisted, files, dirs };
}

async function snapshotDesignScriptProtectedPaths(workspaceDir: string): Promise<ProtectedPathSnapshot[]> {
  return Promise.all([
    snapshotProtectedPath(path.join(workspaceDir, "knowledge-base", "pages")),
    snapshotProtectedPath(path.join(workspaceDir, "knowledge-base", "sources"))
  ]);
}

async function listCurrentProtectedPaths(rootDir: string): Promise<{
  files: Set<string>;
  dirs: Set<string>;
}> {
  const files = new Set<string>();
  const dirs = new Set<string>();

  async function visit(currentPath: string): Promise<void> {
    const currentStats = await lstat(currentPath).catch(() => undefined);
    if (!currentStats) {
      return;
    }

    const relativePath = path.relative(rootDir, currentPath);
    if (relativePath.length > 0) {
      if (currentStats.isDirectory()) {
        dirs.add(relativePath);
      } else if (currentStats.isFile()) {
        files.add(relativePath);
      }
    }

    if (!currentStats.isDirectory()) {
      return;
    }

    const entries = await readdir(currentPath);
    for (const entry of entries) {
      await visit(path.join(currentPath, entry));
    }
  }

  await visit(rootDir);
  return { files, dirs };
}

async function restoreDesignScriptProtectedPaths(snapshots: readonly ProtectedPathSnapshot[]): Promise<string[]> {
  const changedPaths: string[] = [];

  for (const snapshot of snapshots) {
    const current = await listCurrentProtectedPaths(snapshot.rootDir);
    const rootRelativePath = normalizeWorkspaceRelativePath(path.dirname(path.dirname(snapshot.rootDir)), snapshot.rootDir);
    const rootExists = await pathExists(snapshot.rootDir);
    if (snapshot.rootExisted && !rootExists) {
      changedPaths.push(rootRelativePath);
      await mkdir(snapshot.rootDir, { recursive: true });
    }

    for (const relativePath of current.files) {
      const currentPath = path.join(snapshot.rootDir, relativePath);
      const original = snapshot.files.get(relativePath);
      if (original === undefined) {
        changedPaths.push(`${rootRelativePath}/${relativePath.split(path.sep).join("/")}`);
        await rm(currentPath, { force: true });
        continue;
      }

      const currentContent = await readFile(currentPath);
      if (!currentContent.equals(original)) {
        changedPaths.push(`${rootRelativePath}/${relativePath.split(path.sep).join("/")}`);
        await writeFile(currentPath, original);
      }
    }

    for (const [relativePath, original] of snapshot.files) {
      if (current.files.has(relativePath)) {
        continue;
      }
      changedPaths.push(`${rootRelativePath}/${relativePath.split(path.sep).join("/")}`);
      const restoredPath = path.join(snapshot.rootDir, relativePath);
      await mkdir(path.dirname(restoredPath), { recursive: true });
      await writeFile(restoredPath, original);
    }

    const currentDirsByDepth = [...current.dirs].sort((left, right) => right.length - left.length);
    for (const relativePath of currentDirsByDepth) {
      if (snapshot.dirs.has(relativePath)) {
        continue;
      }
      await rm(path.join(snapshot.rootDir, relativePath), { recursive: true, force: true });
    }

    if (!snapshot.rootExisted && await pathExists(snapshot.rootDir)) {
      changedPaths.push(rootRelativePath);
      await rm(snapshot.rootDir, { recursive: true, force: true });
    }
  }

  return [...new Set(changedPaths)].sort();
}

async function syncDesignEnvironment(input: {
  workspaceDir: string;
  projectPath?: string;
  maxOutputChars: number;
}): Promise<{
  status: "synced";
  projectPath: string;
  environmentPath: string;
  pythonPath: string;
  command: string;
  exitCode: 0;
  stdout: string;
  stderr: string;
}> {
  const projectDir = await resolveDesignCodeProjectPath(input.workspaceDir, input.projectPath);
  const environmentDir = rootVenvDir(input.workspaceDir);
  const args = ["sync", "--project", projectDir, "--extra", "dev"];
  const commandLine = `uv sync --project ${normalizeWorkspaceRelativePath(input.workspaceDir, projectDir)} --extra dev`;

  try {
    const { stdout, stderr } = await execFileAsync("uv", args, {
      cwd: input.workspaceDir,
      env: {
        ...process.env,
        UV_PROJECT_ENVIRONMENT: environmentDir
      },
      timeout: 300000,
      maxBuffer: Math.max(input.maxOutputChars * 2, 1024 * 1024)
    }) as { stdout: string | Buffer; stderr: string | Buffer };

    const pythonPath = await findRootVenvPython(input.workspaceDir);
    if (!pythonPath) {
      throw new Error("uv sync completed but root .venv Python was not found.");
    }

    return {
      status: "synced",
      projectPath: normalizeWorkspaceRelativePath(input.workspaceDir, projectDir),
      environmentPath: normalizeWorkspaceRelativePath(input.workspaceDir, environmentDir),
      pythonPath: normalizeWorkspaceRelativePath(input.workspaceDir, pythonPath),
      command: commandLine,
      exitCode: 0,
      stdout: truncateOutput(stdout.toString(), input.maxOutputChars),
      stderr: truncateOutput(stderr.toString(), input.maxOutputChars)
    };
  } catch (error) {
    const failed = error as { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const output = [
      `$ ${commandLine}`,
      failed.stdout?.toString() ?? "",
      failed.stderr?.toString() ?? "",
      failed.message ?? String(error)
    ].filter((part) => part.trim().length > 0).join("\n");
    throw new Error(truncateOutput(output, input.maxOutputChars));
  }
}

async function verifyDesignPythonImport(input: {
  workspaceDir: string;
  moduleName: string;
  maxOutputChars: number;
}): Promise<{
  status: "importable";
  moduleName: string;
  pythonPath: string;
  command: string;
  stdout: string;
  stderr: string;
}> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(input.moduleName)) {
    throw new Error("Invalid Python module name.");
  }

  const pythonPath = await findRootVenvPython(input.workspaceDir);
  if (!pythonPath) {
    throw new Error("Root .venv Python was not found. Run sync_design_environment first.");
  }

  const args = ["-c", `import ${input.moduleName}; print("import-ok:${input.moduleName}")`];
  const commandLine = formatCommandLine({
    command: pythonPath,
    args,
    cwd: input.workspaceDir
  });

  try {
    const { stdout, stderr } = await execFileAsync(pythonPath, args, {
      cwd: input.workspaceDir,
      timeout: 120000,
      maxBuffer: Math.max(input.maxOutputChars * 2, 1024 * 1024)
    }) as { stdout: string | Buffer; stderr: string | Buffer };
    const output = truncateSeparatedOutput({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      maxChars: input.maxOutputChars
    });

    return {
      status: "importable",
      moduleName: input.moduleName,
      pythonPath: normalizeWorkspaceRelativePath(input.workspaceDir, pythonPath),
      command: commandLine,
      stdout: output.stdout,
      stderr: output.stderr
    };
  } catch (error) {
    const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const output = [
      `$ ${commandLine}`,
      failed.stdout?.toString() ?? "",
      failed.stderr?.toString() ?? "",
      failed.message ?? String(error)
    ].filter((part) => part.trim().length > 0).join("\n");
    throw new Error(truncateOutput(output, input.maxOutputChars));
  }
}

type DesignDependencyGroup = "main" | "dev";

type UpdateDesignDependencyResult = {
  status: "updated";
  path: string;
  group: DesignDependencyGroup;
  dependency: string;
  changed: boolean;
};

const PYTHON_DEPENDENCY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PYTHON_SPECIFIER_PREFIXES = ["===", "==", "~=", "!=", "<=", ">=", "<", ">", "="] as const;

function validatePythonDependencyName(name: string): void {
  if (!PYTHON_DEPENDENCY_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Python dependency name: ${name}`);
  }
}

function validatePythonDependencySpecifier(specifier: string | undefined): void {
  if (specifier === undefined || specifier.length === 0) {
    return;
  }
  if (
    specifier.includes("\n") ||
    specifier.includes("\r") ||
    specifier.includes("\"") ||
    !PYTHON_SPECIFIER_PREFIXES.some((prefix) => specifier.startsWith(prefix))
  ) {
    throw new Error(`Invalid Python dependency specifier: ${specifier}`);
  }
}

function buildPythonDependencyString(input: UpdateDesignDependencyParameters): string {
  validatePythonDependencyName(input.name);
  validatePythonDependencySpecifier(input.specifier);
  return `${input.name}${input.specifier ?? ""}`;
}

function parsePythonDependencyPackageName(dependency: string): string {
  return dependency.split(/[<>=!~\[\];\s]/, 1)[0].toLowerCase();
}

function findTomlSectionRange(lines: readonly string[], sectionName: string): { start: number; end: number } | undefined {
  const sectionPattern = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
  const start = lines.findIndex((line) => sectionPattern.exec(line)?.[1] === sectionName);
  if (start < 0) {
    return undefined;
  }

  const nextSection = lines.findIndex((line, index) => index > start && sectionPattern.test(line));
  return { start, end: nextSection >= 0 ? nextSection : lines.length };
}

function parseTomlStringValue(rawValue: string): string {
  return rawValue.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

function parseTomlDependencyArrayEntries(lines: readonly string[], fieldName: string): string[] {
  const entries: string[] = [];
  const fieldPattern = new RegExp(`^\\s*${fieldName}\\s*=\\s*\\[(.*)`);
  const quotedStringPattern = /"((?:\\.|[^"\\])*)"/g;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    if (trimmed.startsWith("\"")) {
      const match = /^"((?:\\.|[^"\\])*)"/.exec(trimmed);
      if (match) {
        entries.push(parseTomlStringValue(match[1]));
      }
      continue;
    }

    const fieldMatch = fieldPattern.exec(line);
    if (!fieldMatch) {
      continue;
    }

    const inlineArrayContent = fieldMatch[1].split("#", 1)[0];
    let match: RegExpExecArray | null;
    while ((match = quotedStringPattern.exec(inlineArrayContent)) !== null) {
      entries.push(parseTomlStringValue(match[1]));
    }
  }
  return entries;
}

function tomlLineBeforeComment(line: string): string {
  let inDoubleQuotedString = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (inDoubleQuotedString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inDoubleQuotedString = false;
      }
      continue;
    }

    if (character === "\"") {
      inDoubleQuotedString = true;
      continue;
    }
    if (character === "#") {
      return line.slice(0, index);
    }
  }

  return line;
}

function consumeDoubleQuotedTomlString(line: string, start: number): number | undefined {
  if (line.startsWith("\"\"\"", start)) {
    return undefined;
  }

  let escaped = false;
  for (let index = start + 1; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      return index + 1;
    }
  }

  return undefined;
}

function assertSupportedTomlDependencyArraySyntax(lines: readonly string[], fieldName: string): void {
  const unsupportedMessage =
    "Unsupported dependency array syntax in knowledge-base/design-code/pyproject.toml; use double-quoted dependency strings.";
  const fieldPrefixPattern = new RegExp(`^\\s*${fieldName}\\s*=\\s*\\[`);

  for (const line of lines) {
    const activeLine = tomlLineBeforeComment(line);
    let index = 0;
    const fieldMatch = fieldPrefixPattern.exec(activeLine);
    if (fieldMatch) {
      index = fieldMatch[0].length;
    }

    while (index < activeLine.length) {
      const character = activeLine[index];
      if (/\s/.test(character) || character === "," || character === "[" || character === "]") {
        index += 1;
        continue;
      }
      if (character === "\"") {
        const nextIndex = consumeDoubleQuotedTomlString(activeLine, index);
        if (nextIndex === undefined) {
          throw new Error(unsupportedMessage);
        }
        index = nextIndex;
        continue;
      }

      throw new Error(unsupportedMessage);
    }
  }
}

function formatTomlStringArray(fieldName: string, dependencies: readonly string[]): string[] {
  if (dependencies.length === 0) {
    return [`${fieldName} = []`];
  }

  return [
    `${fieldName} = [`,
    ...dependencies.map((dependency) => `  "${dependency.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}",`),
    "]"
  ];
}

function sortedDesignDependencies(dependencies: readonly string[]): string[] {
  return [...dependencies].sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
}

function replaceOrAppendDesignDependency(dependencies: readonly string[], dependency: string): {
  dependencies: string[];
  changed: boolean;
} {
  const targetName = parsePythonDependencyPackageName(dependency);
  let replaced = false;
  let changed = false;
  const updated = dependencies.map((existingDependency) => {
    if (parsePythonDependencyPackageName(existingDependency) !== targetName) {
      return existingDependency;
    }
    replaced = true;
    if (existingDependency !== dependency) {
      changed = true;
    }
    return dependency;
  });

  if (!replaced) {
    updated.push(dependency);
    changed = true;
  }

  const sorted = sortedDesignDependencies(updated);
  return {
    dependencies: sorted,
    changed: changed || sorted.some((value, index) => value !== dependencies[index])
  };
}

function findTomlArrayFieldRange(lines: readonly string[], section: { start: number; end: number }, fieldName: string):
  | { start: number; end: number; entries: string[] }
  | undefined {
  const fieldPattern = new RegExp(`^\\s*${fieldName}\\s*=\\s*\\[`);
  const fieldOneLinePattern = new RegExp(`^\\s*${fieldName}\\s*=\\s*\\[.*\\]\\s*(?:#.*)?$`);
  const closeArrayPattern = /^\]\s*(?:#.*)?$/;
  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index];
    if (!fieldPattern.test(line)) {
      continue;
    }

    if (fieldOneLinePattern.test(line)) {
      assertSupportedTomlDependencyArraySyntax([line], fieldName);
      return {
        start: index,
        end: index + 1,
        entries: parseTomlDependencyArrayEntries([line], fieldName)
      };
    }

    let arrayEnd = index + 1;
    while (arrayEnd < section.end && !closeArrayPattern.test(lines[arrayEnd].trim())) {
      arrayEnd += 1;
    }
    if (arrayEnd >= section.end) {
      throw new Error(`Invalid pyproject.toml: ${fieldName} array is not closed.`);
    }
    assertSupportedTomlDependencyArraySyntax(lines.slice(index, arrayEnd + 1), fieldName);
    return {
      start: index,
      end: arrayEnd + 1,
      entries: parseTomlDependencyArrayEntries(lines.slice(index, arrayEnd + 1), fieldName)
    };
  }

  return undefined;
}

function updateTomlDependencyArray(input: {
  content: string;
  sectionName: string;
  fieldName: string;
  dependency: string;
}): { content: string; changed: boolean } {
  const hadTrailingNewline = input.content.endsWith("\n");
  const lines = input.content.replace(/\n$/, "").split("\n");
  let section = findTomlSectionRange(lines, input.sectionName);

  if (!section) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    section = { start: lines.length, end: lines.length + 1 };
    lines.push(`[${input.sectionName}]`);
  }

  const existingArray = findTomlArrayFieldRange(lines, section, input.fieldName);
  const { dependencies, changed } = replaceOrAppendDesignDependency(existingArray?.entries ?? [], input.dependency);
  const replacement = formatTomlStringArray(input.fieldName, dependencies);

  if (existingArray) {
    lines.splice(existingArray.start, existingArray.end - existingArray.start, ...replacement);
  } else {
    lines.splice(section.end, 0, ...replacement);
  }

  return {
    content: `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`,
    changed: changed || !existingArray
  };
}

async function updateDesignDependency(input: {
  workspaceDir: string;
  name: string;
  specifier?: string;
  group?: DesignDependencyGroup;
}): Promise<UpdateDesignDependencyResult> {
  const projectDir = await resolveDesignCodeProjectPath(input.workspaceDir, undefined);
  const pyprojectPath = path.join(projectDir, "pyproject.toml");
  const group = input.group ?? "main";
  const dependency = buildPythonDependencyString(input);
  const original = await readFile(pyprojectPath, "utf8");
  const updated = updateTomlDependencyArray({
    content: original,
    sectionName: group === "main" ? "project" : "project.optional-dependencies",
    fieldName: group === "main" ? "dependencies" : "dev",
    dependency
  });

  if (updated.content !== original) {
    await writeFile(pyprojectPath, updated.content, "utf8");
  }

  return {
    status: "updated",
    path: normalizeWorkspaceRelativePath(input.workspaceDir, pyprojectPath),
    group,
    dependency,
    changed: updated.changed && updated.content !== original
  };
}

async function runDesignScript(input: {
  workspaceDir: string;
  scriptPath: string;
  runner?: RunDesignScriptParameters["runner"];
  outputPaths?: readonly string[];
  maxOutputChars: number;
}): Promise<{
  status: "completed";
  runner: ResolvedDesignScriptRunner;
  scriptPath: string;
  command: string;
  exitCode: 0;
  stdout: string;
  stderr: string;
  outputs: Array<{ path: string; bytes: number }>;
}> {
  const designCodeDir = await resolveDesignCodeProjectPath(input.workspaceDir, "knowledge-base/design-code");
  const realDesignCodeDir = await realpath(designCodeDir);
  const resolvedScriptPath = await resolveDesignCodeExistingFilePath(input.workspaceDir, input.scriptPath);
  const scriptStats = await stat(resolvedScriptPath);
  if (!scriptStats.isFile()) {
    throw new Error(`run_design_script path is not a file: ${input.scriptPath}`);
  }
  if (path.extname(resolvedScriptPath).toLowerCase() !== ".py") {
    throw new Error("run_design_script only runs .py layout or verification scripts.");
  }

  const runner = resolveDesignScriptRunner(input.runner, resolvedScriptPath);
  const workingDir = path.dirname(resolvedScriptPath);
  const scriptFile = path.basename(resolvedScriptPath);
  const scriptProjectRelativePath = path.relative(realDesignCodeDir, resolvedScriptPath);
  const commandSpec = await designScriptCommandForRunner({
    runner,
    scriptFile,
    workingDir,
    workspaceDir: input.workspaceDir
  });
  const commandLine = commandSpec.commandLine;
  const isolatedWorkspace = await createIsolatedDesignScriptWorkspace(input.workspaceDir);
  const protectedSnapshots = await snapshotDesignScriptProtectedPaths(input.workspaceDir);

  try {
    const isolatedScriptPath = path.join(isolatedWorkspace.tempDesignCodeDir, scriptProjectRelativePath);
    const isolatedWorkingDir = path.dirname(isolatedScriptPath);
    const { stdout, stderr } = await execFileAsync(commandSpec.command, commandSpec.args, {
      cwd: isolatedWorkingDir,
      env: {
        ...process.env,
        PYTHONPATH: [
          path.join(isolatedWorkspace.tempDesignCodeDir, "src"),
          process.env.PYTHONPATH
        ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0).join(path.delimiter)
      },
      timeout: 120000,
      maxBuffer: Math.max(input.maxOutputChars * 2, 1024 * 1024)
    }) as { stdout: string | Buffer; stderr: string | Buffer };
    const stdoutText = truncateOutput(stdout.toString(), input.maxOutputChars);
    const stderrText = truncateOutput(stderr.toString(), input.maxOutputChars);
    const protectedMutations = await restoreDesignScriptProtectedPaths(protectedSnapshots);
    if (protectedMutations.length > 0) {
      throw new Error(
        `run_design_script attempted to modify protected wiki/source paths: ${protectedMutations.join(", ")}`
      );
    }
    const outputs = await collectAndCopyDesignScriptOutputs({
      sourceWorkspaceDir: isolatedWorkspace.tempWorkspaceDir,
      destinationWorkspaceDir: input.workspaceDir,
      outputPaths: input.outputPaths
    });

    return {
      status: "completed",
      runner,
      scriptPath: relativeWorkspacePath(input.workspaceDir, resolvedScriptPath),
      command: commandLine,
      exitCode: 0,
      stdout: stdoutText,
      stderr: stderrText,
      outputs
    };
  } catch (error) {
    const protectedMutations = await restoreDesignScriptProtectedPaths(protectedSnapshots);
    const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const output = [
      `$ ${commandLine}`,
      failed.stdout?.toString() ?? "",
      failed.stderr?.toString() ?? "",
      protectedMutations.length > 0
        ? `run_design_script attempted to modify protected wiki/source paths: ${protectedMutations.join(", ")}`
        : "",
      failed.message ?? String(error)
    ].filter((part) => part.trim().length > 0).join("\n");
    throw new Error(truncateOutput(output, input.maxOutputChars));
  } finally {
    await rm(isolatedWorkspace.tempRootDir, { recursive: true, force: true });
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
type WriteDesignCodeFileTool = AgentTool<typeof writeDesignCodeFileParameters, { path: string; bytes: number }>;
type ReplaceFileTextTool = AgentTool<
  typeof replaceFileTextParameters,
  { path: string; replacements: number; bytes: number }
>;
type ReplaceDesignCodeFileTextTool = AgentTool<
  typeof replaceDesignCodeFileTextParameters,
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
type UpdateDesignDependencyTool = AgentTool<
  typeof updateDesignDependencyParameters,
  Awaited<ReturnType<typeof updateDesignDependency>>
>;
type SyncDesignEnvironmentTool = AgentTool<
  typeof syncDesignEnvironmentParameters,
  Awaited<ReturnType<typeof syncDesignEnvironment>>
>;
type VerifyDesignPythonImportTool = AgentTool<
  typeof verifyDesignPythonImportParameters,
  Awaited<ReturnType<typeof verifyDesignPythonImport>>
>;
type RunDesignScriptTool = AgentTool<
  typeof runDesignScriptParameters,
  Awaited<ReturnType<typeof runDesignScript>>
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
      "Creates or overwrites a UTF-8 text file inside the workspace. Use this when the user asks you to actually edit a local writing project or manuscript file. This tool does not write knowledge-base/pages/ synthesis pages; use build_wiki_page for evidence-grounded wiki page writes or read_file plus replace_file_text for a precise edit to an existing page.",
    parameters: writeFileParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: WriteFileParameters) => {
      const resolvedPath = await resolveWorkspaceWritablePath(resolvedWorkspaceDir, args.path);
      const relativePath = relativeWorkspacePath(resolvedWorkspaceDir, resolvedPath);
      if (isWikiSynthesisPagePath(relativePath)) {
        throw new Error(
          "write_file cannot create or overwrite synthesis wiki pages under knowledge-base/pages/. Use build_wiki_page for evidence-grounded wiki page writes, or read_file plus replace_file_text for a precise edit to an existing page."
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

  const writeDesignCodeFileTool: WriteDesignCodeFileTool = {
    name: "write_design_code_file",
    label: "Write Design Code File",
    description:
      "Creates or overwrites a UTF-8 file only under knowledge-base/design-code/. Accepts paths relative to that design-code project or prefixed with knowledge-base/design-code/. This is not a generic workspace file writer.",
    parameters: writeDesignCodeFileParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: WriteDesignCodeFileParameters) => {
      const resolvedPath = await resolveDesignCodeWritableFilePath(resolvedWorkspaceDir, args.path);
      await writeFile(resolvedPath, args.content, "utf8");
      const relativePath = relativeWorkspacePath(resolvedWorkspaceDir, resolvedPath);

      return {
        content: [{ type: "text", text: `Wrote ${relativePath}.` }],
        details: {
          path: relativePath,
          bytes: Buffer.byteLength(args.content, "utf8")
        }
      };
    }
  };

  const replaceDesignCodeFileTextTool: ReplaceDesignCodeFileTextTool = {
    name: "replace_design_code_file_text",
    label: "Replace Design Code File Text",
    description:
      "Replaces an exact text block in a UTF-8 file only under knowledge-base/design-code/. Use read_file first, then replace the smallest exact block. This is not a generic workspace file editor.",
    parameters: replaceDesignCodeFileTextParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: ReplaceDesignCodeFileTextParameters) => {
      if (!args.search) {
        throw new Error("Search text is required.");
      }

      const resolvedPath = await resolveDesignCodeWritableFilePath(resolvedWorkspaceDir, args.path);
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

  const updateDesignDependencyTool: UpdateDesignDependencyTool = {
    name: "update_design_dependency",
    label: "Update Design Dependency",
    description:
      "Updates dependency declarations in knowledge-base/design-code/pyproject.toml without running pip or arbitrary uv commands. Follow this with sync_design_environment to install the declared environment.",
    parameters: updateDesignDependencyParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: UpdateDesignDependencyParameters) => {
      const result = await updateDesignDependency({
        workspaceDir: resolvedWorkspaceDir,
        name: args.name,
        specifier: args.specifier,
        group: args.group ?? "main"
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const syncDesignEnvironmentTool: SyncDesignEnvironmentTool = {
    name: "sync_design_environment",
    label: "Sync Design Environment",
    description:
      "Runs uv sync for knowledge-base/design-code while forcing the shared root .venv as the project environment. This is not a general shell and cannot sync arbitrary projects.",
    parameters: syncDesignEnvironmentParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: SyncDesignEnvironmentParameters) => {
      const maxOutputChars = normalizeDesignToolOutputChars(args.maxOutputChars);
      const result = await syncDesignEnvironment({
        workspaceDir: resolvedWorkspaceDir,
        projectPath: args.projectPath,
        maxOutputChars
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const verifyDesignPythonImportTool: VerifyDesignPythonImportTool = {
    name: "verify_design_python_import",
    label: "Verify Design Python Import",
    description:
      "Verifies a Python module imports with the repository root .venv Python after sync_design_environment. This is used after package install requests.",
    parameters: verifyDesignPythonImportParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: VerifyDesignPythonImportParameters) => {
      const maxOutputChars = normalizeDesignToolOutputChars(args.maxOutputChars);
      const result = await verifyDesignPythonImport({
        workspaceDir: resolvedWorkspaceDir,
        moduleName: args.moduleName,
        maxOutputChars
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };

  const runDesignScriptTool: RunDesignScriptTool = {
    name: "run_design_script",
    label: "Run Design Script",
    description:
      "Runs a workspace-local Python design layout or verification script with the repository root .venv Python or KLayout batch mode, then verifies expected generated files such as .gds outputs. This is not a general shell.",
    parameters: runDesignScriptParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: RunDesignScriptParameters) => {
      const maxOutputChars = normalizeDesignToolOutputChars(args.maxOutputChars);
      const result = await runDesignScript({
        workspaceDir: resolvedWorkspaceDir,
        scriptPath: args.scriptPath,
        runner: args.runner,
        outputPaths: args.outputPaths,
        maxOutputChars
      });

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
      writeDesignArtifactTool,
      writeDesignCodeFileTool,
      replaceDesignCodeFileTextTool,
      updateDesignDependencyTool,
      syncDesignEnvironmentTool,
      verifyDesignPythonImportTool,
      runDesignScriptTool
    ],
    tailFullTools: [
      loadPaperWritingSkillTool
    ]
  };
}
