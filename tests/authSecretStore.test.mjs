import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { McpAuthSecretStore } from '../dist/authSecretStore.js';

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
};

test('creates, authenticates, tracks, lists, and revokes auth secret records', async () => {
  const authSecretRecords = [];
  const updates = [];
  const userRecord = { id: 'user-1', email: 'owner@example.com' };
  let revokedRecord;

  const authSecretResource = {
    list: async () => authSecretRecords,
    get: async () => authSecretRecords[0] ?? null,
    update: async (id, values) => {
      updates.push({ id, values });
      return { ok: true };
    },
  };
  const usersResource = {
    get: async () => userRecord,
  };
  const adminforth = {
    config: {
      auth: {
        usersResourceId: 'admin_users',
        usernameField: 'email',
      },
      resources: [
        { resourceId: 'mcp_auth_secrets' },
        { resourceId: 'admin_users', columns: [{ name: 'id', primaryKey: true }] },
      ],
    },
    resource: (resourceId) => resourceId === 'mcp_auth_secrets' ? authSecretResource : usersResource,
    createResourceRecord: async ({ record }) => {
      authSecretRecords.push(record);
      return { ok: true };
    },
    deleteResourceRecord: async ({ record }) => {
      revokedRecord = record;
      return { ok: true };
    },
  };
  const adminUser = { pk: 'user-1', username: 'owner@example.com', dbUser: userRecord };
  const store = new McpAuthSecretStore(adminforth, options);

  const created = await store.create('Codex', true, adminUser, {});
  assert.match(created.secret, /^afmcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(authSecretRecords[0].secret_hash, createHash('sha256').update(created.secret).digest('hex'));
  assert.equal(JSON.stringify(authSecretRecords[0]).includes(created.secret), false);
  assert.equal(authSecretRecords[0].read_only, true);

  const authenticated = await store.authenticate(created.secret);
  assert.equal(authenticated.adminUser.username, 'owner@example.com');
  assert.equal(authenticated.name, 'Codex');
  assert.equal(authenticated.readOnly, true);
  assert.equal(authenticated.recordId, authSecretRecords[0].id);

  store.touch(authenticated.recordId, { client: 'codex', ver: '1.0.0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates[0].id, authSecretRecords[0].id);
  assert.equal(updates[0].values.last_used_by_agent, JSON.stringify({ client: 'codex', ver: '1.0.0' }));

  authSecretRecords[0].last_used_by_agent = updates[0].values.last_used_by_agent;
  const listed = await store.list(adminUser);
  assert.deepEqual(listed[0].lastUsedByAgent, { client: 'codex', ver: '1.0.0' });
  assert.equal(listed[0].readOnly, true);
  assert.equal('secret_hash' in listed[0], false);
  // Without oauthClientIdField the plugin keeps the 1.0 table layout: no OAuth column is written or read.
  assert.equal('undefined' in authSecretRecords[0], false);
  assert.equal(listed[0].oauthClientId, null);

  const revoked = await store.revoke(authSecretRecords[0].id, adminUser, {});
  assert.deepEqual(revoked, { ok: true });
  assert.equal(revokedRecord, authSecretRecords[0]);
});

test('survives corrupted stored agent info', async () => {
  // e.g. a database column which silently truncated an oversized value
  const record = {
    id: 'secret-1',
    name: 'Codex',
    secret_hash: createHash('sha256').update('afmcp_test').digest('hex'),
    user_id: 'user-1',
    created_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    last_used_by_agent: '{"client":"codex","ver":"1.0',
    read_only: false,
  };
  const userRecord = { id: 'user-1', email: 'owner@example.com' };
  const adminforth = {
    config: {
      auth: { usersResourceId: 'admin_users', usernameField: 'email' },
      resources: [
        { resourceId: 'mcp_auth_secrets' },
        { resourceId: 'admin_users', columns: [{ name: 'id', primaryKey: true }] },
      ],
    },
    resource: (resourceId) => resourceId === 'mcp_auth_secrets'
      ? { list: async () => [record], get: async () => record }
      : { get: async () => userRecord },
  };
  const store = new McpAuthSecretStore(adminforth, options);

  const authenticated = await store.authenticate('afmcp_test');
  assert.equal(authenticated.client, null);
  assert.equal(authenticated.name, 'Codex');

  const listed = await store.list({ pk: 'user-1' });
  assert.equal(listed[0].lastUsedByAgent, null);
});
