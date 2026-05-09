#!/usr/bin/env node
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wikiRoot = path.resolve(process.env.PI_WIKI_DIR || path.join(repoRoot, "knowledge-base"));
const host = process.env.WIKI_HOST || "127.0.0.1";
const port = Number(process.env.WIKI_PORT || 4177);

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJoin(relativePath = "") {
  const decoded = decodeURIComponent(relativePath).replaceAll("\\", "/");
  const normalized = path.posix.normalize(decoded).replace(/^(\.\.\/)+/, "");
  const absolute = path.resolve(wikiRoot, normalized);
  if (!absolute.startsWith(wikiRoot + path.sep) && absolute !== wikiRoot) {
    throw new Error("Path escapes wiki root");
  }
  return { absolute, relative: path.relative(wikiRoot, absolute).replaceAll("\\", "/") };
}

function titleFromPath(relativePath) {
  if (!relativePath || relativePath === "index.md") return "Paper LLM Wiki";
  return path.basename(relativePath, ".md").replaceAll("-", " ");
}

function hrefFor(relativePath) {
  const clean = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!clean || clean === ".") return "/";
  if (clean.endsWith(".md")) return `/view/${encodeURIComponent(clean).replaceAll("%2F", "/")}`;
  return `/dir/${encodeURIComponent(clean).replaceAll("%2F", "/")}`;
}

function renderInline(input, currentDir) {
  let html = escapeHtml(input);
  const code = [];
  html = html.replace(/`([^`]+)`/g, (_, value) => {
    code.push(`<code>${value}</code>`);
    return `\u0000CODE${code.length - 1}\u0000`;
  });
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, target) => {
    const url = resolveLink(target, currentDir, true);
    return `<img src="${escapeHtml(url)}" alt="${alt}">`;
  });
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => {
    const url = resolveLink(target, currentDir, false);
    const external = /^https?:\/\//.test(target) ? ' target="_blank" rel="noreferrer"' : "";
    return `<a href="${escapeHtml(url)}"${external}>${label}</a>`;
  });
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_, label) => {
    const slug = label.split("|")[0].trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
    const text = label.includes("|") ? label.split("|").slice(1).join("|").trim() : label;
    return `<a href="/view/pages/${encodeURIComponent(slug)}.md">${escapeHtml(text)}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => code[Number(index)]);
  return html;
}

function resolveLink(target, currentDir, raw) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [filePart, hashPart] = target.split("#");
  const relative = path.posix.normalize(path.posix.join(currentDir, filePart));
  const hash = hashPart ? `#${hashPart}` : "";
  if (raw || !relative.endsWith(".md")) {
    return `/raw/${encodeURIComponent(relative).replaceAll("%2F", "/")}${hash}`;
  }
  return `${hrefFor(relative)}${hash}`;
}

function stripFrontMatter(markdown) {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---\n", 4);
  return end === -1 ? markdown : markdown.slice(end + 5).replace(/^\n+/, "");
}

function frontMatter(markdown) {
  if (!markdown.startsWith("---\n")) return "";
  const end = markdown.indexOf("\n---\n", 4);
  return end === -1 ? "" : markdown.slice(4, end);
}

function renderMarkdown(markdown, relativePath) {
  const currentDir = path.posix.dirname(relativePath);
  const lines = stripFrontMatter(markdown).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let list = null;
  let codeFence = null;
  let codeBuffer = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join(" "), currentDir)}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (codeFence) {
        out.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
        codeFence = null;
        codeBuffer = [];
      } else {
        flushParagraph();
        flushList();
        codeFence = fence[1] || "text";
      }
      continue;
    }
    if (codeFence) {
      codeBuffer.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const text = renderInline(heading[2], currentDir);
      out.push(`<h${level}>${text}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextList = unordered ? "ul" : "ol";
      if (list !== nextList) {
        flushList();
        out.push(`<${nextList}>`);
        list = nextList;
      }
      out.push(`<li>${renderInline((unordered || ordered)[1], currentDir)}</li>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${renderInline(quote[1], currentDir)}</blockquote>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      out.push("<hr>");
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  if (codeFence) out.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
  return out.join("\n");
}

async function listMarkdownFiles(dir = wikiRoot) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.relative(wikiRoot, absolute).replaceAll("\\", "/"));
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function extractYamlList(markdown, key) {
  const lines = frontMatter(markdown).split("\n");
  const values = [];
  let inList = false;
  for (const line of lines) {
    if (new RegExp(`^${key}:\\s*$`).test(line)) {
      inList = true;
      continue;
    }
    if (inList && /^[a-zA-Z_]+:\s*/.test(line)) break;
    const item = inList ? line.match(/^\s*-\s+"?([^"]+)"?\s*$/) : null;
    if (item) values.push(item[1].trim());
  }
  return values;
}

