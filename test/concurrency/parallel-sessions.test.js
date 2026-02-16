const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');

/**
 * Stream a POST /v1/messages request and collect the full response.
 */
function streamRequest(baseUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Build a spawn handler that tracks per-session-id first/retry spawns.
 * First spawn per session-id exits quickly (triggers spawnWithRetry retry).
 * Retry spawn returns a long-lived controllable child.
 */
function makeSpawnHandler(realChildren) {
  const seenIds = new Set();
  return (_bin, args) => {
    // Extract --session-id or --resume value
    let sid = null;
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '--session-id' || args[i] === '--resume') && args[i + 1]) {
        sid = args[i + 1];
        break;
      }
    }

    if (sid && !seenIds.has(sid)) {
      // First spawn for this session-id: exit quickly to trigger retry
      seenIds.add(sid);
      return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
    }

    // Retry spawn: long-lived, controllable
    const child = createMockChild({ autoClose: false });
    realChildren.push(child);
    return child;
  };
}

describe('Concurrency: parallel sessions', () => {
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

  it('handles 5 concurrent requests to different sessions independently', async () => {
    const SESSION_COUNT = 5;
    const realChildren = [];

    spawnHandler = makeSpawnHandler(realChildren);

    // Fire 5 requests with different session keys simultaneously
    const promises = [];
    for (let i = 0; i < SESSION_COUNT; i++) {
      const body = {
        model: 'sonnet',
        messages: [{ role: 'user', content: `Hello from session ${i}` }],
        stream: true,
      };
      promises.push(streamRequest(url, body, { 'x-session-key': `par-sess-${i}` }));
    }

    // Wait for all real children to be spawned
    await new Promise(r => setTimeout(r, 500));
    assert.equal(realChildren.length, SESSION_COUNT, `all ${SESSION_COUNT} real children spawned`);

    // Each child sends a unique response and closes
    for (let i = 0; i < SESSION_COUNT; i++) {
      realChildren[i].stdout.push(JSON.stringify({
        type: 'result',
        result: `unique-response-${i}`,
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
      realChildren[i].emit('close', 0);
    }

    const results = await Promise.all(promises);

    // All should succeed
    for (let i = 0; i < SESSION_COUNT; i++) {
      assert.equal(results[i].status, 200, `session ${i} got 200`);
      assert.ok(
        results[i].body.includes(`unique-response-${i}`),
        `session ${i} response contains its unique text`
      );
    }

    // Cleanup
    for (let i = 0; i < SESSION_COUNT; i++) {
      internals.sessions.delete(`par-sess-${i}`);
    }
  });

  it('does not share activeRuns between different sessions', async () => {
    const realChildren = [];
    spawnHandler = makeSpawnHandler(realChildren);

    const makeBody = (msg) => ({
      model: 'sonnet',
      messages: [{ role: 'user', content: msg }],
      stream: true,
    });

    // Start two requests to different sessions
    const p1 = streamRequest(url, makeBody('msg-A'), { 'x-session-key': 'iso-a' });
    const p2 = streamRequest(url, makeBody('msg-B'), { 'x-session-key': 'iso-b' });

    // Wait for both real children to spawn
    await new Promise(r => setTimeout(r, 500));
    assert.equal(realChildren.length, 2, 'both real children spawned');

    // Both sessions should have active runs
    assert.ok(internals.activeRuns.has('iso-a'), 'session A has active run');
    assert.ok(internals.activeRuns.has('iso-b'), 'session B has active run');

    // Complete only session A
    realChildren[0].stdout.push(JSON.stringify({
      type: 'result', result: 'A done',
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
    realChildren[0].emit('close', 0);

    await new Promise(r => setTimeout(r, 100));

    // Session A cleaned up, session B still active
    assert.ok(!internals.activeRuns.has('iso-a'), 'session A cleaned up');
    assert.ok(internals.activeRuns.has('iso-b'), 'session B still active');

    // Complete session B
    realChildren[1].stdout.push(JSON.stringify({
      type: 'result', result: 'B done',
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
    realChildren[1].emit('close', 0);

    await Promise.all([p1, p2]);

    assert.ok(!internals.activeRuns.has('iso-b'), 'session B cleaned up');

    internals.sessions.delete('iso-a');
    internals.sessions.delete('iso-b');
  });
});
