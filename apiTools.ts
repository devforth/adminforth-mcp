import { compactInputSchema } from './inputSchema.js';
import type { McpPageSize } from './types.js';
import { adminApiPrefix, MCP_PATH } from './urls.js';
import { AdminForthDataTypes } from 'adminforth';
import type {
  AdminForthResourceFrontend,
  AdminUser,
  IAdminForth,
  IAdminForthHttpResponse,
  IRegisteredApiSchema,
} from 'adminforth';

const METHODS_WITHOUT_REQUEST_BODY = new Set(['GET', 'HEAD']);
// Milliseconds cost tokens on every datetime value and are never needed to answer the user.
const ISO_MILLISECONDS_RE = /\.\d+(?=Z$)/;
const TOOL_TIMEOUT = Symbol('TOOL_TIMEOUT');
// _label repeats field values of the row, _clickUrl is a frontend navigation helper.
const ROW_HELPER_FIELDS = new Set(['_label', '_clickUrl']);
// destructiveHint is only a hint: whether a client asks for approval depends on its permission mode,
// so dangerous tools also require a confirmation in chat.
const DANGEROUS_TOOL_NOTE = 'This tool changes data. If you have not loaded the mutate_data skill yet, load it with fetch_skill first. Before calling, show the user exactly what will change and wait for their explicit confirmation in chat, even when the client does not ask for approval.';

// Column properties needed to read, filter and aggregate records; writes need the detailed response.
// Non-sortable columns also get sortable: false.
const GET_RESOURCE_ESSENTIAL_COLUMN_FIELDS = ['name', 'label', 'type', 'enum', 'foreignResource'];
// The rest of foreignResource configures the foreign record picker in the UI.
const GET_RESOURCE_ESSENTIAL_FOREIGN_RESOURCE_FIELDS = ['resourceId', 'polymorphicOn', 'polymorphicResources'];

type GetResourceOutput = { resource: AdminForthResourceFrontend };
type GetResourceDataOutput = { data: Array<Record<string, unknown>>; total?: number; recordIds?: unknown[] };

type ToolOverride = {
  // Appended to the endpoint description, so clients learn how the tool behaves before loading the schema.
  descriptionNote: string;
  // Arguments handled by the MCP plugin itself: they are added to the tool input schema and never reach the handler.
  arguments?: Record<string, Record<string, unknown>>;
  // Arguments the client may omit: they are dropped from the required list and filled with these values.
  defaultArguments?: Record<string, unknown>;
  prepareArguments?: (handlerArguments: Record<string, unknown>) => Record<string, unknown>;
  // Receives every client argument with defaults applied, and the arguments exactly as the client passed them.
  project?: (output: unknown, args: Record<string, unknown>, clientArgs: Record<string, unknown>) => unknown;
};

function createToolOverrides(pageSize: McpPageSize, adminforth: IAdminForth): Record<string, ToolOverride> {
  return {
    get_resource: {
      descriptionNote: 'By default only the columns needed to read, filter and aggregate records are returned. Pass detailed: true right away when you are going to create or update records or run actions; the detailed response already includes the default one.',
      arguments: {
        detailed: {
          type: 'boolean',
          description: 'Set to true before create_record, update_record, start_custom_action or start_custom_bulk_action: it returns every column property (required fields, which fields can be set on create and edit, validation rules, length and value limits, showIf conditions, editing notes) and the custom and bulk actions of the resource. By default only the column properties needed to read, filter and aggregate records are returned.',
        },
      },
      project: (output, { detailed }) => (
        detailed
          ? withoutFrontendOnlyFields(output as GetResourceOutput)
          : essentialResource(output as GetResourceOutput)
      ),
    },
    get_resource_data: {
      descriptionNote: `Returns ${pageSize.default} rows unless limit is passed, and at most ${pageSize.max} rows per call; the response note tells when more rows exist. Row properties with null values, empty arrays or empty objects are omitted, so a column missing from a row is empty. Datetimes are UTC in ISO 8601 without milliseconds. When you pass columns, include the primary key column to get record ids (composite keys come as _primaryKeyValue in list rows).`,
      defaultArguments: { source: 'list', limit: pageSize.default, offset: 0 },
      prepareArguments: (handlerArguments) => ({
        ...handlerArguments,
        limit: Math.min(handlerArguments.limit as number, pageSize.max),
      }),
      project: (output, args, clientArgs) => compactResourceData(
        output as GetResourceDataOutput,
        args,
        clientArgs,
        pageSize,
        datetimeColumnNames(adminforth, args.resourceId as string),
      ),
    },
  };
}

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
  const apiPrefix = adminApiPrefix(adminforth.config.baseUrl);
  const strippedPath = path.startsWith(apiPrefix) ? path.slice(apiPrefix.length) : path;
  return strippedPath.startsWith('/') ? strippedPath : `/${strippedPath}`;
}

