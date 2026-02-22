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

describe('Streaming: compaction timeout handling', () => {
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

  it('status:compacting event sends "please wait" notification in SSE stream', async () => {
    configureSpawn((child) => {
      // CLI emits status:compacting before the long compaction silence
      child.stdout.push(JSON.stringify({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
      }));
      // Then compaction finishes with compact_boundary
      child.stdout.push(JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 170000 },
      }));
      // Then normal response
      child.stdout.push(JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }));
      child.stdout.push(JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Response after compaction' },
      }));
      child.stdout.push(JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      }));
      child.stdout.push(JSON.stringify({
        type: 'result',
        result: 'Response after compaction',
        usage: { input_tokens: 50000, output_tokens: 20 },
      }));
    });

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    assert.equal(res.status, 200);
    const events = parseSSE(res.body);

    // Find the "please wait" compaction notification
    const compactionNotice = events.find(e =>
      e.event === 'content_block_delta' &&
      e.data?.delta?.text?.includes('Compacting context, please wait')
    );
    assert.ok(compactionNotice, 'compaction "please wait" notification should be present');

    // Find the compact_boundary notification (after compaction completes)
    const compactionDone = events.find(e =>
      e.event === 'content_block_delta' &&
      e.data?.delta?.text?.includes('Context Compaction')
    );
    assert.ok(compactionDone, 'compaction completed notification should be present');
    assert.ok(compactionDone.data.delta.text.includes('170000 tokens'), 'should include token count');

    // Verify the actual response content follows
    const responseText = events.find(e =>
      e.event === 'content_block_delta' &&
      e.data?.delta?.text === 'Response after compaction'
    );
    assert.ok(responseText, 'actual response should follow compaction notifications');
  });

  it('status:compacting arrives before message_start — envelope is injected', async () => {
    configureSpawn((child) => {
      // status:compacting arrives as the very first event (before any content)
      child.stdout.push(JSON.stringify({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
      }));
      // Normal response after compaction
      child.stdout.push(JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }));
      child.stdout.push(JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Done' },
      }));
      child.stdout.push(JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      }));
      child.stdout.push(JSON.stringify({
        type: 'result',
        result: 'Done',
        usage: { input_tokens: 10, output_tokens: 1 },
      }));
    });

    const res = await streamRequest(url, {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Test' }],
      stream: true,
    });

    assert.equal(res.status, 200);
    const events = parseSSE(res.body);

    // message_start must be present (injected by compaction handler)
    const messageStart = events.find(e => e.event === 'message_start');
    assert.ok(messageStart, 'message_start should be present');

    // The compaction notice must come after message_start
    const messageStartIdx = events.indexOf(messageStart);
    const compactionNotice = events.find(e =>
      e.event === 'content_block_delta' &&
      e.data?.delta?.text?.includes('Compacting context, please wait')
    );
    const compactionIdx = events.indexOf(compactionNotice);
    assert.ok(compactionIdx > messageStartIdx, 'compaction notice should come after message_start');
  });
});
