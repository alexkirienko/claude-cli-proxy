const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');

describe('Session: resume logic', () => {
  let url, close, internals;
  let spawnHandler;

  before(async () => {
    // Mock spawn BEFORE requiring server so the destructured reference is captured
    spawnHandler = () => createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
    mock.method(cp, 'spawn', (...args) => spawnHandler(...args));

    const { startTestServer } = require('../helpers/test-server');
    ({ url, close, internals } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
  });

  it('first request uses --session-id, second uses --resume', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = [];
    let spawnCount = 0;

    spawnHandler = (cmd, args) => {
      spawnCount++;
      spawnArgs.push([...args]);
      if (spawnCount % 2 === 1) {
        // First spawn exits quickly -> triggers retry
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      // Second spawn (retry) - the real one
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

    const body = {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };
    const headers = {
      'Content-Type': 'application/json',
      'x-session-key': 'test-resume-session',
    };

    // First request -- should use --session-id
    const res1 = await request(`${url}/v1/messages`, {
      method: 'POST',
      body,
      headers,
    });
    assert.equal(res1.status, 200, 'first request succeeds');

    // The retry spawn (spawnArgs[1]) is the real one for request 1
    const realArgs1 = spawnArgs[1];
    assert.ok(realArgs1, 'retry spawn args captured for first request');
    assert.ok(
      realArgs1.includes('--session-id'),
      'first request uses --session-id'
    );
    assert.ok(
      !realArgs1.includes('--resume'),
      'first request does not use --resume'
    );

    // Verify session was stored
    assert.ok(
      internals.sessions.has('test-resume-session'),
      'session stored after first request'
    );

    // Second request -- should use --resume
    const res2 = await request(`${url}/v1/messages`, {
      method: 'POST',
      body,
      headers,
    });
    assert.equal(res2.status, 200, 'second request succeeds');

    // The retry spawn (spawnArgs[3]) is the real one for request 2
    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2, 'retry spawn args captured for second request');
    assert.ok(
      realArgs2.includes('--resume'),
      'second request uses --resume'
    );
    assert.ok(
      !realArgs2.includes('--session-id'),
      'second request does not use --session-id'
    );

    internals.sessions.delete('test-resume-session');
  });
});
