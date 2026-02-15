#!/usr/bin/env node
/**
 * Claude CLI Proxy Server - Enhanced with Intermediate Status Updates
 *
 * A lightweight HTTP server that wraps Claude CLI to provide an Anthropic-compatible API
 * with full visibility into tool usage, thinking, and processing states.
 *
 * Features:
 * - Full Anthropic Messages API streaming compatibility
 * - Intermediate status events for tool_use, thinking, input_json_delta
 * - Processing state visibility (spawning, thinking, tool_executing)
 * - Detailed event logging for monitoring dashboards
 *
 * Usage:
 *   node server.js [--port 8787]
 *
 * Endpoints:
 *   POST /v1/messages - Anthropic Messages API compatible endpoint
 *   GET /v1/models - List available models
 *   GET /health - Health check
 *   GET /events - SSE stream for monitoring all proxy events
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');
const os = require('os');

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || process.argv.find((_, i, a) => a[i-1] === '--port') || '8787', 10);
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const DEBUG = process.env.DEBUG === '1';
const crypto = require('crypto');
const HOME = process.env.HOME || os.homedir();
const WORKSPACE = process.env.CLAUDE_PROXY_WORKSPACE || path.join(HOME, '.claude-proxy', 'workspace');
const CLAUDE_CONFIG_DIR = path.join(HOME, '.claude'); // real CLI config (auth lives here)
const DEPLOY_SECRET = process.env.DEPLOY_WEBHOOK_SECRET || '';

// Session management: maps session-key → { uuid, lastUsed }
const sessions = new Map();
const SESSION_TTL_MS = 3600 * 1000; // 1 hour

// Active run tracking: session-key → { child, requestId, done, resolveDone }
const activeRuns = new Map();
const sessionQueues = new Map(); // sessionKey → Promise (tail of chain)

// Human messages from Telegram contain [from: Name (@user)] tag — these get priority

// Extract sender username from OpenClaw's [from: Name (@user)] tag
function parseSender(prompt) {
  const m = prompt.match(/\[from:\s*.+?\(@(\w+)\)\]\s*$/);
  return m ? m[1].toLowerCase() : null;
}

// Deterministic UUID from session key
function sessionKeyToUuid(key) {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return [hash.slice(0,8), hash.slice(8,12), '4'+hash.slice(13,16),
          '8'+hash.slice(17,20), hash.slice(20,32)].join('-');
}

// Periodic cleanup every 10 minutes (only when running as main)
if (require.main === module) {
  setInterval(() => {
    const now = Date.now();
    for (const [key, info] of sessions) {
      if (now - info.lastUsed > SESSION_TTL_MS) {
        log(`[session] Evicting expired session: ${key.slice(0, 8)}...`);
        sessions.delete(key);
      }
    }
  }, 600_000);
}

// Detect Claude CLI version at startup (only when running as main)
let cliVersion = 'unknown';
if (require.main === module) {
  // Ensure proxy workspace exists (cwd isolation for sessions)
  fs.mkdirSync(WORKSPACE, { recursive: true });

  try {
    cliVersion = execSync(`${CLAUDE_PATH} --version 2>/dev/null`, { timeout: 5000 }).toString().trim();
  } catch {}
}

// Timeout constants
const IDLE_TIMEOUT_MS = 60 * 1000;          // 60 sec without data = kill child
const TOOL_IDLE_TIMEOUT_MS = 300 * 1000;    // 5 min during tool execution (CLI runs tools locally)
const COMPACTION_TIMEOUT_MS = 600 * 1000;    // 10 min during compaction

// Gateway metadata tags to strip from prompts and responses
const GATEWAY_TAG_RE = /\[\[reply_to_message_id:\s*\d+\]\]\s*/g;

const monitorClients = new Set();

function log(...args) {
  const msg = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(msg);
  emitMonitorEvent('log', { message: args.join(' '), timestamp: new Date().toISOString() });
}

function debug(...args) {
  if (DEBUG) log('[DEBUG]', ...args);
}

