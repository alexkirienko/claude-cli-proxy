const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../../server.js');
mod._server.close();

const { parseChatId } = mod;

describe('parseChatId', () => {
  it('extracts chat_id from OpenClaw inbound metadata', () => {
    const sysText = 'Some preamble\n```json\n{"schema":"openclaw.inbound_meta.v1","message_id":"4684","chat_id":"telegram:19847781"}\n```';
    assert.equal(parseChatId(sysText), 'telegram:19847781');
  });

  it('returns null when no chat_id present', () => {
    assert.equal(parseChatId('You are a helpful assistant'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseChatId(''), null);
  });

  it('handles chat_id with different providers', () => {
    const sysText = '{"chat_id": "whatsapp:+1234567890"}';
    assert.equal(parseChatId(sysText), 'whatsapp:+1234567890');
  });

  it('handles chat_id with spaces around colon', () => {
    const sysText = '{ "chat_id" : "telegram:12345" }';
    assert.equal(parseChatId(sysText), 'telegram:12345');
  });
});
