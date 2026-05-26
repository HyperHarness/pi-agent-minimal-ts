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

```sh
PYTHONPATH=design-repo/solver-runner/src .venv/bin/python -m pi_solver_runner.cli \
  --host 127.0.0.1 \
  --port 17890 \
  --work-dir design-repo/solver-runner/jobs
```
