import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import https from 'node:https';
import { McpAuthSecretStore } from '../dist/authSecretStore.js';
import { McpOAuth } from '../dist/oauth.js';
import { fetchClientMetadata, isSpecialPurposeAddress, redirectUriMatches } from '../dist/oauthClientMetadata.js';
import { createMcpUrls } from '../dist/urls.js';

const options = {
  resourceId: 'mcp_auth_secrets',
  idField: 'id',
  nameField: 'name',
  secretHashField: 'secret_hash',
  userIdField: 'user_id',
  createdAtField: 'created_at',
  lastUsedAtField: 'last_used_at',
  lastUsedByAgentField: 'last_used_by_agent',
  readOnlyField: 'read_only',
  oauthClientIdField: 'oauth_client_id',
};
const CLIENT_ID = 'https://client.example/oauth/metadata.json';
const REDIRECT_URI = 'http://127.0.0.1:51234/callback';
const CODE_VERIFIER = 'verifier-verifier-verifier-verifier-verifier';
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');

function matches(record, filter) {
  if (filter.operator === 'and') return filter.subFilters.every((subFilter) => matches(record, subFilter));
  return (record[filter.field] ?? null) === filter.value;
}

const DEV_CLIENT = { clientId: 'local-test', clientName: 'Local test', redirectUris: ['http://127.0.0.1/callback'] };
const CLAUDE_CLIENT = { clientId: CLIENT_ID, clientName: 'Claude Code', redirectUris: ['http://127.0.0.1/callback'] };

function setup({ serverReadOnly = false } = {}) {
  const records = [];
  const users = { 'user-1': { id: 'user-1', email: 'owner@example.com' } };
  const userRecord = users['user-1'];
  const jwtSecrets = new Map();
  const db = { inFlight: 0, maxInFlight: 0 };
  const adminforth = {
    config: {
      baseUrl: '/admin',
      auth: { usersResourceId: 'admin_users', usernameField: 'email' },
      resources: [
        { resourceId: 'mcp_auth_secrets' },
        { resourceId: 'admin_users', columns: [{ name: 'id', primaryKey: true }] },
      ],
    },
    auth: {
      issueJWT: (payload, type) => {
        const token = `jwt-${jwtSecrets.size}`;
        jwtSecrets.set(token, { ...payload, t: type });
        return token;
      },
      verify: async (token, type) => {
        const payload = jwtSecrets.get(token);
        return payload?.t === type ? payload : null;
      },
    },
    resource: (resourceId) => resourceId === 'mcp_auth_secrets'
      ? {
        // Like a database query: the row is read when the query starts and returned a tick later, so concurrent
        // requests interleave and a request does not see an update made after its read.
        get: async (filter) => {
          const record = records.find((candidate) => matches(candidate, filter));
          const row = record ? { ...record } : null;
          db.inFlight += 1;
          db.maxInFlight = Math.max(db.maxInFlight, db.inFlight);
          await new Promise((resolve) => setImmediate(resolve));
          db.inFlight -= 1;
          return row;
        },
        update: async (id, values) => Object.assign(records.find((record) => record.id === id), values),
        delete: async (id) => records.splice(records.findIndex((record) => record.id === id), 1),
      }
      : { get: async (filter) => users[filter.value] ?? null },
    createResourceRecord: async ({ record }) => {
      records.push(record);
      return { ok: true };
    },
  };
  const store = new McpAuthSecretStore(adminforth, options);
  const oauth = new McpOAuth(adminforth, store, createMcpUrls('https://admin.example', '/admin'), [DEV_CLIENT, CLAUDE_CLIENT], serverReadOnly);
  const adminUser = { pk: 'user-1', username: 'owner@example.com', dbUser: userRecord };
  const signedRequest = adminforth.auth.issueJWT({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: CODE_CHALLENGE,
    state: 'state-1',
  }, 'mcp-oauth-request');
  return { records, store, oauth, adminUser, signedRequest, jwtSecrets, users, db };
}

async function approve(oauth, signedRequest, adminUser) {
  const redirect = new URL(await oauth.resolveAuthorization(signedRequest, true, adminUser));
  return redirect.searchParams.get('code');
}

