import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type ApprovalDoctorStatus = "ok" | "warning" | "error";
export type ApprovalDoctorFindingLevel = "ok" | "warning" | "error";

export interface ExpectedCodexGitApprovalRule {
  kind: "powershell-wrapper" | "direct-git";
  pattern: string[];
  commandLabel: string;
}

export interface CodexApprovalDoctorInput {
  platform: NodeJS.Platform | string;
  workspaceDir: string;
  codexConfigPath: string;
  codexConfigText?: string;
  codexRulesPath: string;
  codexRulesText?: string;
  windowsQuickstartPath: string;
  windowsQuickstartText?: string;
  powerShellLanguageMode?: string;
  powerShellProfileErrors: string[];
}

export interface CodexApprovalFinding {
  level: ApprovalDoctorFindingLevel;
  title: string;
  detail: string;
  recommendation: string;
}

export interface CodexApprovalDoctorResult {
  status: ApprovalDoctorStatus;
  input: CodexApprovalDoctorInput;
  findings: CodexApprovalFinding[];
}

interface ParsedRule {
  pattern: string[];
}

const WINDOWS_POWERSHELL_RULE_PATH = "C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe";
const RULE_LINE_PATTERN =
  /^\s*prefix_rule\(pattern=\[(.+)\],\s*decision="allow"\)\s*$/;
const QUOTED_PATTERN_PART = /"([^"]*)"/g;

export const EXPECTED_CODEX_GIT_APPROVAL_RULES: ExpectedCodexGitApprovalRule[] = [
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git status"], commandLabel: "git status" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git diff"], commandLabel: "git diff" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git add"], commandLabel: "git add" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git commit -m"], commandLabel: "git commit -m" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git switch"], commandLabel: "git switch" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git checkout -b"], commandLabel: "git checkout -b" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git branch -d"], commandLabel: "git branch -d" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git push"], commandLabel: "git push" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git log"], commandLabel: "git log" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git branch"], commandLabel: "git branch" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git rev-parse"], commandLabel: "git rev-parse" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git show"], commandLabel: "git show" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git restore --staged"], commandLabel: "git restore --staged" },
  { kind: "powershell-wrapper", pattern: [WINDOWS_POWERSHELL_RULE_PATH, "-Command", "git commit --amend --no-edit"], commandLabel: "git commit --amend --no-edit" },
  { kind: "direct-git", pattern: ["git", "status"], commandLabel: "git status" },
  { kind: "direct-git", pattern: ["git", "diff"], commandLabel: "git diff" },
  { kind: "direct-git", pattern: ["git", "add"], commandLabel: "git add" },
  { kind: "direct-git", pattern: ["git", "commit", "-m"], commandLabel: "git commit -m" },
  { kind: "direct-git", pattern: ["git", "switch"], commandLabel: "git switch" },
  { kind: "direct-git", pattern: ["git", "checkout", "-b"], commandLabel: "git checkout -b" },
  { kind: "direct-git", pattern: ["git", "branch", "-d"], commandLabel: "git branch -d" },
  { kind: "direct-git", pattern: ["git", "push"], commandLabel: "git push" },
  { kind: "direct-git", pattern: ["git", "log"], commandLabel: "git log" },
  { kind: "direct-git", pattern: ["git", "branch"], commandLabel: "git branch" },
  { kind: "direct-git", pattern: ["git", "rev-parse"], commandLabel: "git rev-parse" },
  { kind: "direct-git", pattern: ["git", "show"], commandLabel: "git show" },
  { kind: "direct-git", pattern: ["git", "restore", "--staged"], commandLabel: "git restore --staged" },
  { kind: "direct-git", pattern: ["git", "commit", "--amend", "--no-edit"], commandLabel: "git commit --amend --no-edit" }
];

const FORBIDDEN_GIT_APPROVAL_PREFIXES = [
  "git",
  "git fetch",
  "git pull",
  "git merge",
  "git rebase",
  "git cherry-pick",
  "git stash",
  "git tag",
  "git reset --hard",
  "git clean -fd",
  "git clean -fdx",
  "git checkout --",
  "git restore",
  "git branch -D"
];

function buildRuleLine(rule: ExpectedCodexGitApprovalRule): string {
  return `prefix_rule(pattern=[${rule.pattern.map((part) => `"${part}"`).join(", ")}], decision="allow")`;
}

function parsePattern(rawPattern: string): string[] {
  QUOTED_PATTERN_PART.lastIndex = 0;
  return Array.from(rawPattern.matchAll(QUOTED_PATTERN_PART), (match) => match[1]);
}

