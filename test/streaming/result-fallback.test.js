const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const cp = require('child_process');
const { parseSSE } = require('../helpers/sse-parser');
const { createMockChild } = require('../helpers/mock-child');

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
 * Push only a result event with no preceding content_block events.
 * This simulates the case where text was not streamed via content_block_delta
 * and the server must synthesize blocks from the result fallback.
 */
function pushResultOnly(child) {
  const events = [
    {
      type: 'result',
      result: 'Fallback text',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
  for (const ev of events) {
    child.stdout.push(JSON.stringify(ev));
  }
}

describe('Streaming: result fallback (no streamed content blocks)', () => {
  let url, close;
  let spawnHandler;

  before(async () => {
    mock.method(cp, 'spawn', (...args) => spawnHandler(...args));
    const { startTestServer } = require('../helpers/test-server');
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
  });

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

  it('SSE output contains a synthetic content_block_start with type text', async () => {
    configureSpawn(pushResultOnly);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const blockStart = events.find(
      e => e.event === 'content_block_start' &&
           e.data?.content_block?.type === 'text'
    );

    assert.ok(blockStart, 'synthetic content_block_start is present');
    assert.equal(blockStart.data.index, 0, 'synthetic block at index 0');
  });

  it('SSE output contains content_block_delta with fallback text', async () => {
    configureSpawn(pushResultOnly);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const textDelta = events.find(
      e => e.event === 'content_block_delta' &&
           e.data?.delta?.type === 'text_delta'
    );

    assert.ok(textDelta, 'content_block_delta with text_delta is present');
    assert.equal(textDelta.data.delta.text, 'Fallback text');
  });

  it('message_delta has usage with output_tokens', async () => {
    configureSpawn(pushResultOnly);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const messageDelta = events.find(e => e.event === 'message_delta');

    assert.ok(messageDelta, 'message_delta event is present');
    assert.equal(messageDelta.data.usage.output_tokens, 5);
  });

  it('full SSE lifecycle is complete even with result-only input', async () => {
    configureSpawn(pushResultOnly);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const eventTypes = events.map(e => e.event);

    assert.ok(eventTypes.includes('message_start'), 'message_start present');
    assert.ok(eventTypes.includes('content_block_start'), 'content_block_start present');
    assert.ok(eventTypes.includes('content_block_delta'), 'content_block_delta present');
    assert.ok(eventTypes.includes('message_delta'), 'message_delta present');
    assert.ok(eventTypes.includes('message_stop'), 'message_stop present');
  });

  it('message_start appears before content blocks', async () => {
    configureSpawn(pushResultOnly);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const messageStartIdx = events.findIndex(e => e.event === 'message_start');
    const blockStartIdx = events.findIndex(e => e.event === 'content_block_start');

    assert.ok(messageStartIdx < blockStartIdx, 'message_start before content_block_start');
  });
});
