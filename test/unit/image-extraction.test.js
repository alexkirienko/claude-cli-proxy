const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mod = require('../../server.js');
mod._server.close();

const { writeImagesToTmp } = mod;

// Minimal 1x1 red PNG (base64)
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// Minimal 1x1 JPEG (base64)
const TINY_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

describe('writeImagesToTmp', () => {
  it('returns empty array when no image blocks', () => {
    const blocks = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ];
    const result = writeImagesToTmp(blocks, 'test-req-1');
    assert.deepEqual(result, []);
  });

  it('writes a single base64 PNG image to disk', () => {
    const blocks = [
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
    ];
    const result = writeImagesToTmp(blocks, 'test-req-2');
    assert.equal(result.length, 1);
    assert.ok(result[0].endsWith('/image-1.png'));
    assert.ok(fs.existsSync(result[0]));

    // Verify file content matches decoded base64
    const written = fs.readFileSync(result[0]);
    const expected = Buffer.from(TINY_PNG, 'base64');
    assert.deepEqual(written, expected);

    // Cleanup
    fs.rmSync(path.dirname(result[0]), { recursive: true, force: true });
  });

  it('writes multiple images and returns all paths', () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
      { type: 'text', text: 'between' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: TINY_JPEG } },
    ];
    const result = writeImagesToTmp(blocks, 'test-req-3');
    assert.equal(result.length, 2);
    assert.ok(result[0].endsWith('/image-1.png'));
    assert.ok(result[1].endsWith('/image-2.jpeg'));
    assert.ok(fs.existsSync(result[0]));
    assert.ok(fs.existsSync(result[1]));

    // All files in same temp directory
    assert.equal(path.dirname(result[0]), path.dirname(result[1]));

    // Cleanup
    fs.rmSync(path.dirname(result[0]), { recursive: true, force: true });
  });

  it('skips image blocks with missing source.data', () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
      { type: 'image', source: { type: 'base64' } },
      { type: 'image', source: { type: 'base64', data: null } },
    ];
    const result = writeImagesToTmp(blocks, 'test-req-4');
    assert.deepEqual(result, []);
  });

  it('skips URL-type images (not supported)', () => {
    const blocks = [
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
    ];
    const result = writeImagesToTmp(blocks, 'test-req-5');
    assert.deepEqual(result, []);
  });

  it('defaults to .png extension when media_type is missing', () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', data: TINY_PNG } },
    ];
    const result = writeImagesToTmp(blocks, 'test-req-6');
    assert.equal(result.length, 1);
    assert.ok(result[0].endsWith('/image-1.png'));

    // Cleanup
    fs.rmSync(path.dirname(result[0]), { recursive: true, force: true });
  });

  it('creates temp directory under os.tmpdir()', () => {
    const os = require('os');
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
    ];
    const result = writeImagesToTmp(blocks, 'test-req-7');
    assert.ok(result[0].startsWith(os.tmpdir()));
    assert.ok(path.dirname(result[0]).includes('claude-proxy-img-'));

    // Cleanup
    fs.rmSync(path.dirname(result[0]), { recursive: true, force: true });
  });

  it('handles empty content blocks array', () => {
    const result = writeImagesToTmp([], 'test-req-8');
    assert.deepEqual(result, []);
  });
});
