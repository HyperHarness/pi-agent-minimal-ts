import test, { type TestOptions } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Shared, test-only cases extracted from tools.test.ts at PR #38 96bf35ba.
// Keep fixture script bytes and assertions unchanged in both registrations.
// Importing this module does not register tests or select an execution backend.
export type RunDesignScriptCaseTool = {
  execute: (
    toolCallId: string,
    args: {
      scriptPath: string;
      runner?: "auto" | "python" | "klayout";
      outputPaths?: string[];
      maxOutputChars?: number;
    },
    signal: undefined,
  ) => Promise<{ content?: { type?: string; text?: string }[]; details?: unknown }>;
};

function rootVenvPythonDisplayPath(): string {
  return process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
}

function rootVenvPythonPath(workspaceDir: string): string {
  return path.join(workspaceDir, ...rootVenvPythonDisplayPath().split("/"));
}

async function writeFakePythonExecutable(filePath: string, scriptLines: string[]): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("fake python.exe shell-script shims are not executable on Windows");
  }
  await writeFile(filePath, [...scriptLines, ""].join("\n"), "utf8");
  await chmod(filePath, 0o755);
}

function rootVenvPythonCommandPathFromDesignScriptDir(): string {
  return path.join(
    "..",
    "..",
    "..",
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
}

export type DesignScriptCaseToolFactory = (workspace: string) => RunDesignScriptCaseTool;
export type OriginalDesignScriptCaseRegistrar = (
  name: string, options: TestOptions, body: () => Promise<void>,
) => unknown;

/** The standalone suite supplies its original default tool factory. Only the
 * separately reviewed pilot entry supplies an authenticated external backend.
 * The optional registrar permits offline registration/negative-assertion tests;
 * it does not confer execution authority or establish sandbox qualification. */
export function registerOriginalDesignScriptCases(
  getRunDesignScriptTool: DesignScriptCaseToolFactory,
  register: OriginalDesignScriptCaseRegistrar = test,
): void {
  register("run_design_script uses the parent root venv Python and ignores nested design-code venvs", { skip: process.platform === "win32" ? "fake python.exe shell-script shims are not executable on Windows" : false }, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
    const projectDir = path.join(workspace, "design-repo", "design-code");
    const scriptDir = path.join(projectDir, "scripts");
    const rootVenvPython = rootVenvPythonPath(workspace);
    const nestedVenvPython = rootVenvPythonPath(projectDir);

    try {
      await mkdir(scriptDir, { recursive: true });
      await mkdir(path.dirname(rootVenvPython), { recursive: true });
      await mkdir(path.dirname(nestedVenvPython), { recursive: true });
      await writeFile(path.join(projectDir, "pyproject.toml"), "[project]\nname = \"pi-chip-design\"\n", "utf8");

      await writeFakePythonExecutable(rootVenvPython, [
        "#!/bin/sh",
        "echo root-venv-python-used >&2",
        "exec python3 \"$@\"",
      ]);

      await writeFakePythonExecutable(nestedVenvPython, [
        "#!/bin/sh",
        "echo nested-venv-python-used >&2",
        "exec python3 \"$@\"",
      ]);

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
          scriptPath: "design-repo/design-code/scripts/generate_gds.py",
          runner: "python",
          outputPaths: ["design-repo/design-code/outputs/from-root-venv.gds"],
        },
        undefined,
      );

      assert.deepEqual(result.details, {
        status: "completed",
        runner: "python",
        scriptPath: "design-repo/design-code/scripts/generate_gds.py",
        command: `${rootVenvPythonCommandPathFromDesignScriptDir()} generate_gds.py`,
        exitCode: 0,
        stdout: "script complete\n",
        stderr: "root-venv-python-used\n",
        outputs: [
          {
            path: "design-repo/design-code/outputs/from-root-venv.gds",
            bytes: Buffer.byteLength("root venv gds"),
          },
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  register("run_design_script copies back only declared design-code outputs from an isolated run", { skip: process.platform === "win32" ? "fake python.exe shell-script shims are not executable on Windows" : false }, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
    const projectDir = path.join(workspace, "design-repo", "design-code");
    const scriptDir = path.join(projectDir, "scripts");
    const rootVenvPython = rootVenvPythonPath(workspace);
    const leakedWikiPath = path.join(workspace, "knowledge-base", "pages", "leaked-design-script.md");

    try {
      await mkdir(scriptDir, { recursive: true });
      await mkdir(path.dirname(rootVenvPython), { recursive: true });

      await writeFakePythonExecutable(rootVenvPython, [
        "#!/bin/sh",
        "exec python3 \"$@\"",
      ]);

      await writeFile(path.join(projectDir, "pyproject.toml"), "[project]\nname = \"pi-chip-design\"\n", "utf8");
      await writeFile(
        path.join(scriptDir, "generate_isolated_gds.py"),
        [
          "from pathlib import Path",
          "Path('../outputs').mkdir(exist_ok=True)",
          "Path('../outputs/isolated.gds').write_bytes(b'isolated gds')",
          "Path('../../pages').mkdir(exist_ok=True)",
          "Path('../../pages/leaked-design-script.md').write_text('# leaked\\n')",
          "print('script complete')",
          ""
        ].join("\n"),
        "utf8",
      );

      const runDesignScriptTool = getRunDesignScriptTool(workspace);
      const result = await runDesignScriptTool.execute(
        "call-run-design-script-isolated",
        {
          scriptPath: "design-repo/design-code/scripts/generate_isolated_gds.py",
          runner: "python",
          outputPaths: ["design-repo/design-code/outputs/isolated.gds"],
        },
        undefined,
      );

      assert.deepEqual(result.details, {
        status: "completed",
        runner: "python",
        scriptPath: "design-repo/design-code/scripts/generate_isolated_gds.py",
        command: `${rootVenvPythonCommandPathFromDesignScriptDir()} generate_isolated_gds.py`,
        exitCode: 0,
        stdout: "script complete\n",
        stderr: "",
        outputs: [
          {
            path: "design-repo/design-code/outputs/isolated.gds",
            bytes: Buffer.byteLength("isolated gds"),
          },
        ],
      });
      assert.equal(
        await readFile(path.join(projectDir, "outputs", "isolated.gds"), "utf8"),
        "isolated gds",
      );
      await assert.rejects(() => readFile(leakedWikiPath, "utf8"), /ENOENT/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  register("run_design_script restores protected wiki paths when a script writes outside design-code", { skip: process.platform === "win32" ? "fake python.exe shell-script shims are not executable on Windows" : false }, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
    const projectDir = path.join(workspace, "design-repo", "design-code");
    const scriptDir = path.join(projectDir, "scripts");
    const rootVenvPython = rootVenvPythonPath(workspace);
    const leakedWikiPath = path.join(workspace, "knowledge-base", "pages", "absolute-leak.md");

    try {
      await mkdir(scriptDir, { recursive: true });
      await mkdir(path.join(workspace, "knowledge-base"), { recursive: true });
      await mkdir(path.dirname(rootVenvPython), { recursive: true });

      await writeFakePythonExecutable(rootVenvPython, [
        "#!/bin/sh",
        "exec python3 \"$@\"",
      ]);

      await writeFile(path.join(projectDir, "pyproject.toml"), "[project]\nname = \"pi-chip-design\"\n", "utf8");
      await writeFile(
        path.join(scriptDir, "absolute_leak.py"),
        [
          "from pathlib import Path",
          `workspace = Path(${JSON.stringify(workspace)})`,
          "Path('../outputs').mkdir(exist_ok=True)",
          "Path('../outputs/absolute-leak.gds').write_bytes(b'should not copy')",
          "(workspace / 'knowledge-base/pages').mkdir(exist_ok=True)",
          "(workspace / 'knowledge-base/pages/absolute-leak.md').write_text('# leaked\\n')",
          "print('script complete')",
          ""
        ].join("\n"),
        "utf8",
      );

      const runDesignScriptTool = getRunDesignScriptTool(workspace);
      await assert.rejects(
        () => runDesignScriptTool.execute(
          "call-run-design-script-absolute-leak",
          {
            scriptPath: "design-repo/design-code/scripts/absolute_leak.py",
            runner: "python",
            outputPaths: ["design-repo/design-code/outputs/absolute-leak.gds"],
          },
          undefined,
        ),
        /run_design_script attempted to modify protected wiki\/source paths|Read-only file system|Permission denied/,
      );

      await assert.rejects(() => readFile(leakedWikiPath, "utf8"), /ENOENT/);
      await assert.rejects(
        () => readFile(path.join(projectDir, "outputs", "absolute-leak.gds"), "utf8"),
        /ENOENT/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
