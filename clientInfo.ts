import type { McpClientInfo } from './types.js';

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const NON_CLIENT_NAME_CHARACTER_RE = /[^a-z0-9]+/g;
const EDGE_HYPHEN_RE = /^-+|-+$/g;
const USER_AGENT_PRODUCT_RE = /^([^/\s]+)(?:\/(\S+))?/;

export const UNKNOWN_CLIENT = 'unknown-agent';

function normalizeClientName(name: string): string {
  return name.toLowerCase().replace(NON_CLIENT_NAME_CHARACTER_RE, '-').replace(EDGE_HYPHEN_RE, '');
}

function parseUserAgent(userAgent: string): McpClientInfo | null {
  const [, name, version] = userAgent.match(USER_AGENT_PRODUCT_RE) ?? [];
  return name ? { client: normalizeClientName(name), ver: version ?? null } : null;
}

export function readMcpClient(
  body: Record<string, any>,
  headers: Record<string, any>,
): McpClientInfo {
  const clientInfo = body.params?._meta?.[CLIENT_INFO_META_KEY] ?? (
    body.method === 'initialize' ? body.params?.clientInfo : undefined
  );

  if (clientInfo?.name) {
    return {
      client: normalizeClientName(clientInfo.name),
      ver: clientInfo.version ?? null,
    };
  }

  return parseUserAgent(String(headers['user-agent'] ?? '')) ?? {
    client: UNKNOWN_CLIENT,
    ver: null,
  };
}

export function canonicalAgentName(client: string): string {
  if (client.includes('claude') && client.includes('code')) return 'claude-code';
  if (client.includes('claude')) return 'claude';
  if (client.includes('codex') || client.includes('openai') || client === 'undici') return 'codex';
  if (client.includes('gemini')) return 'gemini';
  return client;
}

export function formatMcpExecutedBy(client: McpClientInfo, authSecretName: string): string {
  const version = client.ver ? `@${client.ver}` : '';
  return `${canonicalAgentName(client.client)}${version} | ${authSecretName}`;
}
