import type { PluginsCommonOptions } from 'adminforth';

export interface McpTokenResourceOptions {
  resourceId: string;
  idField: string;
  nameField: string;
  tokenHashField: string;
  userIdField: string;
  createdAtField: string;
  lastUsedAtField: string;
  agentField: string;
}

export interface PluginOptions extends PluginsCommonOptions {
  tokenResource: McpTokenResourceOptions;
}

export interface McpClientInfo {
  client: string;
  ver: string | null;
}
