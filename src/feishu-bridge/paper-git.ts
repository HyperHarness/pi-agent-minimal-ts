import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PaperGitConfig {
  gitEnabled: boolean;
  dir?: string;
  maxGitOutputChars: number;
  autoCommitEnabled?: boolean;
  autoPushEnabled?: boolean;
}

export type PaperGitAction = 'status' | 'diff' | 'log' | 'commit';

export interface PaperGitCommand {
  action: PaperGitAction;
  message?: string;
}

export interface PaperGitResult {
  handled: true;
  text: string;
}

export interface PaperGitSnapshot {
  enabled: boolean;
  workspaceDir?: string;
  status?: string;
  reason?: string;
}

export interface AutoPaperGitResult {
  didCommit: boolean;
  didPush: boolean;
  text?: string;
}

export interface PaperGitDependencies {
  runGit?: (cwd: string, args: string[]) => Promise<string>;
}

const COMMAND_PREFIXES = [/^论文\s*git\b/i, /^paper\s+git\b/i, /^\/paper\s+git\b/i];

function stripCommandPrefix(text: string): string | null {
  const trimmed = text.trim();
  for (const prefix of COMMAND_PREFIXES) {
    const match = trimmed.match(prefix);
    if (match) {
      return trimmed.slice(match[0].length).trim();
    }
  }
  return null;
}

export function parsePaperGitCommand(text: string): PaperGitCommand | null {
  const body = stripCommandPrefix(text);
  if (body === null) {
    return null;
  }

  if (!body || /^(status|状态)$/i.test(body)) {
    return { action: 'status' };
  }
  if (/^(diff|差异|改动)(\s|$)/i.test(body)) {
    return { action: 'diff' };
  }
  if (/^(log|日志|历史)(\s|$)/i.test(body)) {
    return { action: 'log' };
  }

  const commitMatch = body.match(/^(?:commit|提交)\s+(.+)$/is);
  if (commitMatch?.[1]?.trim()) {
    return { action: 'commit', message: commitMatch[1].trim() };
  }

  return {
    action: 'status',
    message: 'usage',
  };
}

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n\n...输出已截断，完整输出超过 ${maxChars} 字符。`;
}

function formatCodeBlock(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `\`\`\`\n${trimmed}\n\`\`\`` : '```\n(no output)\n```';
}

async function assertGitWorkspace(
  workspaceDir: string,
  runGitImpl: (cwd: string, args: string[]) => Promise<string>,
): Promise<string> {
  const resolvedDir = path.resolve(workspaceDir);
  const info = await stat(resolvedDir);
  if (!info.isDirectory()) {
    throw new Error(`论文工作区不是目录：${resolvedDir}`);
  }

  const realWorkspaceDir = await realpath(resolvedDir);
  await runGitImpl(realWorkspaceDir, ['rev-parse', '--show-toplevel']);
  return realWorkspaceDir;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    const detail = [failure.stdout, failure.stderr, failure.message].filter(Boolean).join('\n').trim();
    throw new Error(detail || `git ${args.join(' ')} failed`);
  }
}

function validateCommitMessage(message: string | undefined): string {
  const cleaned = message?.trim();
  if (!cleaned) {
    throw new Error('提交需要 commit message，例如：论文 git commit 更新引言结构');
  }
  if (cleaned.length > 200) {
    throw new Error('commit message 过长，请控制在 200 字符以内。');
  }
  if (/[\r\n\0]/.test(cleaned)) {
    throw new Error('commit message 不能包含换行或空字符。');
  }
  return cleaned;
}

function usageText(): string {
  return [
    '可用论文 Git 命令：',
    '- 论文 git status',
    '- 论文 git diff',
    '- 论文 git log',
    '- 论文 git commit 更新说明',
  ].join('\n');
}

function buildAutoCommitMessage(prompt: string): string {
  const compacted = prompt.replace(/\s+/g, ' ').trim();
  const suffix = compacted ? compacted.slice(0, 120) : 'Feishu agent update';
  return validateCommitMessage(`Auto paper update: ${suffix}`);
}

export async function capturePaperGitSnapshot(
  config: PaperGitConfig,
  dependencies: PaperGitDependencies = {},
): Promise<PaperGitSnapshot> {
  if (!config.gitEnabled) {
    return { enabled: false, reason: '论文 Git 管理未启用。' };
  }
  if (!config.autoCommitEnabled) {
    return { enabled: false, reason: '论文 Git 自动提交未启用。' };
  }
  if (!config.dir) {
    return { enabled: false, reason: '论文 Git 工作区未配置。' };
  }

  const runGitImpl = dependencies.runGit ?? runGit;
  const workspaceDir = await assertGitWorkspace(config.dir, runGitImpl);
  const status = await runGitImpl(workspaceDir, ['status', '--porcelain']);
  return {
    enabled: true,
    workspaceDir,
    status,
  };
}

