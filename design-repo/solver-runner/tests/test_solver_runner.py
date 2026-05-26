import json
from pathlib import Path

from pi_chip_design.simulation import PortSpec, prepare_q3d_capacitance
from pi_chip_design.simulation.remote import RemoteSolverClient
from pi_chip_design.templates.ten_qubit import TenQubitSpec, build_ten_qubit_model
from pi_solver_runner import SolverRunnerServer
from pi_solver_runner.backends.fake import FakeSolverBackend
from pi_solver_runner.storage import JobStore


def _prepared_manifest(tmp_path: Path):
    model = build_ten_qubit_model(TenQubitSpec(name="server_q3d"))
    return prepare_q3d_capacitance(
        model,
        records_dir=tmp_path,
        ports=[PortSpec(name="readout_top", kind="terminal", target="readout_top")],
    )


def test_job_store_persists_request_and_fake_result(tmp_path: Path) -> None:
    prepared = _prepared_manifest(tmp_path / "records")
    store = JobStore(tmp_path / "runner")
    backend = FakeSolverBackend(store)

    submitted = backend.submit(
        {
            "spec": prepared.spec.to_manifest(),
            "artifacts": [{"name": prepared.manifest_path.name, "text": prepared.manifest_path.read_text()}],
        }
    )
    status = backend.status(submitted["job_id"])
    result = backend.result(submitted["job_id"])

    assert submitted["status"] == "submitted"
    assert status["status"] == "solved"
    assert result["solver"] == "q3d_capacitance"
    assert (tmp_path / "runner" / submitted["job_id"] / "request.json").exists()
    assert (tmp_path / "runner" / submitted["job_id"] / "result.json").exists()


def test_http_solver_runner_accepts_existing_remote_client(tmp_path: Path) -> None:
    prepared = _prepared_manifest(tmp_path / "records")

    with SolverRunnerServer(work_dir=tmp_path / "runner") as server:
        client = RemoteSolverClient(server.url)
        submitted = client.submit(prepared.spec, artifacts=[prepared.manifest_path])
        status = client.status(submitted.job_id)
        result_path = client.download_result(submitted.job_id, tmp_path / "downloads")

    result = json.loads(result_path.read_text())

    assert submitted.status == "submitted"
    assert status.status == "solved"
    assert result["job_id"] == submitted.job_id
    assert result["backend"] == "ansys_q3d"
