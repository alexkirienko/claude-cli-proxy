const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../../server.js');
mod._server.close();

const { parseSender } = mod;

describe('parseSender', () => {
  it('extracts username from valid tag', () => {
    assert.equal(parseSender('Hello [from: Alex (@alex)]'), 'alex');
  });

  it('lowercases uppercase username', () => {
    assert.equal(parseSender('Hi [from: Bob (@BOB)]'), 'bob');
  });

  it('returns null when no tag present', () => {
    assert.equal(parseSender('Just a normal message'), null);
  });

  it('returns null when tag is not at end', () => {
    assert.equal(parseSender('[from: A (@a)] more text'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseSender(''), null);
  });

  it('handles underscore in username', () => {
    assert.equal(parseSender('msg [from: Name (@user_name)]'), 'user_name');
  });

  it('handles trailing whitespace after tag', () => {
    assert.equal(parseSender('msg [from: Name (@user)]  '), 'user');
  });
});
