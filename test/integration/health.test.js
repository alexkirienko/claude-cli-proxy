const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('../helpers/test-server');

describe('GET /health', () => {
  let url, close;

  before(async () => {
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  it('returns 200', async () => {
    const res = await request(`${url}/health`);
    assert.equal(res.status, 200);
  });

  it('Content-Type is application/json', async () => {
    const res = await request(`${url}/health`);
    assert.match(res.headers['content-type'], /application\/json/);
  });

  it('body has status: ok', async () => {
    const res = await request(`${url}/health`);
    assert.equal(res.json.status, 'ok');
  });

  it('body has features array with exactly the expected entries', async () => {
    const res = await request(`${url}/health`);
    assert.deepEqual(res.json.features, ['streaming', 'tool_use', 'thinking', 'monitoring']);
  });

  it('body has monitorClients as a number', async () => {
    const res = await request(`${url}/health`);
    assert.equal(typeof res.json.monitorClients, 'number');
  });

  it('body has claude string (path to CLI)', async () => {
    const res = await request(`${url}/health`);
    assert.equal(typeof res.json.claude, 'string');
    assert.ok(res.json.claude.length > 0);
  });
});
