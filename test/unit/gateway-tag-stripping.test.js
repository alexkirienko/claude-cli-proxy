const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Recreate the exact regex from server.js to test the pattern directly
const GATEWAY_TAG_RE = /\[\[reply_to_message_id:\s*\d+\]\]\s*/g;

describe('GATEWAY_TAG_RE pattern', () => {
  it('strips tag at end of string', () => {
    const input = 'Hello world [[reply_to_message_id: 123]]';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, 'Hello world ');
  });

  it('strips tag at end with trailing whitespace', () => {
    const input = 'Hello world [[reply_to_message_id: 456]]  \n';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, 'Hello world ');
  });

  it('strips multiple tags', () => {
    const input = 'Hello [[reply_to_message_id: 1]] world [[reply_to_message_id: 2]]';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, 'Hello world ');
  });

  it('strips tag in middle of string', () => {
    // The regex has /g flag so it matches anywhere, not just at end
    const input = 'before [[reply_to_message_id: 99]] after';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, 'before after');
  });

  it('leaves string unchanged when no tags present', () => {
    const input = 'Just a normal message with [brackets] and [[double]]';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, input);
  });

  it('handles tag with no space after colon', () => {
    const input = 'msg [[reply_to_message_id:789]]';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, 'msg ');
  });

  it('handles tag with multiple spaces after colon', () => {
    const input = 'msg [[reply_to_message_id:   42]]';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, 'msg ');
  });

  it('does not match tag with non-digit id', () => {
    const input = 'msg [[reply_to_message_id: abc]]';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, input); // unchanged
  });

  it('does not match tag with wrong name', () => {
    const input = 'msg [[some_other_tag: 123]]';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, input); // unchanged
  });

  it('does not match single brackets', () => {
    const input = 'msg [reply_to_message_id: 123]';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, input); // unchanged
  });

  it('handles empty string', () => {
    const result = ''.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, '');
  });

  it('handles tag with large message id', () => {
    const input = '[[reply_to_message_id: 999999999999]]';
    const result = input.replace(GATEWAY_TAG_RE, '');
    assert.equal(result, '');
  });

  it('strips tag and its trailing whitespace only', () => {
    const input = 'a [[reply_to_message_id: 1]] b';
    const result = input.replace(GATEWAY_TAG_RE, '');
    // Tag + trailing space is removed, leaving "a b"
    assert.equal(result, 'a b');
  });

  it('regex g flag resets lastIndex between calls', () => {
    // Ensure the regex works correctly on successive calls
    const r = /\[\[reply_to_message_id:\s*\d+\]\]\s*/g;
    const a = 'x [[reply_to_message_id: 1]]'.replace(r, '');
    const b = 'y [[reply_to_message_id: 2]]'.replace(r, '');
    assert.equal(a, 'x ');
    assert.equal(b, 'y ');
  });
});
