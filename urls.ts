export const MCP_PATH = '/mcp';
export const CONSENT_PAGE_PATH = '/mcp-authorize';

export const OAUTH_PATHS = {
  protectedResourceMetadata: `${MCP_PATH}/oauth-protected-resource`,
  authorizationServerMetadata: `${MCP_PATH}/.well-known/openid-configuration`,
  jwks: `${MCP_PATH}/oauth/jwks`,
  authorize: `${MCP_PATH}/oauth/authorize`,
  token: `${MCP_PATH}/oauth/token`,
  authorization: `${MCP_PATH}/oauth/authorization`,
};

export function adminApiPrefix(baseUrl: string): string {
  return `${baseUrl}/adminapi/v1`;
}

export interface McpUrls {
  apiUrl: string;
  mcpUrl: string;
  adminPanelUrl: string;
}

export function createMcpUrls(adminPanelOrigin: string, baseUrl: string): McpUrls {
  const apiUrl = new URL(adminApiPrefix(baseUrl), adminPanelOrigin).href;
  return {
    apiUrl,
    mcpUrl: `${apiUrl}${MCP_PATH}`,
    adminPanelUrl: new URL(baseUrl || '/', adminPanelOrigin).href,
  };
}
