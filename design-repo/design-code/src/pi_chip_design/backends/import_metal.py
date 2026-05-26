"""Centralized Quantum Metal import compatibility."""

from __future__ import annotations

from types import ModuleType


def import_metal() -> ModuleType:
    """Import Quantum Metal across its package/import-path transition."""

    try:
        import quantum_metal as metal

        return metal
    except ModuleNotFoundError:
        import qiskit_metal as metal

        return metal
