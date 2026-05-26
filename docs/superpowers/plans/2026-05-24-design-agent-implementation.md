# Design Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the current `design-subagent` into a first-class `design-agent` that owns bounded layout-code editing, dependency declaration, root `.venv` sync, script execution, and design artifact handoff.

**Architecture:** Keep the existing routed-worker runtime, but rename the public design role to `design-agent` while retaining `design-subagent` as a compatibility alias. Add design-specific tools to the existing tool assembly so the design agent can edit only `design-repo/design-code/`, update only that package's `pyproject.toml`, sync only that package into the root `.venv`, and continue handing structured artifacts back to the wiki agent.

**Tech Stack:** TypeScript, Node built-in `fs/promises`, `child_process.execFile`, `@mariozechner/pi-ai` tool schemas, `node:test`, `uv`, root `.venv`, nested `design-repo/design-code` Python package.

---

## File Structure

- Modify `src/agent/agent-routing.ts`: add public `design-agent` role, compatibility alias parsing, design package-management intent routing, and worker handoff next-owner behavior.
- Modify `src/agent/agent-prompts.ts`: replace design-subagent wording with design-agent wording and explicitly describe the engineering boundary.
- Modify `src/agent/tool-types.ts`: add `design-agent` to the boundary role union, keep `design-subagent` as an alias, and expose new design tools only to the design boundary.
- Modify `src/agent/tools.ts`: normalize the alias so `createToolsForBoundary(workspace, "design-subagent")` returns the same tool surface as `design-agent`.
- Modify `src/agent/file-tools.ts`: add scoped design-code file tools, add structured dependency declaration tooling, reuse the existing root `.venv` sync and script runner.
- Modify `test/agent/pi-agent.test.ts`: cover design-agent routing, prompt wording, and routed worker handoff role.
- Modify `test/agent/tools.test.ts`: cover design-agent tool boundaries, scoped file editing, dependency declaration updates, sync behavior, and forbidden paths.
- Modify `README.md` and `docs/feishu-bridge.env.example`: describe design-agent as the engineering owner and keep design-subagent as a compatibility alias.

## Task 1: Route Design-Agent Requests

**Files:**
- Modify: `src/agent/agent-routing.ts`
- Modify: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Write failing routing tests**

Add these assertions to `test("runSessionPrompt routes paper write commands to the paper-writing worker boundary", ...)` in `test/agent/pi-agent.test.ts`, next to the existing `design write a chip-design failure record` assertion:

```ts
  assert.deepEqual(routeChatPromptToWorker!("design-agent install gdstk"), {
    role: "design-agent",
    instruction: "install gdstk",
    reason: "explicit",
  });

  assert.deepEqual(routeChatPromptToWorker!("design subagent install gdstk"), {
    role: "design-agent",
    instruction: "install gdstk",
    reason: "explicit",
  });

  assert.deepEqual(routeChatPromptToWorker!("please ask design subagent to install the gdstk Python package"), {
    role: "design-agent",
    instruction: "please ask design subagent to install the gdstk Python package",
    reason: "intent",
  });

  assert.deepEqual(routeChatPromptToWorker!("please sync the uv environment for design-repo/design-code"), {
    role: "design-agent",
    instruction: "please sync the uv environment for design-repo/design-code",
    reason: "intent",
  });
```

- [ ] **Step 2: Run routing tests and verify they fail**

Run:

```bash
npm test -- test/agent/pi-agent.test.ts
```

Expected: FAIL because `design-agent` is not an accepted role and `design subagent` package-management requests currently do not route to the design worker.

- [ ] **Step 3: Update routed worker role types and explicit patterns**

In `src/agent/agent-routing.ts`, change the role type and design explicit route block:

```ts
export type RoutedWorkerRole =
  | "paper-writing-worker"
  | "paper-download-subagent"
  | "wiki-evidence-worker"
  | "design-agent"
  | "design-subagent";
```

Replace the current design explicit route block with:

```ts
    matchExplicitWorkerRoute(trimmed, "design-agent", [
      /^\/?design-agent\s+([\s\S]+)$/i,
      /^\/?design\s+agent\s+([\s\S]+)$/i,
      /^\/?design-subagent\s+([\s\S]+)$/i,
      /^\/?design\s+subagent\s+([\s\S]+)$/i,
      /^\/?design\s+([\s\S]+)$/i,
      /^\/?chip\s+design\s+([\s\S]+)$/i,
      /^\/?design\s+task\s+([\s\S]+)$/i
    ]);
```

- [ ] **Step 4: Add design package-management intent routing**

In `src/agent/agent-routing.ts`, replace the `designIntent` block with:

```ts
  const designExecutionIntent =
    /(design[-\s]?agent|design[-\s]?subagent|design-code|gdstk|klayout|gds|layout|chip|quantum|qubit|resonator|coupler|python\s*package|dependency|uv\s*environment|uv\s*sync|pyproject\.toml)/i.test(trimmed) &&
    /(install|sync|update|add|declare|run|generate|check|verify|design|simulate|failure|record|artifact|benchmark|layout)/i.test(trimmed);
  if (designExecutionIntent) {
    return { role: "design-agent", instruction: trimmed, reason: "intent" };
  }
```

