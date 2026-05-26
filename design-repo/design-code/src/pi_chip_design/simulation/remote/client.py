"""HTTP client for remote solver services."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from urllib import request

from pi_chip_design.simulation.remote.local_transport import LocalTransportRegistry
from pi_chip_design.simulation.remote.protocol import RemoteJobStatus
from pi_chip_design.simulation.specs import SimulationSpec


@dataclass(frozen=True)
class SubmittedJob:
    """Response returned after submitting a remote simulation job."""

    job_id: str
    status: str


class RemoteSolverClient:
    """Small dependency-free HTTP client for the solver-service protocol."""

    def __init__(self, base_url: str, *, timeout_s: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s

    def submit(self, spec: SimulationSpec, *, artifacts: list[Path] | None = None) -> SubmittedJob:
        payload = {
            "spec": spec.to_manifest(),
            "artifacts": [self._artifact_payload(path) for path in artifacts or []],
        }
        response = self._json_request("POST", "/jobs", payload)
        return SubmittedJob(job_id=str(response["job_id"]), status=str(response["status"]))

    def status(self, job_id: str) -> RemoteJobStatus:
        response = self._json_request("GET", f"/jobs/{job_id}", None)
        return RemoteJobStatus(
            job_id=str(response["job_id"]),
            status=str(response["status"]),
            solver=str(response["solver"]),
            backend=str(response["backend"]),
        )

    def download_result(self, job_id: str, output_dir: str | Path) -> Path:
        response = self._json_request("GET", f"/jobs/{job_id}/result", None)
        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        result_path = destination / f"{job_id}.results.json"
        result_path.write_text(json.dumps(response, indent=2, sort_keys=True) + "\n")
        return result_path

    def _artifact_payload(self, path: Path) -> dict[str, str]:
        return {"name": path.name, "text": path.read_text()}

    def _json_request(
        self,
        method: str,
        path: str,
        payload: dict[str, object] | None,
    ) -> dict[str, object]:
        if self.base_url.startswith("memory://"):
            return self._memory_request(method, path, payload)
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload, sort_keys=True).encode()
            headers["Content-Type"] = "application/json"
        req = request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        with request.urlopen(req, timeout=self.timeout_s) as response:
            return json.loads(response.read().decode())

    def _memory_request(
        self,
        method: str,
        path: str,
        payload: dict[str, object] | None,
    ) -> dict[str, object]:
        runner_name = self.base_url.removeprefix("memory://")
        runner = LocalTransportRegistry.get(runner_name)
        parts = path.strip("/").split("/")
        if method == "POST" and path == "/jobs" and payload is not None:
            return runner.submit(payload)
        if method == "GET" and len(parts) == 2 and parts[0] == "jobs":
            return runner.status(parts[1])
        if method == "GET" and len(parts) == 3 and parts[0] == "jobs" and parts[2] == "result":
            return runner.result(parts[1])
        raise ValueError(f"unsupported memory solver request: {method} {path}")
