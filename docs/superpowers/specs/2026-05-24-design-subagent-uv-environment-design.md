# Design Subagent UV Environment Design

## Purpose

The design-subagent needs to generate superconducting-chip layout artifacts with a reusable Python codebase and dependencies such as `gdsfactory`. It should be able to prepare its own Python environment through `uv`, but it must not receive a general shell or install packages ad hoc with `pip`.

This design separates three concerns:

- Design code lives under the project wiki/knowledge base.
- Python dependency state is declared and locked by the design code repository.
- The actual virtual environment is shared at the `pi-agent-minimal-ts` root.

## Target Layout

```text
/home/ququan2/pi-agent-minimal-ts/
  .venv/                         # one shared Python environment, uv-managed, not committed
  knowledge-base/
    design-code/                 # design-subagent Python codebase, separate Git repository
      .git/
      pyproject.toml
      uv.lock
      README.md
      src/pi_chip_design/
      scripts/
      tests/
      outputs/                   # generated artifacts, ignored by the design-code repo
```

`/home/ququan2/pi-agent-minimal-ts/design-projects/` is not part of the target architecture and should be removed or migrated during implementation. Per-project virtual environments such as `design-projects/superconducting-qubit-chip/.venv/` should not exist.

## Repository Boundary

`knowledge-base/design-code/` is a separate Git repository from `pi-agent-minimal-ts`.

The parent repository should treat this directory as knowledge-base content with its own lifecycle, not as ordinary TypeScript source. The design-code repository owns:

- `pyproject.toml`
- `uv.lock`
- reusable layout-generation modules
- verification scripts
- small test fixtures
- its own `.gitignore`

The parent repository owns only the agent tools and prompts that know how to operate this design-code repository.

## Dependency Management

`gdsfactory` is a normal dependency of the design-code Python package, declared in `knowledge-base/design-code/pyproject.toml`. Future Python dependencies should be added to the same dependency declaration instead of being installed imperatively.

The design-subagent dependency workflow is:

1. Update `pyproject.toml` when the design code needs a new dependency.
2. Run the bounded environment-sync tool.
3. Use the synchronized root `.venv` to run layout or verification scripts.

`uv.lock` should be committed to the design-code repository so layout generation is reproducible.

## Environment Sync Tool

Add a restricted tool such as `sync_design_environment` to the design-subagent boundary.

The tool should:

- Run only for `knowledge-base/design-code/`.
- Execute `uv sync` with the design-code project as the uv project.
- Force `UV_PROJECT_ENVIRONMENT=/home/ququan2/pi-agent-minimal-ts/.venv`.
- Return the command, exit status, truncated stdout/stderr, and the resolved Python path.
- Fail clearly when `uv` is missing, `pyproject.toml` is missing, or the requested project path is outside `knowledge-base/design-code/`.

The tool must not expose a generic shell. It must not accept arbitrary commands. It should not run `uv add`; dependency edits remain normal file edits to `pyproject.toml`, followed by `uv sync`.

## Script Execution

`run_design_script` should keep its current narrow surface: workspace-local `.py` scripts only, explicit runner choice, bounded output, and expected-output verification.

For Python scripts, the interpreter resolution should change to:

1. Prefer `/home/ququan2/pi-agent-minimal-ts/.venv/bin/python` or the Windows equivalent.
2. Fall back to `python3` only if the root `.venv` does not exist.
3. Do not search for nested `.venv` directories under `knowledge-base/design-code/` or old design project directories.

This keeps all design projects on the same dependency environment while still allowing the design-code repository to own the source package and lockfile.

## Prompt Boundary

Update `DESIGN_SUBAGENT_SYSTEM_PROMPT` so the worker understands:

- All self-developed layout code belongs under `knowledge-base/design-code/`.
- `design-projects/` is deprecated and should not be used for new work.
- Python dependencies are managed with `uv` through `pyproject.toml` and `uv.lock`.
- The only managed Python environment is the parent repository root `.venv`.
- For concrete GDS work, sync the environment first when dependencies may be missing, then run scripts with `run_design_script`.
- Record durable lessons and verification results with `write_design_artifact`.

## Cleanup and Migration

Implementation should migrate any still-useful code from `design-projects/superconducting-qubit-chip/` into `knowledge-base/design-code/`, then remove `design-projects/`.

Generated caches and environments should remain ignored:

- `.venv/`
- `.ruff_cache/`
- `.pytest_cache/`
- `__pycache__/`
- generated `.gds` outputs unless intentionally added as small fixtures

## Testing

Add focused tests for:

- `sync_design_environment` rejects paths outside `knowledge-base/design-code/`.
- `sync_design_environment` invokes `uv sync` with `UV_PROJECT_ENVIRONMENT` pointing to the parent root `.venv`.
- `run_design_script` uses the parent root `.venv` and ignores nested project `.venv` directories.
- `createToolsForBoundary(..., "design-subagent")` exposes the sync tool in the expected order.
- The design-subagent prompt mentions `knowledge-base/design-code`, root `.venv`, `uv`, and the deprecated `design-projects/` path.

Full validation should include the relevant targeted tests first, then the repository's normal full `npm test` before release.
