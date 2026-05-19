# Single Xmon Concept Layout

This design artifact records a conceptual single-Xmon/transmon chip layout generated with KLayout Python.

## Artifact Paths

- Code: `knowledge-base/design-artifacts/single-xmon-concept/code/single_xmon_concept_klayout.py`
- Layout: `knowledge-base/design-artifacts/single-xmon-concept/layouts/single_xmon_concept.gds`

## Design Content

The script creates a `SINGLE_XMON_CONCEPT` GDS cell with a chip outline, positive-metal ground-plane visualization, horizontal CPW feedline, meandered readout resonator, Xmon/transmon cross capacitor, conceptual Josephson-junction marker, drive line, airbridge markers, and explanatory labels.

## Evidence State

This artifact is useful as local design evidence for layout-generation workflow discussions and wiki pages about superconducting chip design agents, Xmon layout concepts, and code-backed layout artifacts.

It is not fabrication-ready. Missing checks include PDK mapping, process-specific junction geometry, DRC/LVS, EM/eigenmode simulation, participation-ratio loss analysis, package-mode analysis, frequency target extraction, coupling/readout parameter validation, and foundry review.

## Suggested Retrieval Tags

- design-artifact
- code-output
- xmon
- transmon
- superconducting-chip-layout
- klayout
- gds
