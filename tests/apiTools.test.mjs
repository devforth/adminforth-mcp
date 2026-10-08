import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminForthApiTools } from '../dist/apiTools.js';

const PAGE_SIZE = { default: 10, max: 100 };
const API_PREFIX = '/adminapi/v1';

const carsResource = {
  resourceId: 'cars',
  label: 'Cars',
  columns: [
    { name: 'id', label: 'ID', type: 'string', primaryKey: true, required: { create: true } },
    { name: 'model', label: 'Model', type: 'string', filterOptions: { debounceTimeMs: 10 }, components: { list: 'X.vue' } },
    { name: 'notes', label: 'Notes', type: 'text', sortable: false },
    { name: 'owner_id', label: 'Owner', type: 'string', foreignResource: { resourceId: 'users', searchableFields: ['email'] } },
    { name: 'secret', label: 'Secret', type: 'string', backendOnly: true },
    { name: 'summary', label: 'Summary', type: 'string', virtual: true },
  ],
  options: {
    actions: [{ id: 'approve', name: 'Approve', customComponent: 'Approve.vue' }],
    pageInjections: { list: {} },
  },
};

function createAdminForth(endpoints) {
  return {
    config: {
      baseUrl: '',
      resources: [{
        resourceId: 'cars',
        dataSourceColumns: [
          { name: 'id', type: 'string' },
          { name: 'created_at', type: 'datetime' },
        ],
      }],
    },
    openApi: {
      registeredSchemas: endpoints.map((endpoint) => ({ method: 'POST', ...endpoint, path: `${API_PREFIX}${endpoint.path}` })),
      validateRequestSchema: () => ({ valid: true }),
      validateResponseSchema: () => ({ valid: true }),
    },
    tr: async (message) => message,
  };
}

function createTools(endpoints, { toolTimeoutMs = 1_000, hiddenResourceIds = [] } = {}) {
  return new AdminForthApiTools(createAdminForth(endpoints), new Set(hiddenResourceIds), PAGE_SIZE, toolTimeoutMs);
}

function callTool(tools, name, args, { readOnly = false } = {}) {
  return tools.call({
    name,
    arguments: args,
    adminUser: { pk: '1' },
    headers: {},
    requestUrl: `${API_PREFIX}/mcp`,
    abortSignal: new AbortController().signal,
    readOnly,
  });
}

function recordingEndpoint(path, output, extra = {}) {
  const calls = [];
  return {
    calls,
    endpoint: {
      path,
      request_schema: { type: 'object', required: ['resourceId'], properties: { resourceId: { type: 'string' } } },
      handler: async (input) => {
        calls.push(input);
        return typeof output === 'function' ? output(input) : output;
      },
      ...extra,
    },
  };
}

test('lists endpoints with handlers as tools, except the ones hidden from agents', () => {
  const tools = createTools([
    { path: '/get_resource', description: 'Gets a resource.', handler: async () => ({}) },
    { path: '/plugin/abc123/upload', handler: async () => ({}) },
    { path: '/mcp/auth-secrets', agent: { hiddenFromAgents: true }, handler: async () => ({}) },
    { path: '/mcp', agent: { hiddenFromAgents: true }, handler: async () => ({}) },
    // express routes annotated with withSchema have no handler
    { path: '/api/create-job/' },
  ]);

  assert.deepEqual(tools.list(false).map((tool) => tool.name), ['get_resource', 'plugin_abc123_upload']);
});

test('marks dangerous tools and asks for a confirmation in their description', () => {
  const tools = createTools([
    { path: '/delete_record', description: 'Deletes a record.', agent: { requiresHumanApproval: true }, handler: async () => ({}) },
  ]);

  const [tool] = tools.list(false);
  assert.deepEqual(tool.annotations, { destructiveHint: true });
  assert.match(tool.description, /^Deletes a record\. /);
  assert.match(tool.description, /wait for their explicit confirmation/);
});

