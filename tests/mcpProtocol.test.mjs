import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServerPresentation, McpProtocol } from '../dist/mcpProtocol.js';

const SSE_DATA_RE = /^data: (.+)$/m;

const protocol = new McpProtocol();
const serverPresentation = createMcpServerPresentation('Acme Cars', 'https://admin.acme.example/backoffice');

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'Codex', version: '1.0.0' },
};

async function send(body, {
  headers = {},
  listTools = () => [],
  callTool = async () => ({ output: null, isError: false }),
} = {}) {
  const request = new Request('https://admin.acme.example/backoffice/adminapi/v1/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  });
  const response = await protocol.handle(request, body, { ...serverPresentation, listTools, callTool });
  const text = await response.text();
  const json = response.headers.get('content-type').startsWith('text/event-stream')
    ? text.match(SSE_DATA_RE)[1]
    : text;
  return { status: response.status, body: JSON.parse(json) };
}

function callTool(name, arguments_, output) {
  return send(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } },
    { callTool: async () => ({ output, isError: false }) },
  );
}

test('identifies an admin panel by brand and URL', () => {
  const presentation = createMcpServerPresentation('Internal CRM', 'https://crm.example/');

  assert.equal(presentation.serverInfo.title, 'Internal CRM Admin Panel');
  assert.equal(presentation.serverInfo.description, 'AdminForth admin panel for "Internal CRM" at https://crm.example/.');
  assert.equal(presentation.serverInfo.websiteUrl, 'https://crm.example/');
  assert.match(presentation.instructions, /AdminForth admin panel for "Internal CRM" at https:\/\/crm.example\//);
});

test('serves deterministic modern tools/list results', async () => {
  const response = await send(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta } },
    {
      headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
      listTools: () => [{ name: 'get_resource', inputSchema: { type: 'object', properties: {} } }],
    },
  );

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
  const response = await send(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_resource', arguments: {}, _meta: modernMeta } },
    { headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'wrong_tool' } },
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, -32020);
});

test('supports legacy initialize and tool calls', async () => {
  const initialize = await send({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Codex', version: '1.0.0' } },
  });
  assert.equal(initialize.body.result.protocolVersion, '2025-06-18');
  assert.equal(initialize.body.result.serverInfo.title, 'Acme Cars Admin Panel');
  assert.equal(initialize.body.result.serverInfo.websiteUrl, 'https://admin.acme.example/backoffice');
  assert.match(initialize.body.result.instructions, /admin panel for "Acme Cars" at https:\/\/admin\.acme\.example\/backoffice/);

  const call = await callTool('get_resource', { resourceId: 'cars' }, { resourceId: 'cars' });
  assert.match(call.body.result.content[0].text, /cars/);
  assert.equal(call.body.result.isError, false);
});

test('serializes tool output as YAML, dropping values JSON cannot hold', async () => {
  const call = await callTool('get_resource', { resourceId: 'cars' }, {
    resource: { resourceId: 'cars', hook: async () => {}, missing: undefined, columns: [{ name: 'id' }] },
  });

  assert.equal(call.body.result.content[0].text, 'resource:\n  resourceId: cars\n  columns:\n    - name: id\n');
});

test('passes string tool output as is', async () => {
  const call = await callTool('fetch_skill', { skillName: 'fetch_data' }, '# Fetch data\n');

  assert.equal(call.body.result.content[0].text, '# Fetch data\n');
});

test('negotiates the latest legacy version when the requested version is unsupported', async () => {
  const response = await send({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: { protocolVersion: '2023-01-01', capabilities: {}, clientInfo: { name: 'Codex', version: '1.0.0' } },
  });

  assert.equal(response.body.result.protocolVersion, '2025-11-25');
});

test('answers a tool call whose handler returns nothing', async () => {
  const call = await callTool('start_custom_action', {}, undefined);

  assert.equal(call.body.result.isError, false);
  assert.equal(call.body.result.content[0].text, 'null\n');
});
