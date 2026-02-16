#!/usr/bin/env node
/**
 * E2E Session Continuity Test Suite
 *
 * Sends real HTTP requests to the running proxy and exercises real Claude CLI
 * to verify session continuity works end-to-end.
 *
 * Usage:
 *   node test/e2e/session-continuity.js
 *   npm run test:e2e
 *
 * Environment:
 *   PROXY_URL        - Proxy base URL (default: http://127.0.0.1:8787)
 *   MODEL            - Model to use (default: haiku)
 *   DURATION_MINUTES - How long to loop (default: 120)
 *   PAUSE_SECONDS    - Pause between scenarios (default: 5)
 */

const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// --- Config ---
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:8787';
const MODEL = process.env.MODEL || 'haiku';
const DURATION_MS = parseInt(process.env.DURATION_MINUTES || '120', 10) * 60 * 1000;
const PAUSE_MS = parseInt(process.env.PAUSE_SECONDS || '5', 10) * 1000;
const REQUEST_TIMEOUT_MS = 180_000; // 3 minutes per request
const HOME = os.homedir();
const WORKSPACE = process.env.CLAUDE_PROXY_WORKSPACE || path.join(HOME, '.claude-proxy', 'workspace');
const CWD_SLUG = WORKSPACE.replace(/[/.]/g, '-');
const SESSIONS_DIR = path.join(HOME, '.claude', 'projects', CWD_SLUG);
const RUN_ID = Date.now();

// Track all session UUIDs for cleanup
const createdUuids = new Set();

// --- Helpers ---

function makeSystemPrompt(chatId, messageId) {
  return [
    'You are a test assistant. Answer briefly in 1-2 sentences max.',
    '## Inbound Context',
    '```json',
    JSON.stringify({
      schema: 'openclaw.inbound_meta.v1',
      message_id: String(messageId),
      chat_id: chatId,
      channel: 'telegram',
      provider: 'telegram',
      surface: 'telegram',
      chat_type: 'direct',
    }, null, 2),
    '```',
  ].join('\n');
}