test('omits the description of an undocumented tool', () => {
  const tools = createTools([{ path: '/plugin/abc123/upload', handler: async () => ({}) }]);

  assert.equal('description' in tools.list(false)[0], false);
});

test('compacts tool input schemas', () => {
  const tools = createTools([{
    path: '/create_record',
    handler: async () => ({}),
    request_schema: {
      type: 'object',
      title: 'Create record',
      properties: {
        record: { $ref: '#/$defs/Record', examples: [{ id: 1 }] },
        kind: { type: 'string', enum: ['title', 'examples'] },
      },
      $defs: {
        Record: { type: 'object', title: 'Record' },
        Unused: { type: 'string' },
      },
    },
  }]);

  assert.deepEqual(tools.list(false)[0].inputSchema, {
    type: 'object',
    properties: {
      record: { $ref: '#/$defs/Record' },
      kind: { type: 'string', enum: ['title', 'examples'] },
    },
    $defs: { Record: { type: 'object' } },
  });
});

test('get_resource returns only the essential columns by default', async () => {
  const { endpoint, calls } = recordingEndpoint('/get_resource', { resource: carsResource });
  const tools = createTools([endpoint]);

  const result = await callTool(tools, 'get_resource', { resourceId: 'cars' });

  assert.equal(result.isError, false);
  assert.deepEqual(result.output, {
    resource: {
      resourceId: 'cars',
      label: 'Cars',
      primaryKey: 'id',
      columns: [
        { name: 'id', label: 'ID', type: 'string' },
        { name: 'model', label: 'Model', type: 'string' },
        { name: 'notes', label: 'Notes', type: 'text', sortable: false },
        { name: 'owner_id', label: 'Owner', type: 'string', foreignResource: { resourceId: 'users' } },
      ],
    },
  });
  assert.deepEqual(calls[0].body, { resourceId: 'cars' });
});

test('get_resource with detailed: true drops only frontend-only properties and never passes detailed to the handler', async () => {
  const { endpoint, calls } = recordingEndpoint('/get_resource', { resource: carsResource });
  const tools = createTools([endpoint]);

  const result = await callTool(tools, 'get_resource', { resourceId: 'cars', detailed: true });

  const { resource } = result.output;
  assert.deepEqual(calls[0].body, { resourceId: 'cars' });
  assert.equal(resource.columns.length, carsResource.columns.length);
  assert.equal(resource.columns.some((column) => 'filterOptions' in column || 'components' in column), false);
  assert.deepEqual(resource.columns[0].required, { create: true });
  assert.deepEqual(resource.options, { actions: [{ id: 'approve', name: 'Approve' }] });
  // the handler response may be shared with the AdminForth config, so it must stay untouched
  assert.equal(carsResource.columns[1].filterOptions.debounceTimeMs, 10);
  assert.equal(carsResource.options.actions[0].customComponent, 'Approve.vue');
});

test('get_resource lists every column of a composite primary key', async () => {
  const { endpoint } = recordingEndpoint('/get_resource', {
    resource: {
      resourceId: 'cars',
      label: 'Cars',
      columns: [
        { name: 'vin', label: 'VIN', type: 'string', primaryKey: true },
        { name: 'region', label: 'Region', type: 'string', primaryKey: true },
      ],
    },
  });

  const result = await callTool(createTools([endpoint]), 'get_resource', { resourceId: 'cars' });

  assert.deepEqual(result.output.resource.primaryKey, ['vin', 'region']);
});

test('appends the plugin notes to the endpoint descriptions', () => {
  const tools = createTools([
    { path: '/get_resource', description: 'Gets a resource.', handler: async () => ({}) },
    { path: '/get_resource_data', description: 'Gets records.', handler: async () => ({}) },
  ]);

  const [getResource, getResourceData] = tools.list(false);
  assert.match(getResource.description, /^Gets a resource\. By default only the columns needed/);
  assert.match(getResourceData.description, /^Gets records\. Returns 10 rows unless limit is passed, and at most 100 rows per call;/);
});

