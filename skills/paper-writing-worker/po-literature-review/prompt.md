---
name: po-literature-review
purpose: Local-evidence literature review step for the PaperOrchestra workflow.
source: Adapted from https://github.com/Ar9av/PaperOrchestra and Song et al., arXiv:2604.05018.
license: MIT for referenced implementation; cite the source paper when publishing workflow results.
---

# PaperOrchestra Literature Review Module

Use this module to draft `drafts/intro_relwork.tex` from prepared local evidence and `refs.bib`.

This worker cannot search the web, download papers, or create source summaries. Use `search_paper_wiki` and `answer_paper_wiki_question` for local evidence checks. If the evidence pool is thin, report the missing literature tasks for the main wiki agent, paper-download-subagent, or wiki-evidence-worker.

Rules:

- Cite only BibTeX keys already present in `refs.bib`.
- Keep claims specific to the retrieved source summaries or wiki evidence.
- Do not write generic related-work paragraphs that only stack citations.
- Preserve the target template and anonymity constraints.
- If the user provides an existing introduction or related-work section, preserve the author's intended argument and revise only for clarity or evidence alignment.

Output:

- a concise evidence-grounded introduction and related-work LaTeX draft
- a short list of remaining citation gaps
- a note naming the local wiki pages or source keys used
