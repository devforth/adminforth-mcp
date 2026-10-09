import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  Filters,
  logger,
  type AdminUser,
  type HttpExtra,
  type IAdminForth,
} from 'adminforth';
import { UNKNOWN_CLIENT } from './clientInfo.js';
import { KeyedLock } from './keyedLock.js';
import type { AuthSecret, AuthSecretRepository } from './repositories/authSecret.js';
import type { McpClientInfo } from './types.js';

export const SECRET_PREFIX = 'afmcp_';

type AdminUserWithExecutor = AdminUser & { executedBy?: string };

export interface OAuthGrant {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  readOnly: boolean;
}

export interface AuthenticatedMcpSecret {
  adminUser: AdminUserWithExecutor;
  client: McpClientInfo | null;
  name: string;
  readOnly: boolean;
  recordId: string;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export class McpAuthSecretStore {
  private readonly refreshLock = new KeyedLock();

  constructor(
    private readonly adminforth: IAdminForth,
    private readonly repository: AuthSecretRepository,
  ) {}

  async list(adminUser: AdminUser) {
    const authSecrets = await this.repository.listByUser(adminUser.pk!);
    return authSecrets.map(({ secretHash, userId, ...authSecret }) => authSecret);
  }

  async create(name: string, readOnly: boolean, adminUser: AdminUser, extra: HttpExtra) {
    const secret = `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
    const result = await this.repository.create({
      id: randomUUID(),
      name,
      secretHash: hashSecret(secret),
      userId: adminUser.pk!,
      readOnly,
      oauthClientId: null,
    }, adminUser, extra);

    return result.error ? { error: result.error } : { secret };
  }

  async revoke(id: string, adminUser: AdminUser, extra: HttpExtra) {
    return await this.repository.deleteByIdAndUser(id, adminUser, extra) ?? { error: 'MCP auth secret not found' };
  }

  async authenticate(secret: string): Promise<AuthenticatedMcpSecret | null> {
    const authSecret = await this.repository.findBySecretHash(hashSecret(secret));
    return authSecret ? this.toAuthenticated(authSecret) : null;
  }

  /**
   * Stores the connection an MCP client got through OAuth as an auth secret record, so it is listed and revoked
   * like personal secrets. The record id is the authorization code id, which makes every code redeemable once.
   */
  async createOAuthGrant(grant: OAuthGrant, refreshToken: string): Promise<{ error?: string }> {
    if (await this.repository.findById(grant.id)) {
      return { error: 'Authorization code was already used' };
    }

    const adminUser = await this.loadAdminUser(grant.userId);
    if (!adminUser) return { error: 'User of the authorization code no longer exists' };

    const result = await this.repository.create({
      id: grant.id,
      name: grant.clientName,
      secretHash: hashSecret(refreshToken),
      userId: grant.userId,
      readOnly: grant.readOnly,
      oauthClientId: grant.clientId,
    }, adminUser, {} as HttpExtra);
    return result.error ? { error: result.error } : {};
  }

  /**
   * Swaps the refresh token of a grant for a new one and returns the grant user id. The caller has verified the
   * token signature, so a token that is not the current one was issued for this grant before and is used again:
   * two parties hold it, a client and whoever stole it, and which one is the attacker is unknown, so the whole
   * grant is revoked (OAuth 2.1 refresh token rotation). The lock keeps two concurrent refreshes with one token
   * from both passing, within this process.
   */
  async rotateRefreshToken(
    grantId: string,
    refreshToken: string,
    clientId: string,
    newRefreshToken: string,
  ): Promise<string | null> {
    return this.refreshLock.run(grantId, async () => {
      const grant = await this.repository.findById(grantId);
      if (grant?.oauthClientId !== clientId) return null;

      if (grant.secretHash !== hashSecret(refreshToken)) {
        logger.warn(`AdminForthMcpPlugin: a rotated refresh token of OAuth grant ${grantId} was used again, revoking the grant`);
        await this.repository.deleteById(grantId);
        return null;
      }

      await this.repository.updateSecretHash(grantId, hashSecret(newRefreshToken));
      return grant.userId;
    });
  }

  /** Access tokens are checked against their grant on every request, so revoking the grant applies at once. */
  async authenticateOAuthGrant(grantId: string, userId: string): Promise<AuthenticatedMcpSecret | null> {
    const grant = await this.repository.findById(grantId);
    return grant?.userId === userId && grant.oauthClientId ? this.toAuthenticated(grant) : null;
  }

  private async loadAdminUser(pk: string): Promise<AdminUser | null> {
    const auth = this.adminforth.config.auth!;
    const usersResource = this.adminforth.config.resources.find(
      (resource) => resource.resourceId === auth.usersResourceId,
    )!;
    const userPrimaryKeyField = usersResource.columns.find((column) => column.primaryKey)!.name;
    const dbUser = await this.adminforth.resource(usersResource.resourceId).get(
      Filters.EQ(userPrimaryKeyField, pk),
    );
    return dbUser ? { pk, username: dbUser[auth.usernameField], dbUser } : null;
  }

  private async toAuthenticated(authSecret: AuthSecret): Promise<AuthenticatedMcpSecret | null> {
    const adminUser = await this.loadAdminUser(authSecret.userId);
    if (!adminUser) return null;

    return {
      adminUser,
      client: authSecret.lastUsedByAgent,
      name: authSecret.name,
      readOnly: authSecret.readOnly,
      recordId: authSecret.id,
    };
  }

  touch(recordId: string, client: McpClientInfo): void {
    const knownClient = client.client === UNKNOWN_CLIENT ? undefined : client;
    void this.repository.updateUsage(recordId, knownClient).catch((error) => {
      logger.error(`AdminForthMcpPlugin: failed to update MCP auth secret usage: ${String(error)}`);
    });
  }
}
