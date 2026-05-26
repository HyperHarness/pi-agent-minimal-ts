"""Backend-independent geometric layout model."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TypeAlias

from pi_chip_design.core.layers import LayerSpec


Point: TypeAlias = tuple[float, float]


@dataclass(frozen=True)
class Rectangle:
    """Axis-aligned rectangle defined by center and size."""

    name: str
    center: Point
    size: Point
    layer: LayerSpec


@dataclass(frozen=True)
class PathShape:
    """Orthogonal routed path with a constant width."""

    name: str
    points: tuple[Point, ...]
    width: float
    layer: LayerSpec

    def __post_init__(self) -> None:
        if len(self.points) < 2:
            raise ValueError("path requires at least two points")
        if self.width <= 0:
            raise ValueError("path width must be positive")


@dataclass(frozen=True)
class Label:
    """GDS label annotation."""

    text: str
    position: Point
    size: float
    layer: LayerSpec


Shape: TypeAlias = Rectangle | PathShape | Label


@dataclass
class LayoutModel:
    """Backend-independent single-cell layout model."""

    name: str
    shapes: list[Shape] = field(default_factory=list)

    def add_rectangle(self, name: str, *, center: Point, size: Point, layer: LayerSpec) -> None:
        self.shapes.append(Rectangle(name=name, center=center, size=size, layer=layer))

    def add_path(
        self,
        name: str,
        *,
        points: list[Point] | tuple[Point, ...],
        width: float,
        layer: LayerSpec,
    ) -> None:
        self.shapes.append(PathShape(name=name, points=tuple(points), width=width, layer=layer))

    def add_label(self, text: str, *, position: Point, size: float, layer: LayerSpec) -> None:
        self.shapes.append(Label(text=text, position=position, size=size, layer=layer))
