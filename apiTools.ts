import type { Tool } from '@modelcontextprotocol/server';
import type { McpAdminPanelConfirmation, McpConnection } from './adminPanelConfirmation.js';
import { compactInputSchema } from './compactInputSchema.js';
import { formatDatetime } from './datetime.js';
import type { McpResourceVisibility } from './resourceVisibility.js';
import { isErrorOutput } from './toolOutput.js';
import type { McpPageSize } from './types.js';
import { adminApiPrefix } from './urls.js';
import { AdminForthDataTypes } from 'adminforth';
import type {
  AdminForthResourceFrontend,
  AdminUser,
  IAdminForth,
  IAdminForthHttpResponse,
  IAdminForthPlugin,
  IRegisteredApiSchema,
} from 'adminforth';

const METHODS_WITHOUT_REQUEST_BODY = new Set(['GET', 'HEAD']);
const NON_TOOL_NAME_CHARACTER_RE = /[^a-zA-Z0-9_]+/g;
const EDGE_UNDERSCORE_RE = /^_+|_+$/g;
// Plugins register their endpoints under /plugin/<pluginInstanceId>/, some also under fixed paths like /plugin/twofa/.
const PLUGIN_INSTANCE_PATH_RE = /^\/plugin\/([^/]+)\//;
const PLUGIN_INSTANCE_ID_ARGUMENT = 'pluginInstanceId';
const ANY_ARGUMENTS_SCHEMA = { type: 'object', properties: {}, additionalProperties: true };
const TOOL_TIMEOUT = Symbol('TOOL_TIMEOUT');
// _label repeats field values of the row, _clickUrl is a frontend navigation helper.
const ROW_HELPER_FIELDS = new Set(['_label', '_clickUrl']);
// destructiveHint is only a hint: whether a client asks for approval depends on its permission mode,
// so dangerous tools also require a confirmation in chat.
const DANGEROUS_TOOL_NOTE = 'This tool changes data. If you have not loaded the mutate-data skill yet, load it with fetch_skill first. Before calling, show the user exactly what will change and wait for their explicit confirmation in chat, even when the client does not ask for approval.';

// Column properties needed to read, filter and aggregate records; writes need the detailed response.
// Non-sortable columns also get sortable: false.
const GET_RESOURCE_ESSENTIAL_COLUMN_FIELDS = ['name', 'label', 'type', 'enum', 'foreignResource'];
// The rest of foreignResource configures the foreign record picker in the UI.
const GET_RESOURCE_ESSENTIAL_FOREIGN_RESOURCE_FIELDS = ['resourceId', 'polymorphicOn', 'polymorphicResources'];

type GetResourceOutput = { resource: AdminForthResourceFrontend };
type GetResourceDataOutput = { data: Array<Record<string, unknown>>; total?: number; recordIds?: unknown[] };
// A plugin instance as get_resource lists it: the plugin_<pluginClass>_* tools run its endpoints when called with its pluginInstanceId.
type AgentPluginInstance = Record<string, string> & { pluginInstanceId: string; pluginClass: string; resourceId: string };

type ToolOverride = {
  // Appended to the endpoint description, so clients learn how the tool behaves before loading the schema.
  descriptionNote: string;
  // Arguments handled by the MCP plugin itself: they are added to the tool input schema and never reach the handler.
  arguments?: Record<string, Record<string, unknown>>;
  // Arguments the client may omit: they are dropped from the required list and filled with these values.
  defaultArguments?: Record<string, unknown>;
  prepareArguments?: (handlerArguments: Record<string, unknown>) => Record<string, unknown>;
  // Receives every client argument with defaults applied, the arguments exactly as the client passed them,
  // and the catalog the tool was called from.
  project?: (
    output: unknown,
    args: Record<string, unknown>,
    clientArgs: Record<string, unknown>,
    timeZone: string | undefined,
    catalog: ToolCatalog,
  ) => unknown;
};

