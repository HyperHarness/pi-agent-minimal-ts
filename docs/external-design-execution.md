# Default-off external design execution adapter

The initial adapter was developed against public `HyperHarness/pi-agent-minimal-ts`
commit `3be8d53f975e771a32141de443d046303a727d2a`. The complete-suite routing
update is based on published PR #38 head
`7c3a69bd7c4c4498cbf19d7d1e905ae3e5ff0d2c`, tree
`b7aeee5a58f0057735067c3b1749c7be00f2160e`. This local source snapshot is not the
owner's integrated candidate. The owner reports actual integrated candidate
`29651fe709eecf0167fd8a0060a0ca14a59ce140`; its extra source/tests are not available
in this snapshot, and its acceptance must be rerun against the newly frozen
candidate rather than inferred from public-repository results.

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

The local offline external contract/callback tests use a clearly labeled synthetic helper which does
not authenticate a controller or execute the design script/root shim. They
prove data contracts, routing, and synthetic state-machine interoperability, never Linux namespaces, resource
accounting, shared admission, descendant cleanup, runtime equivalence, or a
managed integration receipt. Actual controller, OS boundary, topology and exact-candidate full-lane
qualification remain required before
activation. No deployment, host setup, resource change or paid model invocation
is part of this implementation.


## Explicit reviewed complete-suite registration

