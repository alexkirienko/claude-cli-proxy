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

describe('Queue: preemption', () => {
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

  it('kills the active child when a new request arrives for the same session', async () => {
    const children = [];
    let spawnCount = 0;

    spawnHandler = () => {
      spawnCount++;
      if (spawnCount % 2 === 1) {
        // Odd spawns exit quickly -> triggers retry
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      // Even spawns (retries) - the real ones
      const child = createMockChild({ autoClose: false });
      children.push(child);
      return child;
    };

    const body = {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    };
    const headers = { 'x-session-key': 'preempt-test' };

    // Start first request - it will spawn a child and keep it alive
    const p1 = streamRequest(url, body, headers);

    // Wait for first child to be spawned and registered as active
    await new Promise(r => setTimeout(r, 200));
    assert.ok(children.length >= 1, 'first child was spawned');

    const firstChild = children[0];
    assert.ok(!firstChild.killed, 'first child is alive before preemption');

    // Send second request to the same session - should trigger preemption
    const p2 = streamRequest(url, body, headers);

    // Wait for preemption to happen
    await new Promise(r => setTimeout(r, 200));

    // First child should have been killed
    assert.ok(firstChild.killed, 'first child was killed by preemption');

    // Wait for second child to spawn after first one's queue resolves
    await new Promise(r => setTimeout(r, 200));

    // Complete second child
    if (children.length >= 2) {
      children[1].stdout.push(JSON.stringify({
        type: 'result',
        result: 'Preempted',
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
      children[1].emit('close', 0);
    }

    // Wait for both requests to finish
    const [res1, res2] = await Promise.all([p1, p2]);

    // Both should get responses (first may be partial/error, second should succeed)
    assert.equal(res2.status, 200, 'second request completed successfully');

    internals.sessions.delete('preempt-test');
  });
});
