import test from 'node:test';
import assert from 'node:assert/strict';
import AdminForthMcpPlugin from '../dist/index.js';
import { createPlugin, SECRET_OPTIONS } from './pluginHarness.mjs';

const CLIENT_ID = 'https://client.example/metadata.json';
const RESOURCE_METADATA = 'resource_metadata="https://admin.example/adminapi/v1/mcp/oauth-protected-resource"';

function addGrant(records, { id = 'grant-1', userId = 'user-1', clientId = CLIENT_ID } = {}) {
  records.push({ id, name: 'Claude Code', secret_hash: `hash-${id}`, user_id: userId, oauth_client_id: clientId });
}

function accessToken(adminforth, payload) {
  return `Bearer ${adminforth.auth.issueJWT(payload, 'mcp-oauth-access')}`;
}

async function createSecret(endpoints) {
  const response = { setHeader: () => {}, setStatus: () => {} };
  const { secret } = await endpoints.get('POST /mcp/auth-secrets').handler({
    body: { name: 'Codex' },
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
  assert.notEqual(status, 401);
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

  assert.notEqual((await callMcp(authorization)).status, 401);
  records.length = 0;
  assert.equal((await callMcp(authorization)).status, 401);
});

test('points a request without a token to the OAuth metadata', async () => {
  const { callMcp } = createPlugin();
  const { status, headers } = await callMcp();
  assert.equal(status, 401);
  assert.equal(headers.get('WWW-Authenticate'), `Bearer ${RESOURCE_METADATA}`);
});

test('accepts personal auth secrets with OAuth enabled', async () => {
  const { endpoints, authorizedUsers, callMcp } = createPlugin();
  const secret = await createSecret(endpoints);

  assert.notEqual((await callMcp(`Bearer ${secret}`)).status, 401);
  assert.equal(authorizedUsers[0].pk, 'user-1');
});

test('enables OAuth only with oauthClientIdField', async () => {
  const enabled = createPlugin();
  const disabled = createPlugin({ oauth: false });

  assert.ok(enabled.endpoints.has('GET /mcp/oauth/authorize'));
  assert.ok(enabled.rawRoutes.has('POST /adminapi/v1/mcp/oauth/token'));
  assert.deepEqual(enabled.adminforth.config.customization.customPages.map((page) => page.path), ['/mcp-authorize']);

  assert.deepEqual([...disabled.endpoints.keys()].filter((key) => key.includes('oauth')), []);
  assert.equal(disabled.rawRoutes.size, 0);
  assert.deepEqual(disabled.adminforth.config.customization.customPages, []);

  const list = async ({ endpoints }) => endpoints.get('GET /mcp/auth-secrets').handler({ adminUser: { pk: 'user-1' } });
  assert.equal((await list(enabled)).oauthEnabled, true);
  assert.equal((await list(disabled)).oauthEnabled, false);
});

test('gives the settings page the MCP URL built from adminPanelOrigin, if configured', async () => {
  const list = async ({ endpoints }) => endpoints.get('GET /mcp/auth-secrets').handler({ adminUser: { pk: 'user-1' } });
  assert.equal((await list(createPlugin({ oauth: false }))).mcpUrl, 'https://admin.example/adminapi/v1/mcp');
  assert.equal((await list(createPlugin({ oauth: false, adminPanelOrigin: null }))).mcpUrl, null);
});

test('without OAuth accepts auth secrets only and answers like before OAuth', async () => {
  const { adminforth, records, endpoints, authorizedUsers, callMcp } = createPlugin({ oauth: false });
  addGrant(records);

  const withAccessToken = await callMcp(accessToken(adminforth, { pk: 'user-1', grantId: 'grant-1' }));
  assert.equal(withAccessToken.status, 401);
  assert.equal(withAccessToken.headers.get('WWW-Authenticate'), 'Bearer');
  assert.equal((await callMcp()).headers.get('WWW-Authenticate'), 'Bearer');

  const secret = await createSecret(endpoints);
  assert.notEqual((await callMcp(`Bearer ${secret}`)).status, 401);
  assert.equal(authorizedUsers.length, 1);
  assert.equal('oauth_client_id' in records.at(-1), false);
});

test('requires adminPanelOrigin when OAuth is enabled', () => {
  assert.throws(() => createPlugin({ adminPanelOrigin: null }), /adminPanelOrigin is required/);
  assert.doesNotThrow(() => createPlugin({ oauth: false, adminPanelOrigin: null }));
});

test('requires the oauthClientIdField column in the auth secret resource', () => {
  const plugin = new AdminForthMcpPlugin({
    adminPanelOrigin: 'https://admin.example',
    authSecretResource: { ...SECRET_OPTIONS, oauthClientIdField: 'oauth_client_id' },
  });
  const columns = Object.values(SECRET_OPTIONS).slice(1).map((name) => ({ name, primaryKey: name === 'id' }));
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
