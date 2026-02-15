const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('../helpers/test-server');

describe('CORS', () => {
  let url, close;

  before(async () => {
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  describe('OPTIONS /v1/messages', () => {
    it('returns 204', async () => {
      const res = await request(`${url}/v1/messages`, { method: 'OPTIONS' });
      assert.equal(res.status, 204);
    });

    it('has access-control-allow-origin: *', async () => {
      const res = await request(`${url}/v1/messages`, { method: 'OPTIONS' });
      assert.equal(res.headers['access-control-allow-origin'], '*');
    });

    it('has access-control-allow-methods including GET, POST, OPTIONS', async () => {
      const res = await request(`${url}/v1/messages`, { method: 'OPTIONS' });
      const methods = res.headers['access-control-allow-methods'];
      assert.ok(methods.includes('GET'), 'should include GET');
      assert.ok(methods.includes('POST'), 'should include POST');
      assert.ok(methods.includes('OPTIONS'), 'should include OPTIONS');
    });

    it('has access-control-allow-headers including x-session-key', async () => {
      const res = await request(`${url}/v1/messages`, { method: 'OPTIONS' });
      const headers = res.headers['access-control-allow-headers'];
      assert.ok(headers.includes('x-session-key'), 'should include x-session-key');
    });
  });

  describe('GET /health CORS headers', () => {
    it('has access-control-allow-origin: *', async () => {
      const res = await request(`${url}/health`);
      assert.equal(res.headers['access-control-allow-origin'], '*');
    });
  });
});
