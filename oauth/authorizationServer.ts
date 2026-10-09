import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AdminUser, IAdminForth } from 'adminforth';
import type { McpAuthSecretStore } from '../authSecretStore.js';
import {
  fetchClientMetadata,
  isAllowedRedirectUri,
  isClientIdUrl,
  isLoopbackUrl,
  redirectUriMatches,
} from './clientMetadata.js';
import { OAuthError } from './errors.js';
import type { McpOAuthClient } from '../types.js';
import { MCP_PATH, type McpUrls } from '../urls.js';

const REQUEST_JWT_TYPE = 'mcp-oauth-request';
const CODE_JWT_TYPE = 'mcp-oauth-code';
const ACCESS_TOKEN_JWT_TYPE = 'mcp-oauth-access';
const REFRESH_TOKEN_JWT_TYPE = 'mcp-oauth-refresh';
const REQUEST_TTL = '10m';
const CODE_TTL = '5m';
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
// Every refresh issues a new token, so a connection expires only after this long without use.
const REFRESH_TOKEN_TTL = '7d';
const CLIENT_METADATA_TTL_MS = 10 * 60 * 1000;

/** Endpoint paths relative to the AdminForth API prefix (`<baseUrl>/adminapi/v1`). */
export const OAUTH_PATHS = {
  protectedResourceMetadata: `${MCP_PATH}/oauth-protected-resource`,
  // Clients derive authorization server metadata URL from the issuer; for an issuer with a path, the
  // OpenID Connect Discovery form `<issuer>/.well-known/openid-configuration` is the only one not at the host root,
  // so it works behind a proxy that forwards only the AdminForth path. The host-root forms are in oauthEndpoints.ts.
  authorizationServerMetadata: `${MCP_PATH}/.well-known/openid-configuration`,
  jwks: `${MCP_PATH}/oauth/jwks`,
  authorize: `${MCP_PATH}/oauth/authorize`,
  token: `${MCP_PATH}/oauth/token`,
  authorization: `${MCP_PATH}/oauth/authorization`,
};
export const CONSENT_PAGE_PATH = '/mcp-authorize';

interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
}

/** An authorization request checked against the client metadata, once the signed-in user opened the consent page. */
interface VerifiedAuthorizationRequest {
  request: AuthorizationRequest;
  client: McpOAuthClient;
  redirectUrl: URL;
}

interface AuthorizationCode {
  jti: string;
  pk: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  readOnly: boolean;
}

interface AccessToken {
  pk: string;
  grantId: string;
  // The MCP URL the token is issued for (RFC 8707): installations sharing ADMINFORTH_SECRET reject each other's tokens.
  aud: string;
}

interface RefreshToken {
  grantId: string;
  // Makes every rotated token differ, even two issued for one grant within the same second.
  nonce: string;
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
  private readonly fetchedClients = new Map<string, { client: McpOAuthClient; expiresAt: number }>();

  /**
   * `configuredClients` are trusted as is, without fetching their client metadata documents. `serverReadOnly` is
   * the plugin readOnly option: it makes every connection read-only, whatever the user chooses on the consent page.
   */
  constructor(
    private readonly adminforth: IAdminForth,
    private readonly store: McpAuthSecretStore,
    urls: McpUrls,
    configuredClients: McpOAuthClient[] = [],
    private readonly serverReadOnly = false,
  ) {
    this.configuredClients = new Map(configuredClients.map((client) => [client.clientId, client]));
    this.apiUrl = urls.apiUrl;
    this.mcpUrl = urls.mcpUrl;
    this.issuer = this.mcpUrl;
    this.resourceMetadataUrl = `${this.apiUrl}${OAUTH_PATHS.protectedResourceMetadata}`;
    this.consentPageUrl = new URL(`${adminforth.config.baseUrl}${CONSENT_PAGE_PATH}`, this.apiUrl).href;
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

  /**
   * Validates the authorization request and returns the consent page URL to redirect the browser to.
   * This endpoint needs no sign-in, so the client metadata document is fetched only once the user opens the
   * consent page: otherwise anyone could make this server send requests to any URL passed as client_id.
   */
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
    const redirectUrl = URL.parse(params.redirect_uri);
    if (!redirectUrl || !isAllowedRedirectUri(redirectUrl)) {
      throw new OAuthError('invalid_request', 'redirect_uri must use https unless it points to localhost');
    }
    if (!this.configuredClients.has(params.client_id) && !isClientIdUrl(params.client_id)) {
      throw new OAuthError('invalid_client', 'client_id must be the https URL of a client metadata document');
    }

    const request: AuthorizationRequest = {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      state: typeof query.state === 'string' ? query.state : undefined,
    };
    const signedRequest = this.adminforth.auth.issueJWT(request, REQUEST_JWT_TYPE, REQUEST_TTL);
    return `${this.consentPageUrl}?request=${encodeURIComponent(signedRequest)}`;
  }