function parseRules(rulesText: string | undefined): ParsedRule[] {
  if (rulesText === undefined) {
    return [];
  }

  return rulesText
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = RULE_LINE_PATTERN.exec(line);
      if (!match) {
        return [];
      }

      return [
        {
          pattern: parsePattern(match[1])
        }
      ];
    });
}

function extractApprovalPolicy(configText: string | undefined): string | undefined {
  if (configText === undefined) {
    return undefined;
  }

  return /^\s*approval_policy\s*=\s*"([^"]+)"\s*$/m.exec(configText)?.[1];
}

function extractWindowsSandbox(configText: string | undefined): string | undefined {
  if (configText === undefined) {
    return undefined;
  }

  let insideWindowsSection = false;
  for (const line of configText.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      insideWindowsSection = /^\s*\[windows\]\s*$/.test(line);
      continue;
    }

    if (!insideWindowsSection) {
      continue;
    }

    const sandbox = /^\s*sandbox\s*=\s*"([^"]+)"\s*$/.exec(line)?.[1];
    if (sandbox !== undefined) {
      return sandbox;
    }
  }

  return undefined;
}

function ruleKey(rule: ExpectedCodexGitApprovalRule): string {
  return rule.pattern.join("\0");
}

function parsedRuleKey(rule: ParsedRule): string {
  return rule.pattern.join("\0");
}

function parsedCommandLabel(rule: ParsedRule): string {
  if (rule.pattern.length === 3 && rule.pattern[1] === "-Command") {
    return rule.pattern[2];
  }

  return rule.pattern.join(" ");
}

function createStatus(findings: CodexApprovalFinding[]): ApprovalDoctorStatus {
  if (findings.some((finding) => finding.level === "error")) {
    return "error";
  }

  if (findings.some((finding) => finding.level === "warning")) {
    return "warning";
  }

  return "ok";
}

function addOk(findings: CodexApprovalFinding[], title: string, detail: string): void {
  findings.push({
    level: "ok",
    title,
    detail,
    recommendation: "No action needed."
  });
}

function addFinding(
  findings: CodexApprovalFinding[],
  level: "warning" | "error",
  title: string,
  detail: string,
  recommendation: string
): void {
  findings.push({
    level,
    title,
    detail,
    recommendation
  });
}

