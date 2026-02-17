const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../../server.js');
mod._server.close();

const { extractJsonObjects } = mod;

describe('extractJsonObjects: stray closing brace', () => {
  it('ignores leading stray } before valid object', () => {
    const result = extractJsonObjects('}{"a":1}');
    assert.deepEqual(result.objects, [{ a: 1 }]);
    assert.equal(result.remainder, '');
  });

  it('ignores multiple leading stray } before valid object', () => {
    const result = extractJsonObjects('}}}{"a":1}');
    assert.deepEqual(result.objects, [{ a: 1 }]);
    assert.equal(result.remainder, '');
  });

  it('ignores stray } between two valid objects', () => {
    const result = extractJsonObjects('{"a":1}}{"b":2}');
    assert.deepEqual(result.objects, [{ a: 1 }, { b: 2 }]);
    assert.equal(result.remainder, '');
  });

  it('does not go negative on braceCount with only stray braces', () => {
    const result = extractJsonObjects('}}}');
    assert.deepEqual(result.objects, []);
    // All stray braces are ignored, startIndex never advances past 0
    assert.equal(result.remainder, '}}}');
  });

  it('handles stray } after valid object with trailing incomplete', () => {
    const result = extractJsonObjects('{"a":1}}{"b":');
    assert.deepEqual(result.objects, [{ a: 1 }]);
    assert.equal(result.remainder, '{"b":');
  });
});
