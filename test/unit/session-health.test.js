const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const mod = require('../../server.js');
mod._server.close();

const { readTailLines, checkSessionHealth, findRecoveryContext, extractRecoveryContext, _internals } = mod;

// Helper: create a temp JSONL file with given lines
function writeTmpJsonl(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-health-'));
  const file = path.join(dir, 'test.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { dir, file };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// -- readTailLines --

describe('readTailLines', () => {
  let dir, file;
  afterEach(() => { if (dir) cleanup(dir); });

  it('returns all lines from a small file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'));
    file = path.join(dir, 'small.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const lines = readTailLines(file, 65536);
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '{"a":1}');
    assert.equal(lines[2], '{"c":3}');
  });

  it('drops partial first line when file exceeds maxBytes', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'));
    file = path.join(dir, 'big.jsonl');
    // Write a long first line + a short second line
    const longLine = '{"data":"' + 'x'.repeat(200) + '"}';
    const shortLine = '{"short":true}';
    fs.writeFileSync(file, longLine + '\n' + shortLine + '\n');
    // Read with maxBytes smaller than total size so we clip into the first line
    const lines = readTailLines(file, 50);
    // Should only have the short line (partial first line dropped)
    assert.equal(lines.length, 1);
    assert.equal(lines[0], shortLine);
  });

  it('returns empty array for missing file', () => {
    const lines = readTailLines('/tmp/nonexistent-session-health-test.jsonl');
    assert.deepEqual(lines, []);
  });

  it('returns empty array for empty file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'));
    file = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    assert.deepEqual(readTailLines(file), []);
  });
});

// -- checkSessionHealth --

describe('checkSessionHealth', () => {
  let dir, file;
  afterEach(() => { if (dir) cleanup(dir); });

  it('returns healthy for missing file', () => {
    const result = checkSessionHealth('/tmp/nonexistent-session-health-check.jsonl');
    assert.equal(result.healthy, true);
  });

  it('returns healthy when last assistant message has text (no tool_use)', () => {
    const tmp = writeTmpJsonl([
      { type: 'user', message: { content: 'Hello' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi there!' }] } },
    ]);
    dir = tmp.dir; file = tmp.file;
    assert.equal(checkSessionHealth(file).healthy, true);
  });

  it('returns healthy for safe tool_use (not matching patterns)', () => {
    const tmp = writeTmpJsonl([
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'Let me check...' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      ] } },
    ]);
    dir = tmp.dir; file = tmp.file;
    assert.equal(checkSessionHealth(file).healthy, true);
  });

  it('detects dangerous "openclaw gateway restart" pattern', () => {
    const tmp = writeTmpJsonl([
      { type: 'user', message: { content: 'restart the gateway' } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'Restarting...' },
        { type: 'tool_use', name: 'Bash', input: { command: 'openclaw gateway restart' } },
      ] } },
    ]);
    dir = tmp.dir; file = tmp.file;
    const result = checkSessionHealth(file);
    assert.equal(result.healthy, false);
    assert.ok(result.reason.includes('Bash'));
    assert.ok(result.inputPreview.includes('openclaw gateway restart'));
  });

  it('detects systemctl restart claude-cli-proxy', () => {
    const tmp = writeTmpJsonl([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'systemctl --user restart claude-cli-proxy' } },
      ] } },
    ]);
    dir = tmp.dir; file = tmp.file;
    assert.equal(checkSessionHealth(file).healthy, false);
  });

  it('detects systemctl stop openclaw', () => {
    const tmp = writeTmpJsonl([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'systemctl --user stop openclaw' } },
      ] } },
    ]);
    dir = tmp.dir; file = tmp.file;
    assert.equal(checkSessionHealth(file).healthy, false);
  });

  it('detects pkill openclaw', () => {
    const tmp = writeTmpJsonl([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'pkill -f openclaw' } },
      ] } },
    ]);
    dir = tmp.dir; file = tmp.file;
    assert.equal(checkSessionHealth(file).healthy, false);
  });

  it('detects rm -rf on .claude directory', () => {
    const tmp = writeTmpJsonl([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /home/alex/.claude' } },
      ] } },
    ]);
    dir = tmp.dir; file = tmp.file;
    assert.equal(checkSessionHealth(file).healthy, false);
  });

  it('returns healthy when tool_use is not the last block', () => {
    const tmp = writeTmpJsonl([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'openclaw gateway restart' } },
        { type: 'text', text: 'Done, gateway restarted.' },
      ] } },
    ]);
    dir = tmp.dir; file = tmp.file;
    // tool_use is NOT the last block — text follows — so it's healthy
    assert.equal(checkSessionHealth(file).healthy, true);
  });

  it('returns healthy when no assistant messages found', () => {
    const tmp = writeTmpJsonl([
      { type: 'user', message: { content: 'Hello' } },
      { type: 'user', message: { content: 'World' } },
    ]);
    dir = tmp.dir; file = tmp.file;
    assert.equal(checkSessionHealth(file).healthy, true);
  });

  it('handles string input in tool_use', () => {
    const tmp = writeTmpJsonl([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: 'systemctl restart openclaw-gateway' },
      ] } },
    ]);
    dir = tmp.dir; file = tmp.file;
    assert.equal(checkSessionHealth(file).healthy, false);
  });

  it('handles malformed JSON lines gracefully', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
    file = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(file, 'not json\n{"type":"assistant"invalid\n');
    // Should not throw, returns healthy (safe default)
    assert.equal(checkSessionHealth(file).healthy, true);
  });
});

