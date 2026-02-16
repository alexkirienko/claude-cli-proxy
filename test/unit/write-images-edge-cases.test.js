const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mod = require('../../server.js');
mod._server.close();

const { writeImagesToTmp } = mod;

// Minimal 1x1 red PNG (base64)
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

describe('writeImagesToTmp edge cases', () => {
  it('handles image/webp media type', () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: TINY_PNG } },
    ];
    const result = writeImagesToTmp(blocks, 'test-webp');
    assert.equal(result.length, 1);
    assert.ok(result[0].endsWith('/image-1.webp'));
    assert.ok(fs.existsSync(result[0]));

    fs.rmSync(path.dirname(result[0]), { recursive: true, force: true });
  });

  it('handles image/svg+xml media type', () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: TINY_PNG } },
    ];
    const result = writeImagesToTmp(blocks, 'test-svg');
    assert.equal(result.length, 1);
    // "svg+xml" → "svg" (strip structured syntax suffix)
    assert.ok(result[0].endsWith('/image-1.svg'));

    fs.rmSync(path.dirname(result[0]), { recursive: true, force: true });
  });

  it('handles media_type without slash (defaults extension to png)', () => {
    // media_type = 'png' → split('/') = ['png'] → [1] = undefined → fallback 'png'
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'png', data: TINY_PNG } },
    ];
    const result = writeImagesToTmp(blocks, 'test-noslash');
    assert.equal(result.length, 1);
    assert.ok(result[0].endsWith('/image-1.png'));

    fs.rmSync(path.dirname(result[0]), { recursive: true, force: true });
  });

  it('skips image blocks where source.type is not base64', () => {
    const blocks = [
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.png', data: TINY_PNG } },
      { type: 'image', source: { type: 'file', data: TINY_PNG } },
    ];
    const result = writeImagesToTmp(blocks, 'test-nonbase64');
    assert.deepEqual(result, []);
  });

  it('skips image blocks with empty string data', () => {
    // Empty string is falsy → filtered out by c.source?.data check
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
    ];
    const result = writeImagesToTmp(blocks, 'test-emptydata');
    assert.deepEqual(result, []);
  });

  it('skips non-image blocks mixed with valid images', () => {
    const blocks = [
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
      { type: 'tool_use', id: 'x', name: 'test', input: {} },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: TINY_PNG } },
    ];
    const result = writeImagesToTmp(blocks, 'test-mixed');
    assert.equal(result.length, 2);
    assert.ok(result[0].endsWith('/image-1.png'));
    assert.ok(result[1].endsWith('/image-2.jpeg'));

    fs.rmSync(path.dirname(result[0]), { recursive: true, force: true });
  });

  it('handles image with source but missing source.type entirely', () => {
    const blocks = [
      { type: 'image', source: { media_type: 'image/png', data: TINY_PNG } },
    ];
    // source.type is undefined, not 'base64' → filtered out
    const result = writeImagesToTmp(blocks, 'test-notype');
    assert.deepEqual(result, []);
  });

  it('handles image with no source at all', () => {
    const blocks = [
      { type: 'image' },
    ];
    // c.source?.type → undefined, filtered out
    const result = writeImagesToTmp(blocks, 'test-nosource');
    assert.deepEqual(result, []);
  });

  it('numbering is sequential across only valid images', () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
      { type: 'image', source: { type: 'url', url: 'http://x.com/a.png' } }, // skipped
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
    ];
    const result = writeImagesToTmp(blocks, 'test-numbering');
    assert.equal(result.length, 2);
    // Valid images are filtered first, then numbered 1, 2
    assert.ok(result[0].endsWith('/image-1.png'));
    assert.ok(result[1].endsWith('/image-2.png'));

    fs.rmSync(path.dirname(result[0]), { recursive: true, force: true });
  });

  it('each call creates a unique temp directory', () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
    ];
    const result1 = writeImagesToTmp(blocks, 'test-unique-1');
    const result2 = writeImagesToTmp(blocks, 'test-unique-2');

    assert.notEqual(path.dirname(result1[0]), path.dirname(result2[0]));

    fs.rmSync(path.dirname(result1[0]), { recursive: true, force: true });
    fs.rmSync(path.dirname(result2[0]), { recursive: true, force: true });
  });
});