test('publishes metadata under the MCP endpoint path', () => {
  const { oauth } = setup();
  const resource = oauth.protectedResourceMetadata();
  assert.equal(resource.resource, 'https://admin.example/admin/adminapi/v1/mcp');
  assert.deepEqual(resource.authorization_servers, ['https://admin.example/admin/adminapi/v1/mcp']);
  assert.equal(oauth.resourceMetadataUrl, 'https://admin.example/admin/adminapi/v1/mcp/oauth-protected-resource');

  const server = oauth.authorizationServerMetadata();
  assert.equal(server.issuer, resource.authorization_servers[0]);
  assert.equal(server.token_endpoint, 'https://admin.example/admin/adminapi/v1/mcp/oauth/token');
  assert.equal(server.authorization_endpoint, 'https://admin.example/admin/adminapi/v1/mcp/oauth/authorize');
});

test('describes and denies an authorization request', async () => {
  const { oauth, adminUser, signedRequest } = setup();
  assert.deepEqual(await oauth.describeAuthorization(signedRequest), {
    clientName: 'Claude Code',
    clientHost: 'client.example',
    redirectHost: '127.0.0.1:51234',
    loopbackRedirect: true,
    serverReadOnly: false,
  });

  const redirect = new URL(await oauth.resolveAuthorization(signedRequest, false, adminUser));
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('state'), 'state-1');
  assert.equal(redirect.searchParams.get('iss'), 'https://admin.example/admin/adminapi/v1/mcp');
  assert.equal(redirect.searchParams.has('code'), false);
});

test('redeems a code once, rotates refresh tokens and authenticates access tokens against the grant', async () => {
  const { records, store, oauth, adminUser, signedRequest } = setup();
  const code = await approve(oauth, signedRequest, adminUser);
  const redeem = (overrides = {}) => oauth.exchangeToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: CODE_VERIFIER,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    ...overrides,
  });

  await assert.rejects(redeem({ code_verifier: 'wrong' }), { code: 'invalid_grant' });
  await assert.rejects(redeem({ client_id: 'https://other.example/metadata.json' }), { code: 'invalid_grant' });

  const tokens = await redeem();
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'Claude Code');
  assert.equal(records[0].oauth_client_id, CLIENT_ID);
  assert.equal(records[0].secret_hash, createHash('sha256').update(tokens.refresh_token).digest('hex'));
  await assert.rejects(redeem(), { code: 'invalid_grant', message: 'Authorization code was already used' });

  const accessToken = await oauth.verifyAccessToken(tokens.access_token);
  const authenticated = await store.authenticateOAuthGrant(accessToken.grantId, accessToken.pk);
  assert.equal(authenticated.adminUser.username, 'owner@example.com');
  assert.equal(authenticated.recordId, records[0].id);

  const refresh = (refreshToken, clientId = CLIENT_ID) => oauth.exchangeToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  await assert.rejects(refresh(tokens.refresh_token, 'https://other.example/metadata.json'), { code: 'invalid_grant' });
  const refreshed = await refresh(tokens.refresh_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  await assert.rejects(refresh(tokens.refresh_token), { code: 'invalid_grant' });

  records.length = 0;
  const revoked = await oauth.verifyAccessToken(refreshed.access_token);
  assert.equal(await store.authenticateOAuthGrant(revoked.grantId, revoked.pk), null);
});

test('does not let a personal auth secret be used as a refresh token', async () => {
  const { records, oauth } = setup();
  records.push({
    id: 'secret-1',
    name: 'Codex',
    secret_hash: createHash('sha256').update('afmcp_personal').digest('hex'),
    user_id: 'user-1',
    oauth_client_id: null,
  });
  await assert.rejects(
    oauth.exchangeToken({ grant_type: 'refresh_token', refresh_token: 'afmcp_personal', client_id: CLIENT_ID }),
    { code: 'invalid_grant' },
  );
});

