import json
from pathlib import Path
from urllib import request

from pi_solver_runner import SolverRunnerServer
from pi_solver_runner.backends.fake import FakeSolverBackend
from pi_solver_runner.storage import JobStore


def _simulation_payload() -> dict[str, object]:
    return {
        "spec": {
            "name": "server_q3d-q3d-capacitance",
            "solver": "q3d_capacitance",
            "backend": "ansys_q3d",
            "layout": {
                "name": "server_q3d",
                "shape_count": 86,
                "layers": [1, 10, 20, 30, 40, 50, 70],
                "rectangles": 31,
                "paths": 45,
                "labels": 10,
            },
            "materials": [
                {"name": "silicon", "role": "substrate", "relative_permittivity": 11.45},
                {"name": "aluminum", "role": "superconductor", "conductivity_s_per_m": 3.5e7},
            ],
            "ports": [{"name": "readout_top", "kind": "terminal", "target": "readout_top"}],
        },
        "artifacts": [{"name": "server_q3d-q3d-capacitance.json", "text": "{}\n"}],
    }


def _json_request(method: str, url: str, payload: dict[str, object] | None = None) -> dict[str, object]:
    data = json.dumps(payload, sort_keys=True).encode() if payload is not None else None
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=data, headers=headers, method=method)
    with request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode())


def test_job_store_persists_request_and_fake_result(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "runner")
    backend = FakeSolverBackend(store)

    submitted = backend.submit(_simulation_payload())
    status = backend.status(submitted["job_id"])
    result = backend.result(submitted["job_id"])

    assert submitted["status"] == "submitted"
    assert status["status"] == "solved"
    assert result["solver"] == "q3d_capacitance"
    assert (tmp_path / "runner" / submitted["job_id"] / "request.json").exists()
    assert (tmp_path / "runner" / submitted["job_id"] / "result.json").exists()


def test_http_solver_runner_accepts_existing_remote_client(tmp_path: Path) -> None:
    with SolverRunnerServer(work_dir=tmp_path / "runner") as server:
        submitted = _json_request("POST", f"{server.url}/jobs", _simulation_payload())
        status = _json_request("GET", f"{server.url}/jobs/{submitted['job_id']}")
        result = _json_request("GET", f"{server.url}/jobs/{submitted['job_id']}/result")

    assert submitted["status"] == "submitted"
    assert status["status"] == "solved"
    assert result["job_id"] == submitted["job_id"]
    assert result["backend"] == "ansys_q3d"


def test_solver_runner_tree_does_not_import_design_client() -> None:
    root = Path(__file__).resolve().parents[1]
    python_files = [*root.joinpath("src").rglob("*.py"), *root.joinpath("tests").rglob("*.py")]

    offenders = [
        str(path.relative_to(root))
        for path in python_files
        if "pi_" + "chip_design" in path.read_text()
    ]

    assert offenders == []
