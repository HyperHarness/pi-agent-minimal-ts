"""Material declarations for simulation manifests."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MaterialSpec:
    """A material role needed by an electromagnetic simulation setup."""

    name: str
    role: str
    relative_permittivity: float | None = None
    conductivity_s_per_m: float | None = None

    def to_manifest(self) -> dict[str, object]:
        payload: dict[str, object] = {"name": self.name, "role": self.role}
        if self.relative_permittivity is not None:
            payload["relative_permittivity"] = self.relative_permittivity
        if self.conductivity_s_per_m is not None:
            payload["conductivity_s_per_m"] = self.conductivity_s_per_m
        return payload


def default_q3d_materials() -> list[MaterialSpec]:
    """Return conservative defaults for a superconducting-chip Q3D setup."""

    return [
        MaterialSpec(name="silicon", role="substrate", relative_permittivity=11.45),
        MaterialSpec(name="aluminum", role="superconductor", conductivity_s_per_m=3.5e7),
        MaterialSpec(name="vacuum", role="simulation_box", relative_permittivity=1.0),
    ]
