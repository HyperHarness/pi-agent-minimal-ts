import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiRpcClient } from '../../src/feishu-bridge/pi-client.js';

class FakeStream extends EventEmitter {}

class FakeChildProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  writes: string[] = [];
  stdin = {
    write: (data: string, callback?: (error?: Error | null) => void) => {
      this.writes.push(data);
      callback?.(null);
      return true;
    },
  };
  killCalled = false;

  kill(): boolean {
    this.killCalled = true;
    this.emit('exit', 0);
    return true;
  }
}

test('PiRpcClient start passes explicit provider and model arguments to pi', async () => {
  const child = new FakeChildProcess();
  let capturedArgs: readonly string[] = [];
  const client = new PiRpcClient(
    { command: 'pi', useSession: true, sessionDir: '/tmp/bridge-session', provider: 'openai-codex', model: 'gpt-5.4' },
    {
      spawnFn: (_command, args) => {
        capturedArgs = Array.isArray(args) ? args : [];
        return child as never;
      },
      startupTimeoutMs: 5,
    },
  );

  await client.start();

  assert.deepEqual(capturedArgs, ['--mode', 'rpc', '--session-dir', '/tmp/bridge-session', '--provider', 'openai-codex', '--model', 'gpt-5.4']);
});

test('PiRpcClient start passes OpenAI-compatible base URL and API key through the child environment', async () => {
  const child = new FakeChildProcess();
  let capturedArgs: readonly string[] = [];
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const client = new PiRpcClient(
    {
      command: 'pi',
      useSession: true,
      sessionDir: '/tmp/bridge-session',
      model: 'gpt-5.5',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-test-secret',
    },
    {
      spawnFn: ((_command: string, args: readonly string[] | undefined, options: { env?: NodeJS.ProcessEnv } | undefined) => {
        capturedArgs = Array.isArray(args) ? args : [];
        capturedEnv = options?.env;
        return child as never;
      }) as never,
      startupTimeoutMs: 5,
    },
  );

  await client.start();

  assert.deepEqual(capturedArgs, [
    '--mode',
    'rpc',
    '--session-dir',
    '/tmp/bridge-session',
    '--provider',
    'openai-compatible',
    '--model',
    'gpt-5.5',
  ]);
  assert.equal(capturedEnv?.PI_BASE_URL, 'https://relay.example.com/v1');
  assert.equal(capturedEnv?.OPENAI_BASE_URL, 'https://relay.example.com/v1');
  assert.equal(capturedEnv?.OPENAI_API_KEY, 'sk-test-secret');
});

test('PiRpcClient start does not force openai-compatible when only an API key is configured', async () => {
  const child = new FakeChildProcess();
  let capturedArgs: readonly string[] = [];
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const client = new PiRpcClient(
    {
      command: 'pi',
      useSession: true,
      apiKey: 'sk-test-secret',
    },
    {
      spawnFn: ((_command: string, args: readonly string[] | undefined, options: { env?: NodeJS.ProcessEnv } | undefined) => {
        capturedArgs = Array.isArray(args) ? args : [];
        capturedEnv = options?.env;
        return child as never;
      }) as never,
      startupTimeoutMs: 5,
    },
  );

  await client.start();

  assert.deepEqual(capturedArgs, ['--mode', 'rpc']);
  assert.equal(capturedEnv?.OPENAI_API_KEY, 'sk-test-secret');
});

test('PiRpcClient start rejects when startup readiness times out', async () => {
  const child = new FakeChildProcess();
  const client = new PiRpcClient(
    { command: 'pi', useSession: true },
    {
      spawnFn: () => child as never,
      startupTimeoutMs: 5,
      requireReadyEvent: true,
    },
  );

  await assert.rejects(client.start(), /PI RPC 启动超时/);
});

test('PiRpcClient start can treat a live process as ready without an initial event', async () => {
  const child = new FakeChildProcess();
  const client = new PiRpcClient(
    { command: 'pi', useSession: true },
    {
      spawnFn: () => child as never,
      startupTimeoutMs: 5,
    },
  );

  await assert.doesNotReject(client.start());
  assert.equal(client.isProcessReady(), true);
});