async function buildGraphData() {
  const pageFiles = await listMarkdownFiles(path.join(wikiRoot, "pages")).catch(() => []);
  const pageBySlug = new Map(pageFiles.map((file) => [path.basename(file, ".md"), file]));
  const nodes = [];
  const edges = new Map();

  const addEdge = (from, to, type) => {
    if (!from || !to || from === to || !pageBySlug.has(to)) return;
    const key = [from, to].sort().join("::");
    const existing = edges.get(key);
    if (existing) {
      existing.weight += type === "related" ? 2 : 1;
      existing.types.add(type);
    } else {
      edges.set(key, { source: from, target: to, weight: type === "related" ? 2 : 1, types: new Set([type]) });
    }
  };

  for (const file of pageFiles) {
    const slug = path.basename(file, ".md");
    const markdown = await readFile(path.join(wikiRoot, file), "utf8");
    const title = markdown.match(/^title:\s+"([^"]+)"/m)?.[1] || titleFromPath(file);
    const tags = extractYamlList(markdown, "tags");
    const related = extractYamlList(markdown, "related_pages");
    nodes.push({ id: slug, title, path: file, tags, href: hrefFor(file) });
    for (const target of related) addEdge(slug, target, "related");

    for (const match of markdown.matchAll(/\]\((pages\/[^)#]+\.md|\.\/[^)#]+\.md|\.\.\/pages\/[^)#]+\.md)\)/g)) {
      const targetPath = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      addEdge(slug, path.basename(targetPath, ".md"), "link");
    }
    for (const match of markdown.matchAll(/\[([a-z0-9][a-z0-9-]{2,})\]/g)) {
      addEdge(slug, match[1], "reference");
    }
  }

  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges.values()) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + edge.weight);
    degree.set(edge.target, (degree.get(edge.target) || 0) + edge.weight);
  }
  for (const node of nodes) node.degree = degree.get(node.id) || 0;

  return {
    nodes: nodes.sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title)),
    links: [...edges.values()].map((edge) => ({
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
      types: [...edge.types],
    })),
  };
}

async function buildSidebar(activePath) {
  const pages = await listMarkdownFiles(path.join(wikiRoot, "pages")).catch(() => []);
  const sourceCount = await listMarkdownFiles(path.join(wikiRoot, "sources")).then((files) => files.length).catch(() => 0);
  const links = [
    `<a class="${activePath === "index.md" ? "active" : ""}" href="/">Index</a>`,
    `<a class="${activePath === "__graph__" ? "active" : ""}" href="/graph">Concept Graph</a>`,
    `<a href="/dir/pages">Knowledge Pages</a>`,
    `<a href="/dir/sources">Sources (${sourceCount})</a>`,
    ...pages.map((file) => {
      const title = titleFromPath(file);
      return `<a class="${activePath === file ? "active" : ""}" href="${hrefFor(file)}">${escapeHtml(title)}</a>`;
    }),
  ];
  return `<aside><input id="filter" placeholder="Filter pages"><nav>${links.join("\n")}</nav></aside>`;
}

async function renderPage(relativePath) {
  const { absolute, relative } = safeJoin(relativePath || "index.md");
  const markdown = await readFile(absolute, "utf8");
  const html = renderMarkdown(markdown, relative);
  return layout(titleFromPath(relative), await buildSidebar(relative), `<article>${html}</article>`);
}

async function renderDirectory(relativePath) {
  const { absolute, relative } = safeJoin(relativePath || ".");
  const entries = await readdir(absolute, { withFileTypes: true });
  const items = entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => {
      const child = path.posix.join(relative, entry.name);
      const label = entry.isDirectory() ? `${entry.name}/` : entry.name;
      return `<li><a href="${hrefFor(child)}">${escapeHtml(label)}</a></li>`;
    });
  return layout(titleFromPath(relative), await buildSidebar(""), `<article><h1>${escapeHtml(relative || "wiki")}</h1><ul class="directory">${items.join("\n")}</ul></article>`);
}

