const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

/**
 * Create a child that emits an error immediately (next tick).
 */
function createImmediateErrorChild(errorCode = 'ENOENT') {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.killed = false;
  child.kill = () => { child.killed = true; };

  process.nextTick(() => {
    child.emit('error', Object.assign(new Error(`spawn claude ${errorCode}`), { code: errorCode }));
  });

  return child;
}

/**
 * Create a delayed error child that survives spawnWithRetry's 3-second race.
 */
function createDelayedErrorChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.killed = false;
  child.kill = () => { child.killed = true; };

  setTimeout(() => {
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', null, null);
  }, 3100);

  return child;
}

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

function jsonRequest(baseUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: text, json });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Lifecycle: spawn error queue cleanup', () => {
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

  it('queue is not deadlocked after spawn error; subsequent request succeeds', async () => {
    let spawnCount = 0;

    // First 2 calls: quick exit + delayed error (for spawnWithRetry of request 1)
    // Next 2 calls: quick exit + normal child (for spawnWithRetry of request 2)
    spawnHandler = () => {
      spawnCount++;
      if (spawnCount === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      if (spawnCount === 2) {
        return createDelayedErrorChild();
      }
      if (spawnCount === 3) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      // spawnCount >= 4: normal working child
      return createMockChild({
        stdoutData: [JSON.stringify({
          type: 'result',
          result: 'Recovery after error',
          usage: { input_tokens: 5, output_tokens: 3 },
        })],
        exitCode: 0,
        autoClose: true,
        closeDelay: 50,
      });
    };

    const body = {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Test queue' }],
      stream: false,
    };
    const headers = { 'x-session-key': 'err-queue-test' };

    // First request will fail due to spawn error
    const res1 = await jsonRequest(url, body, headers);
    assert.equal(res1.status, 500, 'first request fails with spawn error');

    // Wait for cleanup
    await new Promise(r => setTimeout(r, 200));

    // Second request should not be deadlocked
    const res2 = await jsonRequest(url, body, headers);
    assert.equal(res2.status, 200, 'second request succeeds after error');
    assert.ok(res2.json?.content?.[0]?.text?.includes('Recovery'), 'got expected response');

    // Cleanup
    assert.ok(!internals.activeRuns.has('err-queue-test'), 'activeRuns clean');
    internals.sessions.delete('err-queue-test');
  });

  it('EACCES spawn error returns proper error in non-streaming mode', async () => {
    let spawnCount = 0;

    spawnHandler = () => {
      spawnCount++;
      if (spawnCount === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      // Delayed error child that survives the 3-second race
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 12345;
      child.killed = false;
      child.kill = () => { child.killed = true; };

      setTimeout(() => {
        child.emit('error', Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' }));
        child.emit('close', null, null);
      }, 3100);

      return child;
    };

    const res = await jsonRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'EACCES test' }],
      stream: false,
    }, { 'x-session-key': 'spawn-eacces' });

    assert.equal(res.status, 500);
    assert.ok(res.json?.error, 'response has error object');
    assert.ok(res.json.error.message.includes('EACCES'), 'error mentions EACCES');

    await new Promise(r => setTimeout(r, 200));
    assert.ok(!internals.activeRuns.has('spawn-eacces'), 'activeRuns cleaned up');
    internals.sessions.delete('spawn-eacces');
  });

  it('streaming mode sends error SSE event on spawn failure', async () => {
    let spawnCount = 0;

    spawnHandler = () => {
      spawnCount++;
      if (spawnCount === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      return createDelayedErrorChild();
    };

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'stream error test' }],
      stream: true,
    }, { 'x-session-key': 'spawn-err-sse' });

    assert.equal(res.status, 200, 'SSE stream started before error');
    assert.ok(res.body.includes('message_start'), 'message_start event sent');
    assert.ok(res.body.includes('ENOENT'), 'error event contains ENOENT');

    await new Promise(r => setTimeout(r, 200));
    assert.ok(!internals.activeRuns.has('spawn-err-sse'), 'activeRuns cleaned up');
    internals.sessions.delete('spawn-err-sse');
  });
});
