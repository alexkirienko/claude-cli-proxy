const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

  // Set env before require — use isolated temp workspace so tests never touch production sessions.
  // Nest workspace one level deep so SESSIONS_FILE (derived from dirname(WORKSPACE)) is also isolated.
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-test-'));
  const tmpWorkspace = path.join(tmpBase, 'workspace');
  fs.mkdirSync(tmpWorkspace, { recursive: true });
  process.env.CLAUDE_PROXY_PORT = String(port);
  process.env.CLAUDE_PATH = '/bin/echo';
  process.env.CLAUDE_PROXY_WORKSPACE = tmpWorkspace;

  // Clear module cache so each test file gets a fresh server
  const serverPath = path.resolve(__dirname, '../../server.js');
  delete require.cache[serverPath];

  const mod = require(serverPath);

  // Start listening
  await new Promise((resolve) => {
    mod._server.listen(port, '127.0.0.1', resolve);
  });

  // Shorten early-exit race for tests so mock "real" spawns (closeDelay ~50ms) survive it
  mod._internals.EARLY_EXIT_RACE_MS = 20;

  // Track stub JSONL files created during this test run for cleanup
  const createdStubs = new Set();

  // Patch sessions.set to auto-create stub JSONL files — simulates real CLI behavior
  // where each session has a corresponding JSONL file on disk.
  const origSet = mod._internals.sessions.set.bind(mod._internals.sessions);
  mod._internals.sessions.set = function(key, value) {
    origSet(key, value);
    if (value && value.uuid) {
      const file = createSessionJsonl(mod._internals, value.uuid);
      createdStubs.add(file);
    }
  };

  // Patch sessions.delete to also remove stub JSONL files — prevents cross-test leakage.
  // Only deletes the file if no other session entry still uses the same UUID (preserves
  // JSONL during migrations where the UUID moves from old key to new key).
  const origDelete = mod._internals.sessions.delete.bind(mod._internals.sessions);
  mod._internals.sessions.delete = function(key) {
    const entry = mod._internals.sessions.get(key);
    const result = origDelete(key);
    if (entry && entry.uuid) {
      let uuidStillUsed = false;
      for (const [, v] of mod._internals.sessions) {
        if (v.uuid === entry.uuid) { uuidStillUsed = true; break; }
      }
      if (!uuidStillUsed) {
        const cwdSlug = mod._internals.WORKSPACE.replace(/[/.]/g, '-');
        const file = path.join(mod._internals.CLAUDE_CONFIG_DIR, 'projects', cwdSlug, `${entry.uuid}.jsonl`);
        try { fs.unlinkSync(file); } catch {}
        try { fs.unlinkSync(file + '.rotated'); } catch {}
        createdStubs.delete(file);
      }
    }
    return result;
  };

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server: mod._server,
    internals: mod._internals,
    mod,
    close() {
      return new Promise((resolve) => {
        // Clean up stub JSONL files created during this test run
        for (const file of createdStubs) {
          try { fs.unlinkSync(file); } catch {}
          // Also clean .rotated variants (created by health rotation)
          try { fs.unlinkSync(file + '.rotated'); } catch {}
        }
        createdStubs.clear();

        // Remove temp base dir (includes workspace + sessions.json) to avoid leaking test artifacts
        try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
        delete process.env.CLAUDE_PROXY_WORKSPACE;

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

/**
 * Create a stub JSONL file for a session UUID so that resume checks pass.
 * In production, the real CLI creates these files; in tests, mock CLIs don't.
 */
function createSessionJsonl(internals, uuid) {
  const cwdSlug = internals.WORKSPACE.replace(/[/.]/g, '-');
  const dir = path.join(internals.CLAUDE_CONFIG_DIR, 'projects', cwdSlug);
  const file = path.join(dir, `${uuid}.jsonl`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'test stub' } }) + '\n');
  }
  return file;
}

module.exports = { startTestServer, request, createSessionJsonl };
