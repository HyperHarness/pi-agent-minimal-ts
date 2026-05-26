import json
from pathlib import Path

from pi_chip_design.simulation import (
    AnsysQ3DBackend,
    MaterialSpec,
    PortSpec,
    SolverBackend,
    SolverType,
    prepare_q3d_capacitance,
)
from pi_chip_design.templates.ten_qubit import TenQubitSpec, build_ten_qubit_model


def test_prepare_q3d_capacitance_writes_manifest(tmp_path: Path) -> None:
    model = build_ten_qubit_model(TenQubitSpec())

    result = prepare_q3d_capacitance(
        model,
        records_dir=tmp_path,
        ports=[
            PortSpec(name="readout_top", kind="terminal", target="readout_top"),
            PortSpec(name="ground", kind="reference", target="chip_outline"),
        ],
    )

    manifest = json.loads(result.manifest_path.read_text())

    assert result.status == "prepared"
    assert result.solver == SolverType.Q3D_CAPACITANCE
    assert result.backend == SolverBackend.ANSYS_Q3D
    assert result.manifest_path.name == "ten_qubit_chip-q3d-capacitance.json"
    assert manifest["layout"]["name"] == "ten_qubit_chip"
    assert manifest["layout"]["shape_count"] == len(model.shapes)
    assert manifest["layout"]["layers"] == [1, 10, 20, 30, 40, 50, 70]
    assert manifest["ports"][0]["name"] == "readout_top"
    assert manifest["materials"][0]["name"] == "silicon"
    assert manifest["status"] == "prepared"


def test_ansys_q3d_backend_manifest_is_deterministic(tmp_path: Path) -> None:
    model = build_ten_qubit_model(TenQubitSpec(name="unit_q3d"))
    spec = prepare_q3d_capacitance(
        model,
        records_dir=tmp_path,
        materials=[MaterialSpec(name="sapphire", role="substrate", relative_permittivity=9.4)],
        ports=[PortSpec(name="pad", kind="terminal", target="Q0_left_pad")],
    ).spec

    backend = AnsysQ3DBackend()
    first = backend.prepare(spec, tmp_path)
    second = backend.prepare(spec, tmp_path)

    assert first.manifest_path == second.manifest_path
    assert first.manifest_path.read_text() == second.manifest_path.read_text()
