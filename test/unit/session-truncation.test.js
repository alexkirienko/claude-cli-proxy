const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const mod = require('../../server.js');
mod._server.close();

const { truncateSessionForRegenerate } = mod;

// Helper to create temp JSONL for testing
let tmpDir;

function makeTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-truncation-test-'));
  return tmpDir;
}

function writeJsonl(filename, entries) {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return filePath;
}

// Build a simple 3-message session: system init, user msg, assistant response
function makeSimpleSession() {
  return [
    { uuid: 'aaa', type: 'system', message: { role: 'system', content: 'You are helpful' } },
    { uuid: 'bbb', parentUuid: 'aaa', type: 'user', message: { role: 'user', content: 'Hello' } },
    { uuid: 'ccc', parentUuid: 'bbb', type: 'assistant', message: { role: 'assistant', content: 'Hi there!' } },
    { uuid: 'ddd', parentUuid: 'ccc', type: 'user', message: { role: 'user', content: 'What is 2+2?' } },
    { uuid: 'eee', parentUuid: 'ddd', type: 'assistant', message: { role: 'assistant', content: 'It is 4.' } },
  ];
}

describe('truncateSessionForRegenerate', () => {
  beforeEach(() => {
    makeTmpDir();
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('removes last user turn and all descendants', () => {
    const entries = makeSimpleSession();
    const jsonlPath = writeJsonl('original.jsonl', entries);

    const newPath = truncateSessionForRegenerate(jsonlPath, 'new-uuid', tmpDir);
    assert.ok(newPath);

    const lines = fs.readFileSync(newPath, 'utf-8').split('\n').filter(Boolean);
    const kept = lines.map(l => JSON.parse(l));
    assert.equal(kept.length, 3); // system + first user + first assistant
    assert.deepEqual(kept.map(e => e.uuid), ['aaa', 'bbb', 'ccc']);
  });

  it('preserves original JSONL file', () => {
    const entries = makeSimpleSession();
    const jsonlPath = writeJsonl('original.jsonl', entries);
    const originalContent = fs.readFileSync(jsonlPath, 'utf-8');

    truncateSessionForRegenerate(jsonlPath, 'new-uuid', tmpDir);

    assert.equal(fs.readFileSync(jsonlPath, 'utf-8'), originalContent);
  });

  it('removes tool_result messages along with assistant response', () => {
    const entries = [
      { uuid: 'aaa', type: 'system', message: { role: 'system', content: 'init' } },
      { uuid: 'bbb', parentUuid: 'aaa', type: 'user', message: { role: 'user', content: 'Read file.txt' } },
      { uuid: 'ccc', parentUuid: 'bbb', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
      { uuid: 'ddd', parentUuid: 'ccc', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] } },
      { uuid: 'eee', parentUuid: 'ddd', type: 'assistant', message: { role: 'assistant', content: 'Done reading.' } },
      { uuid: 'fff', parentUuid: 'eee', type: 'user', message: { role: 'user', content: 'Now summarize' } },
      { uuid: 'ggg', parentUuid: 'fff', type: 'assistant', message: { role: 'assistant', content: 'Summary here.' } },
    ];
    const jsonlPath = writeJsonl('tool.jsonl', entries);

    const newPath = truncateSessionForRegenerate(jsonlPath, 'new-uuid', tmpDir);
    assert.ok(newPath);

    const kept = fs.readFileSync(newPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    // Should remove fff (last real user msg), ggg (descendant)
    assert.equal(kept.length, 5);
    assert.deepEqual(kept.map(e => e.uuid), ['aaa', 'bbb', 'ccc', 'ddd', 'eee']);
  });

  it('returns null when only one entry exists', () => {
    const entries = [
      { uuid: 'aaa', type: 'user', message: { role: 'user', content: 'Hello' } },
    ];
    const jsonlPath = writeJsonl('single.jsonl', entries);

    const result = truncateSessionForRegenerate(jsonlPath, 'new-uuid', tmpDir);
    assert.equal(result, null);
  });

  it('returns null when file does not exist', () => {
    const result = truncateSessionForRegenerate('/nonexistent/path.jsonl', 'new-uuid', tmpDir);
    assert.equal(result, null);
  });

  it('removes file-history-snapshot before the user message', () => {
    const entries = [
      { uuid: 'aaa', type: 'system', message: { role: 'system', content: 'init' } },
      { uuid: 'bbb', parentUuid: 'aaa', type: 'user', message: { role: 'user', content: 'Hello' } },
      { uuid: 'ccc', parentUuid: 'bbb', type: 'assistant', message: { role: 'assistant', content: 'Hi!' } },
      { uuid: 'ddd', parentUuid: 'ccc', type: 'file-history-snapshot' },
      { uuid: 'eee', parentUuid: 'ddd', type: 'user', message: { role: 'user', content: 'Redo this' } },
      { uuid: 'fff', parentUuid: 'eee', type: 'assistant', message: { role: 'assistant', content: 'Done.' } },
    ];
    const jsonlPath = writeJsonl('snapshot.jsonl', entries);

    const newPath = truncateSessionForRegenerate(jsonlPath, 'new-uuid', tmpDir);
    const kept = fs.readFileSync(newPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    // Should remove ddd (snapshot), eee (user), fff (descendant)
    assert.equal(kept.length, 3);
    assert.deepEqual(kept.map(e => e.uuid), ['aaa', 'bbb', 'ccc']);
  });

  it('skips compact summaries when finding last user message', () => {
    const entries = [
      { uuid: 'aaa', type: 'system', message: { role: 'system', content: 'init' } },
      { uuid: 'bbb', parentUuid: 'aaa', type: 'user', message: { role: 'user', content: 'Hello' } },
      { uuid: 'ccc', parentUuid: 'bbb', type: 'assistant', message: { role: 'assistant', content: 'Hi!' } },
      { uuid: 'ddd', parentUuid: 'ccc', type: 'user', message: { role: 'user', content: 'Compacted' }, isCompactSummary: true },
    ];
    const jsonlPath = writeJsonl('compact.jsonl', entries);

    const newPath = truncateSessionForRegenerate(jsonlPath, 'new-uuid', tmpDir);
    const kept = fs.readFileSync(newPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    // Should remove bbb (actual last user msg) and ccc+ddd (descendants)
    assert.equal(kept.length, 1);
    assert.deepEqual(kept.map(e => e.uuid), ['aaa']);
  });

  it('writes truncated JSONL to new UUID path', () => {
    const entries = makeSimpleSession();
    const jsonlPath = writeJsonl('original.jsonl', entries);

    const newPath = truncateSessionForRegenerate(jsonlPath, 'my-new-uuid', tmpDir);
    assert.ok(newPath);
    assert.ok(newPath.includes('my-new-uuid'));
    assert.ok(fs.existsSync(newPath));
  });
});