describe('DANGEROUS_TOOL_PATTERNS', () => {
  it('is exposed via _internals', () => {
    assert.ok(Array.isArray(_internals.DANGEROUS_TOOL_PATTERNS));
    assert.ok(_internals.DANGEROUS_TOOL_PATTERNS.length >= 5);
  });
});

// -- findRecoveryContext --

// Helper: write a JSONL file with given name into a directory
function writeNamedJsonl(dir, name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('findRecoveryContext', () => {
  let dir;
  afterEach(() => { if (dir) cleanup(dir); });

  it('returns null for empty directory', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-recovery-'));
    assert.equal(findRecoveryContext(dir, 'telegram:123'), null);
  });

  it('returns null for nonexistent directory', () => {
    assert.equal(findRecoveryContext('/tmp/nonexistent-find-recovery-dir', 'telegram:123'), null);
  });

  it('finds context from file matching identity (chat_id)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-recovery-'));
    // File with matching identity
    writeNamedJsonl(dir, 'matching.jsonl', [
      { type: 'user', message: { content: 'System prompt with "chat_id": "telegram:19847781"' } },
      { type: 'user', message: { content: 'Hello from the user' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello! How can I help?' }] } },
    ]);
    // File without matching identity
    writeNamedJsonl(dir, 'other.jsonl', [
      { type: 'user', message: { content: 'Different user' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi other user' }] } },
    ]);

    const ctx = findRecoveryContext(dir, 'telegram:19847781');
    assert.ok(ctx !== null);
    assert.ok(ctx.includes('Hello from the user') || ctx.includes('Hello! How can I help?'));
  });

  it('falls back to most recent file when no identity match', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-recovery-'));
    // Older file
    const olderFile = writeNamedJsonl(dir, 'older.jsonl', [
      { type: 'user', message: { content: 'Old conversation' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Old reply' }] } },
    ]);
    // Make it older
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(olderFile, past, past);

    // Newer file
    writeNamedJsonl(dir, 'newer.jsonl', [
      { type: 'user', message: { content: 'Recent conversation' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Recent reply' }] } },
    ]);

    const ctx = findRecoveryContext(dir, 'telegram:nonexistent');
    assert.ok(ctx !== null);
    // Should get context from the newer file
    assert.ok(ctx.includes('Recent'));
  });

  it('falls back to most recent file when identity is null', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-recovery-'));
    writeNamedJsonl(dir, 'session.jsonl', [
      { type: 'user', message: { content: 'Some conversation' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Some reply' }] } },
    ]);

    const ctx = findRecoveryContext(dir, null);
    assert.ok(ctx !== null);
  });

  it('skips .rotated files', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-recovery-'));
    // Only a .rotated file exists
    writeNamedJsonl(dir, 'session.jsonl.rotated', [
      { type: 'user', message: { content: 'Rotated conversation' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Rotated reply' }] } },
    ]);

    assert.equal(findRecoveryContext(dir, null), null);
  });

  it('prefers identity-matching file over more recent non-matching file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-recovery-'));
    // Older file WITH matching identity
    const matchFile = writeNamedJsonl(dir, 'aaa-match.jsonl', [
      { type: 'user', message: { content: 'Has "chat_id": "telegram:555" in system' } },
      { type: 'user', message: { content: 'Identity user message' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Identity reply' }] } },
    ]);
    const past = new Date(Date.now() - 120000);
    fs.utimesSync(matchFile, past, past);

    // Newer file WITHOUT matching identity
    writeNamedJsonl(dir, 'zzz-recent.jsonl', [
      { type: 'user', message: { content: 'Different user recent' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Different reply' }] } },
    ]);

    const ctx = findRecoveryContext(dir, 'telegram:555');
    assert.ok(ctx !== null);
    assert.ok(ctx.includes('Identity'));
  });

  it('prefers compact summary from matching file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-recovery-'));
    writeNamedJsonl(dir, 'with-summary.jsonl', [
      { type: 'user', message: { content: 'System with "chat_id": "telegram:777"' } },
      { type: 'user', message: { content: 'This session is being continued from a previous conversation summary.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Continuing...' }] } },
    ]);

    const ctx = findRecoveryContext(dir, 'telegram:777');
    assert.ok(ctx !== null);
    assert.ok(ctx.startsWith('This session is being continued'));
  });
});
