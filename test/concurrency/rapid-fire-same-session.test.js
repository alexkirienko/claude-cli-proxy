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

  it('queues 3 rapid requests to the same session; all resolve without hanging', async () => {
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

    // Request 2 preempts request 1's child (kills it).
    // Request 3 arrives while request 2 is pending — it also tries to preempt.
    // The first child should have been killed by preemption.
    assert.ok(realChildren[0].killed, 'first child killed by preemption');

    // Wait for the chain to settle — preempted children resolve their queue promises,
    // allowing next request to spawn.
    await new Promise(r => setTimeout(r, 300));

    // Complete the last surviving child
    const lastChild = realChildren[realChildren.length - 1];
    if (!lastChild.killed) {
      lastChild.stdout.push(JSON.stringify({
        type: 'result',
        result: 'Final response',
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
      lastChild.emit('close', 0);
    }

    // All requests should eventually resolve (no hung sockets)
    const results = await Promise.all([p1, p2, p3]);

    for (let i = 0; i < 3; i++) {
      assert.equal(results[i].status, 200, `request ${i} got 200 (no hung socket)`);
    }

    // After all complete, activeRuns and sessionQueues should be clean
    await new Promise(r => setTimeout(r, 100));
    assert.ok(!internals.activeRuns.has('rapid-test'), 'activeRuns cleaned up');
    assert.ok(!internals.sessionQueues.has('rapid-test'), 'sessionQueues cleaned up');

    internals.sessions.delete('rapid-test');
  });

  it('first request spawns CLI, second preempts it', async () => {
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

    // Send second request — should preempt request 1
    const p2 = streamRequest(url, body, headers);
    await new Promise(r => setTimeout(r, 100));

    // First child should have been killed (preempted)
    assert.ok(realChildren[0].killed, 'first child killed by preemption');

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
