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

  const created = await store.create('Codex', adminUser, {});
  assert.match(created.secret, /^afmcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(authSecretRecords[0].secret_hash, createHash('sha256').update(created.secret).digest('hex'));
  assert.equal(JSON.stringify(authSecretRecords[0]).includes(created.secret), false);

  const authenticated = await store.authenticate(created.secret);
  assert.equal(authenticated.adminUser.username, 'owner@example.com');
  assert.equal(authenticated.name, 'Codex');
  assert.equal(authenticated.recordId, authSecretRecords[0].id);

  store.touch(authenticated.recordId, { client: 'codex', ver: '1.0.0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates[0].id, authSecretRecords[0].id);
  assert.equal(updates[0].values.last_used_by_agent, JSON.stringify({ client: 'codex', ver: '1.0.0' }));

  authSecretRecords[0].last_used_by_agent = updates[0].values.last_used_by_agent;
  const listed = await store.list(adminUser);
  assert.deepEqual(listed[0].lastUsedByAgent, { client: 'codex', ver: '1.0.0' });
  assert.equal('secret_hash' in listed[0], false);

  const revoked = await store.revoke(authSecretRecords[0].id, adminUser, {});
  assert.deepEqual(revoked, { ok: true });
  assert.equal(revokedRecord, authSecretRecords[0]);
});
