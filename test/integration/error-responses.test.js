const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('../helpers/test-server');

describe('error responses', () => {
  let url, close;

  before(async () => {
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  describe('POST /v1/messages with empty body', () => {
    it('returns 400 for empty body', async () => {
      const res = await request(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '',
      });
      assert.equal(res.status, 400);
    });

    it('error format matches Anthropic structure', async () => {
      const res = await request(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '',
      });
      assert.ok(res.json.error, 'response should have error property');
      assert.equal(typeof res.json.error.type, 'string');
      assert.equal(typeof res.json.error.message, 'string');
      assert.equal(res.json.error.type, 'invalid_request');
    });
  });

  describe('POST /v1/messages with non-JSON body', () => {
    it('returns 400 for plain text body', async () => {
      const res = await request(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'this is just plain text',
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.type, 'invalid_request');
      assert.equal(res.json.error.message, 'Invalid JSON');
    });

    it('returns 400 for XML body', async () => {
      const res = await request(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '<request><model>sonnet</model></request>',
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.type, 'invalid_request');
    });
  });

  describe('POST /v1/messages with no user message', () => {
    it('returns 400 for empty messages array', async () => {
      const res = await request(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonnet',
          messages: [],
          stream: false,
        }),
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.message, 'No user message found');
    });

    it('returns 400 when only assistant messages exist', async () => {
      const res = await request(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonnet',
          messages: [
            { role: 'assistant', content: 'Hello' },
            { role: 'assistant', content: 'How are you?' },
          ],
          stream: false,
        }),
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.message, 'No user message found');
    });
  });

  describe('unknown endpoints return 404', () => {
    it('returns 404 for GET /unknown', async () => {
      const res = await request(`${url}/unknown`);
      assert.equal(res.status, 404);
      assert.equal(res.json.error.type, 'not_found');
      assert.equal(res.json.error.message, 'Not found');
    });

    it('returns 404 for GET /v1/messages (wrong method)', async () => {
      const res = await request(`${url}/v1/messages`);
      assert.equal(res.status, 404);
    });

    it('returns 404 for POST /health (wrong method)', async () => {
      const res = await request(`${url}/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 404);
    });

    it('returns 404 for GET /v1/completions (nonexistent API)', async () => {
      const res = await request(`${url}/v1/completions`);
      assert.equal(res.status, 404);
    });
  });

  describe('error response format validation', () => {
    it('all error responses have {error: {type, message}} structure', async () => {
      // Test multiple error scenarios
      const scenarios = [
        { url: `${url}/v1/messages`, options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'bad' } },
        { url: `${url}/nonexistent`, options: {} },
      ];

      for (const scenario of scenarios) {
        const res = await request(scenario.url, scenario.options);
        assert.ok(res.json, `response should be JSON for ${scenario.url}`);
        assert.ok(res.json.error, `response should have error for ${scenario.url}`);
        assert.equal(typeof res.json.error.type, 'string', `error.type should be string for ${scenario.url}`);
        assert.equal(typeof res.json.error.message, 'string', `error.message should be string for ${scenario.url}`);
      }
    });
  });

  describe('CORS headers', () => {
    it('includes CORS headers on error responses', async () => {
      const res = await request(`${url}/nonexistent`);
      assert.equal(res.headers['access-control-allow-origin'], '*');
    });

    it('OPTIONS returns 204 with CORS headers', async () => {
      const res = await request(`${url}/v1/messages`, { method: 'OPTIONS' });
      assert.equal(res.status, 204);
      assert.equal(res.headers['access-control-allow-origin'], '*');
      assert.ok(res.headers['access-control-allow-methods'].includes('POST'));
    });
  });
});
