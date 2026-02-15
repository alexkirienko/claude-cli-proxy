const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('../helpers/test-server');

describe('GET /v1/models', () => {
  let url, close;

  before(async () => {
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  it('returns 200', async () => {
    const res = await request(`${url}/v1/models`);
    assert.equal(res.status, 200);
  });

  it('body has data array with 3 items', async () => {
    const res = await request(`${url}/v1/models`);
    assert.ok(Array.isArray(res.json.data));
    assert.equal(res.json.data.length, 3);
  });

  it('each item has id, name, type: model, and created_at (number)', async () => {
    const res = await request(`${url}/v1/models`);
    for (const item of res.json.data) {
      assert.equal(typeof item.id, 'string');
      assert.equal(typeof item.name, 'string');
      assert.equal(item.type, 'model');
      assert.equal(typeof item.created_at, 'number');
    }
  });

  it('model IDs are opus, sonnet, haiku', async () => {
    const res = await request(`${url}/v1/models`);
    const ids = res.json.data.map(m => m.id);
    assert.deepEqual(ids, ['opus', 'sonnet', 'haiku']);
  });
});
