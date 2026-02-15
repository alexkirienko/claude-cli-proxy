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
 * Push a tool_use block followed by a text block.
 * CLI index 0 = tool_use (filtered), CLI index 1 = text (forwarded).
 */
function pushToolThenTextEvents(child) {
  const events = [
    // tool_use block at index 0 (should be filtered)
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool1', name: 'bash' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    // text block at index 1 (should be forwarded)
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Result' },
    },
    {
      type: 'content_block_stop',
      index: 1,
    },
    // result
    {
      type: 'result',
      result: 'Result',
      usage: { input_tokens: 15, output_tokens: 8 },
    },
  ];
  for (const ev of events) {
    child.stdout.push(JSON.stringify(ev));
  }
}

describe('Streaming: tool_use filtering', () => {
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

  it('SSE output does not contain tool_use content_block_start', async () => {
    configureSpawn(pushToolThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Run ls' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const toolUseStarts = events.filter(
      e => e.event === 'content_block_start' &&
           e.data?.content_block?.type === 'tool_use'
    );
    assert.equal(toolUseStarts.length, 0, 'no tool_use content_block_start in SSE output');
  });

  it('SSE output does not contain input_json_delta', async () => {
    configureSpawn(pushToolThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Run ls' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const jsonDeltas = events.filter(
      e => e.event === 'content_block_delta' &&
           e.data?.delta?.type === 'input_json_delta'
    );
    assert.equal(jsonDeltas.length, 0, 'no input_json_delta in SSE output');
  });

  it('SSE output contains text content_block_start', async () => {
    configureSpawn(pushToolThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Run ls' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const textStarts = events.filter(
      e => e.event === 'content_block_start' &&
           e.data?.content_block?.type === 'text'
    );
    assert.ok(textStarts.length > 0, 'text content_block_start present');
  });

  it('SSE output contains text_delta with correct text', async () => {
    configureSpawn(pushToolThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Run ls' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const textDelta = events.find(
      e => e.event === 'content_block_delta' &&
           e.data?.delta?.type === 'text_delta'
    );
    assert.ok(textDelta, 'text_delta event present');
    assert.equal(textDelta.data.delta.text, 'Result');
  });

  it('text block has SSE index 0 (remapped from CLI index 1)', async () => {
    configureSpawn(pushToolThenTextEvents);

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Run ls' }],
      stream: true,
    });

    const events = parseSSE(res.body);
    const textStart = events.find(
      e => e.event === 'content_block_start' &&
           e.data?.content_block?.type === 'text'
    );
    assert.equal(textStart.data.index, 0, 'text block remapped to SSE index 0');
  });
});
