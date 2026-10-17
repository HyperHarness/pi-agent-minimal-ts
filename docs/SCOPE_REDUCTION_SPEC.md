# Design execution scope withdrawal

User decision (2026-10-17): disable design-agent and its related tools, then
withdraw the agentd changes introduced to support that execution path.

## Project boundary

- Disable design-agent/design-subagent CLI, programmatic profiles, routed
  workers and all eight dedicated design tools, including full/direct factories.
- Remove PR #38's external-agentd adapter, trusted entry and its exclusive tests.
- Keep wiki/paper/writing workflows and read-only curation of existing artifacts.
- Keep existing design assets, environments, Git history and user drafts.
- Retire tests of the withdrawn capability; replace exposure/entry tests with
  explicit rejection/no-design-tool assertions. Do not skip failing live tests.

## agentd boundary

- Remove #108 per-call design modules, recipe field, supervisor hooks and their
  exclusive tests/docs, including the #113/#119 feature-specific follow-ups.
- Preserve generic schema export/CI and #120's shared stable-peer-identity fix.
- Remove active design recipes from drained acceptance projects through the
  supported versioned policy interface before installing the withdrawn schema.
- Preserve stored task/Run evidence. Unknown legacy execution requiring recovery
  must fail closed and refer to its original release, not silently lose proof.
- Use official reviewed deployment/upgrade flows, never edit SQLite/unit files.

## Acceptance

Build and the complete recursive enabled project suite pass; legacy design
entry points reject before model/network calls; no factory exposes design tools.
agentd relevant regressions, schema generation and historical-result checks pass.
Verify a real ordinary service-owned full-project check without design execution.
Keep model calls and business dispatch paused during this withdrawal.
