import json
from pathlib import Path

from pi_chip_design.simulation import PortSpec, prepare_q3d_capacitance
from pi_chip_design.simulation.remote import LocalSolverRunner, RemoteSolverClient, submit_simulation
from pi_chip_design.templates.ten_qubit import TenQubitSpec, build_ten_qubit_model


def test_remote_solver_client_submits_polls_and_downloads_result(tmp_path: Path) -> None:
    model = build_ten_qubit_model(TenQubitSpec(name="remote_q3d"))
    prepared = prepare_q3d_capacitance(
        model,
        records_dir=tmp_path,
        ports=[PortSpec(name="readout_top", kind="terminal", target="readout_top")],
    )

    with LocalSolverRunner(tmp_path / "runner") as runner:
        client = RemoteSolverClient(runner.url)
        submitted = client.submit(prepared.spec, artifacts=[prepared.manifest_path])
        status = client.status(submitted.job_id)
        result_path = client.download_result(submitted.job_id, tmp_path / "downloads")

    result = json.loads(result_path.read_text())

    assert submitted.status == "submitted"
    assert submitted.job_id.startswith("job-")
    assert status.status == "solved"
    assert result["job_id"] == submitted.job_id
    assert result["status"] == "solved"
    assert result["solver"] == "q3d_capacitance"
    assert result["backend"] == "ansys_q3d"


def test_submit_simulation_workflow_writes_remote_record(tmp_path: Path) -> None:
    model = build_ten_qubit_model(TenQubitSpec(name="workflow_q3d"))
    prepared = prepare_q3d_capacitance(model, records_dir=tmp_path / "records")

    with LocalSolverRunner(tmp_path / "runner") as runner:
        remote = submit_simulation(
            prepared,
            solver_url=runner.url,
            records_dir=tmp_path / "records",
            artifacts=[prepared.manifest_path],
        )

    record = json.loads(remote.record_path.read_text())

    assert remote.status == "solved"
    assert remote.record_path.name == "workflow_q3d-q3d-capacitance.remote.json"
    assert record["job_id"] == remote.job_id
    assert record["status"] == "solved"
    assert record["result_path"].endswith(".results.json")