test('get_resource advertises the detailed argument', () => {
  const { endpoint } = recordingEndpoint('/get_resource', {});
  const [tool] = createTools([endpoint]).list(false);

  assert.equal(tool.inputSchema.properties.detailed.type, 'boolean');
  assert.deepEqual(tool.inputSchema.required, ['resourceId']);
});

test('get_resource_data fills default arguments and makes them optional', async () => {
  const { endpoint, calls } = recordingEndpoint('/get_resource_data', { data: [], total: 0 }, {
    request_schema: {
      type: 'object',
      required: ['resourceId', 'source', 'limit', 'offset'],
      properties: {
        resourceId: { type: 'string' },
        source: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
  });
  const tools = createTools([endpoint]);

  assert.deepEqual(tools.list(false)[0].inputSchema.required, ['resourceId']);
  await callTool(tools, 'get_resource_data', { resourceId: 'cars' });
  assert.deepEqual(calls[0].body, { source: 'list', limit: 10, offset: 0, resourceId: 'cars' });
});

test('get_resource_data caps limit and says so', async () => {
  const { endpoint, calls } = recordingEndpoint('/get_resource_data', { data: [], total: 0 });
  const tools = createTools([endpoint]);

  const result = await callTool(tools, 'get_resource_data', { resourceId: 'cars', limit: 500 });

  assert.equal(calls[0].body.limit, 100);
  assert.equal(result.output.note, 'limit is capped at 100 rows per call.');
});

test('get_resource_data compacts rows', async () => {
  const { endpoint } = recordingEndpoint('/get_resource_data', {
    total: 1,
    recordIds: ['1'],
    data: [{
      id: '1',
      created_at: '2026-10-02T13:41:24.123Z',
      model: 'Model 3',
      // not a datetime column, so the same ISO string keeps its milliseconds
      serial: '2026-10-02T13:41:24.123Z',
      color: null,
      tags: [],
      meta: {},
      count: 0,
      enabled: false,
      _label: 'Model 3',
      _clickUrl: '/resource/cars/show/1',
    }],
  });
  const tools = createTools([endpoint]);

  const result = await callTool(tools, 'get_resource_data', { resourceId: 'cars' });

  assert.deepEqual(result.output, {
    total: 1,
    data: [{
      id: '1',
      created_at: '2026-10-02T13:41:24Z',
      model: 'Model 3',
      serial: '2026-10-02T13:41:24.123Z',
      count: 0,
      enabled: false,
    }],
  });
});

test('get_resource_data tells to ask the user before the next page only for page requests', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: String(index) }));
  const { endpoint } = recordingEndpoint('/get_resource_data', { data: rows, total: 25 });
  const tools = createTools([endpoint]);

  const defaultPage = await callTool(tools, 'get_resource_data', { resourceId: 'cars', offset: 10 });
  assert.equal(
    defaultPage.output.note,
    'Loaded 10 of 25 records (offset 10). Ask the user before loading more; the next page starts at offset 20.',
  );

  const exactCount = await callTool(tools, 'get_resource_data', { resourceId: 'cars', limit: 10 });
  assert.equal('note' in exactCount.output, false);
});

test('get_resource_data does not add a note when every record is loaded', async () => {
  const { endpoint } = recordingEndpoint('/get_resource_data', { data: [{ id: '1' }], total: 1 });

  const result = await callTool(createTools([endpoint]), 'get_resource_data', { resourceId: 'cars' });

  assert.equal('note' in result.output, false);
});

test('returns handler errors without projecting them', async () => {
  const { endpoint } = recordingEndpoint('/get_resource_data', { error: 'Resource not found' });

  const result = await callTool(createTools([endpoint]), 'get_resource_data', { resourceId: 'cars' });

  assert.deepEqual(result, { output: { error: 'Resource not found' }, isError: true });
});

