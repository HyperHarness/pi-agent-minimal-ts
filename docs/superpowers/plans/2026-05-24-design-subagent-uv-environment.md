# Design Subagent UV Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `design-subagent` a bounded `uv sync` workflow for a separate `knowledge-base/design-code` Python repository while using `/home/ququan2/pi-agent-minimal-ts/.venv` as the only design Python environment.

**Architecture:** Keep the existing restricted script runner model and add one new restricted tool, `sync_design_environment`, in `src/agent/file-tools.ts`. The design-code repository owns `pyproject.toml` and `uv.lock`, while the parent TypeScript repository only owns tool wiring, prompt policy, tests, and ignore rules that keep the nested repository out of the parent commit.

**Tech Stack:** TypeScript, Node `execFile`, `node:test`, `uv`, Python packaging with `pyproject.toml`, nested Git repository under `knowledge-base/design-code`.

---

## File Structure

- Modify `src/agent/file-tools.ts`: add `sync_design_environment`, root `.venv` interpreter resolution, and stop looking for nested `.venv` directories.
- Modify `src/agent/tool-types.ts`: add `"sync_design_environment"` to `ToolName` and the `design-subagent` boundary.
- Modify `src/agent/agent-prompts.ts`: teach `design-subagent` the `knowledge-base/design-code` and root `.venv` policy.
- Modify `test/agent/tools.test.ts`: add failing tests first, then update expected tool lists and prompt assertions.
- Modify `.gitignore`: ignore `design-projects/` and the nested `knowledge-base/design-code/` repository from the parent repository.
- Create `knowledge-base/design-code/` as a separate Git repository: initial Python package managed by `uv`, with `gdsfactory` as a dependency.
- Remove `/home/ququan2/pi-agent-minimal-ts/design-projects/` after migrating any useful seed package content into `knowledge-base/design-code/`.

## Task 1: Tool Tests for Root Venv and Environment Sync

**Files:**
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Add a helper for the new tool near `getRunDesignScriptTool`**

Add this helper after `getRunDesignScriptTool`:

```ts
function getSyncDesignEnvironmentTool(workspace: string): SyncDesignEnvironmentTool {
  const tools = createTools(workspace, { toolProfile: "full" }) as ReadonlyArray<{
    name: string;
    execute?: SyncDesignEnvironmentTool["execute"];
  }>;
  const syncDesignEnvironmentTool = tools.find((tool) => tool.name === "sync_design_environment");
  assert.ok(syncDesignEnvironmentTool);
  assert.equal(typeof syncDesignEnvironmentTool.execute, "function");
  return syncDesignEnvironmentTool as SyncDesignEnvironmentTool;
}
```

At the top-level test helper type declarations, add:

```ts
type SyncDesignEnvironmentTool = ExtractTool<typeof createTools, "sync_design_environment">;
```

- [ ] **Step 2: Write the failing test for parent root `.venv` interpreter resolution**

Replace the existing test named `run_design_script uses the workspace root venv Python for design scripts` with this stricter version:

