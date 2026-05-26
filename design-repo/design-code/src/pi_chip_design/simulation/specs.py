"""Backend-independent simulation task specifications."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from pi_chip_design.core.geometry import Label, LayoutModel, PathShape, Rectangle
from pi_chip_design.simulation.materials import MaterialSpec
from pi_chip_design.simulation.ports import PortSpec


class SolverType(StrEnum):
    """Supported electromagnetic simulation intents."""

    Q3D_CAPACITANCE = "q3d_capacitance"


class SolverBackend(StrEnum):
    """Supported solver backends."""

    ANSYS_Q3D = "ansys_q3d"


@dataclass(frozen=True)
class LayoutSummary:
    """Small deterministic summary of the layout sent to a solver."""

    name: str
    shape_count: int
    layers: tuple[int, ...]
    rectangles: int
    paths: int
    labels: int

    @classmethod
    def from_model(cls, model: LayoutModel) -> "LayoutSummary":
        layers = sorted({shape.layer.layer for shape in model.shapes})
        return cls(
            name=model.name,
            shape_count=len(model.shapes),
            layers=tuple(layers),
            rectangles=sum(isinstance(shape, Rectangle) for shape in model.shapes),
            paths=sum(isinstance(shape, PathShape) for shape in model.shapes),
            labels=sum(isinstance(shape, Label) for shape in model.shapes),
        )

    def to_manifest(self) -> dict[str, object]:
        return {
            "name": self.name,
            "shape_count": self.shape_count,
            "layers": list(self.layers),
            "rectangles": self.rectangles,
            "paths": self.paths,
            "labels": self.labels,
        }


@dataclass(frozen=True)
class SimulationSpec:
    """A prepared electromagnetic simulation task."""

    name: str
    solver: SolverType
    backend: SolverBackend
    layout: LayoutSummary
    materials: tuple[MaterialSpec, ...]
    ports: tuple[PortSpec, ...]

    def to_manifest(self) -> dict[str, object]:
        return {
            "name": self.name,
            "solver": self.solver.value,
            "backend": self.backend.value,
            "layout": self.layout.to_manifest(),
            "materials": [material.to_manifest() for material in self.materials],
            "ports": [port.to_manifest() for port in self.ports],
        }
