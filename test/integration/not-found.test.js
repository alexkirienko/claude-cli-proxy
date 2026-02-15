const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('../helpers/test-server');

describe('Unknown routes', () => {
  let url, close;

  before(async () => {
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  describe('GET /unknown-path', () => {
    it('returns 404', async () => {
      const res = await request(`${url}/unknown-path`);
      assert.equal(res.status, 404);
    });

    it('body has error.type: not_found', async () => {
      const res = await request(`${url}/unknown-path`);
      assert.equal(res.json.error.type, 'not_found');
    });
  });

  describe('POST /unknown-path', () => {
    it('returns 404', async () => {
      const res = await request(`${url}/unknown-path`, { method: 'POST' });
      assert.equal(res.status, 404);
    });
  });
});