test('answers a handler that returns nothing with an error', async () => {
  const tools = createTools([{ path: '/returns_nothing', handler: async () => {} }]);

  const result = await callTool(tools, 'returns_nothing', {});

  assert.deepEqual(result, {
    output: { error: 'Tool handler completed without returning a response.' },
    isError: true,
  });
});

test('refuses resources hidden from MCP', async () => {
  const { endpoint, calls } = recordingEndpoint('/get_resource_data', { data: [] });

  const result = await callTool(
    createTools([endpoint], { hiddenResourceIds: ['mcp_auth_secrets'] }),
    'get_resource_data',
    { resourceId: 'mcp_auth_secrets' },
  );

  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test('times out a slow handler and aborts its signal', async () => {
  let handlerSignal;
  const tools = createTools([{
    path: '/slow',
    handler: ({ abortSignal }) => {
      handlerSignal = abortSignal;
      return new Promise(() => {});
    },
  }], { toolTimeoutMs: 20 });

  const result = await callTool(tools, 'slow', {});

  assert.equal(result.isError, true);
  assert.match(result.output.error, /^Tool timed out after 0\.02 seconds\./);
  assert.equal(handlerSignal.aborted, true);
});

test('aborts the handler signal when the MCP request is aborted', async () => {
  let handlerSignal;
  const requestController = new AbortController();
  const tools = createTools([{
    path: '/slow',
    handler: ({ abortSignal }) => {
      handlerSignal = abortSignal;
      requestController.abort();
      return { ok: true };
    },
  }]);

  await tools.call({
    name: 'slow',
    arguments: {},
    adminUser: { pk: '1' },
    headers: {},
    requestUrl: `${API_PREFIX}/mcp`,
    abortSignal: requestController.signal,
  });

  assert.equal(handlerSignal.aborted, true);
});

test('lists only endpoints that only read data in read-only mode', async () => {
  const tools = createTools([
    { path: '/get_resource', description: 'Gets a resource.', agent: { onlyReadsData: true }, handler: async () => ({}) },
    { path: '/delete_record', description: 'Deletes a record.', agent: { requiresHumanApproval: true }, handler: async () => ({}) },
  ]);

  assert.deepEqual(tools.list(false).map((tool) => tool.name), ['delete_record', 'get_resource']);
  assert.deepEqual(tools.list(false).find((tool) => tool.name === 'get_resource').annotations, { readOnlyHint: true });
  assert.deepEqual(tools.list(true).map((tool) => tool.name), ['get_resource']);
  assert.deepEqual(
    await callTool(tools, 'delete_record', { resourceId: 'cars' }, { readOnly: true }),
    { output: { error: 'Unknown tool: delete_record' }, isError: true },
  );
});

test('names tools by the endpoint path without the baseUrl and API prefix', () => {
  const handler = async () => ({ ok: true });
  const adminforth = {
    config: { baseUrl: '/backoffice' },
    openApi: {
      registeredSchemas: [
        { method: 'post', path: '/backoffice/adminapi/v1/get_resource', description: 'Get resource.', agent: { onlyReadsData: true }, handler },
        { method: 'post', path: '/backoffice/adminapi/v1/delete_record', description: 'Delete record.', agent: { requiresHumanApproval: true }, handler },
        { method: 'post', path: '/backoffice/adminapi/v1/plugin/passkeys/deletePasskey', agent: { hiddenFromAgents: true }, handler },
        { method: 'post', path: '/backoffice/adminapi/v1/express_route', description: 'Express route.' },
      ],
    },
  };

  const tools = new AdminForthApiTools(adminforth, new Set(), PAGE_SIZE, 1_000).list(false);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.annotations]), [
    ['delete_record', { destructiveHint: true }],
    ['get_resource', { readOnlyHint: true }],
  ]);
});
