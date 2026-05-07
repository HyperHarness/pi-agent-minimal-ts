import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ManagedRepoConfig {
  key?: string;
  label?: string;
  gitEnabled: boolean;
  dir?: string;
  maxGitOutputChars: number;
  autoCommitEnabled?: boolean;
  autoPushEnabled?: boolean;
}

export type ManagedRepoConfigs = Record<string, ManagedRepoConfig>;

export type RepoGitAction = 'status' | 'diff' | 'log' | 'commit' | 'push';

export interface ManagedRepoCommand {
  repoKey: string;
  action: RepoGitAction;
  message?: string;
}

export interface ManagedRepoResult {
  handled: true;
  text: string;
}

export interface ManagedRepoSnapshot {
  enabled: boolean;
  repoKey?: string;
  label?: string;
  workspaceDir?: string;
  status?: string;
  reason?: string;
}

export interface AutoManagedRepoResult {
  didCommit: boolean;
  didPush: boolean;
  repoKey?: string;
  text?: string;
}

export interface ManagedRepoDependencies {
  runGit?: (cwd: string, args: string[]) => Promise<string>;
}

const FEISHU_MENTION_PLACEHOLDER = /@_user_[A-Za-z0-9_-]+/g;
const REPO_KEY_PATTERN = '[A-Za-z0-9_-]+';

