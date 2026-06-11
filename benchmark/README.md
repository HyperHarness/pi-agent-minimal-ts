# Knowledge-base agent benchmark (superconducting quantum design)

A retrieval-grounded QA benchmark built from the 82 paper parses in
`knowledge-base/sources/`. Four stages, all resumable (re-running skips
completed work):

```bash
npm run build                                  # the runner imports the agent from dist/

node benchmark/generate.mjs                    # 1. candidates.jsonl   (LLM, ~115 calls)
node benchmark/verify.mjs                      # 2. benchmark.jsonl    (adversarial filter, frozen)
node benchmark/run.mjs --split dev             # 3. results/agent-dev.jsonl     (agent under test)
node benchmark/run.mjs --split dev --baseline  #    results/baseline-dev.jsonl  (bare model, no KB)
node benchmark/grade.mjs --responses benchmark/results/agent-dev.jsonl \
     --compare benchmark/results/baseline-dev.jsonl   # 4. report + scores
```

## Item categories

| category | tests | grading |
|---|---|---|
| factual | single-source grounded QA | LLM judge vs gold + evidence |
| numerical | exact reported values (fidelity, T1, frequencies…) | LLM judge, rounding-of-last-digit tolerance, units required |
| pointer | retrieval: name the sourceKey reporting a finding | mechanical key match |
| multihop | combine/compare two related sources | LLM judge |
| abstention | plausible questions the corpus can't answer | must reply `NOT_IN_KB`; substantive answer = hallucination |
| synthesis | open survey of a tag cluster | rubric coverage fraction |

Frozen item schema (`benchmark.jsonl`):

```json
{"id": "sq-001", "category": "numerical", "question": "...",
 "gold_answer": "99.13 ± 0.15%", "gold_sources": ["arxiv-2308.09240"],
 "evidence": [{"sourceKey": "arxiv-2308.09240", "quote": "..."}],
 "answerable": true, "difficulty": "medium", "split": "dev"}
```

## Design decisions

- **Generated from raw parses, not summaries** — the agent's own index is built
  from the summaries; grading against them would test string recall.
- **Adversarial verification** — every evidence quote is mechanically checked as a
  verbatim substring of the parse; an LLM reviewer with a default-reject stance
  then checks entailment, self-containedness, and ambiguity. Abstention items are
  checked against the full (truncated) parse for actual absence.
- **Contamination control** — these are public papers, so a bare model answers
  many items from pretraining. Always run `--baseline` and read the
  *discriminative accuracy* in the report: accuracy on items the baseline failed.
  That number is what the knowledge base buys you.
- **Held-out split** — ~20% of items land in `holdout` (deterministic question
  hash). Iterate prompts/agent on `dev`; touch `--split holdout` only for final
  numbers, so you don't overfit to the benchmark.
- **Fresh context per item** — the runner calls `runAgentTurn` with a new message
  context per question (wiki-agent profile, worker routing disabled so the
  download-intent router can't hijack questions containing "paper" + "find").

## Models

- Agent under test: resolved like the CLI from `PI_PROVIDER` / `PI_MODEL` / `PI_BASE_URL`.
- Generator/verifier/judge: same by default, overridable via `BENCH_PROVIDER` /
  `BENCH_MODEL` / `BENCH_BASE_URL`. Use a different model than the agent when you
  can — a judge from the same family is more lenient toward its own mistakes.

## Caveats

- `benchmark.jsonl` is frozen output: don't regenerate it casually, version it in
  git, and treat score history as comparable only while the file is unchanged.
- Synthesis rubrics are seeded from source summaries (breadth questions), unlike
  all other categories which are grounded in raw parses.
- Tag-based gold source lists for synthesis are recall-oriented; the corpus may
  contain additional relevant sources beyond the tagged ones.
