import test from 'node:test';
import assert from 'node:assert/strict';
import { McpResourceVisibility } from '../dist/resourceVisibility.js';

const ADMIN_USER = { pk: '1', dbUser: { role: 'manager' } };

function resource(resourceId, allowedActions) {
  return { resourceId, options: { allowedActions: { create: true, edit: true, delete: true, ...allowedActions } } };
}

function createVisibility(resources, hiddenResourceIds = []) {
  return new McpResourceVisibility({ config: { resources } }, new Set(hiddenResourceIds));
}

test('shows resources whose records the user may list or show', async () => {
  const visibility = createVisibility([
    resource('listed', { list: true, show: false }),
    resource('shown', { list: false, show: true }),
    resource('closed', { list: false, show: false }),
  ]);

  const visible = await visibility.visibleResources(ADMIN_USER);

  assert.deepEqual(visible.map(({ resourceId }) => resourceId), ['listed', 'shown']);
  assert.equal(await visibility.isVisible(ADMIN_USER, 'closed'), false);
});

test('resolves list and show functions for the user', async () => {
  const visibility = createVisibility([
    resource('managers', {
      list: ({ adminUser }) => adminUser.dbUser.role === 'manager',
      show: false,
    }),
    resource('admins', {
      list: ({ adminUser }) => adminUser.dbUser.role === 'admin',
      show: async () => 'Only admins can see records',
    }),
  ]);

  assert.equal(await visibility.isVisible(ADMIN_USER, 'managers'), true);
  assert.equal(await visibility.isVisible(ADMIN_USER, 'admins'), false);
});

test('hides resources hidden from MCP and unknown resources', async () => {
  const visibility = createVisibility(
    [resource('mcp_auth_secrets', { list: true, show: true })],
    ['mcp_auth_secrets'],
  );

  assert.deepEqual(await visibility.visibleResources(ADMIN_USER), []);
  assert.equal(await visibility.isVisible(ADMIN_USER, 'mcp_auth_secrets'), false);
  assert.equal(await visibility.isVisible(ADMIN_USER, 'unknown'), false);
});
