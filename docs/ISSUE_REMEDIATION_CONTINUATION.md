# Issue remediation continuation

The integration branch retains the existing issue #3–#36 fixes, the reviewed
public-URL candidate, and the current mainline design-agent disablement. Preserve
unrelated user drafts in the original workspace.

## Current batch: complete test discovery (#7)

The published npm test command must discover every compiled TypeScript test and
every source `.test.mjs`, including `test/browser-extension`. Keep recursive glob
arguments quoted for npm shells. Do not change dependency versions, restore
design execution, or remove existing assertions.

Acceptance: verify discovery against the actual recursive test inventory, retain
root and deeply nested suite coverage, run the complete offline suite, and inspect
a clean npm package build. Independent service checks and review remain separate
from worker statements. Close each issue after its validated fix is delivered.

## Review follow-ups (#6 and #20)

Handle recognized attachment-start errors during challenge retry navigation using
the existing download-event path. Preserve unrelated navigation failures and
missing-download timeouts. Cover the combined challenge/download sequence.

Open candidate PDF files without blocking on a FIFO before checking the opened
descriptor's file type. Preserve workspace containment, nofollow, Linux descriptor
path checks and size limits. Exercise a real FIFO without a writer in a bounded
test subprocess and clean up its fixtures.

Keep these repairs in their existing implementation/test files. Each candidate
needs its own independent checks and review before adoption; then verify the
combined version through the actual npm test command and clean package build.
