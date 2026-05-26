"""Submit the single-transmon Q3D manifest to a remote solver service."""

from __future__ import annotations

import argparse
from pathlib import Path

from pi_chip_design.simulation import PortSpec, prepare_q3d_capacitance
from pi_chip_design.simulation.remote import submit_simulation
from pi_chip_design.templates.single_transmon import SingleTransmonSpec, build_single_transmon_model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--solver-url",
        required=True,
        help="Remote solver-runner URL, for example http://windows-host:17890.",
    )
    args = parser.parse_args()

    model = build_single_transmon_model(SingleTransmonSpec())
    records_dir = Path(__file__).resolve().parents[4] / "design-records" / "simulations"
    prepared = prepare_q3d_capacitance(
        model,
        records_dir=records_dir,
        ports=[
            PortSpec(name="qubit_island", kind="terminal", target="right_paddle"),
            PortSpec(name="ground", kind="reference", target="ground_plane"),
        ],
    )
    remote = submit_simulation(
        prepared,
        solver_url=args.solver_url,
        records_dir=records_dir,
        artifacts=[prepared.manifest_path],
    )

    print(f"Wrote {remote.record_path}")
    print(f"Wrote {remote.result_path}")


if __name__ == "__main__":
    main()
