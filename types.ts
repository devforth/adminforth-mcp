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
}

export interface McpPageSize {
  /** Rows get_resource_data returns when the client does not pass limit. */
  default: number;
  /** Most rows get_resource_data returns per call; larger limits are capped. */
  max: number;
}

export interface PluginOptions extends PluginsCommonOptions {
  authSecretResource: McpAuthSecretResourceOptions;
  /** Public origin of this AdminForth installation, without the AdminForth baseUrl path. */
  adminPanelOrigin?: string;
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
