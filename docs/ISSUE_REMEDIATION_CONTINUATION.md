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
