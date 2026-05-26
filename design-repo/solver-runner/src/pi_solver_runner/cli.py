"""Command-line entrypoint for the solver runner."""

from __future__ import annotations

import argparse

from pi_solver_runner.server import SolverRunnerServer


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17890)
    parser.add_argument("--work-dir", default="jobs")
    args = parser.parse_args()

    server = SolverRunnerServer(work_dir=args.work_dir, host=args.host, port=args.port)
    print(f"pi-solver-runner listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
