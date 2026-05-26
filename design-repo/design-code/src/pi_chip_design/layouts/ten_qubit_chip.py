"""Generate a conceptual 10-qubit superconducting chip GDS with gdstk."""

from __future__ import annotations

from pathlib import Path

from pi_chip_design.backends.gdstk_backend import GdstkRenderer
from pi_chip_design.core.geometry import LayoutModel
from pi_chip_design.templates.ten_qubit import TenQubitSpec, build_ten_qubit_model


def build_ten_qubit_chip() -> LayoutModel:
    """Build the default backend-independent 10-qubit layout model."""

    return build_ten_qubit_model(TenQubitSpec(name="ten_qubit_superconducting_chip_concept"))


def main() -> None:
    out = Path(__file__).resolve().parents[3] / "outputs" / "ten_qubit_chip_concept.gds"
    GdstkRenderer().write_gds(build_ten_qubit_chip(), out)
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
