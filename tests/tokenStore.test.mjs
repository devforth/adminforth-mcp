import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { McpTokenStore } from '../dist/tokenStore.js';

const options = {
  resourceId: 'mcp_tokens',
  idField: 'id',
  nameField: 'name',
  tokenHashField: 'token_hash',
  userIdField: 'user_id',
  createdAtField: 'created_at',
  lastUsedAtField: 'last_used_at',
  agentField: 'agent',
};

test('creates, authenticates, tracks, lists, and revokes token records', async () => {
  const tokenRecords = [];
  const updates = [];
  const userRecord = { id: 'user-1', email: 'owner@example.com' };
  let revokedRecord;

  const tokenResource = {
    list: async () => tokenRecords,
    get: async () => tokenRecords[0] ?? null,
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
        { resourceId: 'mcp_tokens' },
        { resourceId: 'admin_users', columns: [{ name: 'id', primaryKey: true }] },
      ],
    },
    resource: (resourceId) => resourceId === 'mcp_tokens' ? tokenResource : usersResource,
    createResourceRecord: async ({ record }) => {
      tokenRecords.push(record);
      return { ok: true };
    },
    deleteResourceRecord: async ({ record }) => {
      revokedRecord = record;
      return { ok: true };
    },
  };
  const adminUser = { pk: 'user-1', username: 'owner@example.com', dbUser: userRecord };
  const store = new McpTokenStore(adminforth, options);

  const created = await store.create('Codex', adminUser, {});
  assert.match(created.token, /^afmcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(tokenRecords[0].token_hash, createHash('sha256').update(created.token).digest('hex'));
  assert.equal(JSON.stringify(tokenRecords[0]).includes(created.token), false);

  const authenticated = await store.authenticate(created.token);
  assert.equal(authenticated.adminUser.username, 'owner@example.com');
  assert.equal(authenticated.recordId, tokenRecords[0].id);

  store.touch(authenticated.recordId, { client: 'codex', ver: '1.0.0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates[0].id, tokenRecords[0].id);
  assert.equal(updates[0].values.agent, JSON.stringify({ client: 'codex', ver: '1.0.0' }));

  tokenRecords[0].agent = updates[0].values.agent;
  const listed = await store.list(adminUser);
  assert.deepEqual(listed[0].agent, { client: 'codex', ver: '1.0.0' });
  assert.equal('token_hash' in listed[0], false);

  const revoked = await store.revoke(tokenRecords[0].id, adminUser, {});
  assert.deepEqual(revoked, { ok: true });
  assert.equal(revokedRecord, tokenRecords[0]);
});
