"""HTTP server for remote solver jobs."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any

from pi_solver_runner.backends.fake import FakeSolverBackend
from pi_solver_runner.storage import JobStore


class SolverRunnerServer:
    """Threaded HTTP server for the solver-runner protocol."""

    def __init__(
        self,
        *,
        work_dir: str | Path,
        host: str = "127.0.0.1",
        port: int = 0,
        backend: FakeSolverBackend | None = None,
    ) -> None:
        self.work_dir = Path(work_dir)
        self.host = host
        self.port = port
        self.store = JobStore(self.work_dir)
        self.backend = backend or FakeSolverBackend(self.store)
        self.server: ThreadingHTTPServer | None = None
        self.thread: Thread | None = None

    @property
    def url(self) -> str:
        if self.server is None:
            raise RuntimeError("server is not started")
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def __enter__(self) -> "SolverRunnerServer":
        self.start()
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.stop()

    def start(self) -> None:
        backend = self.backend

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if self.path != "/jobs":
                    self._send_json(404, {"error": "not_found"})
                    return
                try:
                    self._send_json(200, backend.submit(self._read_json()))
                except Exception as exc:  # pragma: no cover - defensive boundary
                    self._send_json(500, {"error": str(exc)})

            def do_GET(self) -> None:
                parts = self.path.strip("/").split("/")
                try:
                    if len(parts) == 2 and parts[0] == "jobs":
                        self._send_json(200, backend.status(parts[1]))
                        return
                    if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "result":
                        self._send_json(200, backend.result(parts[1]))
                        return
                    self._send_json(404, {"error": "not_found"})
                except FileNotFoundError:
                    self._send_json(404, {"error": "job_not_found"})

            def log_message(self, format: str, *args: object) -> None:
                return

            def _read_json(self) -> dict[str, Any]:
                content_length = int(self.headers.get("Content-Length", "0"))
                return json.loads(self.rfile.read(content_length).decode())

            def _send_json(self, status: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload, sort_keys=True).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer((self.host, self.port), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.server = None
        if self.thread is not None:
            self.thread.join(timeout=5)
            self.thread = None

    def serve_forever(self) -> None:
        self.server = ThreadingHTTPServer((self.host, self.port), self._make_handler())
        try:
            self.server.serve_forever()
        finally:
            self.server.server_close()

    def _make_handler(self) -> type[BaseHTTPRequestHandler]:
        backend = self.backend

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if self.path != "/jobs":
                    self._send_json(404, {"error": "not_found"})
                    return
                self._send_json(200, backend.submit(self._read_json()))

            def do_GET(self) -> None:
                parts = self.path.strip("/").split("/")
                if len(parts) == 2 and parts[0] == "jobs":
                    self._send_json(200, backend.status(parts[1]))
                    return
                if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "result":
                    self._send_json(200, backend.result(parts[1]))
                    return
                self._send_json(404, {"error": "not_found"})

            def log_message(self, format: str, *args: object) -> None:
                return

            def _read_json(self) -> dict[str, Any]:
                content_length = int(self.headers.get("Content-Length", "0"))
                return json.loads(self.rfile.read(content_length).decode())

            def _send_json(self, status: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload, sort_keys=True).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return Handler