// Emit event to all monitoring clients
function emitMonitorEvent(type, data) {
  const event = { type, ...data, _ts: Date.now() };
  for (const client of monitorClients) {
    try {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (e) {
      monitorClients.delete(client);
    }
  }
}

/**
 * Generate a unique message ID
 */
function generateMessageId() {
  return `msg_cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Send SSE event in Anthropic format
 */
function sendSSE(res, eventType, data) {
  const line = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  debug('SSE out:', eventType, 'len:', line.length);
  res.write(line);
  // Force flush if cork is active to prevent SSE event merging
  if (res.writableCorked) res.uncork();

  // Also emit to monitoring
  emitMonitorEvent('sse_out', { eventType, data });
}

/**
 * Map model name to CLI model flag
 */
function mapModelName(model) {
  let cliModel = model
    .replace(/^anthropic\//, '')
    .replace(/^claude-cli\//, '')
    .replace(/-20\d{6}$/, ''); // Remove date suffix

  // Common aliases - map to Claude Max plan model flags
  if (cliModel.includes('opus')) cliModel = 'opus';
  else if (cliModel.includes('sonnet')) cliModel = 'sonnet';
  else if (cliModel.includes('haiku')) cliModel = 'haiku';

  return cliModel;
}

/**
 * Extract base64 images from content array, write to temp files,
 * return file paths to append to prompt (matching OpenClaw's CLI backend pattern).
 */
function writeImagesToTmp(contentBlocks, requestId) {
  const images = contentBlocks.filter(c =>
    c.type === 'image' && c.source?.type === 'base64' && c.source?.data
  );
  if (images.length === 0) return [];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-img-'));
  const paths = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = (img.source.media_type || 'image/png').split('/')[1] || 'png';
    const filePath = path.join(tmpDir, `image-${i + 1}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(img.source.data, 'base64'));
    paths.push(filePath);
    debug(`[${requestId}] Wrote image ${i + 1}: ${filePath} (${img.source.media_type})`);
  }

  return paths;
}

/**
 * Truncate a session JSONL to remove the last user turn and all descendants.
 * Returns the path to the new truncated JSONL, or null if truncation is not possible.
 */
function truncateSessionForRegenerate(jsonlPath, newUuid, cwdSlug) {
  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return null;
  }
  const lines = content.split('\n').filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // Find the last real user message (not tool_result, not compact summary)
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'user' && e.message?.role === 'user' && !e.isCompactSummary) {
      // Check if it's a tool_result array — skip those
      if (Array.isArray(e.message.content)
          && e.message.content.every(c => c.type === 'tool_result')) {
        continue;
      }
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx <= 0) return null; // nothing to truncate

  // Collect UUIDs to remove: the user message and all descendants
  const lastUserUuid = entries[lastUserIdx].uuid;
  const toRemove = new Set();
  toRemove.add(lastUserUuid);

  // Walk forward, removing any entry whose parentUuid is in toRemove
  for (let i = lastUserIdx + 1; i < entries.length; i++) {
    if (toRemove.has(entries[i].parentUuid)) {
      toRemove.add(entries[i].uuid);
    }
  }

  // Also remove the file-history-snapshot immediately before the user message
  if (lastUserIdx > 0 && entries[lastUserIdx - 1].type === 'file-history-snapshot') {
    toRemove.add(entries[lastUserIdx - 1].uuid);
  }

  // Build truncated JSONL in a new file (preserves original for safety)
  const kept = entries.filter(e => !toRemove.has(e.uuid));
  const newPath = path.join(
    CLAUDE_CONFIG_DIR, 'projects', cwdSlug, `${newUuid}.jsonl`
  );
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(newPath, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
  return newPath;
}

/**
 * Extract complete JSON objects from a buffer using brace counting.
 * Returns { objects: parsed[], remainder: string }
 */
function extractJsonObjects(buffer) {
  const objects = [];
  let startIndex = 0;
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < buffer.length; i++) {
    const char = buffer[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        if (braceCount === 0) startIndex = i;
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          const jsonStr = buffer.slice(startIndex, i + 1);
          try {
            objects.push(JSON.parse(jsonStr));
          } catch (e) {
            // Skip unparseable JSON
          }
          startIndex = i + 1;
        }
      }
    }
  }

  return { objects, remainder: buffer.slice(startIndex) };
}

/**
 * Convert Anthropic Messages API request to Claude CLI call with full event streaming
 */
