import AdminForthMcpPlugin from '../dist/index.js';

export const SECRET_OPTIONS = {
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

function matches(record, filter) {
  if (filter.operator === 'and') return filter.subFilters.every((subFilter) => matches(record, subFilter));
  return (record[filter.field] ?? null) === filter.value;
}

/**
 * Activates the plugin against an in-memory AdminForth: `records` is the auth secret table, `users` the users
 * table, JWTs are opaque keys of `jwts`. Endpoints and raw Express routes are collected by method and path.
 */
export function createPlugin({ adminPanelOrigin = 'https://admin.example', users, expressApp } = {}) {
  const records = [];
  const userRecords = users ?? [{ id: 'user-1', email: 'owner@example.com' }, { id: 'user-2', email: 'other@example.com' }];
  const jwts = new Map();
  const authorizedUsers = [];
  const columns = Object.values(SECRET_OPTIONS).slice(1).map((name) => ({ name, primaryKey: name === 'id' }));
  const adminforth = {
    config: {
      baseUrl: '',
      auth: { usersResourceId: 'admin_users', usernameField: 'email' },
      customization: { brandName: 'Test Admin', customPages: [] },
      resources: [
        { resourceId: 'mcp_auth_secrets', columns },
        { resourceId: 'admin_users', columns: [{ name: 'id', primaryKey: true }] },
      ],
    },
    codeInjector: { srcFoldersToSync: {}, allComponentNames: {} },
    openApi: { registeredSchemas: [] },
    auth: {
      issueJWT: (payload, type) => {
        const token = `jwt-${jwts.size}`;
        jwts.set(token, { ...payload, t: type });
        return token;
      },
      verify: async (token, type) => (jwts.get(token)?.t === type ? jwts.get(token) : null),
      runAdminUserAuthorizeHooks: async (adminUser) => {
        authorizedUsers.push(adminUser);
        return { allowed: true };
      },
    },
    resource: (resourceId) => resourceId === 'mcp_auth_secrets'
      ? {
        get: async (filter) => records.find((record) => matches(record, filter)) ?? null,
        list: async () => records,
        update: async (id, values) => Object.assign(records.find((record) => record.id === id), values),
      }
      : { get: async (filter) => userRecords.find((user) => matches(user, filter)) ?? null },
    createResourceRecord: async ({ record }) => {
      records.push(record);
      return { ok: true };
    },
  };

  const plugin = new AdminForthMcpPlugin({
    adminPanelOrigin,
    authSecretResource: SECRET_OPTIONS,
  });
  plugin.modifyGlobalConfig(adminforth);

  const endpoints = new Map();
  const rawRoutes = new Map();
  plugin.setupEndpoints({
    endpoint: (options) => endpoints.set(`${options.method} ${options.path}`, options),
    expressApp: expressApp ?? {
      get: (path, ...handlers) => rawRoutes.set(`GET ${path}`, handlers.at(-1)),
      post: (path, ...handlers) => rawRoutes.set(`POST ${path}`, handlers.at(-1)),
    },
  });

  /** Calls the MCP endpoint with an Authorization header and returns its status and headers. */
  async function callMcp(authorization) {
    const headers = new Map();
    let status = 200;
    await endpoints.get('POST /mcp').handler({
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(authorization && { authorization }),
      },
      query: {},
      cookies: [],
      requestUrl: '/adminapi/v1/mcp',
      response: { setHeader: (name, value) => headers.set(name, value), setStatus: (code) => { status = code; } },
    });
    return { status, headers };
  }

  return { plugin, adminforth, records, jwts, authorizedUsers, endpoints, rawRoutes, callMcp };
}
