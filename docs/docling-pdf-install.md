# Docling PDF Fallback Install Guide

This project uses Docling as the first fallback when `parse_paper` cannot parse a PDF with OpenDataLoader.

Validated on 2026-04-28:

- `docling 2.91.0`
- `docling-core 2.74.1`
- `docling-ibm-models 3.13.2`
- `docling-parse 5.10.1`
- Python `3.11.15`

## Install

Install Docling as a user-local CLI tool:

```sh
uv tool install docling
```

Verify:

```sh
command -v docling
docling --version
docling --help
```

Expected command path on this machine:

```text
/home/ququan2/.local/bin/docling
```

## Model Cache

Docling's standard PDF pipeline needs local model artifacts on first use. In this WSL environment, direct Hugging Face access through the proxy returned SSL EOF errors, so the layout model was downloaded through the Hugging Face mirror:

```sh
HF_ENDPOINT=https://hf-mirror.com docling-tools models download layout
```

Validated cache path:

```text
/home/ququan2/.cache/docling/models
```

The agent automatically passes this cache as `--artifacts-path` when it exists. You can override it explicitly:

```sh
export PI_PAPER_READER_DOCLING_ARTIFACTS_PATH="/home/ququan2/.cache/docling/models"
```

## Agent Behavior

`parse_paper` in `auto` mode now uses this order:

```text
opendataloader-local
opendataloader-hybrid
docling
plain-text-baseline
```

Docling is invoked with CPU-only, no OCR, no table-model extraction, and JSON output:

```sh
docling \
  --from pdf \
  --to json \
  --image-export-mode placeholder \
  --no-ocr \
  --no-tables \
  --device cpu \
  --artifacts-path /home/ququan2/.cache/docling/models \
  --output /tmp/pi-agent-docling-check \
  knowledge-base/raw/pdfs/nature-s41467-025-59778-z.pdf
```

The agent reads Docling JSON and writes its own compact markdown, so base64 image payloads are not stored in the wiki parse artifact.

## Environment Variables

- `PI_PAPER_READER_DOCLING_BIN`: override the Docling executable path.
- `PI_PAPER_READER_DOCLING_ARTIFACTS_PATH`: override the local model cache path.
- `PI_PAPER_READER_DOCLING_DEVICE`: override the accelerator device; defaults to `cpu`.
- `PI_PAPER_READER_DOCLING_TIMEOUT_MS`: override the Docling timeout; defaults to 180 seconds.

## Verification

Run a direct Docling conversion:

```sh
rm -rf /tmp/pi-agent-docling-check

docling \
  --from pdf \
  --to json \
  --image-export-mode placeholder \
  --no-ocr \
  --no-tables \
  --device cpu \
  --artifacts-path /home/ququan2/.cache/docling/models \
  --document-timeout 180 \
  --output /tmp/pi-agent-docling-check \
  knowledge-base/raw/pdfs/nature-s41467-025-59778-z.pdf

find /tmp/pi-agent-docling-check -maxdepth 2 -type f | sort
```

Expected key output:

```text
/tmp/pi-agent-docling-check/nature-s41467-025-59778-z.json
```

Verify through the agent reader module:

```sh
npm run build

node --input-type=module -e '
import { parsePaper, searchPaperText } from "./dist/src/index.js";
const parsed = await parsePaper({
  workspaceDir: process.cwd(),
  recordPath: "knowledge-base/wiki/sources/nature-s41467-025-59778-z/acquisition.json",
  engine: "docling",
  force: true
});
console.log(parsed.paperKey, parsed.engine, parsed.quality.status, parsed.quality.pages);
const hits = await searchPaperText({
  workspaceDir: process.cwd(),
  paperKey: parsed.paperKey,
  engine: "docling",
  query: "cosmic-ray",
  maxResults: 2
});
console.log(JSON.stringify(hits.results, null, 2));
'
```