```ts
test("run_design_script uses the parent root venv Python and ignores nested design-code venvs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const projectDir = path.join(workspace, "knowledge-base", "design-code");
  const scriptDir = path.join(projectDir, "scripts");
  const rootVenvBinDir = path.join(workspace, ".venv", "bin");
  const nestedVenvBinDir = path.join(projectDir, ".venv", "bin");

  try {
    await mkdir(scriptDir, { recursive: true });
    await mkdir(rootVenvBinDir, { recursive: true });
    await mkdir(nestedVenvBinDir, { recursive: true });

    const rootVenvPython = path.join(rootVenvBinDir, "python");
    await writeFile(
      rootVenvPython,
      [
        "#!/bin/sh",
        "echo root-venv-python-used >&2",
        "exec python3 \"$@\"",
        ""
      ].join("\n"),
      "utf8",
    );
    await chmod(rootVenvPython, 0o755);

    const nestedVenvPython = path.join(nestedVenvBinDir, "python");
    await writeFile(
      nestedVenvPython,
      [
        "#!/bin/sh",
        "echo nested-venv-python-used >&2",
        "exec python3 \"$@\"",
        ""
      ].join("\n"),
      "utf8",
    );
    await chmod(nestedVenvPython, 0o755);

    await writeFile(
      path.join(scriptDir, "generate_gds.py"),
      [
        "from pathlib import Path",
        "Path('../outputs').mkdir(exist_ok=True)",
        "Path('../outputs/from-root-venv.gds').write_bytes(b'root venv gds')",
        "print('script complete')",
        ""
      ].join("\n"),
      "utf8",
    );

    const runDesignScriptTool = getRunDesignScriptTool(workspace);
    const result = await runDesignScriptTool.execute(
      "call-run-design-script-root-venv",
      {
        scriptPath: "knowledge-base/design-code/scripts/generate_gds.py",
        runner: "python",
        outputPaths: ["knowledge-base/design-code/outputs/from-root-venv.gds"],
      },
      undefined,
    );

    assert.deepEqual(result.details, {
      status: "completed",
      runner: "python",
      scriptPath: "knowledge-base/design-code/scripts/generate_gds.py",
      command: "../../../.venv/bin/python generate_gds.py",
      exitCode: 0,
      stdout: "script complete\n",
      stderr: "root-venv-python-used\n",
      outputs: [
        {
          path: "knowledge-base/design-code/outputs/from-root-venv.gds",
          bytes: Buffer.byteLength("root venv gds"),
        },
      ],
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Write the failing test for `sync_design_environment` happy path**

Add this test after the root venv script-runner test:

```ts
test("sync_design_environment runs uv sync for knowledge-base design-code into the root venv", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");
  const fakeBinDir = path.join(workspace, "fake-bin");
  const callsPath = path.join(workspace, "uv-calls.jsonl");
  const originalPath = process.env.PATH;

  try {
    await mkdir(designCodeDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(
      path.join(designCodeDir, "pyproject.toml"),
      [
        "[project]",
        "name = \"pi-chip-design\"",
        "version = \"0.1.0\"",
        "requires-python = \">=3.11\"",
        "dependencies = [\"gdsfactory>=8\"]",
        ""
      ].join("\n"),
      "utf8",
    );

    const fakeUv = path.join(fakeBinDir, "uv");
    await writeFile(
      fakeUv,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const callsPath = process.env.PI_TEST_UV_CALLS_PATH;",
        "fs.appendFileSync(callsPath, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "  env: process.env.UV_PROJECT_ENVIRONMENT",
        "}) + '\\n');",
        "fs.mkdirSync(path.join(process.env.UV_PROJECT_ENVIRONMENT, 'bin'), { recursive: true });",
        "fs.writeFileSync(path.join(process.env.UV_PROJECT_ENVIRONMENT, 'bin', 'python'), '#!/bin/sh\\necho synced-python\\n');",
        "console.log('uv sync complete');",
        ""
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeUv, 0o755);

    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.PI_TEST_UV_CALLS_PATH = callsPath;

    const syncDesignEnvironmentTool = getSyncDesignEnvironmentTool(workspace);
    const result = await syncDesignEnvironmentTool.execute(
      "call-sync-design-environment",
      {
        projectPath: "knowledge-base/design-code",
      },
      undefined,
    );

    assert.deepEqual(result.details, {
      status: "synced",
      projectPath: "knowledge-base/design-code",
      environmentPath: ".venv",
      pythonPath: ".venv/bin/python",
      command: "uv sync --project knowledge-base/design-code",
      exitCode: 0,
      stdout: "uv sync complete\n",
      stderr: "",
    });

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; env: string });
    assert.deepEqual(calls, [
      {
        argv: ["sync", "--project", designCodeDir],
        cwd: workspace,
        env: path.join(workspace, ".venv"),
      },
    ]);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.PI_TEST_UV_CALLS_PATH;
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Write the failing test for path restriction**

Add this test after the happy-path sync test:

```ts
test("sync_design_environment rejects projects outside knowledge-base design-code", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));

  try {
    const syncDesignEnvironmentTool = getSyncDesignEnvironmentTool(workspace);

    await assert.rejects(
      syncDesignEnvironmentTool.execute(
        "call-sync-design-environment-outside",
        {
          projectPath: "design-projects/superconducting-qubit-chip",
        },
        undefined,
      ),
      /sync_design_environment only runs for knowledge-base\/design-code/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Run the tests to confirm the new tests fail**

Run:

```bash
npm test -- --test-name-pattern "run_design_script uses the parent root venv|sync_design_environment"
```

Expected: fail because `SyncDesignEnvironmentTool` and `sync_design_environment` are not implemented yet, and the old nested-venv resolution is still present.

## Task 2: Implement the Restricted `uv sync` Tool

**Files:**
- Modify: `src/agent/file-tools.ts`

- [ ] **Step 1: Add parameters and types**

Add this block after `runDesignScriptParameters`:

```ts
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
```

Add this type after `type RunDesignScriptParameters`:

```ts
type SyncDesignEnvironmentParameters = Static<typeof syncDesignEnvironmentParameters>;
```

Add this tool type near the other tool aliases if the file uses local aliases for tool shapes:

```ts
type SyncDesignEnvironmentTool = AgentTool<SyncDesignEnvironmentParameters>;
```

- [ ] **Step 2: Replace nested venv search with root venv resolution**

Replace `candidateVenvPythonPaths` and `findWorkspaceVenvPython` with:

```ts
function rootVenvDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".venv");
}

