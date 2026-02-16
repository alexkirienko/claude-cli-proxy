const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestServer, request } = require('../helpers/test-server');

describe('Deploy webhook', () => {
  let url, close;

  before(async () => {
    // Set a known deploy secret for testing
    process.env.DEPLOY_WEBHOOK_SECRET = 'test-secret-123';
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    delete process.env.DEPLOY_WEBHOOK_SECRET;
    await close();
  });

  it('returns 401 for missing signature header (no crash from timingSafeEqual)', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const res = await request(`${url}/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'push',
        // No x-hub-signature-256 header
      },
      body,
    });

    assert.equal(res.status, 401);
    assert.ok(res.json?.error, 'has error field');
    assert.match(res.json.error, /invalid signature/i);
  });

  it('returns 401 for truncated signature', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const res = await request(`${url}/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=abc',
      },
      body,
    });

    assert.equal(res.status, 401);
    assert.ok(res.json?.error);
  });

  it('returns 401 for wrong signature', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const wrongSig = 'sha256=' + crypto.createHmac('sha256', 'wrong-secret').update(body).digest('hex');
    const res = await request(`${url}/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': wrongSig,
      },
      body,
    });

    assert.equal(res.status, 401);
  });

  it('returns 200 for valid signature on push to main', async () => {
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      head_commit: { message: 'test commit' },
    });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'test-secret-123').update(body).digest('hex');
    const res = await request(`${url}/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': sig,
      },
      body,
    });

    // Will fail on missing update.sh but should pass signature check
    // and return 200 (responds before running update script)
    assert.equal(res.status, 200);
    assert.equal(res.json?.status, 'deploying');
  });

  it('skips deploy for non-main branch push', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/feature-branch' });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'test-secret-123').update(body).digest('hex');
    const res = await request(`${url}/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': sig,
      },
      body,
    });

    assert.equal(res.status, 200);
    assert.equal(res.json?.status, 'skipped');
  });
});