- [ ] **Step 5: Normalize legacy design-subagent role for prompt selection and next owner**

In `src/agent/agent-routing.ts`, update the prompt import to use `DESIGN_AGENT_SYSTEM_PROMPT`, and add:

```ts
export function normalizeWorkerRole(role: RoutedWorkerRole): Exclude<RoutedWorkerRole, "design-subagent"> {
  return role === "design-subagent" ? "design-agent" : role;
}
```

Update `systemPromptForWorker()` and `nextOwnerForWorker()` to call `normalizeWorkerRole(role)` before comparisons:

```ts
export function systemPromptForWorker(role: RoutedWorkerRole): string {
  const normalizedRole = normalizeWorkerRole(role);
  if (normalizedRole === "paper-writing-worker") {
    return PAPER_WRITING_WORKER_SYSTEM_PROMPT;
  }
  if (normalizedRole === "paper-download-subagent") {
    return PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT;
  }
  if (normalizedRole === "wiki-evidence-worker") {
    return WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT;
  }
  return DESIGN_AGENT_SYSTEM_PROMPT;
}
```

- [ ] **Step 6: Run routing tests and verify they pass**

Run:

```bash
npm test -- test/agent/pi-agent.test.ts
```

Expected: PASS for the updated routing tests.

- [ ] **Step 7: Commit routing change**

```bash
rtk git add src/agent/agent-routing.ts test/agent/pi-agent.test.ts
rtk git commit -m "Add design agent routing"
```

## Task 2: Rename The Design Prompt And Boundary Surface

**Files:**
- Modify: `src/agent/agent-prompts.ts`
- Modify: `src/agent/tool-types.ts`
- Modify: `src/agent/tools.ts`
- Modify: `test/agent/pi-agent.test.ts`
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Write failing prompt and boundary tests**

In `test/agent/pi-agent.test.ts`, update the design prompt assertions:

```ts
  const designPrompt = (piAgent as { DESIGN_AGENT_SYSTEM_PROMPT?: string }).DESIGN_AGENT_SYSTEM_PROMPT;
  assert.equal(typeof designPrompt, "string");
  assert.match(designPrompt as string, /design-agent/);
  assert.match(designPrompt as string, /layout-code/);
  assert.match(designPrompt as string, /knowledge-base\/design-code/);
  assert.match(designPrompt as string, /sync_design_environment/);
  assert.match(designPrompt as string, /root \.venv/);
  assert.match(designPrompt as string, /Do not install packages ad hoc with pip/);
  assert.match(designPrompt as string, /design-projects\/.*deprecated/);
```

In `test/agent/tools.test.ts`, update the design boundary block to use `design-agent` and add an alias check:

```ts
    const designTools = createToolsForBoundary(workspace, "design-agent");
    assert.deepEqual(designTools.map((tool) => tool.name), getToolBoundaryToolNames("design-agent"));
    assert.ok(designTools.some((tool) => tool.name === "answer_paper_wiki_question"));
    assert.ok(designTools.some((tool) => tool.name === "search_paper_wiki"));
    assert.ok(designTools.some((tool) => tool.name === "write_design_artifact"));
    assert.ok(designTools.some((tool) => tool.name === "sync_design_environment"));
    assert.ok(designTools.some((tool) => tool.name === "run_design_script"));
    assert.ok(!designTools.some((tool) => tool.name === "download_paper"));
    assert.ok(!designTools.some((tool) => tool.name === "web_search"));
    assert.ok(!designTools.some((tool) => tool.name === "build_wiki_page"));
    assert.ok(!designTools.some((tool) => tool.name === "write_paper_wiki_source"));

    const legacyDesignTools = createToolsForBoundary(workspace, "design-subagent");
    assert.deepEqual(legacyDesignTools.map((tool) => tool.name), designTools.map((tool) => tool.name));
```

- [ ] **Step 2: Run prompt and boundary tests and verify they fail**

Run:

```bash
npm test -- test/agent/pi-agent.test.ts test/agent/tools.test.ts
```

Expected: FAIL because `DESIGN_AGENT_SYSTEM_PROMPT` and the `design-agent` boundary do not exist yet.

- [ ] **Step 3: Rename and export the prompt**

In `src/agent/agent-prompts.ts`, rename `DESIGN_SUBAGENT_SYSTEM_PROMPT` to `DESIGN_AGENT_SYSTEM_PROMPT` and use this content:

