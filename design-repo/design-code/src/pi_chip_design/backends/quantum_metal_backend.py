"""Quantum Metal renderer for backend-independent layout models."""

from __future__ import annotations

from importlib import import_module
from pathlib import Path
from typing import Any

from pi_chip_design.backends.import_metal import import_metal
from pi_chip_design.core.geometry import Label, LayoutModel, PathShape, Rectangle


class QuantumMetalRenderer:
    """Render layout models through the Quantum Metal component system."""

    def render(self, model: LayoutModel) -> Any:
        metal = import_metal()
        module_name = metal.__name__
        designs = import_module(f"{module_name}.designs")
        qlibrary_core = import_module(f"{module_name}.qlibrary.core")
        attr_dict = import_module(f"{module_name}.toolbox_python.attr_dict")
        qcomponent = qlibrary_core.QComponent
        metal_dict = attr_dict.Dict

        class RectangleComponent(qcomponent):  # type: ignore[misc, valid-type]
            default_options = metal_dict(
                pos_x="0mm",
                pos_y="0mm",
                width="0.1mm",
                height="0.1mm",
                layer="10",
            )

            def make(self) -> None:
                p = self.p
                rect = metal.draw.rectangle(
                    float(p.width),
                    float(p.height),
                    float(p.pos_x),
                    float(p.pos_y),
                )
                self.add_qgeometry("poly", {"rect": rect}, layer=int(p.layer))

        class PathComponent(qcomponent):  # type: ignore[misc, valid-type]
            default_options = metal_dict(points="", width="0.02mm", layer="20")

            def make(self) -> None:
                pts = [tuple(pair) for pair in self.options.points]
                trace = metal.draw.LineString(pts).buffer(
                    float(self.p.width) / 2,
                    cap_style=2,
                    join_style=2,
                )
                self.add_qgeometry("poly", {"trace": trace}, layer=int(self.p.layer))

        design = designs.DesignPlanar()
        design.overwrite_enabled = True
        design.chips.main.size.size_x = "10mm"
        design.chips.main.size.size_y = "10mm"

        for index, shape in enumerate(model.shapes):
            if isinstance(shape, Rectangle):
                RectangleComponent(
                    design,
                    shape.name,
                    options=metal_dict(
                        pos_x=f"{_um_to_mm(shape.center[0])}mm",
                        pos_y=f"{_um_to_mm(shape.center[1])}mm",
                        width=f"{_um_to_mm(shape.size[0])}mm",
                        height=f"{_um_to_mm(shape.size[1])}mm",
                        layer=str(shape.layer.layer),
                    ),
                )
            elif isinstance(shape, PathShape):
                PathComponent(
                    design,
                    shape.name,
                    options=metal_dict(
                        points=[(_um_to_mm(x), _um_to_mm(y)) for x, y in shape.points],
                        width=f"{_um_to_mm(shape.width)}mm",
                        layer=str(shape.layer.layer),
                    ),
                )
            elif isinstance(shape, Label):
                continue
            else:
                raise TypeError(f"unsupported shape at index {index}: {type(shape).__name__}")

        design.rebuild()
        return design

    def write_gds(self, model: LayoutModel, path: str | Path) -> None:
        output = Path(path)
        output.parent.mkdir(parents=True, exist_ok=True)
        design = self.render(model)
        renderer = design.renderers.gds
        renderer.options.path_filename = str(output)
        renderer.options.gds_unit = 1e-6
        renderer.options.gds_precision = 1e-9
        self._disable_default_cheesing(renderer, model)
        renderer.export_to_gds(renderer.options.path_filename)

    def _disable_default_cheesing(self, renderer: Any, model: LayoutModel) -> None:
        layers = sorted(
            {
                shape.layer.layer
                for shape in model.shapes
                if isinstance(shape, Rectangle | PathShape | Label)
            }
        )
        layer_options = {layer: False for layer in layers}
        renderer.options.cheese.view_in_file = {"main": layer_options}
        renderer.options.no_cheese.view_in_file = {"main": layer_options}


def _um_to_mm(value: float) -> float:
    return value / 1000.0
