const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../../server.js');
mod._server.close();

const { mapModelName } = mod;

describe('mapModelName', () => {
  it('strips anthropic/ prefix and maps to opus', () => {
    assert.equal(mapModelName('anthropic/claude-3-opus'), 'opus');
  });

  it('strips claude-cli/ prefix and maps to opus', () => {
    assert.equal(mapModelName('claude-cli/opus'), 'opus');
  });

  it('strips date suffix and maps to opus', () => {
    assert.equal(mapModelName('claude-3-opus-20240229'), 'opus');
  });

  it('passes through direct alias', () => {
    assert.equal(mapModelName('opus'), 'opus');
  });

  it('maps model containing sonnet', () => {
    assert.equal(mapModelName('claude-3.5-sonnet'), 'sonnet');
  });

  it('maps model containing haiku', () => {
    assert.equal(mapModelName('claude-3-haiku'), 'haiku');
  });

  it('handles combined prefix and date suffix', () => {
    assert.equal(mapModelName('anthropic/claude-3-opus-20240229'), 'opus');
  });

  it('passes through unknown model unchanged', () => {
    assert.equal(mapModelName('gpt-4'), 'gpt-4');
  });
});