async function renderGraph() {
  return layout("Concept Graph", await buildSidebar("__graph__"), `<section class="graph-page">
  <div class="graph-toolbar">
    <div>
      <h1>Concept Graph</h1>
      <p>Nodes are wiki pages. Edges come from <code>related_pages</code> and local page references.</p>
    </div>
    <input id="graph-search" placeholder="Search concepts">
  </div>
  <svg id="graph" role="img" aria-label="Concept graph"></svg>
  <aside id="graph-detail" class="graph-detail">Select a node.</aside>
</section>
<script>
async function drawGraph() {
  const data = await fetch("/graph-data.json").then((response) => response.json());
  const svg = document.getElementById("graph");
  const detail = document.getElementById("graph-detail");
  const search = document.getElementById("graph-search");
  const width = svg.clientWidth || 900;
  const height = Math.max(620, window.innerHeight - 190);
  svg.setAttribute("viewBox", [0, 0, width, height].join(" "));

  const nodes = data.nodes.map((node, index) => ({
    ...node,
    x: width / 2 + Math.cos(index) * width * 0.28,
    y: height / 2 + Math.sin(index) * height * 0.28,
    vx: 0,
    vy: 0
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = data.links
    .map((link) => ({ ...link, source: byId.get(link.source), target: byId.get(link.target) }))
    .filter((link) => link.source && link.target);

  const linkGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.append(linkGroup, nodeGroup);

  const linkEls = links.map((link) => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("stroke-width", String(Math.min(4, 0.8 + link.weight * 0.35)));
    line.dataset.source = link.source.id;
    line.dataset.target = link.target.id;
    linkGroup.append(line);
    return line;
  });

  const nodeEls = nodes.map((node) => {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("graph-node");
    group.dataset.id = node.id;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", String(5 + Math.min(13, Math.sqrt(node.degree + 1) * 2.2)));
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = node.title;
    group.append(circle, title);
    group.addEventListener("click", () => {
      document.querySelectorAll(".graph-node").forEach((item) => item.classList.toggle("selected", item === group));
      const neighbors = links.filter((link) => link.source.id === node.id || link.target.id === node.id)
        .map((link) => link.source.id === node.id ? link.target : link.source)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 12);
      detail.innerHTML = '<h2>' + escapeHtmlClient(node.title) + '</h2>' +
        '<p><a href="' + node.href + '">Open page</a></p>' +
        '<p><strong>Degree:</strong> ' + node.degree + '</p>' +
        '<p><strong>Tags:</strong> ' + node.tags.slice(0, 8).map(escapeHtmlClient).join(", ") + '</p>' +
        '<h3>Connected concepts</h3><ul>' + neighbors.map((item) => '<li><a href="' + item.href + '">' + escapeHtmlClient(item.title) + '</a></li>').join("") + '</ul>';
    });
    nodeGroup.append(group);
    return group;
  });

  function tick() {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const distance2 = Math.max(80, dx * dx + dy * dy);
        const force = 850 / distance2;
        dx = dx || 0.01;
        dy = dy || 0.01;
        a.vx -= dx * force; a.vy -= dy * force;
        b.vx += dx * force; b.vy += dy * force;
      }
    }
    for (const link of links) {
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const desired = 95 - Math.min(35, link.weight * 5);
      const force = (distance - desired) * 0.012;
      const fx = dx / distance * force;
      const fy = dy / distance * force;
      link.source.vx += fx; link.source.vy += fy;
      link.target.vx -= fx; link.target.vy -= fy;
    }
    for (const node of nodes) {
      node.vx += (width / 2 - node.x) * 0.002;
      node.vy += (height / 2 - node.y) * 0.002;
      node.vx *= 0.83;
      node.vy *= 0.83;
      node.x = Math.max(18, Math.min(width - 18, node.x + node.vx));
      node.y = Math.max(18, Math.min(height - 18, node.y + node.vy));
    }
    for (let i = 0; i < links.length; i++) {
      const link = links[i], line = linkEls[i];
      line.setAttribute("x1", link.source.x);
      line.setAttribute("y1", link.source.y);
      line.setAttribute("x2", link.target.x);
      line.setAttribute("y2", link.target.y);
    }
    for (let i = 0; i < nodes.length; i++) {
      nodeEls[i].setAttribute("transform", "translate(" + nodes[i].x + "," + nodes[i].y + ")");
    }
  }
  for (let i = 0; i < 320; i++) tick();
  function animate() { tick(); requestAnimationFrame(animate); }
  animate();

  search.addEventListener("input", () => {
    const query = search.value.toLowerCase();
    nodeEls.forEach((group, index) => {
      const node = nodes[index];
      const matched = !query || node.title.toLowerCase().includes(query) || node.tags.join(" ").toLowerCase().includes(query);
      group.classList.toggle("dimmed", !matched);
    });
  });
}
function escapeHtmlClient(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
drawGraph();
</script>`);
}

