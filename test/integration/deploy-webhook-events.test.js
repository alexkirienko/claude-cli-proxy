const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestServer, request } = require('../helpers/test-server');

describe('Deploy webhook: non-push events', () => {
  let url, close;

  before(async () => {
    process.env.DEPLOY_WEBHOOK_SECRET = 'test-secret-123';
    ({ url, close } = await startTestServer());
  });

  after(async () => {
    delete process.env.DEPLOY_WEBHOOK_SECRET;
    await close();
  });

  function signedRequest(event, payload) {
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'test-secret-123').update(body).digest('hex');
    return request(`${url}/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': event,
        'x-hub-signature-256': sig,
      },
      body,
    });
  }

  it('skips deploy for ping event', async () => {
    const res = await signedRequest('ping', { zen: 'hello' });
    assert.equal(res.status, 200);
    assert.equal(res.json?.status, 'skipped');
    assert.match(res.json?.reason, /ping/);
  });

  it('skips deploy for issues event', async () => {
    const res = await signedRequest('issues', { action: 'opened' });
    assert.equal(res.status, 200);
    assert.equal(res.json?.status, 'skipped');
    assert.match(res.json?.reason, /issues/);
  });

  it('skips deploy for pull_request event', async () => {
    const res = await signedRequest('pull_request', { action: 'opened' });
    assert.equal(res.status, 200);
    assert.equal(res.json?.status, 'skipped');
  });

  it('still deploys for push to main', async () => {
    const res = await signedRequest('push', {
      ref: 'refs/heads/main',
      head_commit: { message: 'test' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json?.status, 'deploying');
  });
});
