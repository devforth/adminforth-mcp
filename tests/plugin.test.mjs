import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import AdminForthMcpPlugin from '../dist/index.js';
import { connectClient } from './inMemoryClient.mjs';
import { createPlugin, SECRET_OPTIONS } from './pluginHarness.mjs';

const CLIENT_ID = 'https://client.example/metadata.json';
const RESOURCE_METADATA = 'resource_metadata="https://admin.example/adminapi/v1/mcp/oauth-protected-resource"';

function addGrant(records, { id = 'grant-1', userId = 'user-1', clientId = CLIENT_ID } = {}) {
  records.push({ id, name: 'Claude Code', secret_hash: `hash-${id}`, user_id: userId, oauth_client_id: clientId });
}

const MCP_URL = 'https://admin.example/adminapi/v1/mcp';
const OWNER = { pk: 'user-1', username: 'owner@example.com' };
const SSE_DATA_RE = /^data: (.+)$/m;
const TOOL_SCHEMAS = [
  { method: 'GET', path: '/adminapi/v1/get_resource', agent: { onlyReadsData: true }, handler: async () => ({}) },
  { method: 'POST', path: '/adminapi/v1/delete_record', agent: { requiresHumanApproval: true }, handler: async () => ({}) },
];

function accessToken(adminforth, payload) {
  return `Bearer ${adminforth.auth.issueJWT({ aud: MCP_URL, ...payload }, 'mcp-oauth-access')}`;
}

async function createSecret(endpoints, adminUser = OWNER) {
  const response = { setHeader: () => {}, setStatus: () => {} };
  const { secret } = await endpoints.get('POST /mcp/auth-secrets').handler({
    body: { name: 'Codex', readOnly: false },
    adminUser,
    headers: {},
    query: {},
    cookies: [],
    response,
  });
  return secret;
}

