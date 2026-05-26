"""Generate a conceptual 10-qubit superconducting chip GDS with Quantum Metal."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pi_chip_design.backends.quantum_metal_backend import QuantumMetalRenderer
from pi_chip_design.templates.ten_qubit import TenQubitSpec, build_ten_qubit_model


def build_design() -> Any:
    """Build the default Quantum Metal design from the shared 10-qubit template."""

    model = build_ten_qubit_model(TenQubitSpec(name="ten_qubit_quantum_metal"))
    return QuantumMetalRenderer().render(model)


def main() -> None:
    out = Path(__file__).resolve().parents[3] / "outputs" / "ten_qubit_quantum_metal.gds"
    model = build_ten_qubit_model(TenQubitSpec(name="ten_qubit_quantum_metal"))
    QuantumMetalRenderer().write_gds(model, out)
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
