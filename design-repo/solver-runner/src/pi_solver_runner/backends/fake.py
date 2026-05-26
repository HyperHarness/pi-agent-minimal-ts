"""Deterministic fake solver backend for protocol tests."""

from __future__ import annotations

from typing import Any

from pi_solver_runner.storage import JobStore


class FakeSolverBackend:
    """Accept a simulation request and immediately mark it solved."""

    def __init__(self, store: JobStore) -> None:
        self.store = store

    def submit(self, payload: dict[str, Any]) -> dict[str, str]:
        spec = payload["spec"]
        job_id = self.store.next_job_id()
        result = {
            "job_id": job_id,
            "status": "solved",
            "solver": spec["solver"],
            "backend": spec["backend"],
            "layout": spec["layout"],
        }
        self.store.write_job(job_id, payload=payload, result=result)
        return {"job_id": job_id, "status": "submitted"}

    def status(self, job_id: str) -> dict[str, str]:
        result = self.store.read_result(job_id)
        return {
            "job_id": job_id,
            "status": str(result["status"]),
            "solver": str(result["solver"]),
            "backend": str(result["backend"]),
        }

    def result(self, job_id: str) -> dict[str, Any]:
        return self.store.read_result(job_id)
