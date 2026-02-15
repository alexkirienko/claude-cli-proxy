const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers/test-server');

describe('Timeout: constants', () => {
  let internals, close;

  before(async () => {
    ({ internals, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  it('IDLE_TIMEOUT_MS is 60 seconds', () => {
    assert.strictEqual(internals.IDLE_TIMEOUT_MS, 60000);
  });

  it('TOOL_IDLE_TIMEOUT_MS is 300 seconds (5 minutes)', () => {
    assert.strictEqual(internals.TOOL_IDLE_TIMEOUT_MS, 300000);
  });

  it('COMPACTION_TIMEOUT_MS is 600 seconds (10 minutes)', () => {
    assert.strictEqual(internals.COMPACTION_TIMEOUT_MS, 600000);
  });

  it('SESSION_TTL_MS is 3600 seconds (1 hour)', () => {
    assert.strictEqual(internals.SESSION_TTL_MS, 3600000);
  });

  it('TOOL_IDLE_TIMEOUT_MS is greater than IDLE_TIMEOUT_MS', () => {
    assert.ok(
      internals.TOOL_IDLE_TIMEOUT_MS > internals.IDLE_TIMEOUT_MS,
      'tool timeout should be longer than idle timeout'
    );
  });

  it('COMPACTION_TIMEOUT_MS is greater than TOOL_IDLE_TIMEOUT_MS', () => {
    assert.ok(
      internals.COMPACTION_TIMEOUT_MS > internals.TOOL_IDLE_TIMEOUT_MS,
      'compaction timeout should be the longest'
    );
  });
});
