# Issue remediation plan

Scope: all 34 open GitHub issues, #3 through #36, as authorized on 2026-10-15.
Coordinator: mainline Codex. Implementation and independent checks run through
the existing agentd project `pi-agent-minimal-ts`.

## Compatibility and integration

- Fix the reported behavior with focused regression coverage; retain public agent
  boundaries and unrelated behavior.
- Use isolated agentd worktrees and exact file scopes. Preserve existing user files
  and untracked slide artifacts in the main workspace.
- Build and test evidence, independent review, lead adoption, and Git integration
  are distinct steps. A worker report alone does not establish completion.
- Keep network tests deterministic and offline. Do not introduce live model calls
  into acceptance tests.
- Do not publish, merge remote branches, or close issues without validated fixes.

## Batches

| Group | Issues | agentd task |
| --- | --- | --- |
| Literal file editing | #3 | `t_38fc468492cc420b99d238f14a6e1b07` |
| Wiki correctness | #28, #29, #33, #34, #35 | `t_747aa77f62e7454a811dd20995962c77` |
| Acquisition identity and list integrity | #14, #30, #31, #36 | `t_1ca61a32e7ee406391fcddedd78eee4a` |
| Agent model selection, routing and runtime | #5, #10, #11, #17 | `t_2c2d24950293422f84e82aabc2d1363e` |
| Feishu queue, PDF delivery and client lifecycle | #4, #20, #23, #24, #25, #26 | `t_b240308064474ce2b8c75d677f94d08c` |
| Network policy, response limits and downloads | #6, #12, #18, #19, #21, #32 | `t_ef51cc8ff44d42b39d11e561437b3131` |
| Atomic memory and wiki writes | #22, #27 | `t_ce65e805ba524f8e927485749e79a2d4` |
| Packaging, test discovery and benchmark integrity | #7, #8, #9, #13, #15, #16 | `t_f1aa73ac3f164c94bb95787eba0abb98` |

## Acceptance

Each issue requires a reviewed fix and regression evidence. After integrating
the batches, run the complete test suite with recursive discovery, verify package
contents from a clean build, and inspect the combined diff for cross-batch effects.
Record environmental failures separately from code failures; do not relax checks
or isolation to manufacture a passing result.