async function listTools(callMcp, secret) {
  const { headers, message } = await callMcp(`Bearer ${secret}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const json = headers.get('content-type').startsWith('text/event-stream') ? message.match(SSE_DATA_RE)[1] : message;
  return JSON.parse(json).result.tools.map((tool) => tool.name);
}

test('authenticates an OAuth access token of an existing grant as the grant user', async () => {
  const { adminforth, records, authorizedUsers, callMcp } = createPlugin();
  addGrant(records);

  const { status } = await callMcp(accessToken(adminforth, { pk: 'user-1', grantId: 'grant-1' }));
  assert.equal(status, 200);
  assert.equal(authorizedUsers.length, 1);
  assert.equal(authorizedUsers[0].pk, 'user-1');
});

test('rejects access tokens that do not match a live OAuth grant of their user', async () => {
  const { adminforth, records, authorizedUsers, callMcp } = createPlugin();
  addGrant(records);
  addGrant(records, { id: 'secret-1', clientId: null });

  const rejected = {
    'grant of another user': accessToken(adminforth, { pk: 'user-2', grantId: 'grant-1' }),
    'personal auth secret record': accessToken(adminforth, { pk: 'user-1', grantId: 'secret-1' }),
    'unknown grant': accessToken(adminforth, { pk: 'user-1', grantId: 'grant-404' }),
    'token of another MCP server': accessToken(adminforth, { pk: 'user-1', grantId: 'grant-1', aud: 'https://other.example/adminapi/v1/mcp' }),
    'token without audience': accessToken(adminforth, { pk: 'user-1', grantId: 'grant-1', aud: undefined }),
    'authorization request JWT': `Bearer ${adminforth.auth.issueJWT({ pk: 'user-1', grantId: 'grant-1' }, 'mcp-oauth-request')}`,
    'authorization code JWT': `Bearer ${adminforth.auth.issueJWT({ pk: 'user-1', grantId: 'grant-1' }, 'mcp-oauth-code')}`,
    'admin session JWT': `Bearer ${adminforth.auth.issueJWT({ pk: 'user-1', grantId: 'grant-1' }, 'auth')}`,
    'random token': 'Bearer not-a-token',
  };
  for (const [name, authorization] of Object.entries(rejected)) {
    const { status, headers } = await callMcp(authorization);
    assert.equal(status, 401, name);
    assert.equal(headers.get('WWW-Authenticate'), `Bearer error="invalid_token", ${RESOURCE_METADATA}`, name);
  }
  assert.equal(authorizedUsers.length, 0);
});

test('stops accepting an access token once its grant is revoked', async () => {
  const { adminforth, records, callMcp } = createPlugin();
  addGrant(records);
  const authorization = accessToken(adminforth, { pk: 'user-1', grantId: 'grant-1' });

  assert.equal((await callMcp(authorization)).status, 200);
  records.length = 0;
  assert.equal((await callMcp(authorization)).status, 401);
});

test('points a request without a token to the OAuth metadata', async () => {
  const { callMcp } = createPlugin();
  const { status, headers } = await callMcp();
  assert.equal(status, 401);
  assert.equal(headers.get('WWW-Authenticate'), `Bearer ${RESOURCE_METADATA}`);
});

test('accepts personal auth secrets', async () => {
  const { endpoints, authorizedUsers, callMcp } = createPlugin();
  const secret = await createSecret(endpoints);

  assert.equal((await callMcp(`Bearer ${secret}`)).status, 200);
  assert.equal(authorizedUsers[0].pk, 'user-1');
});

test('registers the OAuth endpoints and the consent page', () => {
  const { endpoints, rawRoutes, adminforth } = createPlugin();

  assert.ok(endpoints.has('GET /mcp/oauth/authorize'));
  assert.ok(rawRoutes.has('POST /adminapi/v1/mcp/oauth/token'));
  assert.deepEqual(adminforth.config.customization.customPages.map((page) => page.path), ['/mcp-authorize']);
});

test('hides the auth secret resource from agents', () => {
  const { adminforth } = createPlugin();

  const authSecrets = adminforth.config.resources.find(({ resourceId }) => resourceId === 'mcp_auth_secrets');
  assert.deepEqual(authSecrets.options.agent, { hiddenFromAgents: true });
});

test('offers admin panel confirmation only with a 2FA plugin that verifies external requests', async () => {
  const contextualTwoFactorsAuth = { withVerificationContext: (verificationResult, extra, callback) => callback() };
  for (const [twoFactorsAuth, offered] of [[undefined, false], [{}, false], [contextualTwoFactorsAuth, true]]) {
    const { endpoints, adminforth, callMcp } = createPlugin({ twoFactorsAuth });
    const secret = await createSecret(endpoints);
    assert.equal(adminforth.config.customization.customPages.some((page) => page.path === '/mcp-confirm'), offered);
    assert.equal(endpoints.has('POST /mcp/confirmation/run'), offered);
    assert.equal((await listTools(callMcp, secret)).includes('wait_for_confirmation'), offered);
  }
});

test('reads form-encoded token requests and caps their size', async (t) => {
  const app = express();
  app.set('env', 'test');
  createPlugin({ expressApp: app });
  const server = app.listen(0);
  t.after(() => server.close());
  const post = (body, contentType) => fetch(`http://127.0.0.1:${server.address().port}/adminapi/v1/mcp/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });

  const form = await post(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'made-up', client_id: CLIENT_ID }).toString(), 'application/x-www-form-urlencoded');
  assert.equal(form.status, 400);
  assert.equal((await form.json()).error, 'invalid_grant');

  const notForm = await post('{}', 'application/json');
  assert.equal(notForm.status, 400);
  assert.equal((await notForm.json()).error, 'unsupported_grant_type');

  const tooLarge = await post(`grant_type=${'a'.repeat(17 * 1024)}`, 'application/x-www-form-urlencoded');
  assert.equal(tooLarge.status, 413);
});

test('gives the settings page the MCP URL built from adminPanelOrigin', async () => {
  const { endpoints } = createPlugin();
  const { mcpUrl } = await endpoints.get('GET /mcp/auth-secrets').handler({ adminUser: { pk: 'user-1' } });
  assert.equal(mcpUrl, 'https://admin.example/adminapi/v1/mcp');
});

