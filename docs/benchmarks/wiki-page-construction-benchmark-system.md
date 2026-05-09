# Wiki Page Construction Benchmark System

Date: 2026-05-07

## Goal

This benchmark evaluates whether an agent harness can turn a fixed set of source evidence into a durable wiki synthesis page.

It is designed for two related uses:

1. Optimize the harness around `build_wiki_page` and the clean-context page worker.
2. Compare different LLMs under the same harness, evidence package, tools, prompts, and scoring rules.

The benchmark intentionally fixes paper acquisition, parsing, retrieval, and source-summary generation. Those stages have their own health and parser benchmarks. Here, the variable under test is page construction: evidence understanding, synthesis, grounding, structure, uncertainty handling, and wiki integration.

## Boundary

In scope:

- Given source summaries and optional existing wiki pages, produce a new or updated synthesis page.
- Require source-backed claims and page-level provenance.
- Detect insufficient or conflicting evidence instead of hallucinating.
- Produce page metadata such as title, tags, related pages, source citations, and open questions.
- Measure harness behavior and model behavior separately.

Out of scope:

- Live web search.
- Publisher download reliability.
- PDF parser quality.
- Source-summary generation from raw papers.
- General chat answer quality that does not write a durable page.

## Design Principles

### Fixed Evidence, Variable Model

Every model receives the same `PaperWikiPageWorkerInput` shape:

```json
{
  "topic": "qLDPC on superconducting chips",
  "question": "What implementation bottlenecks should a wiki page preserve?",
  "evidence": [
    {
      "kind": "source",
      "key": "source-a",
      "paperKey": "source-a",
      "title": "Source A",
      "path": "knowledge-base/sources/source-a.md",
      "snippet": "..."
    }
  ]
}
```

The benchmark should prefer local fixture evidence under `benchmarks/wiki-page-construction/` over the live `knowledge-base/` directory. Live wiki data is useful for smoke tests, but it drifts and is therefore not a stable leaderboard source.

### Provenance First

The benchmark borrows the KILT idea that downstream task quality and provenance should be evaluated together. A page is not good if it gives a plausible answer but cannot identify the source summaries that support its claims.

### Retrieval Is Frozen

BEIR-style retrieval metrics are useful when testing `search_paper_wiki`, but this benchmark should not let retrieval differences dominate model comparison. Each case provides the evidence set directly, including distractors when the test wants to measure noise handling.

### Supporting Facts And Claim Labels

HotpotQA motivates multi-source questions with explicit supporting facts. FEVER motivates claim labels: supported, refuted, and not enough information. Each benchmark case should therefore include claim cards that identify which source spans support, refute, or fail to support expected page content.

### Wiki Constraints Are First-Class

The generated artifact must satisfy local wiki constraints: source citations, frontmatter fields, related-page hygiene, and no broken links. This follows the same spirit as Wikidata constraint violations and the repo's `wiki_lint`.

### LLM Judge Is Secondary

Use deterministic scoring wherever possible. LLM-as-judge is valuable for coherence, synthesis quality, and redundancy, but those scores should never be the only pass/fail gate.

## Case Format

Recommended path:

```text
benchmarks/wiki-page-construction/cases/<case-id>.json
benchmarks/wiki-page-construction/evidence/<case-id>/*.md
benchmarks/wiki-page-construction/expected/<case-id>.json
benchmarks/wiki-page-construction/runs/<run-id>/<model>/<case-id>.json
```

Case schema:

