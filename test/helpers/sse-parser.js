/**
 * Parse raw SSE text into structured event objects.
 * @param {string} text - Raw SSE response body
 * @returns {{ event: string, data: object }[]}
 */
function parseSSE(text) {
  return text
    .split('\n\n')
    .filter(block => block.trim())
    .map(block => {
      const result = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) result.event = line.slice(7);
        if (line.startsWith('data: ')) {
          try {
            result.data = JSON.parse(line.slice(6));
          } catch {
            result.data = line.slice(6);
          }
        }
      }
      return result;
    })
    .filter(e => e.event || e.data);
}

module.exports = { parseSSE };
