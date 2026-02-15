const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');

describe('POST /v1/messages with image content', () => {
  let url, close;
  let spawnHandler;
  let lastStdinData;

  before(async () => {
    // Capture stdin data written to the mock child to verify image paths in prompt
    spawnHandler = () => {
      const child = createMockChild({ autoClose: false });
      lastStdinData = '';
      child.stdin.on('data', (d) => { lastStdinData += d; });
      // spawnWithRetry sends an early-exit probe for 3s; first spawn must stay alive
      // then second spawn handles the real request. Alternate behavior:
      let callCount = 0;
      return child;
    };
    // Use a counter-based handler to handle spawnWithRetry's probe/real spawns
    let callCount = 0;
    spawnHandler = () => {
      callCount++;
      if (callCount % 2 === 1) {
        // First spawn in spawnWithRetry: stay alive past 3s probe
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      // Second spawn: capture stdin and return result
      const child = createMockChild({ autoClose: false });
      lastStdinData = '';
      child.stdin.on('data', (d) => { lastStdinData += d; });
      process.nextTick(() => {
        child.stdout.push(JSON.stringify({
          result: 'I see an image.',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
        setTimeout(() => child.emit('close', 0), 50);
      });
      return child;
    };

    mock.method(cp, 'spawn', (...args) => spawnHandler(...args));

    const { startTestServer } = require('../helpers/test-server');
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
  });

  // Minimal 1x1 red PNG (base64)
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

  it('includes image file path in prompt sent to CLI', async () => {
    const { request } = require('../helpers/test-server');
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'sonnet',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
          ]
        }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    // Prompt should contain original text + image file path
    assert.ok(lastStdinData.includes('What is in this image?'), 'prompt includes text');
    assert.ok(lastStdinData.includes('claude-proxy-img-'), 'prompt includes temp image path');
    assert.ok(lastStdinData.includes('image-1.png'), 'prompt includes image filename');
  });

  it('handles text-only content without adding image paths', async () => {
    const { request } = require('../helpers/test-server');
    const res = await request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'sonnet',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'No images here' },
          ]
        }],
        stream: false,
      },
    });

    assert.equal(res.status, 200);
    assert.ok(lastStdinData.includes('No images here'), 'prompt includes text');
    assert.ok(!lastStdinData.includes('claude-proxy-img-'), 'no image path in text-only prompt');
  });

  it('health endpoint reports images feature', async () => {
    const { request } = require('../helpers/test-server');
    const res = await request(`${url}/health`);
    assert.equal(res.status, 200);
    assert.ok(res.json.features.includes('images'), 'features should include "images"');
  });

  it('health endpoint reports regenerate feature', async () => {
    const { request } = require('../helpers/test-server');
    const res = await request(`${url}/health`);
    assert.equal(res.status, 200);
    assert.ok(res.json.features.includes('regenerate'), 'features should include "regenerate"');
  });
});
