# Windows Deployment Guide for PI Solver Runner

This guide is written for a Codex agent running on Windows. Follow it from the repository root.

`pi-solver-runner` is the server-side process for remote simulation jobs. It can run on a
Windows workstation with Ansys AEDT installed, or on a shared simulation server. The WSL-side
or Linux-side `pi-chip-design` package submits simulation manifests to this service over HTTP.

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

## 2. Enter the Repository

Open PowerShell and move to the Windows checkout:

```powershell
cd C:\path\to\pi-agent-minimal-ts
```

Confirm the expected files exist:

```powershell
Test-Path .\design-repo\solver-runner\pyproject.toml
Test-Path .\design-repo\design-code\pyproject.toml
```

Both commands should print `True`.

## 3. Create the Python Environment

Use a repository-root virtual environment so the runner and design client can be tested together.

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .\design-repo\solver-runner
```

For full integration tests with the existing WSL/client package, also install `pi-chip-design`:

```powershell
.\.venv\Scripts\python.exe -m pip install -e .\design-repo\design-code
.\.venv\Scripts\python.exe -m pip install pytest ruff
```

If dependency installation fails inside Codex because network access is restricted, ask for
network permission and rerun the same commands.

## 4. Validate the Runner Package

Run the runner tests:

```powershell
.\.venv\Scripts\python.exe -m pytest .\design-repo\solver-runner\tests -q
```

Expected result:

```text
2 passed
```

Run lint:

```powershell
.\.venv\Scripts\python.exe -m ruff check .\design-repo\solver-runner\src .\design-repo\solver-runner\tests
```

Expected result:

```text
All checks passed!
```

## 5. Start the Solver Runner

For local-only validation on Windows:

```powershell
.\.venv\Scripts\pi-solver-runner.exe `
  --host 127.0.0.1 `
  --port 17890 `
  --work-dir .\design-repo\solver-runner\jobs
```

For access from WSL or another machine on the LAN, bind to all interfaces:

```powershell
.\.venv\Scripts\pi-solver-runner.exe `
  --host 0.0.0.0 `
  --port 17890 `
  --work-dir .\design-repo\solver-runner\jobs
```

The server should print:

```text
pi-solver-runner listening on http://0.0.0.0:17890
```

Keep this PowerShell window open while testing.

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

With the server running, open a second PowerShell in the repository root and run:

```powershell
$env:PYTHONPATH = "$PWD\design-repo\design-code\src"
.\.venv\Scripts\python.exe -m pi_chip_design.layouts.submit_ten_qubit_q3d_remote `
  --solver-url http://127.0.0.1:17890
```

Expected output:

```text
Wrote ...\design-repo\design-records\simulations\ten_qubit_chip-q3d-capacitance.remote.json
Wrote ...\design-repo\design-records\simulations\job-000001.results.json
```

The runner should also create:

```text
design-repo\solver-runner\jobs\job-000001\request.json
design-repo\solver-runner\jobs\job-000001\result.json
design-repo\solver-runner\jobs\job-000001\artifacts\
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
design-repo\solver-runner\jobs
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

If tests fail with missing `pi_chip_design`:

```powershell
.\.venv\Scripts\python.exe -m pip install -e .\design-repo\design-code
```

If tests fail with missing `pytest` or `ruff`:

```powershell
.\.venv\Scripts\python.exe -m pip install pytest ruff
```
