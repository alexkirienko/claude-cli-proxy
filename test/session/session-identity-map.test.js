const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createMockChild } = require('../helpers/mock-child');

describe('Session: identity map (cross-channel merging)', () => {
  let url, close, internals;
  let spawnHandler;
  let identityMapFile;

  before(async () => {
    // Write a temp identity map file before the server loads
    identityMapFile = path.join(os.tmpdir(), `identity-map-${Date.now()}.json`);
    fs.writeFileSync(identityMapFile, JSON.stringify({
      'signal:aaa-bbb-ccc': 'telegram:19847781',
    }));
    process.env.CLAUDE_PROXY_IDENTITY_MAP = identityMapFile;

    spawnHandler = () => createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
    mock.method(cp, 'spawn', (...args) => spawnHandler(...args));

    const { startTestServer } = require('../helpers/test-server');
    ({ url, close, internals } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
    delete process.env.CLAUDE_PROXY_IDENTITY_MAP;
    try { fs.unlinkSync(identityMapFile); } catch {}
  });

  function captureSpawnArgs() {
    const spawnArgs = [];
    let spawnCount = 0;

    spawnHandler = (cmd, args) => {
      spawnCount++;
      spawnArgs.push([...args]);
      if (spawnCount % 2 === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      const child = createMockChild({ autoClose: false });
      process.nextTick(() => {
        child.stdout.push(JSON.stringify({
          result: 'OK',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
        setTimeout(() => child.emit('close', 0), 50);
      });
      return child;
    };

    return spawnArgs;
  }

  function sysPrompt(chatId) {
    const channel = chatId.startsWith('signal:') ? 'signal' : 'telegram';
    const caps = channel === 'telegram' ? 'inlineButtons' : 'none';
    const msgId = channel === 'telegram' ? '2' : '1';
    return `You are a bot.\nRuntime: channel=${channel} | capabilities=${caps}\n` +
      `\`\`\`json\n{"schema":"openclaw.inbound_meta.v1","message_id":"${msgId}","chat_id":"${chatId}"}\n\`\`\``;
  }

  it('mapped identities share a session', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    // First request from Signal (mapped → telegram:19847781)
    const res1 = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers,
      body: {
        model: 'sonnet',
        system: sysPrompt('signal:aaa-bbb-ccc'),
        messages: [{ role: 'user', content: 'Hello from Signal' }],
        stream: false,
      },
    });
    assert.equal(res1.status, 200, 'signal request succeeds');

    const realArgs1 = spawnArgs[1];
    assert.ok(realArgs1, 'retry spawn args captured for signal request');
    assert.ok(realArgs1.includes('--session-id'), 'signal request uses --session-id (new session)');

    const sessionUuid1 = realArgs1[realArgs1.indexOf('--session-id') + 1];

    // Second request from Telegram (canonical identity)
    const res2 = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers,
      body: {
        model: 'sonnet',
        system: sysPrompt('telegram:19847781'),
        messages: [{ role: 'user', content: 'Hello from Telegram' }],
        stream: false,
      },
    });
    assert.equal(res2.status, 200, 'telegram request succeeds');

    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2, 'retry spawn args captured for telegram request');
    assert.ok(realArgs2.includes('--resume'), 'telegram request resumes the same session');

    const sessionUuid2 = realArgs2[realArgs2.indexOf('--resume') + 1];
    assert.equal(sessionUuid2, sessionUuid1, 'both channels share the same session UUID');

    for (const [key] of internals.sessions) {
      internals.sessions.delete(key);
    }
  });

  it('unmapped identities stay isolated', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    // Request from a group chat (not in identity map)
    const res1 = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers,
      body: {
        model: 'sonnet',
        system: sysPrompt('telegram:-1001234567890'),
        messages: [{ role: 'user', content: 'Group message' }],
        stream: false,
      },
    });
    assert.equal(res1.status, 200, 'group chat request succeeds');

    // Request from a mapped identity
    const res2 = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers,
      body: {
        model: 'sonnet',
        system: sysPrompt('telegram:19847781'),
        messages: [{ role: 'user', content: 'DM message' }],
        stream: false,
      },
    });
    assert.equal(res2.status, 200, 'DM request succeeds');

    const realArgs1 = spawnArgs[1];
    const realArgs2 = spawnArgs[3];

    assert.ok(realArgs1.includes('--session-id'), 'group chat uses --session-id');
    assert.ok(realArgs2.includes('--session-id'), 'DM uses --session-id');

    const uuid1 = realArgs1[realArgs1.indexOf('--session-id') + 1];
    const uuid2 = realArgs2[realArgs2.indexOf('--session-id') + 1];
    assert.notEqual(uuid1, uuid2, 'group chat and DM get different session UUIDs');

    for (const [key] of internals.sessions) {
      internals.sessions.delete(key);
    }
  });
});
