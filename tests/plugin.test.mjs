import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import AdminForthMcpPlugin from '../dist/index.js';
import { createPlugin, SECRET_OPTIONS } from './pluginHarness.mjs';

const CLIENT_ID = 'https://client.example/metadata.json';
const RESOURCE_METADATA = 'resource_metadata="https://admin.example/adminapi/v1/mcp/oauth-protected-resource"';

function addGrant(records, { id = 'grant-1', userId = 'user-1', clientId = CLIENT_ID } = {}) {
  records.push({ id, name: 'Claude Code', secret_hash: `hash-${id}`, user_id: userId, oauth_client_id: clientId });
}

const MCP_URL = 'https://admin.example/adminapi/v1/mcp';

function accessToken(adminforth, payload) {
  return `Bearer ${adminforth.auth.issueJWT({ aud: MCP_URL, ...payload }, 'mcp-oauth-access')}`;
}

async function createSecret(endpoints) {
  const response = { setHeader: () => {}, setStatus: () => {} };
  const { secret } = await endpoints.get('POST /mcp/auth-secrets').handler({
    body: { name: 'Codex', readOnly: false },
    adminUser: { pk: 'user-1', username: 'owner@example.com' },
    headers: {},
    query: {},
    cookies: [],
    response,
  });
  return secret;
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
