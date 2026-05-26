"""Ansys Q3D simulation task preparation backend."""

from __future__ import annotations

import json
from pathlib import Path

from pi_chip_design.simulation.results import SimulationResult
from pi_chip_design.simulation.specs import SimulationSpec, SolverBackend, SolverType


class AnsysQ3DBackend:
    """Prepare deterministic Q3D capacitance task manifests.

    This backend intentionally stops at setup preparation. Actual AEDT execution
    should be added as a separate runner so local tests do not require a license.
    """

    solver = SolverType.Q3D_CAPACITANCE
    backend = SolverBackend.ANSYS_Q3D

    def prepare(self, spec: SimulationSpec, records_dir: str | Path) -> SimulationResult:
        if spec.solver != self.solver:
            raise ValueError(f"AnsysQ3DBackend only accepts {self.solver.value}")
        if spec.backend != self.backend:
            raise ValueError(f"AnsysQ3DBackend only accepts {self.backend.value}")

        output_dir = Path(records_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = output_dir / f"{spec.name}.json"
        manifest = spec.to_manifest()
        manifest["status"] = "prepared"
        manifest["runner"] = {
            "requires": ["quantum-metal[ansys]", "Ansys AEDT license"],
            "execution": "not_started",
        }
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        return SimulationResult(spec=spec, status="prepared", manifest_path=manifest_path)
