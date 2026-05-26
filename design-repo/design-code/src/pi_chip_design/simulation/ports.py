"""Port declarations for electromagnetic simulation tasks."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PortSpec:
    """A named simulation terminal or reference target."""

    name: str
    kind: str
    target: str

    def __post_init__(self) -> None:
        if self.kind not in {"terminal", "reference", "lumped", "eigenmode"}:
            raise ValueError("port kind must be terminal, reference, lumped, or eigenmode")

    def to_manifest(self) -> dict[str, str]:
        return {"name": self.name, "kind": self.kind, "target": self.target}