```ts
export const DESIGN_AGENT_SYSTEM_PROMPT = [
  "You are the design-agent for this project. You operate in a clean context with a restricted chip-design engineering, layout-code, dependency-management, and verification tool surface.",
  "Use local wiki and paper evidence before writing design artifacts. Keep design outputs as structured design records, verification reports, failure records, benchmark cases, or generated layout artifacts.",
  "All self-developed layout code belongs under design-repo/design-code/. Treat it as a separate design-code Git repository that is part of the knowledge base, not as ordinary parent-repo TypeScript source.",
  "Do not create or use design-projects/ for new work. That path is deprecated; migrate useful legacy design code into design-repo/design-code/ when implementation work requires it.",
  "Manage Python dependencies through design-repo/design-code/pyproject.toml and uv.lock. The only managed Python runtime environment is the parent repository root .venv.",
  "When Python dependencies may be missing, first update or confirm dependency declarations, then call sync_design_environment before running layout or verification scripts. Do not install packages ad hoc with pip or use uv as a general shell.",
  "Run workspace-local layout or verification scripts with run_design_script when the user asks for concrete design artifacts such as GDS files. Use the klayout runner for KLayout Python scripts and report generated output paths or the exact execution failure.",
  "Write design artifacts with write_design_artifact. Do not edit parent-repo source files, write wiki pages, download papers, run external web search, or use run_design_script as a general shell.",
  "When evidence is insufficient for a design conclusion, write a bounded uncertainty or failure record instead of inventing a design result."
].join(" ");
```

Also export a compatibility alias:

```ts
export const DESIGN_SUBAGENT_SYSTEM_PROMPT = DESIGN_AGENT_SYSTEM_PROMPT;
```

- [ ] **Step 4: Add design-agent boundary and alias normalization**

In `src/agent/tool-types.ts`, change the role union:

```ts
export type ToolBoundaryRole =
  | "wiki-agent"
  | "paper-download-subagent"
  | "wiki-evidence-worker"
  | "design-agent"
  | "design-subagent"
  | "paper-writing-worker";
```

Add `design-agent` with the existing design tool names, and keep `design-subagent` as the same list:

```ts
const DESIGN_AGENT_TOOL_NAMES = [
  "answer_paper_wiki_question",
  "search_paper_wiki",
  "search_local_papers",
  "list_local_papers",
  "sync_design_environment",
  "run_design_script",
  "write_design_artifact"
] as const satisfies readonly ToolName[];
```

Use it inside `TOOL_BOUNDARY_NAMES`:

```ts
  "design-agent": DESIGN_AGENT_TOOL_NAMES,
  "design-subagent": DESIGN_AGENT_TOOL_NAMES,
```

In `src/agent/tools.ts`, `createToolsForBoundary()` can continue to read `TOOL_BOUNDARY_NAMES[role]`; the alias works through the map.

- [ ] **Step 5: Run prompt and boundary tests**

Run:

```bash
npm test -- test/agent/pi-agent.test.ts test/agent/tools.test.ts
```

Expected: PASS for prompt and boundary tests.

- [ ] **Step 6: Commit prompt and boundary change**

```bash
rtk git add src/agent/agent-prompts.ts src/agent/tool-types.ts src/agent/tools.ts test/agent/pi-agent.test.ts test/agent/tools.test.ts
rtk git commit -m "Rename design worker boundary to design agent"
```

## Task 3: Add Structured Design Dependency Tool

**Files:**
- Modify: `src/agent/file-tools.ts`
- Modify: `src/agent/tool-types.ts`
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Write failing dependency tool tests**

Add helper lookup near the existing design tool helpers in `test/agent/tools.test.ts`:

```ts
function getUpdateDesignDependencyTool(workspaceDir: string) {
  const tool = createTools(workspaceDir, { toolProfile: "full" }).find(
    (candidate) => candidate.name === "update_design_dependency",
  );
  assert.ok(tool);
  return tool;
}
```

Add this test near the `sync_design_environment` tests:

