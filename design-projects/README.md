# Design Projects Redirect

Chip-design source code is now managed as knowledge-base content under:

```text
knowledge-base/design-projects/
```

This keeps design code, generated artifacts, design records, source summaries, manifests, and synthesis pages in one data flywheel. Do not add new design projects under this directory.

Recommended repo-manager configuration for the first design workspace:

```sh
BRIDGE_DESIGN_WORKSPACE_DIR=<repo-root>/knowledge-base/design-projects/superconducting-qubit-chip
```

## Python Package Convention

The first package workspace is:

```text
knowledge-base/design-projects/superconducting-qubit-chip/
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

Do not put literature summaries, benchmark conclusions, or design failure narratives directly in the Python package. Those belong in `knowledge-base/sources/`, `knowledge-base/manifests/`, `knowledge-base/pages/`, or `knowledge-base/design-records/`.

## Python Development Environment

Use a single repository-root virtual environment:

```sh
cd <repo-root>
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e "knowledge-base/design-projects/superconducting-qubit-chip[dev]"
```

On WSL images without `python3-venv`, use `uv venv --seed .venv` and then run the same activation and install commands.

The parent agent process does not need to be started from an activated shell. When the design-subagent runs a Python script through `run_design_script`, it uses the repository root `.venv/bin/python` before falling back to WSL/system `python3`.

Basic checks:

```sh
.venv/bin/python -m pytest knowledge-base/design-projects/superconducting-qubit-chip/tests
.venv/bin/python -m ruff check knowledge-base/design-projects/superconducting-qubit-chip/src knowledge-base/design-projects/superconducting-qubit-chip/tests
```

The repository currently keeps dependencies minimal. Add heavy EDA, geometry, simulator, or GDS/OASIS dependencies only when a concrete layout workflow needs them, and document the reason in the project README.
