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
import type { McpAuthSecretResourceOptions, McpClientInfo } from './types.js';

const SECRET_PREFIX = 'afmcp_';

type AdminUserWithExecutor = AdminUser & { executedBy?: string };

export interface AuthenticatedMcpSecret {
  adminUser: AdminUserWithExecutor;
  client: McpClientInfo | null;
  name: string;
  recordId: string;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Stored agent info originates from the MCP client, so it is never trusted to be valid JSON:
 * a database column which truncated an oversized value would otherwise break every next
 * request made with the auth secret, including the page used to revoke it.
 */
function parseStoredClient(value: unknown): McpClientInfo | null {
  if (typeof value !== 'string' || !value) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.client !== 'string') return null;
  return { client: parsed.client, ver: typeof parsed.ver === 'string' ? parsed.ver : null };
}

export class McpAuthSecretStore {
  private readonly resource: AdminForthResource;

  constructor(
    private readonly adminforth: IAdminForth,
    private readonly options: McpAuthSecretResourceOptions,
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
      lastUsedByAgent: parseStoredClient(record[fields.lastUsedByAgentField]),
    }));
  }

  async create(name: string, adminUser: AdminUser, extra: HttpExtra) {
    const fields = this.options;
    const secret = `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
    const result = await this.adminforth.createResourceRecord({
      resource: this.resource,
      adminUser,
      extra,
      record: {
        [fields.idField]: randomUUID(),
        [fields.nameField]: name,
        [fields.secretHashField]: hashSecret(secret),
        [fields.userIdField]: adminUser.pk,
        [fields.createdAtField]: new Date().toISOString(),
        [fields.lastUsedAtField]: null,
        [fields.lastUsedByAgentField]: null,
      },
    });

    return result.error ? { error: result.error } : { secret };
  }

  async revoke(id: string, adminUser: AdminUser, extra: HttpExtra) {
    const fields = this.options;
    const record = await this.adminforth.resource(fields.resourceId).get(Filters.AND(
      Filters.EQ(fields.idField, id),
      Filters.EQ(fields.userIdField, adminUser.pk),
    ));

    if (!record) return { error: 'MCP auth secret not found' };

    return this.adminforth.deleteResourceRecord({
      resource: this.resource,
      record,
      recordId: id,
      adminUser,
      extra,
    });
  }

  async authenticate(secret: string): Promise<AuthenticatedMcpSecret | null> {
    const fields = this.options;
    const record = await this.adminforth.resource(fields.resourceId).get(
      Filters.EQ(fields.secretHashField, hashSecret(secret)),
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
      client: parseStoredClient(record[fields.lastUsedByAgentField]),
      name: record[fields.nameField],
      recordId: record[fields.idField],
    };
  }

  touch(recordId: string, client: McpClientInfo): void {
    const fields = this.options;
    const updates: Record<string, unknown> = {
      [fields.lastUsedAtField]: new Date().toISOString(),
    };
    if (client.client !== UNKNOWN_CLIENT) {
      updates[fields.lastUsedByAgentField] = JSON.stringify(client);
    }

    void this.adminforth.resource(fields.resourceId).update(recordId, updates).catch((error) => {
      logger.error(`AdminForthMcpPlugin: failed to update MCP auth secret usage: ${String(error)}`);
    });
  }
}
