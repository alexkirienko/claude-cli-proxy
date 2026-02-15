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
 * Push an interleaved sequence of tool_use and text blocks:
 *   CLI index 0: tool_use (filtered)
 *   CLI index 1: text "First" (forwarded -> SSE index 0)
 *   CLI index 2: tool_use (filtered)
 *   CLI index 3: text "Second" (forwarded -> SSE index 1)
 */
function pushInterleavedEvents(child) {
  const events = [
    // tool_use block at CLI index 0
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_a', name: 'bash' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index: 0 },
    // text block at CLI index 1
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'First' } },
    { type: 'content_block_stop', index: 1 },
    // tool_use block at CLI index 2
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool_b', name: 'read' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"y":2}' } },
    { type: 'content_block_stop', index: 2 },
    // text block at CLI index 3
    { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'Second' } },
    { type: 'content_block_stop', index: 3 },
    // result
    { type: 'result', result: 'First\nSecond', usage: { input_tokens: 20, output_tokens: 10 } },
  ];
  for (const ev of events) {
    child.stdout.push(JSON.stringify(ev));
  }
}

describe('Streaming: block index remapping', () => {
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

  it('first text block in SSE has index 0', async () => {
    configureSpawn(pushInterleavedEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Do stuff' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const textStarts = events.filter(
      e => e.event === 'content_block_start' &&
           e.data?.content_block?.type === 'text'
    );

    assert.ok(textStarts.length >= 1, 'at least one text block present');
    assert.equal(textStarts[0].data.index, 0, 'first text block has SSE index 0');
  });

  it('second text block in SSE has index 1', async () => {
    configureSpawn(pushInterleavedEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Do stuff' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const textStarts = events.filter(
      e => e.event === 'content_block_start' &&
           e.data?.content_block?.type === 'text'
    );

    assert.equal(textStarts.length, 2, 'exactly two text blocks');
    assert.equal(textStarts[1].data.index, 1, 'second text block has SSE index 1');
  });

  it('content_block_delta indices match their content_block_start', async () => {
    configureSpawn(pushInterleavedEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Do stuff' }],
      stream: true,
    });

    const events = parseSSE(res.body);

    // Collect all text_delta events
    const textDeltas = events.filter(
      e => e.event === 'content_block_delta' &&
           e.data?.delta?.type === 'text_delta'
    );

    assert.equal(textDeltas.length, 2, 'exactly two text_delta events');
    assert.equal(textDeltas[0].data.index, 0, 'first text_delta at index 0');
    assert.equal(textDeltas[0].data.delta.text, 'First');
    assert.equal(textDeltas[1].data.index, 1, 'second text_delta at index 1');
    assert.equal(textDeltas[1].data.delta.text, 'Second');
  });

  it('content_block_stop indices match their content_block_start', async () => {
    configureSpawn(pushInterleavedEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Do stuff' }],
      stream: true,
    });

    const events = parseSSE(res.body);

    // The server emits content_block_stop for text blocks (not tool_use).
    // Focus on the stops emitted during stream processing.
    const blockStops = events.filter(e => e.event === 'content_block_stop');

    // We expect at least 2 stop events for the 2 text blocks
    assert.ok(blockStops.length >= 2, 'at least two content_block_stop events');
    assert.equal(blockStops[0].data.index, 0, 'first stop at index 0');
    assert.equal(blockStops[1].data.index, 1, 'second stop at index 1');
  });

  it('no tool_use events leak into SSE output', async () => {
    configureSpawn(pushInterleavedEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Do stuff' }],
      stream: true,
    });

    const events = parseSSE(res.body);

    const toolEvents = events.filter(
      e => (e.event === 'content_block_start' && e.data?.content_block?.type === 'tool_use') ||
           (e.event === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta')
    );

    assert.equal(toolEvents.length, 0, 'no tool_use events in SSE output');
  });
});
