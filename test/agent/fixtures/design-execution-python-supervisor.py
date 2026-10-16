"""TEST ONLY: real wire/lifecycle/IO with synthetic kernel and process adapters.

The explicit cross-language runner prepends SETTINGS. No controller endpoint,
OS sandbox, admission, cgroup or submitted executable is created or exercised.
This fixture must never be used as a production execution helper.
"""
# ruff: noqa: E402 -- Test-only package setup must precede stdlib module imports.
import base64
import hashlib
import json
import sys
import tempfile
import threading
import types
from pathlib import Path

SETTINGS = globals()["SETTINGS"]  # Prepended by the test runner, never ENV.

# Load only the stdlib execution modules, not agentd's application __init__.
package = types.ModuleType("agentd")
package.__path__ = [str(Path(SETTINGS["agentd_source"]) / "agentd")]
sys.modules["agentd"] = package
from agentd import design_execution_client as client
from agentd import design_execution_supervisor as supervisor
from agentd.design_execution_contracts import canonical_json_bytes, parse_execution_request
from agentd.design_execution_io import stage_inputs
from agentd.design_execution_lifecycle import (
    CgroupIdentity, DesignExecutionLifecycle, FileJournal, LauncherIdentity,
    StageIdentity, StageLimits, StageTopology,
)
from agentd.design_execution_policy import ReviewedDesignPolicy
from agentd.design_execution_transport import create_design_directory


class SyntheticKernel:
    def __init__(self):
        self.frozen = self.running = self.stopped = False
        self.events = []

    def verify(self, **_kwargs):
        self.events.append("verify")

    def assert_script_empty(self):
        assert not self.running

    def freeze_harness(self):
        self.frozen = True
        self.events.append("freeze")

    def thaw_harness(self):
        assert not self.running
        self.frozen = False
        self.events.append("thaw")

    def stop_script(self):
        self.running = False
        self.events.append("stop-script")

    def stop_all(self, **_kwargs):
        self.running = False
        self.stopped = True

    def assert_stage_empty(self):
        assert self.stopped

    def remove_fixed_children(self):
        assert self.stopped


class SyntheticProcess:
    def __init__(self, *, config, directory_fd, topology, policy):
        self.directory_fd, self.policy = directory_fd, policy
        self.request = self.staged = self.launcher = None
        self.reaped = False

    def bind_request(self, request):
        self.request = request

    def spawn(self, call):
        assert controller.kernel.frozen
        assert controller.journal.read()["calls"][self.request.request_id]["state"] == "launch_intent"
        self.staged = stage_inputs(self.request, parent_fd=self.directory_fd, limits=self.policy.limits)
        root = Path("/proc/self/fd") / str(self.staged.design_code_fd)
        for member in self.request.files:
            assert (root / member.path).read_bytes() == member.data
        assert (Path("/proc/self/fd") / str(self.staged.root_fd) / "root_entry.bin").read_bytes() == self.request.root_entry.data
        # These bytes are synthetic output. Never interpret/execute the script.
        script_bytes = (root / self.request.script_path).read_bytes()
        for relative in self.request.output_paths:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"\0\xfffixture:" + script_bytes + b":" + relative.encode())
        self.launcher = LauncherIdentity(4242, 123, "11111111-1111-4111-8111-111111111111")
        controller.kernel.running = True
        controller.kernel.events.append("synthetic-spawn")
        return self.launcher

    def observe(self, *, cancelled):
        assert not cancelled()
        return SETTINGS["status"], 0 if SETTINGS["status"] == "completed" else 7

    def stop_and_reap(self, launcher):
        assert launcher == self.launcher
        self.reaped = True
        controller.kernel.events.append("reap")
        return True

    def logs_after_closure(self):
        assert self.reaped and not controller.kernel.running
        call = controller.journal.read()["calls"][self.request.request_id]
        assert call["closure"]["script_empty"] is True
        controller.kernel.events.append("logs-after-closure")
        return SETTINGS["stdout"], SETTINGS["stderr"]

    def retain_and_close_descriptors(self):
        if self.staged is not None:
            self.staged.retain()
            self.staged.close()


