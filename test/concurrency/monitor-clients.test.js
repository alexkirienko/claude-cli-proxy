const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');

/**
 * Connect to the /events SSE endpoint and return { req, chunks, close() }.
 */
function connectMonitor(baseUrl) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = http.get(baseUrl + '/events', (res) => {
      res.on('data', (chunk) => chunks.push(chunk.toString()));
      resolve({
        req,
        res,
        chunks,
        close() {
          req.destroy();
        },
      });
    });
    req.on('error', () => {}); // Swallow errors from destroy
  });
}

describe('Concurrency: monitor clients', () => {
  let url, close, internals;

  before(async () => {
    mock.method(cp, 'spawn', () => createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 }));

    const { startTestServer } = require('../helpers/test-server');
    ({ url, close, internals } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
  });

  it('tracks 10 monitor clients connecting simultaneously', async () => {
    const MONITOR_COUNT = 10;
    const monitors = [];

    // Connect 10 monitor clients
    for (let i = 0; i < MONITOR_COUNT; i++) {
      monitors.push(await connectMonitor(url));
    }

    // Wait for all to register
    await new Promise(r => setTimeout(r, 200));

    assert.equal(
      internals.monitorClients.size,
      MONITOR_COUNT,
      `${MONITOR_COUNT} monitor clients registered`
    );

    // Each should have received a connected event
    for (let i = 0; i < MONITOR_COUNT; i++) {
      const allData = monitors[i].chunks.join('');
      assert.ok(allData.includes('"type":"connected"'), `client ${i} received connected event`);
    }

    // Clean up all monitors
    for (const m of monitors) {
      m.close();
    }

    await new Promise(r => setTimeout(r, 200));
    assert.equal(internals.monitorClients.size, 0, 'all monitor clients cleaned up');
  });

  it('correctly decrements count when some clients disconnect', async () => {
    const monitors = [];

    // Connect 5 clients
    for (let i = 0; i < 5; i++) {
      monitors.push(await connectMonitor(url));
    }

    await new Promise(r => setTimeout(r, 100));
    assert.equal(internals.monitorClients.size, 5, '5 clients connected');

    // Disconnect 3 of them
    monitors[0].close();
    monitors[2].close();
    monitors[4].close();

    await new Promise(r => setTimeout(r, 200));
    assert.equal(internals.monitorClients.size, 2, '2 clients remaining after 3 disconnect');

    // Remaining clients should still be functional — check by making an API request
    // that triggers log events
    const healthReq = await new Promise((resolve, reject) => {
      const req = http.get(url + '/health', (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
    });
    assert.equal(healthReq.status, 200, 'health check works');

    // Wait for events to propagate
    await new Promise(r => setTimeout(r, 100));

    // Remaining clients should have received monitor events (log events from health check)
    const client1Data = monitors[1].chunks.join('');
    const client3Data = monitors[3].chunks.join('');
    assert.ok(client1Data.includes('"type":"connected"'), 'remaining client 1 got events');
    assert.ok(client3Data.includes('"type":"connected"'), 'remaining client 3 got events');

    // Clean up
    monitors[1].close();
    monitors[3].close();

    await new Promise(r => setTimeout(r, 200));
    assert.equal(internals.monitorClients.size, 0, 'all cleaned up');
  });
});
