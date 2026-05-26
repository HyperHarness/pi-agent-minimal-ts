"""Submit the 10-qubit Q3D manifest to a remote solver service."""

from __future__ import annotations

import argparse
from pathlib import Path

from pi_chip_design.simulation import PortSpec, prepare_q3d_capacitance
from pi_chip_design.simulation.remote import LocalSolverRunner, submit_simulation
from pi_chip_design.templates.ten_qubit import TenQubitSpec, build_ten_qubit_model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--solver-url",
        default=None,
        help="Remote solver URL. If omitted, use an in-process fake runner.",
    )
    args = parser.parse_args()

    model = build_ten_qubit_model(TenQubitSpec())
    records_dir = Path(__file__).resolve().parents[4] / "design-records" / "simulations"
    prepared = prepare_q3d_capacitance(
        model,
        records_dir=records_dir,
        ports=[
            PortSpec(name="readout_top", kind="terminal", target="readout_top"),
            PortSpec(name="ground", kind="reference", target="chip_outline"),
        ],
    )

    if args.solver_url:
        remote = submit_simulation(
            prepared,
            solver_url=args.solver_url,
            records_dir=records_dir,
            artifacts=[prepared.manifest_path],
        )
    else:
        with LocalSolverRunner(records_dir / "local-runner") as runner:
            remote = submit_simulation(
                prepared,
                solver_url=runner.url,
                records_dir=records_dir,
                artifacts=[prepared.manifest_path],
            )

    print(f"Wrote {remote.record_path}")
    print(f"Wrote {remote.result_path}")


if __name__ == "__main__":
    main()
