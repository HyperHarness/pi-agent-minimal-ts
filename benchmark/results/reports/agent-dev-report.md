# Benchmark report

Responses: `/home/ququan2/pi-agent-minimal-ts/benchmark/results/agent-dev.jsonl` (120 responses, 120 graded)
Judge: openai/gpt-5.5

## Accuracy by category

| category | n | accuracy | errors |
|---|---|---|---|
| factual | 36 | 61.1% | 0 |
| numerical | 29 | 39.7% | 1 |
| pointer | 16 | 81.3% | 0 |
| multihop | 18 | 47.2% | 0 |
| abstention | 17 | 82.4% | 0 |
| synthesis | 4 | 61.7% | 0 |

**Overall: 59.6%** over 120 items.

## Grounding

- Citation precision: 92.7% / recall: 95.4% (over 83 answered items)
- Uncited-answer rate: 1.2%
- False-answer rate on abstention items (hallucination metric): 17.6%

## Cost

- Total tokens: 4,050,743 — reported cost: $3.3721
- Mean latency per item: 11.2 s
