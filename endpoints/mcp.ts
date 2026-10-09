import type { IAdminForthEndpointHandlerInput, IHttpServer } from 'adminforth';
import { MCP_PATH } from '../urls.js';

export function registerMcpEndpoints(
  server: IHttpServer,
  handleMcpRequest: (input: IAdminForthEndpointHandlerInput) => Promise<unknown>,
): void {
  server.endpoint({
    method: 'POST',
    path: MCP_PATH,
    agent: {
      hiddenFromAgents: true,
    },
    noAuth: true,
    handler: handleMcpRequest,
  });

  server.endpoint({
    method: 'GET',
    path: MCP_PATH,
    agent: {
      hiddenFromAgents: true,
    },
    noAuth: true,
    handler: async ({ response }) => {
      response.setHeader('Allow', 'POST');
      response.setStatus(405, 'Method Not Allowed');
    },
  });
}
