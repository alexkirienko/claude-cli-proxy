const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');

describe('Session: sender-based continuity', () => {
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

  /**
   * Helper: set up spawnHandler that captures args via the two-spawn retry pattern.
   * First spawn exits quickly (triggers retry), second is the real one.
   */
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

  it('sender-based session key resumes correctly', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();

    const body1 = {
      model: 'sonnet',
      system: 'You are a helpful bot',
      messages: [{ role: 'user', content: 'Hi [from: Alice (@alice)]' }],
      stream: false,
    };
    const body2 = {
      model: 'sonnet',
      system: 'You are a helpful bot',
      messages: [{ role: 'user', content: 'Follow up [from: Alice (@alice)]' }],
      stream: false,
    };
    const headers = { 'Content-Type': 'application/json' };

    const res1 = await request(`${url}/v1/messages`, { method: 'POST', body: body1, headers });
    assert.equal(res1.status, 200, 'first request succeeds');

    const realArgs1 = spawnArgs[1];
    assert.ok(realArgs1, 'retry spawn args captured for first request');
    assert.ok(realArgs1.includes('--session-id'), 'first request uses --session-id');
    assert.ok(!realArgs1.includes('--resume'), 'first request does not use --resume');

    const sessionIdx1 = realArgs1.indexOf('--session-id');
    const sessionUuid1 = realArgs1[sessionIdx1 + 1];

    const res2 = await request(`${url}/v1/messages`, { method: 'POST', body: body2, headers });
    assert.equal(res2.status, 200, 'second request succeeds');

    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2, 'retry spawn args captured for second request');
    assert.ok(realArgs2.includes('--resume'), 'second request uses --resume');
    assert.ok(!realArgs2.includes('--session-id'), 'second request does not use --session-id');

    const resumeIdx = realArgs2.indexOf('--resume');
    const sessionUuid2 = realArgs2[resumeIdx + 1];
    assert.equal(sessionUuid2, sessionUuid1, 'both requests use the same session UUID');

    // Clean up session state
    for (const [key] of internals.sessions) {
      internals.sessions.delete(key);
    }
  });

  it('system-prompt-only fallback resumes without sender tag', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();

    const body1 = {
      model: 'sonnet',
      system: 'You are a helpful bot',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };
    const body2 = {
      model: 'sonnet',
      system: 'You are a helpful bot',
      messages: [{ role: 'user', content: 'What next?' }],
      stream: false,
    };
    const headers = { 'Content-Type': 'application/json' };

    const res1 = await request(`${url}/v1/messages`, { method: 'POST', body: body1, headers });
    assert.equal(res1.status, 200, 'first request succeeds');

    const realArgs1 = spawnArgs[1];
    assert.ok(realArgs1, 'retry spawn args captured for first request');
    assert.ok(realArgs1.includes('--session-id'), 'first request uses --session-id');
    assert.ok(!realArgs1.includes('--resume'), 'first request does not use --resume');

    const sessionIdx1 = realArgs1.indexOf('--session-id');
    const sessionUuid1 = realArgs1[sessionIdx1 + 1];

    const res2 = await request(`${url}/v1/messages`, { method: 'POST', body: body2, headers });
    assert.equal(res2.status, 200, 'second request succeeds');

    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2, 'retry spawn args captured for second request');
    assert.ok(realArgs2.includes('--resume'), 'second request uses --resume');
    assert.ok(!realArgs2.includes('--session-id'), 'second request does not use --session-id');

    const resumeIdx = realArgs2.indexOf('--resume');
    const sessionUuid2 = realArgs2[resumeIdx + 1];
    assert.equal(sessionUuid2, sessionUuid1, 'both requests use the same session UUID');

    for (const [key] of internals.sessions) {
      internals.sessions.delete(key);
    }
  });

  it('different senders get separate sessions', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();

    const bodyAlice = {
      model: 'sonnet',
      system: 'You are a helpful bot',
      messages: [{ role: 'user', content: 'Hi [from: Alice (@alice)]' }],
      stream: false,
    };
    const bodyBob = {
      model: 'sonnet',
      system: 'You are a helpful bot',
      messages: [{ role: 'user', content: 'Hi [from: Bob (@bob)]' }],
      stream: false,
    };
    const headers = { 'Content-Type': 'application/json' };

    const res1 = await request(`${url}/v1/messages`, { method: 'POST', body: bodyAlice, headers });
    assert.equal(res1.status, 200, 'alice request succeeds');

    const res2 = await request(`${url}/v1/messages`, { method: 'POST', body: bodyBob, headers });
    assert.equal(res2.status, 200, 'bob request succeeds');

    const realArgs1 = spawnArgs[1];
    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs1, 'retry spawn args captured for alice');
    assert.ok(realArgs2, 'retry spawn args captured for bob');

    assert.ok(realArgs1.includes('--session-id'), 'alice uses --session-id');
    assert.ok(realArgs2.includes('--session-id'), 'bob uses --session-id');

    const uuid1 = realArgs1[realArgs1.indexOf('--session-id') + 1];
    const uuid2 = realArgs2[realArgs2.indexOf('--session-id') + 1];
    assert.notEqual(uuid1, uuid2, 'alice and bob get different session UUIDs');

    for (const [key] of internals.sessions) {
      internals.sessions.delete(key);
    }
  });
});