function rootVenvPythonCandidates(workspaceDir: string): string[] {
  const venvDir = rootVenvDir(workspaceDir);
  if (process.platform === "win32") {
    return [
      path.join(venvDir, "Scripts", "python.exe"),
      path.join(venvDir, "Scripts", "python")
    ];
  }

  return [
    path.join(venvDir, "bin", "python"),
    path.join(venvDir, "bin", "python3")
  ];
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
```

In `designScriptCommandForRunner`, replace:

```ts
const venvPython = await findWorkspaceVenvPython(input.workspaceDir);
```

with:

```ts
const venvPython = await findRootVenvPython(input.workspaceDir);
```

- [ ] **Step 3: Add design-code project path helpers**

Add these helpers after `findRootVenvPython`:

```ts
function designCodeProjectDir(workspaceDir: string): string {
  return path.join(workspaceDir, "knowledge-base", "design-code");
}

function normalizeWorkspaceRelativePath(workspaceDir: string, resolvedPath: string): string {
  const relativePath = path.relative(workspaceDir, resolvedPath);
  return relativePath.length > 0 ? relativePath : ".";
}

async function resolveDesignCodeProjectPath(workspaceDir: string, requestedPath: string | undefined): Promise<string> {
  const expectedProjectDir = designCodeProjectDir(workspaceDir);
  const resolvedProjectDir = await resolveWorkspacePath(workspaceDir, requestedPath ?? "knowledge-base/design-code");
  assertPathInsideDirectory(workspaceDir, resolvedProjectDir);

  if (path.resolve(resolvedProjectDir) !== path.resolve(expectedProjectDir)) {
    throw new Error("sync_design_environment only runs for knowledge-base/design-code.");
  }

  const pyprojectPath = path.join(resolvedProjectDir, "pyproject.toml");
  if (!(await fileExists(pyprojectPath))) {
    throw new Error("sync_design_environment requires knowledge-base/design-code/pyproject.toml.");
  }

  return resolvedProjectDir;
}
```

- [ ] **Step 4: Implement `syncDesignEnvironment`**

Add this function before `runDesignScript`:

```ts
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
  const args = ["sync", "--project", projectDir];
  const commandLine = `uv sync --project ${normalizeWorkspaceRelativePath(input.workspaceDir, projectDir)}`;

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
```

- [ ] **Step 5: Add the tool object and expose it in full tools**

Add this tool before `runDesignScriptTool`:

```ts
const syncDesignEnvironmentTool: SyncDesignEnvironmentTool = {
  name: "sync_design_environment",
  label: "Sync Design Environment",
  description:
    "Runs uv sync for knowledge-base/design-code while forcing the shared root .venv as the project environment. This is not a general shell and cannot sync arbitrary projects.",
  parameters: syncDesignEnvironmentParameters,
  executionMode: "sequential",
  execute: async (_toolCallId: string, args: SyncDesignEnvironmentParameters) => {
    const maxOutputChars = Math.max(1000, Math.trunc(args.maxOutputChars ?? 12000));
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
```

Update `artifactFullTools` to:

```ts
artifactFullTools: [
  writeDesignArtifactTool,
  syncDesignEnvironmentTool,
  runDesignScriptTool
],
```

- [ ] **Step 6: Run targeted tool tests**

Run:

```bash
npm test -- --test-name-pattern "run_design_script uses the parent root venv|sync_design_environment"
```

Expected: pass for the new root `.venv` and sync tests.

## Task 3: Wire Tool Names and Worker Prompt

**Files:**
- Modify: `src/agent/tool-types.ts`
- Modify: `src/agent/agent-prompts.ts`
- Modify: `test/agent/tools.test.ts`
- Modify: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Add the tool name and boundary entry**

In `src/agent/tool-types.ts`, add `"sync_design_environment"` to `ToolName` immediately before `"run_design_script"`:

```ts
  | "sync_design_environment"
  | "run_design_script"
```

Update the `design-subagent` boundary to:

```ts
  "design-subagent": [
    "answer_paper_wiki_question",
    "search_paper_wiki",
    "search_local_papers",
    "list_local_papers",
    "sync_design_environment",
    "run_design_script",
    "write_design_artifact"
  ],
```

- [ ] **Step 2: Update expected full tool list**

In `test/agent/tools.test.ts`, update `EXPECTED_FULL_ONLY_TOOL_NAMES`:

```ts
const EXPECTED_FULL_ONLY_TOOL_NAMES = [
  "write_paper_wiki_source",
  "generate_paper_wiki_summary",
  "paper_wiki_relations",
  "search_paper_wiki",
  "write_design_artifact",
  "sync_design_environment",
  "run_design_script",
  "paper_orchestra_prepare_workspace",
  "paper_orchestra_check_draft",
  "paper_orchestra_score_delta",
  "paper_orchestra_snapshot_provenance",
  "load_paper_writing_skill",
  "list_local_papers",
  "fetch_paper_webpage",
  "register_manual_paper_download",
  "open_paper_page_for_login",
  "parse_paper",
] as const;
```

In the `createToolsForBoundary exposes isolated wiki and worker tool surfaces` test, add:

```ts
assert.ok(designTools.some((tool) => tool.name === "sync_design_environment"));
```

- [ ] **Step 3: Update the design-subagent prompt**

Replace `DESIGN_SUBAGENT_SYSTEM_PROMPT` with:

```ts
export const DESIGN_SUBAGENT_SYSTEM_PROMPT = [
  "You are the design-subagent for this project. You operate in a clean context with a restricted chip-design reasoning and layout-code tool surface.",
  "Use local wiki and paper evidence before writing design artifacts. Keep design outputs as structured design records, verification reports, failure records, or benchmark cases.",
  "All self-developed layout code belongs under knowledge-base/design-code/. Treat it as a separate design-code Git repository that is part of the knowledge base, not as ordinary parent-repo TypeScript source.",
  "Do not create or use design-projects/ for new work. That path is deprecated; migrate useful legacy design code into knowledge-base/design-code/ when implementation work requires it.",
  "Manage Python dependencies through knowledge-base/design-code/pyproject.toml and uv.lock. The only managed Python runtime environment is the parent repository root .venv.",
  "When Python dependencies may be missing, call sync_design_environment before running layout or verification scripts. Do not install packages ad hoc with pip or use uv as a general shell.",
  "Run workspace-local layout or verification scripts with run_design_script when the user asks for concrete design artifacts such as GDS files. Use the klayout runner for KLayout Python scripts and report generated output paths or the exact execution failure.",
  "Write design artifacts with write_design_artifact. Do not edit arbitrary source files, write wiki pages, download papers, run external web search, or use run_design_script as a general shell.",
  "When evidence is insufficient for a design conclusion, write a bounded uncertainty or failure record instead of inventing a design result."
].join(\" \");
```

- [ ] **Step 4: Add prompt assertions**

In `test/agent/pi-agent.test.ts`, extend the existing design prompt assertions:

```ts
assert.match(designPrompt as string, /knowledge-base\/design-code/);
assert.match(designPrompt as string, /sync_design_environment/);
assert.match(designPrompt as string, /root \.venv/);
assert.match(designPrompt as string, /design-projects\/.*deprecated/);
```

- [ ] **Step 5: Run boundary and prompt tests**

Run:

```bash
npm test -- --test-name-pattern "createTools full profile|createToolsForBoundary|tools module re-exports|exports worker prompts|design-subagent"
```

Expected: pass.

## Task 4: Create the Separate Design-Code Repository and Remove the Old Location

**Files:**
- Modify: `.gitignore`
- Create in nested repo: `knowledge-base/design-code/.gitignore`
- Create in nested repo: `knowledge-base/design-code/README.md`
- Create in nested repo: `knowledge-base/design-code/pyproject.toml`
- Create in nested repo: `knowledge-base/design-code/src/pi_chip_design/__init__.py`
- Create in nested repo: `knowledge-base/design-code/src/pi_chip_design/layouts/__init__.py`
- Create in nested repo: `knowledge-base/design-code/tests/test_import.py`
- Delete local tree: `design-projects/`

- [ ] **Step 1: Update parent `.gitignore`**

Replace:

```gitignore
design-projects/superconducting-qubit-chip/
```

with:

```gitignore
design-projects/
knowledge-base/design-code/
```

Keep the existing top-level `.venv/` ignore entry.

- [ ] **Step 2: Create the new design-code directory**

Run:

```bash
mkdir -p knowledge-base/design-code/src/pi_chip_design/layouts knowledge-base/design-code/tests
```

Expected: directories exist under `/home/ququan2/pi-agent-minimal-ts/knowledge-base/design-code`.

- [ ] **Step 3: Write the nested repo files**

Create `knowledge-base/design-code/.gitignore`:

```gitignore
.venv/
.ruff_cache/
.pytest_cache/
__pycache__/
*.py[cod]
outputs/
*.gds
*.oas
*.lyrdb
dist/
build/
*.egg-info/
```

Create `knowledge-base/design-code/README.md`:

```md
# PI Chip Design

This repository contains the design-subagent Python codebase for superconducting-chip layout generation and verification.

It is intentionally stored under `knowledge-base/design-code/` because design code, verification scripts, and reusable layout lessons are part of the local wiki data flywheel. This repository has its own Git history separate from the parent `pi-agent-minimal-ts` repository.

## Environment

The source package owns `pyproject.toml` and `uv.lock`, but the Python environment is shared at the parent repository root:

```sh
UV_PROJECT_ENVIRONMENT=/home/ququan2/pi-agent-minimal-ts/.venv uv sync --project /home/ququan2/pi-agent-minimal-ts/knowledge-base/design-code
```

The design-subagent normally performs this through `sync_design_environment`.

## Layout

```text
src/pi_chip_design/
  layouts/
scripts/
tests/
outputs/
```

Generated layout outputs should stay under `outputs/` and remain out of Git unless a small fixture is intentionally added for a test.
```

Create `knowledge-base/design-code/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "pi-chip-design"
version = "0.1.0"
description = "Python package for superconducting-chip layout generation and verification."
readme = "README.md"
requires-python = ">=3.11"
dependencies = [
  "gdsfactory>=8"
]

[project.optional-dependencies]
dev = [
  "pytest>=8",
  "ruff>=0.6"
]

[tool.setuptools.packages.find]
where = ["src"]

[tool.ruff]
line-length = 100
target-version = "py311"

[tool.pytest.ini_options]
testpaths = ["tests"]
```

Create `knowledge-base/design-code/src/pi_chip_design/__init__.py`:

```py
"""Reusable Python package for PI chip layout design workflows."""

__all__: list[str] = []
```

Create `knowledge-base/design-code/src/pi_chip_design/layouts/__init__.py`:

```py
"""Layout family modules for PI chip design workflows."""

__all__: list[str] = []
```

Create `knowledge-base/design-code/tests/test_import.py`:

```py
import pi_chip_design


def test_package_imports() -> None:
    assert pi_chip_design.__all__ == []
```

- [ ] **Step 4: Initialize and commit the nested Git repository**

Run:

```bash
git -C knowledge-base/design-code init
git -C knowledge-base/design-code add .gitignore README.md pyproject.toml src/pi_chip_design/__init__.py src/pi_chip_design/layouts/__init__.py tests/test_import.py
git -C knowledge-base/design-code commit -m "Initialize design code package"
```

Expected: nested repository has one initial commit. If Git identity is missing, set local identity only inside `knowledge-base/design-code` and rerun the commit:

```bash
git -C knowledge-base/design-code config user.name "PI Design Agent"
git -C knowledge-base/design-code config user.email "pi-design-agent@example.local"
git -C knowledge-base/design-code commit -m "Initialize design code package"
```

- [ ] **Step 5: Remove the deprecated design-projects tree**

Run:

```bash
rm -rf design-projects
```

Expected: `/home/ququan2/pi-agent-minimal-ts/design-projects/` no longer exists. The useful seed package structure now exists in `knowledge-base/design-code/`.

- [ ] **Step 6: Check parent Git status**

Run:

```bash
git status --short --untracked-files=all
```

Expected: parent repo shows changes to `.gitignore`, TypeScript/test files from prior tasks, and no untracked files under `knowledge-base/design-code/` because that nested repo is ignored by the parent.

## Task 5: Lock, Verify, and Commit

**Files:**
- Modify: `knowledge-base/design-code/uv.lock`
- Commit in nested repo: `knowledge-base/design-code`
- Commit in parent repo: `pi-agent-minimal-ts`

- [ ] **Step 1: Sync the design environment with the new tool path**

Run:

```bash
UV_PROJECT_ENVIRONMENT=/home/ququan2/pi-agent-minimal-ts/.venv uv sync --project /home/ququan2/pi-agent-minimal-ts/knowledge-base/design-code
```

Expected: `knowledge-base/design-code/uv.lock` is created or updated, and `/home/ququan2/pi-agent-minimal-ts/.venv/bin/python` exists.

- [ ] **Step 2: Run design-code package checks**

Run:

```bash
/home/ququan2/pi-agent-minimal-ts/.venv/bin/python -m pytest /home/ququan2/pi-agent-minimal-ts/knowledge-base/design-code/tests
/home/ququan2/pi-agent-minimal-ts/.venv/bin/python -m ruff check /home/ququan2/pi-agent-minimal-ts/knowledge-base/design-code/src /home/ququan2/pi-agent-minimal-ts/knowledge-base/design-code/tests
```

Expected: both commands pass. If `ruff` is not installed, run the sync command with dev extras:

```bash
UV_PROJECT_ENVIRONMENT=/home/ququan2/pi-agent-minimal-ts/.venv uv sync --project /home/ququan2/pi-agent-minimal-ts/knowledge-base/design-code --extra dev
```

Then rerun the checks.

- [ ] **Step 3: Commit the nested repo lockfile**

Run:

```bash
git -C knowledge-base/design-code status --short
git -C knowledge-base/design-code add uv.lock
git -C knowledge-base/design-code commit -m "Lock design environment dependencies"
```

Expected: nested repo has a second commit containing `uv.lock`.

- [ ] **Step 4: Run targeted parent tests**

Run:

```bash
npm test -- --test-name-pattern "run_design_script uses the parent root venv|sync_design_environment|createTools full profile|createToolsForBoundary|tools module re-exports|exports worker prompts|design-subagent"
```

Expected: pass.

- [ ] **Step 5: Run full parent test suite**

Run:

```bash
npm test
```

Expected: pass.

- [ ] **Step 6: Run whitespace and status checks**

Run:

```bash
git diff --check
git status --short --untracked-files=all
git -C knowledge-base/design-code status --short
```

Expected: no whitespace errors. Parent status should include only intended parent repo changes. Nested repo status should be clean after the lockfile commit.

- [ ] **Step 7: Commit parent repository changes**

Run:

```bash
rtk git add .gitignore src/agent/file-tools.ts src/agent/tool-types.ts src/agent/agent-prompts.ts test/agent/tools.test.ts test/agent/pi-agent.test.ts docs/superpowers/plans/2026-05-24-design-subagent-uv-environment.md
rtk git commit -m "Add design subagent uv environment tooling"
```

Expected: parent repository commit succeeds and does not include `knowledge-base/design-code/` contents.

## Self-Review Notes

- Spec coverage: the plan covers the root `.venv`, `knowledge-base/design-code` nested Git repo, `gdsfactory` dependency declaration, restricted `uv sync` tool, script runner interpreter change, prompt policy, deprecated `design-projects/` cleanup, and tests.
- Placeholder scan: no deferred implementation sections are intentionally left for later.
- Type consistency: the new tool name is consistently `sync_design_environment`; the tool parameter type is `SyncDesignEnvironmentParameters`; the helper is `getSyncDesignEnvironmentTool`.