test('rejects unsupported grants and foreign resources', async () => {
  const { oauth } = setup();
  await assert.rejects(oauth.exchangeToken({ grant_type: 'client_credentials' }), { code: 'unsupported_grant_type' });
  await assert.rejects(
    oauth.exchangeToken({
      grant_type: 'refresh_token',
      refresh_token: 'token',
      client_id: CLIENT_ID,
      resource: 'https://other.example/mcp',
    }),
    { code: 'invalid_target' },
  );
});

test('matches loopback redirect URIs on any port and others exactly', () => {
  const matches = (requested, registered) => redirectUriMatches(new URL(requested), registered);
  assert.equal(matches('http://127.0.0.1:51234/callback', 'http://127.0.0.1/callback'), true);
  assert.equal(matches('http://localhost:9999/callback', 'http://localhost:3000/callback'), true);
  assert.equal(matches('http://127.0.0.1:51234/other', 'http://127.0.0.1/callback'), false);
  assert.equal(matches('http://localhost:9999/callback', 'http://127.0.0.1/callback'), false);
  assert.equal(matches('https://app.example/callback', 'https://app.example/callback'), true);
  assert.equal(matches('https://app.example:8443/callback', 'https://app.example/callback'), false);
});

test('authorizes a configured client without fetching its metadata document', async () => {
  const { oauth, jwtSecrets } = setup();
  const authorizeQuery = {
    response_type: 'code',
    client_id: 'local-test',
    redirect_uri: 'http://127.0.0.1:5555/callback',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'xyz',
  };

  const consentPageUrl = new URL(await oauth.authorize(authorizeQuery));
  assert.equal(consentPageUrl.origin + consentPageUrl.pathname, 'https://admin.example/admin/mcp-authorize');
  const request = jwtSecrets.get(consentPageUrl.searchParams.get('request'));
  assert.equal(request.redirectUri, 'http://127.0.0.1:5555/callback');
  assert.deepEqual(await oauth.describeAuthorization(consentPageUrl.searchParams.get('request')), {
    clientName: 'Local test',
    clientHost: null,
    redirectHost: '127.0.0.1:5555',
    loopbackRedirect: true,
    serverReadOnly: false,
  });

  await assert.rejects(
    oauth.authorize({ ...authorizeQuery, client_id: 'http://localhost/client.json' }),
    { code: 'invalid_client' },
  );
});

test('checks redirect_uri against the client metadata on the consent page, before allowing or denying', async () => {
  const { oauth, adminUser } = setup();
  const consentPageUrl = new URL(await oauth.authorize({
    response_type: 'code',
    client_id: 'local-test',
    redirect_uri: 'https://attacker.example/callback',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
  }));
  const signedRequest = consentPageUrl.searchParams.get('request');

  await assert.rejects(oauth.describeAuthorization(signedRequest), { code: 'invalid_request' });
  await assert.rejects(oauth.resolveAuthorization(signedRequest, true, adminUser), { code: 'invalid_request' });
  await assert.rejects(oauth.resolveAuthorization(signedRequest, false, adminUser), { code: 'invalid_request' });
});

test('treats IPv4-mapped IPv6 addresses like the IPv4 addresses they connect to', () => {
  for (const address of ['::ffff:127.0.0.1', '::ffff:10.0.0.5', '::ffff:169.254.169.254', '::ffff:192.168.1.1', '::1']) {
    assert.equal(isSpecialPurposeAddress(address, 6), true, address);
  }
  assert.equal(isSpecialPurposeAddress('10.0.0.5', 4), true);
  assert.equal(isSpecialPurposeAddress('93.184.216.34', 4), false);
  assert.equal(isSpecialPurposeAddress('2606:2800:220:1:248:1893:25c8:1946', 6), false);
});

test('does not tell the caller why a client metadata document could not be fetched', async () => {
  await assert.rejects(fetchClientMetadata('https://localhost/client.json'), (error) => {
    assert.equal(error.code, 'invalid_client');
    assert.equal(error.message, 'Could not fetch the client metadata document');
    return true;
  });
});

const AUTHORIZE_QUERY = {
  response_type: 'code',
  client_id: 'local-test',
  redirect_uri: 'http://127.0.0.1:5555/callback',
  code_challenge: CODE_CHALLENGE,
  code_challenge_method: 'S256',
};