function stripFeishuMentionPlaceholders(text: string): string {
  return text.replace(FEISHU_MENTION_PLACEHOLDER, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeRepoKey(value: string): string {
  return value.trim().toLowerCase();
}

function labelForRepo(config: ManagedRepoConfig, fallbackKey = 'repo'): string {
  return config.label?.trim() || config.key?.trim() || fallbackKey;
}

function parseAction(value: string): RepoGitAction | null {
  const action = value.trim().toLowerCase();
  if (action === 'status' || action === '状态') {
    return 'status';
  }
  if (action === 'diff' || action === '差异' || action === '改动') {
    return 'diff';
  }
  if (action === 'log' || action === '日志' || action === '历史') {
    return 'log';
  }
  if (action === 'commit' || action === '提交') {
    return 'commit';
  }
  if (action === 'push' || action === '推送') {
    return 'push';
  }
  return null;
}

export function parseManagedRepoCommand(text: string): ManagedRepoCommand | null {
  const trimmed = stripFeishuMentionPlaceholders(text);
  const actionFirst = trimmed.match(new RegExp(`^/?repo\\s+(\\S+)\\s+(${REPO_KEY_PATTERN})(?:\\s+(.+))?$`, 'is'));
  if (actionFirst) {
    const action = parseAction(actionFirst[1]);
    if (action) {
      const repoKey = normalizeRepoKey(actionFirst[2]);
      if (action === 'commit') {
        const message = stripFeishuMentionPlaceholders(actionFirst[3] ?? '');
        return message ? { repoKey, action, message } : { repoKey, action: 'status', message: 'usage' };
      }
      return { repoKey, action };
    }
  }

  const repoFirst = trimmed.match(new RegExp(`^/?repo\\s+(${REPO_KEY_PATTERN})\\s+(\\S+)(?:\\s+(.+))?$`, 'is'));
  if (repoFirst) {
    const action = parseAction(repoFirst[2]);
    if (!action) {
      return { repoKey: normalizeRepoKey(repoFirst[1]), action: 'status', message: 'usage' };
    }
    const repoKey = normalizeRepoKey(repoFirst[1]);
    if (action === 'commit') {
      const message = stripFeishuMentionPlaceholders(repoFirst[3] ?? '');
      return message ? { repoKey, action, message } : { repoKey, action: 'status', message: 'usage' };
    }
    return { repoKey, action };
  }

  return null;
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
  config: ManagedRepoConfig,
  runGitImpl: (cwd: string, args: string[]) => Promise<string>,
): Promise<string> {
  if (!config.dir) {
    throw new Error(`${labelForRepo(config)} Git 工作区未配置。`);
  }

  const resolvedDir = path.resolve(config.dir);
  const info = await stat(resolvedDir);
  if (!info.isDirectory()) {
    throw new Error(`${labelForRepo(config)} Git 工作区不是目录：${resolvedDir}`);
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

function validateCommitMessage(message: string | undefined, noun = 'repo'): string {
  const cleaned = message?.trim();
  if (!cleaned) {
    throw new Error(`提交需要 commit message，例如：repo commit ${noun} 更新说明`);
  }
  if (cleaned.length > 200) {
    throw new Error('commit message 过长，请控制在 200 字符以内。');
  }
  if (/[\r\n\0]/.test(cleaned)) {
    throw new Error('commit message 不能包含换行或空字符。');
  }
  return cleaned;
}

function usageText(configs?: ManagedRepoConfigs): string {
  const repoKeys = configs && Object.keys(configs).length > 0
    ? Object.keys(configs).sort().join(', ')
    : 'paper, design';
  return [
    '可用 Repo Git 命令：',
    '- repo status paper',
    '- repo diff design',
    '- repo log paper',
    '- repo commit design 更新说明',
    '- repo push design',
    `已知 repo：${repoKeys}`,
  ].join('\n');
}

function buildAutoCommitMessage(prompt: string, config: ManagedRepoConfig): string {
  const compacted = stripFeishuMentionPlaceholders(prompt);
  const suffix = compacted ? compacted.slice(0, 120) : 'Feishu agent update';
  const noun = (config.key ?? labelForRepo(config, 'repo')).toLowerCase().replace(/\s+/g, '-');
  return validateCommitMessage(`Auto ${noun} update: ${suffix}`, config.key ?? 'repo');
}

function resolveManagedRepoConfig(configs: ManagedRepoConfigs, repoKey: string): ManagedRepoConfig | undefined {
  const normalized = normalizeRepoKey(repoKey);
  const config = configs[normalized];
  if (!config) {
    return undefined;
  }
  return { ...config, key: config.key ?? normalized };
}

export async function captureManagedRepoSnapshot(
  config: ManagedRepoConfig,
  dependencies: ManagedRepoDependencies = {},
): Promise<ManagedRepoSnapshot> {
  const label = labelForRepo(config);
  if (!config.gitEnabled) {
    return { enabled: false, repoKey: config.key, label, reason: `${label} Git 管理未启用。` };
  }
  if (!config.autoCommitEnabled) {
    return { enabled: false, repoKey: config.key, label, reason: `${label} Git 自动提交未启用。` };
  }
  if (!config.dir) {
    return { enabled: false, repoKey: config.key, label, reason: `${label} Git 工作区未配置。` };
  }

  const runGitImpl = dependencies.runGit ?? runGit;
  const workspaceDir = await assertGitWorkspace(config, runGitImpl);
  const status = await runGitImpl(workspaceDir, ['status', '--porcelain']);
  return {
    enabled: true,
    repoKey: config.key,
    label,
    workspaceDir,
    status,
  };
}

export async function captureManagedRepoSnapshots(
  configs: ManagedRepoConfigs,
  dependencies: ManagedRepoDependencies = {},
): Promise<ManagedRepoSnapshot[]> {
  const snapshots: ManagedRepoSnapshot[] = [];
  for (const [repoKey, rawConfig] of Object.entries(configs)) {
    const config = { ...rawConfig, key: rawConfig.key ?? repoKey };
    if (!config.autoCommitEnabled) {
      continue;
    }
    snapshots.push(await captureManagedRepoSnapshot(config, dependencies));
  }
  return snapshots;
}

export async function autoCommitManagedRepoChanges(
  config: ManagedRepoConfig,
  snapshot: ManagedRepoSnapshot,
  prompt: string,
  dependencies: ManagedRepoDependencies = {},
): Promise<AutoManagedRepoResult> {
  if (!snapshot.enabled || !snapshot.workspaceDir) {
    return { didCommit: false, didPush: false, repoKey: snapshot.repoKey };
  }

  const runGitImpl = dependencies.runGit ?? runGit;
  const maxChars = Math.max(1000, config.maxGitOutputChars);
  const label = labelForRepo(config, snapshot.label ?? snapshot.repoKey ?? 'repo');
  if (snapshot.status?.trim()) {
    return {
      didCommit: false,
      didPush: false,
      repoKey: snapshot.repoKey,
      text: `${label} Git 自动提交跳过：agent 回合开始前工作区已有未提交改动，请先手动检查或提交。`,
    };
  }

  const afterStatus = await runGitImpl(snapshot.workspaceDir, ['status', '--porcelain']);
  if (!afterStatus.trim()) {
    return { didCommit: false, didPush: false, repoKey: snapshot.repoKey };
  }

  const commitMessage = buildAutoCommitMessage(prompt, config);
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
    config.autoPushEnabled && didPush ? `${label} Git 已自动提交并推送。` : `${label} Git 已自动提交，未自动推送。`,
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
    repoKey: snapshot.repoKey,
    text: lines.join('\n'),
  };
}

export async function autoCommitManagedRepos(
  configs: ManagedRepoConfigs,
  snapshots: ManagedRepoSnapshot[],
  prompt: string,
  dependencies: ManagedRepoDependencies = {},
): Promise<AutoManagedRepoResult[]> {
  const results: AutoManagedRepoResult[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot.repoKey) {
      continue;
    }
    const config = resolveManagedRepoConfig(configs, snapshot.repoKey);
    if (!config) {
      continue;
    }
    results.push(await autoCommitManagedRepoChanges(config, snapshot, prompt, dependencies));
  }
  return results;
}

export async function runManagedRepoCommand(
  configs: ManagedRepoConfigs,
  command: ManagedRepoCommand,
  dependencies: ManagedRepoDependencies = {},
): Promise<ManagedRepoResult> {
  if (command.message === 'usage') {
    return { handled: true, text: usageText(configs) };
  }

  const config = resolveManagedRepoConfig(configs, command.repoKey);
  if (!config) {
    return {
      handled: true,
      text: `未知 repo：${command.repoKey}\n\n${usageText(configs)}`,
    };
  }

  const label = labelForRepo(config, command.repoKey);
  if (!config.gitEnabled) {
    return { handled: true, text: `${label} Git 管理未启用。` };
  }
  if (!config.dir) {
    return { handled: true, text: `${label} Git 工作区未配置。` };
  }

  const runGitImpl = dependencies.runGit ?? runGit;
  const workspaceDir = await assertGitWorkspace(config, runGitImpl);
  const maxChars = Math.max(1000, config.maxGitOutputChars);

  if (command.action === 'status') {
    const output = await runGitImpl(workspaceDir, ['status', '--short', '--branch']);
    return { handled: true, text: `${label} Git 状态：\n${formatCodeBlock(truncateOutput(output, maxChars))}` };
  }

  if (command.action === 'diff') {
    const output = await runGitImpl(workspaceDir, ['diff', '--stat']);
    const detail = output || '当前没有未提交 diff。';
    return { handled: true, text: `${label} Git 改动摘要：\n${formatCodeBlock(truncateOutput(detail, maxChars))}` };
  }

  if (command.action === 'log') {
    const output = await runGitImpl(workspaceDir, ['log', '--oneline', '-n', '8']);
    return { handled: true, text: `${label} Git 最近提交：\n${formatCodeBlock(truncateOutput(output, maxChars))}` };
  }

  if (command.action === 'push') {
    const output = await runGitImpl(workspaceDir, ['push']);
    return { handled: true, text: `${label} Git 推送完成：\n${formatCodeBlock(truncateOutput(output, maxChars))}` };
  }

  const commitMessage = validateCommitMessage(command.message, command.repoKey);
  const beforeStatus = await runGitImpl(workspaceDir, ['status', '--porcelain']);
  if (!beforeStatus.trim()) {
    return { handled: true, text: `${label} Git 工作区没有可提交的改动。` };
  }

  await runGitImpl(workspaceDir, ['add', '-A']);
  const commitOutput = await runGitImpl(workspaceDir, ['commit', '-m', commitMessage]);
  const afterStatus = await runGitImpl(workspaceDir, ['status', '--short', '--branch']);
  return {
    handled: true,
    text: [
      `${label} Git 提交完成。`,
      formatCodeBlock(truncateOutput(commitOutput, maxChars)),
      '当前状态：',
      formatCodeBlock(truncateOutput(afterStatus, maxChars)),
    ].join('\n'),
  };
}
