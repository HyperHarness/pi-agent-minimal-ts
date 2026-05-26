"""High-level remote solver workflows."""

from __future__ import annotations

import json
from pathlib import Path

from pi_chip_design.simulation.remote.client import RemoteSolverClient
from pi_chip_design.simulation.remote.protocol import RemoteJobResult
from pi_chip_design.simulation.results import SimulationResult


def submit_simulation(
    prepared: SimulationResult,
    *,
    solver_url: str,
    records_dir: str | Path,
    artifacts: list[Path] | None = None,
) -> RemoteJobResult:
    """Submit a prepared simulation to a remote solver and persist local state."""

    client = RemoteSolverClient(solver_url)
    submitted = client.submit(prepared.spec, artifacts=artifacts)
    status = client.status(submitted.job_id)
    result_path = client.download_result(submitted.job_id, records_dir)
    record_path = Path(records_dir) / f"{prepared.spec.name}.remote.json"
    record = {
        "job_id": submitted.job_id,
        "status": status.status,
        "solver": status.solver,
        "backend": status.backend,
        "result_path": str(result_path),
        "solver_url": solver_url,
    }
    record_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    return RemoteJobResult(
        job_id=submitted.job_id,
        status=status.status,
        record_path=record_path,
        result_path=result_path,
    )
