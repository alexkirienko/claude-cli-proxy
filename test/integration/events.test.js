const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startTestServer, request } = require('../helpers/test-server');
const { parseSSE } = require('../helpers/sse-parser');

describe('GET /events', () => {
  let url, close, internals;

  before(async () => {
    ({ url, close, internals } = await startTestServer());
  });

  after(async () => {
    await close();
  });

  it('returns SSE stream with connected event', async () => {
    const result = await new Promise((resolve, reject) => {
      http.get(`${url}/events`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          // Got first event, close connection
          if (data.includes('\n\n')) {
            res.destroy();
            resolve({ status: res.statusCode, headers: res.headers, data });
          }
        });
        res.on('error', () => {}); // Ignore destroy error
      }).on('error', reject);
    });

    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /text\/event-stream/);

    const events = parseSSE(result.data);
    assert.ok(events.length >= 1);

    const connected = events[0].data;
    assert.equal(connected.type, 'connected');
    assert.equal(typeof connected.timestamp, 'string');
  });

  it('monitorClients count decreases after disconnect', async () => {
    // Connect a monitor client
    const clientDone = new Promise((resolve, reject) => {
      http.get(`${url}/events`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.includes('\n\n')) {
            // Verify count went up
            const countDuring = internals.monitorClients.size;
            assert.ok(countDuring >= 1, 'should have at least 1 monitor client');
            // Disconnect
            res.destroy();
            // Allow time for close event to propagate
            setTimeout(() => {
              resolve(countDuring);
            }, 50);
          }
        });
        res.on('error', () => {}); // Ignore destroy error
      }).on('error', reject);
    });

    const countDuring = await clientDone;
    // After disconnect, count should have decreased
    assert.ok(
      internals.monitorClients.size < countDuring,
      `monitorClients should decrease after disconnect (was ${countDuring}, now ${internals.monitorClients.size})`
    );
  });
});
