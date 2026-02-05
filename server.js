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
const { spawn } = require('child_process');
const { URL } = require('url');
const { EventEmitter } = require('events');

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || process.argv.find((_, i, a) => a[i-1] === '--port') || '8787', 10);
const CLAUDE_PATH = process.env.CLAUDE_PATH || '/home/alex/.local/bin/claude';
const DEBUG = process.env.DEBUG === '1';

// Timeout constants
const IDLE_TIMEOUT_MS = 60 * 1000;          // 60 sec without data = kill child
const TOOL_IDLE_TIMEOUT_MS = 300 * 1000;    // 5 min during tool execution (CLI runs tools locally)
const KEEPALIVE_INTERVAL_MS = 15 * 1000;    // 15 sec SSE ping

// Global event bus for monitoring
const proxyEvents = new EventEmitter();
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

  // Build full conversation context from all messages
  let prompt = '';

  // If system prompt provided, include it
  if (system) {
    let sysText = '';
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
    if (sysText) {
      prompt += `System: ${sysText}\n\n`;
    }
  }

  // Include all messages for context (not just last user message)
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }
    if (content) {
      prompt += `${role}: ${content}\n\n`;
    }
  }

  // Trim trailing newlines
  prompt = prompt.trim();

  // Map model names
  let cliModel = model
    .replace(/^anthropic\//, '')
    .replace(/^claude-cli\//, '')
    .replace(/-20\d{6}$/, ''); // Remove date suffix

  // Common aliases - map to Claude Max plan model flags
  if (cliModel.includes('opus')) cliModel = 'opus';
  else if (cliModel.includes('sonnet')) cliModel = 'sonnet';
  else if (cliModel.includes('haiku')) cliModel = 'haiku';

  debug('Model:', model, '->', cliModel);
  debug('Prompt length:', prompt.length);
  debug('Stream requested:', stream);

  // Emit request started event
  emitMonitorEvent('request_start', {
    requestId,
    model: cliModel,
    promptLength: prompt.length,
    stream,
    promptPreview: prompt.slice(0, 100)
  });

  // Build CLI args
  const args = [
    '--print',
    '--output-format', stream ? 'stream-json' : 'json',
    '--dangerously-skip-permissions',
    '--model', cliModel,
  ];

  // stream-json requires --verbose
  if (stream) {
    args.push('--verbose');
    args.push('--include-partial-messages');  // Enable text_delta streaming
  }

  // Prompt will be passed via stdin to avoid E2BIG error for large prompts
  // (Linux has MAX_ARG_STRLEN ~128KB limit per argument)

  log(`[${requestId}] Spawning: claude ${args.join(' ')} [prompt via stdin: ${prompt.length} chars]`);

  emitMonitorEvent('cli_spawn', {
    requestId,
    model: cliModel,
    args: args.slice(0, 6)
  });

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const child = spawn(CLAUDE_PATH, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Write prompt to stdin to avoid E2BIG for large prompts
  child.stdin.write(prompt);
  child.stdin.end();

  if (stream) {
    await handleStreamingResponse(req, res, child, model, requestId);
  } else {
    await handleNonStreamingResponse(req, res, child, model, requestId);
  }
}

/**
 * Handle streaming response with full Anthropic event compatibility
 */
async function handleStreamingResponse(req, res, child, model, requestId) {
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
  };

  // Idle timeout - kill child if no output for configured period
  let idleTimeout;
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeout);
    const timeoutMs = state.toolExecuting ? TOOL_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
    idleTimeout = setTimeout(() => {
      log(`[${requestId}] Idle timeout (${timeoutMs}ms, toolExecuting=${state.toolExecuting}), killing child`);
      emitMonitorEvent('cli_timeout', { requestId, type: 'idle', toolExecuting: state.toolExecuting });
      child.kill('SIGTERM');
    }, timeoutMs);
  };
  resetIdleTimeout();

  // SSE keepalive disabled - was causing issues with some clients
  const keepaliveInterval = null;

  // Handle client disconnect
  req.on('close', () => {
    log(`[${requestId}] Client disconnected, killing child`);
    clearTimeout(idleTimeout);
    clearInterval(keepaliveInterval);
    child.kill('SIGTERM');
  });

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

    // Extract complete JSON objects from buffer using brace counting
    // This handles concatenated JSON (no newline between objects) correctly
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
            // Complete JSON object found
            const jsonStr = buffer.slice(startIndex, i + 1);
            try {
              const event = JSON.parse(jsonStr);
              // Handle raw events (new in 2.1.29) or wrapped stream_event (Phase 1)
              if (event.type === 'stream_event' && event.event) {
                processStreamEvent(event.event, res, state, contentBlocks, messageId, model, requestId);
              } else {
                processStreamEvent(event, res, state, contentBlocks, messageId, model, requestId);
              }
            } catch (e) {
              log(`[${requestId}] JSON parse error: ${e.message}, json: ${jsonStr.slice(0, 100)}`);
            }
            startIndex = i + 1;
          }
        }
      }
    }

    // Keep unparsed remainder in buffer (incomplete JSON or whitespace/newlines before next object)
    buffer = buffer.slice(startIndex);
  });

  child.stderr.on('data', (data) => {
    const stderr = data.toString();
    debug('stderr:', stderr);
    emitMonitorEvent('cli_stderr', { requestId, message: stderr });
  });

  child.on('close', (code) => {
    // Clear timeouts
    clearTimeout(idleTimeout);
    clearInterval(keepaliveInterval);

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
    // Clear timeouts
    clearTimeout(idleTimeout);
    clearInterval(keepaliveInterval);

    log(`[${requestId}] Spawn error:`, err.message);
    emitMonitorEvent('cli_error', { requestId, error: err.message });

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
      const delta = e.delta;

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

    // Handle system_event (API calls, tool results, etc.)
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
          delta: { type: 'text_delta', text: e.result }
        });
      }
      return;
    }
  }
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(req, res, child, model, requestId) {
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => {
    stderr += data;
    emitMonitorEvent('cli_stderr', { requestId, message: data.toString() });
  });

  child.on('close', (code) => {
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

    try {

      const response = {
        id: requestId,
        type: 'message',
        role: 'assistant',
        model: model,
        content: [{ type: 'text', text: result.result || '' }],
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
    log(`[${requestId}] Spawn error:`, err.message);
    emitMonitorEvent('cli_error', { requestId, error: err.message });

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, anthropic-version, x-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  debug(`${req.method} ${url.pathname}`);

  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await handleMessages(req, res);
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
      version: '2.0.0',
      features: ['streaming', 'tool_use', 'thinking', 'monitoring'],
      monitorClients: monitorClients.size
    }));
  } else if (req.method === 'GET' && url.pathname === '/events') {
    handleMonitorEvents(req, res);
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

server.listen(PORT, '127.0.0.1', () => {
  log(`Claude CLI Proxy v2.0 running on http://127.0.0.1:${PORT}`);
  log(`Claude path: ${CLAUDE_PATH}`);
  log(`Features: streaming, tool_use, thinking, monitoring`);
  log(`Endpoints:`);
  log(`  POST /v1/messages  - Anthropic Messages API`);
  log(`  GET  /v1/models    - List models`);
  log(`  GET  /health       - Health check`);
  log(`  GET  /events       - SSE monitoring stream`);
});