test('rejects malformed authorization requests before looking up the client', async () => {
  const { oauth } = setup();
  const rejected = {
    'implicit flow': [{ response_type: 'token' }, 'unsupported_response_type'],
    'plain PKCE': [{ code_challenge_method: 'plain' }, 'invalid_request'],
    'no PKCE challenge': [{ code_challenge: undefined }, 'invalid_request'],
    'no client_id': [{ client_id: undefined }, 'invalid_request'],
    'http redirect off localhost': [{ redirect_uri: 'http://app.example/callback' }, 'invalid_request'],
    'javascript redirect': [{ redirect_uri: 'javascript:alert(1)' }, 'invalid_request'],
    'unparsable redirect': [{ redirect_uri: 'not a url' }, 'invalid_request'],
    'foreign resource': [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    'parameter repeated as an array': [{ client_id: ['local-test', 'local-test'] }, 'invalid_request'],
  };
  for (const [name, [overrides, code]] of Object.entries(rejected)) {
    await assert.rejects(oauth.authorize({ ...AUTHORIZE_QUERY, ...overrides }), { code }, name);
  }
  await assert.doesNotReject(oauth.authorize({ ...AUTHORIZE_QUERY, resource: 'https://admin.example/admin/adminapi/v1/mcp' }));
});

test('accepts only canonical https URLs without credentials as client_id documents', async () => {
  const { oauth } = setup();
  for (const clientId of [
    'https://127.0.0.1/client.json',
    'https://[::1]/client.json',
    'https://0x7f000001/client.json',
    'https://client.example/',
    'https://client.example',
    'https://user:password@client.example/client.json',
    'https://client.example/client.json#fragment',
    'https://CLIENT.example/client.json',
    'ftp://client.example/client.json',
  ]) {
    await assert.rejects(oauth.authorize({ ...AUTHORIZE_QUERY, client_id: clientId }), {
      code: 'invalid_client',
      message: 'client_id must be the https URL of a client metadata document',
    }, clientId);
  }
});

test('redeems a code only with its redirect_uri and only while it is a valid code', async () => {
  const { oauth, adminUser, signedRequest, jwtSecrets } = setup();
  const code = await approve(oauth, signedRequest, adminUser);
  const redeem = (overrides) => oauth.exchangeToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: CODE_VERIFIER,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    ...overrides,
  });

  await assert.rejects(redeem({ redirect_uri: 'http://127.0.0.1:51234/other' }), { code: 'invalid_grant' });
  await assert.rejects(redeem({ code: 'not-a-code' }), { code: 'invalid_grant' });
  await assert.rejects(redeem({ code: signedRequest }), { code: 'invalid_grant' }, 'authorization request used as a code');
  await assert.rejects(redeem({ code_verifier: undefined }), { code: 'invalid_request' });
  await assert.rejects(redeem({ resource: 'https://other.example/mcp' }), { code: 'invalid_target' });

  const [expiredCode] = [...jwtSecrets].find(([, payload]) => payload.t === 'mcp-oauth-code');
  jwtSecrets.delete(expiredCode);
  await assert.rejects(redeem(), { code: 'invalid_grant', message: 'Authorization code is invalid or expired' });
});

test('does not redeem a code of a user deleted after the consent', async () => {
  const { records, oauth, adminUser, signedRequest, users } = setup();
  const code = await approve(oauth, signedRequest, adminUser);
  delete users['user-1'];

  await assert.rejects(oauth.exchangeToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: CODE_VERIFIER,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  }), { code: 'invalid_grant', message: 'User of the authorization code no longer exists' });
  assert.equal(records.length, 0);
});

test('returns state and issuer with an approved code', async () => {
  const { oauth, adminUser, signedRequest } = setup();
  const redirect = new URL(await oauth.resolveAuthorization(signedRequest, true, adminUser));
  assert.equal(redirect.origin + redirect.pathname, REDIRECT_URI);
  assert.equal(redirect.searchParams.get('state'), 'state-1');
  assert.equal(redirect.searchParams.get('iss'), 'https://admin.example/admin/adminapi/v1/mcp');
  assert.ok(redirect.searchParams.get('code'));
  await assert.rejects(oauth.resolveAuthorization('not-a-request', true, adminUser), { code: 'invalid_request' });
});

