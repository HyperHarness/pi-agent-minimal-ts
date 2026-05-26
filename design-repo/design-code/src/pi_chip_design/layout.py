"""Small gdstk-backed helpers for superconducting-chip layout sketches."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

import gdstk

from pi_chip_design.core.layers import LayerSpec


Point = tuple[float, float]


class ChipLayout:
    """Convenience wrapper around a single-cell gdstk library."""

    def __init__(self, name: str, *, unit: float = 1e-6, precision: float = 1e-9) -> None:
        self.library = gdstk.Library(unit=unit, precision=precision)
        self.cell = self.library.new_cell(name)

    def add_rectangle(
        self,
        name: str,
        *,
        center: Point,
        size: Point,
        layer: LayerSpec,
    ) -> None:
        del name
        cx, cy = center
        width, height = size
        lower_left = (cx - width / 2, cy - height / 2)
        upper_right = (cx + width / 2, cy + height / 2)
        self.cell.add(gdstk.rectangle(lower_left, upper_right, layer=layer.layer, datatype=layer.datatype))

    def add_box(
        self,
        name: str,
        *,
        lower_left: Point,
        upper_right: Point,
        layer: LayerSpec,
    ) -> None:
        del name
        self.cell.add(gdstk.rectangle(lower_left, upper_right, layer=layer.layer, datatype=layer.datatype))

    def add_path(
        self,
        name: str,
        *,
        points: Iterable[Point],
        width: float,
        layer: LayerSpec,
    ) -> None:
        del name
        path_points = list(points)
        if len(path_points) < 2:
            raise ValueError("path requires at least two points")
        for p1, p2 in zip(path_points, path_points[1:]):
            self._add_segment_rectangle(p1, p2, width, layer)

    def add_label(self, text: str, *, position: Point, size: float, layer: LayerSpec) -> None:
        del size
        self.cell.add(gdstk.Label(text, position, layer=layer.layer, texttype=layer.datatype))

    def to_library(self) -> gdstk.Library:
        return self.library

    def write_gds(self, path: str | Path) -> None:
        output = Path(path)
        output.parent.mkdir(parents=True, exist_ok=True)
        self.library.write_gds(output)

    def _add_segment_rectangle(self, p1: Point, p2: Point, width: float, layer: LayerSpec) -> None:
        x1, y1 = p1
        x2, y2 = p2
        half = width / 2
        if abs(x1 - x2) < 1e-9:
            self.add_box(
                "vertical_segment",
                lower_left=(x1 - half, min(y1, y2)),
                upper_right=(x1 + half, max(y1, y2)),
                layer=layer,
            )
            return
        if abs(y1 - y2) < 1e-9:
            self.add_box(
                "horizontal_segment",
                lower_left=(min(x1, x2), y1 - half),
                upper_right=(max(x1, x2), y1 + half),
                layer=layer,
            )
            return
        mid = (x2, y1)
        self._add_segment_rectangle(p1, mid, width, layer)
        self._add_segment_rectangle(mid, p2, width, layer)