export function analyzeCodexApproval(input: CodexApprovalDoctorInput): CodexApprovalDoctorResult {
  const findings: CodexApprovalFinding[] = [];
  const parsedRules = parseRules(input.codexRulesText);
  const parsedRuleKeys = new Set(parsedRules.map(parsedRuleKey));
  const missingRules = EXPECTED_CODEX_GIT_APPROVAL_RULES.filter(
    (rule) => !parsedRuleKeys.has(ruleKey(rule))
  );
  const caseMismatchRules = missingRules.filter((expectedRule) =>
    expectedRule.kind === "powershell-wrapper" &&
    parsedRules.some(
      (parsedRule) =>
        parsedRule.pattern.length === 3 &&
        parsedRule.pattern[1] === "-Command" &&
        parsedRule.pattern[2] === expectedRule.pattern[2] &&
        parsedRule.pattern[0].toLowerCase() === expectedRule.pattern[0].toLowerCase() &&
        parsedRule.pattern[0] !== expectedRule.pattern[0]
    )
  );
  const trulyMissingRules = missingRules.filter(
    (expectedRule) =>
      !caseMismatchRules.some((caseMismatchRule) => caseMismatchRule.commandLabel === expectedRule.commandLabel)
  );
  const forbiddenRules = parsedRules.filter((rule) =>
    FORBIDDEN_GIT_APPROVAL_PREFIXES.includes(parsedCommandLabel(rule))
  );
  const approvalPolicy = extractApprovalPolicy(input.codexConfigText);
  const windowsSandbox = extractWindowsSandbox(input.codexConfigText);

  if (input.platform !== "win32") {
    addFinding(
      findings,
      "warning",
      "Not running on Windows",
      `This doctor is designed for Windows PowerShell. Current platform is ${input.platform}.`,
      "Run it from Windows PowerShell in Codex Desktop when diagnosing Windows approval prompts."
    );
  } else {
    addOk(findings, "Windows platform detected", "The host platform is win32.");
  }

  if (input.codexConfigText === undefined) {
    addFinding(
      findings,
      "error",
      "Codex config not readable",
      `Could not read ${input.codexConfigPath}.`,
      "Create or restore the Codex config file, then keep approval_policy = \"on-request\"."
    );
  } else if (approvalPolicy === "on-request") {
    addOk(findings, "approval_policy is on-request", `${input.codexConfigPath} keeps approval_policy on-request.`);
  } else {
    addFinding(
      findings,
      "warning",
      "approval_policy is not on-request",
      approvalPolicy === undefined
        ? `${input.codexConfigPath} does not define approval_policy.`
        : `${input.codexConfigPath} defines approval_policy = "${approvalPolicy}".`,
      "Set approval_policy = \"on-request\" if you want safe prefix rules to reduce prompts without disabling approvals globally."
    );
  }

  if (input.codexRulesText === undefined) {
    addFinding(
      findings,
      "error",
      "Codex rules file not readable",
      `Could not read ${input.codexRulesPath}.`,
      "Create the rules file and append the safe Git prefix rules listed below."
    );
  } else {
    if (caseMismatchRules.length > 0) {
      addFinding(
        findings,
        "error",
        "PowerShell path case mismatch",
        `Found Git allow rules for the right commands, but their PowerShell path casing does not exactly match ${WINDOWS_POWERSHELL_RULE_PATH}. A case-sensitive prefix match can still prompt.`,
        `Rewrite those rules to use ${WINDOWS_POWERSHELL_RULE_PATH}, then fully restart Codex Desktop.`
      );
    }

    const missingWrapperRules = trulyMissingRules.filter((rule) => rule.kind === "powershell-wrapper");
    const missingDirectGitRules = trulyMissingRules.filter((rule) => rule.kind === "direct-git");

    if (missingWrapperRules.length > 0) {
      addFinding(
        findings,
        "error",
        "Missing PowerShell wrapper Git allow rules",
        `Missing prefixes: ${missingWrapperRules.map((rule) => rule.commandLabel).join(", ")}.`,
        `Append the missing exact prefix_rule lines to ${input.codexRulesPath}, then fully restart Codex Desktop.`
      );
    }

    if (missingDirectGitRules.length > 0) {
      addFinding(
        findings,
        "error",
        "Missing direct Git inner allow rules",
        `Missing prefixes: ${missingDirectGitRules.map((rule) => rule.commandLabel).join(", ")}.`,
        `Append the missing exact direct Git prefix_rule lines to ${input.codexRulesPath}. These cover approval UIs that match the inner command instead of the PowerShell wrapper.`
      );
    }

    if (caseMismatchRules.length === 0 && trulyMissingRules.length === 0) {
      addOk(findings, "Safe Git allow rules are present", "All expected wrapper and direct routine Git prefix rules are present exactly.");
    }

    if (forbiddenRules.length > 0) {
      addFinding(
        findings,
        "error",
        "Unsafe Git allow rules detected",
        `These broad or destructive prefixes are allowed: ${forbiddenRules.map(parsedCommandLabel).join(", ")}.`,
        "Remove broad/destructive Git allow rules. Keep only narrow routine prefixes."
      );
    }
  }

  if (input.windowsQuickstartText === undefined) {
    addFinding(
      findings,
      "warning",
      "Windows quickstart not found",
      `Could not read ${input.windowsQuickstartPath}.`,
      "Keep the approval-rule guidance in the project docs so future checks have a stable reference."
    );
  } else if (input.windowsQuickstartText.includes("Reduce routine Git approval prompts in Codex Desktop")) {
    addOk(findings, "Project approval documentation found", `${input.windowsQuickstartPath} documents the approval setup.`);
  } else {
    addFinding(
      findings,
      "warning",
      "Project approval documentation is incomplete",
      `${input.windowsQuickstartPath} exists but does not contain the expected approval troubleshooting section.`,
      "Add or restore the Codex Desktop approval-rule section in the Windows quickstart."
    );
  }

  if (windowsSandbox === "unelevated") {
    addFinding(
      findings,
      "warning",
      "Windows sandbox is unelevated",
      "Git write commands can still fail inside the sandbox when they need to update .git/index.lock or other Git metadata, even when safe Git approval rules are present.",
      "Treat follow-up prompts for git add, git commit, or git push as sandbox escalation prompts, not missing default.rules entries. Persist the external-execution approval in the Codex prompt or change the Windows sandbox policy, then restart Codex Desktop before re-testing."
    );
  }

  if (input.powerShellLanguageMode !== undefined && input.powerShellLanguageMode !== "FullLanguage") {
    addFinding(
      findings,
      "warning",
      "PowerShell is not in FullLanguage mode",
      `Observed PowerShell language mode: ${input.powerShellLanguageMode}.`,
      "If profile commands fail under ConstrainedLanguage, guard or simplify the profile so diagnostic commands start cleanly."
    );
  }

  if (input.powerShellProfileErrors.length > 0) {
    addFinding(
      findings,
      "warning",
      "PowerShell profile startup errors were observed",
      input.powerShellProfileErrors.join("\n"),
      "Fix or guard the profile commands that fail at startup; noisy profile failures can hide the real approval-rule signal."
    );
  }

  return {
    status: createStatus(findings),
    input,
    findings
  };
}

