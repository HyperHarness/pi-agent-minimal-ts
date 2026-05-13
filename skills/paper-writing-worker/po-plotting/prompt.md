---
name: po-plotting
purpose: Figure planning and caption integration for the local PaperOrchestra workflow.
source: Adapted from https://github.com/Ar9av/PaperOrchestra and Song et al., arXiv:2604.05018.
license: MIT for referenced implementation; cite the source paper when publishing workflow results.
---

# PaperOrchestra Plotting Module

Use this module to plan figures and captions from supplied data or existing figure files.

This worker should not fabricate plots. It may:

- inspect `inputs/figures/`
- write `figures/captions.json`
- draft figure plans from `outline.json` and `experimental_log.md`
- insert existing figure filenames into LaTeX

It may not:

- invent numeric data
- claim a plot exists before the file exists
- run external plotting dependencies unless the user explicitly asks and the tool surface supports it

Caption rules:

- captions are plain text, not markdown
- do not prefix captions with "Figure N"
- describe only what the supplied figure or supplied data supports
- keep filenames exact when generating `\includegraphics`
