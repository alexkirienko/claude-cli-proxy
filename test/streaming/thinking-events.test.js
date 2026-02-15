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
 * Push a thinking block followed by a text block.
 *   CLI index 0: thinking
 *   CLI index 1: text
 */
function pushThinkingThenTextEvents(child) {
  const events = [
    // thinking block at index 0
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me think...' },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    // text block at index 1
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Answer' },
    },
    {
      type: 'content_block_stop',
      index: 1,
    },
    // result
    {
      type: 'result',
      result: 'Answer',
      usage: { input_tokens: 12, output_tokens: 6 },
    },
  ];
  for (const ev of events) {
    child.stdout.push(JSON.stringify(ev));
  }
}

describe('Streaming: thinking events', () => {
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

  it('SSE output contains thinking content_block_start', async () => {
    configureSpawn(pushThinkingThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Think about this' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const thinkingStart = events.find(
      e => e.event === 'content_block_start' &&
           e.data?.content_block?.type === 'thinking'
    );

    assert.ok(thinkingStart, 'thinking content_block_start is present');
  });

  it('SSE output contains thinking_delta', async () => {
    configureSpawn(pushThinkingThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Think about this' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const thinkingDelta = events.find(
      e => e.event === 'content_block_delta' &&
           e.data?.delta?.type === 'thinking_delta'
    );

    assert.ok(thinkingDelta, 'thinking_delta event is present');
    assert.equal(thinkingDelta.data.delta.thinking, 'Let me think...');
  });

  it('thinking block has SSE index 0', async () => {
    configureSpawn(pushThinkingThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Think about this' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const thinkingStart = events.find(
      e => e.event === 'content_block_start' &&
           e.data?.content_block?.type === 'thinking'
    );

    assert.equal(thinkingStart.data.index, 0, 'thinking block at SSE index 0');
  });

  it('text block has SSE index 1', async () => {
    configureSpawn(pushThinkingThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Think about this' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const textStart = events.find(
      e => e.event === 'content_block_start' &&
           e.data?.content_block?.type === 'text'
    );

    assert.equal(textStart.data.index, 1, 'text block at SSE index 1');
  });

  it('thinking is not filtered like tool_use', async () => {
    configureSpawn(pushThinkingThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Think about this' }],
      stream: true,
    });

    const events = parseSSE(res.body);

    const thinkingStarts = events.filter(
      e => e.event === 'content_block_start' &&
           e.data?.content_block?.type === 'thinking'
    );
    const thinkingDeltas = events.filter(
      e => e.event === 'content_block_delta' &&
           e.data?.delta?.type === 'thinking_delta'
    );

    assert.equal(thinkingStarts.length, 1, 'exactly one thinking start');
    assert.equal(thinkingDeltas.length, 1, 'exactly one thinking delta');
  });

  it('events arrive in order: thinking start, thinking delta, thinking stop, text start, text delta, text stop', async () => {
    configureSpawn(pushThinkingThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Think about this' }],
      stream: true,
    });

    const events = parseSSE(res.body);

    // Build a simplified event timeline
    const timeline = events
      .filter(e => ['content_block_start', 'content_block_delta', 'content_block_stop'].includes(e.event))
      .map(e => {
        if (e.event === 'content_block_start') {
          return `${e.data.content_block.type}_start`;
        }
        if (e.event === 'content_block_delta') {
          return `${e.data.delta.type}`;
        }
        return `block_stop_${e.data.index}`;
      });

    const expectedOrder = [
      'thinking_start',
      'thinking_delta',
      'block_stop_0',
      'text_start',
      'text_delta',
      'block_stop_1',
    ];

    assert.deepEqual(timeline, expectedOrder);
  });
});
