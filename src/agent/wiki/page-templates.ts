import type { WikiSourceKind } from "./source-metadata-store.js";
import type { WikiPageType } from "./page-schema.js";

type TemplatePageType = Extract<
  WikiPageType,
  "concept" | "method" | "finding" | "dataset" | "capability-boundary" | "design-record"
>;

export interface WikiPageTemplate {
  pageType: TemplatePageType;
  requiredSections: string[];
  guidance: string;
}

export interface InferWikiPageTypeInput {
  query: string;
  sourceKinds: WikiSourceKind[];
}

const WIKI_PAGE_TEMPLATES: Record<TemplatePageType, WikiPageTemplate> = {
  concept: {
    pageType: "concept",
    requiredSections: ["Overview", "Key Concepts", "Evidence", "Open Questions", "Related Pages"],
    guidance: "Use concept pages for stable explanatory knowledge. Ground claims in source_refs and keep design implications explicit."
  },
  dataset: {
    pageType: "dataset",
    requiredSections: ["Parameter Table", "Applicability", "Design Implications", "Known Uncertainty", "Related Pages"],
    guidance: "Use dataset pages for material, device, process, and calibration parameter tables. Quantitative rows need units, conditions, confidence, and source references."
  },
  method: {
    pageType: "method",
    requiredSections: ["Goal", "Inputs", "Procedure", "Outputs", "Failure Modes", "Design Use"],
    guidance: "Use method pages for software documentation and repeatable workflows. Capture tool versions, inputs, outputs, and failure modes."
  },
  finding: {
    pageType: "finding",
    requiredSections: ["Claim", "Evidence", "Scope", "Confidence", "Implications", "Contradictions or Open Checks"],
    guidance: "Use finding pages for evidence-backed conclusions. Attach claim provenance and unresolved contradiction candidates."
  },
  "capability-boundary": {
    pageType: "capability-boundary",
    requiredSections: ["Can Support", "Cannot Support Yet", "Evidence Boundary", "Escalation Criteria"],
    guidance: "Use capability-boundary pages to prevent agent overclaim. Separate supported workflows from unsupported engineering decisions and name the evidence required before escalation."
  },
  "design-record": {
    pageType: "design-record",
    requiredSections: [
      "Decision",
      "Context",
      "Evidence Used",
      "Alternatives Considered",
      "Verification Plan",
      "Status"
    ],
    guidance: "Use design records for maintained decisions. Add typed_relations such as uses, supports, implementation_of, and open_problem_for."
  }
};

export function getWikiPageTemplate(pageType: TemplatePageType): WikiPageTemplate {
  const template = WIKI_PAGE_TEMPLATES[pageType];
  return {
    ...template,
    requiredSections: [...template.requiredSections]
  };
}

export function inferWikiPageTypeForEvidence(input: InferWikiPageTypeInput): TemplatePageType {
  const query = input.query.toLowerCase();
  const sourceKinds = new Set(input.sourceKinds);

  if (
    sourceKinds.has("material-database") ||
    containsAny(query, ["parameter", "permittivity", "loss tangent", "material", "substrate", "film"])
  ) {
    return "dataset";
  }

  if (
    sourceKinds.has("software-doc") ||
    containsAny(query, ["workflow", "software", "procedure", "simulation", "hfss", "qiskit metal", "pyepr", "scqubits", "manual"])
  ) {
    return "method";
  }

  if (containsAny(query, ["decision", "design record", "selected", "tradeoff", "alternative"])) {
    return "design-record";
  }

  if (containsAny(query, ["capability boundary", "ability boundary", "can support", "cannot support", "can't support", "overclaim", "tapeout-ready", "tapeout ready"])) {
    return "capability-boundary";
  }

  if (containsAny(query, ["risk", "finding", "conclusion", "evidence shows", "suspected"])) {
    return "finding";
  }

  return "concept";
}

export function validateRequiredTemplateSections(input: {
  pageType: TemplatePageType;
  markdown: string;
}): { missingSections: string[] } {
  const headings = new Set<string>();
  const headingPattern = /^##\s+(.+?)\s*#*\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = headingPattern.exec(input.markdown)) !== null) {
    headings.add(match[1].trim());
  }

  const template = getWikiPageTemplate(input.pageType);
  return {
    missingSections: template.requiredSections.filter((section) => !headings.has(section))
  };
}

function containsAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}