  /** What the consent page shows about a pending authorization request. */
  async describeAuthorization(signedRequest: string) {
    const { request, client, redirectUrl } = await this.verifyAuthorizationRequest(signedRequest);
    return {
      clientName: client.clientName,
      // Null for a configured client whose client_id is not a metadata document URL.
      clientHost: URL.parse(request.clientId)?.host ?? null,
      redirectHost: redirectUrl.host,
      loopbackRedirect: isLoopbackUrl(redirectUrl),
      serverReadOnly: this.serverReadOnly,
    };
  }

  /**
   * Approves or denies a pending authorization request and returns where to send the browser. `readOnly` is the
   * choice of the user on the consent page; the connection is read-only with it or with the plugin readOnly option.
   */
  async resolveAuthorization(
    signedRequest: string,
    approved: boolean,
    adminUser: AdminUser,
    readOnly = false,
  ): Promise<string> {
    // Denying redirects too, so the redirect_uri is checked against the client metadata either way.
    const { request, client, redirectUrl: url } = await this.verifyAuthorizationRequest(signedRequest);
    if (approved) {
      const code: AuthorizationCode = {
        jti: randomUUID(),
        pk: adminUser.pk!,
        clientId: request.clientId,
        clientName: client.clientName,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        readOnly: this.serverReadOnly || readOnly,
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

  /** Returns the grant an OAuth access token was issued for, or null for an invalid, expired or foreign token. */
  async verifyAccessToken(token: string): Promise<AccessToken | null> {
    const accessToken: AccessToken | null = await this.adminforth.auth.verify(token, ACCESS_TOKEN_JWT_TYPE, false);
    return accessToken?.aud === this.mcpUrl ? accessToken : null;
  }

  private checkResource(resource: unknown): void {
    if (resource !== undefined && resource !== this.mcpUrl) {
      throw new OAuthError('invalid_target', `resource must be ${this.mcpUrl}`);
    }
  }

  private async verifyAuthorizationRequest(signedRequest: string): Promise<VerifiedAuthorizationRequest> {
    const request: AuthorizationRequest | null = await this.adminforth.auth.verify(
      signedRequest, REQUEST_JWT_TYPE, false,
    );
    if (!request) {
      throw new OAuthError('invalid_request', 'Authorization request is invalid or expired, start connecting again');
    }
    const client = await this.lookUpClient(request.clientId);
    const redirectUrl = new URL(request.redirectUri);
    if (!client.redirectUris.some((registered) => redirectUriMatches(redirectUrl, registered))) {
      throw new OAuthError('invalid_request', 'redirect_uri is not listed in the client metadata document');
    }
    return { request, client, redirectUrl };
  }

  /** The consent page loads the client to describe it and again to resolve the request, hence the cache. */
  private async lookUpClient(clientId: string): Promise<McpOAuthClient> {
    const configured = this.configuredClients.get(clientId);
    if (configured) return configured;

    const cached = this.fetchedClients.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.client;

    const client = await fetchClientMetadata(clientId);
    this.fetchedClients.set(clientId, { client, expiresAt: Date.now() + CLIENT_METADATA_TTL_MS });
    return client;
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

    const refreshToken = this.issueRefreshToken(code.jti);
    const result = await this.store.createOAuthGrant({
      id: code.jti,
      userId: code.pk,
      clientId: code.clientId,
      clientName: code.clientName,
      readOnly: code.readOnly,
    }, refreshToken);
    if (result.error) {
      throw new OAuthError('invalid_grant', result.error);
    }
    return this.tokenResponse(code.pk, code.jti, refreshToken);
  }

  private async refreshAccessToken(body: Record<string, unknown>) {
    const params = requireParams(body, ['refresh_token', 'client_id']);
    this.checkResource(body.resource);

    // The signature tells a token this server issued from a made-up one: a made-up token knowing a grant id must
    // not revoke that grant, and anonymous callers must not reach the store or its lock.
    const presented: RefreshToken | null = await this.adminforth.auth.verify(
      params.refresh_token, REFRESH_TOKEN_JWT_TYPE, false,
    );
    if (!presented) {
      throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired');
    }

    const { grantId } = presented;
    const refreshToken = this.issueRefreshToken(grantId);
    const userId = await this.store.rotateRefreshToken(grantId, params.refresh_token, params.client_id, refreshToken);
    if (!userId) {
      throw new OAuthError('invalid_grant', 'Refresh token was already used or its connection was revoked');
    }
    return this.tokenResponse(userId, grantId, refreshToken);
  }

  private issueRefreshToken(grantId: string): string {
    const token: RefreshToken = { grantId, nonce: randomBytes(16).toString('base64url') };
    return this.adminforth.auth.issueJWT(token, REFRESH_TOKEN_JWT_TYPE, REFRESH_TOKEN_TTL);
  }

  private tokenResponse(pk: string, grantId: string, refreshToken: string) {
    const accessToken: AccessToken = { pk, grantId, aud: this.mcpUrl };
    return {
      access_token: this.adminforth.auth.issueJWT(accessToken, ACCESS_TOKEN_JWT_TYPE, ACCESS_TOKEN_TTL_SECONDS),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
    };
  }
}
