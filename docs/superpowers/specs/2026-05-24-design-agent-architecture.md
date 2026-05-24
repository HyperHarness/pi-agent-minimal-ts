# Design Agent Architecture

## Purpose

Promote the current `design-subagent` from a wiki-agent worker into a first-class `design-agent` that owns chip-layout engineering work. The wiki agent remains the durable knowledge coordinator. The design agent becomes the execution owner for layout code, Python dependency management, generated GDS artifacts, and design verification records.

This keeps the knowledge flywheel intact without forcing engineering execution to look like wiki maintenance.

## Current Problem

The current `design-subagent` is routed through the wiki-agent runtime as a clean worker. That is useful for bounded design records, but it creates an awkward boundary for EDA-style work:

- Package-management requests can miss the design worker router and fall back to the main wiki agent.
- The design worker can sync an existing environment, but it cannot own dependency declaration updates.
- Layout-code editing, test creation, artifact generation, and verification are engineering workflows, not wiki synthesis workflows.
- The wiki agent should consume stable design outputs; it should not be responsible for deciding how layout code is structured or how Python packages are managed.

## Target Model

Introduce `design-agent` as a separate runtime role with its own prompt, router entry points, tool surface, and handoff contract. It should still operate inside the same repository and knowledge base.

The intended separation is:

- `design-agent`: executes and verifies chip-layout work.
- `wiki-agent`: curates durable knowledge from papers, source summaries, design records, and generated artifacts.
- `paper-download-subagent`: acquires papers.
- `wiki-evidence-worker`: constructs paper evidence summaries.
- `paper-writing-worker`: edits manuscripts.

The design agent may retrieve local wiki and paper evidence, but it should not directly download papers or write final wiki pages.

## Repository And Environment Contract

The design agent owns the self-developed design-code repository at:

```text
knowledge-base/design-code/
```

This directory is a separate Git repository inside the knowledge base. It is not normal parent-repo TypeScript source. The parent repo may document and invoke it, but design-code commits belong to the nested repository.

The design agent may create and update files under:

```text
knowledge-base/design-code/
knowledge-base/design-records/
knowledge-base/design-artifacts/
```

It must not create or use:

```text
design-projects/
knowledge-base/design-projects/
```

The only managed Python runtime environment is the parent repository root:

```text
.venv/
```

The design agent must use `uv` to synchronize dependencies into that shared environment by forcing `UV_PROJECT_ENVIRONMENT=<parent-repo>/.venv`.

## Tool Boundary

The design agent should have a wider but still bounded engineering tool surface than the current `design-subagent`.

Allowed tools:

- local wiki retrieval: answer/search wiki evidence for design decisions
- local paper retrieval: search/list/read already-acquired papers
- design dependency declaration: add/update/remove dependencies in `knowledge-base/design-code/pyproject.toml`
- design environment sync: run fixed `uv sync` for `knowledge-base/design-code/` into root `.venv`
- design code editing: write/replace files only inside `knowledge-base/design-code/`
- design script execution: run workspace-local Python or KLayout scripts with bounded output and expected artifact checks
- design tests/lints: run project-local test and lint commands through fixed `uv`/root-venv entry points
- design artifact writing: write generated outputs and structured records under `knowledge-base/design-artifacts/` and `knowledge-base/design-records/`
- nested design-code Git status/diff/commit helpers, if later exposed through the repo-manager boundary

Forbidden tools:

- arbitrary shell
- arbitrary `pip install`
- arbitrary `uv` commands
- parent-repo source editing
- paper download or external web search
- final wiki page writes
- writing outside the design-code, design-records, and design-artifacts roots

## Dependency Management

The design agent should not install Python packages by direct shell commands. Package changes should be a two-step controlled workflow:

1. Update dependency declarations in `knowledge-base/design-code/pyproject.toml`.
2. Run the existing fixed environment sync:

```text
UV_PROJECT_ENVIRONMENT=<parent-repo>/.venv uv sync --project <parent-repo>/knowledge-base/design-code --extra dev
```

For user requests such as "install gdsfactory", the design agent should interpret the request as:

- ensure `gdsfactory` is declared in `pyproject.toml`
- update `uv.lock` through `uv sync`
- verify importability from the root `.venv`
- report the exact dependency state and Python path

If the package is already declared, the agent should sync and verify rather than duplicate the declaration.

## Routing

Add first-class routes for design-agent requests. These should include both explicit and natural-language forms:

- `/design-agent ...`
- `design-agent ...`
- `design subagent ...` for backward compatibility
- `design ...`
- `芯片设计 ...`
- `设计任务 ...`
- requests mentioning GDS, gdsfactory, KLayout, layout scripts, chip layout, design-code, Python package dependencies, or design environment sync

The old `design-subagent` name should remain as a compatibility alias during migration, but user-visible docs should move toward `design-agent`.

## Handoff To Wiki Agent

The design agent should return a structured handoff after each routed turn:

- design-code files changed
- generated artifacts
- design records written
- dependency changes
- environment sync status
- scripts/tests/lints run
- failures and root causes
- suggested wiki follow-up, if a result should become durable knowledge

The wiki agent should treat this handoff as input evidence. It may later build or update wiki pages, but that is a separate step.

## Error Handling

The design agent should fail closed:

- If `knowledge-base/design-code/` is missing or is a symlink, stop and report the boundary violation.
- If `pyproject.toml` is missing, stop unless the user explicitly asked to initialize the design-code package.
- If `uv sync` fails, report the command, normalized project path, stderr summary, and whether root `.venv` changed.
- If an import check fails after sync, report the root `.venv` Python path and exact import error.
- If a script does not produce expected outputs, report the missing output paths and keep generated partial artifacts visible.
- If local evidence is insufficient for a design conclusion, write a bounded uncertainty or failure record instead of inventing a result.

## Migration Plan

1. Rename the conceptual role in docs and prompts from `design-subagent` to `design-agent`, while keeping `design-subagent` as a compatibility alias.
2. Add router coverage for design-agent package-management and GDS/layout requests.
3. Split the design prompt from wiki-worker wording into an engineering-agent prompt.
4. Add bounded design-code file editing tools.
5. Add structured dependency declaration tools for `pyproject.toml`.
6. Keep `sync_design_environment` as the only package installation execution path.
7. Extend tests for routing, dependency update, environment sync, root `.venv` use, and forbidden path rejection.
8. Update README and bridge env docs to describe `design-agent` as an independent execution owner.

## Non-Goals

- Do not introduce an arbitrary terminal shell for the design agent.
- Do not let design-agent manage unrelated Python projects.
- Do not merge the nested `knowledge-base/design-code` Git repository into the parent repo.
- Do not let the design agent download papers or browse the web directly in the first version.
- Do not make the wiki agent responsible for layout-code structure, package versions, or generated GDS validation.

## Success Criteria

The migration is successful when:

- A request like "让 design agent 安装 gdsfactory" routes to the design agent.
- The agent updates or confirms `knowledge-base/design-code/pyproject.toml`.
- The agent runs `uv sync` into the parent root `.venv`.
- The agent verifies `import gdsfactory` with root `.venv/bin/python`.
- The agent can write and run a layout script under `knowledge-base/design-code/`.
- Generated GDS files and verification records are written under knowledge-base design artifact paths.
- The wiki agent receives a compact handoff instead of owning the engineering workflow.
