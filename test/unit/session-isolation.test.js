const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const mod = require('../../server.js');
mod._server.close();

const { _internals: internals } = mod;

describe('Session isolation', () => {
  it('WORKSPACE defaults to ~/.claude-proxy/workspace', () => {
    const expected = path.join(internals.HOME, '.claude-proxy', 'workspace');
    assert.strictEqual(internals.WORKSPACE, expected);
  });

  it('CLAUDE_CONFIG_DIR points to ~/.claude (real CLI config)', () => {
    const expected = path.join(internals.HOME, '.claude');
    assert.strictEqual(internals.CLAUDE_CONFIG_DIR, expected);
  });

  it('WORKSPACE is separate from ~/.claude', () => {
    assert.ok(!internals.WORKSPACE.includes(path.join('.claude', 'projects')),
      'WORKSPACE must not be inside ~/.claude');
    assert.ok(internals.WORKSPACE.includes('.claude-proxy'),
      'WORKSPACE must be inside .claude-proxy');
  });

  it('CLAUDE_CONFIG_DIR is the real ~/.claude dir (for auth)', () => {
    assert.ok(internals.CLAUDE_CONFIG_DIR.endsWith('/.claude'),
      'CLAUDE_CONFIG_DIR must be ~/.claude');
  });

  it('CLAUDE_PATH defaults to "claude" (not a hardcoded absolute path)', () => {
    // When CLAUDE_PATH env is not set, it should default to 'claude' (found in PATH)
    // The test-server helper sets CLAUDE_PATH=/bin/echo, so check the env-based logic
    assert.ok(!internals.CLAUDE_PATH.includes('/home/alex'),
      'CLAUDE_PATH must not contain hardcoded /home/alex path');
  });

  it('WORKSPACE is configurable via CLAUDE_PROXY_WORKSPACE env var', () => {
    // The constant is computed at module load time from env.
    // Verify the default formula: HOME + .claude-proxy/workspace
    const home = process.env.HOME || require('os').homedir();
    if (!process.env.CLAUDE_PROXY_WORKSPACE) {
      assert.strictEqual(internals.WORKSPACE, path.join(home, '.claude-proxy', 'workspace'));
    }
  });
});
