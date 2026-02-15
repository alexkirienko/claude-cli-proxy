const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../../server.js');
mod._server.close();

const { sessionKeyToUuid } = mod;

const UUID_V4_VARIANT8 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

describe('sessionKeyToUuid', () => {
  it('produces a valid UUID format', () => {
    const uuid = sessionKeyToUuid('test-key');
    assert.match(uuid, UUID_V4_VARIANT8);
  });

  it('is deterministic (same input yields same output)', () => {
    const a = sessionKeyToUuid('deterministic-key');
    const b = sessionKeyToUuid('deterministic-key');
    assert.equal(a, b);
  });

  it('produces different UUIDs for different inputs', () => {
    const a = sessionKeyToUuid('key-one');
    const b = sessionKeyToUuid('key-two');
    assert.notEqual(a, b);
  });

  it('has version nibble set to 4', () => {
    const uuid = sessionKeyToUuid('version-check');
    const versionChar = uuid.split('-')[2][0];
    assert.equal(versionChar, '4');
  });

  it('has variant nibble set to 8', () => {
    const uuid = sessionKeyToUuid('variant-check');
    const variantChar = uuid.split('-')[3][0];
    assert.equal(variantChar, '8');
  });
});
