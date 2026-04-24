import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type ApprovalDoctorStatus = "ok" | "warning" | "error";
export type ApprovalDoctorFindingLevel = "ok" | "warning" | "error";

export interface ExpectedCodexGitApprovalRule {
  powerShellPath: string;
  gitPrefix: string;
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
  powerShellPath: string;
  commandPrefix: string;
}

const WINDOWS_POWERSHELL_RULE_PATH = "C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe";
const RULE_LINE_PATTERN =
  /^\s*prefix_rule\(pattern=\["([^"]+)",\s*"-Command",\s*"([^"]+)"\],\s*decision="allow"\)\s*$/;

export const EXPECTED_CODEX_GIT_APPROVAL_RULES: ExpectedCodexGitApprovalRule[] = [
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git status" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git diff" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git add" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git commit -m" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git switch" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git checkout -b" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git branch -d" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git push" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git log" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git branch" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git rev-parse" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git show" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git restore --staged" },
  { powerShellPath: WINDOWS_POWERSHELL_RULE_PATH, gitPrefix: "git commit --amend --no-edit" }
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
  return `prefix_rule(pattern=["${rule.powerShellPath}", "-Command", "${rule.gitPrefix}"], decision="allow")`;
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
          powerShellPath: match[1],
          commandPrefix: match[2]
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

function ruleKey(rule: ExpectedCodexGitApprovalRule): string {
  return `${rule.powerShellPath}\0${rule.gitPrefix}`;
}

function parsedRuleKey(rule: ParsedRule): string {
  return `${rule.powerShellPath}\0${rule.commandPrefix}`;
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
    parsedRules.some(
      (parsedRule) =>
        parsedRule.commandPrefix === expectedRule.gitPrefix &&
        parsedRule.powerShellPath.toLowerCase() === expectedRule.powerShellPath.toLowerCase() &&
        parsedRule.powerShellPath !== expectedRule.powerShellPath
    )
  );
  const trulyMissingRules = missingRules.filter(
    (expectedRule) =>
      !caseMismatchRules.some((caseMismatchRule) => caseMismatchRule.gitPrefix === expectedRule.gitPrefix)
  );
  const forbiddenRules = parsedRules.filter((rule) =>
    FORBIDDEN_GIT_APPROVAL_PREFIXES.includes(rule.commandPrefix)
  );
  const approvalPolicy = extractApprovalPolicy(input.codexConfigText);

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

    if (trulyMissingRules.length > 0) {
      addFinding(
        findings,
        "error",
        "Missing safe Git allow rules",
        `Missing prefixes: ${trulyMissingRules.map((rule) => rule.gitPrefix).join(", ")}.`,
        `Append the missing exact prefix_rule lines to ${input.codexRulesPath}, then fully restart Codex Desktop.`
      );
    }

    if (caseMismatchRules.length === 0 && trulyMissingRules.length === 0) {
      addOk(findings, "Safe Git allow rules are present", "All expected routine Git prefix rules are present exactly.");
    }

    if (forbiddenRules.length > 0) {
      addFinding(
        findings,
        "error",
        "Unsafe Git allow rules detected",
        `These broad or destructive prefixes are allowed: ${forbiddenRules.map((rule) => rule.commandPrefix).join(", ")}.`,
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