test('requires https adminPanelOrigin for OAuth except on localhost', () => {
  for (const origin of ['http://admin.example', 'http://admin.example:3500', 'http://10.0.0.5']) {
    assert.throws(() => createPlugin({ adminPanelOrigin: origin }), /adminPanelOrigin must use https/, origin);
  }
  for (const origin of ['https://admin.example', 'http://localhost:3123', 'http://127.0.0.1:3500', 'http://[::1]:3500']) {
    assert.doesNotThrow(() => createPlugin({ adminPanelOrigin: origin }), origin);
  }
});

test('requires the oauthClientIdField column in the auth secret resource', () => {
  const plugin = new AdminForthMcpPlugin({
    adminPanelOrigin: 'https://admin.example',
    authSecretResource: SECRET_OPTIONS,
  });
  const columns = Object.values(SECRET_OPTIONS)
    .slice(1)
    .filter((name) => name !== SECRET_OPTIONS.oauthClientIdField)
    .map((name) => ({ name, primaryKey: name === 'id' }));
  const adminforth = {
    config: {
      baseUrl: '',
      auth: { usersResourceId: 'admin_users', usernameField: 'email' },
      customization: { brandName: 'Test Admin', customPages: [] },
      resources: [{ resourceId: 'mcp_auth_secrets', columns }],
    },
    codeInjector: { srcFoldersToSync: {}, allComponentNames: {} },
  };
  assert.throws(() => plugin.modifyGlobalConfig(adminforth), /column "oauth_client_id" not found/);
});

test('changes read-only mode of own connections within the readOnly option', async () => {
  const writers = new Set();
  const other = { pk: 'user-2', username: 'other@example.com' };
  const { endpoints, records, callMcp } = createPlugin({
    readOnly: async ({ adminUser }) => !writers.has(adminUser.pk),
    registeredSchemas: TOOL_SCHEMAS,
  });
  let status = 200;
  const setReadOnly = (readOnly, adminUser = OWNER) => endpoints.get('PATCH /mcp/auth-secrets').handler({
    body: { id: records[0].id, readOnly },
    adminUser,
    headers: {},
    query: {},
    cookies: [],
    response: { setHeader: () => {}, setStatus: (code) => { status = code; } },
  });

  const secret = await createSecret(endpoints);
  writers.add('user-1');
  assert.equal(records[0].read_only, true);
  assert.deepEqual(await listTools(callMcp, secret), ['get_resource', 'fetch_skill']);

  assert.deepEqual(await setReadOnly(false, other), { error: 'MCP auth secret not found' });
  assert.equal(status, 404);
  assert.equal(records[0].read_only, true);

  await setReadOnly(false);
  assert.equal(records[0].read_only, false);
  assert.deepEqual(await listTools(callMcp, secret), ['delete_record', 'get_resource', 'fetch_skill']);

  await setReadOnly(true);
  assert.equal(records[0].read_only, true);

  writers.delete('user-1');
  await setReadOnly(false);
  assert.equal(records[0].read_only, true);
});

test('applies a readOnly function to the user of every request', async () => {
  const writers = new Set(['user-2']);
  const other = { pk: 'user-2', username: 'other@example.com' };
  const { endpoints, records, callMcp } = createPlugin({
    readOnly: async ({ adminUser }) => !writers.has(adminUser.pk),
    registeredSchemas: TOOL_SCHEMAS,
  });

  const settings = endpoints.get('GET /mcp/auth-secrets');
  assert.equal((await settings.handler({ adminUser: OWNER })).serverReadOnly, true);
  assert.equal((await settings.handler({ adminUser: other })).serverReadOnly, false);

  await createSecret(endpoints);
  const secret = await createSecret(endpoints, other);
  assert.deepEqual(records.map((record) => record.read_only), [true, false]);

  assert.deepEqual(await listTools(callMcp, secret), ['delete_record', 'get_resource', 'fetch_skill']);
  writers.delete('user-2');
  assert.deepEqual(await listTools(callMcp, secret), ['get_resource', 'fetch_skill']);
});