// Drops frontend-only parts of the get_resource response that are useless for MCP clients and only waste their context.
// Copies instead of deleting: the response shares nested objects with the AdminForth config.
function withoutFrontendOnlyFields({ resource }: GetResourceOutput): GetResourceOutput {
  const { pageInjections, ...options } = resource.options;
  return {
    resource: {
      ...resource,
      columns: resource.columns.map(({ filterOptions, components, ...column }) => column),
      options: {
        ...options,
        actions: options.actions?.map(({ customComponent, ...action }) => action),
      },
    },
  };
}

function pickFields<T extends object>(source: T, fields: string[]): Partial<T> {
  return Object.fromEntries(
    fields.filter((field) => field in source).map((field) => [field, source[field as keyof T]]),
  ) as Partial<T>;
}

// Virtual columns are skipped: they cannot be filtered, sorted, aggregated or selected in get_resource_data.
function essentialResource({ resource }: GetResourceOutput) {
  const primaryKeyNames = resource.columns.filter((column) => column.primaryKey).map((column) => column.name);
  return {
    resource: {
      resourceId: resource.resourceId,
      label: resource.label,
      primaryKey: primaryKeyNames.length === 1 ? primaryKeyNames[0] : primaryKeyNames,
      columns: resource.columns
        .filter((column) => !column.backendOnly && !column.virtual)
        .map((column) => ({
          ...pickFields(column, GET_RESOURCE_ESSENTIAL_COLUMN_FIELDS),
          // most columns are sortable, so only the exceptions are listed
          ...(column.sortable === false && { sortable: false }),
          ...(column.foreignResource && {
            foreignResource: pickFields(column.foreignResource, GET_RESOURCE_ESSENTIAL_FOREIGN_RESOURCE_FIELDS),
          }),
        })),
    },
  };
}

function datetimeColumnNames(adminforth: IAdminForth, resourceId: string): Set<string> {
  const resource = adminforth.config.resources.find((candidate) => candidate.resourceId === resourceId)!;
  return new Set(
    resource.dataSourceColumns
      .filter((column) => column.type === AdminForthDataTypes.DATETIME)
      .map((column) => column.name),
  );
}

// null, [] and {} carry no data, so the column is left out of the row; clients read a missing column as empty.
function isEmptyValue(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

function compactRow(row: Record<string, unknown>, datetimeColumns: Set<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([name, value]) => !isEmptyValue(value) && !ROW_HELPER_FIELDS.has(name))
      .map(([name, value]) => [
        name,
        datetimeColumns.has(name) ? (value as string).replace(ISO_MILLISECONDS_RE, '') : value,
      ]),
  );
}

// recordIds repeat the primary keys that list rows already carry, the frontend only needs them for paging in the show view.
// The note stops clients from silently paging through every record: they should ask the user first. It is added only
// for page requests (no limit, so the default page, or a full page); a client that asked for exactly N records,
// such as the single oldest one, gets what it asked for without the note.
function compactResourceData(
  { recordIds, data, ...rest }: GetResourceDataOutput,
  args: Record<string, unknown>,
  clientArgs: Record<string, unknown>,
  pageSize: McpPageSize,
  datetimeColumns: Set<string>,
) {
  const offset = args.offset as number;
  const nextOffset = offset + data.length;
  const isPageRequest = clientArgs.limit === undefined || (clientArgs.limit as number) >= pageSize.max;
  const notes = [
    (args.limit as number) > pageSize.max && `limit is capped at ${pageSize.max} rows per call.`,
    isPageRequest && rest.total !== undefined && rest.total > nextOffset
      && `Loaded ${data.length} of ${rest.total} records (offset ${offset}). Ask the user before loading more; the next page starts at offset ${nextOffset}.`,
  ].filter(Boolean);
  return {
    ...rest,
    data: data.map((row) => compactRow(row, datetimeColumns)),
    ...(notes.length > 0 && { note: notes.join(' ') }),
  };
}

function overrideInputSchema(
  inputSchema: Record<string, unknown>,
  override: ToolOverride | undefined,
): Record<string, unknown> {
  if (!override) return inputSchema;
  const defaultedNames = new Set(Object.keys(override.defaultArguments ?? {}));
  return {
    ...inputSchema,
    ...(Array.isArray(inputSchema.required) && {
      required: inputSchema.required.filter((name: string) => !defaultedNames.has(name)),
    }),
    properties: { ...(inputSchema.properties as Record<string, unknown>), ...override.arguments },
  };
}

