# PI Chip Design

This package contains the design-agent Python codebase for superconducting-chip layout generation and verification.

It is intentionally stored under `design-repo/design-code/` and tracked by the parent `pi-agent-minimal-ts` repository. The package provides a stable PI chip layout API, a lightweight `gdstk` backend, and a Quantum Metal backend for higher-level superconducting-device design. Design artifacts and design records live in sibling `design-repo/` directories.

## Environment

The source package owns `pyproject.toml` and `uv.lock`, but the Python environment is shared at the parent repository root:

```sh
cd ../..
UV_PROJECT_ENVIRONMENT="$PWD/.venv" uv sync --project "$PWD/design-repo/design-code" --extra dev
```

The design-agent normally performs this through `sync_design_environment`.

## Layout

```text
src/pi_chip_design/
  core/
  backends/
  simulation/
  templates/
  layouts/
scripts/
tests/
outputs/
```

`core/` owns backend-independent layout models and layer definitions. `templates/` builds reusable chip-level models. `backends/` turns those models into concrete outputs such as GDS through `gdstk` or Quantum Metal. `simulation/` prepares electromagnetic simulation tasks and writes deterministic manifests for solver runners. `layouts/` contains executable examples and CLI-style entrypoints.

Generated layout outputs should stay under `outputs/` and remain out of Git unless a small fixture is intentionally added for a test.

## Simulation

The package currently supports a minimal Q3D capacitance preparation loop. It does not run Ansys AEDT directly; it writes a deterministic manifest that records the layout summary, materials, ports, requested solver, and required external runner dependencies.

```sh
cd ../..
.venv/bin/python -m pi_chip_design.layouts.prepare_ten_qubit_q3d
```

The generated manifest is written under `design-repo/design-records/simulations/` and should be treated as a design record, not wiki knowledge.

Remote solver submission uses the same manifest and a small service protocol:

```sh
cd ../..
.venv/bin/python -m pi_chip_design.layouts.submit_ten_qubit_q3d_remote --solver-url http://windows-host:17890
.venv/bin/python -m pi_chip_design.layouts.submit_single_transmon_q3d_remote --solver-url http://windows-host:17890
```

The design-agent exposes this as `submit_design_simulation` for EM, Q3D, HFSS, AEDT, capacitance-extraction, and frequency-validation requests. The tool uses `solverUrl` when supplied, otherwise `PI_DESIGN_SOLVER_URL` or `PI_SOLVER_URL`. With `--solver-url http://windows-host:17890`, it submits to a real solver service that can run on Windows or a simulation server and hide AEDT, license, queue, and file-path details from the WSL agent.
