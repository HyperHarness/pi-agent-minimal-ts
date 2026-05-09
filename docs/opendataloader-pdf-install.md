# OpenDataLoader PDF Install Guide

This project uses OpenDataLoader PDF as the default structured parser for scientific-paper reading tools such as `parse_paper`, `inspect_paper`, `read_paper_section`, and `search_paper_text`.

This guide documents the WSL Ubuntu user-level installation that was validated on this machine.

## Installed Versions

Validated on 2026-04-27:

- `uv 0.11.7`
- `opendataloader-pdf 2.3.0`
- Eclipse Temurin JRE `17.0.19+10`

The installation is user-local and does not require sudo after the initial attempt showed sudo password access was unavailable in the Codex session.

## Paths

```text
uv:
  /home/ququan2/.local/bin/uv

OpenDataLoader PDF:
  /home/ququan2/.local/bin/opendataloader-pdf
  /home/ququan2/.local/bin/opendataloader-pdf-hybrid

Java:
  /home/ququan2/.local/opt/java-17
  /home/ququan2/.local/bin/java
```

`/home/ququan2/.local/bin` is already on `PATH` in this WSL environment.

## Installation Commands

Install `uv`:

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Install a user-local Java 17 JRE:

```sh
mkdir -p ~/.local/opt ~/.local/tmp

curl -L --fail \
  --output ~/.local/tmp/temurin-jre17.tar.gz \
  https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jre/hotspot/normal/eclipse

tar -xzf ~/.local/tmp/temurin-jre17.tar.gz -C ~/.local/opt
ln -sfn ~/.local/opt/jdk-17.0.19+10-jre ~/.local/opt/java-17
ln -sfn ~/.local/opt/java-17/bin/java ~/.local/bin/java
```

Install OpenDataLoader PDF:

```sh
uv tool install opendataloader-pdf
```

## WSL Headless Fix

In WSL, the first real parse failed with:

```text
java.awt.AWTError: Can't connect to X11 window server using ':0'
```

The fix is to run Java in headless mode:

```sh
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Djava.awt.headless=true"
```

On this machine, the `uv` tool entrypoints were patched to set this automatically before starting OpenDataLoader:

```python
java_tool_options = os.environ.get("JAVA_TOOL_OPTIONS", "")
if "-Djava.awt.headless=" not in java_tool_options:
    os.environ["JAVA_TOOL_OPTIONS"] = f"{java_tool_options} -Djava.awt.headless=true".strip()
```

Patched files:

```text
/home/ququan2/.local/share/uv/tools/opendataloader-pdf/bin/opendataloader-pdf
/home/ququan2/.local/share/uv/tools/opendataloader-pdf/bin/opendataloader-pdf-hybrid
```

If `uv tool upgrade opendataloader-pdf` overwrites these scripts, reapply the headless fix or export `JAVA_TOOL_OPTIONS` in the shell that starts the agent.

## Verification

Check commands:

```sh
command -v uv
uv --version

command -v java
java -version

command -v opendataloader-pdf
opendataloader-pdf --help
```

Expected paths:

```text
/home/ququan2/.local/bin/uv
/home/ququan2/.local/bin/java
/home/ququan2/.local/bin/opendataloader-pdf
```

Run a real parse:

```sh
rm -rf /tmp/pi-agent-opendataloader-check
mkdir -p /tmp/pi-agent-opendataloader-check

opendataloader-pdf \
  knowledge-base/raw/pdfs/arxiv-2406.06015.pdf \
  --output-dir /tmp/pi-agent-opendataloader-check \
  --format markdown,json \
  --quiet

find /tmp/pi-agent-opendataloader-check -maxdepth 2 -type f | sort
```

Expected key outputs:

```text
/tmp/pi-agent-opendataloader-check/arxiv-2406.06015.json
/tmp/pi-agent-opendataloader-check/arxiv-2406.06015.md
```

Verify through the agent reader module:

```sh
npm run build

node --input-type=module -e '
import { parsePaper, searchPaperText } from "./dist/src/index.js";
const parsed = await parsePaper({
  workspaceDir: process.cwd(),
  path: "knowledge-base/raw/pdfs/arxiv-2406.06015.pdf",
  engine: "opendataloader-local",
  force: true
});
console.log(parsed.paperKey, parsed.quality.status, parsed.quality.pages);
const hits = await searchPaperText({
  workspaceDir: process.cwd(),
  paperKey: parsed.paperKey,
  query: "superconducting",
  maxResults: 2
});
console.log(JSON.stringify(hits.results, null, 2));
'
```

Validated result:

```text
arxiv-2406.06015 good 35
```

## Agent Usage

After downloading a paper:

```text
parse_paper with recordPath knowledge-base/sources/arxiv-2406.06015/acquisition.json
inspect_paper with paperKey arxiv-2406.06015
search_paper_text with paperKey arxiv-2406.06015 and query superconducting
read_paper_section with paperKey arxiv-2406.06015 and sectionId section-0003
```

The default `parse_paper` engine is `auto`, which starts with `opendataloader-local`.
If OpenDataLoader fails on a difficult PDF, for example because Java runs out of heap while parsing malformed embedded fonts, the reader automatically falls back to Docling first and then to `plain-text-baseline` if Docling also fails. The baseline extracts decoded PDF content streams where possible, so it can produce usable searchable markdown instead of raw PDF object syntax.