function withoutPluginArguments(
  args: Record<string, unknown>,
  override: ToolOverride | undefined,
): Record<string, unknown> {
  const pluginArgumentNames = new Set(Object.keys(override?.arguments ?? {}));
  return Object.fromEntries(Object.entries(args).filter(([name]) => !pluginArgumentNames.has(name)));
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
    pageSize: McpPageSize,
    private readonly toolTimeoutMs: number,
  ) {
    this.toolOverrides = createToolOverrides(pageSize, adminforth);
  }

  private readonly toolOverrides: Record<string, ToolOverride>;

  private schemas(): Map<string, RegisteredToolSchema> {
    const schemas = new Map<string, RegisteredToolSchema>();

    for (const schema of this.adminforth.openApi.registeredSchemas) {
      if (!isRegisteredToolSchema(schema)) continue;
      const path = stripAdminApiPrefix(schema.path, this.adminforth);
      if (path === MCP_PATH || path.startsWith(`${MCP_PATH}/`)) continue;
      schemas.set(endpointPathToToolName(path), schema);
    }

    return schemas;
  }

  private description(name: string, schema: RegisteredToolSchema): { description?: string } {
    const description = [
      schema.description,
      this.toolOverrides[name]?.descriptionNote,
      schema.agent?.isDangerous && DANGEROUS_TOOL_NOTE,
    ].filter(Boolean).join(' ');
    return description ? { description } : {};
  }

  // The handler gets an abort signal that fires on timeout or when the MCP request is aborted;
  // a handler that ignores it keeps running in the background, but the client is not kept waiting.
  private async withTimeout<T>(
    requestSignal: AbortSignal,
    run: (abortSignal: AbortSignal) => T | Promise<T>,
  ): Promise<T | typeof TOOL_TIMEOUT> {
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    requestSignal.addEventListener('abort', abortHandler, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TOOL_TIMEOUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TOOL_TIMEOUT);
      }, this.toolTimeoutMs);
    });
    try {
      return await Promise.race([run(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
      requestSignal.removeEventListener('abort', abortHandler);
    }
  }

  list(): McpToolDefinition[] {
    return Array.from(this.schemas().entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, schema]) => ({
        name,
        ...this.description(name, schema),
        inputSchema: compactInputSchema(overrideInputSchema(schema.request_schema ?? {
          type: 'object',
          properties: {},
          additionalProperties: true,
        }, this.toolOverrides[name])),
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

    const override = this.toolOverrides[params.name];
    const args = { ...override?.defaultArguments, ...params.arguments };
    const pluginFreeArguments = withoutPluginArguments(args, override);
    const handlerArguments = override?.prepareArguments?.(pluginFreeArguments) ?? pluginFreeArguments;
    const method = schema.method.toUpperCase();
    const hasBody = !METHODS_WITHOUT_REQUEST_BODY.has(method);
    const body = hasBody ? handlerArguments : {};
    const query = hasBody ? {} : handlerArguments;
    const requestValidation = this.adminforth.openApi.validateRequestSchema(schema, body);
    if (!requestValidation.valid) {
      return {
        output: { error: 'REQUEST_VALIDATION_FAILED', details: requestValidation.errors },
        isError: true,
      };
    }

    const response = createDirectResponse();
    const language = String(params.headers['accept-language'] ?? 'en');
    const output = await this.withTimeout(params.abortSignal, (abortSignal) => schema.handler({
      body,
      query,
      headers: params.headers,
      cookies: [],
      adminUser: params.adminUser,
      response,
      requestUrl: params.requestUrl,
      abortSignal,
      _raw_express_req: undefined as never,
      _raw_express_res: undefined as never,
      tr: (message, category, translationParams, pluralizationNumber) => this.adminforth.tr(
        message,
        category,
        language,
        translationParams,
        pluralizationNumber,
      ),
    }));

    if (output === TOOL_TIMEOUT) {
      return {
        output: {
          error: `Tool timed out after ${this.toolTimeoutMs / 1000} seconds. A change it started may still complete: check the result before calling it again.`,
        },
        isError: true,
      };
    }

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

    const isError = response.status >= 400 || Boolean(
      output && typeof output === 'object' && 'error' in output,
    );
    return {
      output: isError || !override?.project ? output : override.project(output, args, params.arguments ?? {}),
      isError,
    };
  }
}
