# Pandoc and LaTeXML Install Guide

This project uses Pandoc and LaTeXML as enhanced scientific-paper reading backends.

- arXiv TeX source: `tex -> latexmlc -> html -> pandoc -> markdown`.
- Publisher webpages: filtered article HTML from APS, Nature, Science, and arXiv HTML is converted through Pandoc first, then falls back to the built-in lightweight converter if Pandoc is unavailable or fails.

Validated on 2026-04-28:

- `latexmlc` from LaTeXML `0.8.8`
- `pandoc 3.1.3`

## Install LaTeXML

Install LaTeXML from Ubuntu packages:

```sh
sudo apt-get update
sudo apt-get install -y latexml
```

Verify:

```sh
command -v latexmlc
latexmlc --VERSION
```

Expected command path on this machine:

```text
/usr/bin/latexmlc
```

## Install Pandoc

Prefer the official GitHub `.deb` package instead of Ubuntu's `apt install pandoc`, because the Ubuntu archive can lag behind Pandoc releases.

Download the Linux amd64 `.deb` package from:

```text
https://github.com/jgm/pandoc/releases
```

Then install it from the directory containing the downloaded file:

```sh
sudo dpkg -i pandoc-*.deb
sudo apt-get install -f
```

Verify:

```sh
command -v pandoc
pandoc --version
```

Expected command path on this machine:

```text
/usr/bin/pandoc
```

## Agent Behavior

`parse_paper` can use the `tex-source` engine for arXiv papers when the source archive exists under:

```text
knowledge-base/raw/arxiv-sources/<arxiv-id>/
```

The conversion command sequence is equivalent to:

```sh
latexmlc \
  --dest /tmp/document.html \
  --nocomments \
  --quiet \
  knowledge-base/raw/arxiv-sources/<arxiv-id>/<main>.tex

pandoc \
  --from html \
  --to gfm \
  --wrap=none \
  --output /tmp/document.md \
  /tmp/document.html
```

For webpage parsing, the agent first removes known publisher navigation, login, sharing, recommendation, and access-noise blocks from the selected article HTML. It then asks Pandoc to convert that filtered HTML into Markdown. If Pandoc is missing, times out, or fails, the built-in lightweight converter is used automatically.

## Environment Variables

- `PI_PAPER_READER_LATEXML_BIN`: override the `latexmlc` executable path for arXiv TeX source parsing.
- `PI_PAPER_READER_PANDOC_BIN`: override the `pandoc` executable path for paper-reader conversions.
- `PI_PAPER_READER_TEX_SOURCE_TIMEOUT_MS`: override the TeX source conversion timeout; defaults to 180 seconds.
- `PI_PAPER_WEBPAGE_PANDOC_BIN`: override the `pandoc` executable path for webpage HTML conversion.
- `PI_PAPER_WEBPAGE_PANDOC_TIMEOUT_MS`: override the webpage Pandoc conversion timeout; defaults to 60 seconds.
- `PI_PAPER_WEBPAGE_PANDOC=0`: disable Pandoc for webpage conversion and use the built-in lightweight converter.

## Verification

Run the relevant automated tests:

```sh
npm run build
node --test dist/test/agent/paper-reader.test.js --test-name-pattern "tex-source"
node --test dist/test/agent/paper-webpage-fetch.test.js --test-name-pattern "Pandoc"
```

Run a real TeX source parse when an arXiv source archive is available:

```sh
node --input-type=module -e 'import { parsePaper } from "./dist/src/agent/paper/reading/paper-reader.js"; const result = await parsePaper({ workspaceDir: process.cwd(), recordPath: "knowledge-base/wiki/sources/arxiv-2507.09690/acquisition.json", engine: "tex-source", force: true, timeoutMs: 300000 }); console.log(JSON.stringify({ status: result.status, paperKey: result.paperKey, engine: result.engine, markdownPath: result.artifacts.markdownPath, quality: result.quality }, null, 2));'
```