export async function autoCommitPaperGitChanges(
  config: PaperGitConfig,
  snapshot: PaperGitSnapshot,
  prompt: string,
  dependencies: PaperGitDependencies = {},
): Promise<AutoPaperGitResult> {
  if (!snapshot.enabled || !snapshot.workspaceDir) {
    return { didCommit: false, didPush: false };
  }

  const runGitImpl = dependencies.runGit ?? runGit;
  const maxChars = Math.max(1000, config.maxGitOutputChars);
  if (snapshot.status?.trim()) {
    return {
      didCommit: false,
      didPush: false,
      text: '论文 Git 自动提交跳过：agent 回合开始前工作区已有未提交改动，请先手动检查或提交。',
    };
  }

  const afterStatus = await runGitImpl(snapshot.workspaceDir, ['status', '--porcelain']);
  if (!afterStatus.trim()) {
    return { didCommit: false, didPush: false };
  }

  const commitMessage = buildAutoCommitMessage(prompt);
  await runGitImpl(snapshot.workspaceDir, ['add', '-A']);
  const commitOutput = await runGitImpl(snapshot.workspaceDir, ['commit', '-m', commitMessage]);
  let didPush = false;
  let pushOutput = '';
  let pushError = '';
  if (config.autoPushEnabled) {
    try {
      pushOutput = await runGitImpl(snapshot.workspaceDir, ['push']);
      didPush = true;
    } catch (error) {
      pushError = error instanceof Error ? error.message : String(error);
    }
  }

  const lines = [
    config.autoPushEnabled && didPush ? '论文 Git 已自动提交并推送。' : '论文 Git 已自动提交，未自动推送。',
    formatCodeBlock(truncateOutput(commitOutput, maxChars)),
  ];
  if (pushOutput.trim()) {
    lines.push('推送输出：', formatCodeBlock(truncateOutput(pushOutput, maxChars)));
  }
  if (pushError) {
    lines.push('自动推送失败：', formatCodeBlock(truncateOutput(pushError, maxChars)));
  }

  return {
    didCommit: true,
    didPush,
    text: lines.join('\n'),
  };
}

export async function runPaperGitCommand(
  config: PaperGitConfig,
  command: PaperGitCommand,
  dependencies: PaperGitDependencies = {},
): Promise<PaperGitResult> {
  if (command.message === 'usage') {
    return { handled: true, text: usageText() };
  }
  if (!config.gitEnabled) {
    return { handled: true, text: '论文 Git 管理未启用：BRIDGE_PAPER_GIT_ENABLED=false。' };
  }
  if (!config.dir) {
    return { handled: true, text: '论文 Git 工作区未配置。请设置 BRIDGE_PAPER_WORKSPACE_DIR。' };
  }

  const runGitImpl = dependencies.runGit ?? runGit;
  const workspaceDir = await assertGitWorkspace(config.dir, runGitImpl);
  const maxChars = Math.max(1000, config.maxGitOutputChars);

  if (command.action === 'status') {
    const output = await runGitImpl(workspaceDir, ['status', '--short', '--branch']);
    return { handled: true, text: `论文 Git 状态：\n${formatCodeBlock(truncateOutput(output, maxChars))}` };
  }

  if (command.action === 'diff') {
    const output = await runGitImpl(workspaceDir, ['diff', '--stat']);
    const detail = output || '当前没有未提交 diff。';
    return { handled: true, text: `论文 Git 改动摘要：\n${formatCodeBlock(truncateOutput(detail, maxChars))}` };
  }

  if (command.action === 'log') {
    const output = await runGitImpl(workspaceDir, ['log', '--oneline', '-n', '8']);
    return { handled: true, text: `论文 Git 最近提交：\n${formatCodeBlock(truncateOutput(output, maxChars))}` };
  }

  const commitMessage = validateCommitMessage(command.message);
  const beforeStatus = await runGitImpl(workspaceDir, ['status', '--porcelain']);
  if (!beforeStatus.trim()) {
    return { handled: true, text: '论文 Git 工作区没有可提交的改动。' };
  }

  await runGitImpl(workspaceDir, ['add', '-A']);
  const commitOutput = await runGitImpl(workspaceDir, ['commit', '-m', commitMessage]);
  const afterStatus = await runGitImpl(workspaceDir, ['status', '--short', '--branch']);
  return {
    handled: true,
    text: [
      '论文 Git 提交完成。',
      formatCodeBlock(truncateOutput(commitOutput, maxChars)),
      '当前状态：',
      formatCodeBlock(truncateOutput(afterStatus, maxChars)),
    ].join('\n'),
  };
}
