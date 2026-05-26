"""Closed-loop simulation preparation workflows."""

from __future__ import annotations

from pathlib import Path

from pi_chip_design.core.geometry import LayoutModel
from pi_chip_design.simulation.backends.ansys_q3d import AnsysQ3DBackend
from pi_chip_design.simulation.materials import MaterialSpec, default_q3d_materials
from pi_chip_design.simulation.ports import PortSpec
from pi_chip_design.simulation.results import SimulationResult
from pi_chip_design.simulation.specs import LayoutSummary, SimulationSpec, SolverBackend, SolverType


def prepare_q3d_capacitance(
    model: LayoutModel,
    *,
    records_dir: str | Path,
    materials: list[MaterialSpec] | None = None,
    ports: list[PortSpec] | None = None,
) -> SimulationResult:
    """Prepare a deterministic Q3D capacitance simulation manifest."""

    simulation_name = f"{model.name}-q3d-capacitance"
    spec = SimulationSpec(
        name=simulation_name,
        solver=SolverType.Q3D_CAPACITANCE,
        backend=SolverBackend.ANSYS_Q3D,
        layout=LayoutSummary.from_model(model),
        materials=tuple(materials or default_q3d_materials()),
        ports=tuple(ports or []),
    )
    return AnsysQ3DBackend().prepare(spec, records_dir)
