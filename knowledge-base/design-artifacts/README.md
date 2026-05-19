# Design Artifact Workspace

This directory stores design-subagent experiment code, generated layouts, logs, and result files that should remain inside the local knowledge base.

## Path Contract

Use one stable experiment key per design attempt:

```text
knowledge-base/design-artifacts/<experiment-key>/
  code/       # runnable scripts, notebooks, and small helper modules
  layouts/    # generated layout data, including GDS/OAS/DXF
  logs/       # tool stdout/stderr, DRC/LVS/simulation logs
  results/    # extracted metrics, reports, screenshots, and derived tables
  README.md   # optional human handoff for larger experiments
```

Each searchable experiment should also have a source summary:

```text
knowledge-base/sources/design-artifact-<experiment-key>/summary.md
knowledge-base/manifests/design-artifact-<experiment-key>.json
```

The source summary is the wiki-agent retrieval surface. Keep large binary layout files in `design-artifacts/`, and point to them from the manifest `artifacts` list.
