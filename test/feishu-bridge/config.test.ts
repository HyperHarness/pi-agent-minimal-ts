import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeWindowsEnvOutput, loadConfig } from '../../src/feishu-bridge/config.js';

function withEnv(env: NodeJS.ProcessEnv, fn: () => void): void {
  const originalEnv = process.env;
  process.env = { ...env };
  try {
    fn();
  } finally {
    process.env = originalEnv;
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-feishu-config-'));
}

test('loadConfig reads PI_BASE_URL, PI_MODEL, and OPENAI_API_KEY from environment', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      PI_BASE_URL: 'https://relay.example.com/v1',
      PI_MODEL: 'gpt-5.5',
      OPENAI_API_KEY: 'sk-test-secret',
    },
    () => {
      const config = loadConfig(makeTempDir());

      assert.equal(config.pi.baseUrl, 'https://relay.example.com/v1');
      assert.equal(config.pi.model, 'gpt-5.5');
      assert.equal(config.pi.apiKey, 'sk-test-secret');
    },
  );
});

test('loadConfig defaults PI_PROVIDER to openai-compatible when relay env is configured', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      PI_BASE_URL: 'https://relay.example.com/v1',
      PI_MODEL: 'gpt-5.5',
      OPENAI_API_KEY: 'sk-test-secret',
    },
    () => {
      const config = loadConfig(makeTempDir());

      assert.equal(config.pi.provider, 'openai-compatible');
    },
  );
});

test('loadConfig also accepts OPENAI_BASE_URL as the OpenAI-compatible relay URL', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      OPENAI_BASE_URL: 'https://relay.example.com/v1',
      PI_MODEL: 'gpt-5.5',
      OPENAI_API_KEY: 'sk-test-secret',
    },
    () => {
      const config = loadConfig(makeTempDir());

      assert.equal(config.pi.provider, 'openai-compatible');
      assert.equal(config.pi.baseUrl, 'https://relay.example.com/v1');
    },
  );
});

test('loadConfig does not default to openai-compatible only because OPENAI_API_KEY is present', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      OPENAI_API_KEY: 'sk-test-secret',
    },
    () => {
      const config = loadConfig(makeTempDir());

      assert.equal(config.pi.provider, undefined);
      assert.equal(config.pi.baseUrl, undefined);
      assert.equal(config.pi.apiKey, 'sk-test-secret');
    },
  );
});

test('loadConfig excludes agent messages from prompt history by default', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
    },
    () => {
      const config = loadConfig(makeTempDir());

      assert.equal(config.memory.includeAgentMessagesInHistory, false);
    },
  );
});

test('loadConfig can include agent messages in prompt history when explicitly enabled', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      BRIDGE_INCLUDE_AGENT_MESSAGES_IN_HISTORY: 'true',
    },
    () => {
      const config = loadConfig(makeTempDir());

      assert.equal(config.memory.includeAgentMessagesInHistory, true);
    },
  );
});

test('loadConfig sends downloaded PDFs to Feishu by default', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
    },
    () => {
      const config = loadConfig(makeTempDir());

      assert.equal(config.feishu.sendDownloadedPdf, true);
      assert.equal(config.feishu.maxPdfUploadMb, 30);
    },
  );
});

test('loadConfig controls downloaded PDF delivery to Feishu', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      FEISHU_SEND_DOWNLOADED_PDF: 'true',
      FEISHU_MAX_PDF_UPLOAD_MB: '12',
    },
    () => {
      const config = loadConfig(makeTempDir());

      assert.equal(config.feishu.sendDownloadedPdf, true);
      assert.equal(config.feishu.maxPdfUploadMb, 12);
    },
  );
});

test('loadConfig reads paper Git workspace settings', () => {
  const cwd = makeTempDir();
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      BRIDGE_PAPER_WORKSPACE_DIR: 'paper-projects/current-paper',
      BRIDGE_PAPER_GIT_ENABLED: 'false',
      BRIDGE_PAPER_GIT_MAX_OUTPUT_CHARS: '1234',
      BRIDGE_PAPER_GIT_AUTO_COMMIT: 'true',
      BRIDGE_PAPER_GIT_AUTO_PUSH: 'true',
    },
    () => {
      const config = loadConfig(cwd);

      assert.equal(config.paperWorkspace.gitEnabled, false);
      assert.equal(config.paperWorkspace.dir, path.join(cwd, 'paper-projects', 'current-paper'));
      assert.equal(config.paperWorkspace.compiledPdfPath, 'manuscript/main.pdf');
      assert.equal(config.paperWorkspace.maxGitOutputChars, 1234);
      assert.equal(config.paperWorkspace.autoCommitEnabled, true);
      assert.equal(config.paperWorkspace.autoPushEnabled, true);
      assert.equal(config.managedRepos.paper.label, '论文');
      assert.equal(config.managedRepos.paper.gitEnabled, false);
      assert.equal(config.managedRepos.paper.dir, path.join(cwd, 'paper-projects', 'current-paper'));
      assert.equal(config.managedRepos.paper.autoCommitEnabled, true);
      assert.equal(config.managedRepos.paper.autoPushEnabled, true);
    },
  );
});

