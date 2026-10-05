import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AdminUser, IAdminForth } from 'adminforth';
import type { McpAuthSecretStore } from './authSecretStore.js';
import {
  fetchClientMetadata,
  isAllowedRedirectUri,
  isLoopbackRedirectUri,
  redirectUriMatches,
} from './oauthClientMetadata.js';
import { OAuthError } from './oauthError.js';
import type { McpOAuthClient } from './types.js';

const REQUEST_JWT_TYPE = 'mcp-oauth-request';
const CODE_JWT_TYPE = 'mcp-oauth-code';
const ACCESS_TOKEN_JWT_TYPE = 'mcp-oauth-access';
const REQUEST_TTL = '10m';
const CODE_TTL = '5m';
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** Endpoint paths relative to the AdminForth API prefix (`<baseUrl>/adminapi/v1`). */
export const OAUTH_PATHS = {
  protectedResourceMetadata: '/mcp/oauth-protected-resource',
  // Clients derive authorization server metadata URL from the issuer; for an issuer with a path, the
  // OpenID Connect Discovery form `<issuer>/.well-known/openid-configuration` is the only one not at the host root,
  // so it works behind a proxy that forwards only the AdminForth path. The host-root forms are in oauthEndpoints.ts.
  authorizationServerMetadata: '/mcp/.well-known/openid-configuration',
  jwks: '/mcp/oauth/jwks',
  authorize: '/mcp/oauth/authorize',
  token: '/mcp/oauth/token',
  authorization: '/mcp/oauth/authorization',
};
export const CONSENT_PAGE_PATH = '/mcp-authorize';

interface AuthorizationRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  loopbackRedirect: boolean;
}

interface AuthorizationCode {
  jti: string;
  pk: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
}

interface AccessToken {
  pk: string;
  grantId: string;
}

function requireParams<K extends string>(params: Record<string, unknown>, names: K[]): Record<K, string> {
  const missing = names.filter((name) => typeof params[name] !== 'string' || !params[name]);
  if (missing.length) {
    throw new OAuthError('invalid_request', `Missing or invalid parameters: ${missing.join(', ')}`);
  }
  return params as Record<K, string>;
}

function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * OAuth 2.1 authorization server for the MCP endpoint: authorization code flow with PKCE for public clients
 * identified by Client ID Metadata Documents. Authorization requests and codes are signed JWTs, so only the
 * resulting grants are stored, as records of the auth secret resource.
 */
export class McpOAuth {
  readonly mcpUrl: string;
  readonly resourceMetadataUrl: string;
  private readonly issuer: string;
  private readonly apiUrl: string;
  private readonly consentPageUrl: string;
  private readonly configuredClients: Map<string, McpOAuthClient>;

  /** `configuredClients` are trusted as is, without fetching their client metadata documents. */
  constructor(
    private readonly adminforth: IAdminForth,
    private readonly store: McpAuthSecretStore,
    adminPanelOrigin: string,
    configuredClients: McpOAuthClient[] = [],
  ) {
    this.configuredClients = new Map(configuredClients.map((client) => [client.clientId, client]));
    const baseUrl = adminforth.config.baseUrl;
    this.apiUrl = new URL(`${baseUrl}/adminapi/v1`, adminPanelOrigin).href;
    this.mcpUrl = `${this.apiUrl}/mcp`;
    this.issuer = this.mcpUrl;
    this.resourceMetadataUrl = `${this.apiUrl}${OAUTH_PATHS.protectedResourceMetadata}`;
    this.consentPageUrl = new URL(`${baseUrl}${CONSENT_PAGE_PATH}`, adminPanelOrigin).href;
  }

