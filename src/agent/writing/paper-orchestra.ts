import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_INPUTS = [
  "inputs/idea.md",
  "inputs/experimental_log.md",
  "inputs/template.tex",
  "inputs/conference_guidelines.md",
] as const;

const WORKSPACE_DIRECTORIES = [
  "inputs",
  "inputs/figures",
  "figures",
  "drafts",
  "refinement",
  "final",
] as const;

export interface PreparePaperOrchestraWorkspaceResult {
  workspacePath: string;
  createdDirectories: string[];
  requiredInputs: string[];
  missingInputs: string[];
  ready: boolean;
}

export interface DraftGateResult {
  workspacePath: string;
  texPath: string;
  bibPath: string;
  status: "passed" | "failed";
  checks: {
    orphanCitations: {
      status: "passed" | "failed";
      missingKeys: string[];
      citedKeys: string[];
      bibKeys: string[];
    };
    latexSanity: {
      status: "passed" | "failed";
      errors: string[];
    };
    antiLeakage: {
      status: "passed" | "failed";
      matches: string[];
    };
  };
}

export interface ScoreDeltaResult {
  decision: "accept" | "revert" | "halt_plateau";
  reason:
    | "overall_improved"
    | "tie_with_non_negative_subaxis_delta"
    | "overall_decreased"
    | "tie_with_negative_subaxis_delta"
    | "accepted_but_plateau_reached";
  previousOverall: number;
  currentOverall: number;
  overallDelta: number;
  netSubaxisDelta: number;
  consecutiveSmall: number;
}

export interface ProvenanceResult {
  workspacePath: string;
  provenancePath: string;
  inputCount: number;
  figureCount: number;
  finalCount: number;
  bibEntryCount: number;
}

type ScoreDocument = {
  overall_score?: unknown;
  overall?: unknown;
  score?: {
    overall?: unknown;
  };
  axis_scores?: unknown;
  axes?: unknown;
};

function assertPathInsideDirectory(rootDir: string, candidatePath: string): void {
  const relativePath = path.relative(rootDir, candidatePath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error("Requested path is outside the workspace.");
  }
}

function resolveInsideWorkspace(workspaceDir: string, requestedPath: string): string {
  if (!requestedPath.trim()) {
    throw new Error("Path is required.");
  }

  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(resolvedWorkspaceDir, requestedPath);
  assertPathInsideDirectory(resolvedWorkspaceDir, resolvedPath);
  return resolvedPath;
}

function relativeWorkspacePath(workspaceDir: string, resolvedPath: string): string {
  return path.relative(path.resolve(workspaceDir), resolvedPath).split(path.sep).join("/");
}

async function fileExistsAndNonEmpty(filePath: string): Promise<boolean> {
  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile() && fileStats.size > 0;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function preparePaperOrchestraWorkspace(input: {
  workspaceDir: string;
  workspacePath: string;
  createMissing?: boolean;
}): Promise<PreparePaperOrchestraWorkspaceResult> {
  const resolvedWorkspacePath = resolveInsideWorkspace(input.workspaceDir, input.workspacePath);
  if (input.createMissing) {
    await mkdir(resolvedWorkspacePath, { recursive: true });
  }

  const createdDirectories: string[] = [];
  if (input.createMissing) {
    for (const directory of WORKSPACE_DIRECTORIES) {
      const resolvedDirectory = path.resolve(resolvedWorkspacePath, directory);
      assertPathInsideDirectory(path.resolve(input.workspaceDir), resolvedDirectory);
      await mkdir(resolvedDirectory, { recursive: true });
      createdDirectories.push(relativeWorkspacePath(input.workspaceDir, resolvedDirectory));
    }
  }

  const missingInputs: string[] = [];
  for (const requiredInput of REQUIRED_INPUTS) {
    const resolvedInput = path.resolve(resolvedWorkspacePath, requiredInput);
    assertPathInsideDirectory(path.resolve(input.workspaceDir), resolvedInput);
    if (!(await fileExistsAndNonEmpty(resolvedInput))) {
      missingInputs.push(requiredInput);
    }
  }

  return {
    workspacePath: relativeWorkspacePath(input.workspaceDir, resolvedWorkspacePath),
    createdDirectories,
    requiredInputs: [...REQUIRED_INPUTS],
    missingInputs,
    ready: missingInputs.length === 0,
  };
}

function extractCitationKeys(tex: string): string[] {
  const keys = new Set<string>();
  const citePattern =
    /\\(?:cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite)(?:\[[^\]]*\]){0,2}\{([^}]+)\}/g;
  for (const match of tex.matchAll(citePattern)) {
    for (const key of match[1].split(",")) {
      const trimmed = key.trim();
      if (trimmed) {
        keys.add(trimmed);
      }
    }
  }
  return [...keys].sort();
}

