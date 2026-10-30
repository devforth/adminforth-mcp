import type { AdminUser, PluginsCommonOptions } from 'adminforth';
import type { McpConnection } from './adminPanelConfirmation.js';

export interface McpAuthSecretResourceOptions {
  resourceId: string;
  idField: string;
  nameField: string;
  secretHashField: string;
  userIdField: string;
  createdAtField: string;
  lastUsedAtField: string;
  lastUsedByAgentField: string;
  readOnlyField: string;
  oauthClientIdField: string;
}

/** An MCP client allowed to connect through OAuth, as its Client ID Metadata Document describes it. */
export interface McpOAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export interface McpPageSize {
  default: number;
  max: number;
}

interface McpCommonPluginOptions extends PluginsCommonOptions {
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
  /**
   * Expose only endpoints marked with `agent: { onlyReadsData: true }`: with true to every connection, with a function
   * to the connections of users it returns true for, checked on every MCP request.
   * Without it, read-only mode is chosen per auth secret.
   */
  readOnly?: boolean | ((input: { adminUser: AdminUser }) => boolean | Promise<boolean>);
}

/** Serves MCP clients over HTTP besides the in-process connections of the agent plugin. */
export interface McpExternalPluginOptions extends McpCommonPluginOptions {
  internalOnly?: false;
  authSecretResource: McpAuthSecretResourceOptions;
  /**
   * Public origin of this AdminForth installation, without the AdminForth baseUrl path, e.g. https://example.com.
   * The MCP server URL shown on the settings page, the OAuth issuer and resource URLs are built from it, so it must
   * be the origin MCP clients connect to.
   */
  adminPanelOrigin: string;
  /**
   * MCP clients resolved from this list instead of fetching their Client ID Metadata Document, so OAuth can be
   * tried locally without a public https URL. Ignored when NODE_ENV is "production": there every client_id is
   * fetched as a document with SSRF checks. Unlisted client_ids are fetched in development too.
   */
  devOAuthClients?: McpOAuthClient[];
}

export interface McpInternalOnlyPluginOptions extends McpCommonPluginOptions {
  /**
   * Serve only the in-process connections of the agent plugin: no MCP endpoint, OAuth sign-in, auth secrets or
   * MCP settings page, so neither authSecretResource nor adminPanelOrigin is needed.
   */
  internalOnly: true;
}

export type PluginOptions = McpExternalPluginOptions | McpInternalOnlyPluginOptions;

export interface McpClientInfo {
  client: string;
  ver: string | null;
}

export interface McpSession {
  adminUser: AdminUser;
  connection: McpConnection;
  readOnly: boolean;
  headers: Record<string, any>;
  requestUrl: string;
  /**
   * Public origin the user works with the admin panel on, e.g. https://example.com. Links to admin panel pages,
   * such as 2FA confirmations, and the server instructions are built from it.
   */
  adminPanelOrigin: string;
  /** IANA time zone, e.g. Europe/Kyiv, to show datetimes of get_resource_data in. Without it they are UTC. */
  timeZone?: string;
}
