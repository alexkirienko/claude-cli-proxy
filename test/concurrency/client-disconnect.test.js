const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');

/**
 * Start a streaming request and return { req, responsePromise }.
 * Caller can abort req to simulate client disconnect.
 * Resolves (never rejects) — aborted requests get { aborted: true }.
 */
function startStreamRequest(baseUrl, body, headers = {}) {
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  let settled = false;
  const settle = (val) => { if (!settled) { settled = true; resolveResponse(val); } };

  const req = http.request(baseUrl + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
  }, (res) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      settle({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
    });
    res.on('error', () => {
      settle({ status: 0, body: '', aborted: true });
    });
  });
  req.on('error', () => {
    settle({ status: 0, body: '', aborted: true });
  });
  req.write(JSON.stringify(body));
  req.end();

  return { req, responsePromise };
}

/**
 * Stream request that collects the full response.
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

describe('Concurrency: client disconnect', () => {
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

  it('kills child process when client disconnects mid-stream', async () => {
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
      messages: [{ role: 'user', content: 'Long running task' }],
      stream: true,
    };

    // Start a streaming request
    const { req, responsePromise } = startStreamRequest(url, body, {
      'x-session-key': 'disconnect-test',
    });

    // Wait for the child to be spawned and active
    await new Promise(r => setTimeout(r, 300));
    assert.equal(realChildren.length, 1, 'real child spawned');
    assert.ok(internals.activeRuns.has('disconnect-test'), 'session has active run');
    assert.ok(!realChildren[0].killed, 'child is alive');

    // Abort the client request (simulate disconnect)
    req.destroy();

    // Wait for cleanup
    await new Promise(r => setTimeout(r, 200));

    // Child should have been killed
    assert.ok(realChildren[0].killed, 'child killed after client disconnect');

    // activeRuns should be cleaned up
    assert.ok(!internals.activeRuns.has('disconnect-test'), 'activeRuns cleaned up after disconnect');

    await responsePromise;
    internals.sessions.delete('disconnect-test');
  });

  it('cleans up queued request when client disconnects while waiting', async () => {
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
      messages: [{ role: 'user', content: 'First request' }],
      stream: true,
    };
    const headers = { 'x-session-key': 'queue-disconnect' };

    // Start first request (it becomes active)
    const p1 = streamRequest(url, body, headers);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(realChildren.length, 1, 'first child spawned');

    // Start second request (it queues behind first) then abort it
    const { req: req2, responsePromise: p2 } = startStreamRequest(url, body, headers);
    await new Promise(r => setTimeout(r, 100));

    // Abort the queued request
    req2.destroy();
    await new Promise(r => setTimeout(r, 100));

    // Now complete the first request
    realChildren[0].stdout.push(JSON.stringify({
      type: 'result', result: 'First done',
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
    realChildren[0].emit('close', 0);

    await p1;
    await p2;

    // Queue should not deadlock — no new child should be spawned for the cancelled request.
    await new Promise(r => setTimeout(r, 300));

    assert.ok(!internals.activeRuns.has('queue-disconnect'), 'activeRuns cleaned up');

    internals.sessions.delete('queue-disconnect');
  });

  it('subsequent request works after a client disconnect', async () => {
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
      messages: [{ role: 'user', content: 'Will be aborted' }],
      stream: true,
    };
    const headers = { 'x-session-key': 'recover-test' };

    // First request - abort it
    const { req, responsePromise: p1 } = startStreamRequest(url, body, headers);
    await new Promise(r => setTimeout(r, 300));
    req.destroy();
    await new Promise(r => setTimeout(r, 200));
    await p1;

    // Second request to same session should work fine
    const p2 = streamRequest(url, body, headers);
    await new Promise(r => setTimeout(r, 300));

    // Complete the second child
    const lastChild = realChildren[realChildren.length - 1];
    if (!lastChild.killed) {
      lastChild.stdout.push(JSON.stringify({
        type: 'result', result: 'Recovery works',
        usage: { input_tokens: 5, output_tokens: 3 },
      }));
      lastChild.emit('close', 0);
    }

    const res2 = await p2;
    assert.equal(res2.status, 200, 'second request succeeds after disconnect');
    assert.ok(res2.body.includes('Recovery works'), 'response contains expected text');

    internals.sessions.delete('recover-test');
  });
});
