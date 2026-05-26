"""File-backed storage for solver runner jobs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class JobStore:
    """Persist solver requests and results under a work directory."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def next_job_id(self) -> str:
        existing = [
            int(path.name.removeprefix("job-"))
            for path in self.root.glob("job-*")
            if path.is_dir() and path.name.removeprefix("job-").isdigit()
        ]
        return f"job-{(max(existing) if existing else 0) + 1:06d}"

    def write_job(self, job_id: str, *, payload: dict[str, Any], result: dict[str, Any]) -> None:
        job_dir = self.root / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        self._write_json(job_dir / "request.json", payload)
        self._write_json(job_dir / "result.json", result)
        artifacts = payload.get("artifacts", [])
        if isinstance(artifacts, list):
            artifact_dir = job_dir / "artifacts"
            artifact_dir.mkdir(exist_ok=True)
            for artifact in artifacts:
                if not isinstance(artifact, dict):
                    continue
                name = str(artifact.get("name", "artifact.txt"))
                text = str(artifact.get("text", ""))
                (artifact_dir / name).write_text(text)

    def read_result(self, job_id: str) -> dict[str, Any]:
        return json.loads((self.root / job_id / "result.json").read_text())

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
