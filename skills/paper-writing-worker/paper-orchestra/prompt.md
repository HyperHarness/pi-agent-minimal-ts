---
name: paper-orchestra
purpose: PaperOrchestra-inspired end-to-end manuscript workflow for the paper-writing worker.
source: Adapted from https://github.com/Ar9av/PaperOrchestra and Song et al., arXiv:2604.05018.
license: MIT for referenced implementation; cite the source paper when publishing workflow results.
---

# PaperOrchestra Workflow Module

Use this module when the user asks the paper-writing worker to run PaperOrchestra, draft a complete paper, turn research notes into a manuscript, prepare a submission package, build an outline, write missing sections, or refine a draft.

This repository keeps PaperOrchestra inside the existing worker boundaries:

- `paper-writing-worker` owns manuscript files, PaperOrchestra workspace setup, deterministic writing gates, refinement decisions, provenance snapshots, and LaTeX compilation.
- `paper-download-subagent` owns external paper search, downloads, browser access, and acquisition fallback.
- `wiki-evidence-worker` owns source summaries and fixed-evidence relation maintenance.
- `wiki-agent` owns durable wiki page construction.

Do not run web search, download papers, create source summaries, or build wiki pages from this worker. If literature evidence is missing, report the missing evidence and hand the upstream task back to the main wiki agent.

## Workspace Contract

Prefer a private project-local workspace:

```text
paper-projects/<paper-key>/paper-orchestra/
```

Required inputs:

- `inputs/idea.md`
- `inputs/experimental_log.md`
- `inputs/template.tex`
- `inputs/conference_guidelines.md`

Optional inputs:

- `inputs/figures/`
- local wiki evidence retrieved with `search_paper_wiki` or `answer_paper_wiki_question`

Expected generated artifacts:

- `outline.json`
- `figures/` and `figures/captions.json`
- `refs.bib` and optional `citation_pool.json`
- `drafts/intro_relwork.tex`
- `drafts/paper.tex`
- `refinement/worklog.json`
- `final/paper.tex`
- `final/paper.pdf`
- `provenance.json`

## Execution Protocol

1. Run `paper_orchestra_prepare_workspace` before writing. If required inputs are missing, stop and name the missing files. Do not invent inputs.
2. Load the narrow submodule for the current step when useful: `po-outline`, `po-literature-review`, `po-plotting`, `po-section-writing`, or `po-content-refinement`.
3. Ground every substantive technical claim in the provided inputs or local wiki evidence. Do not rely on remembered facts.
4. Preserve anonymity. Do not add author names, affiliations, email addresses, acknowledgements, or corresponding-author language.
5. Use only citation keys present in `refs.bib`.
6. After writing or revising `drafts/paper.tex`, run `paper_orchestra_check_draft`.
7. After accepted finalization, compile with `compile_latex` and write `paper_orchestra_snapshot_provenance`.

## Pipeline Mapping

PaperOrchestra's five steps map to this repository as follows:

- Outline: write `outline.json` from local inputs and evidence.
- Plotting: reuse existing figures or write figure plans/captions. Do not fabricate generated plots unless the user supplies the data and asks for generated assets.
- Literature review: consume local wiki evidence and prepared `refs.bib`; ask upstream workers for missing acquisition/evidence tasks.
- Section writing: make one coherent whole-draft pass where feasible, preserving prefilled introduction/related-work text and template style.
- Content refinement: iterate on presentation, clarity, structure, and evidence use. Do not add experiments, new numeric results, or unsupported limitations.

## Output Discipline

For an end-to-end run, report:

- workspace path
- required inputs status
- draft/final artifact paths
- citation count
- gate results
- compile result
- provenance path
- upstream evidence tasks that remain blocked or missing
