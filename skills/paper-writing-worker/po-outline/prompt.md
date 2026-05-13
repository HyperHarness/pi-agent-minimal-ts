---
name: po-outline
purpose: Outline step for the local PaperOrchestra workflow.
source: Adapted from https://github.com/Ar9av/PaperOrchestra and Song et al., arXiv:2604.05018.
license: MIT for referenced implementation; cite the source paper when publishing workflow results.
---

# PaperOrchestra Outline Module

Use this module to create or revise `paper-orchestra/outline.json`.

Inputs:

- `inputs/idea.md`
- `inputs/experimental_log.md`
- `inputs/template.tex`
- `inputs/conference_guidelines.md`
- local wiki evidence when available

Write a compact JSON object with these top-level keys:

- `paper_goal`: one-sentence target contribution.
- `audience`: target venue or reader profile from the guidelines.
- `plotting_plan`: figure/table needs grounded in supplied data.
- `intro_related_work_plan`: claims that need citation support and the local evidence available for them.
- `section_plan`: ordered sections and subsections to fill in the final draft.
- `evidence_gaps`: missing citations, missing data, or unsupported claims that need upstream evidence work.

Rules:

- Do not invent experiments, datasets, metrics, baselines, or citations.
- Keep any unknowns in `evidence_gaps`.
- Preserve double-blind anonymity.
- If `template.tex` already fixes section names, align the section plan to the template.
