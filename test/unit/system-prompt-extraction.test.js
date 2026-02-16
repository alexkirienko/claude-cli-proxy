const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, request } = require('../helpers/test-server');

describe('system prompt extraction', { timeout: 30000 }, () => {
  let url, close;

  before(async () => {
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    await new Promise(r => setTimeout(r, 1000));
    await close();
  });

  // These tests verify that system prompt extraction doesn't crash (400)
  // or throw an unhandled exception (500 "Internal server error").
  // The CLI itself will fail (500) since CLAUDE_PATH is /bin/echo or similar,
  // but the specific error message varies by platform (ENOENT vs parse error).

  const validBody = (systemValue) => JSON.stringify({
    model: 'sonnet',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    ...(systemValue !== undefined ? { system: systemValue } : {}),
  });

  function assertNotValidationError(res) {
    // 400 = validation failed during system prompt extraction (bug)
    assert.notEqual(res.status, 400, 'should not be a validation error');
    // 500 is expected (CLI fails), but should not be "Internal server error"
    // which would indicate an unhandled exception in system prompt extraction
    assert.equal(res.status, 500);
    assert.ok(res.json?.error?.message, 'error has a message');
    assert.ok(
      !res.json.error.message.startsWith('Internal server error'),
      'should not be an unhandled exception'
    );
  }

  it('accepts system as string', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody('You are a helpful assistant'),
    });
    assertNotValidationError(res);
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
    assertNotValidationError(res);
  });

  it('accepts system as object with .text property', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody({ text: 'You are a helpful assistant.' }),
    });
    assertNotValidationError(res);
  });

  it('accepts request with no system prompt', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody(undefined),
    });
    assertNotValidationError(res);
  });

  it('strips gateway tags from system string', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody('You are helpful [[reply_to_message_id: 123]] '),
    });
    assertNotValidationError(res);
  });

  it('handles empty string system prompt', async () => {
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody(''),
    });
    assertNotValidationError(res);
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
    assertNotValidationError(res);
  });
});
