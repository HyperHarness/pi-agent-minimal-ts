"""Backend-independent 10-qubit superconducting-chip template."""

from __future__ import annotations

from dataclasses import dataclass

from pi_chip_design.core.geometry import LayoutModel
from pi_chip_design.core.layers import DEFAULT_LAYERS, LayerPalette


@dataclass(frozen=True)
class TenQubitSpec:
    """Parameters for the conceptual 10-qubit chip template."""

    name: str = "ten_qubit_chip"
    chip_size: tuple[float, float] = (10000.0, 10000.0)
    qubit_pitch_x: float = 1800.0
    qubit_pitch_y: float = 3200.0
    pad_size: tuple[float, float] = (150.0, 90.0)
    pad_gap: float = 70.0
    layers: LayerPalette = DEFAULT_LAYERS


def build_ten_qubit_model(spec: TenQubitSpec) -> LayoutModel:
    """Build the 10-qubit concept as a backend-independent model."""

    model = LayoutModel(spec.name)
    chip_w, chip_h = spec.chip_size
    layers = spec.layers
    model.add_rectangle("chip_outline", center=(0.0, 0.0), size=spec.chip_size, layer=layers.chip)

    xs = [spec.qubit_pitch_x * offset for offset in (-2, -1, 0, 1, 2)]
    ys = [spec.qubit_pitch_y / 2, -spec.qubit_pitch_y / 2]
    pad_w, pad_h = spec.pad_size
    pad_offset = (pad_w + spec.pad_gap) / 2

    for row, y in enumerate(ys):
        direction = 1 if row == 0 else -1
        for col, x in enumerate(xs):
            idx = row * 5 + col
            qname = f"Q{idx}"
            model.add_rectangle(
                f"{qname}_left_pad",
                center=(x - pad_offset, y),
                size=spec.pad_size,
                layer=layers.metal,
            )
            model.add_rectangle(
                f"{qname}_right_pad",
                center=(x + pad_offset, y),
                size=spec.pad_size,
                layer=layers.metal,
            )
            model.add_rectangle(
                f"{qname}_junction",
                center=(x, y),
                size=(42.0, 8.0),
                layer=layers.metal,
            )
            model.add_label(qname, position=(x - 46.0, y + 145.0), size=45.0, layer=layers.label)

            ry = y + direction * 360.0
            model.add_path(
                f"{qname}_readout_resonator",
                points=[(x - 260.0, ry), (x + 260.0, ry)],
                width=24.0,
                layer=layers.resonator,
            )
            model.add_path(
                f"{qname}_readout_coupler",
                points=[(x, y + direction * 70.0), (x, ry)],
                width=16.0,
                layer=layers.coupler,
            )
            edge_y = chip_h / 2 - 600.0 if row == 0 else -chip_h / 2 + 600.0
            model.add_path(
                f"{qname}_control",
                points=[(x, edge_y), (x, y + direction * 520.0)],
                width=18.0,
                layer=layers.control,
            )

    for row, y in enumerate(ys):
        for col in range(4):
            model.add_path(
                f"horizontal_coupler_{row}_{col}",
                points=[(xs[col] + 230.0, y), (xs[col + 1] - 230.0, y)],
                width=22.0,
                layer=layers.coupler,
            )

    for col, x in enumerate(xs):
        model.add_path(
            f"vertical_coupler_{col}",
            points=[(x, ys[1] + 180.0), (x, ys[0] - 180.0)],
            width=22.0,
            layer=layers.coupler,
        )

    model.add_path(
        "readout_top",
        points=[(-chip_w / 2 + 500.0, 2450.0), (chip_w / 2 - 500.0, 2450.0)],
        width=36.0,
        layer=layers.readout,
    )
    model.add_path(
        "readout_bottom",
        points=[(-chip_w / 2 + 500.0, -2450.0), (chip_w / 2 - 500.0, -2450.0)],
        width=36.0,
        layer=layers.readout,
    )
    return model
