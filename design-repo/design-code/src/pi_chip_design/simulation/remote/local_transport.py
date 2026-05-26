"""In-memory transport for remote solver protocol tests."""

from __future__ import annotations

from typing import Any


class LocalTransportRegistry:
    """Process-local registry for fake solver runners."""

    _runners: dict[str, Any] = {}

    @classmethod
    def register(cls, name: str, runner: Any) -> None:
        cls._runners[name] = runner

    @classmethod
    def unregister(cls, name: str) -> None:
        cls._runners.pop(name, None)

    @classmethod
    def get(cls, name: str) -> Any:
        return cls._runners[name]