function extractBibKeys(bib: string): string[] {
  const keys = new Set<string>();
  for (const match of bib.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) {
    keys.add(match[1].trim());
  }
  return [...keys].sort();
}

function checkLatexSanity(tex: string): string[] {
  const errors: string[] = [];
  const environmentStack: string[] = [];
  const envPattern = /\\(begin|end)\{([^}]+)\}/g;
  for (const match of tex.matchAll(envPattern)) {
    const [, direction, environment] = match;
    if (direction === "begin") {
      environmentStack.push(environment);
      continue;
    }

    const openEnvironment = environmentStack.pop();
    if (!openEnvironment) {
      errors.push(`Unmatched LaTeX environment close: ${environment}`);
    } else if (openEnvironment !== environment) {
      errors.push(`Mismatched LaTeX environment: expected ${openEnvironment}, saw ${environment}`);
    }
  }

  while (environmentStack.length > 0) {
    const environment = environmentStack.pop();
    if (environment) {
      errors.push(`Unclosed LaTeX environment: ${environment}`);
    }
  }

  const strippedEscapes = tex.replace(/\\./g, "");
  const openBraces = (strippedEscapes.match(/\{/g) ?? []).length;
  const closeBraces = (strippedEscapes.match(/\}/g) ?? []).length;
  if (openBraces !== closeBraces) {
    errors.push(`Unbalanced braces: ${openBraces} opening and ${closeBraces} closing braces`);
  }

  return errors;
}

function checkAntiLeakage(tex: string): string[] {
  const matches: string[] = [];
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(tex)) {
    matches.push("email address");
  }
  if (/\bcorresponding author\b/i.test(tex)) {
    matches.push("corresponding author");
  }
  if (/\b(?:Google|Microsoft|Meta|OpenAI|Stanford|MIT|Berkeley|Harvard|Princeton|Yale)\b/i.test(tex)) {
    matches.push("affiliation token");
  }
  if (/\b[A-Z][a-z]+ [A-Z][a-z]+,\s+[A-Z][a-z]+ [A-Z][a-z]+\b/.test(tex)) {
    matches.push("author-list-like names");
  }
  return matches;
}