```json
{
  "id": "qldpc-superconducting-bottlenecks-001",
  "difficulty": "medium",
  "taskType": "multi_source_synthesis",
  "topic": "qLDPC on superconducting chips",
  "question": "Build a durable wiki page about qLDPC implementation bottlenecks on superconducting chips.",
  "targetPageKey": "qldpc-superconducting-chips",
  "harness": {
    "mode": "draft",
    "allowedTools": ["build_wiki_page"],
    "forbiddenTools": ["web_search", "download_paper"],
    "maxEvidenceItems": 6
  },
  "evidence": [
    {
      "kind": "source",
      "key": "source-layout",
      "paperKey": "source-layout",
      "title": "Superconducting Layout Constraints",
      "path": "benchmarks/wiki-page-construction/evidence/qldpc-superconducting-bottlenecks-001/source-layout.md",
      "role": "required"
    },
    {
      "kind": "source",
      "key": "source-qldpc",
      "paperKey": "source-qldpc",
      "title": "Quantum LDPC Connectivity",
      "path": "benchmarks/wiki-page-construction/evidence/qldpc-superconducting-bottlenecks-001/source-qldpc.md",
      "role": "required"
    },
    {
      "kind": "source",
      "key": "source-distractor",
      "paperKey": "source-distractor",
      "title": "Unrelated Cryogenic Control Note",
      "path": "benchmarks/wiki-page-construction/evidence/qldpc-superconducting-bottlenecks-001/source-distractor.md",
      "role": "distractor"
    }
  ],
  "claimCards": [
    {
      "id": "c1",
      "label": "support",
      "claim": "Non-local connectivity is a central hardware bottleneck for qLDPC layouts on superconducting chips.",
      "supportingEvidence": [
        {
          "key": "source-qldpc",
          "anchors": ["non-local connectivity", "long-range coupler"]
        },
        {
          "key": "source-layout",
          "anchors": ["layout congestion", "routing overhead"]
        }
      ]
    },
    {
      "id": "c2",
      "label": "not_enough_info",
      "claim": "The provided sources prove a full million-qubit qLDPC implementation is already validated.",
      "supportingEvidence": []
    }
  ],
  "expected": {
    "mustIncludeClaims": ["c1"],
    "mustNotAssertClaims": ["c2"],
    "requiredSourceKeys": ["source-layout", "source-qldpc"],
    "distractorSourceKeys": ["source-distractor"],
    "requiredSections": ["Overview", "Evidence", "Implementation Bottlenecks", "Open Questions"],
    "expectedTags": ["qldpc", "superconducting-qubits"],
    "expectedRelatedPages": ["superconducting-qubits"],
    "openQuestionHints": ["crosstalk", "fabrication", "measurement overhead"]
  }
}
```

## Task Taxonomy

Use several case classes instead of one generic page-generation task.

| Level | Case type | What it tests | Public benchmark inspiration |
| --- | --- | --- | --- |
| 0 | Harness conformance | Calls the right tool, uses fixed evidence, writes/drafts valid page output | KILT provenance discipline |
| 1 | Single-source extraction page | Preserves key claims from one source without invention | WikiQA answer triggering |
| 2 | Multi-source synthesis page | Combines complementary sources into a coherent concept page | HotpotQA multi-document support |
| 3 | Distractor-resistant synthesis | Ignores irrelevant source summaries | BEIR/RAG context precision |
| 4 | Conflict-aware page | Surfaces contradictory evidence and avoids false consensus | FEVER support/refute labels |
| 5 | Insufficient-evidence page | Produces open questions instead of unsupported conclusions | FEVER not-enough-info |
| 6 | Incremental update page | Updates an existing page without duplicating concepts or losing citations | Wiki maintenance constraints |
| 7 | Graph-aware synthesis | Adds useful related pages and preserves navigability | Wikidata constraints and local graph lint |

Each model run should include a balanced slice:

- 20% single-source cases.
- 25% multi-source synthesis cases.
- 15% distractor cases.
- 15% conflict or uncertainty cases.
- 15% graph/update cases.
- 10% adversarial formatting or bilingual cases.

## Harness Modes

### Worker-Isolated Mode

This is the cleanest model comparison mode.

- Directly call the page worker with `PaperWikiPageWorkerInput`.
- Do not call retrieval, download, parse, or summary tools.
- Score the returned `PaperWikiPageWorkerOutput`.
- This isolates LLM synthesis behavior from agent tool-planning behavior.