async function handleMessages(req, res) {
  const requestId = generateMessageId();
  let body = '';

  for await (const chunk of req) {
    body += chunk;
  }

  let request;
  try {
    request = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'Invalid JSON' } }));
    return;
  }

  const { model, messages, system, max_tokens, stream } = request;

  // Extract the last user message as the prompt
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'No user message found' } }));
    return;
  }

  // Extract ONLY the last user message (gateway already provides conversation context in it)
  let prompt = '';
  let imagePaths = [];
  if (typeof lastUserMsg.content === 'string') {
    prompt = lastUserMsg.content;
  } else if (Array.isArray(lastUserMsg.content)) {
    prompt = lastUserMsg.content
      .filter(c => c.type === 'text').map(c => c.text).join('\n');

    // Extract base64 images to temp files, append paths to prompt
    imagePaths = writeImagesToTmp(lastUserMsg.content, requestId);
    if (imagePaths.length > 0) {
      prompt += '\n\n' + imagePaths.join('\n');
    }
  }
  prompt = prompt.trim();

  // Helper to clean up temp image files (called on early exit and child close/error)
  const cleanupImages = () => {
    if (imagePaths.length > 0) {
      const tmpDir = path.dirname(imagePaths[0]);
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    }
  };

  // Strip gateway metadata tags that Claude would echo back
  prompt = prompt.replace(GATEWAY_TAG_RE, '');

  const sender = parseSender(prompt);
  const isPriority = sender != null;  // any human Telegram message gets priority

  // Extract system prompt text
  let sysText = '';
  if (system) {
    if (typeof system === 'string') {
      sysText = system;
    } else if (Array.isArray(system)) {
      sysText = system
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    } else if (system.text) {
      sysText = system.text;
    }
    sysText = sysText.replace(GATEWAY_TAG_RE, '');
  }

  // Derive session key from request header or hash of system prompt + first message
  const firstMsgText = typeof messages[0]?.content === 'string'
    ? messages[0].content
    : (messages[0]?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const sessionKey = req.headers['x-session-key']
    || crypto.createHash('md5').update((sysText || 'default') + '|' + firstMsgText.slice(0, 200)).digest('hex');
  // Use stored UUID if session was forked (regen), else deterministic from key
  let sessionUuid = sessions.get(sessionKey)?.uuid || sessionKeyToUuid(sessionKey);
  // Check both in-memory map AND on-disk JSONL to survive proxy restarts
  const cwdSlug = WORKSPACE.replace(/[/.]/g, '-');
  let sessionJsonlPath = path.join(
    CLAUDE_CONFIG_DIR, 'projects', cwdSlug,
    `${sessionUuid}.jsonl`
  );
  let isResume = sessions.has(sessionKey) || fs.existsSync(sessionJsonlPath);

  // Session regeneration: fork to new UUID with truncated history
  const isRegenerate = req.headers['x-regenerate'] === 'true';
  if (isRegenerate && isResume) {
    const regenUuid = sessionKeyToUuid(sessionKey + ':regen:' + Date.now());
    const truncatedPath = truncateSessionForRegenerate(sessionJsonlPath, regenUuid, cwdSlug);
    if (truncatedPath) {
      sessionUuid = regenUuid;
      sessionJsonlPath = truncatedPath;
      debug(`[${requestId}] Regenerating: forked session to ${regenUuid.slice(0, 8)}`);
    }
  }

  // Map model names
  let cliModel = mapModelName(model);

  debug('Model:', model, '->', cliModel);
  debug('Prompt length:', prompt.length);
  debug('Stream requested:', stream);
  debug('Session:', sessionKey.slice(0, 8) + '...', 'resume:', isResume);

  // Emit request started event
  emitMonitorEvent('request_start', {
    requestId,
    model: cliModel,
    promptLength: prompt.length,
    stream,
    sessionKey: sessionKey.slice(0, 8),
    isResume,
    promptPreview: prompt.slice(0, 100)
  });

  // Handle /stop command — kill active run without spawning CLI
  if (prompt === '/stop') {
    const hadActive = activeRuns.has(sessionKey);
    if (hadActive) {
      const prev = activeRuns.get(sessionKey);
      log(`[${requestId}] /stop: killing active run ${prev.requestId} for session ${sessionKey.slice(0, 8)}...`);
      prev.child.kill('SIGTERM');
    } else {
      log(`[${requestId}] /stop: no active run for session ${sessionKey.slice(0, 8)}...`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: requestId, type: 'message', role: 'assistant', model: model || 'unknown',
      content: [{ type: 'text', text: hadActive ? 'Stopping current task.' : 'No active task to stop.' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }));
    cleanupImages();
    return;
  }

  // Spawn CLI with session management
  const spawnCli = () => {
    const args = [
      '--print',
      '--output-format', stream ? 'stream-json' : 'json',
      '--dangerously-skip-permissions',
      '--model', cliModel,
    ];

    // Use --resume for existing sessions (preserves conversation context),
    // --session-id for new sessions. Only pass --system-prompt for new sessions
    // because it overrides the stored prompt and destroys context on resume.
    if (isResume) {
      args.push('--resume', sessionUuid);
      // Nudge the agent to re-read project instructions after compaction
      args.push('--append-system-prompt',
        'Remember: read CLAUDE.md project instructions. Check workspace files (SOUL.md, memory/) if context feels incomplete.');
    } else {
      args.push('--session-id', sessionUuid);
      if (sysText) {
        args.push('--system-prompt', sysText);
      }
    }

    if (stream) {
      args.push('--verbose');
      args.push('--include-partial-messages');
    }

    const logArgs = args.map((a, i) => args[i-1] === '--system-prompt' ? `[${a.length} chars]` : a);
    log(`[${requestId}] Spawning: claude ${logArgs.join(' ')} [prompt via stdin: ${prompt.length} chars]`);

    emitMonitorEvent('cli_spawn', {
      requestId,
      model: cliModel,
      resume: isResume,
      sessionId: sessionUuid.slice(0, 8),
      args: args.filter(a => !a.startsWith('--system')).slice(0, 10)
    });

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn(CLAUDE_PATH, args, {
      env,
      cwd: WORKSPACE,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write(prompt);
    child.stdin.end();

    return child;
  };

  // Create queue entry BEFORE await to prevent double-wake race condition
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const prevTail = sessionQueues.get(sessionKey);
  sessionQueues.set(sessionKey, done);

  // Session preemption: if a new request arrives for a session that already has
  // an active CLI, the gateway has abandoned the previous run. Kill it immediately
  // so the queue unblocks. The old CLI's exit resolves prevTail via resolveDone().
  const activeRun = activeRuns.get(sessionKey);
  if (activeRun) {
    log(`[${requestId}] Preempting active run ${activeRun.requestId} for session ${sessionKey.slice(0, 8)}...`);
    activeRun.child.kill('SIGTERM');
  }

  // Handle client disconnect while queued (prevent queue hang)
  let cancelled = false;
  const onDisconnect = () => { cancelled = true; resolveDone(); };
  req.on('close', onDisconnect);

  if (prevTail) {
    log(`[${requestId}] Session ${sessionKey.slice(0, 8)}... busy, queuing (priority=${isPriority})...`);
    await prevTail;
  }

  req.removeListener('close', onDisconnect);
  if (cancelled) {
    log(`[${requestId}] Client disconnected while queued, skipping`);
    if (sessionQueues.get(sessionKey) === done) sessionQueues.delete(sessionKey);
    cleanupImages();
    return;
  }

  // Claude CLI treats an existing JSONL as "session in use" — but we need the JSONL
  // for conversation continuity. Only clear it when we hit the lock error.
  function clearSessionLock() {
    try {
      fs.unlinkSync(sessionJsonlPath);
      log(`[${requestId}] Cleared stale session JSONL: ${path.basename(sessionJsonlPath)}`);
    } catch (e) {
      if (e.code !== 'ENOENT') log(`[${requestId}] Failed to clear session JSONL: ${e.message}`);
    }
  }

  // Spawn CLI with error recovery:
  // - "already in use" → clear JSONL, fall back to --session-id (loses context but works)
  // - --resume fail → fall back to --session-id (new session)
  async function spawnWithRetry() {
    const child = spawnCli();
    let stderrBuf = '';
    const onStderr = (d) => { stderrBuf += d; };
    child.stderr.on('data', onStderr);

    const earlyExit = await Promise.race([
      new Promise(resolve => child.once('close', code => resolve({ exited: true, code }))),
      new Promise(resolve => setTimeout(() => resolve({ exited: false }), 3000)),
    ]);

    child.stderr.removeListener('data', onStderr);

    if (!earlyExit.exited) return child; // still running → success

    if (stderrBuf.includes('already in use')) {
      // Session locked — clear JSONL and retry with fresh session
      log(`[${requestId}] Session locked, clearing JSONL and retrying...`);
      clearSessionLock();
      isResume = false;
      return spawnCli();
    }

    if (isResume && earlyExit.code !== 0) {
      // --resume failed (e.g. session not found) — fall back to new session
      log(`[${requestId}] Resume failed (${stderrBuf.trim().slice(0, 100)}), falling back to new session`);
      sessions.delete(sessionKey);
      isResume = false;
      return spawnCli();
    }

    // Other error — clear JSONL (first spawn may have created it) and try once more
    clearSessionLock();
    return spawnCli();
  }

  const proc = await spawnWithRetry();
  activeRuns.set(sessionKey, { child: proc, requestId, done, resolveDone, isPriority, sender });

  if (stream) {
    await handleStreamingResponse(req, res, proc, model, requestId, sessionKey, imagePaths, sessionUuid);
  } else {
    await handleNonStreamingResponse(req, res, proc, model, requestId, sessionKey, imagePaths, sessionUuid);
  }
}

/**
 * Handle streaming response with full Anthropic event compatibility
 */
async function handleStreamingResponse(req, res, child, model, requestId, sessionKey, imagePaths, sessionUuid) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Request-Id': requestId,
  });

  // Disable Nagle's algorithm to prevent TCP buffering of SSE events
  if (res.socket) res.socket.setNoDelay(true);

  const messageId = requestId;
  let inputTokens = 0;
  let outputTokens = 0;
  let contentBlocks = [];
  let currentBlockIndex = -1;
  let currentBlockType = null;
  let sseBlockIndex = -1;           // SSE output index (excludes filtered tool_use blocks)
  let insideToolUseBlock = false;   // true during tool_use block streaming

  // Tracking state (must be declared before resetIdleTimeout which references it)
  const state = {
    messageStarted: false,
    thinking: false,
    toolUse: null,
    textStarted: false,
    textSent: false,  // Track if text was already sent via text_delta streaming
    toolExecuting: false,  // true from tool_use start until next text/thinking block
    compacting: false,     // true from compact_boundary until next content block
  };

  // Idle timeout - kill child if no output for configured period
  let idleTimeout;
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeout);
    const timeoutMs = state.compacting
      ? COMPACTION_TIMEOUT_MS
      : state.toolExecuting
        ? TOOL_IDLE_TIMEOUT_MS
        : IDLE_TIMEOUT_MS;
    idleTimeout = setTimeout(() => {
      log(`[${requestId}] Idle timeout (${timeoutMs}ms, toolExecuting=${state.toolExecuting}), killing child`);
      emitMonitorEvent('cli_timeout', { requestId, type: 'idle', toolExecuting: state.toolExecuting });
      child.kill('SIGTERM');
    }, timeoutMs);
  };
  resetIdleTimeout();

  // Handle client disconnect — listen on both req and res for robustness
  let clientDisconnected = false;
  const onClientClose = () => {
    if (clientDisconnected) return;
    clientDisconnected = true;
    log(`[${requestId}] Client disconnected, killing child`);
    clearTimeout(idleTimeout);
    child.kill('SIGTERM');
  };
  req.on('close', onClientClose);
  res.on('close', onClientClose);

  // Send message_start
  sendSSE(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  state.messageStarted = true;

  // Process CLI stream events
  let buffer = '';

  child.stdout.on('data', (data) => {
    resetIdleTimeout();  // Reset idle timeout on each data chunk
    buffer += data.toString();

    const { objects, remainder } = extractJsonObjects(buffer);
    buffer = remainder;

    for (const event of objects) {
      // Handle raw events (new in 2.1.29) or wrapped stream_event (Phase 1)
      if (event.type === 'stream_event' && event.event) {
        processStreamEvent(event.event, res, state, contentBlocks, messageId, model, requestId);
      } else {
        processStreamEvent(event, res, state, contentBlocks, messageId, model, requestId);
      }
    }
  });

  child.stderr.on('data', (data) => {
    const stderr = data.toString();
    debug('stderr:', stderr);
    emitMonitorEvent('cli_stderr', { requestId, message: stderr });
  });

  child.on('close', (code) => {
    clearTimeout(idleTimeout);

    // Clean up active run tracking and resolve queue promise
    const entry = activeRuns.get(sessionKey);
    if (entry?.requestId === requestId) {
      entry.resolveDone();
      activeRuns.delete(sessionKey);
      if (sessionQueues.get(sessionKey) === entry.done) {
        sessionQueues.delete(sessionKey);
      }
    }

    // Track session on success (use actual sessionUuid, which may be a regen fork)
    if (code === 0 && sessionKey) {
      sessions.set(sessionKey, { uuid: sessionUuid, lastUsed: Date.now() });
      log(`[${requestId}] Session saved: ${sessionKey.slice(0, 8)}... (${sessions.size} active)`);
    }

    cleanupImages();

    // Close any open non-tool_use content blocks visible to gateway
    if ((state.thinking || state.textStarted) && !insideToolUseBlock) {
      sendSSE(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: sseBlockIndex >= 0 ? sseBlockIndex : 0
      });
    }

    // Send message_delta with stop_reason
    sendSSE(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens }
    });

    // Give time for final SSE events to flush before ending the response
    setTimeout(() => {
      sendSSE(res, 'message_stop', { type: 'message_stop' });
      res.end();
    }, 10);

    emitMonitorEvent('request_complete', {
      requestId,
      exitCode: code,
      outputTokens,
      contentBlocks: contentBlocks.length
    });

    log(`[${requestId}] Completed (code ${code}): ${outputTokens} tokens, ${contentBlocks.length} blocks`);
  });

  child.on('error', (err) => {
    clearTimeout(idleTimeout);

    // Clean up active run tracking and resolve queue promise
    const entry = activeRuns.get(sessionKey);
    if (entry?.requestId === requestId) {
      entry.resolveDone();
      activeRuns.delete(sessionKey);
      if (sessionQueues.get(sessionKey) === entry.done) {
        sessionQueues.delete(sessionKey);
      }
    }

    log(`[${requestId}] Spawn error:`, err.message);
    emitMonitorEvent('cli_error', { requestId, error: err.message });

    cleanupImages();
    sendSSE(res, 'error', {
      type: 'error',
      error: { type: 'api_error', message: err.message }
    });
    res.end();
  });

  /**
   * Process a single stream event from Claude CLI
   */
  function processStreamEvent(e, res, state, contentBlocks, messageId, model, requestId) {
    // Forward content_block_start events
    if (e.type === 'content_block_start') {
      currentBlockIndex++;
      const block = e.content_block;
      currentBlockType = block.type;

      contentBlocks.push({
        index: currentBlockIndex,
        type: block.type,
        started: Date.now()
      });

      if (block.type === 'tool_use') {
        // Filter tool_use from SSE output — CLI handles tools internally.
        // Forwarding these causes gateway to attempt (and fail) tool execution → retry loop.
        insideToolUseBlock = true;
        state.toolExecuting = true;
        state.toolUse = { id: block.id, name: block.name, input: '' };
        resetIdleTimeout();  // Switch to longer timeout
        emitMonitorEvent('tool_use_start', {
          requestId,
          index: currentBlockIndex,
          toolId: block.id,
          toolName: block.name
        });
      } else {
        // thinking or text — send to gateway
        state.compacting = false;   // compaction done, content flowing again
        state.toolExecuting = false;
        resetIdleTimeout();  // Switch back to normal timeout
        sseBlockIndex++;

        sendSSE(res, 'content_block_start', {
          type: 'content_block_start',
          index: sseBlockIndex,
          content_block: block
        });

        if (block.type === 'thinking') {
          state.thinking = true;
          emitMonitorEvent('thinking_start', { requestId, index: sseBlockIndex });
        } else if (block.type === 'text') {
          state.textStarted = true;
          emitMonitorEvent('text_start', { requestId, index: sseBlockIndex });
        }
      }

      return;
    }

    // Forward content_block_delta events
    if (e.type === 'content_block_delta') {
      let delta = e.delta;

      // Filter tool_use deltas — don't forward to gateway
      if (insideToolUseBlock) {
        if (delta.type === 'input_json_delta' && state.toolUse) {
          state.toolUse.input += delta.partial_json || '';
          emitMonitorEvent('tool_input_delta', {
            requestId,
            index: currentBlockIndex,
            partialJson: delta.partial_json
          });
        }
        return;
      }

      // Strip gateway metadata tags from outgoing text (may leak from session history)
      if (delta.type === 'text_delta' && delta.text) {
        delta = { ...delta, text: delta.text.replace(GATEWAY_TAG_RE, '') };
      }

      // Forward thinking/text deltas with remapped index
      sendSSE(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: sseBlockIndex >= 0 ? sseBlockIndex : 0,
        delta: delta
      });

      // Track thinking content
      if (delta.type === 'thinking_delta') {
        emitMonitorEvent('thinking_delta', {
          requestId,
          index: sseBlockIndex,
          thinkingPreview: (delta.thinking || '').slice(0, 100)
        });
      }

      // Track text_delta - mark that text was already streamed
      if (delta.type === 'text_delta') {
        state.textSent = true;
      }

      return;
    }

    // Forward content_block_stop events
    if (e.type === 'content_block_stop') {
      const blockInfo = contentBlocks[e.index] || contentBlocks[currentBlockIndex];
      if (blockInfo) {
        blockInfo.ended = Date.now();
        blockInfo.duration = blockInfo.ended - blockInfo.started;
      }

      if (currentBlockType === 'tool_use') {
        // Don't forward tool_use stop to gateway
        emitMonitorEvent('tool_use_end', {
          requestId,
          index: currentBlockIndex,
          toolId: state.toolUse?.id,
          toolName: state.toolUse?.name,
          duration: blockInfo?.duration
        });
        state.toolUse = null;
        insideToolUseBlock = false;
        // Note: toolExecuting stays true until next thinking/text block starts
      } else {
        // Forward thinking/text stop with remapped index
        sendSSE(res, 'content_block_stop', {
          type: 'content_block_stop',
          index: sseBlockIndex >= 0 ? sseBlockIndex : 0
        });

        if (currentBlockType === 'thinking') {
          state.thinking = false;
          emitMonitorEvent('thinking_end', {
            requestId,
            index: sseBlockIndex,
            duration: blockInfo?.duration
          });
        } else if (currentBlockType === 'text') {
          state.textStarted = false;
          emitMonitorEvent('text_end', {
            requestId,
            index: sseBlockIndex,
            duration: blockInfo?.duration
          });
        }
      }

      currentBlockType = null;
      return;
    }

    // Forward message_delta events
    if (e.type === 'message_delta') {
      if (e.usage) {
        outputTokens = e.usage.output_tokens || 0;
      }
      sendSSE(res, 'message_delta', {
        type: 'message_delta',
        delta: e.delta,
        usage: e.usage
      });
      return;
    }

    // Handle assistant messages (static tool use or text)
    if (e.type === 'assistant' && e.message) {
      const msg = e.message;
      if (msg.content) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            emitMonitorEvent('tool_use_start', {
              requestId,
              toolId: block.id,
              toolName: block.name,
              input: block.input,
              static: true
            });
          }
        }
      }
      return;
    }

    // Handle user messages (tool results)
    if (e.type === 'user' && e.message) {
      const msg = e.message;
      if (msg.content) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            emitMonitorEvent('tool_use_end', {
              requestId,
              toolId: block.tool_use_id,
              status: block.is_error ? 'error' : 'success',
              static: true
            });
          }
        }
      }
      return;
    }

    // Handle system events (compaction, errors, status, etc.)
    if (e.type === 'system') {
      if (e.subtype === 'compact_boundary') {
        state.compacting = true;
        resetIdleTimeout();  // Switch to 10-min timeout
        const meta = e.compact_metadata || {};
        log(`[${requestId}] Context compaction started (trigger=${meta.trigger}, pre_tokens=${meta.pre_tokens})`);
        emitMonitorEvent('context_compaction', {
          requestId,
          trigger: meta.trigger,
          preTokens: meta.pre_tokens
        });
        // Inject notification into SSE stream
        sseBlockIndex++;
        sendSSE(res, 'content_block_start', {
          type: 'content_block_start',
          index: sseBlockIndex,
          content_block: { type: 'text', text: '' }
        });
        const triggerLabel = meta.trigger === 'manual' ? 'Manual' : 'Auto';
        const tokensLabel = meta.pre_tokens ? ` (${meta.pre_tokens} tokens)` : '';
        sendSSE(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: sseBlockIndex,
          delta: { type: 'text_delta', text: `[${triggerLabel} context compaction${tokensLabel} — summarizing conversation history...]` }
        });
        sendSSE(res, 'content_block_stop', {
          type: 'content_block_stop',
          index: sseBlockIndex
        });
      } else {
        // Log other system events (api_error, status, etc.)
        emitMonitorEvent('system_event', {
          requestId,
          subtype: e.subtype,
          data: e
        });
      }
      return;
    }

    // Handle system_event (legacy wrapper format)
    if (e.system_event) {
      const sysEvent = e.system_event;
      emitMonitorEvent('system_event', {
        requestId,
        systemEventType: sysEvent.type,
        data: sysEvent
      });
      // Don't send ping - not a standard Anthropic event, causes parse errors
      return;
    }

    // Handle init event - just log, don't create blocks (CLI does it)
    if (e.type === 'init' || e.subtype === 'init') {
      emitMonitorEvent('cli_init', {
        requestId,
        sessionId: e.session_id,
        model: e.model
      });
      return;
    }

    // Handle result event (final summary)
    if (e.type === 'result') {
      if (e.usage) {
        inputTokens = (e.usage.input_tokens || 0) +
                     (e.usage.cache_creation_input_tokens || 0) +
                     (e.usage.cache_read_input_tokens || 0);
        outputTokens = e.usage.output_tokens || 0;
      }

      emitMonitorEvent('cli_result', {
        requestId,
        inputTokens,
        outputTokens,
        resultPreview: (e.result || '').slice(0, 100)
      });

      // Emit result as text delta ONLY if text wasn't already sent via streaming
      // With --include-partial-messages, text is streamed via text_delta events
      if (e.result && !state.textSent) {
        if (sseBlockIndex < 0) {
          sseBlockIndex = 0;
          sendSSE(res, 'content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
          });
          contentBlocks.push({
            index: 0,
            type: 'text',
            started: Date.now(),
            ended: Date.now()
          });
        }

        sendSSE(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: sseBlockIndex,
          delta: { type: 'text_delta', text: e.result.replace(GATEWAY_TAG_RE, '') }
        });
      }
      return;
    }
  }
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(req, res, child, model, requestId, sessionKey, imagePaths, sessionUuid) {
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => {
    stderr += data;
    emitMonitorEvent('cli_stderr', { requestId, message: data.toString() });
  });

  child.on('close', (code) => {
    // Clean up active run tracking and resolve queue promise
    const entry = activeRuns.get(sessionKey);
    if (entry?.requestId === requestId) {
      entry.resolveDone();
      activeRuns.delete(sessionKey);
      if (sessionQueues.get(sessionKey) === entry.done) {
        sessionQueues.delete(sessionKey);
      }
    }

    // Track session on success (use actual sessionUuid, which may be a regen fork)
    if (code === 0 && sessionKey) {
      sessions.set(sessionKey, { uuid: sessionUuid, lastUsed: Date.now() });
      log(`[${requestId}] Session saved: ${sessionKey.slice(0, 8)}... (${sessions.size} active)`);
    }

    cleanupImages();

    // Try to parse JSON output regardless of exit code
    // CLI returns exit 1 for credit issues but still provides valid JSON
    let result;
    try {
      result = JSON.parse(stdout);
    } catch (e) {
      // Only fail if we can't parse AND exit code was non-zero
      if (code !== 0) {
        log(`[${requestId}] CLI error:`, stderr);
        emitMonitorEvent('request_error', { requestId, error: stderr, exitCode: code });

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: stderr || 'Claude CLI failed' } }));
        return;
      }
    }

    if (!result) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'api_error', message: 'No parseable output from CLI' } }));
      return;
    }

    try {
      const response = {
        id: requestId,
        type: 'message',
        role: 'assistant',
        model: model,
        content: [{ type: 'text', text: (result.result || '').replace(GATEWAY_TAG_RE, '') }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: (result.usage?.input_tokens || 0) +
                       (result.usage?.cache_creation_input_tokens || 0) +
                       (result.usage?.cache_read_input_tokens || 0),
          output_tokens: result.usage?.output_tokens || 0,
        }
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));

      emitMonitorEvent('request_complete', {
        requestId,
        exitCode: code,
        outputTokens: response.usage.output_tokens
      });

      log(`[${requestId}] Completed: ${response.usage.output_tokens} tokens`);
    } catch (e) {
      log(`[${requestId}] Parse error:`, e.message);
      emitMonitorEvent('request_error', { requestId, error: e.message });

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'api_error', message: 'Failed to parse CLI output' } }));
    }
  });

  child.on('error', (err) => {
    // Clean up active run tracking and resolve queue promise
    const entry = activeRuns.get(sessionKey);
    if (entry?.requestId === requestId) {
      entry.resolveDone();
      activeRuns.delete(sessionKey);
      if (sessionQueues.get(sessionKey) === entry.done) {
        sessionQueues.delete(sessionKey);
      }
    }

    log(`[${requestId}] Spawn error:`, err.message);
    emitMonitorEvent('cli_error', { requestId, error: err.message });

    cleanupImages();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
  });
}

