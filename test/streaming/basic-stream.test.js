const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const cp = require('child_process');
const { parseSSE } = require('../helpers/sse-parser');
const { createMockChild } = require('../helpers/mock-child');

/**
 * Stream a POST /v1/messages request and collect the full response.
 */
function streamRequest(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
 * Push a basic text streaming sequence to a mock child's stdout.
 */
function pushBasicTextEvents(child) {
  const events = [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'result',
      result: 'Hello',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
  for (const ev of events) {
    child.stdout.push(JSON.stringify(ev));
  }
}

describe('Streaming: basic text stream', () => {
  let url, close;
  // Mutable spawn handler: each test sets this to control mock behavior.
  let spawnHandler;

  before(async () => {
    // Mock cp.spawn BEFORE loading the server so the destructured `spawn`
    // reference inside server.js captures the mock.
    mock.method(cp, 'spawn', (...args) => spawnHandler(...args));

    // Now load and start the server (it will capture the mocked spawn)
    const { startTestServer } = require('../helpers/test-server');
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
  });

  /**
   * Configure spawnHandler with the retry pattern:
   * first spawn exits quickly (code 0, triggers "try once more"),
   * second spawn stays alive and receives data after a delay.
   */
  function configureSpawn(pushFn) {
    let spawnCount = 0;
    let mockChild;
    spawnHandler = () => {
      spawnCount++;
      if (spawnCount === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      mockChild = createMockChild({ autoClose: false });
      const mc = mockChild;
      setTimeout(() => {
        pushFn(mc);
        setTimeout(() => mc.emit('close', 0), 100);
      }, 50);
      return mockChild;
    };
  }

  it('returns complete SSE lifecycle for a simple text response', async () => {
    configureSpawn(pushBasicTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);

    const events = parseSSE(res.body);

    const messageStart = events.find(e => e.event === 'message_start');
    const blockStart = events.find(e => e.event === 'content_block_start');
    const blockDelta = events.find(e => e.event === 'content_block_delta');
    const blockStop = events.find(e => e.event === 'content_block_stop');
    const messageDelta = events.find(e => e.event === 'message_delta');
    const messageStop = events.find(e => e.event === 'message_stop');

    assert.ok(messageStart, 'message_start event present');
    assert.ok(blockStart, 'content_block_start event present');
    assert.ok(blockDelta, 'content_block_delta event present');
    assert.ok(blockStop, 'content_block_stop event present');
    assert.ok(messageDelta, 'message_delta event present');
    assert.ok(messageStop, 'message_stop event present');
  });

  it('message_start has correct structure', async () => {
    configureSpawn(pushBasicTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const messageStart = events.find(e => e.event === 'message_start');

    assert.equal(messageStart.data.type, 'message_start');
    assert.ok(messageStart.data.message.id, 'message has an id');
    assert.equal(messageStart.data.message.type, 'message');
    assert.equal(messageStart.data.message.role, 'assistant');
  });

  it('content_block_start has type text at index 0', async () => {
    configureSpawn(pushBasicTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const blockStart = events.find(e => e.event === 'content_block_start');

    assert.ok(blockStart, 'content_block_start present');
    assert.equal(blockStart.data.index, 0);
    assert.equal(blockStart.data.content_block.type, 'text');
  });

  it('content_block_delta carries text_delta with correct text', async () => {
    configureSpawn(pushBasicTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const blockDelta = events.find(e => e.event === 'content_block_delta');

    assert.ok(blockDelta, 'content_block_delta present');
    assert.equal(blockDelta.data.index, 0);
    assert.equal(blockDelta.data.delta.type, 'text_delta');
    assert.equal(blockDelta.data.delta.text, 'Hello');
  });

  it('message_delta has stop_reason end_turn', async () => {
    configureSpawn(pushBasicTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const messageDelta = events.find(e => e.event === 'message_delta');

    assert.ok(messageDelta, 'message_delta present');
    assert.equal(messageDelta.data.delta.stop_reason, 'end_turn');
  });

  it('SSE events arrive in correct order', async () => {
    configureSpawn(pushBasicTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const eventTypes = events.map(e => e.event);

    const expectedOrder = [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ];

    // Filter to only the events we care about
    const relevant = eventTypes.filter(t => expectedOrder.includes(t));
    assert.deepEqual(relevant, expectedOrder);
  });
});
