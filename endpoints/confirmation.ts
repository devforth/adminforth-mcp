import type { IHttpServer } from 'adminforth';
import type { McpAdminPanelConfirmation } from '../adminPanelConfirmation.js';
import {
  declineConfirmationBodySchema,
  runConfirmationBodySchema,
  type DeclineConfirmationBody,
  type RunConfirmationBody,
} from '../schemas/confirmation.js';
import { MCP_PATH } from '../urls.js';

export function registerConfirmationEndpoints(server: IHttpServer, confirmation: McpAdminPanelConfirmation): void {
  server.endpoint({
    method: 'GET',
    path: `${MCP_PATH}/confirmation`,
    agent: { hiddenFromAgents: true },
    handler: async (input) => {
      const pending = confirmation.describe(String(input.query.id), input.adminUser);
      if ('error' in pending) input.response.setStatus(400);
      return pending;
    },
  });
  server.endpoint({
    method: 'POST',
    path: `${MCP_PATH}/confirmation/run`,
    agent: { hiddenFromAgents: true },
    request_schema: runConfirmationBodySchema,
    handler: async (input) => {
      const body: RunConfirmationBody = input.body;
      return confirmation.run(body.id, body.verificationResult, input);
    },
  });
  server.endpoint({
    method: 'POST',
    path: `${MCP_PATH}/confirmation/decline`,
    agent: { hiddenFromAgents: true },
    request_schema: declineConfirmationBodySchema,
    handler: async (input) => {
      const body: DeclineConfirmationBody = input.body;
      const result = confirmation.decline(body.id, input.adminUser);
      if ('error' in result) input.response.setStatus(400);
      return result;
    },
  });
}
