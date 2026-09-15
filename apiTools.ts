import type {
  AdminUser,
  IAdminForth,
  IAdminForthHttpResponse,
  IRegisteredApiSchema,
} from 'adminforth';

const METHODS_WITHOUT_REQUEST_BODY = new Set(['GET', 'HEAD']);

type RegisteredToolSchema = IRegisteredApiSchema & {
  handler: NonNullable<IRegisteredApiSchema['handler']>;
};

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { destructiveHint: boolean };
}

function isRegisteredToolSchema(schema: IRegisteredApiSchema): schema is RegisteredToolSchema {
  return typeof schema.handler === 'function';
}

function endpointPathToToolName(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stripAdminApiPrefix(path: string, adminforth: IAdminForth): string {
  const baseUrl = (adminforth.config.baseUrl ?? '').replace(/\/$/, '');
  const apiPrefix = `${baseUrl}/adminapi/v1`;
  const strippedPath = path.startsWith(apiPrefix) ? path.slice(apiPrefix.length) : path;
  return strippedPath.startsWith('/') ? strippedPath : `/${strippedPath}`;
}

function createDirectResponse(): IAdminForthHttpResponse & { status: number; message?: string } {
  return {
    status: 200,
    setHeader() {},
    setStatus(status, message) {
      this.status = status;
      this.message = message;
    },
    blobStream() {
      throw new Error('File streaming is not available through MCP tools');
    },
  };
}

export class AdminForthApiTools {
  constructor(
    private readonly adminforth: IAdminForth,
    private readonly hiddenResourceIds: ReadonlySet<string>,
  ) {}

  private schemas(): Map<string, RegisteredToolSchema> {
    const schemas = new Map<string, RegisteredToolSchema>();

    for (const schema of this.adminforth.openApi.registeredSchemas) {
      if (!isRegisteredToolSchema(schema)) continue;
      const path = stripAdminApiPrefix(schema.path, this.adminforth);
      if (path === '/mcp' || path.startsWith('/mcp/')) continue;
      schemas.set(endpointPathToToolName(path), schema);
    }

    return schemas;
  }

  list(): McpToolDefinition[] {
    return Array.from(this.schemas().entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, schema]) => ({
        name,
        ...(schema.description && { description: schema.description }),
        inputSchema: schema.request_schema ?? {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        ...(schema.agent?.isDangerous && {
          annotations: { destructiveHint: true },
        }),
      }));
  }

  async call(params: {
    name: string;
    arguments?: Record<string, unknown>;
    adminUser: AdminUser;
    headers: Record<string, any>;
    requestUrl: string;
    abortSignal: AbortSignal;
  }): Promise<{ output: unknown; isError: boolean }> {
    const schema = this.schemas().get(params.name);
    if (!schema) {
      return { output: { error: `Unknown tool: ${params.name}` }, isError: true };
    }
    if (
      typeof params.arguments?.resourceId === 'string'
      && this.hiddenResourceIds.has(params.arguments.resourceId)
    ) {
      return {
        output: { error: 'This resource is not available through MCP.' },
        isError: true,
      };
    }

    const method = schema.method.toUpperCase();
    const hasBody = !METHODS_WITHOUT_REQUEST_BODY.has(method);
    const body = hasBody ? (params.arguments ?? {}) : {};
    const query = hasBody ? {} : (params.arguments ?? {});
    const requestValidation = this.adminforth.openApi.validateRequestSchema(schema, body);
    if (!requestValidation.valid) {
      return {
        output: { error: 'REQUEST_VALIDATION_FAILED', details: requestValidation.errors },
        isError: true,
      };
    }

    const response = createDirectResponse();
    const language = String(params.headers['accept-language'] ?? 'en');
    const output = await schema.handler({
      body,
      query,
      headers: params.headers,
      cookies: [],
      adminUser: params.adminUser,
      response,
      requestUrl: params.requestUrl,
      abortSignal: params.abortSignal,
      _raw_express_req: undefined as never,
      _raw_express_res: undefined as never,
      tr: (message, category, translationParams, pluralizationNumber) => this.adminforth.tr(
        message,
        category,
        language,
        translationParams,
        pluralizationNumber,
      ),
    });

    if (response.message) {
      return {
        output: response.message,
        isError: response.status >= 400,
      };
    }
    if (output === undefined) {
      return {
        output: { error: 'Tool handler completed without returning a response.' },
        isError: true,
      };
    }

    const responseValidation = this.adminforth.openApi.validateResponseSchema(schema, output);
    if (!responseValidation.valid) {
      return {
        output: { error: 'RESPONSE_VALIDATION_FAILED', details: responseValidation.errors },
        isError: true,
      };
    }

    return {
      output,
      isError: response.status >= 400 || Boolean(
        output && typeof output === 'object' && 'error' in output,
      ),
    };
  }
}
