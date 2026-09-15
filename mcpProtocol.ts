import type { McpToolDefinition } from './apiTools.js';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const LEGACY_PROTOCOL_VERSIONS = new Set([
  LEGACY_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
]);

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

type JsonRpcId = string | number;

export interface McpServerInfo {
  name: string;
  title: string;
  version: string;
  description: string;
  websiteUrl?: string;
}

export interface McpServerPresentation {
  serverInfo: McpServerInfo;
  instructions: string;
}

export function createMcpServerPresentation(
  brandName: string,
  adminPanelOrigin?: string,
  baseUrl = '',
): McpServerPresentation {
  const adminPanelUrl = adminPanelOrigin
    ? new URL(baseUrl || '/', adminPanelOrigin).toString()
    : undefined;
  const adminPanel = `AdminForth admin panel for "${brandName}"${adminPanelUrl ? ` at ${adminPanelUrl}` : ''}`;
  return {
    serverInfo: {
      name: 'adminforth-mcp',
      title: `${brandName} Admin Panel`,
      version: '1.0.0',
      description: `${adminPanel}.`,
      ...(adminPanelUrl && { websiteUrl: adminPanelUrl }),
    },
    instructions: `This is the ${adminPanel}. Use its tools to read and update data allowed for the authenticated user.`,
  };
}

export interface McpProtocolContext {
  body: Record<string, any>;
  headers: Record<string, any>;
  serverInfo: McpServerInfo;
  instructions: string;
  listTools: () => McpToolDefinition[];
  callTool: (
    name: string,
    arguments_: Record<string, unknown> | undefined,
  ) => Promise<{ output: unknown; isError: boolean }>;
}

export interface McpProtocolResponse {
  status: number;
  body?: Record<string, unknown>;
}

function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  status = 400,
): McpProtocolResponse {
  return {
    status,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  };
}

function isModernRequest(body: Record<string, any>): boolean {
  return body.params?._meta?.[PROTOCOL_VERSION_META_KEY] === MODERN_PROTOCOL_VERSION;
}

function completeResult(
  result: Record<string, unknown>,
  modern: boolean,
  serverInfo: McpServerInfo,
) {
  if (!modern) return result;
  return {
    resultType: 'complete',
    ...result,
    _meta: {
      ...(result._meta as Record<string, unknown> | undefined),
      [SERVER_INFO_META_KEY]: serverInfo,
    },
  };
}

function successResponse(
  id: JsonRpcId,
  result: Record<string, unknown>,
  modern: boolean,
  serverInfo: McpServerInfo,
): McpProtocolResponse {
  return {
    status: 200,
    body: {
      jsonrpc: '2.0',
      id,
      result: completeResult(result, modern, serverInfo),
    },
  };
}

function validateModernHeaders(
  body: Record<string, any>,
  headers: Record<string, any>,
): McpProtocolResponse | null {
  const meta = body.params?._meta;
  if (!meta || !(CLIENT_CAPABILITIES_META_KEY in meta)) {
    return errorResponse(body.id ?? null, -32602, 'Missing required MCP request metadata.');
  }
  if (
    headers['mcp-protocol-version'] !== MODERN_PROTOCOL_VERSION
    || headers['mcp-method'] !== body.method
    || (body.method === 'tools/call' && headers['mcp-name'] !== body.params?.name)
  ) {
    return errorResponse(body.id ?? null, -32020, 'MCP request headers do not match the JSON-RPC body.');
  }
  return null;
}

function serializeToolOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output, null, 2);
}

export async function handleMcpProtocol(
  context: McpProtocolContext,
): Promise<McpProtocolResponse> {
  const { body, headers, serverInfo, instructions } = context;
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return errorResponse(body.id ?? null, -32600, 'Invalid JSON-RPC request.');
  }

  const modern = isModernRequest(body);
  const requestedVersion = body.params?._meta?.[PROTOCOL_VERSION_META_KEY];
  if (requestedVersion && requestedVersion !== MODERN_PROTOCOL_VERSION) {
    return errorResponse(body.id ?? null, -32000, `Unsupported MCP protocol version: ${requestedVersion}`);
  }
  if (modern) {
    const headerError = validateModernHeaders(body, headers);
    if (headerError) return headerError;
  }

  if (body.id === undefined) {
    return { status: 202 };
  }
  if (typeof body.id !== 'string' && typeof body.id !== 'number') {
    return errorResponse(null, -32600, 'JSON-RPC id must be a string or number.');
  }

  switch (body.method) {
    case 'server/discover':
      if (!modern) {
        return errorResponse(body.id, -32602, 'server/discover requires modern MCP request metadata.');
      }
      return successResponse(body.id, {
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        instructions,
        ttlMs: 0,
        cacheScope: 'private',
      }, true, serverInfo);

    case 'initialize': {
      const requestedVersion = body.params?.protocolVersion;
      return successResponse(body.id, {
        protocolVersion: typeof requestedVersion === 'string' && LEGACY_PROTOCOL_VERSIONS.has(requestedVersion)
          ? requestedVersion
          : LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions,
      }, false, serverInfo);
    }

    case 'ping':
      return successResponse(body.id, {}, modern, serverInfo);

    case 'tools/list':
      return successResponse(body.id, {
        tools: context.listTools(),
        ...(modern && { ttlMs: 0, cacheScope: 'private' }),
      }, modern, serverInfo);

    case 'tools/call': {
      if (typeof body.params?.name !== 'string') {
        return errorResponse(body.id, -32602, 'Tool name is required.');
      }
      const result = await context.callTool(body.params.name, body.params.arguments);
      return successResponse(body.id, {
        content: [{ type: 'text', text: serializeToolOutput(result.output) }],
        isError: result.isError,
      }, modern, serverInfo);
    }

    default:
      return errorResponse(body.id, -32601, `Method not found: ${body.method}`);
  }
}
