import { logger, type IAdminForthEndpointHandlerInput, type IHttpServer } from 'adminforth';
import express, { type Express } from 'express';
import type { McpOAuth } from '../oauth/authorizationServer.js';
import { OAuthError } from '../oauth/errors.js';
import { resolveAuthorizationBodySchema, type ResolveAuthorizationBody } from '../schemas/oAuth.js';
import { MCP_PATH, OAUTH_PATHS } from '../urls.js';

const FORM_BODY_LIMIT = '16kb';

async function oauthResponse<T>(input: IAdminForthEndpointHandlerInput, handler: () => Promise<T>) {
  try {
    const result = await handler();
    if (result !== null) input.response.setHeader('Cache-Control', 'no-store');
    return result;
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    input.response.setHeader('Cache-Control', 'no-store');
    input.response.setStatus(400);
    return error.toResponseObject();
  }
}

export function registerOAuthEndpoints(server: IHttpServer, oauth: McpOAuth, apiPrefix: string): void {
  server.endpoint({
    method: 'GET',
    path: OAUTH_PATHS.protectedResourceMetadata,
    agent: {
      hiddenFromAgents: true,
    },
    noAuth: true,
    handler: async () => oauth.protectedResourceMetadata(),
  });

  server.endpoint({
    method: 'GET',
    path: OAUTH_PATHS.authorizationServerMetadata,
    agent: {
      hiddenFromAgents: true,
    },
    noAuth: true,
    handler: async () => oauth.authorizationServerMetadata(),
  });

  server.endpoint({
    method: 'GET',
    path: OAUTH_PATHS.jwks,
    agent: {
      hiddenFromAgents: true,
    },
    noAuth: true,
    handler: async () => ({ keys: [] }),
  });

  server.endpoint({
    method: 'GET',
    path: OAUTH_PATHS.authorize,
    agent: {
      hiddenFromAgents: true,
    },
    noAuth: true,
    handler: async (input) => oauthResponse(input, async () => {
      const consentPageUrl = await oauth.authorize(input.query);
      input._raw_express_res.set('Cache-Control', 'no-store').redirect(302, consentPageUrl);
      return null;
    }),
  });

  server.endpoint({
    method: 'GET',
    path: OAUTH_PATHS.authorization,
    agent: {
      hiddenFromAgents: true,
    },
    handler: async (input) => oauthResponse(input, () => oauth.describeAuthorization(String(input.query.request))),
  });

  server.endpoint({
    method: 'POST',
    path: OAUTH_PATHS.authorization,
    agent: {
      hiddenFromAgents: true,
    },
    request_schema: resolveAuthorizationBodySchema,
    handler: async (input) => {
      const body: ResolveAuthorizationBody = input.body;
      return oauthResponse(input, async () => ({
        redirectUrl: await oauth.resolveAuthorization(body.request, body.approved, input.adminUser, body.readOnly),
      }));
    },
  });

  const { expressApp } = server as IHttpServer & { expressApp: Express };

  const mcpPath = `${apiPrefix}${MCP_PATH}`;
  expressApp.get(`/.well-known/oauth-protected-resource${mcpPath}`, async (_req, res) => {
    res.json(oauth.protectedResourceMetadata());
  });
  expressApp.get(`/.well-known/oauth-authorization-server${mcpPath}`, async (_req, res) => {
    res.json(oauth.authorizationServerMetadata());
  });

  expressApp.post(
    `${apiPrefix}${OAUTH_PATHS.token}`,
    express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        res.json(await oauth.exchangeToken(req.body ?? {}));
      } catch (error) {
        if (error instanceof OAuthError) {
          res.status(400).json(error.toResponseObject());
          return;
        }
        logger.error(`AdminForthMcpPlugin: OAuth token request failed: ${(error as Error).stack ?? String(error)}`);
        res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
      }
    },
  );
}
