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
  readOnlyField: string;
}

export interface PluginOptions extends PluginsCommonOptions {
  authSecretResource: McpAuthSecretResourceOptions;
  /** Public origin of this AdminForth installation, without the AdminForth baseUrl path. */
  adminPanelOrigin?: string;
  /**
   * Expose only endpoints marked with `agent: { onlyReadsData: true }` to every auth secret.
   * Without it, read-only mode is chosen per auth secret.
   */
  readOnly?: boolean;
}

export interface McpClientInfo {
  client: string;
  ver: string | null;
}
