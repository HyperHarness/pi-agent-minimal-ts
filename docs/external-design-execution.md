# Default-off external design execution adapter

This is a local implementation against public `HyperHarness/pi-agent-minimal-ts`
commit `3be8d53f975e771a32141de443d046303a727d2a`, tree
`890fe2270890556d16936a4e658b859e2a6c35a5`. The actual adapted/deployed candidate
for agentd #108 is unknown. This directory is a separate source snapshot, not a
modification or validation of that deployed candidate. `SOURCE_MANIFEST.json`
and `SOURCE_ADDITIONAL_MANIFEST.json` record fetched Git blob identities.

## Selection and authority

The default remains the existing `self-sandbox` implementation, including the
actual bwrap command and existing containment tests. There is no environment
variable, container detector, bwrap-failure fallback, or LLM tool parameter that
selects external mode or disables isolation.

A reviewed trusted startup module may explicitly construct
`createAgentdDesignExecution(configuration)` and pass the resulting opaque
object as `ToolDependencies.designScriptExecution` to `createTools` or
`createToolsForBoundary`. Ordinary callback objects, deserialized copies, and
objects merely claiming `mode: "external-agentd"` are rejected. Factory objects
and their copied limits are frozen. One backend has at most one active local
call; the controller independently owns admission and lifecycle limits.

Configuration supplies a fixed absolute canonical Python interpreter and its SHA-256, fixed
controller-mounted helper path and SHA-256, independent capability SHA-256, all mandatory protocol limits,
and a transport-response timeout. No arbitrary arguments, shell, inherited
environment, mounts, host output paths or namespace options are accepted.
The intended helper mount is `/run/agentd-design-client.py`. It is opened
without following symlinks, read with byte/identity bounds, hashed, and the same
held descriptor is executed as `/proc/self/fd/4 -I -S /proc/self/fd/3 --stdio`.
The independently pinned interpreter is also held and executed through fd4.

The optional `loadReviewedAgentdDesignExecution(pins)` /
`runReviewedAgentdDesignAgent(pins, options)` entrypoint reads only the fixed
`/run/agentd-design-client.json` document. Pins come from independent reviewed
launch-module code constants: interpreter path/hash, helper hash and capability
hash. The document cannot choose or authorize its own helper or interpreter. A
fixed stdlib bootstrap under the already-pinned interpreter checks the config
and helper are ordinary read-only mounts using `fstatvfs(ST_RDONLY)`; closed
document fields must match those independent pins. Nothing invokes this loader
automatically. The programmatic `design-agent.main` and profile resolver accept
the trusted backend; CLI and environment parsing do not. Other profiles/routed
worker overrides and context workspace changes fail closed for external tools.

The interpreter, helper and its runtime must be immutable reviewed controller
mounts. A candidate-supplied executable/path/digest is not startup authority.
A digest proves bytes, not authority or operating-system containment. The
production helper independently requires the fixed read-only controller proof
and socket, an outside-namespace live peer, and the original sealed read-only
controller proof descriptor before transmitting input. No endpoint means an
`environment_unverified` transport failure. There is never local script exec.

## Input and root runtime semantics

The wire version is `agentd-design-exec/1`. Inputs are bounded immutable bytes,
canonical design-code-relative file/entry/output paths, an explicit runner,
exact file hashes, a root-entry declaration, and a bounded log request.
All counts/bytes/depth limits are mandatory frozen-setup configuration; compiled
ceilings only protect parsers and do not grant capability. The controller must
independently validate the complete request and frozen policy.

The project preserves discovery of the parent workspace `.venv/bin/python`,
the existing missing-root error, and the displayed root-relative command.
It reads the exact selected root entry and transmits bounded bytes/hash with no
host path. A legitimate selected root-runtime symlink may resolve to its entry;
this exception never applies to design inputs. A nested design-code `.venv`
cannot replace the selected parent entry. The controller must either match the
reviewed runtime binding or execute an explicitly configured fixture entry as
untrusted bytes inside the isolated call. A shell shim is never substituted with
another interpreter to make a test pass, nor is it executed in the calling
process. KLayout carries no Python root entry and requires its own controller
runtime binding.

Registered entry matching proves executable bytes only. Identical Python
binaries in different virtual environments do not establish identical
`pyvenv.cfg`, site packages, shared libraries, or environment semantics. Exact
fixture-shim bytes are preserved; registered runtime/package compatibility
still needs qualification against the actual candidate. No full runtime-tree
pin or runtime scratch disk-quota guarantee is introduced.

Design input symlinks, hardlinks, special files, changing file identities,
noncanonical paths, Unicode control/unsupported categories, `.git` components,
file/directory output conflicts and exceeded limits are rejected. Source
traversal uses held directory descriptors and bounded directory iteration.
`.git` trees are omitted as before. Files-only v1 cannot represent empty
directories; they are omitted from the submitted tree. Client source traversal
conservatively counts visited empty directories against its directory bound.
Scripts depending on pre-existing empty directories require adaptation or a
future reviewed protocol revision.