Use this mode for model leaderboards.

### Tool-Harness Mode

This tests the full harness around `build_wiki_page`.

- Create a temporary workspace.
- Install fixture source summaries into `knowledge-base/sources/`.
- Inject or mock retrieval so every model receives the same evidence.
- Use `createToolsForBoundary(workspaceDir, "wiki-agent")` so the benchmarked agent cannot call paper download, web search, or source-summary generation tools.
- Run `build_wiki_page` in `draft` or `write` mode.
- Run `wiki_lint` after write mode.

Use this mode to optimize the harness, tool schemas, prompt wrappers, and page-write constraints.

### Live-Wiki Smoke Mode

This mode samples the real local wiki.

- Use current `knowledge-base/sources/` and `pages/`.
- Record snapshot metadata.
- Do not compare model leaderboard scores across different wiki snapshots.

Use this mode only for regression checks before relying on the harness interactively.

## Scoring

Recommended total score: 100 points.

### 1. Harness Compliance, 15 Points

Programmatic.

- Uses only allowed tools: 4.
- Does not attempt external search/download in fixed-evidence mode: 3.
- Returns required schema fields: 3.
- Does not exceed evidence/token budget: 2.
- Produces deterministic run metadata: 1.
- Completes without timeout or tool error: 2.

### 2. Wiki Artifact Validity, 15 Points

Programmatic.

- Valid Markdown and non-empty title: 2.
- Required frontmatter/page-worker fields are present: 3.
- At least one required source citation is preserved: 3.
- No citation to non-provided source: 2.
- Required sections are present: 2.
- `wiki_lint` has no high-severity issue after write mode: 3.

### 3. Evidence Coverage, 20 Points

Mostly programmatic with optional judge assist.

- Required claim cards are covered: 8.
- Required source keys are cited or referenced in relevant sections: 5.
- Important evidence from different sources is integrated, not listed separately without synthesis: 4.
- No over-reliance on a single source when the case requires multi-source synthesis: 3.

### 4. Faithfulness And Non-Hallucination, 20 Points

Hybrid deterministic and LLM judge.

- No forbidden or unsupported claim cards are asserted: 8.
- Refuted claims are either rejected or explicitly marked as conflicting: 4.
- Not-enough-info claims become open questions or limitations: 4.
- Numeric, causal, temporal, and comparative statements are grounded in provided evidence: 4.

### 5. Synthesis Quality, 15 Points

LLM judge plus human audit sample.

- Page has a clear conceptual thesis: 3.
- Organizes evidence into reusable wiki knowledge, not a paper-by-paper bibliography: 4.
- Explains mechanisms, tradeoffs, and design implications: 4.
- Keeps uncertainty and scope visible: 2.
- Avoids redundant filler: 2.

### 6. Graph And Maintenance Quality, 10 Points

Programmatic and judge.

- Tags match expected concepts: 2.
- Related pages are useful and not noisy: 3.
- Open questions are actionable: 2.
- Page key/title are canonical and avoid duplicate aliases: 2.
- Existing page update does not destroy prior content in update cases: 1.

### 7. Style And Usability, 5 Points

Judge or human.

- Clear headings and concise prose: 2.
- Suitable for future retrieval and paper writing: 2.
- Bilingual handling is appropriate when the case asks in Chinese but sources are English: 1.

## Derived Metrics

Report aggregate scores and diagnostic metrics:

- `pass_rate`: cases above the configured pass threshold.
- `citation_precision`: cited provided sources / all cited sources.
- `citation_recall`: required cited sources / required sources.
- `claim_recall`: required supported claims covered / required supported claims.
- `unsupported_claim_rate`: unsupported asserted claims / total asserted claims.
- `distractor_use_rate`: distractor sources cited or substantively used / distractor sources.
- `nei_discipline`: not-enough-info claims correctly demoted / all NEI claims.
- `conflict_handling_rate`: conflict cases with explicit contradiction handling / conflict cases.
- `wiki_lint_high_count`: high severity wiki lint issues after write mode.
- `latency_ms`, `input_tokens`, `output_tokens`, `tool_call_count`, `estimated_cost`.

