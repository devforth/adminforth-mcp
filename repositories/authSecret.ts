import {
  Filters,
  Sorts,
  type AdminForthResource,
  type AdminUser,
  type CreateResourceRecordResult,
  type DeleteResourceRecordResult,
  type HttpExtra,
  type IAdminForth,
  type IAdminForthSingleFilter,
  type IOperationalResource,
} from 'adminforth';
import type { McpAuthSecretResourceOptions, McpClientInfo } from '../types.js';

export interface AuthSecret {
  id: string;
  name: string;
  secretHash: string;
  userId: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedByAgent: McpClientInfo | null;
  readOnly: boolean;
  oauthClientId: string | null;
}

export type NewAuthSecret = Pick<AuthSecret, 'id' | 'name' | 'secretHash' | 'userId' | 'readOnly' | 'oauthClientId'>;

export class AuthSecretRepository {
  private readonly resource: AdminForthResource;

  constructor(
    private readonly adminforth: IAdminForth,
    private readonly fields: McpAuthSecretResourceOptions,
  ) {
    this.resource = adminforth.config.resources.find(
      (resource) => resource.resourceId === fields.resourceId,
    )!;
  }

  async listByUser(userId: string): Promise<AuthSecret[]> {
    const records = await this.records().list(
      Filters.EQ(this.fields.userIdField, userId),
      undefined,
      undefined,
      Sorts.DESC(this.fields.createdAtField),
    );
    return records.map((record) => this.toAuthSecret(record));
  }

  findById(id: string): Promise<AuthSecret | null> {
    return this.findOne(Filters.EQ(this.fields.idField, id));
  }

  findBySecretHash(secretHash: string): Promise<AuthSecret | null> {
    return this.findOne(Filters.EQ(this.fields.secretHashField, secretHash));
  }

  create(authSecret: NewAuthSecret, adminUser: AdminUser, extra: HttpExtra): Promise<CreateResourceRecordResult> {
    const fields = this.fields;
    return this.adminforth.createResourceRecord({
      resource: this.resource,
      adminUser,
      extra,
      record: {
        [fields.idField]: authSecret.id,
        [fields.nameField]: authSecret.name,
        [fields.secretHashField]: authSecret.secretHash,
        [fields.userIdField]: authSecret.userId,
        [fields.createdAtField]: new Date().toISOString(),
        [fields.lastUsedAtField]: null,
        [fields.lastUsedByAgentField]: null,
        [fields.readOnlyField]: authSecret.readOnly,
        [fields.oauthClientIdField]: authSecret.oauthClientId,
      },
    });
  }

  async deleteByIdAndUser(id: string, adminUser: AdminUser, extra: HttpExtra): Promise<DeleteResourceRecordResult | null> {
    const record = await this.records().get(Filters.AND(
      Filters.EQ(this.fields.idField, id),
      Filters.EQ(this.fields.userIdField, adminUser.pk!),
    ));
    if (!record) return null;

    return this.adminforth.deleteResourceRecord({
      resource: this.resource,
      record,
      recordId: id,
      adminUser,
      extra,
    });
  }

  async deleteById(id: string): Promise<void> {
    await this.records().delete(id);
  }

  async updateSecretHash(id: string, secretHash: string): Promise<void> {
    await this.records().update(id, { [this.fields.secretHashField]: secretHash });
  }

  async updateUsage(id: string, client?: McpClientInfo): Promise<void> {
    await this.records().update(id, {
      [this.fields.lastUsedAtField]: new Date().toISOString(),
      ...(client && { [this.fields.lastUsedByAgentField]: JSON.stringify(client) }),
    });
  }

  private records(): IOperationalResource {
    return this.adminforth.resource(this.fields.resourceId);
  }

  private async findOne(filter: IAdminForthSingleFilter): Promise<AuthSecret | null> {
    const record = await this.records().get(filter);
    return record ? this.toAuthSecret(record) : null;
  }

  private toAuthSecret(record: Record<string, any>): AuthSecret {
    const fields = this.fields;
    const lastUsedByAgent: string | null = record[fields.lastUsedByAgentField];
    return {
      id: record[fields.idField],
      name: record[fields.nameField],
      secretHash: record[fields.secretHashField],
      userId: record[fields.userIdField],
      createdAt: record[fields.createdAtField],
      lastUsedAt: record[fields.lastUsedAtField],
      lastUsedByAgent: lastUsedByAgent && JSON.parse(lastUsedByAgent),
      readOnly: record[fields.readOnlyField],
      oauthClientId: record[fields.oauthClientIdField],
    };
  }
}
