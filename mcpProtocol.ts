import {
  createMcpHandler,
  InMemoryTransport,
  McpServer,
  type Implementation,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/server';
import YAML from 'yaml';

const UNCACHED = { ttlMs: 0, cacheScope: 'private' } as const;

export interface McpServerPresentation {
  serverInfo: Implementation;
  instructions: string;
}

export function createMcpServerPresentation(
  brandName: string,
  adminPanelUrl: string,
  guidance = '',
  readOnly = false,
): McpServerPresentation {
  const adminPanel = `AdminForth admin panel for "${brandName}" at ${adminPanelUrl}`;
  return {
    serverInfo: {
      name: 'adminforth-mcp',
      title: `${brandName} Admin Panel`,
      version: '1.0.0',
      description: `${adminPanel}.`,
      websiteUrl: adminPanelUrl,
    },
    instructions: [
      `This is the ${adminPanel}. Use its tools to ${readOnly ? 'read' : 'read and update'} data allowed for the authenticated user.`,
      guidance,
    ].filter(Boolean).join('\n\n'),
  };
}

export interface McpProtocolContext extends McpServerPresentation {
  listTools: () => Tool[];
  callTool: (
    name: string,
    arguments_: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ) => Promise<{ output: unknown; isError: boolean }>;
}

// The JSON round trip drops functions and undefined values that handler responses may carry, which YAML cannot serialize.
function serializeToolOutput(output: unknown): string {
  return typeof output === 'string' ? output : YAML.stringify(JSON.parse(JSON.stringify(output ?? null)));
}

function createServer({ serverInfo, instructions, listTools, callTool }: McpProtocolContext): McpServer {
  const server = new McpServer(serverInfo, {
    capabilities: { tools: { listChanged: false } },
    instructions,
    cacheHints: { 'tools/list': UNCACHED, 'server/discover': UNCACHED },
  });
  server.server.setRequestHandler('tools/list', () => ({ tools: listTools() }));
  server.server.setRequestHandler('tools/call', async ({ params }, ctx) => {
    const { output, isError } = await callTool(params.name, params.arguments, ctx.mcpReq.signal);
    return { content: [{ type: 'text', text: serializeToolOutput(output) }], isError };
  });
  return server;
}

export class McpProtocol {
  private readonly contexts = new WeakMap<Request, McpProtocolContext>();
  private readonly handler = createMcpHandler(({ requestInfo }) => createServer(this.contexts.get(requestInfo!)!));

  handle(request: Request, parsedBody: unknown, context: McpProtocolContext): Promise<Response> {
    this.contexts.set(request, context);
    return this.handler.fetch(request, { parsedBody });
  }

  async open(context: McpProtocolContext): Promise<Transport> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(context).connect(serverTransport);
    return clientTransport;
  }
}