export async function checkPaperOrchestraDraft(input: {
  workspaceDir: string;
  workspacePath: string;
  texPath?: string;
  bibPath?: string;
}): Promise<DraftGateResult> {
  const resolvedWorkspacePath = resolveInsideWorkspace(input.workspaceDir, input.workspacePath);
  const resolvedTexPath = resolveInsideWorkspace(
    input.workspaceDir,
    input.texPath ?? path.join(input.workspacePath, "drafts", "paper.tex"),
  );
  const resolvedBibPath = resolveInsideWorkspace(input.workspaceDir, input.bibPath ?? path.join(input.workspacePath, "refs.bib"));
  assertPathInsideDirectory(resolvedWorkspacePath, resolvedTexPath);
  assertPathInsideDirectory(resolvedWorkspacePath, resolvedBibPath);

  const [tex, bib] = await Promise.all([
    readFile(resolvedTexPath, "utf8"),
    readFile(resolvedBibPath, "utf8"),
  ]);
  const citedKeys = extractCitationKeys(tex);
  const bibKeys = extractBibKeys(bib);
  const bibKeySet = new Set(bibKeys);
  const missingKeys = citedKeys.filter((key) => !bibKeySet.has(key));
  const latexErrors = checkLatexSanity(tex);
  const leakageMatches = checkAntiLeakage(tex);
  const status = missingKeys.length === 0 && latexErrors.length === 0 && leakageMatches.length === 0
    ? "passed"
    : "failed";

  return {
    workspacePath: relativeWorkspacePath(input.workspaceDir, resolvedWorkspacePath),
    texPath: relativeWorkspacePath(input.workspaceDir, resolvedTexPath),
    bibPath: relativeWorkspacePath(input.workspaceDir, resolvedBibPath),
    status,
    checks: {
      orphanCitations: {
        status: missingKeys.length === 0 ? "passed" : "failed",
        missingKeys,
        citedKeys,
        bibKeys,
      },
      latexSanity: {
        status: latexErrors.length === 0 ? "passed" : "failed",
        errors: latexErrors,
      },
      antiLeakage: {
        status: leakageMatches.length === 0 ? "passed" : "failed",
        matches: leakageMatches,
      },
    },
  };
}

