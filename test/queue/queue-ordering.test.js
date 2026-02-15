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

describe('Queue: FIFO ordering', () => {
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

  it('processes two same-session requests sequentially, not concurrently', async () => {
    const spawnTimestamps = [];
    const children = [];
    let spawnCount = 0;

    spawnHandler = () => {
      spawnCount++;
      if (spawnCount % 2 === 1) {
        // Odd spawns exit quickly -> triggers retry
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      // Even spawns (retries) - the real ones
      spawnTimestamps.push(Date.now());
      const child = createMockChild({ autoClose: false });
      children.push(child);
      return child;
    };

    const body = {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    };
    const headers = { 'x-session-key': 'queue-order-test' };

    // Fire both requests concurrently
    const p1 = streamRequest(url, body, headers);
    // Small delay to ensure ordering
    await new Promise(r => setTimeout(r, 100));
    const p2 = streamRequest(url, body, headers);

    // Wait for the first child to appear
    await new Promise(r => setTimeout(r, 200));

    // First child should exist; complete it
    assert.ok(children.length >= 1, 'first child was spawned');
    children[0].stdout.push(JSON.stringify({
      type: 'result',
      result: 'First',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    children[0].emit('close', 0);

    // Wait for second child to spawn
    await new Promise(r => setTimeout(r, 200));

    assert.ok(children.length >= 2, 'second child was spawned after first completed');

    // Complete the second child
    children[1].stdout.push(JSON.stringify({
      type: 'result',
      result: 'Second',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    children[1].emit('close', 0);

    const [res1, res2] = await Promise.all([p1, p2]);
    assert.equal(res1.status, 200, 'first request completed');
    assert.equal(res2.status, 200, 'second request completed');

    // Second spawn must have occurred after first
    assert.ok(
      spawnTimestamps[1] >= spawnTimestamps[0],
      'second spawn started after first spawn'
    );

    internals.sessions.delete('queue-order-test');
  });
});
