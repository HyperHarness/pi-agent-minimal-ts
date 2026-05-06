import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  autoCommitPaperGitChanges,
  capturePaperGitSnapshot,
  parsePaperGitCommand,
  runPaperGitCommand,
} from '../../src/feishu-bridge/paper-git.js';

test('parsePaperGitCommand recognizes bridge paper git commands', () => {
  assert.deepEqual(parsePaperGitCommand('论文 git status'), { action: 'status' });
  assert.deepEqual(parsePaperGitCommand('论文git状态'), { action: 'status' });
  assert.deepEqual(parsePaperGitCommand('/paper git diff'), { action: 'diff' });
  assert.deepEqual(parsePaperGitCommand('paper git log'), { action: 'log' });
  assert.deepEqual(parsePaperGitCommand('论文 git commit 更新引言'), {
    action: 'commit',
    message: '更新引言',
  });
  assert.equal(parsePaperGitCommand('请 wiki agent 修改论文'), null);
});

test('runPaperGitCommand reports unconfigured workspace without starting git', async () => {
  assert.deepEqual(
    await runPaperGitCommand({ gitEnabled: true, maxGitOutputChars: 6000 }, { action: 'status' }),
    {
      handled: true,
      text: '论文 Git 工作区未配置。请设置 BRIDGE_PAPER_WORKSPACE_DIR。',
    },
  );
});

test('runPaperGitCommand returns status with the configured workspace', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'paper-git-workspace-'));
  try {
    const calls: string[][] = [];
    const result = await runPaperGitCommand(
      { gitEnabled: true, dir: workspaceDir, maxGitOutputChars: 6000 },
      { action: 'status' },
      {
        runGit: async (_cwd, args) => {
          calls.push(args);
          return args[0] === 'status' ? '## main\n M manuscript/main.tex' : workspaceDir;
        },
      },
    );

    assert.match(result.text, /论文 Git 状态/);
    assert.match(result.text, /M manuscript\/main\.tex/);
    assert.deepEqual(calls, [
      ['rev-parse', '--show-toplevel'],
      ['status', '--short', '--branch'],
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('runPaperGitCommand commits all workspace changes through controlled git args', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'paper-git-workspace-'));
  try {
    const calls: string[][] = [];
    const commit = await runPaperGitCommand(
      { gitEnabled: true, dir: workspaceDir, maxGitOutputChars: 6000 },
      { action: 'commit', message: '初始化论文草稿' },
      {
        runGit: async (_cwd, args) => {
          calls.push(args);
          if (args[0] === 'status' && args[1] === '--porcelain') {
            return '?? manuscript/main.tex';
          }
          if (args[0] === 'commit') {
            return '[main 1234567] 初始化论文草稿';
          }
          if (args[0] === 'status') {
            return '## main';
          }
          return workspaceDir;
        },
      },
    );

    assert.match(commit.text, /论文 Git 提交完成/);
    assert.match(commit.text, /初始化论文草稿/);
    assert.deepEqual(calls, [
      ['rev-parse', '--show-toplevel'],
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', '初始化论文草稿'],
      ['status', '--short', '--branch'],
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('capturePaperGitSnapshot is disabled until auto commit is enabled', async () => {
  assert.deepEqual(
    await capturePaperGitSnapshot({
      gitEnabled: true,
      dir: '/not/used',
      maxGitOutputChars: 6000,
      autoCommitEnabled: false,
    }),
    {
      enabled: false,
      reason: '论文 Git 自动提交未启用。',
    },
  );
});

test('autoCommitPaperGitChanges commits and pushes when a clean snapshot becomes dirty', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'paper-git-workspace-'));
  try {
    const calls: string[][] = [];
    const snapshot = await capturePaperGitSnapshot(
      {
        gitEnabled: true,
        dir: workspaceDir,
        maxGitOutputChars: 6000,
        autoCommitEnabled: true,
        autoPushEnabled: true,
      },
      {
        runGit: async (_cwd, args) => {
          calls.push(args);
          return '';
        },
      },
    );

    const result = await autoCommitPaperGitChanges(
      {
        gitEnabled: true,
        dir: workspaceDir,
        maxGitOutputChars: 6000,
        autoCommitEnabled: true,
        autoPushEnabled: true,
      },
      snapshot,
      '请修改论文引言',
      {
        runGit: async (_cwd, args) => {
          calls.push(args);
          if (args[0] === 'status') {
            return ' M manuscript/main.tex';
          }
          if (args[0] === 'commit') {
            return '[main 2345678] Auto paper update: 请修改论文引言';
          }
          if (args[0] === 'push') {
            return 'pushed';
          }
          return '';
        },
      },
    );

    assert.equal(result.didCommit, true);
    assert.equal(result.didPush, true);
    assert.match(result.text ?? '', /已自动提交并推送/);
    assert.deepEqual(calls, [
      ['rev-parse', '--show-toplevel'],
      ['status', '--porcelain'],
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', 'Auto paper update: 请修改论文引言'],
      ['push'],
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('autoCommitPaperGitChanges skips when the paper repo was dirty before the agent turn', async () => {
  const result = await autoCommitPaperGitChanges(
    {
      gitEnabled: true,
      dir: '/not/used',
      maxGitOutputChars: 6000,
      autoCommitEnabled: true,
      autoPushEnabled: true,
    },
    {
      enabled: true,
      workspaceDir: '/paper',
      status: ' M manuscript/main.tex',
    },
    '请继续修改',
    {
      runGit: async () => {
        throw new Error('git should not run');
      },
    },
  );

  assert.equal(result.didCommit, false);
  assert.equal(result.didPush, false);
  assert.match(result.text ?? '', /已有未提交改动/);
});
