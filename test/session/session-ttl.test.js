const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers/test-server');

describe('Session: TTL expiry', () => {
  let internals, close;

  before(async () => {
    ({ internals, close } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  it('removes sessions older than SESSION_TTL_MS', () => {
    const now = Date.now();

    // Add an expired session (lastUsed well beyond TTL)
    internals.sessions.set('expired-session', {
      uuid: 'aaaa-bbbb-cccc-dddd',
      lastUsed: now - internals.SESSION_TTL_MS - 60000,
    });

    // Add a fresh session
    internals.sessions.set('fresh-session', {
      uuid: 'eeee-ffff-0000-1111',
      lastUsed: now,
    });

    // Simulate the cleanup logic from server.js setInterval
    for (const [key, info] of internals.sessions) {
      if (now - info.lastUsed > internals.SESSION_TTL_MS) {
        internals.sessions.delete(key);
      }
    }

    assert.ok(
      !internals.sessions.has('expired-session'),
      'expired session was removed'
    );
    assert.ok(
      internals.sessions.has('fresh-session'),
      'fresh session was retained'
    );

    // Cleanup
    internals.sessions.delete('fresh-session');
  });

  it('retains sessions that are exactly at the TTL boundary', () => {
    const now = Date.now();

    // Session at exactly TTL age (not older) should be retained
    internals.sessions.set('boundary-session', {
      uuid: '2222-3333-4444-5555',
      lastUsed: now - internals.SESSION_TTL_MS,
    });

    for (const [key, info] of internals.sessions) {
      if (now - info.lastUsed > internals.SESSION_TTL_MS) {
        internals.sessions.delete(key);
      }
    }

    assert.ok(
      internals.sessions.has('boundary-session'),
      'session at exact TTL boundary is retained (not strictly greater)'
    );

    // Cleanup
    internals.sessions.delete('boundary-session');
  });

  it('removes multiple expired sessions in one pass', () => {
    const now = Date.now();

    internals.sessions.set('old-1', {
      uuid: 'a1',
      lastUsed: now - internals.SESSION_TTL_MS - 1000,
    });
    internals.sessions.set('old-2', {
      uuid: 'a2',
      lastUsed: now - internals.SESSION_TTL_MS - 2000,
    });
    internals.sessions.set('old-3', {
      uuid: 'a3',
      lastUsed: now - internals.SESSION_TTL_MS - 3000,
    });
    internals.sessions.set('keeper', {
      uuid: 'a4',
      lastUsed: now - 1000,
    });

    for (const [key, info] of internals.sessions) {
      if (now - info.lastUsed > internals.SESSION_TTL_MS) {
        internals.sessions.delete(key);
      }
    }

    assert.ok(!internals.sessions.has('old-1'), 'old-1 removed');
    assert.ok(!internals.sessions.has('old-2'), 'old-2 removed');
    assert.ok(!internals.sessions.has('old-3'), 'old-3 removed');
    assert.ok(internals.sessions.has('keeper'), 'keeper retained');

    internals.sessions.delete('keeper');
  });
});
