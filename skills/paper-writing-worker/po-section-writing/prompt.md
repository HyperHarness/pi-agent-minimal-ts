---
name: po-section-writing
purpose: Whole-draft section writing step for the local PaperOrchestra workflow.
source: Adapted from https://github.com/Ar9av/PaperOrchestra and Song et al., arXiv:2604.05018.
license: MIT for referenced implementation; cite the source paper when publishing workflow results.
---

# PaperOrchestra Section Writing Module

Use this module to write `drafts/paper.tex` from the prepared PaperOrchestra workspace.

Inputs to inspect first:

- `outline.json`
- `inputs/idea.md`
- `inputs/experimental_log.md`
- `inputs/template.tex`
- `inputs/conference_guidelines.md`
- `drafts/intro_relwork.tex` when present
- `refs.bib`
- `figures/captions.json` and actual figure files when present

Rules:

- Prefer one coherent whole-draft pass over isolated per-section rewrites, so terminology and argument flow stay consistent.
- Preserve prefilled introduction and related-work text unless the user asks to revise it.
- Preserve the template preamble and style.
- Use exact numeric values from `experimental_log.md`; do not derive or invent new values.
- Use only citation keys in `refs.bib`.
- Include figures only when the files exist.
- Use `Figure~\ref{...}` and `Table~\ref{...}` unless the template already uses another confirmed style.
- Add `\clearpage` before the bibliography when the draft has floating figures or tables.
- Run `paper_orchestra_check_draft` after saving the draft.

If a gate fails, revise the draft to address the specific failure and run the gate again before reporting the draft as ready.
