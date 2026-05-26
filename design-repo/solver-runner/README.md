# PI Solver Runner

`pi-solver-runner` is the server-side companion for `pi-chip-design` remote simulation jobs.
It is intended to run on a Windows workstation or simulation server while the
agent and `pi-chip-design` client may run from WSL, Linux, macOS, or another host.

For Windows deployment, see [WINDOWS_DEPLOYMENT.md](WINDOWS_DEPLOYMENT.md).

The runner exposes the same minimal HTTP protocol used by the WSL/client-side design package:

- `POST /jobs`
- `GET /jobs/{job_id}`
- `GET /jobs/{job_id}/result`

The current backend is a deterministic fake solver for protocol and deployment testing. Real
Ansys/PyAEDT or server-side solver integrations should implement the same backend methods:

- `submit(payload) -> {"job_id": "...", "status": "submitted"}`
- `status(job_id) -> {"job_id": "...", "status": "...", "solver": "...", "backend": "..."}`
- `result(job_id) -> normalized result JSON`

```powershell
cd C:\path\to\solver-runner
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\pi-solver-runner.exe --host 127.0.0.1 --port 17890 --work-dir .\jobs
```

After installation, Windows users can also start the service with:

- `run_solver_runner_visible.bat` for a foreground console.
- `run_solver_runner_background.bat` for a background process with logs under `logs\`.
- `stop_solver_runner_background.bat` to stop a process listening on the default `17890` port.
