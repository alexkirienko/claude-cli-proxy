const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('../helpers/test-server');

describe('POST /v1/messages validation', () => {
  let url, close;

  before(async () => {
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  describe('invalid JSON body', () => {
    it('returns 400', async () => {
      const res = await request(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json {{{',
      });
      assert.equal(res.status, 400);
    });

    it('body error type is invalid_request', async () => {
      const res = await request(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json {{{',
      });
      assert.equal(res.json.error.type, 'invalid_request');
    });
  });

  describe('no user message', () => {
    it('returns 400', async () => {
      const res = await request(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonnet',
          messages: [{ role: 'assistant', content: 'hi' }],
          stream: false,
        }),
      });
      assert.equal(res.status, 400);
    });

    it('body error message is "No user message found"', async () => {
      const res = await request(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonnet',
          messages: [{ role: 'assistant', content: 'hi' }],
          stream: false,
        }),
      });
      assert.equal(res.json.error.message, 'No user message found');
    });
  });
});
