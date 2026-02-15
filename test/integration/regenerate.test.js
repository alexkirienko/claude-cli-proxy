const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');

describe('POST /v1/messages with x-regenerate header', () => {
  let url, close;
  let spawnHandler;

  before(async () => {
    let callCount = 0;
    spawnHandler = () => {
      callCount++;
      if (callCount % 2 === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      const child = createMockChild({ autoClose: false });
      process.nextTick(() => {
        child.stdout.push(JSON.stringify({
          result: 'Regenerated response.',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
        setTimeout(() => child.emit('close', 0), 50);
      });
      return child;
    };

    mock.method(cp, 'spawn', (...args) => spawnHandler(...args));

    const { startTestServer } = require('../helpers/test-server');
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
  });

  it('accepts x-regenerate header without error', async () => {
    const { request } = require('../helpers/test-server');
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-regenerate': 'true',
      },
      body: {
        model: 'sonnet',
        messages: [{ role: 'user', content: 'Hello again' }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.content[0].text, 'Regenerated response.');
  });

  it('CORS allows x-regenerate header', async () => {
    const { request } = require('../helpers/test-server');
    const res = await request(`${url}/v1/messages`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://localhost:3000',
        'Access-Control-Request-Headers': 'x-regenerate',
      },
    });

    assert.equal(res.status, 204);
    const allowed = res.headers['access-control-allow-headers'] || '';
    assert.ok(allowed.includes('x-regenerate'), `CORS should allow x-regenerate, got: ${allowed}`);
  });
});
