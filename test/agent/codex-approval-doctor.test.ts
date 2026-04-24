import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_CODEX_GIT_APPROVAL_RULES,
  analyzeCodexApproval,
  buildMissingCodexApprovalRulesPatch,
  formatCodexApprovalDoctorReport
} from "../../src/agent/codex-approval-doctor.js";

const expectedRulesText = EXPECTED_CODEX_GIT_APPROVAL_RULES.map(
  (rule) => `prefix_rule(pattern=[${rule.pattern.map((part) => `"${part}"`).join(", ")}], decision="allow")`
).join("\n");

test("approval doctor reports a healthy Windows PowerShell Git approval setup", () => {
  const result = analyzeCodexApproval({
    platform: "win32",
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    codexConfigPath: "C:\\Users\\user\\.codex\\config.toml",
    codexConfigText: 'approval_policy = "on-request"\n',
    codexRulesPath: "C:\\Users\\user\\.codex\\rules\\default.rules",
    codexRulesText: expectedRulesText,
    windowsQuickstartPath: "D:\\Codex\\pi-agent-minimal-ts\\docs\\windows-powershell-codex-quickstart.md",
    windowsQuickstartText: "Reduce routine Git approval prompts in Codex Desktop",
    powerShellLanguageMode: "FullLanguage",
    powerShellProfileErrors: []
  });

  assert.equal(result.status, "ok");
  assert.equal(result.findings.filter((finding) => finding.level === "error").length, 0);
  assert.match(formatCodexApprovalDoctorReport(result), /Conclusion: routine Git rules look healthy/);
});

test("approval doctor detects missing safe Git allow rules", () => {
  const wrapperOnlyRulesText = EXPECTED_CODEX_GIT_APPROVAL_RULES.filter(
    (rule) => rule.kind === "powershell-wrapper"
  )
    .map((rule) => `prefix_rule(pattern=[${rule.pattern.map((part) => `"${part}"`).join(", ")}], decision="allow")`)
    .join("\n");
  const result = analyzeCodexApproval({
    platform: "win32",
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    codexConfigPath: "C:\\Users\\user\\.codex\\config.toml",
    codexConfigText: 'approval_policy = "on-request"\n',
    codexRulesPath: "C:\\Users\\user\\.codex\\rules\\default.rules",
    codexRulesText: wrapperOnlyRulesText,
    windowsQuickstartPath: "D:\\Codex\\pi-agent-minimal-ts\\docs\\windows-powershell-codex-quickstart.md",
    windowsQuickstartText: "Reduce routine Git approval prompts in Codex Desktop",
    powerShellLanguageMode: "FullLanguage",
    powerShellProfileErrors: []
  });

  assert.equal(result.status, "error");
  assert.match(formatCodexApprovalDoctorReport(result), /Missing direct Git inner allow rules/);
  assert.match(formatCodexApprovalDoctorReport(result), /git commit -m/);
});

test("approval doctor detects PowerShell launcher path case mismatches", () => {
  const wrongCaseRulesText = expectedRulesText.replaceAll("C:\\\\WINDOWS", "C:\\\\Windows");

  const result = analyzeCodexApproval({
    platform: "win32",
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    codexConfigPath: "C:\\Users\\user\\.codex\\config.toml",
    codexConfigText: 'approval_policy = "on-request"\n',
    codexRulesPath: "C:\\Users\\user\\.codex\\rules\\default.rules",
    codexRulesText: wrongCaseRulesText,
    windowsQuickstartPath: "D:\\Codex\\pi-agent-minimal-ts\\docs\\windows-powershell-codex-quickstart.md",
    windowsQuickstartText: "Reduce routine Git approval prompts in Codex Desktop",
    powerShellLanguageMode: "FullLanguage",
    powerShellProfileErrors: []
  });

  assert.equal(result.status, "error");
  assert.match(formatCodexApprovalDoctorReport(result), /PowerShell path case mismatch/);
  assert.match(formatCodexApprovalDoctorReport(result), /C:\\\\WINDOWS/);
});

test("approval doctor patch appends only missing exact safe rules", () => {
  const patch = buildMissingCodexApprovalRulesPatch("");

  assert.match(patch, /prefix_rule\(pattern=\["git", "commit", "-m"\], decision="allow"\)/);
  assert.match(patch, /prefix_rule\(pattern=\["git", "restore", "--staged"\], decision="allow"\)/);
  assert.doesNotMatch(patch, /pattern=\["git"\]/);
  assert.doesNotMatch(patch, /pattern=\["git", "commit"\]/);
  assert.doesNotMatch(patch, /reset --hard/);
});

test("approval doctor warns when unelevated Windows sandbox can still force git write approvals", () => {
  const result = analyzeCodexApproval({
    platform: "win32",
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    codexConfigPath: "C:\\Users\\user\\.codex\\config.toml",
    codexConfigText: 'approval_policy = "on-request"\n\n[windows]\nsandbox = "unelevated"\n',
    codexRulesPath: "C:\\Users\\user\\.codex\\rules\\default.rules",
    codexRulesText: expectedRulesText,
    windowsQuickstartPath: "D:\\Codex\\pi-agent-minimal-ts\\docs\\windows-powershell-codex-quickstart.md",
    windowsQuickstartText: "Reduce routine Git approval prompts in Codex Desktop",
    powerShellLanguageMode: "FullLanguage",
    powerShellProfileErrors: []
  });

  const report = formatCodexApprovalDoctorReport(result);

  assert.equal(result.status, "warning");
  assert.match(report, /Windows sandbox is unelevated/);
  assert.match(report, /\.git\/index\.lock/);
});

test("approval doctor warns when approval policy or PowerShell profile can interfere", () => {
  const result = analyzeCodexApproval({
    platform: "win32",
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    codexConfigPath: "C:\\Users\\user\\.codex\\config.toml",
    codexConfigText: 'approval_policy = "never"\n',
    codexRulesPath: "C:\\Users\\user\\.codex\\rules\\default.rules",
    codexRulesText: expectedRulesText,
    windowsQuickstartPath: "D:\\Codex\\pi-agent-minimal-ts\\docs\\windows-powershell-codex-quickstart.md",
    windowsQuickstartText: "Reduce routine Git approval prompts in Codex Desktop",
    powerShellLanguageMode: "ConstrainedLanguage",
    powerShellProfileErrors: ["Cannot dot-source this command because it was defined in a different language mode."]
  });

  const report = formatCodexApprovalDoctorReport(result);

  assert.equal(result.status, "warning");
  assert.match(report, /approval_policy is not on-request/);
  assert.match(report, /PowerShell profile startup errors were observed/);
  assert.match(report, /ConstrainedLanguage/);
});