The input bytes are a submitted immutable envelope. They are not a
controller-attested snapshot of an entire concurrently changing live workspace.
The controller must revalidate runtime/selection bindings after its own freeze.
Canonical JSON uses fixed ASCII keys, compact separators and UTF-8 Unicode;
manifest paths sort by UTF-8 bytes, not JavaScript UTF-16 or locale ordering.
Shared Unicode fixtures include accented, BMP and astral filenames.

## Result, failure and publication

Only a response from the configured authenticated helper is considered, and
its request ID/digest, input manifest/root digest, boundary, closure and exact
output set are validated again. The JSON closure booleans are consistency
checks; they are not independent proof. Successful results require exit zero,
network none, call-private writes, nested user namespaces disabled, reaped
launcher, stopped descendants, frozen outputs and exact output hashes/sizes.
Combined stdout plus stderr is bounded by the request's Unicode codepoint cap.
Every non-completed state publishes no outputs. Disconnects, helper errors and
timeouts never cause automatic retry or fallback. A new explicit invocation
gets a new ID; controller idempotency/recovery is separate from this client.
Failure diagnostics retain both labeled stdout and stderr after validating
their combined bound; empty logs retain a no-publication diagnostic.

All declared destination paths are preflighted before replacing any output.
Publication uses directory descriptors, no-follow traversal, exclusive temporary
files, and per-file rename. Named parent chains are revalidated before writing,
before renaming and after publication. If publication fails, the error lists the
already published paths; multi-file publication is not claimed atomic.

These checks do not make a hostile concurrently resumed caller workspace safe.
A malicious writer can still move directories or swap temporary entries between
checks. The controller-frozen manifest is authoritative; resumed harness files are
mutable and are not containment evidence. Chain checks detect many races and
publication reports partial failures. A protected writer or exclusive phase is
needed only for a stronger hostile-concurrency-safe or atomic publication claim,
not for this baseline-equivalent controller script-isolation feature.

The helper response timeout has at most 30 seconds of transport grace (maximum
150 seconds); this does not enlarge the controller script limit of 120 seconds.
The script timeout/cancellation and descendant cleanup belong to the external
controller. The Node/helper watchdog is only a transport diagnostic and may be
paused with a frozen harness; its expiry cannot prove the script stopped.
A real activation must account for controller execution, cleanup and result
handoff deadlines independently of paused caller timers.

The controller conservatively retains protected evidence and
`process_stopped=false` if fixed topology preparation succeeds but
lifecycle/supervisor startup fails. There is no durable no-launch-abort
authority; operator-reviewed recovery is required. Ambiguous pre-join launch
without exact process ownership likewise remains recovery-required.

## Verification lanes

- `npm run build`: exact lockfile TypeScript build.
- `npm run test:design:external-contract`:
  immutable request, cross-language hashing, bounded I/O, forged bindings,
  unsafe inputs/outputs, no fallback, root selection and project seams.
- `npm run test:design:cross-language -- /absolute/agentd/source` is a separate,
  explicit interoperability lane. It runs actual compiled TS request/transport,
  Python request parsing/staging/supervisor/lifecycle/output freezing,
  Python client response validation, and TS validation/publication. Kernel,
  process, admission and startup authority are test-only synthetic adapters;
  there is no socket, live cgroup, or submitted code execution. It covers
  binary/Unicode outputs, mixed/empty failure logs and combined-log overflow.
  The ordinary project suites do not auto-discover an agentd checkout.
- `npm run test:design:standalone` runs the original five tool cases and the
  additional `test/agent/design-script-containment.test.ts`, which requires an actually started
  bwrap script, three attempted/denied writes to original package/wiki/root-venv
  files, and a declared output marker. Namespace startup failure fails this test.
- Original `test/agent/tools.test.ts` containment cases remain unchanged and
  execute the actual self-sandbox implementation. A namespace startup failure
  is an environment qualification blocker, not a containment pass. In
  particular, the old absolute-parent test accepts an error containing bwrap;
  its pass alone proves no launched-script isolation.
- `npm test`: the package-script project suite, overlapping the focused lanes.
  Recursive discovery additionally includes tests omitted by its shell glob.

All external positive tests use a clearly labeled synthetic helper which does
not authenticate a controller or execute the design script/root shim. They
prove data contracts, routing, and synthetic state-machine interoperability, never Linux namespaces, resource
accounting, shared admission, descendant cleanup, runtime equivalence, or a
managed integration receipt. Actual controller, OS boundary, topology and exact-candidate full-lane
qualification remain required before
activation. No deployment, host setup, resource change or paid model invocation
is part of this implementation.