function sessionKeyToUuid(key) {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return [
    hash.slice(0, 8), hash.slice(8, 12),
    '4' + hash.slice(13, 16), '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

function randomNumber() {
  return Math.floor(100000 + Math.random() * 900000);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Send a message to the proxy and return the parsed response.
 * Automatically tracks session UUIDs for cleanup.
 */
function sendMessage(chatId, messageId, text, opts = {}) {
  const sysPrompt = opts.systemPrompt || makeSystemPrompt(chatId, messageId);
  const headers = { 'Content-Type': 'application/json' };
  if (opts.regenerate) headers['x-regenerate'] = 'true';

  // Track the session UUID for cleanup (replicate proxy's session key logic)
  const senderMatch = text.match(/\[from:\s*.+?\(@(\w+)\)\]/);
  const sender = senderMatch ? senderMatch[1].toLowerCase() : null;
  const chatIdMatch = sysPrompt.match(/"chat_id"\s*:\s*"([^"]+)"/);
  const proxyChatId = chatIdMatch ? chatIdMatch[1] : null;
  const identity = sender || proxyChatId;
  const sysTextStable = sysPrompt.replace(/```json\n[\s\S]*?```/g, '');
  const sessionKey = crypto.createHash('md5')
    .update((sysTextStable || 'default') + (identity ? '|' + identity : ''))
    .digest('hex');
  createdUuids.add(sessionKeyToUuid(sessionKey));

  const body = JSON.stringify({
    model: MODEL,
    system: sysPrompt,
    messages: [{ role: 'user', content: text }],
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const url = new URL('/v1/messages', PROXY_URL);
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(raw); } catch {}
        resolve({
          status: res.statusCode,
          text: json?.content?.[0]?.text || '',
          raw,
          json,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timeout (${REQUEST_TIMEOUT_MS / 1000}s)`));
    });
    req.write(body);
    req.end();
  });
}

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${PROXY_URL}/health`, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

// --- Assertions ---

function assertOk(response, label) {
  if (response.status !== 200) {
    return { pass: false, detail: `${label}: expected status 200, got ${response.status} — ${(response.raw || '').slice(0, 200)}` };
  }
  return { pass: true };
}

function assertContains(response, expected, label) {
  const text = response.text.toLowerCase();
  const exp = String(expected).toLowerCase();
  if (!text.includes(exp)) {
    return { pass: false, detail: `${label}: expected "${exp}" in response, got: "${response.text.slice(0, 300)}"` };
  }
  return { pass: true, detail: `${label}: found "${exp}"` };
}

function assertNotContains(response, unexpected, label) {
  const text = response.text.toLowerCase();
  const unexp = String(unexpected).toLowerCase();
  if (text.includes(unexp)) {
    return { pass: false, detail: `${label}: unexpected "${unexp}" found in: "${response.text.slice(0, 300)}"` };
  }
  return { pass: true, detail: `${label}: correctly absent "${unexp}"` };
}

// --- Scenarios ---

async function testBasicContinuity() {
  const name = 'Basic Continuity';
  const chatId = `telegram:e2e-${RUN_ID}-basic`;
  const N = randomNumber();

  const r1 = await sendMessage(chatId, '1',
    `Remember the number ${N}. Just confirm you've remembered it.`);
  let check = assertOk(r1, 'msg1');
  if (!check.pass) return { name, ...check };

  const r2 = await sendMessage(chatId, '2',
    'What number did I ask you to remember? Reply with just the number.');
  check = assertOk(r2, 'msg2');
  if (!check.pass) return { name, ...check };

  return { name, ...assertContains(r2, N, 'recall') };
}

async function testMultiTurnChain() {
  const name = 'Multi-Turn Chain';
  const chatId = `telegram:e2e-${RUN_ID}-chain`;
  const topics = ['elephants', 'volcanoes', 'jazz', 'satellites'];

  for (let i = 0; i < topics.length; i++) {
    const r = await sendMessage(chatId, String(i + 1),
      `The topic is: ${topics[i]}. Acknowledge briefly.`);
    const check = assertOk(r, `msg${i + 1}`);
    if (!check.pass) return { name, ...check };
  }

  const r5 = await sendMessage(chatId, '5',
    'List ALL the topics I mentioned previously. Be brief.');
  const check = assertOk(r5, 'msg5');
  if (!check.pass) return { name, ...check };

  let found = 0;
  for (const t of topics) {
    if (r5.text.toLowerCase().includes(t.toLowerCase())) found++;
  }
  if (found < 2) {
    return { name, pass: false, detail: `Expected >=2 of ${topics.length} topics, found ${found}. Response: "${r5.text.slice(0, 300)}"` };
  }
  return { name, pass: true, detail: `Recalled ${found}/${topics.length} topics` };
}

async function testSessionIsolation() {
  const name = 'Session Isolation';
  const chatA = `telegram:e2e-${RUN_ID}-iso-a`;
  const chatB = `telegram:e2e-${RUN_ID}-iso-b`;

  const rA1 = await sendMessage(chatA, '1',
    'Remember the word "apple". Just confirm.');
  let check = assertOk(rA1, 'chatA msg1');
  if (!check.pass) return { name, ...check };

  const rB1 = await sendMessage(chatB, '1',
    'Remember the word "banana". Just confirm.');
  check = assertOk(rB1, 'chatB msg1');
  if (!check.pass) return { name, ...check };

  const rA2 = await sendMessage(chatA, '2',
    'What word did I ask you to remember?');
  check = assertOk(rA2, 'chatA msg2');
  if (!check.pass) return { name, ...check };

  const rB2 = await sendMessage(chatB, '2',
    'What word did I ask you to remember?');
  check = assertOk(rB2, 'chatB msg2');
  if (!check.pass) return { name, ...check };

  check = assertContains(rA2, 'apple', 'chatA recall');
  if (!check.pass) return { name, ...check };

  check = assertContains(rB2, 'banana', 'chatB recall');
  if (!check.pass) return { name, ...check };

  check = assertNotContains(rA2, 'banana', 'chatA isolation');
  if (!check.pass) return { name, ...check };

  check = assertNotContains(rB2, 'apple', 'chatB isolation');
  if (!check.pass) return { name, ...check };

  return { name, pass: true, detail: 'Sessions correctly isolated' };
}

async function testDynamicMessageId() {
  const name = 'Dynamic message_id Stability';
  const chatId = `telegram:e2e-${RUN_ID}-msgid`;
  const N = randomNumber();

  const r1 = await sendMessage(chatId, '1',
    `Remember: the number is ${N}. Confirm.`);
  let check = assertOk(r1, 'msg1 (id=1)');
  if (!check.pass) return { name, ...check };

  const r2 = await sendMessage(chatId, '99999',
    'Add 10 to the number I told you. What is the result?');
  check = assertOk(r2, 'msg2 (id=99999)');
  if (!check.pass) return { name, ...check };

  const expected = N + 10;
  check = assertContains(r2, expected, 'math check');
  if (!check.pass) return { name, ...check };

  const r3 = await sendMessage(chatId, '50',
    'What was the original number I told you (before adding 10)?');
  check = assertOk(r3, 'msg3 (id=50)');
  if (!check.pass) return { name, ...check };

  return { name, ...assertContains(r3, N, 'recall original') };
}

async function testProxyRestart() {
  const name = 'Proxy Restart Resilience';
  const chatId = `telegram:e2e-${RUN_ID}-restart`;
  const N = randomNumber();

  const r1 = await sendMessage(chatId, '1',
    `Remember the number ${N}. Confirm.`);
  let check = assertOk(r1, 'msg1 before restart');
  if (!check.pass) return { name, ...check };

  // Restart the proxy service
  try {
    execSync('systemctl --user restart claude-cli-proxy', { timeout: 10_000 });
  } catch (err) {
    return { name, pass: false, detail: `Failed to restart proxy: ${err.message}` };
  }

  // Wait for proxy to become healthy
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await checkHealth()) { healthy = true; break; }
  }
  if (!healthy) {
    return { name, pass: false, detail: 'Proxy did not become healthy after restart' };
  }

  const r2 = await sendMessage(chatId, '2',
    'What number did I ask you to remember?');
  check = assertOk(r2, 'msg2 after restart');
  if (!check.pass) return { name, ...check };

  return { name, ...assertContains(r2, N, 'recall after restart') };
}

async function testPreemption() {
  const name = 'Preemption';
  const chatId = `telegram:e2e-${RUN_ID}-preempt`;
  const N = randomNumber();

  // Establish context
  const r1 = await sendMessage(chatId, '1',
    `Remember the number ${N}. Confirm.`);
  let check = assertOk(r1, 'setup msg');
  if (!check.pass) return { name, ...check };

  // Fire long request (don't await)
  const longPromise = sendMessage(chatId, '2',
    'Write a very detailed 500-word essay about the entire history of computing from the abacus to modern AI. Be extremely thorough and verbose.');

  // Wait for CLI to spawn
  await sleep(3000);

  // Fire preempting request with explicit regenerate
  const r3 = await sendMessage(chatId, '3',
    'What number did I ask you to remember? Just the number.',
    { regenerate: true });
  check = assertOk(r3, 'preempt msg');

  // Wait for long promise to settle (was killed)
  await longPromise.catch(() => {});

  if (!check.pass) return { name, ...check };

  return { name, ...assertContains(r3, N, 'recall after preemption') };
}

async function testRegeneration() {
  const name = 'Regeneration';
  const chatId = `telegram:e2e-${RUN_ID}-regen`;

  const r1 = await sendMessage(chatId, '1',
    'The secret code is "alpha". Confirm you\'ve noted it.');
  let check = assertOk(r1, 'msg1');
  if (!check.pass) return { name, ...check };

  const r2 = await sendMessage(chatId, '2',
    'The second secret is "bravo". Confirm you\'ve noted it.');
  check = assertOk(r2, 'msg2');
  if (!check.pass) return { name, ...check };

  // Regenerate — truncates msg2 from history
  const r3 = await sendMessage(chatId, '3',
    'What secrets have I told you? List them all.',
    { regenerate: true });
  check = assertOk(r3, 'regen msg');
  if (!check.pass) return { name, ...check };

  // Should have alpha (msg1 preserved) but not bravo (msg2 truncated)
  check = assertContains(r3, 'alpha', 'preserved msg1');
  if (!check.pass) return { name, ...check };

  check = assertNotContains(r3, 'bravo', 'truncated msg2');
  if (!check.pass) return { name, ...check };

  return { name, pass: true, detail: 'Regeneration correctly truncated last turn' };
}

async function testParallelSessions() {
  const name = 'Parallel Sessions';
  const chats = [
    { id: `telegram:e2e-${RUN_ID}-par-1`, num: randomNumber() },
    { id: `telegram:e2e-${RUN_ID}-par-2`, num: randomNumber() },
    { id: `telegram:e2e-${RUN_ID}-par-3`, num: randomNumber() },
  ];

  // Send all remember messages in parallel
  const remembers = await Promise.all(
    chats.map(c => sendMessage(c.id, '1', `Remember the number ${c.num}. Confirm.`))
  );
  for (let i = 0; i < remembers.length; i++) {
    const check = assertOk(remembers[i], `par-${i + 1} remember`);
    if (!check.pass) return { name, ...check };
  }

  // Recall all in parallel
  const recalls = await Promise.all(
    chats.map(c => sendMessage(c.id, '2', 'What number did I ask you to remember?'))
  );
  for (let i = 0; i < recalls.length; i++) {
    let check = assertOk(recalls[i], `par-${i + 1} recall`);
    if (!check.pass) return { name, ...check };
    check = assertContains(recalls[i], chats[i].num, `par-${i + 1} number`);
    if (!check.pass) return { name, ...check };
  }

  return { name, pass: true, detail: `All ${chats.length} parallel sessions recalled correctly` };
}

async function testLongPause() {
  const name = 'Long Pause';
  const chatId = `telegram:e2e-${RUN_ID}-pause`;
  const N = randomNumber();
  const pauseSec = 60 + Math.floor(Math.random() * 31); // 60-90 seconds

  const r1 = await sendMessage(chatId, '1',
    `Remember the number ${N}. Confirm.`);
  let check = assertOk(r1, 'msg1');
  if (!check.pass) return { name, ...check };

  process.stdout.write(`  waiting ${pauseSec}s...`);
  await sleep(pauseSec * 1000);
  process.stdout.write(' done\n');

  const r2 = await sendMessage(chatId, '2',
    'What number did I ask you to remember?');
  check = assertOk(r2, 'msg2 after pause');
  if (!check.pass) return { name, ...check };

  return { name, ...assertContains(r2, N, `recall after ${pauseSec}s`) };
}

async function testSenderTagPriority() {
  const name = 'Sender Tag Priority';
  const chatId = `telegram:e2e-${RUN_ID}-sender`;

  // msg1: chat_id only (no sender tag) -> session keyed by chatId
  const r1 = await sendMessage(chatId, '1',
    'Remember the word "apple". Confirm.');
  let check = assertOk(r1, 'chatId-only msg1');
  if (!check.pass) return { name, ...check };

  // msg2: sender tag present -> different session (keyed by sender)
  const r2 = await sendMessage(chatId, '2',
    'Remember the word "banana". Confirm. [from: Tester (@e2etest)]');
  check = assertOk(r2, 'sender-tag msg2');
  if (!check.pass) return { name, ...check };

  // msg3: chat_id only -> same session as msg1 -> should recall apple
  const r3 = await sendMessage(chatId, '3',
    'What word did I ask you to remember?');
  check = assertOk(r3, 'chatId-only recall');
  if (!check.pass) return { name, ...check };

  check = assertContains(r3, 'apple', 'chatId session');
  if (!check.pass) return { name, ...check };

  // msg4: sender tag -> same session as msg2 -> should recall banana
  const r4 = await sendMessage(chatId, '4',
    'What word did I ask you to remember? [from: Tester (@e2etest)]');
  check = assertOk(r4, 'sender-tag recall');
  if (!check.pass) return { name, ...check };

  check = assertContains(r4, 'banana', 'sender session');
  if (!check.pass) return { name, ...check };

  return { name, pass: true, detail: 'Sender tag correctly creates separate session' };
}

// --- Runner ---

const ALL_SCENARIOS = [
  testBasicContinuity,
  testMultiTurnChain,
  testSessionIsolation,
  testDynamicMessageId,
  testProxyRestart,
  testPreemption,
  testRegeneration,
  testParallelSessions,
  testLongPause,
  testSenderTagPriority,
];

const stats = {};
let interrupted = false;

async function runAllScenarios(iteration) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Iteration ${iteration} - ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  for (const scenario of ALL_SCENARIOS) {
    if (interrupted) break;

    const scenarioName = scenario.name;
    process.stdout.write(`\n  [${scenarioName}] Running... `);

    const start = Date.now();
    let result;
    try {
      result = await scenario();
    } catch (err) {
      result = { name: scenarioName, pass: false, detail: `Error: ${err.message}` };
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const icon = result.pass ? 'PASS' : 'FAIL';
    // Clear the "Running..." line and print result
    process.stdout.write(`\r  [${result.name}] ${icon} (${elapsed}s) - ${result.detail}\n`);

    if (!stats[result.name]) stats[result.name] = { passed: 0, failed: 0, errors: [] };
    if (result.pass) {
      stats[result.name].passed++;
    } else {
      stats[result.name].failed++;
      stats[result.name].errors.push(`iter${iteration}: ${result.detail}`);
    }

    if (!interrupted && ALL_SCENARIOS.indexOf(scenario) < ALL_SCENARIOS.length - 1) {
      await sleep(PAUSE_MS);
    }
  }
}

function cleanupSessions() {
  let cleaned = 0;

  // Delete tracked session UUIDs
  for (const uuid of createdUuids) {
    const jsonlPath = path.join(SESSIONS_DIR, `${uuid}.jsonl`);
    try { fs.unlinkSync(jsonlPath); cleaned++; } catch {}
  }

  // Also sweep for regen forks and other files created during this run
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (createdUuids.has(f.replace('.jsonl', ''))) continue; // already handled
      const fp = path.join(SESSIONS_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < RUN_ID) continue; // older than our run
        // Check if it contains our test marker
        const head = fs.readFileSync(fp, 'utf-8').slice(0, 4000);
        if (head.includes(`e2e-${RUN_ID}`)) {
          fs.unlinkSync(fp);
          cleaned++;
        }
      } catch {}
    }
  } catch {}

  if (cleaned > 0) {
    console.log(`\nCleaned up ${cleaned} test session file(s)`);
  }
}

function printSummary() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));

  let totalPassed = 0;
  let totalFailed = 0;

  for (const [name, s] of Object.entries(stats)) {
    const icon = s.failed === 0 ? 'PASS' : 'FAIL';
    console.log(`  ${icon}  ${name}: ${s.passed} passed, ${s.failed} failed`);
    if (s.errors.length > 0) {
      for (const err of s.errors.slice(-3)) {
        console.log(`        > ${err}`);
      }
    }
    totalPassed += s.passed;
    totalFailed += s.failed;
  }

  console.log(`\nTotal: ${totalPassed} passed, ${totalFailed} failed`);
  return totalFailed === 0;
}

async function main() {
  console.log('E2E Session Continuity Test Suite');
  console.log(`Proxy:    ${PROXY_URL}`);
  console.log(`Model:    ${MODEL}`);
  console.log(`Duration: ${DURATION_MS / 60000} minutes`);
  console.log(`Run ID:   ${RUN_ID}`);

  // Check proxy health
  if (!(await checkHealth())) {
    console.error(`\nCannot reach proxy at ${PROXY_URL}`);
    console.error('Start the proxy: systemctl --user start claude-cli-proxy');
    process.exit(1);
  }
  console.log('Proxy:    healthy');

  // Graceful SIGINT
  process.on('SIGINT', () => {
    if (interrupted) process.exit(1);
    interrupted = true;
    console.log('\n\nInterrupted - finishing current scenario...');
  });

  const startTime = Date.now();
  let iteration = 1;

  while (!interrupted && (Date.now() - startTime) < DURATION_MS) {
    await runAllScenarios(iteration);
    iteration++;

    const remaining = DURATION_MS - (Date.now() - startTime);
    if (remaining > 0 && !interrupted) {
      const mins = (remaining / 60000).toFixed(1);
      console.log(`\n--- ${mins} minutes remaining ---`);
    }
  }

  cleanupSessions();
  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