async function connect({ records, oauth, adminUser, signedRequest }) {
  const code = await approve(oauth, signedRequest, adminUser);
  const tokens = await oauth.exchangeToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: CODE_VERIFIER,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
  assert.equal(records.length, 1);
  return tokens;
}

const refreshWith = (oauth, refreshToken) => oauth.exchangeToken({
  grant_type: 'refresh_token',
  refresh_token: refreshToken,
  client_id: CLIENT_ID,
});

async function isGrantAlive(oauth, store, accessToken) {
  const payload = await oauth.verifyAccessToken(accessToken);
  return Boolean(await store.authenticateOAuthGrant(payload.grantId, payload.pk));
}

test('revokes the grant when an attacker refreshes a stolen refresh token before the client does', async () => {
  const context = setup();
  const { oauth, store } = context;
  const stolen = await connect(context);

  const attacker = await refreshWith(oauth, stolen.refresh_token);
  // The client still holds the refresh token the attacker already rotated.
  await assert.rejects(refreshWith(oauth, stolen.refresh_token), { code: 'invalid_grant' });

  assert.equal(await isGrantAlive(oauth, store, attacker.access_token), false, 'attacker access token still works');
  await assert.rejects(refreshWith(oauth, attacker.refresh_token), { code: 'invalid_grant' }, 'attacker can still refresh');
});

test('revokes the grant when a refresh token the client already rotated is presented again', async () => {
  const context = setup();
  const { oauth, store } = context;
  const stolen = await connect(context);

  const client = await refreshWith(oauth, stolen.refresh_token);
  await assert.rejects(refreshWith(oauth, stolen.refresh_token), { code: 'invalid_grant' });

  // The server cannot tell which side is the attacker, so the client has to sign in again too.
  assert.equal(await isGrantAlive(oauth, store, client.access_token), false);
  await assert.rejects(refreshWith(oauth, client.refresh_token), { code: 'invalid_grant' });
});

test('does not fetch client metadata documents for requests of signed out callers', async (t) => {
  const fetchedUrls = [];
  t.mock.method(https, 'get', (url) => {
    fetchedUrls.push(url);
    throw new Error('outgoing request');
  });
  const { oauth } = setup();

  // GET /mcp/oauth/authorize is noAuth: anyone can send it with any client_id, e.g. a victim's URL.
  for (let i = 0; i < 20; i += 1) {
    await oauth.authorize({ ...AUTHORIZE_QUERY, client_id: `https://victim.example/client-${i}.json` }).catch(() => {});
  }

  assert.deepEqual(fetchedUrls, []);
});

test('rejects a made-up refresh token without revoking the grant whose id it names', async (t) => {
  const context = setup();
  const { records, oauth, store } = context;
  const tokens = await connect(context);
  const rotate = t.mock.method(store, 'rotateRefreshToken');

  // The grant id is no secret: it is the jti of the authorization code and in the access token payload.
  for (const refreshToken of [`${records[0].id}.made-up`, records[0].id, 'jwt-999']) {
    await assert.rejects(refreshWith(oauth, refreshToken), { code: 'invalid_grant' }, refreshToken);
  }

  assert.equal(rotate.mock.callCount(), 0, 'a made-up token reached the store and its lock');
  assert.equal(await isGrantAlive(oauth, store, tokens.access_token), true);
  await assert.doesNotReject(refreshWith(oauth, tokens.refresh_token));
});

async function connectUser({ oauth, users }, userId) {
  users[userId] = { id: userId, email: `${userId}@example.com` };
  const adminUser = { pk: userId, username: users[userId].email, dbUser: users[userId] };
  const consentPageUrl = new URL(await oauth.authorize({ ...AUTHORIZE_QUERY, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI }));
  const code = await approve(oauth, consentPageUrl.searchParams.get('request'), adminUser);
  return oauth.exchangeToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: CODE_VERIFIER,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
}

