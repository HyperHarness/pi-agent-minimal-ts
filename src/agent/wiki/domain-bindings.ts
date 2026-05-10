export interface WikiDomainBinding {
  key: string;
  domain: "superconducting-qubits" | "benchmark" | "workflow";
  title: string;
  description: string;
  executionMode: "deterministic-local";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export type WikiDomainBindingValidationResult =
  | {
    ok: true;
    key: string;
  }
  | {
    ok: false;
    key: string;
    reason: "unknown_binding";
  };

const DOMAIN_BINDINGS: WikiDomainBinding[] = [
  {
    key: "transmon-frequency-estimate",
    domain: "superconducting-qubits",
    title: "Transmon frequency estimate",
    description: "Validated metadata hook for transmon and resonator estimate helpers.",
    executionMode: "deterministic-local",
    inputSchema: { type: "object", required: ["ej", "ec"] },
    outputSchema: { type: "object", required: ["frequencyGhz"] }
  }
];

function cloneBindingValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneBindingValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nestedValue]) => [key, cloneBindingValue(nestedValue)])
    );
  }

  return value;
}

function cloneBindingSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return cloneBindingValue(schema) as Record<string, unknown>;
}

function cloneWikiDomainBinding(binding: WikiDomainBinding): WikiDomainBinding {
  return {
    ...binding,
    inputSchema: cloneBindingSchema(binding.inputSchema),
    outputSchema: cloneBindingSchema(binding.outputSchema)
  };
}

export function listWikiDomainBindings(): WikiDomainBinding[] {
  return DOMAIN_BINDINGS.map((binding) => cloneWikiDomainBinding(binding));
}

export function validateWikiDomainBinding(key: string): WikiDomainBindingValidationResult {
  const binding = DOMAIN_BINDINGS.find((candidate) => candidate.key === key);
  if (!binding) {
    return {
      ok: false,
      key,
      reason: "unknown_binding"
    };
  }

  return {
    ok: true,
    key
  };
}
