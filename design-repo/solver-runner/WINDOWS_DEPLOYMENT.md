# Windows Deployment Guide for PI Solver Runner

This guide is written for a Codex agent running on Windows. Follow it from the
`design-repo\solver-runner` directory. The folder can be deployed by itself.

`pi-solver-runner` is the server-side process for remote simulation jobs. It can run on a
Windows workstation with Ansys AEDT installed, or on a shared simulation server. The runner
is self-contained: deployment only needs the files under `design-repo\solver-runner`.
Client packages such as `pi-chip-design` submit simulation manifests to this service over HTTP,
but they do not need to be installed on the solver machine.

The current backend is a deterministic fake backend. It validates the deployment, protocol,
job storage, and client/server wiring before a real Ansys/PyAEDT backend is enabled.

## 1. Prerequisites

Required:

- Windows 10 or Windows 11.
- PowerShell 7 or Windows PowerShell.
- Python 3.11 available as `py -3.11`.
- The `pi-agent-minimal-ts` repository checked out on Windows.

Recommended:

- `uv` installed and available on `PATH`.
- Ansys AEDT installed only if you are preparing to add a real Ansys backend. The fake backend
  does not require Ansys.

## 2. Enter the Runner Directory

Open PowerShell and move to the solver-runner directory:

```powershell
cd C:\path\to\solver-runner
```

Confirm the expected files exist:

```powershell
Test-Path .\pyproject.toml
Test-Path .\src\pi_solver_runner\server.py
```

Both commands should print `True`.

## 3. Create the Python Environment

Use a repository-root virtual environment for the runner.

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m pip install pytest ruff
```

If dependency installation fails inside Codex because network access is restricted, ask for
network permission and rerun the same commands.

## 4. Validate the Runner Package

Run the runner tests:

```powershell
.\.venv\Scripts\python.exe -m pytest .\tests -q
```

Expected result:

```text
2 passed
```

Run lint:

```powershell
.\.venv\Scripts\python.exe -m ruff check .\src .\tests
```

Expected result:

```text
All checks passed!
```

## 5. Start the Solver Runner

After installation, the simplest Windows path is to double-click one of these files:

```text
run_solver_runner_visible.bat
run_solver_runner_background.bat
stop_solver_runner_background.bat
```

The start scripts prefer the local `solver-runner\.venv` environment. On first run, they call
`bootstrap_solver_runner.bat` to create `.venv` and install the runner from the copied folder.
They also keep a compatibility fallback for a parent repository `.venv` when the runner is used
inside the full source checkout. The stop script looks for a process listening on the default
TCP port `17890` and terminates it.

For local-only validation on Windows:

```powershell
.\.venv\Scripts\pi-solver-runner.exe `
  --host 127.0.0.1 `
  --port 17890 `
  --work-dir .\jobs
```

For access from WSL or another machine on the LAN, bind to all interfaces:

```powershell
.\.venv\Scripts\pi-solver-runner.exe `
  --host 0.0.0.0 `
  --port 17890 `
  --work-dir .\jobs
```

The server should print:

```text
pi-solver-runner listening on http://0.0.0.0:17890
```

Keep this PowerShell window open while testing.

To stop a background runner started on the default port, double-click:

```text
stop_solver_runner_background.bat
```

The stop script is intentionally port-based. If you started the runner with a non-default port,
stop that process manually or update the `PORT` value inside the script.

## 6. Allow Windows Firewall Access

If the WSL or remote client cannot connect, add a local firewall rule from an elevated PowerShell:

```powershell
New-NetFirewallRule `
  -DisplayName "PI Solver Runner 17890" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 17890
```

Only do this on a trusted private network. For public or shared networks, bind to a specific
private interface address instead of `0.0.0.0`.

## 7. Test from the Windows Side

With the server running, open a second PowerShell and submit a minimal smoke-test request:

```powershell
$body = @{
  spec = @{
    name = "windows-smoke-q3d-capacitance"
    solver = "q3d_capacitance"
    backend = "ansys_q3d"
    layout = @{
      name = "windows_smoke"
      shape_count = 1
      layers = @(10)
      rectangles = 1
      paths = 0
      labels = 0
    }
    materials = @(@{ name = "silicon"; role = "substrate"; relative_permittivity = 11.45 })
    ports = @(@{ name = "readout"; kind = "terminal"; target = "readout_trace" })
  }
  artifacts = @(@{ name = "windows-smoke.json"; text = "{}" })
} | ConvertTo-Json -Depth 8

$submitted = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:17890/jobs -ContentType "application/json" -Body $body
$submitted
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:17890/jobs/$($submitted.job_id)"
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:17890/jobs/$($submitted.job_id)/result"
```

Expected output includes:

```text
job_id : job-000001
status : solved
solver : q3d_capacitance
backend: ansys_q3d
```

The runner should also create:

```text
jobs\job-000001\request.json
jobs\job-000001\result.json
jobs\job-000001\artifacts\
```

## 8. Test from WSL

Start the runner on Windows with `--host 0.0.0.0`.

From WSL, find the Windows host address:

```sh
ip route | awk '/default/ {print $3}'
```

Then run the client from the WSL repository checkout:

```sh
WINDOWS_HOST="$(ip route | awk '/default/ {print $3}')"
.venv/bin/python -m pi_chip_design.layouts.submit_ten_qubit_q3d_remote \
  --solver-url "http://${WINDOWS_HOST}:17890"
```

Expected result: WSL writes a `.remote.json` and `.results.json`, while the Windows runner writes
the corresponding `jobs/job-00000*/` request and result files.

## 9. Operational Notes

Use a persistent work directory:

```text
jobs
```

This directory is intentionally ignored by Git. It stores submitted requests, artifacts, and
results. Do not store generated job directories in source control.

For a long-running workstation deployment, run the command in a persistent terminal, Windows
Terminal profile, scheduled task, or service wrapper. Keep the initial deployment simple until
the fake backend and WSL client connectivity are confirmed.

## 10. Future Ansys Backend

The fake backend is intentionally small. A real Windows Ansys backend should implement the same
backend methods used by `FakeSolverBackend`:

```python
submit(payload) -> {"job_id": "...", "status": "submitted"}
status(job_id) -> {"job_id": "...", "status": "...", "solver": "...", "backend": "..."}
result(job_id) -> normalized result JSON
```

That real backend should own:

- Starting or connecting to AEDT/PyAEDT.
- Translating the submitted manifest and artifacts into Q3D or HFSS setup objects.
- Managing license, queue, and retry behavior.
- Writing raw AEDT artifacts under the job directory.
- Producing a normalized `result.json` for the WSL/client agent.

The WSL/client package should not need to know Windows paths, AEDT versions, license details,
or server queue behavior.

## 11. Troubleshooting

If `pi-solver-runner.exe` is not found:

```powershell
.\.venv\Scripts\python.exe -m pi_solver_runner.cli --help
```

If WSL cannot connect:

- Confirm the runner used `--host 0.0.0.0`.
- Confirm Windows Firewall allows TCP port `17890`.
- Confirm WSL is using the Windows host IP from `ip route`.
- Test from Windows first with `http://127.0.0.1:17890`.

If tests fail with missing `pytest` or `ruff`:

```powershell
.\.venv\Scripts\python.exe -m pip install pytest ruff
```
