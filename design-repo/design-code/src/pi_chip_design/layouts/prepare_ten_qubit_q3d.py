"""Prepare a Q3D capacitance simulation manifest for the 10-qubit template."""

from __future__ import annotations

from pathlib import Path

from pi_chip_design.simulation import PortSpec, prepare_q3d_capacitance
from pi_chip_design.templates.ten_qubit import TenQubitSpec, build_ten_qubit_model


def main() -> None:
    model = build_ten_qubit_model(TenQubitSpec())
    records_dir = Path(__file__).resolve().parents[4] / "design-records" / "simulations"
    result = prepare_q3d_capacitance(
        model,
        records_dir=records_dir,
        ports=[
            PortSpec(name="readout_top", kind="terminal", target="readout_top"),
            PortSpec(name="ground", kind="reference", target="chip_outline"),
        ],
    )
    print(f"Wrote {result.manifest_path}")


if __name__ == "__main__":
    main()
