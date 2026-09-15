import type { McpClientInfo } from './types.js';

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const NON_CLIENT_NAME_CHARACTER_RE = /[^a-z0-9]+/g;
const EDGE_HYPHEN_RE = /^-+|-+$/g;
const NON_CLIENT_VERSION_CHARACTER_RE = /[^A-Za-z0-9._-]+/g;
const USER_AGENT_PRODUCT_RE = /^([^/\s]+)(?:\/(\S+))?/;
// Client name and version are attacker-controlled: they are persisted as JSON and rendered into
// the audit "executed by" string, so they are sanitized and capped here, at the single entry point.
const MAX_CLIENT_NAME_LENGTH = 64;
const MAX_CLIENT_VERSION_LENGTH = 32;

export const UNKNOWN_CLIENT = 'unknown-agent';

function normalizeClientName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(NON_CLIENT_NAME_CHARACTER_RE, '-')
    .slice(0, MAX_CLIENT_NAME_LENGTH)
    .replace(EDGE_HYPHEN_RE, '');
}

function normalizeClientVersion(version: unknown): string | null {
  if (typeof version !== 'string') return null;
  return version
    .replace(NON_CLIENT_VERSION_CHARACTER_RE, '')
    .slice(0, MAX_CLIENT_VERSION_LENGTH) || null;
}

function parseUserAgent(userAgent: string): McpClientInfo | null {
  const [, name, version] = userAgent.match(USER_AGENT_PRODUCT_RE) ?? [];
  const client = normalizeClientName(name);
  return client ? { client, ver: normalizeClientVersion(version) } : null;
}

export function readMcpClient(
  body: Record<string, any>,
  headers: Record<string, any>,
): McpClientInfo {
  const clientInfo = body.params?._meta?.[CLIENT_INFO_META_KEY] ?? (
    body.method === 'initialize' ? body.params?.clientInfo : undefined
  );

  const client = normalizeClientName(clientInfo?.name);
  if (client) {
    return { client, ver: normalizeClientVersion(clientInfo.version) };
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