test('refreshes connections of different users at once, each for its own user and grant', async () => {
  const context = setup();
  const { records, oauth, store, db } = context;
  const userIds = ['user-a', 'user-b', 'user-c', 'user-d', 'user-e'];
  const connected = await Promise.all(userIds.map((userId) => connectUser(context, userId)));
  assert.equal(records.length, userIds.length);
  db.maxInFlight = 0;

  const refreshed = await Promise.all(connected.map((tokens) => refreshWith(oauth, tokens.refresh_token)));

  // The lock is per grant: refreshes of different grants do not queue behind each other.
  assert.equal(db.maxInFlight, userIds.length);
  for (const [index, userId] of userIds.entries()) {
    const accessToken = await oauth.verifyAccessToken(refreshed[index].access_token);
    assert.equal(accessToken.pk, userId);
    assert.equal(accessToken.grantId, (await oauth.verifyAccessToken(connected[index].access_token)).grantId);
    assert.equal((await store.authenticateOAuthGrant(accessToken.grantId, accessToken.pk)).adminUser.pk, userId);
  }
});

test('revokes only the connection whose refresh token is sent twice at once, while other users refresh', async () => {
  const context = setup();
  const { records, oauth, store } = context;
  const [reused, ...others] = await Promise.all(['user-a', 'user-b', 'user-c'].map((userId) => connectUser(context, userId)));

  const [first, second, ...othersResults] = await Promise.allSettled([
    refreshWith(oauth, reused.refresh_token),
    refreshWith(oauth, reused.refresh_token),
    ...others.map((tokens) => refreshWith(oauth, tokens.refresh_token)),
  ]);

  assert.deepEqual([first.status, second.status].sort(), ['fulfilled', 'rejected']);
  const rotated = first.status === 'fulfilled' ? first.value : second.value;
  assert.equal(await isGrantAlive(oauth, store, rotated.access_token), false);
  await assert.rejects(refreshWith(oauth, rotated.refresh_token), { code: 'invalid_grant' });

  assert.equal(records.length, others.length);
  for (const result of othersResults) {
    assert.equal(result.status, 'fulfilled');
    assert.equal(await isGrantAlive(oauth, store, result.value.access_token), true);
    await assert.doesNotReject(refreshWith(oauth, result.value.refresh_token));
  }
});

async function connectWithAccess(oauth, signedRequest, adminUser, readOnly) {
  const redirect = new URL(await oauth.resolveAuthorization(signedRequest, true, adminUser, readOnly));
  return oauth.exchangeToken({
    grant_type: 'authorization_code',
    code: redirect.searchParams.get('code'),
    code_verifier: CODE_VERIFIER,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
}

async function connectionOf(oauth, store, tokens) {
  const { grantId, pk } = await oauth.verifyAccessToken(tokens.access_token);
  return store.authenticateOAuthGrant(grantId, pk);
}

test('stores the read-only choice made on the consent page in the connection', async () => {
  const { records, store, oauth, adminUser, signedRequest } = setup();
  assert.equal((await oauth.describeAuthorization(signedRequest)).serverReadOnly, false);

  const full = await connectWithAccess(oauth, signedRequest, adminUser, false);
  const readOnly = await connectWithAccess(oauth, signedRequest, adminUser, true);

  assert.deepEqual(records.map((record) => record.read_only), [false, true]);
  assert.equal((await connectionOf(oauth, store, full)).readOnly, false);
  assert.equal((await connectionOf(oauth, store, readOnly)).readOnly, true);
});

test('makes every OAuth connection read-only with the plugin readOnly option', async () => {
  const { records, store, oauth, adminUser, signedRequest } = setup({ serverReadOnly: true });
  assert.equal((await oauth.describeAuthorization(signedRequest)).serverReadOnly, true);

  const tokens = await connectWithAccess(oauth, signedRequest, adminUser, false);

  assert.equal(records[0].read_only, true);
  assert.equal((await connectionOf(oauth, store, tokens)).readOnly, true);
});
