import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAgentName, readMcpClient } from '../dist/clientInfo.js';

test('reads modern per-request MCP client info', () => {
  assert.deepEqual(readMcpClient({
    method: 'tools/list',
    params: {
      _meta: {
        'io.modelcontextprotocol/clientInfo': {
          name: 'Claude Code',
          version: '2.1.0',
        },
      },
    },
  }, {}), { client: 'claude-code', ver: '2.1.0' });
});

test('reads legacy initialize client info and falls back to user-agent', () => {
  assert.deepEqual(readMcpClient({
    method: 'initialize',
    params: { clientInfo: { name: 'Gemini CLI', version: '1.2.3' } },
  }, {}), { client: 'gemini-cli', ver: '1.2.3' });

  assert.deepEqual(readMcpClient({ method: 'tools/list' }, {
    'user-agent': 'claude-code/4.5.6 node',
  }), { client: 'claude-code', ver: '4.5.6' });
});

test('normalizes known clients for audit attribution', () => {
  assert.equal(canonicalAgentName('undici'), 'codex');
  assert.equal(canonicalAgentName('claude-code'), 'claude-code');
  assert.equal(canonicalAgentName('gemini-cli'), 'gemini');
});
