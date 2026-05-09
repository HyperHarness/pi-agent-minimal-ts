# Design Projects

This directory is the recommended home for code repositories that the design subagent will use for chip-design work. The default design workspace is a Python package so the project can maintain reusable layout-generation code instead of scattering one-off scripts across wiki pages or manuscript folders.

Keep this separate from `knowledge-base/design-records/`:

- `design-projects/` contains executable design code, reusable Python packages, scripts, simulation setup, generated-layout code, and project-local tests.
- `knowledge-base/design-records/` contains design records, verification reports, failure records, and benchmark cases written through `write_design_artifact`.
- `knowledge-base/` contains durable knowledge pages and evidence summaries that inform design work, but it should not own design code.

Recommended repo-manager configuration for the first design workspace:

```sh
BRIDGE_DESIGN_WORKSPACE_DIR=<repo-root>/design-projects/superconducting-qubit-chip
```

Project directories under this root are treated as independent design workspaces. The parent agent repository should track this README, but should ignore concrete project repositories such as `superconducting-qubit-chip/`. Point `BRIDGE_DESIGN_WORKSPACE_DIR` at the concrete project repository that repo manager should control.

## Python Package Convention

The first package workspace is:

```text
design-projects/superconducting-qubit-chip/
  pyproject.toml
  src/pi_chip_design/
    __init__.py
    layouts/
      __init__.py
  tests/
```

Use `pi_chip_design` for shared chip-design primitives, layout families, parameter schemas, exporters, and analysis helpers. Add different chip layouts as package modules under `src/pi_chip_design/layouts/` rather than as unrelated top-level scripts.

Keep the package responsibilities narrow:

- generate or transform design artifacts from explicit parameters
- provide reusable layout families and technology-specific helpers
- run local verification checks that can be repeated by the design subagent
- export files needed by downstream EDA tools

Do not put literature summaries, benchmark conclusions, or design failure narratives in the Python package. Those belong in `knowledge-base/` or `knowledge-base/design-records/`.

## Python Development Environment

From the design workspace:

```sh
cd design-projects/superconducting-qubit-chip
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
```

Basic checks:

```sh
python -m pytest
python -m ruff check src tests
```

The repository currently keeps dependencies minimal. Add heavy EDA, geometry, simulator, or GDS/OASIS dependencies only when a concrete layout workflow needs them, and document the reason in the project README.
