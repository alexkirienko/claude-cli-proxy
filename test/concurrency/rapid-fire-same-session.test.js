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

describe('Concurrency: rapid-fire same session', () => {
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

  it('queues 3 rapid requests to the same session; all complete sequentially without preemption', async () => {
    const realChildren = [];
    let spawnCount = 0;

    // Same-session requests are serialized by the queue, so odd/even pattern works
    spawnHandler = () => {
      spawnCount++;
      if (spawnCount % 2 === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      const child = createMockChild({ autoClose: false });
      realChildren.push(child);
      return child;
    };

    const body = {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Rapid fire' }],
      stream: true,
    };
    const headers = { 'x-session-key': 'rapid-test' };

    // Send 3 requests in quick succession to the same session
    const p1 = streamRequest(url, body, headers);
    await new Promise(r => setTimeout(r, 50));
    const p2 = streamRequest(url, body, headers);
    await new Promise(r => setTimeout(r, 50));
    const p3 = streamRequest(url, body, headers);

    // Wait for first real child to appear
    await new Promise(r => setTimeout(r, 300));
    assert.ok(realChildren.length >= 1, 'first real child spawned');

    // Without implicit preemption, first child should NOT be killed
    assert.ok(!realChildren[0].killed, 'first child NOT killed (no implicit preemption)');

    // Complete first child — unblocks queue for second request
    realChildren[0].stdout.push(JSON.stringify({
      type: 'result',
      result: 'Response 1',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    realChildren[0].emit('close', 0);

    // Wait for second child to spawn
    await new Promise(r => setTimeout(r, 300));
    assert.ok(realChildren.length >= 2, 'second real child spawned');
    assert.ok(!realChildren[1].killed, 'second child NOT killed');

    // Complete second child — unblocks queue for third request
    realChildren[1].stdout.push(JSON.stringify({
      type: 'result',
      result: 'Response 2',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    realChildren[1].emit('close', 0);

    // Wait for third child to spawn
    await new Promise(r => setTimeout(r, 300));
    assert.ok(realChildren.length >= 3, 'third real child spawned');
    assert.ok(!realChildren[2].killed, 'third child NOT killed');

    // Complete third child
    realChildren[2].stdout.push(JSON.stringify({
      type: 'result',
      result: 'Response 3',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    realChildren[2].emit('close', 0);

    // All requests should resolve with 200
    const results = await Promise.all([p1, p2, p3]);

    for (let i = 0; i < 3; i++) {
      assert.equal(results[i].status, 200, `request ${i} got 200`);
    }

    // After all complete, activeRuns and sessionQueues should be clean
    await new Promise(r => setTimeout(r, 100));
    assert.ok(!internals.activeRuns.has('rapid-test'), 'activeRuns cleaned up');
    assert.ok(!internals.sessionQueues.has('rapid-test'), 'sessionQueues cleaned up');

    internals.sessions.delete('rapid-test');
  });

  it('two normal requests queue sequentially; first child is NOT killed', async () => {
    const realChildren = [];
    let spawnCount = 0;

    spawnHandler = () => {
      spawnCount++;
      if (spawnCount % 2 === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      const child = createMockChild({ autoClose: false });
      realChildren.push(child);
      return child;
    };

    const body = {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Queue test' }],
      stream: true,
    };
    const headers = { 'x-session-key': 'queue-rapid' };

    // Send first request
    const p1 = streamRequest(url, body, headers);
    await new Promise(r => setTimeout(r, 300));

    // First child should be spawned and active
    assert.equal(realChildren.length, 1, 'first real child spawned');
    assert.ok(internals.activeRuns.has('queue-rapid'), 'session has active run');

    // Send second request — should NOT preempt (no x-regenerate)
    const p2 = streamRequest(url, body, headers);
    await new Promise(r => setTimeout(r, 100));

    // First child should still be alive
    assert.ok(!realChildren[0].killed, 'first child NOT killed (queued, not preempted)');

    // Complete first child
    realChildren[0].stdout.push(JSON.stringify({
      type: 'result',
      result: 'First done',
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
    realChildren[0].emit('close', 0);

    // Wait for second child to spawn
    await new Promise(r => setTimeout(r, 300));

    // Complete second child
    if (realChildren.length >= 2 && !realChildren[1].killed) {
      realChildren[1].stdout.push(JSON.stringify({
        type: 'result',
        result: 'Second done',
        usage: { input_tokens: 5, output_tokens: 3 },
      }));
      realChildren[1].emit('close', 0);
    }

    const [res1, res2] = await Promise.all([p1, p2]);
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);

    internals.sessions.delete('queue-rapid');
  });
});
