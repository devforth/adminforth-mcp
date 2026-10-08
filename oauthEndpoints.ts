import { logger, type IAdminForthEndpointHandlerInput, type IHttpServer } from 'adminforth';
import { OAUTH_PATHS, type McpOAuth } from './oauth.js';
import { OAuthError } from './oauthError.js';
import { MCP_PATH } from './urls.js';

const MAX_FORM_BODY_BYTES = 16 * 1024;

interface RawRequest extends AsyncIterable<Buffer> {
  body?: unknown;
}

interface RawResponse {
  set(name: string, value: string): RawResponse;
  status(code: number): RawResponse;
  json(body: unknown): void;
  redirect(status: number, url: string): void;
}

type RawHandler = (req: RawRequest, res: RawResponse) => Promise<void>;

/**
 * Routes `server.endpoint()` cannot serve are added to the Express app: the token endpoint gets form bodies,
 * and RFC 8414 / RFC 9728 metadata lives at the host root, outside the AdminForth API prefix.
 */
interface ExpressHttpServer extends IHttpServer {
  expressApp: {
    get(path: string, handler: RawHandler): void;
    post(path: string, handler: RawHandler): void;
  };
}

/**
 * RFC 6749 token requests are application/x-www-form-urlencoded. The host app may already have parsed the body
 * with its own urlencoded middleware; otherwise the stream is still unread.
 */
async function readFormBody(req: RawRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
    return req.body as Record<string, unknown>;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FORM_BODY_BYTES) {
      throw new OAuthError('invalid_request', `Request body is larger than ${MAX_FORM_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

async function oauthResponse(
  input: IAdminForthEndpointHandlerInput,
  handler: () => Promise<unknown>,
): Promise<unknown> {
  try {
    const result = await handler();
    // A handler that answered through the raw response returns null; headers can no longer be set then.
    if (result !== null) input.response.setHeader('Cache-Control', 'no-store');
    return result;
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    input.response.setHeader('Cache-Control', 'no-store');
    input.response.setStatus(400);
    return error.toResponseObject();
  }
}

export function setupOAuthEndpoints(server: IHttpServer, oauth: McpOAuth, apiPrefix: string): void {
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
      (input._raw_express_res as RawResponse).set('Cache-Control', 'no-store').redirect(302, consentPageUrl);
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
    handler: async (input) => oauthResponse(input, async () => ({
      redirectUrl: await oauth.resolveAuthorization(
        String(input.body.request),
        input.body.approved === true,
        input.adminUser,
        input.body.readOnly === true,
      ),
    })),
  });

  const { expressApp } = server as ExpressHttpServer;

  // MCP clients try the host-root well-known URLs first and stop at the first 200 response. The AdminForth SPA
  // answers every unknown path with 200 HTML, so unless these are served the client fails before it reaches
  // `<issuer>/.well-known/openid-configuration`. Behind a proxy that forwards only the AdminForth path they 404,
  // and the client goes on to that URL.
  const mcpPath = `${apiPrefix}${MCP_PATH}`;
  expressApp.get(`/.well-known/oauth-protected-resource${mcpPath}`, async (_req, res) => {
    res.json(oauth.protectedResourceMetadata());
  });
  expressApp.get(`/.well-known/oauth-authorization-server${mcpPath}`, async (_req, res) => {
    res.json(oauth.authorizationServerMetadata());
  });

  expressApp.post(`${apiPrefix}${OAUTH_PATHS.token}`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(await oauth.exchangeToken(await readFormBody(req)));
    } catch (error) {
      if (error instanceof OAuthError) {
        res.status(400).json(error.toResponseObject());
        return;
      }
      logger.error(`AdminForthMcpPlugin: OAuth token request failed: ${(error as Error).stack ?? String(error)}`);
      res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
    }
  });
}
