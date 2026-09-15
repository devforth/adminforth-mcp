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

export interface PluginOptions extends PluginsCommonOptions {
  authSecretResource: McpAuthSecretResourceOptions;
  /** Public origin of this AdminForth installation, without the AdminForth baseUrl path. */
  adminPanelOrigin?: string;
}

export interface McpClientInfo {
  client: string;
  ver: string | null;
}
