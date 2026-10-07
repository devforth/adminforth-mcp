export const MCP_PATH = '/mcp';

/** Path prefix of AdminForth API endpoints, e.g. `/admin/adminapi/v1`. */
export function adminApiPrefix(baseUrl: string): string {
  return `${baseUrl}/adminapi/v1`;
}

/**
 * Public URLs of the plugin, built once from adminPanelOrigin: the settings page, OAuth metadata and the MCP server
 * info must all name the same URL, because OAuth accepts tokens only for the exact MCP resource URL.
 */
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
