"""Backend-independent single-transmon superconducting-qubit template."""

from __future__ import annotations

from dataclasses import dataclass

from pi_chip_design.core.geometry import LayoutModel
from pi_chip_design.core.layers import DEFAULT_LAYERS, LayerPalette


@dataclass(frozen=True)
class SingleTransmonSpec:
    """Parameters for a conceptual fixed-frequency single transmon."""

    name: str = "single_transmon_5p4ghz"
    chip_size: tuple[float, float] = (4000.0, 3000.0)
    target_f01_ghz: float = 5.4
    paddle_size: tuple[float, float] = (180.0, 520.0)
    paddle_gap: float = 50.0
    arm_size: tuple[float, float] = (70.0, 260.0)
    layers: LayerPalette = DEFAULT_LAYERS


def build_single_transmon_model(spec: SingleTransmonSpec) -> LayoutModel:
    """Build a single-transmon concept as a backend-independent model."""

    layers = spec.layers
    model = LayoutModel(spec.name)
    paddle_w, paddle_h = spec.paddle_size
    paddle_offset = (paddle_w + spec.paddle_gap) / 2
    arm_w, arm_h = spec.arm_size

    model.add_rectangle("chip_outline", center=(0.0, 0.0), size=spec.chip_size, layer=layers.chip)
    model.add_rectangle("ground_plane", center=(0.0, 0.0), size=(3600.0, 2600.0), layer=layers.ground)
    model.add_rectangle(
        "left_paddle",
        center=(-paddle_offset, 0.0),
        size=spec.paddle_size,
        layer=layers.metal,
    )
    model.add_rectangle(
        "right_paddle",
        center=(paddle_offset, 0.0),
        size=spec.paddle_size,
        layer=layers.metal,
    )
    model.add_rectangle("top_arm", center=(0.0, 230.0), size=(arm_w, arm_h), layer=layers.metal)
    model.add_rectangle("bottom_arm", center=(0.0, -230.0), size=(arm_w, arm_h), layer=layers.metal)
    model.add_rectangle("junction_left_lead", center=(-18.0, 0.0), size=(34.0, 8.0), layer=layers.coupler)
    model.add_rectangle("junction_right_lead", center=(18.0, 0.0), size=(34.0, 8.0), layer=layers.coupler)
    model.add_path(
        "readout_resonator",
        points=[(360.0, 360.0), (900.0, 360.0), (900.0, 120.0), (520.0, 120.0)],
        width=18.0,
        layer=layers.readout,
    )
    model.add_path(
        "xy_control",
        points=[(-900.0, -380.0), (-350.0, -380.0), (-350.0, -120.0)],
        width=12.0,
        layer=layers.control,
    )
    model.add_label(
        f"single transmon target f01={spec.target_f01_ghz:.3f} GHz",
        position=(-1750.0, -1350.0),
        size=40.0,
        layer=layers.label,
    )
    return model
