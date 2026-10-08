import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMcpServerPresentation,
  handleMcpProtocol,
} from '../dist/mcpProtocol.js';

const serverPresentation = createMcpServerPresentation('Acme Cars', 'https://admin.acme.example/backoffice');

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'Codex', version: '1.0.0' },
};

test('identifies an admin panel by brand when no canonical URL is configured', () => {
  const presentation = createMcpServerPresentation('Internal CRM');

  assert.equal(presentation.serverInfo.title, 'Internal CRM Admin Panel');
  assert.equal(presentation.serverInfo.description, 'AdminForth admin panel for "Internal CRM".');
  assert.equal('websiteUrl' in presentation.serverInfo, false);
  assert.match(presentation.instructions, /AdminForth admin panel for "Internal CRM"/);
});

test('identifies an admin panel by brand and URL', () => {
  const presentation = createMcpServerPresentation('Internal CRM', 'https://crm.example/');

  assert.equal(presentation.serverInfo.title, 'Internal CRM Admin Panel');
  assert.equal(presentation.serverInfo.description, 'AdminForth admin panel for "Internal CRM" at https://crm.example/.');
  assert.equal(presentation.serverInfo.websiteUrl, 'https://crm.example/');
  assert.match(presentation.instructions, /AdminForth admin panel for "Internal CRM" at https:\/\/crm.example\//);
});

test('serves deterministic modern tools/list results', async () => {
  const response = await handleMcpProtocol({
    ...serverPresentation,
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
  assert.equal(
    response.body.result._meta['io.modelcontextprotocol/serverInfo'].title,
    'Acme Cars Admin Panel',
  );
});

test('rejects mismatched modern request headers', async () => {
  const response = await handleMcpProtocol({
    ...serverPresentation,
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
    ...serverPresentation,
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
  assert.equal(initialize.body.result.serverInfo.title, 'Acme Cars Admin Panel');
  assert.equal(initialize.body.result.serverInfo.websiteUrl, 'https://admin.acme.example/backoffice');
  assert.match(initialize.body.result.instructions, /admin panel for "Acme Cars" at https:\/\/admin\.acme\.example\/backoffice/);

  const call = await handleMcpProtocol({
    ...serverPresentation,
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

test('serializes tool output as YAML, dropping values JSON cannot hold', async () => {
  const call = await handleMcpProtocol({
    ...serverPresentation,
    body: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_resource', arguments: { resourceId: 'cars' } },
    },
    headers: {},
    listTools: () => [],
    callTool: async () => ({
      output: { resource: { resourceId: 'cars', hook: async () => {}, missing: undefined, columns: [{ name: 'id' }] } },
      isError: false,
    }),
  });

  assert.equal(call.body.result.content[0].text, 'resource:\n  resourceId: cars\n  columns:\n    - name: id\n');
});

test('passes string tool output as is', async () => {
  const call = await handleMcpProtocol({
    ...serverPresentation,
    body: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'fetch_skill', arguments: { skillName: 'fetch_data' } },
    },
    headers: {},
    listTools: () => [],
    callTool: async () => ({ output: '# Fetch data\n', isError: false }),
  });

  assert.equal(call.body.result.content[0].text, '# Fetch data\n');
});

test('negotiates the latest legacy version when the requested version is unsupported', async () => {
  const response = await handleMcpProtocol({
    ...serverPresentation,
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

test('answers a tool call whose handler returns nothing', async () => {
  const call = await handleMcpProtocol({
    ...serverPresentation,
    body: {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'start_custom_action', arguments: {} },
    },
    headers: {},
    listTools: () => [],
    callTool: async () => ({ output: undefined, isError: false }),
  });

  assert.equal(call.body.result.isError, false);
  assert.equal(call.body.result.content[0].text, 'null\n');
});