  protectedResourceMetadata() {
    return {
      resource: this.mcpUrl,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ['header'],
    };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.apiUrl}${OAUTH_PATHS.authorize}`,
      token_endpoint: `${this.apiUrl}${OAUTH_PATHS.token}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      // Required by OpenID Connect Discovery, which clients validate this document against. No ID tokens are
      // issued, so the key set is empty.
      jwks_uri: `${this.apiUrl}${OAUTH_PATHS.jwks}`,
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    };
  }

  /** Validates the authorization request and returns the consent page URL to redirect the browser to. */
  async authorize(query: Record<string, unknown>): Promise<string> {
    const params = requireParams(query, [
      'response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method',
    ]);
    if (params.response_type !== 'code') {
      throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
    }
    if (params.code_challenge_method !== 'S256') {
      throw new OAuthError('invalid_request', 'Only code_challenge_method=S256 is supported');
    }
    this.checkResource(query.resource);
    if (!URL.canParse(params.redirect_uri) || !isAllowedRedirectUri(params.redirect_uri)) {
      throw new OAuthError('invalid_request', 'redirect_uri must use https unless it points to localhost');
    }

    const client = this.configuredClients.get(params.client_id) ?? await fetchClientMetadata(params.client_id);
    if (!client.redirectUris.some((registered) => redirectUriMatches(params.redirect_uri, registered))) {
      throw new OAuthError('invalid_request', 'redirect_uri is not listed in the client metadata document');
    }

    const request: AuthorizationRequest = {
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      state: typeof query.state === 'string' ? query.state : undefined,
      loopbackRedirect: isLoopbackRedirectUri(params.redirect_uri),
    };
    const signedRequest = this.adminforth.auth.issueJWT(request, REQUEST_JWT_TYPE, REQUEST_TTL);
    return `${this.consentPageUrl}?request=${encodeURIComponent(signedRequest)}`;
  }

  /** What the consent page shows about a pending authorization request. */
  async describeAuthorization(signedRequest: string) {
    const request = await this.verifyAuthorizationRequest(signedRequest);
    return {
      clientName: request.clientName,
      // Null for a configured client whose client_id is not a metadata document URL.
      clientHost: URL.parse(request.clientId)?.host ?? null,
      redirectHost: new URL(request.redirectUri).host,
      loopbackRedirect: request.loopbackRedirect,
    };
  }

  /** Approves or denies a pending authorization request and returns where to send the browser. */
  async resolveAuthorization(signedRequest: string, approved: boolean, adminUser: AdminUser): Promise<string> {
    const request = await this.verifyAuthorizationRequest(signedRequest);
    const url = new URL(request.redirectUri);
    if (approved) {
      const code: AuthorizationCode = {
        jti: randomUUID(),
        pk: adminUser.pk!,
        clientId: request.clientId,
        clientName: request.clientName,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
      };
      url.searchParams.set('code', this.adminforth.auth.issueJWT(code, CODE_JWT_TYPE, CODE_TTL));
    } else {
      url.searchParams.set('error', 'access_denied');
    }
    if (request.state !== undefined) {
      url.searchParams.set('state', request.state);
    }
    url.searchParams.set('iss', this.issuer);
    return url.href;
  }

  async exchangeToken(body: Record<string, unknown>) {
    if (body.grant_type === 'authorization_code') return this.redeemAuthorizationCode(body);
    if (body.grant_type === 'refresh_token') return this.refreshAccessToken(body);
    throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token grants are supported');
  }

  /** Returns the grant an OAuth access token was issued for, or null for an invalid or expired token. */
  async verifyAccessToken(token: string): Promise<AccessToken | null> {
    return this.adminforth.auth.verify(token, ACCESS_TOKEN_JWT_TYPE, false);
  }

  private checkResource(resource: unknown): void {
    if (resource !== undefined && resource !== this.mcpUrl) {
      throw new OAuthError('invalid_target', `resource must be ${this.mcpUrl}`);
    }
  }

  private async verifyAuthorizationRequest(signedRequest: string): Promise<AuthorizationRequest> {
    const request = await this.adminforth.auth.verify(signedRequest, REQUEST_JWT_TYPE, false);
    if (!request) {
      throw new OAuthError('invalid_request', 'Authorization request is invalid or expired, start connecting again');
    }
    return request;
  }

  private async redeemAuthorizationCode(body: Record<string, unknown>) {
    const params = requireParams(body, ['code', 'code_verifier', 'client_id', 'redirect_uri']);
    this.checkResource(body.resource);

    const code: AuthorizationCode | null = await this.adminforth.auth.verify(params.code, CODE_JWT_TYPE, false);
    if (!code) {
      throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired');
    }
    if (code.clientId !== params.client_id || code.redirectUri !== params.redirect_uri) {
      throw new OAuthError('invalid_grant', 'Authorization code was issued for another client_id or redirect_uri');
    }
    if (pkceChallenge(params.code_verifier) !== code.codeChallenge) {
      throw new OAuthError('invalid_grant', 'code_verifier does not match the code challenge');
    }

    const refreshToken = randomBytes(32).toString('base64url');
    const result = await this.store.createOAuthGrant({
      id: code.jti,
      userId: code.pk,
      clientId: code.clientId,
      clientName: code.clientName,
    }, refreshToken);
    if (result.error) {
      throw new OAuthError('invalid_grant', result.error);
    }
    return this.tokenResponse({ pk: code.pk, grantId: code.jti }, refreshToken);
  }

  private async refreshAccessToken(body: Record<string, unknown>) {
    const params = requireParams(body, ['refresh_token', 'client_id']);
    this.checkResource(body.resource);

    const refreshToken = randomBytes(32).toString('base64url');
    const grant = await this.store.rotateRefreshToken(params.refresh_token, params.client_id, refreshToken);
    if (!grant) {
      throw new OAuthError('invalid_grant', 'Refresh token is invalid or was already used');
    }
    return this.tokenResponse({ pk: grant.userId, grantId: grant.grantId }, refreshToken);
  }

  private tokenResponse(accessToken: AccessToken, refreshToken: string) {
    return {
      access_token: this.adminforth.auth.issueJWT(accessToken, ACCESS_TOKEN_JWT_TYPE, ACCESS_TOKEN_TTL_SECONDS),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
    };
  }
}