function layout(title, sidebar, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --bg:#f7f7f4; --panel:#ffffff; --text:#202124; --muted:#6a6f73; --line:#deded8; --accent:#166d62; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    .shell { display: grid; grid-template-columns: minmax(220px, 320px) minmax(0, 1fr); min-height: 100vh; }
    aside { border-right: 1px solid var(--line); background: #f0f1ed; padding: 14px; position: sticky; top: 0; height: 100vh; overflow: auto; }
    input { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 9px 10px; margin-bottom: 12px; background: #fff; }
    nav a { display: block; color: #303437; text-decoration: none; padding: 7px 8px; border-radius: 6px; font-size: 14px; line-height: 1.25; }
    nav a:hover, nav a.active { background: #dfe9e5; color: var(--accent); }
    main { padding: 36px min(7vw, 90px); }
    article { max-width: 980px; margin: 0 auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 34px 42px; }
    h1, h2, h3 { line-height: 1.2; margin: 1.4em 0 .55em; }
    h1 { margin-top: 0; font-size: 30px; }
    h2 { font-size: 22px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
    h3 { font-size: 18px; }
    p, li, blockquote { line-height: 1.72; }
    a { color: var(--accent); }
    code { background: #eef1ee; border: 1px solid #dde2df; border-radius: 4px; padding: 1px 4px; }
    pre { overflow: auto; background: #1f2523; color: #f0f3ef; padding: 16px; border-radius: 8px; }
    pre code { background: transparent; color: inherit; border: 0; padding: 0; }
    blockquote { border-left: 4px solid var(--line); color: var(--muted); margin-left: 0; padding-left: 14px; }
    img { max-width: 100%; height: auto; }
    .directory { columns: 2; }
    .graph-page { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 16px; }
    .graph-toolbar { grid-column: 1 / -1; display: flex; gap: 18px; align-items: end; justify-content: space-between; }
    .graph-toolbar h1 { margin: 0 0 4px; }
    .graph-toolbar p { margin: 0; color: var(--muted); }
    #graph-search { width: min(360px, 100%); margin: 0; }
    #graph { width: 100%; height: min(72vh, 760px); min-height: 560px; background: #fbfbf8; border: 1px solid var(--line); border-radius: 8px; }
    #graph line { stroke: #9fb3ad; stroke-opacity: .42; }
    .graph-node circle { fill: #177266; stroke: #ffffff; stroke-width: 1.5; cursor: pointer; }
    .graph-node:hover circle, .graph-node.selected circle { fill: #b3482d; }
    .graph-node.dimmed { opacity: .16; }
    .graph-detail { position: static; height: min(72vh, 760px); min-height: 560px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; overflow: auto; }
    .graph-detail h2 { font-size: 18px; margin-top: 0; }
    .graph-detail h3 { font-size: 15px; }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      aside { position: relative; height: 42vh; border-right: 0; border-bottom: 1px solid var(--line); }
      main { padding: 18px; }
      article { padding: 24px; }
      .directory { columns: 1; }
      .graph-page { grid-template-columns: 1fr; }
      .graph-toolbar { display: block; }
      #graph, .graph-detail { min-height: 420px; height: 55vh; }
    }
  </style>
</head>
<body>
  <div class="shell">${sidebar}<main>${body}</main></div>
  <script>
    const filter = document.getElementById("filter");
    filter?.addEventListener("input", () => {
      const query = filter.value.toLowerCase();
      document.querySelectorAll("nav a").forEach((link) => {
        link.style.display = link.textContent.toLowerCase().includes(query) ? "" : "none";
      });
    });
  </script>
</body>
</html>`;
}

function notFound(response, message = "Not found") {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/index.md") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(await renderPage("index.md"));
      return;
    }
    if (url.pathname === "/graph") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(await renderGraph());
      return;
    }
    if (url.pathname === "/graph-data.json") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(await buildGraphData()));
      return;
    }
    if (url.pathname.startsWith("/view/")) {
      const relativePath = url.pathname.slice("/view/".length);
      const { absolute } = safeJoin(relativePath);
      if (!(await stat(absolute)).isFile()) return notFound(response);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(await renderPage(relativePath));
      return;
    }
    if (url.pathname.startsWith("/dir/")) {
      const relativePath = url.pathname.slice("/dir/".length);
      const { absolute } = safeJoin(relativePath);
      if (!(await stat(absolute)).isDirectory()) return notFound(response);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(await renderDirectory(relativePath));
      return;
    }
    if (url.pathname.startsWith("/raw/")) {
      const relativePath = url.pathname.slice("/raw/".length);
      const { absolute } = safeJoin(relativePath);
      if (!(await stat(absolute)).isFile()) return notFound(response);
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(await readFile(absolute));
      return;
    }
    notFound(response);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  console.log(`Wiki web viewer: http://${host}:${port}`);
  console.log(`Serving: ${wikiRoot}`);
});
