#set page(paper: "a4", flipped: true, margin: 20pt)
#set text(font: "DejaVu Sans", size: 8.5pt)
#set par(justify: false, leading: 0.42em)

#let blue = rgb("#e8f1ff")
#let green = rgb("#eaf7ef")
#let amber = rgb("#fff3d6")
#let violet = rgb("#f1edff")
#let red = rgb("#ffecec")
#let gray = rgb("#f8fafc")
#let ink = rgb("#172033")
#let muted = rgb("#536174")
#let stroke = rgb("#9aa7bb")

#let node(title, body, fill: gray) = block(
  width: 100%,
  fill: fill,
  stroke: 0.75pt + stroke,
  radius: 5pt,
  inset: 6pt,
)[
  #text(fill: ink, weight: "bold", size: 9pt)[#title]
  #v(2pt)
  #text(fill: muted, size: 7.4pt)[#body]
]

#let arr(label: "") = align(center + horizon)[
  #text(fill: muted, size: 6.8pt)[#label]
  #linebreak()
  #text(fill: muted, size: 15pt)[->]
]

#let section-title(title) = block(
  width: 100%,
  fill: rgb("#0f172a"),
  radius: 4pt,
  inset: (x: 7pt, y: 4pt),
)[
  #text(fill: white, weight: "bold", size: 9pt)[#title]
]

#let flow-four(a, b, c, d, labels: ("", "", "")) = grid(
  columns: (1fr, 22pt, 1fr, 22pt, 1fr, 22pt, 1fr),
  gutter: 5pt,
  a, arr(label: labels.at(0)), b, arr(label: labels.at(1)), c, arr(label: labels.at(2)), d,
)

#let flow-five(a, b, c, d, e, labels: ("", "", "", "")) = grid(
  columns: (1fr, 21pt, 1fr, 21pt, 1fr, 21pt, 1fr, 21pt, 1fr),
  gutter: 4pt,
  a, arr(label: labels.at(0)), b, arr(label: labels.at(1)), c, arr(label: labels.at(2)), d, arr(label: labels.at(3)), e,
)

#align(center)[
  #text(size: 16pt, weight: "bold", fill: ink)[Stable Workflows in pi-agent-minimal-ts]
]

#v(3pt)

#grid(
  columns: (1fr, 1fr),
  gutter: 10pt,
)[
  #section-title("1. Paper acquisition and readable-source closure")
  #v(4pt)
  #flow-five(
    node("Search or URL", "search_papers or a direct article / arXiv URL", fill: blue),
    node("Download / Queue", "download_paper uses arXiv direct paths or extension bridge for publishers", fill: amber),
    node("Parse / Webpage capture", "Preferred readable source: webpage / TeX / PDF parser artifacts", fill: green),
    node("Acquisition state", "wiki/sources/<paperKey>/acquisition.json plus raw PDFs and parse manifests", fill: gray),
    node("Ready for reading", "inspect_paper, read_paper_section, search_paper_text", fill: violet),
    labels: ("select", "acquire", "persist", "read"),
  )
][
  #section-title("2. Source-summary generation")
  #v(4pt)
  #flow-four(
    node("Parsed paper", "Good parse or webpage artifact is available", fill: green),
    node("Evidence package", "Bounded Markdown, quality report, sections, related candidates", fill: blue),
    node("Clean worker", "generate_paper_wiki_summary runs a no-history subagent", fill: violet),
    node("Source summary", "wiki/sources/<paper-key>.md with provenance and tags", fill: amber),
    labels: ("build", "summarize", "write"),
  )
]

#v(8pt)

#grid(
  columns: (1fr, 1fr),
  gutter: 10pt,
)[
  #section-title("3. Evidence-first professional Q&A")
  #v(4pt)
  #flow-five(
    node("User question", "Scientific / technical / literature-comparison question", fill: blue),
    node("Local wiki search", "answer_research_question searches source summaries and pages first", fill: green),
    node("Enough evidence?", "If yes: answer from local evidence only", fill: amber),
    node("External acquisition", "If no: search papers, download, parse, summarize", fill: red),
    node("Refreshed answer", "Search wiki again, then answer with citations", fill: violet),
    labels: ("ask", "retrieve", "branch", "ingest"),
  )
][
  #section-title("4. New wiki page bootstrap")
  #v(4pt)
  #flow-five(
    node("Topic / question", "No durable page may exist yet", fill: blue),
    node("Seed queries", "bootstrap_wiki_page_evidence creates deterministic query variants", fill: green),
    node("Source-first retrieval", "Search source summaries, then expand by tags and related_papers", fill: amber),
    node("Parsed fallback", "Find parsed papers that need source summaries; optionally generate them", fill: red),
    node("Synthesis page", "build_wiki_page uses clean page worker and writes pages/<page-key>.md", fill: violet),
    labels: ("derive", "search", "expand", "write"),
  )
]

#v(8pt)

#grid(
  columns: (1fr, 1fr),
  gutter: 10pt,
)[
  #section-title("5. Wiki health and repair")
  #v(4pt)
  #flow-four(
    node("Health scan", "wiki_health checks download, authorization, queue, parse, quality, summary, artifacts", fill: blue),
    node("Auto repair", "wiki_health_fix retries download / parse / summary where deterministic", fill: green),
    node("User action", "Authorization and queued extension work are reported with reasons", fill: amber),
    node("Recheck", "Run wiki_health again after browser/login/manual steps", fill: violet),
    labels: ("diagnose", "fix", "explain"),
  )
][
  #section-title("6. Wiki structure lint")
  #v(4pt)
  #flow-four(
    node("Structure scan", "wiki_lint checks index, source citations, links, pages, repeated tags", fill: blue),
    node("Find gaps", "stale_index, broken_wiki_link, missing_source_citation, orphan_page, concept_gap", fill: amber),
    node("Build pages", "concept_gap points to topics for build_wiki_page", fill: green),
    node("Graph hygiene", "Pages become easier to search and maintain", fill: violet),
    labels: ("lint", "prioritize", "maintain"),
  )
]

#v(10pt)

#block(fill: rgb("#f8fafc"), stroke: 0.6pt + stroke, radius: 5pt, inset: 7pt)[
  #text(weight: "bold", fill: ink)[Stable core idea:]
  #text(fill: muted)[ keep raw papers as immutable evidence, promote parsed papers into source summaries, answer from wiki evidence first, and only build durable pages from citeable source summaries.]
]
