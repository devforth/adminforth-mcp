import type { IHttpServer } from 'adminforth';
import type { McpAuthSecretStore } from '../authSecretStore.js';
import { requestExtra } from '../requestExtra.js';
import {
  createAuthSecretBodySchema,
  revokeAuthSecretBodySchema,
  updateAuthSecretBodySchema,
  type CreateAuthSecretBody,
  type RevokeAuthSecretBody,
  type UpdateAuthSecretBody,
} from '../schemas/settings.js';
import type { ServerReadOnly } from '../serverReadOnly.js';
import { MCP_PATH } from '../urls.js';

export function registerSettingsEndpoints(
  server: IHttpServer,
  authSecretStore: McpAuthSecretStore,
  mcpUrl: string,
  serverReadOnly: ServerReadOnly,
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
      serverReadOnly: await serverReadOnly(adminUser),
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
        body.readOnly || await serverReadOnly(input.adminUser),
        input.adminUser,
        requestExtra(input),
      );
    },
  });

  server.endpoint({
    method: 'PATCH',
    path: `${MCP_PATH}/auth-secrets`,
    agent: {
      hiddenFromAgents: true,
    },
    request_schema: updateAuthSecretBodySchema,
    handler: async (input) => {
      const body: UpdateAuthSecretBody = input.body;
      const result = await authSecretStore.setReadOnly(
        body.id,
        body.readOnly || await serverReadOnly(input.adminUser),
        input.adminUser,
        requestExtra(input),
      );
      if (result.error) input.response.setStatus(404);
      return result;
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
