import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminForthApiTools } from '../dist/apiTools.js';

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

const emptyInputSchema = { type: 'object', properties: {}, additionalProperties: true };

test('lists endpoints with handlers that are not hidden from agents', () => {
  assert.deepEqual(new AdminForthApiTools(adminforth, new Set()).list(false), [
    {
      name: 'delete_record',
      description: 'Delete record.',
      inputSchema: emptyInputSchema,
      annotations: { destructiveHint: true },
    },
    {
      name: 'get_resource',
      description: 'Get resource.',
      inputSchema: emptyInputSchema,
      annotations: { readOnlyHint: true },
    },
  ]);
});

test('lists only endpoints that only read data in read-only mode', async () => {
  const tools = new AdminForthApiTools(adminforth, new Set());

  assert.deepEqual(tools.list(true).map(({ name }) => name), ['get_resource']);
  assert.deepEqual(
    await tools.call({ name: 'delete_record', arguments: {}, headers: {}, readOnly: true }),
    { output: { error: 'Unknown tool: delete_record' }, isError: true },
  );
});
