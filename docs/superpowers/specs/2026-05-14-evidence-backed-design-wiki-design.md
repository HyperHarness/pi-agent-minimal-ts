# Evidence-Backed Design Wiki Design

## Context

The current wiki is strongest when it starts from scientific papers: download or parse a paper, write a source summary, then synthesize a page from those paper-backed summaries. That is useful for literature review, but it is too narrow for the larger goal: using the knowledge base to design superconducting quantum chips.

Superconducting chip design depends on evidence that is not always a paper:

- material parameters such as permittivity, loss tangent, kinetic inductance, surface participation assumptions, and cryogenic thermal properties;
- software documentation for EM simulation, layout generation, circuit extraction, optimization, calibration, and verification workflows;
- vendor notes, standards, lab notes, measurement logs, local scripts, generated reports, and code outputs;
- design decisions that combine literature, parameters, simulations, and engineering constraints.

The repository already has the right direction in its schema-first wiki core. `page-schema.ts` supports page types such as `concept`, `method`, `finding`, `dataset`, and `design-record`, plus claim provenance, typed relations, experiment references, and reviewer critique. The main gap is that the source side is still paper-shaped: source manifests use `kind: "paper-source"` and `paperKey`, and source summaries are read through paper-specific paths.

This design turns the wiki from a paper-backed literature wiki into an evidence-backed design wiki while preserving the current acquisition, summary, page, lint, and retrieval architecture.

## Goals

1. Make non-paper evidence a first-class source type without creating a separate wiki system.
2. Keep `pages/` organized around chip-design knowledge and decisions, not around individual files or URLs.
3. Preserve current paper workflows and paper-backed pages.
4. Let material parameters and software documentation participate in the same retrieval, provenance, lint, and page-building flow as papers.
5. Add practical page templates for `dataset`, `method`, `finding`, and `design-record` pages used in superconducting quantum chip design.
6. Strengthen source/page provenance enough that later design agents can distinguish measured values, assumptions, documentation-derived procedures, simulation outputs, and literature claims.

## Non-Goals

- No new standalone wiki agent.
- No large ontology or graph database migration.
- No forced migration of every existing paper source or synthesis page in the first implementation.
- No automatic trust in vendor/software documentation as scientific truth.
- No automatic execution of simulation tools such as HFSS, Qiskit Metal, pyEPR, scqubits, or custom design scripts.
- No background crawler for software docs, material databases, or vendor sites.

## Recommended Approach

Use a unified evidence model with typed source kinds. Papers remain one source kind, but material documents, software docs, design artifacts, and code outputs become source kinds too. The existing `retrieval-contract.ts` should remain the downstream boundary: builders and workers ask for evidence items, not raw files.

Rejected alternatives:

- Treat non-paper documents as fake paper sources. This is fast but damages semantics, because material values and software procedures do not have paper keys, PDF provenance, or citation completeness in the same sense.
- Build a separate material/software wiki. This duplicates indexing, retrieval, lint, and graph logic, and it makes design pages harder to ground across evidence types.
- Start with a full ontology. That may become useful later, but the current codebase already has typed pages and source manifests. The useful next step is to generalize those contracts, not replace them.

## Source Model

Introduce a generalized source manifest while keeping paper manifests readable.

```ts
type WikiSourceKind =
  | "paper"
  | "material-database"
  | "software-doc"
  | "vendor-note"
  | "standard"
  | "lab-note"
  | "code-output"
  | "design-artifact"
  | "webpage"
  | "manual";

type WikiSourceStatus =
  | "ready"
  | "stale"
  | "blocked"
  | "low_quality"
  | "citation_incomplete"
  | "missing_artifact"
  | "version_unknown"
  | "needs_review";

interface WikiSourceManifestV2 {
  schemaVersion: 2;
  sourceKind: WikiSourceKind;
  sourceKey: string;
  title: string;
  status: WikiSourceStatus;
  createdAt: string;
  updatedAt: string;
  summaryPath: string;
  provenance: {
    url?: string;
    doi?: string;
    arxivId?: string;
    recordPath?: string;
    rawPath?: string;
    rawSha256?: string;
    retrievedAt?: string;
    version?: string;
    softwareName?: string;
    softwareVersion?: string;
    vendor?: string;
    license?: string;
  };
  artifacts: Array<{
    kind: "raw" | "parse" | "table" | "figure" | "script" | "result" | "log" | "snapshot";
    path: string;
    engine?: string;
    qualityPath?: string;
    note?: string;
  }>;
  tags: string[];
  relatedSourceKeys: string[];
  synthesisPageKeys: string[];
}
```

