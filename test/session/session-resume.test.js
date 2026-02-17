const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const { createMockChild } = require('../helpers/mock-child');

describe('Session: resume logic', () => {
  let url, close, internals;
  let spawnHandler;

  before(async () => {
    // Mock spawn BEFORE requiring server so the destructured reference is captured
    spawnHandler = () => createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
    mock.method(cp, 'spawn', (...args) => spawnHandler(...args));

    const { startTestServer } = require('../helpers/test-server');
    ({ url, close, internals } = await startTestServer());
  });

  after(async () => {
    mock.restoreAll();
    await close();
  });

  it('first request uses --session-id, second uses --resume', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = [];
    const spawnOpts = [];
    let spawnCount = 0;

    spawnHandler = (cmd, args, opts) => {
      spawnCount++;
      spawnArgs.push([...args]);
      spawnOpts.push(opts);
      if (spawnCount % 2 === 1) {
        // First spawn exits quickly -> triggers retry
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      // Second spawn (retry) - the real one
      const child = createMockChild({ autoClose: false });
      process.nextTick(() => {
        child.stdout.push(JSON.stringify({
          result: 'OK',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
        setTimeout(() => child.emit('close', 0), 50);
      });
      return child;
    };

    const body = {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };
    const headers = {
      'Content-Type': 'application/json',
      'x-session-key': 'test-resume-session',
    };

    // First request -- should use --session-id
    const res1 = await request(`${url}/v1/messages`, {
      method: 'POST',
      body,
      headers,
    });
    assert.equal(res1.status, 200, 'first request succeeds');

    // The retry spawn (spawnArgs[1]) is the real one for request 1
    const realArgs1 = spawnArgs[1];
    assert.ok(realArgs1, 'retry spawn args captured for first request');
    assert.ok(
      realArgs1.includes('--session-id'),
      'first request uses --session-id'
    );
    assert.ok(
      !realArgs1.includes('--resume'),
      'first request does not use --resume'
    );

    // Verify session was stored
    assert.ok(
      internals.sessions.has('test-resume-session'),
      'session stored after first request'
    );

    // Second request -- should use --resume
    const res2 = await request(`${url}/v1/messages`, {
      method: 'POST',
      body,
      headers,
    });
    assert.equal(res2.status, 200, 'second request succeeds');

    // The retry spawn (spawnArgs[3]) is the real one for request 2
    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2, 'retry spawn args captured for second request');
    assert.ok(
      realArgs2.includes('--resume'),
      'second request uses --resume'
    );
    assert.ok(
      !realArgs2.includes('--session-id'),
      'second request does not use --session-id'
    );

    // Verify CLAUDE_CONFIG_DIR is NOT overridden (CLI uses default ~/.claude for auth)
    const realOpts = spawnOpts[1]; // retry spawn opts
    assert.strictEqual(realOpts?.env?.CLAUDE_CONFIG_DIR, undefined,
      'CLAUDE_CONFIG_DIR must not be set (CLI uses ~/.claude for auth)');

    // Verify cwd uses WORKSPACE (not hardcoded path)
    assert.ok(realOpts.cwd,
      'cwd is set in spawn opts');
    assert.ok(!realOpts.cwd.includes('/home/alex/.openclaw'),
      'cwd does not use hardcoded /home/alex/.openclaw path');

    // Verify ANTHROPIC_API_KEY is removed
    assert.strictEqual(realOpts.env.ANTHROPIC_API_KEY, undefined,
      'ANTHROPIC_API_KEY is removed from spawn env');

    internals.sessions.delete('test-resume-session');
  });

  it('resumed session includes channel context in --append-system-prompt', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = [];
    let spawnCount = 0;

    spawnHandler = (cmd, args) => {
      spawnCount++;
      spawnArgs.push([...args]);
      if (spawnCount % 2 === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      const child = createMockChild({ autoClose: false });
      process.nextTick(() => {
        child.stdout.push(JSON.stringify({
          result: 'OK',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
        setTimeout(() => child.emit('close', 0), 50);
      });
      return child;
    };

    const sysPrompt = [
      'You are a helpful assistant.',
      '```json\n{"openclaw.inbound_meta.v1":{"chat_id":"telegram:12345","message_id":"99"}}\n```',
    ].join('\n');

    const body = {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      system: sysPrompt,
      stream: false,
    };

    // First request — establishes session
    const res1 = await request(`${url}/v1/messages`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res1.status, 200, 'first request succeeds');

    // Second request — resumed, should include channel context
    const res2 = await request(`${url}/v1/messages`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res2.status, 200, 'second request succeeds');

    // The retry spawn for request 2 is at index 3
    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2, 'retry spawn args captured for second request');
    assert.ok(realArgs2.includes('--resume'), 'second request uses --resume');

    const appendIdx = realArgs2.indexOf('--append-system-prompt');
    assert.ok(appendIdx !== -1, '--append-system-prompt is present');
    const appendValue = realArgs2[appendIdx + 1];
    assert.ok(appendValue.includes('telegram'), 'append-system-prompt contains channel name "telegram"');
    assert.ok(appendValue.includes('telegram:12345'), 'append-system-prompt contains full chat_id');
  });

  /**
   * Helper: set up spawnHandler that captures args via the two-spawn retry pattern.
   * First spawn exits quickly (triggers retry), second is the real one.
   */
  function captureSpawnArgs() {
    const spawnArgs = [];
    let spawnCount = 0;

    spawnHandler = (cmd, args) => {
      spawnCount++;
      spawnArgs.push([...args]);
      if (spawnCount % 2 === 1) {
        return createMockChild({ exitCode: 0, autoClose: true, closeDelay: 5 });
      }
      const child = createMockChild({ autoClose: false });
      process.nextTick(() => {
        child.stdout.push(JSON.stringify({
          result: 'OK',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
        setTimeout(() => child.emit('close', 0), 50);
      });
      return child;
    };

    return spawnArgs;
  }

  it('full metadata block is forwarded with label and code fence on resume', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    // Realistic WhatsApp-style metadata block with all dynamic fields
    const meta = {
      schema: 'openclaw.inbound_meta.v1',
      message_id: '42',
      message_id_full: 'wa:42@s.whatsapp.net',
      chat_id: 'whatsapp:491234567890',
      channel: 'whatsapp',
      provider: 'whatsapp',
      surface: 'whatsapp',
      chat_type: 'direct',
      reply_to_id: null,
      flags: {
        history_count: 3,
        has_reply_context: false,
        has_forwarded_context: false,
        has_thread_starter: false,
      },
    };
    const metaBlock = '```json\n' + JSON.stringify(meta, null, 2) + '\n```';
    const sysPrompt = 'You are a helpful WhatsApp bot.\n' + metaBlock;

    const body = {
      model: 'sonnet',
      system: sysPrompt,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };

    // First request — establishes session
    const res1 = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res1.status, 200, 'first request succeeds');

    // Second request — resumed
    const res2 = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res2.status, 200, 'second request succeeds');

    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2.includes('--resume'), 'second request uses --resume');

    const appendValue = realArgs2[realArgs2.indexOf('--append-system-prompt') + 1];

    // Must contain the "Current message context:" label
    assert.ok(appendValue.includes('Current message context:'),
      'append-system-prompt contains "Current message context:" label');

    // Must contain the opening and closing code fences
    assert.ok(appendValue.includes('```json\n'),
      'append-system-prompt contains opening ```json fence');
    assert.ok(appendValue.includes('\n```'),
      'append-system-prompt contains closing ``` fence');

    // Must contain the full JSON body — check key fields including dynamic ones
    assert.ok(appendValue.includes('"schema": "openclaw.inbound_meta.v1"'),
      'contains schema field');
    assert.ok(appendValue.includes('"chat_id": "whatsapp:491234567890"'),
      'contains chat_id field');
    assert.ok(appendValue.includes('"message_id_full": "wa:42@s.whatsapp.net"'),
      'contains message_id_full field');
    assert.ok(appendValue.includes('"history_count": 3'),
      'contains flags.history_count field');

    // Must also contain the base prompt reminder
    assert.ok(appendValue.includes('Remember: read CLAUDE.md'),
      'contains base prompt reminder');

    for (const [key] of internals.sessions) internals.sessions.delete(key);
  });

  it('falls back to chatId when no JSON code fence exists', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    // System prompt with bare chat_id (parseable by parseChatId) but no code fence
    const sysPrompt = 'You are a bot.\nconfig: {"chat_id": "telegram:12345", "channel": "telegram"}';

    const body = {
      model: 'sonnet',
      system: sysPrompt,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };

    const res1 = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res1.status, 200, 'first request succeeds');

    const res2 = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res2.status, 200, 'second request succeeds');

    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2.includes('--resume'), 'second request uses --resume');

    const appendValue = realArgs2[realArgs2.indexOf('--append-system-prompt') + 1];

    // Fallback path: "Current channel: telegram (telegram:12345)"
    assert.ok(appendValue.includes('Current channel: telegram (telegram:12345)'),
      'append-system-prompt contains fallback channel line');

    // Must NOT contain the metadata context label
    assert.ok(!appendValue.includes('Current message context:'),
      'append-system-prompt does not contain "Current message context:" (fallback path)');

    for (const [key] of internals.sessions) internals.sessions.delete(key);
  });

  it('no metadata and no chatId — base prompt only', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    // Plain system prompt with no identifiable metadata at all
    const sysPrompt = 'You are a generic assistant. Be helpful and concise.';

    const body = {
      model: 'sonnet',
      system: sysPrompt,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };

    const res1 = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res1.status, 200, 'first request succeeds');

    const res2 = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res2.status, 200, 'second request succeeds');

    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2.includes('--resume'), 'second request uses --resume');

    const appendValue = realArgs2[realArgs2.indexOf('--append-system-prompt') + 1];

    // Must contain the base prompt reminder
    assert.ok(appendValue.includes('Remember: read CLAUDE.md'),
      'append-system-prompt contains base prompt reminder');

    // Must NOT contain channel or metadata context
    assert.ok(!appendValue.includes('Current channel:'),
      'does not contain "Current channel:" (no chatId)');
    assert.ok(!appendValue.includes('Current message context:'),
      'does not contain "Current message context:" (no metadata block)');

    for (const [key] of internals.sessions) internals.sessions.delete(key);
  });

  it('cross-channel resume: Signal metadata forwarded on merged session', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    // Set up identity map: Signal → Telegram
    internals.identityMap['signal:aaa-bbb-ccc'] = 'telegram:19847781';

    function sysPromptForChannel(chatId) {
      const channel = chatId.startsWith('signal:') ? 'signal' : 'telegram';
      const meta = {
        schema: 'openclaw.inbound_meta.v1',
        message_id: channel === 'telegram' ? '10' : '20',
        chat_id: chatId,
        channel,
        provider: channel,
        surface: channel,
        chat_type: 'direct',
        flags: { history_count: 0 },
      };
      return `You are a bot.\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\``;
    }

    // First request from Telegram — establishes session
    const res1 = await request(`${url}/v1/messages`, {
      method: 'POST', headers,
      body: {
        model: 'sonnet',
        system: sysPromptForChannel('telegram:19847781'),
        messages: [{ role: 'user', content: 'Hello from Telegram' }],
        stream: false,
      },
    });
    assert.equal(res1.status, 200, 'telegram request succeeds');

    const realArgs1 = spawnArgs[1];
    assert.ok(realArgs1.includes('--session-id'), 'first request uses --session-id');
    const sessionUuid = realArgs1[realArgs1.indexOf('--session-id') + 1];

    // Second request from Signal (mapped → telegram:19847781) — should resume
    const res2 = await request(`${url}/v1/messages`, {
      method: 'POST', headers,
      body: {
        model: 'sonnet',
        system: sysPromptForChannel('signal:aaa-bbb-ccc'),
        messages: [{ role: 'user', content: 'Hello from Signal' }],
        stream: false,
      },
    });
    assert.equal(res2.status, 200, 'signal request succeeds');

    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2.includes('--resume'), 'signal request resumes the session');

    // Same session UUID
    const resumeUuid = realArgs2[realArgs2.indexOf('--resume') + 1];
    assert.equal(resumeUuid, sessionUuid, 'both channels share the same session UUID');

    // The append-system-prompt should contain Signal's metadata (not Telegram's)
    const appendValue = realArgs2[realArgs2.indexOf('--append-system-prompt') + 1];
    assert.ok(appendValue.includes('Current message context:'),
      'append-system-prompt contains "Current message context:" label');
    assert.ok(appendValue.includes('"channel": "signal"'),
      'metadata block contains signal channel (not telegram)');
    assert.ok(appendValue.includes('"chat_id": "signal:aaa-bbb-ccc"'),
      'metadata block contains signal chat_id');
    assert.ok(!appendValue.includes('"channel": "telegram"'),
      'metadata block does not contain telegram channel');

    // Cleanup
    delete internals.identityMap['signal:aaa-bbb-ccc'];
    for (const [key] of internals.sessions) internals.sessions.delete(key);
  });

  it('realistic metadata format with schema field is forwarded correctly on resume', async () => {
    const { request } = require('../helpers/test-server');
    const spawnArgs = captureSpawnArgs();
    const headers = { 'Content-Type': 'application/json' };

    // Realistic format: {"schema": "openclaw.inbound_meta.v1", ...} (not wrapper-key style)
    const meta = {
      schema: 'openclaw.inbound_meta.v1',
      message_id: '55',
      chat_id: 'telegram:19847781',
      channel: 'telegram',
      provider: 'telegram',
      surface: 'telegram',
      chat_type: 'direct',
      flags: { history_count: 2, has_reply_context: true },
    };
    const sysPrompt = `You are a helpful bot.\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\``;

    const body = {
      model: 'sonnet',
      system: sysPrompt,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };

    const res1 = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res1.status, 200, 'first request succeeds');

    const res2 = await request(`${url}/v1/messages`, { method: 'POST', body, headers });
    assert.equal(res2.status, 200, 'second request succeeds');

    const realArgs2 = spawnArgs[3];
    assert.ok(realArgs2.includes('--resume'), 'second request uses --resume');

    const appendValue = realArgs2[realArgs2.indexOf('--append-system-prompt') + 1];

    // Must have the "Current message context:" label and code fence
    assert.ok(appendValue.includes('Current message context:'),
      'contains "Current message context:" label');
    assert.ok(appendValue.includes('```json\n'),
      'contains opening ```json fence');
    assert.ok(appendValue.includes('\n```'),
      'contains closing ``` fence');

    // Verify the actual metadata content is forwarded
    assert.ok(appendValue.includes('"schema": "openclaw.inbound_meta.v1"'),
      'contains schema field');
    assert.ok(appendValue.includes('"chat_id": "telegram:19847781"'),
      'contains chat_id');
    assert.ok(appendValue.includes('"has_reply_context": true'),
      'contains flags field');

    for (const [key] of internals.sessions) internals.sessions.delete(key);
  });
});
