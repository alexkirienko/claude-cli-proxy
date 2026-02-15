const net = require('net');
const path = require('path');

/**
 * Start the server on a random available port for integration testing.
 * Returns { url, server, close(), internals }.
 */
async function startTestServer() {
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

  // Set env before require
  process.env.CLAUDE_PROXY_PORT = String(port);
  process.env.CLAUDE_PATH = '/bin/echo';

  // Clear module cache so each test file gets a fresh server
  const serverPath = path.resolve(__dirname, '../../server.js');
  delete require.cache[serverPath];

  const mod = require(serverPath);

  // Start listening
  await new Promise((resolve) => {
    mod._server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server: mod._server,
    internals: mod._internals,
    mod,
    close() {
      return new Promise((resolve) => {
        mod._server.close(resolve);
        delete require.cache[serverPath];
      });
    }
  };
}

/**
 * Make an HTTP request and collect the response.
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<{ status, headers, body, json }>}
 */
async function request(url, options = {}) {
  const http = require('http');
  const { method = 'GET', body, headers = {} } = options;

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

module.exports = { startTestServer, request };
