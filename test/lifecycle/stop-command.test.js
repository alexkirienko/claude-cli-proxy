const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('../helpers/test-server');

describe('Lifecycle: /stop command', () => {
  let url, close, internals;

  before(async () => {
    ({ url, close, internals } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  it('returns "No active task to stop." when no active run exists', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'sonnet',
        messages: [{ role: 'user', content: '/stop' }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);

    const body = res.json;
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.ok(Array.isArray(body.content), 'content is an array');
    assert.equal(body.content[0].type, 'text');
    assert.equal(body.content[0].text, 'No active task to stop.');
  });

  it('returns zero usage tokens for /stop command', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'sonnet',
        messages: [{ role: 'user', content: '/stop' }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.usage.input_tokens, 0);
    assert.equal(res.json.usage.output_tokens, 0);
  });

  it('returns end_turn stop_reason for /stop command', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'sonnet',
        messages: [{ role: 'user', content: '/stop' }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.stop_reason, 'end_turn');
    assert.equal(res.json.stop_sequence, null);
  });

  it('returns a valid message id', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'sonnet',
        messages: [{ role: 'user', content: '/stop' }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    assert.ok(res.json.id, 'response has an id');
    assert.match(res.json.id, /^msg_cli_/, 'id has msg_cli_ prefix');
  });
});