The owner reports a real service-owned selected pilot of three cases passing at
PR #38 `7c3a69b` with agentd `ba17c32`, but the same integrated candidate's complete
managed run remained **1112/1116**, with four default self-sandbox registrations
failing. Public host **964/964** and integrated host **1116/1116** are separate
observations. These are owner-reported retained results, not new local live
validation: [issue #108 acceptance report](https://github.com/cying22/agentd/issues/108#issuecomment-6218503537)
and [PR #38 report](https://github.com/HyperHarness/pi-agent-minimal-ts/pull/38#issuecomment-6218504890).

The new test-only `registerReviewedDesignScriptFullSuite(pins)` export in
`dist/test/agent/design-script-reviewed-full-suite.js` fills that registration
gap using the existing fixed independent-pin loader/backend. It adds no agentd
schema, protocol, execution subsystem or activation switch. Default/standalone backend selection and original callback bodies/assertions
stay unchanged; the new regression file adds registrations to ordinary discovery. This module is deliberately not a `.test.js` file.

An independently reviewed/pinned owner launch module must be the **sole test
file argument in a fresh process**, after the frozen candidate is built:

```sh
node --test --experimental-test-isolation=none /run/reviewed-full-suite-entry.mjs
```

The owner module imports the new export from that exact frozen candidate,
top-level-awaits it with independent code-constant interpreter/helper/capability
pins, and saves or prints its returned `{ files, mapping }` inventory. Do not run
it alongside the normal recursive glob or preload either mapped test module.
Do not derive pins from candidate content, the client document, arguments or
ENV. No optional loader, importer, root or factory can be supplied to this API.
The loader finishes before any test-file imports. Source discovery and required-module
inventory validation settle before sequential imports begin; exact registration
accounting is then checked after all imports.

Discovery recursively reads every `dist/test/**/*.test.js` and
`test/**/*.test.mjs` in the **actual candidate**, including arbitrarily nested
extra candidate tests and browser-extension MJS tests. It does not use a fixed
public inventory. Missing mapped modules, symlinks in these roots, duplicate
file identities, missing/duplicate/unmatched mapped registrations and already
registered standalone modules fail closed. Each awaited module import has a
private registration scope with its exact URL and an explicit close in `finally`.
Callbacks use factories captured during registration, so inherited async scope
does not become runtime backend-selection authority. There is no exported
context setter or process-global writable backend registry.

Returned file paths and SHA-256s are **registration inventory**, not completion
or pass evidence and not an atomic snapshot of mutable source. The owner's
frozen exact-candidate/read-only-source binding remains required. Compare the
inventory against that candidate's frozen recursive baseline and account for
all extras. Node can start callbacks while later imports await; a late failure
must not count a partial run as success. The entry both rejects and registers an
explicit failing registration test on any entry error. This is necessary because
Node 24 with test isolation disabled can otherwise omit a late entry-import
rejection and exit zero after earlier cases pass. Successful registration adds
no extra test. Preserve final Node exit/TAP totals and real controller receipts
separately; an inventory receipt alone never establishes full acceptance.

### Exact standalone/external mapping

Four explicit mapped registrations retain the original total case count:

1. Parent-root venv selection: reuse the unchanged original callback with the
   verified external factory, preserving nested-venv rejection, exact root-shim
   bytes, command display and declared output assertions.
2. Declared-output isolation: reuse the unchanged original callback with that
   factory, preserving output bytes and absence of undeclared wiki publication.
3. Protected wiki write: replace only the external registration with the accepted
   separately named direct-write B canary. Require exact operation/target ENOENT,
   bound raw script exit 1, verified adapter failure/closure fields, unchanged
   protected tree and no failed-output publication. The original standalone
   callback and its permission/read-only assertions remain unchanged.
4. `standalone actual bwrap proves script start and denied original workspace
   writes`: preserve its callback and errno **13/30** assertions in default mode.
   The separately named external counterpart attempts all three original host
   targets: `package.json`, parent `.venv/bin/python`, and protected wiki file.
   It requires a started marker, exact ordered `Path.write_text` operations and
   **ENOENT for every target**, exact returned error filename/type, exit zero,
   one declared `execution-proof.txt` with neutral external proof content, and
   unchanged original bytes and stable metadata. This proves the expected
   namespace nonvisibility at the application assertion layer, not equivalence
   to read-only-mounted originals. It cannot be replaced by another wiki-only B.

Two additional registrations are explicitly accounted without changing their
bodies: missing-root Python remains prelaunch validation with no submitted call;
absolute-parent workspace write uses the captured external factory. The latter's
legacy broad error regex is insufficient alone, so a case-local guard requires
exactly one call and one provenance-backed script failure with raw exit 1,
exact script/input-manifest/root hashes, final target-bound ENOENT and
reaped/stopped closure with `outputFrozen=false`. Its postcondition runs
**outside** the original callback, so even a swallowed startup, generic or guard
error fails the mapped test. Failed responses cannot publish outputs.

Consequently this mapping requires **five real submitted calls**: three
completed (two original positives and three-target containment) and two raw
script failures (B and parent write). This is an owner-side reviewed budget and
receipt requirement, not an automatic budget/resource-policy change. New
candidate tests may require further accounting. Retain the original total
resource policy and independently verify every call/stage journal, closure and
output receipt. The earlier pilot's reviewed runtime split was client/check
Python **3.14.8** and the fixture shell shim's read-only system Python **3.12.3**;
this update adds no runtime alias or real-venv/KLayout compatibility claim.

### Offline regression evidence and remaining acceptance

The new regression file has 13 local tests for recursive extra-file discovery,
identity/mapping rejection, the three-target counterpart, strict parent-write
postconditions and actual private registration-scope behavior. Scope tests copy
compiled dependencies to a disposable tree, substitute exactly one fixed-loader
import with an explicitly synthetic helper, and record original/transformed
hashes. The shipped API has no test injection hook. They reuse original compiled
parent/preflight callback bodies, require exactly five synthetic requests, and
exercise stale scopes, preloaded modules, missing/duplicate/unsupported mappings,
and late imports. An additional Node test autorun timing case waits for an
explicit synthetic request marker before failing a late import; it is separate
from the owner-command `--test` cases. Every negative entry scenario must return
an actual nonzero subprocess exit, including a caller that catches rejection.
These synthetic Python helpers manufacture transport responses; no submitted
fixture script or root shim, actual bwrap, cgroup, service/controller or full
managed acceptance is exercised.

The accessible public discovery is 71 compiled files plus two source MJS files,
with this one regression file adding 13 registrations to the earlier public
baseline. A separate recording-only discovery observes 977 default registrations;
its callbacks never execute, so this is not a 977-test runtime pass. The integrated candidate has additional tests: never use a fixed
1116 count or this public manifest to exclude them. Record its actual updated
inventory and final totals. The full service-owned rerun, exact runtime/startup
pins and real failure/recovery qualifications remain owner-side acceptance.
