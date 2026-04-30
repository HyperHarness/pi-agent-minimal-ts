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
