import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpProtocol } from '../dist/mcpProtocol.js';

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'Codex', version: '1.0.0' },
};

test('serves deterministic modern tools/list results', async () => {
  const response = await handleMcpProtocol({
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: modernMeta },
    },
    headers: {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/list',
    },
    listTools: () => [{
      name: 'get_resource',
      inputSchema: { type: 'object', properties: {} },
    }],
    callTool: async () => ({ output: null, isError: false }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.result.resultType, 'complete');
  assert.equal(response.body.result.cacheScope, 'private');
  assert.equal(response.body.result.tools[0].name, 'get_resource');
});

test('rejects mismatched modern request headers', async () => {
  const response = await handleMcpProtocol({
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_resource', arguments: {}, _meta: modernMeta },
    },
    headers: {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'wrong_tool',
    },
    listTools: () => [],
    callTool: async () => ({ output: null, isError: false }),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, -32020);
});

test('supports legacy initialize and tool calls', async () => {
  const initialize = await handleMcpProtocol({
    body: {
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    },
    headers: {},
    listTools: () => [],
    callTool: async () => ({ output: null, isError: false }),
  });
  assert.equal(initialize.body.result.protocolVersion, '2025-06-18');

  const call = await handleMcpProtocol({
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_resource', arguments: { resourceId: 'cars' } },
    },
    headers: {},
    listTools: () => [],
    callTool: async () => ({ output: { resourceId: 'cars' }, isError: false }),
  });
  assert.match(call.body.result.content[0].text, /cars/);
  assert.equal(call.body.result.isError, false);
});

test('negotiates the latest legacy version when the requested version is unsupported', async () => {
  const response = await handleMcpProtocol({
    body: {
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    },
    headers: {},
    listTools: () => [],
    callTool: async () => ({ output: null, isError: false }),
  });

  assert.equal(response.body.result.protocolVersion, '2025-11-25');
});
