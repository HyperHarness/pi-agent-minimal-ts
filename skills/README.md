# Worker Skills

This directory contains repository-local prompt modules for isolated agent workers.

Each worker owns its own skill namespace:

```text
skills/<worker-role>/<skill-name>/prompt.md
skills/<worker-role>/<skill-name>/ATTRIBUTION.md
```

The current runtime exposes `load_paper_writing_skill` to the `paper-writing-worker` boundary. It loads modules from `skills/paper-writing-worker/<skill-name>/prompt.md`, defaulting to `sciwrite`.

Keep skills here when they describe worker behavior. Keep manuscript drafts, figures, claims, and paper-specific notes under `paper-projects/`.
