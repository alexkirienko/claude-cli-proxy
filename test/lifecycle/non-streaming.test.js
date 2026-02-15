const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');

describe('Lifecycle: non-streaming response', () => {
  let url, close, internals;
  let spawnHandler;

  before(async () => {
    // Mock spawn BEFORE requiring server so the destructured reference is captured
    spawnHandler = () => createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
    mock.method(cp, 'spawn', (...args) => spawnHandler(...args));

    const { startTestServer } = require('../helpers/test-server');
    ({ url, close, internals } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
  });

  it('returns well-formed JSON for stream:false request', async () => {
    const { request } = require('../helpers/test-server');
    let spawnCount = 0;
    spawnHandler = () => {
      spawnCount++;
      if (spawnCount % 2 === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      const child = createMockChild({ autoClose: false });
      process.nextTick(() => {
        child.stdout.push(JSON.stringify({
          result: 'Hello',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
        setTimeout(() => child.emit('close', 0), 50);
      });
      return child;
    };

    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'sonnet',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);

    const body = res.json;
    assert.ok(body.id, 'response has an id');
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.ok(Array.isArray(body.content), 'content is an array');
    assert.equal(body.content[0].type, 'text');
    assert.equal(body.content[0].text, 'Hello');
    assert.equal(body.stop_reason, 'end_turn');
    assert.equal(body.usage.input_tokens, 10);
    assert.equal(body.usage.output_tokens, 5);
  });

  it('returns correct model in response', async () => {
    const { request } = require('../helpers/test-server');
    let spawnCount = 0;
    spawnHandler = () => {
      spawnCount++;
      if (spawnCount % 2 === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      const child = createMockChild({ autoClose: false });
      process.nextTick(() => {
        child.stdout.push(JSON.stringify({
          result: 'Test',
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
        setTimeout(() => child.emit('close', 0), 50);
      });
      return child;
    };

    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Test' }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.model, 'claude-3-5-sonnet-20241022');
  });

  it('includes cache tokens in input_tokens sum', async () => {
    const { request } = require('../helpers/test-server');
    let spawnCount = 0;
    spawnHandler = () => {
      spawnCount++;
      if (spawnCount % 2 === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      const child = createMockChild({ autoClose: false });
      process.nextTick(() => {
        child.stdout.push(JSON.stringify({
          result: 'Cached',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 50,
          },
        }));
        setTimeout(() => child.emit('close', 0), 50);
      });
      return child;
    };

    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'sonnet',
        messages: [{ role: 'user', content: 'Cache test' }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    // input_tokens = 10 + 100 + 50 = 160
    assert.equal(res.json.usage.input_tokens, 160);
    assert.equal(res.json.usage.output_tokens, 5);
  });

  it('stop_sequence is null', async () => {
    const { request } = require('../helpers/test-server');
    let spawnCount = 0;
    spawnHandler = () => {
      spawnCount++;
      if (spawnCount % 2 === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      const child = createMockChild({ autoClose: false });
      process.nextTick(() => {
        child.stdout.push(JSON.stringify({
          result: 'OK',
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
        setTimeout(() => child.emit('close', 0), 50);
      });
      return child;
    };

    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'sonnet',
        messages: [{ role: 'user', content: 'OK' }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.stop_sequence, null);
  });
});