## Judge Protocol

Use two judge layers.

### Deterministic Judge

The deterministic judge should parse:

- frontmatter fields
- headings
- source keys and page links
- exact or fuzzy anchors from claim cards
- forbidden phrases
- generated source citations
- `wiki_lint` result

This judge is the authority for pass/fail constraints.

### LLM Judge

The LLM judge receives:

- case question
- provided evidence
- claim cards without expected point weights
- generated page output
- rubric

The judge must emit JSON:

```json
{
  "scores": {
    "evidenceCoverage": 0,
    "faithfulness": 0,
    "synthesisQuality": 0,
    "maintenanceQuality": 0,
    "style": 0
  },
  "unsupportedClaims": [],
  "missedClaims": [],
  "misusedDistractors": [],
  "rationale": "short explanation"
}
```

For model leaderboard runs, use the same judge model and judge prompt for all candidate models. Keep judge temperature at 0 or the lowest supported value. Sample at least 10% of cases for human audit because judge bias can otherwise hide systematic failures.

## Pass Gates

A model can have a high numeric score but still fail a case. Use hard gates:

- Any external search/download in fixed-evidence mode: fail.
- Writes a page with zero source citations: fail.
- Cites a source not in the evidence package: fail.
- Asserts a forbidden `not_enough_info` claim as fact: fail.
- `wiki_lint` high-severity issue after write mode: fail for tool-harness write cases.
- Empty or near-empty page: fail.

Recommended model pass threshold:

- Case pass: score >= 75 and no hard gate failure.
- Harness ready: average >= 82, pass rate >= 90%, no more than 2% unsupported-claim hard failures.

## Benchmark Splits

Use three splits.

### Development

Small, visible, and fast.

- 10-20 cases.
- Used while editing prompts and harness code.
- Expected outputs and rubrics can be read by developers.

### Regression

Stable CI/local suite.

- 40-80 cases.
- Covers every case type.
- No live network.
- Should run after changing prompts, tool schemas, source packaging, or page-write code.

### Blind Evaluation

Held-out model comparison.

- 50-150 cases.
- Do not expose expected claim cards to the candidate harness.
- Use for model selection.

## Minimal Implementation Plan

### Phase 1: Fixture And Worker Benchmark

Add:

```text
benchmarks/wiki-page-construction/
  cases/
  evidence/
  expected/
  runs/
scripts/wiki-page-benchmark.mjs
```

The script should:

1. Load cases.
2. Read fixture evidence markdown.
3. Convert evidence into `PaperWikiPageWorkerInput`.
4. Call one configured page worker/model.
5. Save raw output and metadata.
6. Run deterministic scoring.
7. Write `benchmark-report.md` and `benchmark-report.json`.

This phase is enough to compare LLMs under the same synthesis harness.

### Phase 2: Tool-Harness Benchmark

Extend the script to:

1. Create a temp workspace per case.
2. Write fixture evidence into `knowledge-base/sources/`.
3. Inject deterministic `searchPaperWiki` results.
4. Run `build_wiki_page` in `draft` and optionally `write`.
5. Run `wiki_lint`.
6. Score both page-worker output and final page artifact.

This phase tests the real harness, not only the worker prompt.

### Phase 3: Judge And Report Layer

Add:

- LLM judge JSON scoring.
- Cost and latency tracking.
- Per-model leaderboard.
- Failure cluster report grouped by hard gate and case type.
- Human-audit export with evidence, generated page, deterministic score, and judge score side by side.

## Recommended Report Shape

