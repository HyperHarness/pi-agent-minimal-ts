"""Protocol objects for remote solver services."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RemoteJobStatus:
    """Current state of a remote solver job."""

    job_id: str
    status: str
    solver: str
    backend: str


@dataclass(frozen=True)
class RemoteJobResult:
    """Local record for a submitted remote solver job."""

    job_id: str
    status: str
    record_path: Path
    result_path: Path
