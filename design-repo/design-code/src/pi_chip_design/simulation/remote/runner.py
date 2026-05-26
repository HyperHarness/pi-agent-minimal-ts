"""Local HTTP solver runner used for protocol tests and demos."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pi_chip_design.simulation.remote.local_transport import LocalTransportRegistry


class LocalSolverRunner:
    """In-process fake solver service implementing the remote protocol."""

    def __init__(self, work_dir: str | Path) -> None:
        self.work_dir = Path(work_dir)
        self.jobs: dict[str, dict[str, Any]] = {}
        self.name = f"runner-{id(self)}"

    @property
    def url(self) -> str:
        return f"memory://{self.name}"

    def __enter__(self) -> "LocalSolverRunner":
        self.work_dir.mkdir(parents=True, exist_ok=True)
        LocalTransportRegistry.register(self.name, self)
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        LocalTransportRegistry.unregister(self.name)

    def submit(self, payload: dict[str, Any]) -> dict[str, str]:
        spec = payload["spec"]
        job_id = f"job-{len(self.jobs) + 1:06d}"
        result = {
            "job_id": job_id,
            "status": "solved",
            "solver": spec["solver"],
            "backend": spec["backend"],
            "layout": spec["layout"],
        }
        job_dir = self.work_dir / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "request.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
        (job_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        self.jobs[job_id] = {"spec": spec, "result": result}
        return {"job_id": job_id, "status": "submitted"}

    def status(self, job_id: str) -> dict[str, str]:
        job = self.jobs[job_id]
        spec = job["spec"]
        return {
            "job_id": job_id,
            "status": "solved",
            "solver": spec["solver"],
            "backend": spec["backend"],
        }

    def result(self, job_id: str) -> dict[str, Any]:
        return self.jobs[job_id]["result"]
