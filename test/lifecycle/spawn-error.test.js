const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');
const { parseSSE } = require('../helpers/sse-parser');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

function postMessages(baseUrl, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Create a child that passes spawnWithRetry's 3-second race (exits fast with code 0),
 * used for the first spawn in the retry pattern.
 */
function createQuickChild() {
  return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
}

/**
 * Create a child that emits 'error' then 'close' after handlers are attached.
 * This simulates spawn ENOENT but fires AFTER spawnWithRetry returns the child
 * (i.e., after the response handler attaches its listeners).
 */
function createDelayedErrorChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.killed = false;
  child.kill = () => { child.killed = true; };

  // Don't auto-close for spawnWithRetry's 3-second race — stay alive
  // so spawnWithRetry returns this child to the response handler.
  // Then fire error+close after handlers are attached.
  setTimeout(() => {
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', null, null);
  }, 3100); // Fire after spawnWithRetry's 3-second timeout

  return child;
}

describe('Lifecycle: spawn error (error+close double-fire)', () => {
  let url, close, internals;
  let spawnHandler;

  before(async () => {
    spawnHandler = () => createQuickChild();
    mock.method(cp, 'spawn', (...args) => spawnHandler(...args));

    const { startTestServer } = require('../helpers/test-server');
    ({ url, close, internals } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
  });

  it('non-streaming: handles error+close double-fire without crashing', async () => {
    let spawnCount = 0;
    spawnHandler = () => {
      spawnCount++;
      if (spawnCount === 1) {
        // First spawn: exits quickly for spawnWithRetry
        return createQuickChild();
      }
      // Second spawn (retry): emits error+close after handlers are attached
      return createDelayedErrorChild();
    };

    const res = await postMessages(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'test error non-stream' }],
      stream: false,
    });

    assert.equal(res.status, 500);
    assert.ok(res.json?.error, 'response has error object');
    assert.equal(res.json.error.type, 'api_error');
    assert.match(res.json.error.message, /ENOENT/);
  });

  it('streaming: handles error+close double-fire without crashing', async () => {
    let spawnCount = 0;
    spawnHandler = () => {
      spawnCount++;
      if (spawnCount === 1) {
        return createQuickChild();
      }
      return createDelayedErrorChild();
    };

    const res = await postMessages(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'test error streaming' }],
      stream: true,
    });

    assert.equal(res.status, 200); // Headers already sent for streaming
    const events = parseSSE(res.body);

    const errorEvent = events.find(e => e.event === 'error');
    assert.ok(errorEvent, 'error SSE event present');
    assert.match(errorEvent.data.error.message, /ENOENT/);

    // Should NOT have message_stop after error (close handler should skip)
    const eventsAfterError = events.slice(events.findIndex(e => e.event === 'error') + 1);
    const stopAfterError = eventsAfterError.find(e => e.event === 'message_stop');
    assert.equal(stopAfterError, undefined, 'no message_stop after error (close handler skipped)');
  });

  it('activeRuns cleaned up after spawn error', async () => {
    let spawnCount = 0;
    spawnHandler = () => {
      spawnCount++;
      if (spawnCount === 1) {
        return createQuickChild();
      }
      return createDelayedErrorChild();
    };

    await postMessages(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'cleanup after error' }],
      stream: false,
    });

    await new Promise(r => setTimeout(r, 100));
    assert.equal(internals.activeRuns.size, 0, 'activeRuns should be empty');
  });
});