```text
# Wiki Page Construction Benchmark Report

Run: 2026-05-07T...
Harness: build_wiki_page@<git-sha>
Evidence split: regression-v1
Models: gpt-x, model-y, model-z

| Model | Avg | Pass | Faithfulness | Coverage | Synthesis | NEI | Distractor | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |

## Failure Clusters

- model-y: high unsupported claim rate in conflict cases.
- model-z: low citation recall in multi-source cases.

## Harness Findings

- Current prompt under-specifies open-question behavior.
- Page key generation is stable.
- `wiki_lint` catches missing source citations after write mode.
```

## How This Maps To Current Repo

Current repo primitives already cover most of this benchmark:

- `PaperWikiPageWorkerInput` and `PaperWikiPageWorkerOutput` are the natural worker-isolated API.
- `build_wiki_page` already passes fixed evidence to a clean-context page worker.
- `createToolsForBoundary(workspaceDir, "wiki-agent")` exposes the wiki-agent tool surface while disabling external evidence acquisition inside `build_wiki_page`.
- `createToolsForBoundary(workspaceDir, "paper-download-subagent")` provides the raw paper acquisition surface for non-benchmark ingestion workflows.
- `createToolsForBoundary(workspaceDir, "wiki-evidence-worker")` provides the wiki-side evidence surface for source-summary generation and source relation maintenance.
- `createToolsForBoundary(workspaceDir, "paper-writing-worker")` provides a paper-writing surface that can read and write manuscript files, compile LaTeX, and retrieve citeable wiki evidence without exposing download, web search, source-summary generation, or wiki page writes.
- Worker-isolated page synthesis should call the page worker directly with `PaperWikiPageWorkerInput` and no tools, preserving the benchmark contract.
- `writePaperWikiPage` enforces at least one source citation.
- `wiki_lint` already catches stale index entries, broken links, missing source citations, orphan pages, and concept gaps.
- `/graph-data.json` can support graph-related derived metrics for live-wiki smoke tests.

The main missing pieces are the fixture format, deterministic scorer, run recorder, and report generator.

## Practical Starting Suite

Start with 24 cases:

- 4 single-source extraction cases.
- 6 multi-source synthesis cases.
- 4 distractor-resistance cases.
- 4 conflict/insufficient-evidence cases.
- 4 graph-aware page cases.
- 2 bilingual Chinese-question/English-source cases.

For each case, write 2-4 short fixture source summaries, each 800-1500 words or less. That is large enough to test synthesis and small enough to keep cost stable across models.

After the first suite is stable, expand to 60-80 regression cases and keep 50+ blind cases for model selection.

## References Used For Method Design

- KILT: shared knowledge snapshot and provenance-aware knowledge-intensive task evaluation: https://nlp.cs.ucl.ac.uk/datasets/2020-09-kilt-a-benchmark-for-knowledge-intensive-language-tasks/
- BEIR: retrieval metrics such as NDCG, MAP, Recall, Precision, and MRR: https://github.com/beir-cellar/beir/wiki/Metrics-available
- Ragas: RAG metrics such as context precision, context recall, response relevancy, faithfulness, and agent/tool-use metrics: https://docs.ragas.io/en/v0.4.1/concepts/metrics/available_metrics/
- WikiQA: natural user questions, answer sentence selection, and answer-triggering cases where no answer exists: https://www.microsoft.com/en-us/research/publication/wikiqa-a-challenge-dataset-for-open-domain-question-answering/
- HotpotQA: multi-document reasoning with supporting facts: https://huggingface.co/papers/1809.09600
- FEVER: supported, refuted, and not-enough-information claim labels with evidence: https://fever.ai/dataset/fever.html
- Wikimedia article quality and articlequality: structural page-quality signals, with the caveat that such models should not be treated as domain-independent writing-quality judges: https://meta.wikimedia.org/wiki/Machine_learning_models/Production/English_Wikipedia_article_quality and https://articlequality.readthedocs.io/
- Wikidata quality and property constraints: constraint violations, consistency, references, and maintenance health as benchmark dimensions: https://www.wikidata.org/wiki/Help:Property_constraints_portal/en and https://www.sciencedirect.com/science/article/pii/S1570826821000536