function createToolOverrides(pageSize: McpPageSize, adminforth: IAdminForth): Record<string, ToolOverride> {
  return {
    get_resource: {
      descriptionNote: 'By default only the columns needed to read, filter and aggregate records are returned. Pass detailed: true right away when you are going to create or update records or run actions; the detailed response already includes the default one. plugins lists the plugin instances of the resource: pass the pluginInstanceId of one to the plugin_<pluginClass>_* tools; instances of one plugin differ in the option shown next to them.',
      arguments: {
        detailed: {
          type: 'boolean',
          description: 'Set to true before create_record, update_record, start_custom_action or start_custom_bulk_action: it returns every column property (required fields, which fields can be set on create and edit, validation rules, length and value limits, showIf conditions, editing notes) and the custom and bulk actions of the resource. By default only the column properties needed to read, filter and aggregate records are returned.',
        },
      },
      project: (output, { detailed }, _clientArgs, _timeZone, catalog) => {
        const { resource } = detailed
          ? withoutFrontendOnlyFields(output as GetResourceOutput)
          : essentialResource(output as GetResourceOutput);
        const plugins = catalog.resourcePlugins.get(resource.resourceId);
        return { resource: plugins ? { ...resource, plugins } : resource };
      },
    },
    get_resource_data: {
      descriptionNote: `Returns ${pageSize.default} rows unless limit is passed, and at most ${pageSize.max} rows per call; the response note tells when more rows exist. Row properties with null values, empty arrays or empty objects are omitted, so a column missing from a row is empty. Datetimes are ISO 8601 without milliseconds and end with their UTC offset (Z is UTC). When you pass columns, include the primary key column to get record ids (composite keys come as _primaryKeyValue in list rows).`,
      defaultArguments: { source: 'list', limit: pageSize.default, offset: 0 },
      prepareArguments: (handlerArguments) => ({
        ...handlerArguments,
        limit: Math.min(handlerArguments.limit as number, pageSize.max),
      }),
      project: (output, args, clientArgs, timeZone) => compactResourceData(
        output as GetResourceDataOutput,
        args,
        clientArgs,
        pageSize,
        datetimeColumnNames(adminforth, args.resourceId as string),
        timeZone,
      ),
    },
  };
}

type RegisteredToolSchema = IRegisteredApiSchema & {
  handler: NonNullable<IRegisteredApiSchema['handler']>;
};

type PluginInstanceEndpoint = { plugin: IAdminForthPlugin; schema: RegisteredToolSchema };

interface ToolCatalog {
  schemas: Map<string, RegisteredToolSchema>;
  // Every instance of a plugin registers the same endpoints under /plugin/<pluginInstanceId>/, so each endpoint
  // is one tool for all instances: tool name → pluginInstanceId → the endpoint of that instance.
  pluginTools: Map<string, Map<string, PluginInstanceEndpoint>>;
  tools: Tool[];
  resourcePlugins: Map<string, AgentPluginInstance[]>;
}

// The endpoint a tool call runs and the resources it works with, which must be visible to the user.
type CallTarget = { schema: RegisteredToolSchema; clientArguments: Record<string, unknown>; resourceIds: unknown[] };

function isRegisteredToolSchema(schema: IRegisteredApiSchema): schema is RegisteredToolSchema {
  return typeof schema.handler === 'function' && !schema.agent?.hiddenFromAgents;
}

function endpointPathToToolName(path: string): string {
  return path.replace(NON_TOOL_NAME_CHARACTER_RE, '_').replace(EDGE_UNDERSCORE_RE, '');
}

// instanceUniqueRepresentation is usually the value of one plugin option, like pathColumnName of the upload plugin,
// and the option name tells agents what the instance works with. Only top-level options are compared, so adapters
// are never read. A value no single option holds still tells instances of one plugin apart; a lone instance needs
// none, its representation is a constant like 'single'.
function instanceParams(plugin: IAdminForthPlugin, hasSameClassPlugins: boolean): Record<string, string> {
  const representation = plugin.instanceUniqueRepresentation(plugin.pluginOptions);
  const keys = Object.keys(plugin.pluginOptions).filter((key) => plugin.pluginOptions[key] === representation);
  if (keys.length === 1) return { [keys[0]]: representation };
  return hasSameClassPlugins ? { instance: representation } : {};
}