test('loadConfig reads design managed repo settings', () => {
  const cwd = makeTempDir();
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      BRIDGE_DESIGN_WORKSPACE_DIR: 'design-workspaces/minimal-demo',
      BRIDGE_DESIGN_GIT_ENABLED: 'true',
      BRIDGE_DESIGN_GIT_MAX_OUTPUT_CHARS: '4321',
      BRIDGE_DESIGN_GIT_AUTO_COMMIT: 'true',
      BRIDGE_DESIGN_GIT_AUTO_PUSH: 'false',
    },
    () => {
      const config = loadConfig(cwd);

      assert.equal(config.managedRepos.design.label, '设计');
      assert.equal(config.managedRepos.design.gitEnabled, true);
      assert.equal(config.managedRepos.design.dir, path.join(cwd, 'design-workspaces', 'minimal-demo'));
      assert.equal(config.managedRepos.design.maxGitOutputChars, 4321);
      assert.equal(config.managedRepos.design.autoCommitEnabled, true);
      assert.equal(config.managedRepos.design.autoPushEnabled, false);
      assert.equal(config.managedRepos.wiki.gitEnabled, false);
    },
  );
});

test('loadConfig reads the compiled paper PDF path', () => {
  const cwd = makeTempDir();
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      BRIDGE_PAPER_WORKSPACE_DIR: 'paper-projects/current-paper',
      BRIDGE_PAPER_COMPILED_PDF_PATH: 'build/current.pdf',
    },
    () => {
      const config = loadConfig(cwd);

      assert.equal(config.paperWorkspace.compiledPdfPath, 'build/current.pdf');
    },
  );
});

test('loadConfig defaults the bridge to this repository agent RPC entrypoint', () => {
  const cwd = makeTempDir();
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
    },
    () => {
      const config = loadConfig(cwd);

      assert.equal(config.pi.command, process.execPath);
      assert.deepEqual(config.pi.commandArgs, [path.join(cwd, 'dist', 'src', 'pi-agent.js')]);
    },
  );
});

test('loadConfig lets PI_COMMAND override the built-in agent entrypoint', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      PI_COMMAND: 'pi',
    },
    () => {
      const config = loadConfig(makeTempDir());

      assert.equal(config.pi.command, 'pi');
      assert.deepEqual(config.pi.commandArgs, []);
    },
  );
});

test('loadConfig rejects invalid OpenAI-compatible relay URLs before starting pi', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      PI_BASE_URL: 'not-a-url',
      PI_MODEL: 'gpt-5.5',
      OPENAI_API_KEY: 'sk-test-secret',
    },
    () => {
      assert.throws(() => loadConfig(makeTempDir()), /PI_BASE_URL\/OPENAI_BASE_URL 必须是有效的 http\(s\) URL/);
    },
  );
});

test('loadConfig rejects non-ASCII API keys before they reach fetch headers', () => {
  withEnv(
    {
      FEISHU_APP_ID: 'cli-test-app',
      FEISHU_APP_SECRET: 'cli-test-secret',
      PI_BASE_URL: 'https://relay.example.com/v1',
      PI_MODEL: 'gpt-5.5',
      OPENAI_API_KEY: 'sk-test-歳',
    },
    () => {
      assert.throws(() => loadConfig(makeTempDir()), /OPENAI_API_KEY 包含非 ASCII 字符/);
    },
  );
});

test('decodeWindowsEnvOutput reads UTF-8 PowerShell output without corrupting API keys', () => {
  assert.equal(decodeWindowsEnvOutput(Buffer.from('sk-test-secret\r\n', 'utf8')), 'sk-test-secret');
});

test('decodeWindowsEnvOutput still handles UTF-16LE PowerShell output', () => {
  assert.equal(decodeWindowsEnvOutput(Buffer.from('sk-test-secret\r\n', 'utf16le')), 'sk-test-secret');
});

test('loadConfig lets process env override .env values for PI_BASE_URL, PI_MODEL, and OPENAI_API_KEY', () => {
  const dir = makeTempDir();
  fs.writeFileSync(
    path.join(dir, '.env'),
    [
      'FEISHU_APP_ID=file-app',
      'FEISHU_APP_SECRET=file-secret',
      'PI_BASE_URL=https://file.example.com/v1',
      'PI_MODEL=file-model',
      'OPENAI_API_KEY=file-key',
    ].join('\n'),
    'utf-8',
  );

  withEnv(
    {
      PI_BASE_URL: 'https://relay.example.com/v1',
      PI_MODEL: 'gpt-5.5',
      OPENAI_API_KEY: 'sk-env-secret',
    },
    () => {
      const config = loadConfig(dir);

      assert.equal(config.feishu.appId, 'file-app');
      assert.equal(config.feishu.appSecret, 'file-secret');
      assert.equal(config.pi.baseUrl, 'https://relay.example.com/v1');
      assert.equal(config.pi.model, 'gpt-5.5');
      assert.equal(config.pi.apiKey, 'sk-env-secret');
    },
  );
});
