const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../../server.js');
mod._server.close();

const { generateMessageId } = mod;

const FORMAT = /^msg_cli_\d+_[a-z0-9]{6}$/;

describe('generateMessageId', () => {
  it('matches the expected format', () => {
    const id = generateMessageId();
    assert.match(id, FORMAT);
  });

  it('produces different IDs on successive calls', () => {
    const a = generateMessageId();
    const b = generateMessageId();
    assert.notEqual(a, b);
  });

  it('contains a recent timestamp (within 1 second of Date.now())', () => {
    const before = Date.now();
    const id = generateMessageId();
    const after = Date.now();

    const parts = id.split('_');
    // parts: ['msg', 'cli', '<timestamp>', '<random>']
    const ts = Number(parts[2]);
    assert.ok(ts >= before, `timestamp ${ts} should be >= ${before}`);
    assert.ok(ts <= after, `timestamp ${ts} should be <= ${after}`);
  });
});