test('PiRpcClient rejects in-flight prompt when process exits before agent_end', async () => {
  const child = new FakeChildProcess();
  const client = new PiRpcClient(
    { command: 'pi', useSession: true },
    {
      spawnFn: () => child as never,
      startupTimeoutMs: 50,
    },
  );

  const startPromise = client.start();
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));
  await startPromise;

  const promptPromise = client.prompt('hello');
  child.stdout.emit('data', Buffer.from('{"type":"response","id":"cmd-1","success":true}\n'));
  child.stdout.emit('data', Buffer.from('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"partial"}}\n'));
  child.emit('exit', 1);

  await assert.rejects(promptPromise, /PI 进程已退出/);
});

test('PiRpcClient rejects concurrent prompts on the same client', async () => {
  const child = new FakeChildProcess();
  const client = new PiRpcClient(
    { command: 'pi', useSession: true },
    {
      spawnFn: () => child as never,
      startupTimeoutMs: 50,
    },
  );

  const startPromise = client.start();
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));
  await startPromise;

  const firstPrompt = client.prompt('hello');
  child.stdout.emit('data', Buffer.from('{"type":"response","id":"cmd-1","success":true}\n'));

  await assert.rejects(client.prompt('second'), /已有进行中的 prompt/);

  child.stdout.emit('data', Buffer.from('{"type":"agent_end"}\n'));
  await assert.doesNotReject(firstPrompt);
});

test('PiRpcClient prompt sends streamingBehavior followUp by default', async () => {
  const child = new FakeChildProcess();
  const client = new PiRpcClient(
    { command: 'pi', useSession: true },
    {
      spawnFn: () => child as never,
      startupTimeoutMs: 50,
    },
  );

  const startPromise = client.start();
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));
  await startPromise;

  const promptPromise = client.prompt('hello');
  child.stdout.emit('data', Buffer.from('{"type":"response","id":"cmd-1","success":true}\n'));
  const payload = JSON.parse(child.writes[0]);
  assert.equal(payload.streamingBehavior, 'followUp');

  child.stdout.emit('data', Buffer.from('{"type":"agent_end"}\n'));
  await assert.doesNotReject(promptPromise);
});

test('PiRpcClient keeps a recent stderr summary for startup diagnostics', async () => {
  const child = new FakeChildProcess();
  const client = new PiRpcClient(
    { command: 'pi', useSession: true },
    {
      spawnFn: () => child as never,
      startupTimeoutMs: 5,
      requireReadyEvent: true,
    },
  );

  const startPromise = client.start();
  child.stderr.emit('data', Buffer.from('first stderr\n'));
  child.stderr.emit('data', Buffer.from('second stderr\n'));

  await assert.rejects(startPromise, /PI RPC 启动超时/);
  assert.match(client.getRecentStderrSummary(), /first stderr/);
  assert.match(client.getRecentStderrSummary(), /second stderr/);
});

test('PiRpcClient rejects prompt when PI returns an errored assistant message with no text', async () => {
  const child = new FakeChildProcess();
  const client = new PiRpcClient(
    { command: 'pi', useSession: true },
    {
      spawnFn: () => child as never,
      startupTimeoutMs: 50,
    },
  );

  const startPromise = client.start();
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));
  await startPromise;

  const promptPromise = client.prompt('hello');
  child.stdout.emit('data', Buffer.from('{"type":"response","id":"cmd-1","success":true}\n'));
  child.stdout.emit(
    'data',
    Buffer.from(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'message',
          message: {
            content: [],
            stopReason: 'error',
            errorMessage: '{"detail":"model is not supported"}',
          },
        },
      }) + '\n',
    ),
  );

  await assert.rejects(promptPromise, /model is not supported/);
});

test('PiRpcClient accepts complete assistant message content when no text_delta is emitted', async () => {
  const child = new FakeChildProcess();
  const client = new PiRpcClient(
    { command: 'pi', useSession: true },
    {
      spawnFn: () => child as never,
      startupTimeoutMs: 50,
    },
  );

  const startPromise = client.start();
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));
  await startPromise;

  const promptPromise = client.prompt('hello');
  child.stdout.emit('data', Buffer.from('{"type":"response","id":"cmd-1","success":true}\n'));
  child.stdout.emit(
    'data',
    Buffer.from(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'message',
          message: {
            content: [{ type: 'text', text: '完整回复' }],
          },
        },
      }) + '\n',
    ),
  );
  child.stdout.emit('data', Buffer.from('{"type":"agent_end"}\n'));

  assert.equal(await promptPromise, '完整回复');
});
