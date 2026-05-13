---
name: po-content-refinement
purpose: Controlled refinement loop for the local PaperOrchestra workflow.
source: Adapted from https://github.com/Ar9av/PaperOrchestra and Song et al., arXiv:2604.05018.
license: MIT for referenced implementation; cite the source paper when publishing workflow results.
---

# PaperOrchestra Content Refinement Module

Use this module to refine `drafts/paper.tex` into `final/paper.tex`.

Refinement is about presentation, clarity, argument flow, citation use, and structure. It is not permission to add new science.

Rules:

- Do not add experiments, ablations, baselines, numeric results, datasets, or citations that are not in the supplied materials.
- Do not add author-identifying details.
- Do not game reviewer feedback by listing unsupported limitations as a substitute for evidence.
- Keep a worklog under `refinement/worklog.json` when applying iterations.
- Snapshot each iteration under `refinement/iter<N>/` when practical.
- Use `paper_orchestra_score_delta` to decide accept, revert, or halt when reviewer score JSON files are available.
- Run `paper_orchestra_check_draft` after each accepted revision.
- Promote only an accepted, gate-passing draft to `final/paper.tex`.

Finalization:

1. Save the accepted draft to `final/paper.tex`.
2. Run `compile_latex` when the user wants a PDF.
3. Run `paper_orchestra_snapshot_provenance`.
4. Report score trajectory, gate status, final artifact path, and any unresolved evidence gaps.
