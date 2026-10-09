import type { IHttpServer } from 'adminforth';
import type { McpAuthSecretStore } from '../authSecretStore.js';
import { requestExtra } from '../requestExtra.js';
import {
  createAuthSecretBodySchema,
  revokeAuthSecretBodySchema,
  type CreateAuthSecretBody,
  type RevokeAuthSecretBody,
} from '../schemas/settings.js';
import { MCP_PATH } from '../urls.js';

export function registerSettingsEndpoints(
  server: IHttpServer,
  authSecretStore: McpAuthSecretStore,
  mcpUrl: string,
  serverReadOnly: boolean,
): void {
  server.endpoint({
    method: 'GET',
    path: `${MCP_PATH}/auth-secrets`,
    agent: {
      hiddenFromAgents: true,
    },
    handler: async ({ adminUser }) => ({
      authSecrets: await authSecretStore.list(adminUser),
      mcpUrl,
      serverReadOnly,
    }),
  });

  server.endpoint({
    method: 'POST',
    path: `${MCP_PATH}/auth-secrets`,
    agent: {
      hiddenFromAgents: true,
    },
    request_schema: createAuthSecretBodySchema,
    handler: async (input) => {
      const body: CreateAuthSecretBody = input.body;
      return authSecretStore.create(
        body.name,
        serverReadOnly || body.readOnly,
        input.adminUser,
        requestExtra(input),
      );
    },
  });

  server.endpoint({
    method: 'DELETE',
    path: `${MCP_PATH}/auth-secrets`,
    agent: {
      hiddenFromAgents: true,
    },
    request_schema: revokeAuthSecretBodySchema,
    handler: async (input) => {
      const body: RevokeAuthSecretBody = input.body;
      const result = await authSecretStore.revoke(
        body.id,
        input.adminUser,
        requestExtra(input),
      );
      if (result.error) input.response.setStatus(404);
      return result;
    },
  });
}
