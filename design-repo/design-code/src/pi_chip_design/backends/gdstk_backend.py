"""gdstk renderer for backend-independent layout models."""

from __future__ import annotations

from pathlib import Path

import gdstk

from pi_chip_design.core.geometry import Label, LayoutModel, PathShape, Point, Rectangle
from pi_chip_design.core.layers import LayerSpec


class GdstkRenderer:
    """Render a :class:`LayoutModel` into a single-cell gdstk library."""

    def __init__(self, *, unit: float = 1e-6, precision: float = 1e-9) -> None:
        self.unit = unit
        self.precision = precision

    def render(self, model: LayoutModel) -> gdstk.Library:
        library = gdstk.Library(unit=self.unit, precision=self.precision)
        cell = library.new_cell(model.name)
        for shape in model.shapes:
            if isinstance(shape, Rectangle):
                self._add_rectangle(cell, shape)
            elif isinstance(shape, PathShape):
                self._add_path(cell, shape)
            elif isinstance(shape, Label):
                self._add_label(cell, shape)
        return library

    def write_gds(self, model: LayoutModel, path: str | Path) -> None:
        output = Path(path)
        output.parent.mkdir(parents=True, exist_ok=True)
        self.render(model).write_gds(output)

    def _add_rectangle(self, cell: gdstk.Cell, shape: Rectangle) -> None:
        cx, cy = shape.center
        width, height = shape.size
        lower_left = (cx - width / 2, cy - height / 2)
        upper_right = (cx + width / 2, cy + height / 2)
        cell.add(
            gdstk.rectangle(
                lower_left,
                upper_right,
                layer=shape.layer.layer,
                datatype=shape.layer.datatype,
            )
        )

    def _add_path(self, cell: gdstk.Cell, shape: PathShape) -> None:
        for p1, p2 in zip(shape.points, shape.points[1:]):
            self._add_segment_rectangle(cell, p1, p2, shape.width, shape.layer)

    def _add_label(self, cell: gdstk.Cell, shape: Label) -> None:
        cell.add(
            gdstk.Label(
                shape.text,
                shape.position,
                layer=shape.layer.layer,
                texttype=shape.layer.datatype,
            )
        )

    def _add_segment_rectangle(
        self,
        cell: gdstk.Cell,
        p1: Point,
        p2: Point,
        width: float,
        layer: LayerSpec,
    ) -> None:
        x1, y1 = p1
        x2, y2 = p2
        half = width / 2
        if abs(x1 - x2) < 1e-9:
            cell.add(
                gdstk.rectangle(
                    (x1 - half, min(y1, y2)),
                    (x1 + half, max(y1, y2)),
                    layer=layer.layer,
                    datatype=layer.datatype,
                )
            )
            return
        if abs(y1 - y2) < 1e-9:
            cell.add(
                gdstk.rectangle(
                    (min(x1, x2), y1 - half),
                    (max(x1, x2), y1 + half),
                    layer=layer.layer,
                    datatype=layer.datatype,
                )
            )
            return
        mid = (x2, y1)
        self._add_segment_rectangle(cell, p1, mid, width, layer)
        self._add_segment_rectangle(cell, mid, p2, width, layer)
