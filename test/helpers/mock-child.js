const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

/**
 * Create a mock child process for testing.
 *
 * @param {object} [options]
 * @param {string[]} [options.stdoutData] - Data chunks to push to stdout
 * @param {string} [options.stderrData] - Data to push to stderr
 * @param {number} [options.exitCode=0] - Exit code for close event
 * @param {boolean} [options.autoClose=true] - Auto-emit close after stdout data
 * @param {number} [options.closeDelay=10] - Delay before close (ms)
 * @returns {EventEmitter} Mock child process
 */
function createMockChild(options = {}) {
  const {
    stdoutData = [],
    stderrData,
    exitCode = 0,
    autoClose = true,
    closeDelay = 10,
  } = options;

  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345 + Math.floor(Math.random() * 10000);
  child.killed = false;

  child.kill = (signal) => {
    child.killed = true;
    child.emit('close', 1, signal);
  };

  if (stdoutData.length > 0 || autoClose) {
    process.nextTick(() => {
      for (const chunk of stdoutData) {
        child.stdout.push(typeof chunk === 'string' ? chunk : JSON.stringify(chunk));
      }
      if (autoClose) {
        setTimeout(() => {
          if (!child.killed) {
            child.emit('close', exitCode);
          }
        }, closeDelay);
      }
    });
  }

  if (stderrData) {
    process.nextTick(() => {
      child.stderr.push(stderrData);
    });
  }

  return child;
}

module.exports = { createMockChild };
