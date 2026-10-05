import type { PluginsCommonOptions } from 'adminforth';

export interface McpAuthSecretResourceOptions {
  resourceId: string;
  idField: string;
  nameField: string;
  secretHashField: string;
  userIdField: string;
  createdAtField: string;
  lastUsedAtField: string;
  lastUsedByAgentField: string;
  /**
   * Client ID Metadata Document URL of the MCP client connected through OAuth; empty for personal auth secrets.
   * Setting it enables OAuth sign-in, which also needs adminPanelOrigin. Without it only auth secrets work.
   */
  oauthClientIdField?: string;
}

/** An MCP client allowed to connect through OAuth, as its Client ID Metadata Document describes it. */
export interface McpOAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export interface McpPageSize {
  /** Rows get_resource_data returns when the client does not pass limit. */
  default: number;
  /** Most rows get_resource_data returns per call; larger limits are capped. */
  max: number;
}

export interface PluginOptions extends PluginsCommonOptions {
  authSecretResource: McpAuthSecretResourceOptions;
  /**
   * Public origin of this AdminForth installation, without the AdminForth baseUrl path, e.g. https://example.com.
   * Required with OAuth sign-in: OAuth issuer and MCP resource URLs are built from it, so it must be the origin
   * MCP clients connect to.
   */
  adminPanelOrigin?: string;
  /**
   * MCP clients resolved from this list instead of fetching their Client ID Metadata Document, so OAuth can be
   * tried locally without a public https URL. Ignored when NODE_ENV is "production": there every client_id is
   * fetched as a document with SSRF checks. Unlisted client_ids are fetched in development too.
   */
  devOAuthClients?: McpOAuthClient[];
  /** Page size limits for get_resource_data, also quoted in the MCP instructions and skills. Defaults to 10 and 100. */
  pageSize?: Partial<McpPageSize>;
  /** How long a tool handler may run before the call fails with a timeout error. Defaults to 15000 ms. */
  toolTimeoutMs?: number;
  /**
   * Tool calls an agent may make for one user request before it must ask the user to continue. Defaults to 10.
   * MCP clients do not tell the server where a user request starts, so this is a rule in the MCP instructions,
   * not a server-side limit.
   */
  toolCallsPerRequest?: number;
}

export interface McpClientInfo {
  client: string;
  ver: string | null;
}
