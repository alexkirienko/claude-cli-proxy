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

describe('Streaming: thinking events filtered from SSE', () => {
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

  it('SSE output does NOT contain thinking content_block_start', async () => {
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

    assert.equal(thinkingStart, undefined, 'thinking content_block_start must NOT be in SSE');
  });

  it('SSE output does NOT contain thinking_delta', async () => {
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

    assert.equal(thinkingDelta, undefined, 'thinking_delta must NOT be in SSE');
  });

  it('text block gets SSE index 0 (thinking no longer occupies an index)', async () => {
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

    assert.ok(textStart, 'text block must be present');
    assert.equal(textStart.data.index, 0, 'text block at SSE index 0');
  });

  it('only text events appear in SSE timeline', async () => {
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
      'text_start',
      'text_delta',
      'block_stop_0',
    ];

    assert.deepEqual(timeline, expectedOrder);
  });
});
