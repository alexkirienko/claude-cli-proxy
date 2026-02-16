const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('../helpers/test-server');

describe('system prompt extraction', { timeout: 30000 }, () => {
  let url, close;

  before(async () => {
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    // Allow spawned /bin/echo processes to fully exit before closing server
    await new Promise(r => setTimeout(r, 1000));
    await close();
  });

  // With CLAUDE_PATH=/bin/echo, valid requests pass validation (no 400)
  // but CLI output is not JSON, so we expect 500 "No parseable output from CLI".
  // A 400 would mean system prompt extraction crashed during validation.
  // A 500 with "Internal server error" would mean extraction threw an exception.

  const validBody = (systemValue) => JSON.stringify({
    model: 'sonnet',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    ...(systemValue !== undefined ? { system: systemValue } : {}),
  });

  it('accepts system as string', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody('You are a helpful assistant'),
    });
    // Should not be a validation error
    assert.notEqual(res.status, 400);
    // Should be a CLI output parse error (expected with /bin/echo)
    assert.equal(res.status, 500);
    assert.equal(res.json.error.message, 'No parseable output from CLI');
  });

  it('accepts system as array of text blocks', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody([
        { type: 'text', text: 'You are a helpful assistant.' },
        { type: 'text', text: 'Be concise.' },
      ]),
    });
    assert.notEqual(res.status, 400);
    assert.equal(res.status, 500);
    assert.equal(res.json.error.message, 'No parseable output from CLI');
  });

  it('accepts system as object with .text property', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody({ text: 'You are a helpful assistant.' }),
    });
    assert.notEqual(res.status, 400);
    assert.equal(res.status, 500);
    assert.equal(res.json.error.message, 'No parseable output from CLI');
  });

  it('accepts request with no system prompt', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody(undefined),
    });
    assert.notEqual(res.status, 400);
    assert.equal(res.status, 500);
    assert.equal(res.json.error.message, 'No parseable output from CLI');
  });

  it('strips gateway tags from system string', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody('You are helpful [[reply_to_message_id: 123]] '),
    });
    assert.notEqual(res.status, 400);
    assert.equal(res.status, 500);
    assert.equal(res.json.error.message, 'No parseable output from CLI');
  });

  it('handles empty string system prompt', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody(''),
    });
    assert.notEqual(res.status, 400);
    assert.equal(res.status, 500);
    assert.equal(res.json.error.message, 'No parseable output from CLI');
  });

  it('handles system array with mixed block types (non-text filtered)', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody([
        { type: 'text', text: 'Be helpful.' },
        { type: 'image', source: { type: 'base64', data: 'abc' } },
      ]),
    });
    assert.notEqual(res.status, 400);
    assert.equal(res.status, 500);
    assert.equal(res.json.error.message, 'No parseable output from CLI');
  });
});