assert sys.argv[1:] == ["--stdio"]
policy = ReviewedDesignPolicy(SETTINGS["policy"], pins=SETTINGS["pins"])
raw = sys.stdin.buffer.read(policy.limits.max_request_bytes + 1)
request = parse_execution_request(raw, limits=policy.limits)
assert raw == canonical_json_bytes(json.loads(raw))
with tempfile.TemporaryDirectory(prefix="design-cross-language-") as temporary:
    root = Path(temporary)
    allocation = root / "allocation"
    (allocation / "agentd_fixture/harness").mkdir(parents=True)
    (allocation / "agentd_fixture/script").mkdir()

    def identity(path):
        info = path.stat()
        return CgroupIdentity(str(path), info.st_dev, info.st_ino)

    topology = StageTopology(*(identity(path) for path in (
        allocation, allocation / "agentd_fixture", allocation / "agentd_fixture/harness",
        allocation / "agentd_fixture/script")), StageLimits(1024 * 1024, 100000, 64))
    controller = object.__new__(supervisor.DesignExecutionSupervisor)
    controller.stopping = threading.Event()
    controller._dispatch_gate = threading.Lock()
    controller._accepting, controller._fatal, controller._seen = True, None, {}
    controller.stage = StageIdentity("cross-language-fixture", "check", "fixture-launch")
    controller.topology, controller.policy = topology, policy
    controller.directory = create_design_directory(root)
    controller.journal = FileJournal(controller.directory.path / "lifecycle.json")
    controller.kernel = SyntheticKernel()
    controller.config = {"base_command": [], "runtime_fds": []}
    controller.response_limit = 128 * 1024
    controller._assert_live_lease = lambda: None  # Explicit synthetic admission only.
    supervisor.CallProcess = SyntheticProcess
    controller.processes = supervisor._ProcessOwners(controller.config, controller.directory.fd, topology, policy)
    controller.lifecycle = DesignExecutionLifecycle(stage=controller.stage, topology=topology,
        journal=controller.journal, kernel=controller.kernel, processes=controller.processes,
        max_calls=policy.max_calls, create=True)
    try:
        try:
            response = controller._dispatch(request)
        except supervisor.FatalCollectorError as error:
            assert SETTINGS["name"] == "combined log overflow"
            assert isinstance(error.__cause__, supervisor.SupervisorUnverified)
            assert "combined request bound" in str(error.__cause__)
            assert controller.stopping.is_set() and not controller._accepting
            Path(SETTINGS["capture_path"]).write_text(json.dumps({
                "rejection": str(error.__cause__), "outputs_published": False,
                "gate_closed": True, "events": controller.kernel.events,
            }))
            raise
        proof = {"protocol": "agentd-design-exec/1", "run_id": controller.stage.run_id,
                 "parent_launch_token": controller.stage.launch_token, "capability_sha256": policy.digest,
                 "topology_sha256": hashlib.sha256(canonical_json_bytes(topology.document())).hexdigest(),
                 "limits": SETTINGS["policy"]["limits"], "call_timeout_seconds": policy.timeout_seconds}
        client.verify_result(response, json.loads(raw), proof)
        events = controller.kernel.events
        assert events.index("freeze") < events.index("synthetic-spawn") < events.index("reap")
        assert events.index("reap") < events.index("stop-script") < events.index("logs-after-closure")
        # Persist the actual exchanged bytes for the cross-language assertions.
        Path(SETTINGS["capture_path"]).write_text(json.dumps({
            "request_base64": base64.b64encode(raw).decode(), "response": response, "proof": proof,
            "events": events, "input_manifest_sha256": request.input_manifest_sha256,
            "request_sha256": hashlib.sha256(raw).hexdigest(),
        }, ensure_ascii=False))
        controller.lifecycle.close()
        sys.stdout.buffer.write(canonical_json_bytes(response))
    finally:
        controller.processes.close_descriptors()
        controller.directory.close()
