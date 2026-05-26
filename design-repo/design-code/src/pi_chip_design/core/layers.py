"""GDS layer definitions used by PI chip layouts."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LayerSpec:
    """GDS layer/datatype pair."""

    layer: int
    datatype: int = 0

    def __post_init__(self) -> None:
        if not 0 <= self.layer <= 65535:
            raise ValueError("layer must be between 0 and 65535")
        if not 0 <= self.datatype <= 65535:
            raise ValueError("datatype must be between 0 and 65535")


@dataclass(frozen=True)
class LayerPalette:
    """Named layer palette for superconducting-chip concept layouts."""

    chip: LayerSpec = LayerSpec(1, 0)
    ground: LayerSpec = LayerSpec(2, 0)
    metal: LayerSpec = LayerSpec(10, 0)
    resonator: LayerSpec = LayerSpec(20, 0)
    coupler: LayerSpec = LayerSpec(30, 0)
    readout: LayerSpec = LayerSpec(40, 0)
    control: LayerSpec = LayerSpec(50, 0)
    marker: LayerSpec = LayerSpec(60, 0)
    label: LayerSpec = LayerSpec(70, 0)


DEFAULT_LAYERS = LayerPalette()