Compatibility rules:

- Existing `schemaVersion: 1`, `kind: "paper-source"`, and `paperKey` manifests remain valid.
- Retrieval should map old manifests into the V2 shape internally with `sourceKind: "paper"` and `sourceKey = paperKey`.
- Existing paper source paths can remain under `knowledge-base/sources/<paper-key>/` during the transition.
- New non-paper source directories should also live under `knowledge-base/sources/<source-key>/` unless a later storage plan splits them by source kind.

## Page Model

Keep the current page schema and use page types deliberately:

- `concept`: stable explanatory knowledge, such as dielectric loss, package modes, frequency crowding, surface participation, Purcell loss, or flux noise.
- `dataset`: parameter tables and curated factual datasets, such as substrate/film material parameters, cryogenic attenuation components, or fabrication process windows.
- `method`: procedures and workflows, such as HFSS eigenmode simulation, GDS-to-EM simulation, frequency-allocation optimization, package-mode risk review, or calibration-loop diagnosis.
- `finding`: evidence-backed conclusions, such as a suspected package-mode risk, a parameter sensitivity result, or a comparison between two gate architectures.
- `design-record`: a maintained design decision record, such as a minimal superconducting qLDPC chip revision, a packaging choice, or a frequency-plan decision.

Do not create pages for every imported document by default. A source summary is enough for individual documents. A page should exist when the knowledge is durable, reusable, and design-relevant.

## Page Templates

### Material Parameter Dataset

Use `type: "dataset"` and `evidence_contract: "mixed"` or `source_refs` that point to material documents, vendor notes, papers, and lab notes.

Required sections:

- `Parameter Table`: material, parameter, value, unit, condition, confidence, source.
- `Applicability`: frequency range, temperature, process assumptions, geometry assumptions, and simulation context.
- `Design Implications`: how the parameter affects coherence, resonator Q, impedance, package modes, coupling, thermalization, or fabrication yield.
- `Known Uncertainty`: room-temperature versus cryogenic values, missing process context, conflicting sources, or fitted values.
- `Related Pages`: design and method pages that consume the dataset.

Quantitative rows should become `claims` with concrete source evidence whenever they are promoted into page metadata.

### Software Documentation Method

Use `type: "method"` for stable workflows extracted from software docs.

Required sections:

- `Goal`: the design question this workflow answers.
- `Inputs`: geometry, material table, boundary conditions, ports, frequency range, scripts, and tool versions.
- `Procedure`: a concise workflow that an agent can follow or check.
- `Outputs`: mode frequencies, fields, participation, S-parameters, capacitance matrices, logs, or risk flags.
- `Failure Modes`: convergence failure, wrong boundary conditions, stale software version, missing material assumptions, and unsupported geometry.
- `Design Use`: how outputs feed a design record or finding page.

Software docs should include software name and version in source provenance when available.

### Finding Page

Use `type: "finding"` when several evidence items support a design-relevant conclusion.

Required sections:

- `Claim`: the conclusion in one paragraph.
- `Evidence`: direct sources, parameter tables, simulation outputs, and relevant papers.
- `Scope`: where the claim applies and where it does not.
- `Confidence`: high, medium, or low, with reason.
- `Implications`: what a chip design agent should change or check.
- `Contradictions or Open Checks`: conflicting evidence and unresolved validation steps.

### Design Record Page

Use `type: "design-record"` for maintained design decisions.

Required sections:

- `Decision`: the selected design choice.
- `Context`: design objective, constraints, target architecture, and assumptions.
- `Evidence Used`: pages and source keys consumed by the decision.
- `Alternatives Considered`: rejected options and why.
- `Verification Plan`: scripts, simulations, experiments, or manual checks.
- `Status`: proposed, active, superseded, blocked, or retired.

Design records should use typed relations:

- `uses` dataset and method pages;
- `supports` finding pages;
- `implementation_of` code or design artifacts;
- `open_problem_for` unresolved checks.

## Retrieval and Page-Building Flow

The new flow should be:

1. Ingest or register a source.
2. Store raw artifact, parse artifact, or summary under `knowledge-base/sources/<source-key>/`.
3. Write a generalized source manifest.
4. Generate or update a grounded source summary.
5. Expose the source through `retrieval-contract.ts` as a normal evidence item.
6. Build or update a page only when the answer is durable enough to become reusable design knowledge.
7. Run wiki lint/health to report missing source version, missing units, weak quantitative provenance, stale software docs, and design records without evidence links.

Example query behavior:

- If the user asks for sapphire substrate parameters, build or update a `dataset` page, not a paper page.
- If the user asks how to run HFSS eigenmode simulation for package modes, build or update a `method` page grounded in software docs and existing material datasets.
- If the user asks whether a packaging choice is risky, build or update a `finding` or `design-record` page using papers, material datasets, software-method pages, and simulation outputs.

## Tooling Strategy

Enhance existing wiki tools instead of adding many new tools.

- `build_wiki_page`: add source-kind-aware planning and page template selection.
- `search_paper_wiki`: eventually rename or alias to a more general search name, but preserve the existing tool during migration.
- `write_paper_wiki_source`: introduce a generalized source-writing path while keeping the paper-specific wrapper.
- `wiki_lint`: add deterministic checks for non-paper source quality and design-page grounding.
- `wiki_health`: keep download/parse checks for papers, but add source-kind-specific health checks for missing raw artifacts, missing version, malformed material tables, and stale software docs.

The first implementation should avoid a broad new tool surface. One or two generalized helpers can sit underneath the existing public tools until the behavior is stable.

## Lint and Health Rules

Add deterministic checks:

- Material dataset has quantitative values without units.
- Material dataset has quantitative values without condition notes such as temperature, frequency, process, or geometry when applicable.
- Software doc source lacks software name or version when the source claims to describe a software workflow.
- Method page has no inputs or outputs section.
- Design record has no `uses` relation to any dataset, method, source, or finding.
- Finding page has no claim provenance.
- Mixed evidence page cites only synthesis pages and no source summaries.
- Source manifest has `sourceKind: "software-doc"` and a stale `retrievedAt` or missing `version`.

These checks should produce actionable diagnostics, not automatic rewrites.

## Migration Plan

Phase 1: schema and retrieval compatibility.

- Add V2 source manifest types.
- Keep V1 paper manifests readable.
- Map V1 paper manifests into the generalized retrieval item shape.
- Add tests for paper-source backward compatibility and non-paper source listing.

Phase 2: non-paper source registration and summaries.

- Add a generalized source summary writer.
- Keep paper-specific wrappers working.
- Support at least `software-doc`, `material-database`, `vendor-note`, `lab-note`, and `code-output` in tests.

Phase 3: page template integration.

- Teach page building to choose `dataset`, `method`, `finding`, or `design-record` templates based on intent and evidence.
- Preserve current synthesis-page behavior for literature-review topics.

Phase 4: lint and health.

- Add source-kind-specific diagnostics.
- Add page-grounding diagnostics for datasets, methods, findings, and design records.

## Testing Plan

Use repository tests before implementation is considered complete:

1. Manifest-store tests for V2 source manifests and V1 paper manifest compatibility.
2. Retrieval-contract tests showing paper and non-paper sources return the same evidence item shape.
3. Page-schema or typed-store tests for `dataset`, `method`, `finding`, and `design-record` pages with claims and typed relations.
4. Lint tests for missing units, missing source versions, missing method inputs/outputs, and ungrounded design records.
5. Tool tests showing existing paper workflows still pass through old wrappers.
6. A small fixture-based test for a material parameter source and a software documentation source.

Full validation remains `npm test` from the repository root.

## Open Decisions for the Implementation Plan

1. Whether to rename public tools now or keep compatibility wrappers for one release.
2. Whether non-paper source keys should include source-kind prefixes such as `software-doc-hfss-eigenmode` and `material-sapphire-permittivity`.
3. Whether material parameter rows should be stored only in Markdown tables first or also in structured JSON artifacts.
4. Whether software documentation freshness should be user-triggered only or exposed through a low-frequency explicit health check later.

The recommended first implementation is schema/retrieval compatibility plus deterministic lint fixtures. Worker prompt and tool naming changes should come after the data contract is stable.
