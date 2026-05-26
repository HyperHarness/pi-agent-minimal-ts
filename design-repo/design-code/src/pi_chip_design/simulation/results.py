"""Simulation workflow result objects."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from pi_chip_design.simulation.specs import SimulationSpec, SolverBackend, SolverType


@dataclass(frozen=True)
class SimulationResult:
    """Result returned by a simulation preparation or execution backend."""

    spec: SimulationSpec
    status: str
    manifest_path: Path

    @property
    def solver(self) -> SolverType:
        return self.spec.solver

    @property
    def backend(self) -> SolverBackend:
        return self.spec.backend