export function buildMissingCodexApprovalRulesPatch(rulesText: string | undefined): string {
  const parsedRuleKeys = new Set(parseRules(rulesText).map(parsedRuleKey));
  return EXPECTED_CODEX_GIT_APPROVAL_RULES.filter((rule) => !parsedRuleKeys.has(ruleKey(rule)))
    .map(buildRuleLine)
    .join("\n");
}

export async function appendMissingCodexApprovalRules(rulesPath: string): Promise<string> {
  const currentRulesText = (await readOptionalText(rulesPath)) ?? "";
  const patch = buildMissingCodexApprovalRulesPatch(currentRulesText);

  if (!patch) {
    return "";
  }

  const separator = currentRulesText.trim().length === 0 || currentRulesText.endsWith("\n") ? "" : "\n";
  await mkdir(path.dirname(rulesPath), { recursive: true });
  await writeFile(rulesPath, `${currentRulesText}${separator}${patch}\n`, "utf8");
  return patch;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function readPowerShellEnvironment(): Pick<
  CodexApprovalDoctorInput,
  "powerShellLanguageMode" | "powerShellProfileErrors"
> {
  if (process.platform !== "win32") {
    return { powerShellProfileErrors: [] };
  }

  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-Command", "$ExecutionContext.SessionState.LanguageMode"],
    {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true
    }
  );
  const stderrLines = (result.stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const stdoutLines = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const spawnError = result.error === undefined ? [] : [result.error.message];

  return {
    powerShellLanguageMode: stdoutLines.at(-1),
    powerShellProfileErrors: [...spawnError, ...stderrLines]
  };
}

export async function collectCodexApprovalDoctorInput(
  workspaceDir = process.cwd()
): Promise<CodexApprovalDoctorInput> {
  const homeDir = os.homedir();
  const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
  const codexRulesPath = path.join(homeDir, ".codex", "rules", "default.rules");
  const windowsQuickstartPath = path.join(workspaceDir, "docs", "windows-powershell-codex-quickstart.md");
  const powerShellEnvironment = readPowerShellEnvironment();

  return {
    platform: process.platform,
    workspaceDir,
    codexConfigPath,
    codexConfigText: await readOptionalText(codexConfigPath),
    codexRulesPath,
    codexRulesText: await readOptionalText(codexRulesPath),
    windowsQuickstartPath,
    windowsQuickstartText: await readOptionalText(windowsQuickstartPath),
    ...powerShellEnvironment
  };
}

function formatFinding(finding: CodexApprovalFinding): string {
  const marker = finding.level.toUpperCase();
  return [
    `[${marker}] ${finding.title}`,
    `  Evidence: ${finding.detail}`,
    `  Fix: ${finding.recommendation}`
  ].join("\n");
}

export function formatCodexApprovalDoctorReport(result: CodexApprovalDoctorResult): string {
  const conclusion =
    result.status === "ok"
      ? "routine Git rules look healthy"
      : result.status === "warning"
        ? "routine Git rules are usable, but environment warnings need attention"
        : "routine Git commands can still prompt until the errors below are fixed";
  const missingRuleLines = EXPECTED_CODEX_GIT_APPROVAL_RULES.map(buildRuleLine).join("\n");

  return [
    "Codex approval doctor (Windows PowerShell)",
    "",
    `Workspace: ${result.input.workspaceDir}`,
    `Rules: ${result.input.codexRulesPath}`,
    `Config: ${result.input.codexConfigPath}`,
    "",
    `Conclusion: ${conclusion}.`,
    "",
    "Findings:",
    ...result.findings.map(formatFinding),
    "",
    "Safe Git prefix rules expected:",
    missingRuleLines,
    "",
    "Git commands outside these safe prefixes are expected to request approval.",
    "",
    "After changing rules, fully restart Codex Desktop before judging whether approval prompts are fixed."
  ].join("\n");
}
