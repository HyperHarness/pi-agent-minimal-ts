# Local Wiki Web And Concept Graph Guide

This guide is for another agent that needs to inspect the local paper/wiki graph without reverse-engineering the code.

Use this when the user wants a browser-based view of the WSL-native wiki, especially when Windows Obsidian has trouble opening the WSL vault path or when copying the wiki to `D:` is not acceptable.

## What This Serves

The source of truth is the WSL wiki directory:

```text
knowledge-base
```

All paths in this document are relative to the repository root unless an environment variable explicitly says otherwise.

The viewer is a small Node.js HTTP server:

```text
scripts/wiki-web.mjs
```

It reads the wiki directly from WSL. It does not copy files to Windows, does not upload content, and does not require Obsidian.

## Quick Start

Run from the repository root:

```sh
npm run wiki:web
```

Expected startup output:

```text
Wiki web viewer: http://127.0.0.1:4177
Serving: <repo-root>/knowledge-base
```

Open these URLs from the Windows browser:

```text
http://localhost:4177/
http://localhost:4177/graph
```

Use `/` for the Markdown wiki reader. Use `/graph` for concept relationships.

## Main Endpoints

```text
/                         Render index.md
/graph                    Interactive concept graph
/graph-data.json          Machine-readable graph JSON
/view/<path>.md           Render a Markdown file
/dir/<path>               Browse a wiki directory
/raw/<path>               Return a raw wiki asset or file
```

Examples:

```text
http://localhost:4177/view/pages/superconducting-qubits.md
http://localhost:4177/dir/pages
http://localhost:4177/dir/sources
```

## What The Graph Means

The graph is a concept-page graph, not a semantic embedding graph.

Nodes are wiki synthesis pages under:

```text
knowledge-base/pages/*.md
```

Node fields in `/graph-data.json`:

```text
id       Page slug, usually the file basename
title    Frontmatter title, or a fallback title from the filename
path     Relative wiki file path
tags     Frontmatter tags
href     Local web viewer link for the page
degree   Weighted number of graph connections
```

Edges are inferred from existing wiki structure:

```text
related   Frontmatter related_pages entries; weight +2
link      Markdown links to pages/*.md; weight +1
reference Bracket references like [surface-code] when they match an existing page slug; weight +1
```

The graph intentionally ignores edges that do not resolve to an existing page in `pages/`. This keeps the graph focused on durable knowledge entries rather than every paper/source citation.

## How To Use The Graph

Open:

```text
http://localhost:4177/graph
```

Then:

- Use the search box to dim concepts that do not match the query.
- Click a node to show title, degree, tags, and connected concepts.
- Click `Open page` in the detail panel to read the underlying synthesis page.
- Use the left sidebar to switch back to `Index`, `Knowledge Pages`, or individual pages.

For machine inspection, fetch:

```sh
curl --noproxy '*' -s http://127.0.0.1:4177/graph-data.json
```

Example node/link count check:

```sh
curl --noproxy '*' -s http://127.0.0.1:4177/graph-data.json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const g=JSON.parse(s); console.log(g.nodes.length, g.links.length);})"
```

On the original machine after the graph feature was added, this returned:

```text
49 346
```

The exact counts can change as wiki pages are added or edited.

## Configuration

Default settings:

```text
WIKI_HOST=127.0.0.1
WIKI_PORT=4177
PI_WIKI_DIR=<repo-root>/knowledge-base
```

Override them only when needed:

```sh
WIKI_PORT=4180 npm run wiki:web
```

```sh
PI_WIKI_DIR=/absolute/path/to/wiki npm run wiki:web
```

Keep `WIKI_HOST=127.0.0.1` unless the user explicitly wants LAN access. Binding to all interfaces can expose local research notes to the network.

## Troubleshooting

### `listen EPERM: operation not permitted 127.0.0.1:4177`

This usually means the current execution context blocks opening a localhost listener. In Codex sandboxed command execution, rerun the server outside the sandbox or ask for the needed approval. Do not assume the viewer code is broken.

### `EADDRINUSE: address already in use 127.0.0.1:4177`

An old viewer is already running. Find it:

```sh
pgrep -af 'node scripts/wiki-web.mjs|npm run wiki:web'
```

Stop the old process, then restart:

```sh
kill <pid>
npm run wiki:web
```

Or use a different port:

```sh
WIKI_PORT=4180 npm run wiki:web
```

### Browser cannot reach `localhost`

Check from WSL:

```sh
curl --noproxy '*' -I http://127.0.0.1:4177/
curl --noproxy '*' -I http://127.0.0.1:4177/graph
```

Use `--noproxy '*'` because proxy environment variables can interfere with loopback requests.

### Graph page loads but has no useful links

Check that durable pages exist:

```sh
find knowledge-base/pages -maxdepth 1 -type f -name '*.md' | wc -l
```

Check graph data directly:

```sh
curl --noproxy '*' -s http://127.0.0.1:4177/graph-data.json
```

If `nodes` is empty, the server is probably pointed at the wrong `PI_WIKI_DIR`.

If `nodes` exists but `links` is sparse, improve the wiki pages by adding `related_pages` frontmatter or local page references that match existing page slugs.

## When To Use Graphify Instead

This built-in graph is the first choice for this repository because it is local, fast, and reads the existing WSL wiki directly.

Use Graphify or a similar external graph extraction tool only when the user wants an AI-extracted semantic graph across files, PDFs, images, or code beyond the explicit wiki links. That is a different workflow: it may infer new relationships, but it is no longer just showing the current wiki structure.

## Maintenance Notes For Agents

The graph implementation lives in:

```text
scripts/wiki-web.mjs
```

The npm entrypoint lives in:

```text
package.json -> scripts.wiki:web
```

If changing graph extraction, preserve these properties:

- Read directly from `knowledge-base` by default.
- Keep `/graph-data.json` stable enough for agents to inspect.
- Do not require network dependencies or a frontend build step.
- Do not copy the wiki into `D:` or another Windows directory unless the user explicitly asks for a mirror.
- Keep `pages/*.md` as the concept-node layer and `sources/` as evidence/source material.