const AGENT_SESSION = {
  adminUser: { ...OWNER, executedBy: 'af-agent' },
  connection: { id: 'agent-session-1', name: 'Agent' },
  readOnly: false,
  headers: { 'accept-language': 'uk', cookie: 'adminforth_jwt=session', Authorization: 'Bearer session' },
  requestUrl: '/adminapi/v1/agent/turn',
};

function recordingToolSchemas(calls, handler = async () => ({ ok: true })) {
  return TOOL_SCHEMAS.map((schema) => ({
    ...schema,
    handler: (input) => {
      calls.push(input);
      return handler(input);
    },
  }));
}

function skillsFolder(skillNames) {
  const folder = mkdtempSync(join(tmpdir(), 'adminforth-mcp-custom-'));
  for (const name of skillNames) {
    mkdirSync(join(folder, 'skills', name), { recursive: true });
    writeFileSync(join(folder, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}.\n---\n${name} body.\n`);
  }
  return folder;
}

test('opens an in-memory connection that calls tools as the session user', async () => {
  const calls = [];
  const { plugin } = createPlugin({ registeredSchemas: recordingToolSchemas(calls) });
  const client = await connectClient(await plugin.openConnection(AGENT_SESSION));

  assert.match(client.initialize.instructions, /fetch_skill/);
  assert.deepEqual((await client.call('tools/list')).tools.map((tool) => tool.name), ['delete_record', 'get_resource', 'fetch_skill']);
  const result = await client.call('tools/call', { name: 'delete_record', arguments: {} });
  assert.equal(result.isError, false);
  assert.equal(calls[0].adminUser, AGENT_SESSION.adminUser);
  assert.deepEqual(calls[0].headers, { 'accept-language': 'uk' });
  assert.equal(calls[0].requestUrl, AGENT_SESSION.requestUrl);
});

test('does not pass the MCP auth secret to tool handlers', async () => {
  const calls = [];
  const { endpoints, callMcp } = createPlugin({ registeredSchemas: recordingToolSchemas(calls) });
  const secret = await createSecret(endpoints);

  await callMcp(`Bearer ${secret}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_resource', arguments: {} } });

  assert.equal(calls.length, 1);
  assert.equal('authorization' in calls[0].headers, false);
});

test('applies the readOnly option to in-memory connections', async () => {
  const { plugin } = createPlugin({ readOnly: true, registeredSchemas: TOOL_SCHEMAS });
  const client = await connectClient(await plugin.openConnection(AGENT_SESSION));

  assert.deepEqual((await client.call('tools/list')).tools.map((tool) => tool.name), ['get_resource', 'fetch_skill']);
});

test('aborts a tool call when its MCP HTTP request is aborted', async () => {
  const calls = [];
  const { endpoints, callMcp } = createPlugin({
    registeredSchemas: recordingToolSchemas(calls, ({ abortSignal }) => new Promise((resolve) => {
      abortSignal.addEventListener('abort', () => resolve({ error: 'Aborted' }));
    })),
  });
  const secret = await createSecret(endpoints);
  const controller = new AbortController();

  const call = callMcp(
    `Bearer ${secret}`,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_resource', arguments: {} } },
    { abortSignal: controller.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await call.catch(() => {});
  assert.equal(calls[0].abortSignal.aborted, true);
});

test('offers skills of the project and of other plugins', async () => {
  const { plugin } = createPlugin({
    customComponentsDir: skillsFolder(['project-skill']),
    globalPlugins: [{ customFolderPath: skillsFolder(['global-plugin-skill']) }, { customFolderPath: join(tmpdir(), 'no-such-plugin') }],
    resourcePlugins: [{ customFolderPath: skillsFolder(['resource-plugin-skill']) }],
  });
  const client = await connectClient(await plugin.openConnection(AGENT_SESSION));
  const fetchSkill = (await client.call('tools/list')).tools.find((tool) => tool.name === 'fetch_skill');

  assert.deepEqual(
    fetchSkill.inputSchema.properties.skillName.enum,
    ['analyze-data', 'fetch-data', 'global-plugin-skill', 'mutate-data', 'project-skill', 'resource-plugin-skill'],
  );
});
