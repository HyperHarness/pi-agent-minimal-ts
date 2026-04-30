import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPiClientOptionsForMessage, getPiClientKey } from '../../src/feishu-bridge/pi-session.js';
import type { ParsedIncomingMessage } from '../../src/feishu-bridge/types.js';

const baseMessage: ParsedIncomingMessage = {
  chatId: 'oc_group:physics/1',
  chatType: 'group',
  isDirectMessage: false,
  mentionsBot: true,
  messageId: 'om_1',
  senderId: 'ou_user_1',
  senderName: 'Alice',
  text: 'hello bridge',
};

test('buildPiClientOptionsForMessage creates isolated per-chat session dirs when sessions are enabled', () => {
  const rootDir = '/tmp/pi-bridge-sessions';
  const optionsA = buildPiClientOptionsForMessage(
    { command: 'pi', useSession: true },
    baseMessage,
    rootDir,
  );
  const optionsB = buildPiClientOptionsForMessage(
    { command: 'pi', useSession: true },
    { ...baseMessage, chatId: 'oc_group:physics/2' },
    rootDir,
  );

  assert.equal(optionsA.useSession, true);
  assert.equal(optionsB.useSession, true);
  assert.equal(optionsA.command, 'pi');
  assert.ok(optionsA.sessionDir);
  assert.ok(optionsB.sessionDir);
  assert.match(optionsA.sessionDir ?? '', new RegExp(`${path.sep}oc_group_physics_1-[a-f0-9]{8}$`.replace(/\\/g, '\\\\')));
  assert.match(optionsB.sessionDir ?? '', new RegExp(`${path.sep}oc_group_physics_2-[a-f0-9]{8}$`.replace(/\\/g, '\\\\')));
  assert.notEqual(optionsA.sessionDir, optionsB.sessionDir);
});

test('buildPiClientOptionsForMessage keeps stateless mode unchanged when sessions are disabled', () => {
  const options = buildPiClientOptionsForMessage(
    { command: 'pi', useSession: false },
    baseMessage,
    '/tmp/pi-bridge-sessions',
  );

  assert.equal(options.useSession, false);
  assert.equal(options.sessionDir, undefined);
  assert.equal(getPiClientKey(options), 'stateless');
});

test('getPiClientKey reuses the same key for the same chat session directory', () => {
  const rootDir = '/tmp/pi-bridge-sessions';
  const options = buildPiClientOptionsForMessage(
    { command: 'pi', useSession: true },
    baseMessage,
    rootDir,
  );

  assert.match(getPiClientKey(options), new RegExp(`^${path.join(rootDir, 'oc_group_physics_1').replace(/\\/g, '\\\\')}-[a-f0-9]{8}$`));
});

test('buildPiClientOptionsForMessage avoids session dir collisions for different raw chat ids with same sanitized prefix', () => {
  const rootDir = '/tmp/pi-bridge-sessions';
  const optionA = buildPiClientOptionsForMessage(
    { command: 'pi', useSession: true },
    { ...baseMessage, chatId: 'oc_group:a/b' },
    rootDir,
  );
  const optionB = buildPiClientOptionsForMessage(
    { command: 'pi', useSession: true },
    { ...baseMessage, chatId: 'oc_group:a:b' },
    rootDir,
  );

  assert.notEqual(optionA.sessionDir, optionB.sessionDir);
});

test('buildPiClientOptionsForMessage forwards provider, model, and relay env config into per-chat sessions', () => {
  const rootDir = '/tmp/pi-bridge-sessions';
  const options = buildPiClientOptionsForMessage(
    {
      command: 'pi',
      useSession: true,
      provider: 'openai-compatible',
      model: 'gpt-5.5',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-test-secret',
    },
    baseMessage,
    rootDir,
  );

  assert.equal(options.provider, 'openai-compatible');
  assert.equal(options.model, 'gpt-5.5');
  assert.equal(options.baseUrl, 'https://relay.example.com/v1');
  assert.equal(options.apiKey, 'sk-test-secret');
});
