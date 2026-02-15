const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../../server.js');
mod._server.close();

const { extractJsonObjects } = mod;

describe('extractJsonObjects', () => {
  it('parses a single complete object', () => {
    const result = extractJsonObjects('{"a":1}');
    assert.deepEqual(result.objects, [{ a: 1 }]);
    assert.equal(result.remainder, '');
  });

  it('parses two concatenated objects', () => {
    const result = extractJsonObjects('{"a":1}{"b":2}');
    assert.deepEqual(result.objects, [{ a: 1 }, { b: 2 }]);
    assert.equal(result.remainder, '');
  });

  it('returns remainder for incomplete trailing object', () => {
    const result = extractJsonObjects('{"a":1}{"b":');
    assert.deepEqual(result.objects, [{ a: 1 }]);
    assert.equal(result.remainder, '{"b":');
  });

  it('handles nested braces', () => {
    const result = extractJsonObjects('{"a":{"b":1}}');
    assert.deepEqual(result.objects, [{ a: { b: 1 } }]);
  });

  it('handles escaped quotes inside strings', () => {
    const result = extractJsonObjects('{"a":"he said \\"hi\\""}');
    assert.deepEqual(result.objects, [{ a: 'he said "hi"' }]);
  });

  it('handles braces inside strings', () => {
    const result = extractJsonObjects('{"a":"}{{"}');
    assert.deepEqual(result.objects, [{ a: '}{{' }]);
  });

  it('returns empty arrays for empty buffer', () => {
    const result = extractJsonObjects('');
    assert.deepEqual(result.objects, []);
    assert.equal(result.remainder, '');
  });

  it('handles whitespace between objects', () => {
    const result = extractJsonObjects('  {"a":1}  {"b":2}  ');
    assert.deepEqual(result.objects, [{ a: 1 }, { b: 2 }]);
    assert.equal(result.remainder, '  ');
  });

  it('handles deeply nested objects', () => {
    const result = extractJsonObjects('{"a":{"b":{"c":1}}}');
    assert.deepEqual(result.objects, [{ a: { b: { c: 1 } } }]);
  });

  it('handles newlines between objects', () => {
    const result = extractJsonObjects('{"a":1}\n{"b":2}');
    assert.deepEqual(result.objects, [{ a: 1 }, { b: 2 }]);
  });
});
