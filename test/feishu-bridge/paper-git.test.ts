import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  autoCommitManagedRepoChanges,
  captureManagedRepoSnapshot,
  parseManagedRepoCommand,
  runManagedRepoCommand,
} from '../../src/feishu-bridge/paper-git.js';

test('parseManagedRepoCommand recognizes generic repo commands', () => {
  assert.deepEqual(parseManagedRepoCommand('repo status paper'), { repoKey: 'paper', action: 'status' });
  assert.deepEqual(parseManagedRepoCommand('repo paper status'), { repoKey: 'paper', action: 'status' });
  assert.deepEqual(parseManagedRepoCommand('/repo diff design'), { repoKey: 'design', action: 'diff' });
  assert.deepEqual(parseManagedRepoCommand('repo commit design 添加频率规划 demo'), {
    repoKey: 'design',
    action: 'commit',
    message: '添加频率规划 demo',
  });
  assert.deepEqual(parseManagedRepoCommand('repo push design'), { repoKey: 'design', action: 'push' });
  assert.equal(parseManagedRepoCommand('设计 git status'), null);
  assert.equal(parseManagedRepoCommand('论文 git status'), null);
  assert.equal(parseManagedRepoCommand('请 wiki agent 修改论文'), null);
});

test('runManagedRepoCommand returns design status with the configured workspace', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'design-git-workspace-'));
  try {
    const calls: string[][] = [];
    const result = await runManagedRepoCommand(
      {
        design: {
          key: 'design',
          label: '设计',
          gitEnabled: true,
          dir: workspaceDir,
          maxGitOutputChars: 6000,
        },
      },
      { repoKey: 'design', action: 'status' },
      {
        runGit: async (_cwd, args) => {
          calls.push(args);
          return args[0] === 'status' ? '## main\n M src/frequency_plan.py' : workspaceDir;
        },
      },
    );

    assert.match(result.text, /设计 Git 状态/);
    assert.match(result.text, /M src\/frequency_plan\.py/);
    assert.deepEqual(calls, [
      ['rev-parse', '--show-toplevel'],
      ['status', '--short', '--branch'],
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('runManagedRepoCommand pushes a managed repo through controlled git args', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'design-git-workspace-'));
  try {
    const calls: string[][] = [];
    const result = await runManagedRepoCommand(
      {
        design: {
          key: 'design',
          label: '设计',
          gitEnabled: true,
          dir: workspaceDir,
          maxGitOutputChars: 6000,
        },
      },
      { repoKey: 'design', action: 'push' },
      {
        runGit: async (_cwd, args) => {
          calls.push(args);
          return args[0] === 'push' ? 'pushed' : workspaceDir;
        },
      },
    );

    assert.match(result.text, /设计 Git 推送完成/);
    assert.deepEqual(calls, [
      ['rev-parse', '--show-toplevel'],
      ['push'],
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('runManagedRepoCommand reports unconfigured paper workspace without starting git', async () => {
  assert.deepEqual(
    await runManagedRepoCommand(
      {
        paper: {
          key: 'paper',
          label: '论文',
          gitEnabled: true,
          maxGitOutputChars: 6000,
        },
      },
      { repoKey: 'paper', action: 'status' },
    ),
    {
      handled: true,
      text: '论文 Git 工作区未配置。',
    },
  );
});

test('runManagedRepoCommand returns paper status with the configured workspace', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'paper-git-workspace-'));
  try {
    const calls: string[][] = [];
    const result = await runManagedRepoCommand(
      {
        paper: {
          key: 'paper',
          label: '论文',
          gitEnabled: true,
          dir: workspaceDir,
          maxGitOutputChars: 6000,
        },
      },
      { repoKey: 'paper', action: 'status' },
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

test('runManagedRepoCommand commits all paper workspace changes through controlled git args', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'paper-git-workspace-'));
  try {
    const calls: string[][] = [];
    const commit = await runManagedRepoCommand(
      {
        paper: {
          key: 'paper',
          label: '论文',
          gitEnabled: true,
          dir: workspaceDir,
          maxGitOutputChars: 6000,
        },
      },
      { repoKey: 'paper', action: 'commit', message: '初始化论文草稿' },
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

test('captureManagedRepoSnapshot is disabled until auto commit is enabled', async () => {
  assert.deepEqual(
    await captureManagedRepoSnapshot({
      key: 'paper',
      label: '论文',
      gitEnabled: true,
      dir: '/not/used',
      maxGitOutputChars: 6000,
      autoCommitEnabled: false,
    }),
    {
      enabled: false,
      repoKey: 'paper',
      label: '论文',
      reason: '论文 Git 自动提交未启用。',
    },
  );
});

test('autoCommitManagedRepoChanges commits and pushes when a clean paper snapshot becomes dirty', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'paper-git-workspace-'));
  try {
    const calls: string[][] = [];
    const config = {
      key: 'paper',
      label: '论文',
      gitEnabled: true,
      dir: workspaceDir,
      maxGitOutputChars: 6000,
      autoCommitEnabled: true,
      autoPushEnabled: true,
    };
    const snapshot = await captureManagedRepoSnapshot(
      config,
      {
        runGit: async (_cwd, args) => {
          calls.push(args);
          return '';
        },
      },
    );

    const result = await autoCommitManagedRepoChanges(
      config,
      snapshot,
      '@_user_1 请修改论文引言',
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

test('autoCommitManagedRepoChanges uses repo-specific labels and commit messages', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'design-git-workspace-'));
  try {
    const calls: string[][] = [];
    const config = {
      key: 'design',
      label: '设计',
      gitEnabled: true,
      dir: workspaceDir,
      maxGitOutputChars: 6000,
      autoCommitEnabled: true,
      autoPushEnabled: false,
    };
    const snapshot = await captureManagedRepoSnapshot(config, {
      runGit: async (_cwd, args) => {
        calls.push(args);
        return '';
      },
    });

    const result = await autoCommitManagedRepoChanges(
      config,
      snapshot,
      '@_user_1 请增加 frequency planning demo',
      {
        runGit: async (_cwd, args) => {
          calls.push(args);
          if (args[0] === 'status') {
            return ' M src/frequency_plan.py';
          }
          if (args[0] === 'commit') {
            return '[main 3456789] Auto design update: 请增加 frequency planning demo';
          }
          return '';
        },
      },
    );

    assert.equal(result.didCommit, true);
    assert.equal(result.didPush, false);
    assert.match(result.text ?? '', /设计 Git 已自动提交/);
    assert.deepEqual(calls, [
      ['rev-parse', '--show-toplevel'],
      ['status', '--porcelain'],
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', 'Auto design update: 请增加 frequency planning demo'],
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('autoCommitManagedRepoChanges skips when the paper repo was dirty before the agent turn', async () => {
  const result = await autoCommitManagedRepoChanges(
    {
      key: 'paper',
      label: '论文',
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
