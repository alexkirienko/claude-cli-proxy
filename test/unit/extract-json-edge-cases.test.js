const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../../server.js');
mod._server.close();

const { extractJsonObjects } = mod;

describe('extractJsonObjects edge cases', () => {
  it('handles arrays inside objects', () => {
    const result = extractJsonObjects('{"a":[1,2,3]}');
    assert.deepEqual(result.objects, [{ a: [1, 2, 3] }]);
    assert.equal(result.remainder, '');
  });

  it('handles nested arrays with objects', () => {
    const result = extractJsonObjects('{"a":[{"b":1},{"c":2}]}');
    assert.deepEqual(result.objects, [{ a: [{ b: 1 }, { c: 2 }] }]);
  });

  it('handles unicode escape sequences', () => {
    const result = extractJsonObjects('{"key":"\\u0041\\u0042"}');
    assert.deepEqual(result.objects, [{ key: 'AB' }]);
  });

  it('handles string ending with escaped backslash', () => {
    // Raw JSON: {"key":"val\\"} → value is "val\"
    const input = '{"key":"val\\\\"}';
    const result = extractJsonObjects(input);
    assert.deepEqual(result.objects, [{ key: 'val\\' }]);
    assert.equal(result.remainder, '');
  });

  it('handles double escaped backslash followed by quote', () => {
    // Raw JSON: {"key":"a\\\\"} → value is "a\\"
    const input = '{"key":"a\\\\\\\\"}';
    const result = extractJsonObjects(input);
    assert.deepEqual(result.objects, [{ key: 'a\\\\' }]);
  });

  it('handles very deeply nested objects (10 levels)', () => {
    const input = '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":{"j":1}}}}}}}}}}';
    const result = extractJsonObjects(input);
    assert.equal(result.objects.length, 1);
    assert.equal(result.objects[0].a.b.c.d.e.f.g.h.i.j, 1);
    assert.equal(result.remainder, '');
  });

  it('handles booleans and null values', () => {
    const result = extractJsonObjects('{"a":true,"b":false,"c":null}');
    assert.deepEqual(result.objects, [{ a: true, b: false, c: null }]);
  });

  it('handles JSON with newlines inside strings', () => {
    const result = extractJsonObjects('{"key":"line1\\nline2"}');
    assert.deepEqual(result.objects, [{ key: 'line1\nline2' }]);
  });

  it('returns only garbage text as remainder when no objects found', () => {
    const result = extractJsonObjects('hello world no json here');
    assert.deepEqual(result.objects, []);
    assert.equal(result.remainder, 'hello world no json here');
  });

  it('handles object followed by non-JSON garbage', () => {
    const result = extractJsonObjects('{"a":1} some garbage text');
    assert.deepEqual(result.objects, [{ a: 1 }]);
    assert.equal(result.remainder, ' some garbage text');
  });

  it('handles empty object', () => {
    const result = extractJsonObjects('{}');
    assert.deepEqual(result.objects, [{}]);
    assert.equal(result.remainder, '');
  });

  it('handles multiple empty objects', () => {
    const result = extractJsonObjects('{}{}{}');
    assert.deepEqual(result.objects, [{}, {}, {}]);
  });

  it('handles string with escaped forward slash', () => {
    const result = extractJsonObjects('{"url":"http:\\/\\/example.com"}');
    assert.deepEqual(result.objects, [{ url: 'http://example.com' }]);
  });

  it('handles string with tab escape', () => {
    const result = extractJsonObjects('{"a":"col1\\tcol2"}');
    assert.deepEqual(result.objects, [{ a: 'col1\tcol2' }]);
  });

  it('handles empty string values', () => {
    const result = extractJsonObjects('{"a":"","b":""}');
    assert.deepEqual(result.objects, [{ a: '', b: '' }]);
  });

  it('handles large number values', () => {
    const result = extractJsonObjects('{"n":999999999999999}');
    assert.deepEqual(result.objects, [{ n: 999999999999999 }]);
  });

  it('handles negative and float numbers', () => {
    const result = extractJsonObjects('{"a":-42,"b":3.14}');
    assert.deepEqual(result.objects, [{ a: -42, b: 3.14 }]);
  });

  it('incomplete nested object is remainder', () => {
    const result = extractJsonObjects('{"a":{"b":1}');
    assert.deepEqual(result.objects, []);
    assert.equal(result.remainder, '{"a":{"b":1}');
  });

  it('handles three concatenated objects with mixed content', () => {
    const result = extractJsonObjects('{"a":1}{"b":"two"}{"c":true}');
    assert.deepEqual(result.objects, [{ a: 1 }, { b: 'two' }, { c: true }]);
    assert.equal(result.remainder, '');
  });

  it('skips unparseable JSON with valid brace structure', () => {
    // Valid brace nesting but invalid JSON (missing quotes on key)
    const result = extractJsonObjects('{bad json}');
    assert.deepEqual(result.objects, []);
    // After braceCount hits 0, it tries JSON.parse which fails, then startIndex advances
    assert.equal(result.remainder, '');
  });

  it('handles colons inside strings without confusion', () => {
    const result = extractJsonObjects('{"time":"12:30:00"}');
    assert.deepEqual(result.objects, [{ time: '12:30:00' }]);
  });
});
