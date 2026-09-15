import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAgentName, formatMcpExecutedBy, readMcpClient } from '../dist/clientInfo.js';

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
  assert.equal(
    formatMcpExecutedBy({ client: 'codex-cli', ver: '1.2.3' }, 'Production Codex'),
    'codex@1.2.3 | Production Codex',
  );
});

test('sanitizes attacker-controlled client name and version', () => {
  // a version is free-form client input: it must not be able to forge the "| <auth secret name>"
  // part of the audit attribution, and it must stay short enough to be stored safely
  assert.deepEqual(readMcpClient({
    method: 'initialize',
    params: { clientInfo: { name: 'Codex', version: '1.0 | Production Codex' } },
  }, {}), { client: 'codex', ver: '1.0ProductionCodex' });

  assert.equal(
    formatMcpExecutedBy(
      readMcpClient({
        method: 'initialize',
        params: { clientInfo: { name: 'Codex', version: '1 | Root Key' } },
      }, {}),
      'My Key',
    ),
    'codex@1RootKey | My Key',
  );

  assert.equal(readMcpClient({
    method: 'initialize',
    params: { clientInfo: { name: 'Codex', version: 'v'.repeat(500) } },
  }, {}).ver.length, 32);

  assert.equal(readMcpClient({
    method: 'initialize',
    params: { clientInfo: { name: 'x'.repeat(500), version: '1.0.0' } },
  }, {}).client.length, 64);

  assert.deepEqual(readMcpClient({
    method: 'initialize',
    params: { clientInfo: { name: 'Codex', version: { toString: () => 'nope' } } },
  }, {}), { client: 'codex', ver: null });
});

test('falls back to user-agent and unknown agent when client name is unusable', () => {
  assert.deepEqual(readMcpClient({
    method: 'initialize',
    params: { clientInfo: { name: '***', version: '1.0.0' } },
  }, { 'user-agent': 'undici/6.0.0' }), { client: 'undici', ver: '6.0.0' });

  assert.deepEqual(
    readMcpClient({ method: 'initialize', params: { clientInfo: { name: 42 } } }, {}),
    { client: 'unknown-agent', ver: null },
  );
});
