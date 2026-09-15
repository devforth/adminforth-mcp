import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  Filters,
  Sorts,
  logger,
  type AdminForthResource,
  type AdminUser,
  type HttpExtra,
  type IAdminForth,
} from 'adminforth';
import { UNKNOWN_CLIENT } from './clientInfo.js';
import type { McpClientInfo, McpTokenResourceOptions } from './types.js';

const TOKEN_PREFIX = 'afmcp_';

type AdminUserWithExecutor = AdminUser & { executedBy?: string };

export interface AuthenticatedMcpToken {
  adminUser: AdminUserWithExecutor;
  client: McpClientInfo | null;
  recordId: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class McpTokenStore {
  private readonly resource: AdminForthResource;

  constructor(
    private readonly adminforth: IAdminForth,
    private readonly options: McpTokenResourceOptions,
  ) {
    this.resource = adminforth.config.resources.find(
      (resource) => resource.resourceId === options.resourceId,
    )!;
  }

  async list(adminUser: AdminUser) {
    const fields = this.options;
    const records = await this.adminforth.resource(fields.resourceId).list(
      Filters.EQ(fields.userIdField, adminUser.pk),
      undefined,
      undefined,
      Sorts.DESC(fields.createdAtField),
    );

    return records.map((record) => ({
      id: record[fields.idField],
      name: record[fields.nameField],
      createdAt: record[fields.createdAtField],
      lastUsedAt: record[fields.lastUsedAtField] ?? null,
      agent: record[fields.agentField] ? JSON.parse(record[fields.agentField]) : null,
    }));
  }

  async create(name: string, adminUser: AdminUser, extra: HttpExtra) {
    const fields = this.options;
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const result = await this.adminforth.createResourceRecord({
      resource: this.resource,
      adminUser,
      extra,
      record: {
        [fields.idField]: randomUUID(),
        [fields.nameField]: name,
        [fields.tokenHashField]: hashToken(token),
        [fields.userIdField]: adminUser.pk,
        [fields.createdAtField]: new Date().toISOString(),
        [fields.lastUsedAtField]: null,
        [fields.agentField]: null,
      },
    });

    return result.error ? { error: result.error } : { token };
  }

  async revoke(id: string, adminUser: AdminUser, extra: HttpExtra) {
    const fields = this.options;
    const record = await this.adminforth.resource(fields.resourceId).get(Filters.AND(
      Filters.EQ(fields.idField, id),
      Filters.EQ(fields.userIdField, adminUser.pk),
    ));

    if (!record) return { error: 'MCP token not found' };

    return this.adminforth.deleteResourceRecord({
      resource: this.resource,
      record,
      recordId: id,
      adminUser,
      extra,
    });
  }

  async authenticate(token: string): Promise<AuthenticatedMcpToken | null> {
    const fields = this.options;
    const record = await this.adminforth.resource(fields.resourceId).get(
      Filters.EQ(fields.tokenHashField, hashToken(token)),
    );
    if (!record) return null;

    const auth = this.adminforth.config.auth!;
    const usersResource = this.adminforth.config.resources.find(
      (resource) => resource.resourceId === auth.usersResourceId,
    )!;
    const userPrimaryKeyField = usersResource.columns.find((column) => column.primaryKey)!.name;
    const dbUser = await this.adminforth.resource(usersResource.resourceId).get(
      Filters.EQ(userPrimaryKeyField, record[fields.userIdField]),
    );
    if (!dbUser) return null;

    return {
      adminUser: {
        pk: record[fields.userIdField],
        username: dbUser[auth.usernameField],
        dbUser,
      },
      client: record[fields.agentField] ? JSON.parse(record[fields.agentField]) : null,
      recordId: record[fields.idField],
    };
  }

  touch(recordId: string, client: McpClientInfo): void {
    const fields = this.options;
    const updates: Record<string, unknown> = {
      [fields.lastUsedAtField]: new Date().toISOString(),
    };
    if (client.client !== UNKNOWN_CLIENT) {
      updates[fields.agentField] = JSON.stringify(client);
    }

    void this.adminforth.resource(fields.resourceId).update(recordId, updates).catch((error) => {
      logger.error(`AdminForthMcpPlugin: failed to update MCP token usage: ${String(error)}`);
    });
  }
}