function numberFromUnknown(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Score file is missing numeric ${label}.`);
  }
  return value;
}

function extractOverallScore(score: ScoreDocument): number {
  return numberFromUnknown(score.overall_score ?? score.overall ?? score.score?.overall, "overall score");
}

function extractAxisScores(score: ScoreDocument): Record<string, number> {
  const rawAxes = score.axis_scores ?? score.axes;
  if (typeof rawAxes !== "object" || rawAxes === null || Array.isArray(rawAxes)) {
    return {};
  }

  const axes: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawAxes)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      axes[key] = value;
    } else if (typeof value === "object" && value !== null && "score" in value) {
      axes[key] = numberFromUnknown(value.score, `axis score for ${key}`);
    }
  }
  return axes;
}

export async function computePaperOrchestraScoreDelta(input: {
  workspaceDir: string;
  previousScorePath: string;
  currentScorePath: string;
  plateauThreshold?: number;
  plateauStreak?: number;
  consecutiveSmall?: number;
}): Promise<ScoreDeltaResult> {
  const previousPath = resolveInsideWorkspace(input.workspaceDir, input.previousScorePath);
  const currentPath = resolveInsideWorkspace(input.workspaceDir, input.currentScorePath);
  const [previousScore, currentScore] = await Promise.all([
    readFile(previousPath, "utf8").then((content) => JSON.parse(content) as ScoreDocument),
    readFile(currentPath, "utf8").then((content) => JSON.parse(content) as ScoreDocument),
  ]);
  const previousOverall = extractOverallScore(previousScore);
  const currentOverall = extractOverallScore(currentScore);
  const overallDelta = currentOverall - previousOverall;
  const previousAxes = extractAxisScores(previousScore);
  const currentAxes = extractAxisScores(currentScore);
  const netSubaxisDelta = Object.keys(currentAxes)
    .filter((key) => key in previousAxes)
    .reduce((sum, key) => sum + (currentAxes[key] - previousAxes[key]), 0);
  const plateauThreshold = Math.max(0, input.plateauThreshold ?? 1);
  const plateauStreak = Math.max(1, Math.trunc(input.plateauStreak ?? 3));
  const nextConsecutiveSmall = Math.abs(overallDelta) < plateauThreshold
    ? Math.max(0, Math.trunc(input.consecutiveSmall ?? 0)) + 1
    : 0;

  if (overallDelta > 0) {
    if (nextConsecutiveSmall >= plateauStreak) {
      return {
        decision: "halt_plateau",
        reason: "accepted_but_plateau_reached",
        previousOverall,
        currentOverall,
        overallDelta,
        netSubaxisDelta,
        consecutiveSmall: nextConsecutiveSmall,
      };
    }
    return {
      decision: "accept",
      reason: "overall_improved",
      previousOverall,
      currentOverall,
      overallDelta,
      netSubaxisDelta,
      consecutiveSmall: nextConsecutiveSmall,
    };
  }

  if (overallDelta === 0 && netSubaxisDelta >= 0) {
    return {
      decision: "accept",
      reason: "tie_with_non_negative_subaxis_delta",
      previousOverall,
      currentOverall,
      overallDelta,
      netSubaxisDelta,
      consecutiveSmall: nextConsecutiveSmall,
    };
  }

  return {
    decision: "revert",
    reason: overallDelta < 0 ? "overall_decreased" : "tie_with_negative_subaxis_delta",
    previousOverall,
    currentOverall,
    overallDelta,
    netSubaxisDelta,
    consecutiveSmall: nextConsecutiveSmall,
  };
}

async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const buffer = await readFile(filePath);
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
  };
}

async function hashOptionalFile(rootDir: string, relativePath: string): Promise<{ sha256: string; bytes: number } | undefined> {
  const resolvedPath = path.resolve(rootDir, relativePath);
  if (!(await fileExistsAndNonEmpty(resolvedPath))) {
    return undefined;
  }
  return hashFile(resolvedPath);
}

async function hashDirectoryFiles(rootDir: string, relativeDir: string): Promise<Record<string, { sha256: string; bytes: number }>> {
  const resolvedDir = path.resolve(rootDir, relativeDir);
  const result: Record<string, { sha256: string; bytes: number }> = {};
  try {
    const entries = await readdir(resolvedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        result[entry.name] = await hashFile(path.resolve(resolvedDir, entry.name));
      }
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return result;
    }
    throw error;
  }
  return result;
}

function countBibEntries(bib: string): number {
  return [...bib.matchAll(/@\w+\s*\{/g)].length;
}

export async function snapshotPaperOrchestraProvenance(input: {
  workspaceDir: string;
  workspacePath: string;
}): Promise<ProvenanceResult> {
  const resolvedWorkspacePath = resolveInsideWorkspace(input.workspaceDir, input.workspacePath);
  const inputs: Record<string, { sha256: string; bytes: number }> = {};
  for (const requiredInput of REQUIRED_INPUTS) {
    const hash = await hashOptionalFile(resolvedWorkspacePath, requiredInput);
    if (hash) {
      inputs[path.basename(requiredInput)] = hash;
    }
  }

  const outline = await hashOptionalFile(resolvedWorkspacePath, "outline.json");
  const refsBib = await hashOptionalFile(resolvedWorkspacePath, "refs.bib");
  const figures = {
    ...(await hashDirectoryFiles(resolvedWorkspacePath, "inputs/figures")),
    ...(await hashDirectoryFiles(resolvedWorkspacePath, "figures")),
  };
  const final = await hashDirectoryFiles(resolvedWorkspacePath, "final");
  const bibEntryCount = refsBib
    ? countBibEntries(await readFile(path.resolve(resolvedWorkspacePath, "refs.bib"), "utf8"))
    : 0;
  const provenance = {
    created_at: new Date().toISOString(),
    inputs,
    ...(outline ? { outline } : {}),
    refs_bib: refsBib ? { ...refsBib, n_entries: bibEntryCount } : { n_entries: 0 },
    figures,
    final,
    skill_versions: {
      "paper-orchestra": "PaperOrchestra-inspired controlled writing workflow",
    },
  };
  const provenancePath = path.resolve(resolvedWorkspacePath, "provenance.json");
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

  return {
    workspacePath: relativeWorkspacePath(input.workspaceDir, resolvedWorkspacePath),
    provenancePath: relativeWorkspacePath(input.workspaceDir, provenancePath),
    inputCount: Object.keys(inputs).length,
    figureCount: Object.keys(figures).length,
    finalCount: Object.keys(final).length,
    bibEntryCount,
  };
}