// The identifying fields go last, so a plugin option of the same name cannot replace them.
function agentPluginInstance(plugin: IAdminForthPlugin, resourcePlugins: IAdminForthPlugin[]): AgentPluginInstance {
  const hasSameClassPlugins = resourcePlugins.some((other) => other !== plugin && other.className === plugin.className);
  return {
    ...instanceParams(plugin, hasSameClassPlugins),
    pluginInstanceId: plugin.pluginInstanceId,
    pluginClass: plugin.className,
    resourceId: plugin.resourceConfig.resourceId,
  };
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

function compactRow(
  row: Record<string, unknown>,
  datetimeColumns: Set<string>,
  timeZone: string | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([name, value]) => !isEmptyValue(value) && !ROW_HELPER_FIELDS.has(name))
      .map(([name, value]) => [
        name,
        datetimeColumns.has(name) ? formatDatetime(value as string, timeZone) : value,
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
  timeZone: string | undefined,
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
    data: data.map((row) => compactRow(row, datetimeColumns, timeZone)),
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

// Endpoint schemas are strict and know nothing about plugin instances, so pluginInstanceId never reaches them.
function withPluginInstanceIdArgument(inputSchema: Record<string, unknown>, pluginClass: string): Record<string, unknown> {
  return {
    ...inputSchema,
    required: [PLUGIN_INSTANCE_ID_ARGUMENT, ...(Array.isArray(inputSchema.required) ? inputSchema.required : [])],
    properties: {
      [PLUGIN_INSTANCE_ID_ARGUMENT]: {
        type: 'string',
        description: `pluginInstanceId of the ${pluginClass} instance from plugins of get_resource.`,
      },
      ...(inputSchema.properties as Record<string, unknown>),
    },
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
    private readonly resourceVisibility: McpResourceVisibility,
    pageSize: McpPageSize,
    private readonly toolTimeoutMs: number,
    private readonly adminPanelConfirmation: McpAdminPanelConfirmation | undefined,
  ) {
    this.toolOverrides = createToolOverrides(pageSize, adminforth);
  }

  private readonly toolOverrides: Record<string, ToolOverride>;
  private fullCatalog?: ToolCatalog;
  private readOnlyCatalog?: ToolCatalog;

  private catalog(readOnly: boolean): ToolCatalog {
    return readOnly
      ? (this.readOnlyCatalog ??= this.buildCatalog(true))
      : (this.fullCatalog ??= this.buildCatalog(false));
  }

  private buildCatalog(readOnly: boolean): ToolCatalog {
    const apiPrefix = adminApiPrefix(this.adminforth.config.baseUrl);
    const pluginsById = new Map(this.adminforth.activatedPlugins.map((plugin) => [plugin.pluginInstanceId, plugin]));
    const schemas = new Map<string, RegisteredToolSchema>();
    const pluginTools = new Map<string, Map<string, PluginInstanceEndpoint>>();
    for (const schema of this.adminforth.openApi.registeredSchemas) {
      if (!isRegisteredToolSchema(schema) || (readOnly && !schema.agent?.onlyReadsData)) continue;
      const path = schema.path.slice(apiPrefix.length);
      const pluginPath = path.match(PLUGIN_INSTANCE_PATH_RE);
      const plugin = pluginPath && pluginsById.get(pluginPath[1]);
      if (!plugin) {
        schemas.set(endpointPathToToolName(path), schema);
        continue;
      }
      const name = endpointPathToToolName(`plugin_${plugin.className}_${path.slice(pluginPath[0].length)}`);
      pluginTools.set(name, (pluginTools.get(name) ?? new Map()).set(plugin.pluginInstanceId, { plugin, schema }));
    }
    const tools = [
      ...Array.from(schemas, ([name, schema]) => this.tool(name, schema)),
      // instances of one plugin share the endpoint code, so the first one describes the tool
      ...Array.from(pluginTools, ([name, instances]) => {
        const [{ plugin, schema }] = instances.values();
        return this.tool(name, schema, plugin.className);
      }),
    ].sort((left, right) => left.name.localeCompare(right.name));
    return { schemas, pluginTools, tools, resourcePlugins: this.resourcePlugins(pluginTools) };
  }

  private tool(name: string, schema: RegisteredToolSchema, pluginClass?: string): Tool {
    const inputSchema = overrideInputSchema(schema.request_schema ?? ANY_ARGUMENTS_SCHEMA, this.toolOverrides[name]);
    return {
      name,
      ...this.description(name, schema, pluginClass),
      inputSchema: compactInputSchema(
        pluginClass ? withPluginInstanceIdArgument(inputSchema, pluginClass) : inputSchema,
      ) as Tool['inputSchema'],
      ...(schema.agent?.onlyReadsData && {
        annotations: { readOnlyHint: true },
      }),
      ...(schema.agent?.requiresHumanApproval && {
        annotations: { destructiveHint: true },
      }),
    };
  }

  // Instances that own tools of the catalog, by resource. Global plugins have no resourceConfig, so they are not listed.
  private resourcePlugins(pluginTools: ToolCatalog['pluginTools']): Map<string, AgentPluginInstance[]> {
    const toolPluginInstanceIds = new Set(
      Array.from(pluginTools.values()).flatMap((instances) => Array.from(instances.keys())),
    );
    const pluginsByResource = new Map<string, IAdminForthPlugin[]>();
    for (const plugin of this.adminforth.activatedPlugins) {
      if (!plugin.resourceConfig || !toolPluginInstanceIds.has(plugin.pluginInstanceId)) continue;
      const { resourceId } = plugin.resourceConfig;
      pluginsByResource.set(resourceId, [...(pluginsByResource.get(resourceId) ?? []), plugin]);
    }
    return new Map(Array.from(pluginsByResource, ([resourceId, plugins]) => [
      resourceId,
      plugins.map((plugin) => agentPluginInstance(plugin, plugins)),
    ]));
  }

  private description(name: string, schema: RegisteredToolSchema, pluginClass?: string): { description?: string } {
    const description = [
      schema.description,
      this.toolOverrides[name]?.descriptionNote,
      pluginClass && `Runs for one ${pluginClass} instance: pass its pluginInstanceId from plugins of get_resource.`,
      schema.agent?.requiresHumanApproval && DANGEROUS_TOOL_NOTE,
    ].filter(Boolean).join(' ');
    return description ? { description } : {};
  }

  // A plugin tool runs the endpoint of the instance passed in pluginInstanceId and works with the resource of that
  // instance; any tool may also name a resource in resourceId.
  private callTarget(catalog: ToolCatalog, name: string, args: Record<string, unknown>): CallTarget | { error: string } {
    const pluginTool = catalog.pluginTools.get(name);
    if (pluginTool) {
      const { [PLUGIN_INSTANCE_ID_ARGUMENT]: pluginInstanceId, ...clientArguments } = args;
      const instance = pluginTool.get(pluginInstanceId as string);
      if (!instance) return { error: `Unknown pluginInstanceId: ${pluginInstanceId}` };
      // global plugins have no resourceConfig
      const resourceIds = [instance.plugin.resourceConfig?.resourceId, clientArguments.resourceId];
      return { schema: instance.schema, clientArguments, resourceIds };
    }
    const schema = catalog.schemas.get(name);
    if (!schema) return { error: `Unknown tool: ${name}` };
    return { schema, clientArguments: args, resourceIds: [args.resourceId] };
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

  list(readOnly: boolean): Tool[] {
    return this.catalog(readOnly).tools;
  }

  async call(params: {
    name: string;
    arguments?: Record<string, unknown>;
    adminUser: AdminUser;
    headers: Record<string, any>;
    requestUrl: string;
    abortSignal: AbortSignal;
    readOnly: boolean;
    connection: McpConnection;
    timeZone?: string;
  }): Promise<{ output: unknown; isError: boolean }> {
    const catalog = this.catalog(params.readOnly);
    const target = this.callTarget(catalog, params.name, params.arguments ?? {});
    if ('error' in target) {
      return { output: { error: target.error }, isError: true };
    }
    const { schema, clientArguments } = target;
    for (const resourceId of target.resourceIds) {
      if (typeof resourceId === 'string' && !await this.resourceVisibility.isVisible(params.adminUser, resourceId)) {
        return { output: { error: `Resource ${resourceId} not found` }, isError: true };
      }
    }

    const override = this.toolOverrides[params.name];
    const args = { ...override?.defaultArguments, ...clientArguments };
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
    const request = {
      body,
      query: query as Record<string, string>,
      headers: params.headers,
      cookies: [],
      requestUrl: params.requestUrl,
      response,
    };
    const output = await this.withTimeout(params.abortSignal, (abortSignal) => {
      const execute = async () => schema.handler({
        ...request,
        adminUser: params.adminUser,
        abortSignal,
        _raw_express_req: undefined as never,
        _raw_express_res: undefined as never,
        tr: (message, category, translationParams, pluralizationNumber) => this.adminforth.tr(
          message,
          category,
          params.headers['accept-language'],
          translationParams,
          pluralizationNumber,
        ),
      });
      return this.adminPanelConfirmation ? this.adminPanelConfirmation.runUnverified(request, execute) : execute();
    });

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

    const confirmation = this.adminPanelConfirmation?.offer(
      output,
      params.connection,
      params.adminUser,
      schema.path.slice(adminApiPrefix(this.adminforth.config.baseUrl).length),
      handlerArguments,
    );
    if (confirmation) return confirmation;

    const responseValidation = this.adminforth.openApi.validateResponseSchema(schema, output);
    if (!responseValidation.valid) {
      return {
        output: { error: 'RESPONSE_VALIDATION_FAILED', details: responseValidation.errors },
        isError: true,
      };
    }

    const isError = isErrorOutput(response.status, output);
    return {
      output: isError || !override?.project
        ? output
        : override.project(output, args, clientArguments, params.timeZone, catalog),
      isError,
    };
  }
}