/**
 * Handle monitoring SSE endpoint
 */
function handleMonitorEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  monitorClients.add(res);
  log(`Monitor client connected (${monitorClients.size} total)`);

  req.on('close', () => {
    monitorClients.delete(res);
    log(`Monitor client disconnected (${monitorClients.size} remaining)`);
  });
}

/**
 * Handle GitHub webhook deploy trigger
 */
async function handleDeploy(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  // Validate HMAC-SHA256 signature
  if (!DEPLOY_SECRET) {
    log('[deploy] DEPLOY_WEBHOOK_SECRET not configured');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'webhook secret not configured' }));
    return;
  }

  const sig = req.headers['x-hub-signature-256'] || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', DEPLOY_SECRET).update(body).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    log('[deploy] Invalid webhook signature');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid signature' }));
    return;
  }

  // Only deploy on push to main
  const event = req.headers['x-github-event'];
  let payload;
  try { payload = JSON.parse(body); } catch { payload = {}; }

  if (event === 'push' && payload.ref !== 'refs/heads/main') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'skipped', reason: 'not main branch' }));
    return;
  }

  log(`[deploy] Webhook received: ${event} (${(payload.head_commit?.message || '').slice(0, 60)})`);

  // Respond immediately, then run update in background
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'deploying' }));

  // Spawn update.sh detached — it will git pull + restart the service
  const updateScript = path.join(__dirname, 'scripts', 'update.sh');
  const child = spawn('bash', [updateScript], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => log(`[deploy] ${d.toString().trim()}`));
  child.stderr.on('data', d => log(`[deploy] stderr: ${d.toString().trim()}`));
  child.unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, anthropic-version, x-api-key, x-session-key, x-regenerate');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  debug(`${req.method} ${url.pathname}`);

  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    try {
      await handleMessages(req, res);
    } catch (err) {
      log(`[Router Error]`, err.stack);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: 'Internal server error: ' + err.message } }));
      }
    }
  } else if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        {
          id: 'opus',
          name: 'Claude Opus 4.5 (CLI)',
          type: 'model',
          created_at: Date.now(),
        },
        {
          id: 'sonnet',
          name: 'Claude Sonnet 4.5 (CLI)',
          type: 'model',
          created_at: Date.now(),
        },
        {
          id: 'haiku',
          name: 'Claude Haiku 3.5 (CLI)',
          type: 'model',
          created_at: Date.now(),
        }
      ]
    }));
  } else if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      claude: CLAUDE_PATH,
      version: cliVersion,
      features: ['streaming', 'tool_use', 'thinking', 'monitoring', 'images', 'regenerate'],
      monitorClients: monitorClients.size
    }));
  } else if (req.method === 'GET' && url.pathname === '/events') {
    handleMonitorEvents(req, res);
  } else if (req.method === 'POST' && url.pathname === '/deploy') {
    await handleDeploy(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'not_found', message: 'Not found' } }));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Error: Port ${PORT} is already in use`);
    log(`Kill existing process: fuser -k ${PORT}/tcp`);
  } else {
    log('Server error:', err);
  }
  process.exit(1);
});

// Graceful shutdown: kill all tracked CLI children to prevent orphans
function gracefulShutdown(signal) {
  log(`Received ${signal}, killing ${activeRuns.size} active CLI processes...`);
  for (const [key, entry] of activeRuns) {
    entry.child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 2000);
}
if (require.main === module) {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  server.listen(PORT, '127.0.0.1', () => {
    const pkg = require('./package.json');
    log(`Claude CLI Proxy v${pkg.version} running on http://127.0.0.1:${PORT}`);
    log(`Claude path: ${CLAUDE_PATH}`);
    log(`Features: streaming, tool_use, thinking, monitoring, images, regenerate`);
    log(`Endpoints:`);
    log(`  POST /v1/messages  - Anthropic Messages API`);
    log(`  GET  /v1/models    - List models`);
    log(`  GET  /health       - Health check`);
    log(`  GET  /events       - SSE monitoring stream`);
  });
}

module.exports = {
  parseSender, sessionKeyToUuid, generateMessageId,
  extractJsonObjects, mapModelName, writeImagesToTmp,
  truncateSessionForRegenerate, gracefulShutdown,
  _server: server,
  _internals: {
    sessions, activeRuns, sessionQueues, monitorClients,
    IDLE_TIMEOUT_MS, TOOL_IDLE_TIMEOUT_MS, COMPACTION_TIMEOUT_MS, SESSION_TTL_MS,
    WORKSPACE, CLAUDE_CONFIG_DIR, CLAUDE_PATH, HOME
  }
};