```ts
test("update_design_dependency adds a main dependency to design-code pyproject", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");

  try {
    await mkdir(designCodeDir, { recursive: true });
    await writeFile(
      path.join(designCodeDir, "pyproject.toml"),
      [
        "[project]",
        "name = \"pi-chip-design\"",
        "version = \"0.1.0\"",
        "requires-python = \">=3.11\"",
        "dependencies = [",
        "  \"gdstk>=8\"",
        "]",
        "",
        "[project.optional-dependencies]",
        "dev = [",
        "  \"pytest>=8\"",
        "]",
        "",
      ].join("\n"),
      "utf8",
    );

    const tool = getUpdateDesignDependencyTool(workspace);
    const result = await tool.execute(
      "call-update-design-dependency",
      {
        name: "klayout",
        specifier: ">=0.29",
        group: "main",
      },
      undefined,
    );

    assert.deepEqual(result.details, {
      status: "updated",
      path: "design-repo/design-code/pyproject.toml",
      group: "main",
      dependency: "klayout>=0.29",
      changed: true,
    });
    assert.match(await readFile(path.join(designCodeDir, "pyproject.toml"), "utf8"), /"klayout>=0\.29"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

Add a rejection test:

```ts
test("update_design_dependency rejects invalid dependency names", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");

  try {
    await mkdir(designCodeDir, { recursive: true });
    await writeFile(
      path.join(designCodeDir, "pyproject.toml"),
      "[project]\nname = \"pi-chip-design\"\nversion = \"0.1.0\"\ndependencies = []\n",
      "utf8",
    );

    const tool = getUpdateDesignDependencyTool(workspace);
    await assert.rejects(
      tool.execute(
        "call-update-design-dependency-invalid",
        {
          name: "../bad",
          group: "main",
        },
        undefined,
      ),
      /Invalid Python dependency name/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run dependency tests and verify they fail**

Run:

```bash
npm test -- test/agent/tools.test.ts
```

Expected: FAIL because `update_design_dependency` is not registered.

- [ ] **Step 3: Add tool schema and implementation helpers**

In `src/agent/file-tools.ts`, add the schema near `syncDesignEnvironmentParameters`:

```ts
const updateDesignDependencyParameters = Type.Object({
  name: Type.String({
    description: "Python package name to declare in design-repo/design-code/pyproject.toml."
  }),
  specifier: Type.Optional(
    Type.String({
      description: "PEP 440 version specifier such as >=8, ==8.20.0, or ~=8.0. Defaults to no version specifier."
    })
  ),
  group: Type.Optional(
    Type.Union([Type.Literal("main"), Type.Literal("dev")], {
      description: "Dependency group to update. main updates [project].dependencies; dev updates [project.optional-dependencies].dev. Defaults to main."
    })
  )
});
```

Add helper functions before `syncDesignEnvironment()`:

```ts
function normalizePythonDependency(input: { name: string; specifier?: string }): string {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error("Invalid Python dependency name.");
  }
  const specifier = input.specifier?.trim() ?? "";
  if (specifier && !/^(===|==|~=|!=|<=|>=|<|>|=).+/.test(specifier)) {
    throw new Error("Invalid Python dependency specifier.");
  }
  return `${name}${specifier}`;
}

function dependencyPackageName(dependency: string): string {
  return dependency.split(/[<>=!~;\[]/, 1)[0]?.trim().toLowerCase() ?? "";
}

function formatDependencyArray(dependencies: string[]): string[] {
  if (dependencies.length === 0) {
    return ["[]"];
  }
  return [
    "[",
    ...dependencies.map((dependency) => `  "${dependency}",`),
    "]"
  ];
}

function replaceTomlArray(input: {
  content: string;
  key: string;
  newLines: string[];
  sectionStart: number;
  sectionEnd: number;
}): string {
  const lines = input.content.split("\n");
  const keyPattern = new RegExp(`^${input.key}\\s*=`);
  const keyIndex = lines.findIndex((line, index) =>
    index >= input.sectionStart && index < input.sectionEnd && keyPattern.test(line.trim())
  );
  const replacement = [`${input.key} = ${input.newLines[0]}`, ...input.newLines.slice(1)];
  if (keyIndex === -1) {
    lines.splice(input.sectionEnd, 0, ...replacement);
    return lines.join("\n");
  }
  let endIndex = keyIndex + 1;
  if (lines[keyIndex]?.includes("[") && !lines[keyIndex]?.includes("]")) {
    while (endIndex < lines.length && !lines[endIndex]?.trim().startsWith("]")) {
      endIndex += 1;
    }
    endIndex += 1;
  }
  lines.splice(keyIndex, endIndex - keyIndex, ...replacement);
  return lines.join("\n");
}
```

Add `updateDesignDependency()`:

```ts
async function updateDesignDependency(input: {
  workspaceDir: string;
  name: string;
  specifier?: string;
  group?: "main" | "dev";
}): Promise<{
  status: "updated";
  path: string;
  group: "main" | "dev";
  dependency: string;
  changed: boolean;
}> {
  const projectDir = await resolveDesignCodeProjectPath(input.workspaceDir, "design-repo/design-code");
  const pyprojectPath = path.join(projectDir, "pyproject.toml");
  const dependency = normalizePythonDependency({ name: input.name, specifier: input.specifier });
  const group = input.group ?? "main";
  const content = await readFile(pyprojectPath, "utf8");
  const lines = content.split("\n");
  const sectionName = group === "main" ? "project" : "project.optional-dependencies";
  const key = group === "main" ? "dependencies" : "dev";
  const sectionHeader = `[${sectionName}]`;
  const sectionStart = lines.findIndex((line) => line.trim() === sectionHeader);
  if (sectionStart === -1) {
    throw new Error(`design-repo/design-code/pyproject.toml is missing ${sectionHeader}.`);
  }
  const nextSection = lines.findIndex((line, index) => index > sectionStart && /^\[[^\]]+\]\s*$/.test(line.trim()));
  const sectionEnd = nextSection === -1 ? lines.length : nextSection;
  const existingDependencies = lines
    .slice(sectionStart + 1, sectionEnd)
    .map((line) => line.trim().match(/^"([^"]+)",?$/)?.[1])
    .filter((value): value is string => Boolean(value));
  const packageName = dependencyPackageName(dependency);
  const withoutExisting = existingDependencies.filter(
    (existing) => dependencyPackageName(existing) !== packageName
  );
  const updatedDependencies = [...withoutExisting, dependency].sort((a, b) => a.localeCompare(b));
  const changed = updatedDependencies.join("\n") !== existingDependencies.join("\n");
  if (changed) {
    const updatedContent = replaceTomlArray({
      content,
      key,
      newLines: formatDependencyArray(updatedDependencies),
      sectionStart: sectionStart + 1,
      sectionEnd
    });
    await writeFile(pyprojectPath, updatedContent, "utf8");
  }
  return {
    status: "updated",
    path: "design-repo/design-code/pyproject.toml",
    group,
    dependency,
    changed
  };
}
```

- [ ] **Step 4: Register the dependency tool**

In `src/agent/file-tools.ts`, add the type:

```ts
type UpdateDesignDependencyTool = AgentTool<
  typeof updateDesignDependencyParameters,
  {
    status: "updated";
    path: string;
    group: "main" | "dev";
    dependency: string;
    changed: boolean;
  }
>;
```

Create the tool inside `createFileTools()`:

```ts
  const updateDesignDependencyTool: UpdateDesignDependencyTool = {
    name: "update_design_dependency",
    label: "Update Design Dependency",
    description:
      "Adds or updates a Python dependency declaration in design-repo/design-code/pyproject.toml. This does not run pip or arbitrary uv commands; call sync_design_environment afterwards.",
    parameters: updateDesignDependencyParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: Static<typeof updateDesignDependencyParameters>) => {
      const result = await updateDesignDependency({
        workspaceDir: resolvedWorkspaceDir,
        name: args.name,
        specifier: args.specifier,
        group: args.group
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };
```

Add it to `artifactFullTools` before `syncDesignEnvironmentTool`.

In `src/agent/tool-types.ts`, add `"update_design_dependency"` to `ToolName` and to `DESIGN_AGENT_TOOL_NAMES`.

In `test/agent/tools.test.ts`, add `"update_design_dependency"` to `EXPECTED_FULL_ONLY_TOOL_NAMES`.

- [ ] **Step 5: Run dependency and boundary tests**

Run:

```bash
npm test -- test/agent/tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit dependency tool**

```bash
rtk git add src/agent/file-tools.ts src/agent/tool-types.ts test/agent/tools.test.ts
rtk git commit -m "Add design dependency declaration tool"
```

## Task 4: Add Scoped Design-Code File Tools

**Files:**
- Modify: `src/agent/file-tools.ts`
- Modify: `src/agent/tool-types.ts`
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Write failing scoped file-tool tests**

Add helpers in `test/agent/tools.test.ts`:

```ts
function getWriteDesignCodeFileTool(workspaceDir: string) {
  const tool = createTools(workspaceDir, { toolProfile: "full" }).find(
    (candidate) => candidate.name === "write_design_code_file",
  );
  assert.ok(tool);
  return tool;
}

function getReplaceDesignCodeFileTextTool(workspaceDir: string) {
  const tool = createTools(workspaceDir, { toolProfile: "full" }).find(
    (candidate) => candidate.name === "replace_design_code_file_text",
  );
  assert.ok(tool);
  return tool;
}
```

Add tests:

```ts
test("write_design_code_file writes only under knowledge-base design-code", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");

  try {
    await mkdir(designCodeDir, { recursive: true });
    await writeFile(path.join(designCodeDir, "pyproject.toml"), "[project]\nname = \"pi-chip-design\"\nversion = \"0.1.0\"\ndependencies = []\n", "utf8");

    const tool = getWriteDesignCodeFileTool(workspace);
    const result = await tool.execute(
      "call-write-design-code",
      {
        path: "src/pi_chip_design/layouts/demo.py",
        content: "def build():\n    return 'layout'\n",
      },
      undefined,
    );

    assert.deepEqual(result.details, {
      path: "design-repo/design-code/src/pi_chip_design/layouts/demo.py",
      bytes: Buffer.byteLength("def build():\n    return 'layout'\n", "utf8"),
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("write_design_code_file rejects parent repo paths", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const designCodeDir = path.join(workspace, "knowledge-base", "design-code");

  try {
    await mkdir(designCodeDir, { recursive: true });
    await writeFile(path.join(designCodeDir, "pyproject.toml"), "[project]\nname = \"pi-chip-design\"\nversion = \"0.1.0\"\ndependencies = []\n", "utf8");

    const tool = getWriteDesignCodeFileTool(workspace);
    await assert.rejects(
      tool.execute(
        "call-write-design-code-outside",
        {
          path: "../../src/agent/agent-prompts.ts",
          content: "bad\n",
        },
        undefined,
      ),
      /design-code file tools only write under knowledge-base\/design-code/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run scoped file-tool tests and verify they fail**

Run:

```bash
npm test -- test/agent/tools.test.ts
```

Expected: FAIL because the scoped design-code file tools are not registered.

- [ ] **Step 3: Add scoped path resolver and tool schemas**

In `src/agent/file-tools.ts`, add schemas near `writeFileParameters`:

```ts
const writeDesignCodeFileParameters = Type.Object({
  path: Type.String({
    description: "Path inside design-repo/design-code. Both design-code-relative paths and design-repo/design-code/... paths are accepted."
  }),
  content: Type.String({ description: "Full UTF-8 file content to write." })
});

const replaceDesignCodeFileTextParameters = Type.Object({
  path: Type.String({
    description: "Path inside design-repo/design-code. Both design-code-relative paths and design-repo/design-code/... paths are accepted."
  }),
  search: Type.String({ description: "Exact existing text block to replace." }),
  replacement: Type.String({ description: "Replacement text." }),
  replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence. Defaults to false." }))
});
```

Add resolver:

```ts
async function resolveDesignCodeWritableFilePath(workspaceDir: string, requestedPath: string): Promise<string> {
  const projectDir = await resolveDesignCodeProjectPath(workspaceDir, "design-repo/design-code");
  const relativeRequest = requestedPath.startsWith("design-repo/design-code/")
    ? requestedPath.slice("design-repo/design-code/".length)
    : requestedPath;
  if (!relativeRequest.trim() || path.isAbsolute(relativeRequest)) {
    throw new Error("design-code file tools only write under design-repo/design-code.");
  }
  const resolvedPath = path.resolve(projectDir, relativeRequest);
  assertPathInsideDirectory(projectDir, resolvedPath);
  const parentDir = path.dirname(resolvedPath);
  await mkdir(parentDir, { recursive: true });
  const [realProjectDir, realParentDir] = await Promise.all([
    realpath(projectDir),
    realpath(parentDir)
  ]);
  assertPathInsideDirectory(realProjectDir, realParentDir);
  if (await pathExists(resolvedPath)) {
    const realResolvedPath = await realpath(resolvedPath);
    assertPathInsideDirectory(realProjectDir, realResolvedPath);
  }
  return resolvedPath;
}
```

- [ ] **Step 4: Register scoped write and replace tools**

Add tool types:

```ts
type WriteDesignCodeFileTool = AgentTool<typeof writeDesignCodeFileParameters, { path: string; bytes: number }>;
type ReplaceDesignCodeFileTextTool = AgentTool<
  typeof replaceDesignCodeFileTextParameters,
  { path: string; replacements: number; bytes: number }
>;
```

Add tool definitions inside `createFileTools()`:

```ts
  const writeDesignCodeFileTool: WriteDesignCodeFileTool = {
    name: "write_design_code_file",
    label: "Write Design Code File",
    description:
      "Creates or overwrites a UTF-8 file only inside design-repo/design-code. This is for the design-agent's self-developed layout code repository.",
    parameters: writeDesignCodeFileParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: Static<typeof writeDesignCodeFileParameters>) => {
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
      "Replaces an exact UTF-8 text block only inside design-repo/design-code. Use this instead of generic replace_file_text for design-agent code edits.",
    parameters: replaceDesignCodeFileTextParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: Static<typeof replaceDesignCodeFileTextParameters>) => {
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
      return {
        content: [{ type: "text", text: `Replaced text in ${relativeWorkspacePath(resolvedWorkspaceDir, resolvedPath)}.` }],
        details: {
          path: relativeWorkspacePath(resolvedWorkspaceDir, resolvedPath),
          replacements: args.replaceAll ? occurrences : 1,
          bytes: Buffer.byteLength(updated, "utf8")
        }
      };
    }
  };
```

Add both tools to `artifactFullTools` before `updateDesignDependencyTool`.

Add `"write_design_code_file"` and `"replace_design_code_file_text"` to `ToolName`, `DESIGN_AGENT_TOOL_NAMES`, and `EXPECTED_FULL_ONLY_TOOL_NAMES`.

- [ ] **Step 5: Run scoped file-tool tests**

Run:

```bash
npm test -- test/agent/tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit scoped file tools**

```bash
rtk git add src/agent/file-tools.ts src/agent/tool-types.ts test/agent/tools.test.ts
rtk git commit -m "Add scoped design code file tools"
```

## Task 5: Add Design Import Verification Tool

**Files:**
- Modify: `src/agent/file-tools.ts`
- Modify: `src/agent/tool-types.ts`
- Modify: `test/agent/tools.test.ts`

- [ ] **Step 1: Write failing import verification test**

Add helper in `test/agent/tools.test.ts`:

```ts
function getVerifyDesignPythonImportTool(workspaceDir: string) {
  const tool = createTools(workspaceDir, { toolProfile: "full" }).find(
    (candidate) => candidate.name === "verify_design_python_import",
  );
  assert.ok(tool);
  return tool;
}
```

Add test:

```ts
test("verify_design_python_import uses root venv python", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-agent-tools-"));
  const venvBinDir = path.join(workspace, ".venv", "bin");

  try {
    await mkdir(venvBinDir, { recursive: true });
    const fakePython = path.join(venvBinDir, "python");
    await writeFile(
      fakePython,
      [
        "#!/bin/sh",
        "echo import-ok:$1:$2",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePython, 0o755);

    const tool = getVerifyDesignPythonImportTool(workspace);
    const result = await tool.execute(
      "call-verify-import",
      {
        moduleName: "gdstk",
      },
      undefined,
    );

    assert.equal((result.details as { status: string }).status, "importable");
    assert.equal((result.details as { pythonPath: string }).pythonPath, ".venv/bin/python");
    assert.match((result.details as { stdout: string }).stdout, /import-ok:-c/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run import verification test and verify it fails**

Run:

```bash
npm test -- test/agent/tools.test.ts
```

Expected: FAIL because `verify_design_python_import` is not registered.

- [ ] **Step 3: Add import verification schema and implementation**

In `src/agent/file-tools.ts`, add:

```ts
const verifyDesignPythonImportParameters = Type.Object({
  moduleName: Type.String({
    description: "Python module name to import with the repository root .venv Python, such as gdstk."
  }),
  maxOutputChars: Type.Optional(Type.Integer({ description: "Maximum combined stdout/stderr characters to return. Defaults to 12000.", minimum: 1000 }))
});
```

Add implementation:

```ts
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
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(input.moduleName.trim())) {
    throw new Error("Invalid Python module name.");
  }
  const pythonPath = await findRootVenvPython(input.workspaceDir);
  if (!pythonPath) {
    throw new Error("Root .venv Python was not found. Run sync_design_environment first.");
  }
  const args = ["-c", `import ${input.moduleName}; print("import-ok:${input.moduleName}")`];
  const { stdout, stderr } = await execFileAsync(pythonPath, args, {
    cwd: input.workspaceDir,
    timeout: 120000,
    maxBuffer: Math.max(input.maxOutputChars * 2, 1024 * 1024)
  }) as { stdout: string | Buffer; stderr: string | Buffer };
  return {
    status: "importable",
    moduleName: input.moduleName,
    pythonPath: normalizeWorkspaceRelativePath(input.workspaceDir, pythonPath),
    command: `${normalizeWorkspaceRelativePath(input.workspaceDir, pythonPath)} -c import ${input.moduleName}`,
    stdout: compactOutputText(String(stdout), input.maxOutputChars),
    stderr: compactOutputText(String(stderr), input.maxOutputChars)
  };
}
```

- [ ] **Step 4: Register import verification tool**

Add type:

```ts
type VerifyDesignPythonImportTool = AgentTool<
  typeof verifyDesignPythonImportParameters,
  {
    status: "importable";
    moduleName: string;
    pythonPath: string;
    command: string;
    stdout: string;
    stderr: string;
  }
>;
```

Add tool:

```ts
  const verifyDesignPythonImportTool: VerifyDesignPythonImportTool = {
    name: "verify_design_python_import",
    label: "Verify Design Python Import",
    description:
      "Verifies that a Python module imports with the repository root .venv Python. Use after sync_design_environment for package-install requests.",
    parameters: verifyDesignPythonImportParameters,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args: Static<typeof verifyDesignPythonImportParameters>) => {
      const result = await verifyDesignPythonImport({
        workspaceDir: resolvedWorkspaceDir,
        moduleName: args.moduleName,
        maxOutputChars: normalizeDesignToolOutputChars(args.maxOutputChars)
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result
      };
    }
  };
```

Add it to `artifactFullTools`, `ToolName`, `DESIGN_AGENT_TOOL_NAMES`, and `EXPECTED_FULL_ONLY_TOOL_NAMES`.

- [ ] **Step 5: Run import verification tests**

Run:

```bash
npm test -- test/agent/tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit import verification tool**

```bash
rtk git add src/agent/file-tools.ts src/agent/tool-types.ts test/agent/tools.test.ts
rtk git commit -m "Add design Python import verification tool"
```

## Task 6: Update Handoff And Documentation

**Files:**
- Modify: `src/agent/agent-routing.ts`
- Modify: `src/agent/agent-runtime.ts`
- Modify: `README.md`
- Modify: `docs/feishu-bridge.env.example`
- Modify: `test/agent/pi-agent.test.ts`

- [ ] **Step 1: Add handoff regression test**

In `test/agent/pi-agent.test.ts`, add a routed-worker test that confirms `design-agent` appears in handoff metadata:

```ts
test("runSessionPrompt routes design package requests to design-agent boundary", async () => {
  const registration = registerFauxProvider();
  registration.setResponses([
    fauxAssistantMessage([fauxText("Design dependency checked.")])
  ]);

  const context: Context = {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    messages: [],
    tools: []
  };

  const result = await piAgent.runSessionPrompt({
    model: registration.getModel(),
    workspaceDir: process.cwd(),
    context,
    prompt: "please ask design subagent to install the gdstk Python package"
  });

  const handoff = result.newMessages
    .filter(isAssistantMessage)
    .map((message) => {
      try {
        return parseWorkerHandoff(message) as { role?: string; instruction?: string };
      } catch {
        return undefined;
      }
    })
    .find((candidate) => candidate?.role === "design-agent");

  assert.ok(handoff);
  assert.equal(handoff.instruction, "please ask design subagent to install the gdstk Python package");
});
```

- [ ] **Step 2: Run handoff test**

Run:

```bash
npm test -- test/agent/pi-agent.test.ts
```

Expected: PASS after Task 1 routing normalization. If it fails with `design-subagent`, continue to Step 3.

- [ ] **Step 3: Ensure worker handoff reports normalized role**

In `src/agent/agent-routing.ts`, confirm this normalizer exists from Task 1:

```ts
export function normalizeWorkerRole(role: RoutedWorkerRole): Exclude<RoutedWorkerRole, "design-subagent"> {
  return role === "design-subagent" ? "design-agent" : role;
}
```

In `src/agent/agent-runtime.ts`, add `normalizeWorkerRole` to the import from `./agent-routing.js`:

```ts
import {
  createWorkerHandoffMessage,
  extractWorkerHandoffPaths,
  nextOwnerForWorker,
  normalizeWorkerRole,
  routeChatPromptToWorker,
  systemPromptForWorker,
  type RoutedWorkerPrompt,
  type RoutedWorkerRole,
  type WorkerHandoff
} from "./agent-routing.js";
```

Inside `runRoutedWorkerPrompt()`, define `normalizedRole` before the handoff is returned:

```ts
    const normalizedRole = normalizeWorkerRole(options.role);
    return {
      messages: attemptResult.messages,
      handoff: {
        role: normalizedRole,
        instruction: options.instruction,
        routeReason: options.routeReason,
        status: isFailedTurn(attemptResult.messages) ? "failed" : "completed",
        changedFiles: [...changedFiles].sort(),
        artifacts: [...artifacts].sort(),
        sourcePaths: [...sourcePaths].sort(),
        pagePaths: [...pagePaths].sort(),
        designRecords: [...designRecords].sort(),
        toolsUsed: [...new Set(toolsUsed)],
        failedTools: [...new Set(failedTools)],
        finalResponse,
        nextSuggestedOwner: nextOwnerForWorker(normalizedRole)
      }
    };
```

- [ ] **Step 4: Update README docs**

In `README.md`, replace user-facing `design-subagent` wording in the router and tool-boundary sections with `design-agent`, and add this paragraph near the design tools section:

```md
The design-agent is the engineering owner for executable layout code. It manages `design-repo/design-code/` as a nested design-code Git repository, updates design-code dependency declarations, syncs them into the parent root `.venv` with `uv`, runs bounded layout and verification scripts, and returns generated artifacts and design records to the wiki agent. `design-subagent` remains a compatibility alias for older prompts.
```

Keep references to `design-subagent` only where describing compatibility aliases.

- [ ] **Step 5: Update bridge env docs**

In `docs/feishu-bridge.env.example`, update the comment above `BRIDGE_DESIGN_WORKSPACE_DIR`:

```env
# Optional managed design workspace for design-agent code and verification artifacts.
# design-subagent is accepted as a compatibility alias, but design-agent owns this workspace.
BRIDGE_DESIGN_WORKSPACE_DIR=design-repo/design-code
```

- [ ] **Step 6: Run docs and handoff tests**

Run:

```bash
npm test -- test/agent/pi-agent.test.ts
git diff --check
```

Expected: PASS and no whitespace errors.

- [ ] **Step 7: Commit docs and handoff change**

```bash
rtk git add src/agent/agent-routing.ts src/agent/agent-runtime.ts README.md docs/feishu-bridge.env.example test/agent/pi-agent.test.ts
rtk git commit -m "Document design agent handoff boundary"
```

## Task 7: Final Verification And Integration

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- test/agent/pi-agent.test.ts test/agent/tools.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS. Use plain `npm test` for full validation.

- [ ] **Step 3: Verify design-code package still works in root venv**

Run:

```bash
.venv/bin/python -m pytest design-repo/design-code/tests
```

Expected: PASS.

Run:

```bash
.venv/bin/python -m ruff check design-repo/design-code/src design-repo/design-code/tests
```

Expected: `All checks passed!`

- [ ] **Step 4: Check diffs and status**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: no whitespace errors and a clean worktree after commits.

- [ ] **Step 5: Request code review**

Use `superpowers:requesting-code-review` before merging or pushing. Ask the reviewer to focus on:

- whether `design-agent` can still escape its filesystem boundary
- whether dependency updates are sufficiently structured and do not behave like arbitrary shell access
- whether legacy `design-subagent` prompts remain compatible
- whether wiki-agent remains the owner of final wiki page writes

- [ ] **Step 6: Address review feedback**

Use `superpowers:receiving-code-review` for any reviewer findings. Fix only confirmed issues and rerun the targeted tests that cover each fix.

- [ ] **Step 7: Push only after user approval**

If the user asks to push, run:

```bash
rtk git push origin main
```

Expected: `main` updates on `origin`.
