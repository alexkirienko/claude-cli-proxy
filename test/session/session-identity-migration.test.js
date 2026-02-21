const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');

describe('Session: identity-based migration', () => {
  let url, close, internals;
  let spawnHandler;

  before(async () => {
    spawnHandler = () => createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
    mock.method(cp, 'spawn', (...args) => spawnHandler(...args));

    const { startTestServer } = require('../helpers/test-server');
    ({ url, close, internals } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
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

  it('migrates session when identity matches but session key changed', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    const identity = 'telegram:-1003720729044';
    const oldKey = 'old-session-key-aaa';
    const fakeUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    // Pre-populate sessions with an old entry that has identity
    internals.sessions.set(oldKey, {
      uuid: fakeUuid,
      lastUsed: Date.now() - 60000,
      identity,
    });

    // System prompt that produces a DIFFERENT session key than oldKey
    // but resolves to the same identity (telegram:-1003720729044)
    const meta = {
      schema: 'openclaw.inbound_meta.v1',
      message_id: '100',
      chat_id: identity,
      channel: 'telegram',
    };
    const sysPrompt = `New system prompt version.\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\``;

    const body = {
      model: 'sonnet',
      system: sysPrompt,
      messages: [{ role: 'user', content: 'Hello after deploy' }],
      stream: false,
    };

    const res = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res.status, 200, 'request succeeds');

    // The retry spawn (index 1) is the real one
    const realArgs = spawnArgs[1];
    assert.ok(realArgs, 'spawn args captured');

    // Should resume (migrated from old key)
    assert.ok(realArgs.includes('--resume'), 'uses --resume after migration');

    // Should use the old UUID
    const resumeIdx = realArgs.indexOf('--resume');
    assert.equal(realArgs[resumeIdx + 1], fakeUuid, 'resumes with the original UUID');

    // Old key should be gone, new key should exist
    assert.ok(!internals.sessions.has(oldKey), 'old session key removed');

    // Find the new entry — it should have the identity and same UUID
    let found = false;
    for (const [key, entry] of internals.sessions) {
      if (entry.uuid === fakeUuid) {
        assert.equal(entry.identity, identity, 'migrated entry preserves identity');
        assert.notEqual(key, oldKey, 'new key differs from old key');
        found = true;
        internals.sessions.delete(key);
        break;
      }
    }
    assert.ok(found, 'migrated session entry exists under new key');
  });

  it('migrates DM session (positive chat_id) when session key changed', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    const identity = 'telegram:19847781';
    const oldKey = 'old-dm-key-bbb';
    const fakeUuid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

    // Pre-populate sessions with an old DM entry that has identity
    internals.sessions.set(oldKey, {
      uuid: fakeUuid,
      lastUsed: Date.now() - 60000,
      identity,
    });

    // Different system prompt text → different session key, but same chat_id
    const meta = {
      schema: 'openclaw.inbound_meta.v1',
      message_id: '200',
      chat_id: identity,
      channel: 'telegram',
    };
    const sysPrompt = `Updated DM bot v2.\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\``;

    const body = {
      model: 'sonnet',
      system: sysPrompt,
      messages: [{ role: 'user', content: 'Hello DM after deploy' }],
      stream: false,
    };

    const res = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res.status, 200, 'request succeeds');

    const realArgs = spawnArgs[1];
    assert.ok(realArgs.includes('--resume'), 'uses --resume after DM migration');

    const resumeIdx = realArgs.indexOf('--resume');
    assert.equal(realArgs[resumeIdx + 1], fakeUuid, 'resumes with the original DM UUID');

    assert.ok(!internals.sessions.has(oldKey), 'old DM key removed');

    // Cleanup
    for (const [key, entry] of internals.sessions) {
      if (entry.uuid === fakeUuid) {
        internals.sessions.delete(key);
        break;
      }
    }
  });

  it('does not migrate when session key already matches', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    const identity = 'telegram:99999';

    const meta = {
      schema: 'openclaw.inbound_meta.v1',
      message_id: '1',
      chat_id: identity,
      channel: 'telegram',
    };
    const sysPrompt = `Bot prompt.\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\``;

    const body = {
      model: 'sonnet',
      system: sysPrompt,
      messages: [{ role: 'user', content: 'First message' }],
      stream: false,
    };

    // First request — creates the session
    const res1 = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res1.status, 200, 'first request succeeds');

    const realArgs1 = spawnArgs[1];
    assert.ok(realArgs1.includes('--session-id'), 'first request uses --session-id');
    const sessionUuid = realArgs1[realArgs1.indexOf('--session-id') + 1];

    // Second request — same system prompt = same session key, no migration needed
    const res2 = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res2.status, 200, 'second request succeeds');

    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2.includes('--resume'), 'second request uses --resume');
    const resumeUuid = realArgs2[realArgs2.indexOf('--resume') + 1];
    assert.equal(resumeUuid, sessionUuid, 'same UUID on normal resume');

    // Exactly one session entry for this identity
    let count = 0;
    for (const [key, entry] of internals.sessions) {
      if (entry.identity === identity) {
        count++;
        internals.sessions.delete(key);
      }
    }
    assert.equal(count, 1, 'only one session entry for the identity');
  });

  it('saves identity in session entry after successful request', async () => {
    const { request } = require('../helpers/test-server');
    captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    const identity = 'telegram:saveme123';
    const meta = {
      schema: 'openclaw.inbound_meta.v1',
      message_id: '50',
      chat_id: identity,
      channel: 'telegram',
    };
    const sysPrompt = `Test.\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\``;

    const body = {
      model: 'sonnet',
      system: sysPrompt,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };

    const res = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res.status, 200, 'request succeeds');

    // Find the session entry and verify identity was saved
    let found = false;
    for (const [key, entry] of internals.sessions) {
      if (entry.identity === identity) {
        found = true;
        internals.sessions.delete(key);
        break;
      }
    }
    assert.ok(found, 'session entry includes identity field');
  });
});
