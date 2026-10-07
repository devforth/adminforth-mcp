import {
  AdminForthPlugin,
  type AdminForthResource,
  type AdminUser,
  type HttpExtra,
  type IAdminForth,
  type IAdminForthEndpointHandlerInput,
  type IHttpServer,
} from 'adminforth';
import { AdminForthApiTools } from './apiTools.js';
import { formatMcpExecutedBy, readMcpClient, UNKNOWN_CLIENT } from './clientInfo.js';
import { createMcpServerPresentation, handleMcpProtocol } from './mcpProtocol.js';
import { McpAuthSecretStore } from './authSecretStore.js';
import type { PluginOptions } from './types.js';

const BEARER_SECRET_RE = /^Bearer (afmcp_[A-Za-z0-9_-]+)$/i;
const MCP_PATH = '/mcp';
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

const RESOURCES_LIST_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['resources'],
  properties: {
    resources: {
      type: 'array',
      description: 'Resources the authenticated admin user can access. A resource is not listed when list, show, create, edit and delete are all forbidden for the user.',
      items: {
        type: 'object',
        required: ['resourceId', 'label'],
        properties: {
          resourceId: {
            type: 'string',
            description: 'Resource identifier. Pass it as resourceId to get_resource, get_resource_data, aggregate, create_record, update_record, delete_record and other resource tools. Call get_resource with it to get the columns and allowed actions of the resource.',
          },
          label: {
            type: 'string',
            description: 'Human readable resource name, translated for the current user.',
          },
        },
      },
    },
  },
};

type AdminUserWithExecutor = AdminUser & { executedBy?: string };

function requestExtra(input: IAdminForthEndpointHandlerInput): HttpExtra {
  return {
    body: input.body,
    query: input.query,
    headers: input.headers,
    cookies: input.cookies,
    requestUrl: input.requestUrl,
    response: input.response,
  };
}

/**
 * The MCP auth secret is a long-lived credential, so it is dropped as soon as it is verified and
 * never reaches tool handlers, which may log, persist or forward the headers they are given.
 */
function withoutCredentials(headers: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())),
  );
}

function jsonRpcAuthError(id: string | number | null = null) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32001, message: 'Invalid or revoked MCP auth secret.' },
  };
}

export default class AdminForthMcpPlugin extends AdminForthPlugin {
  options: PluginOptions;
  pluginsScope: 'global' = 'global';
  private authSecretStore!: McpAuthSecretStore;
  private apiTools!: AdminForthApiTools;

  constructor(options: PluginOptions) {
    super(options, import.meta.url);
    this.options = options;
    this.shouldHaveSingleInstancePerWholeApp = () => true;
  }

  instanceUniqueRepresentation(): string {
    return 'single';
  }

  modifyGlobalConfig(adminforth: IAdminForth) {
    super.modifyGlobalConfig(adminforth);
    const authSecretResource = adminforth.config.resources.find(
      (resource) => resource.resourceId === this.options.authSecretResource.resourceId,
    );
    if (!authSecretResource) {
      throw new Error(
        `AdminForthMcpPlugin: auth secret resource "${this.options.authSecretResource.resourceId}" not found`,
      );
    }

    this.validateAuthSecretResource(authSecretResource);
    const secretHashColumn = authSecretResource.columns.find(
      (column) => column.name === this.options.authSecretResource.secretHashField,
    )!;
    secretHashColumn.backendOnly = true;
    secretHashColumn.showIn = {
      show: false,
      list: false,
      create: false,
      edit: false,
      filter: false,
    };

    const auth = adminforth.config.auth!;
    auth.userMenuSettingsPages ??= [];
    if (!auth.userMenuSettingsPages.some((page) => page.slug === 'mcp')) {
      auth.userMenuSettingsPages.push({
        icon: 'flowbite:server-outline',
        pageLabel: 'MCP Settings',
        slug: 'mcp',
        component: this.componentPath('McpSettings.vue'),
        isVisible: () => true,
      });
    }

    this.authSecretStore = new McpAuthSecretStore(adminforth, this.options.authSecretResource);
    this.apiTools = new AdminForthApiTools(
      adminforth,
      new Set([this.options.authSecretResource.resourceId]),
    );
  }

  private validateAuthSecretResource(resource: AdminForthResource): void {
    const fields = this.options.authSecretResource;
    for (const fieldName of [
      fields.idField,
      fields.nameField,
      fields.secretHashField,
      fields.userIdField,
      fields.createdAtField,
      fields.lastUsedAtField,
      fields.lastUsedByAgentField,
      fields.readOnlyField,
    ]) {
      if (!resource.columns.some((column) => column.name === fieldName)) {
        throw new Error(
          `AdminForthMcpPlugin: column "${fieldName}" not found in auth secret resource "${resource.resourceId}"`,
        );
      }
    }

    if (!resource.columns.find((column) => column.name === fields.idField)!.primaryKey) {
      throw new Error(
        `AdminForthMcpPlugin: column "${fields.idField}" must be the primary key of auth secret resource "${resource.resourceId}"`,
      );
    }
  }

  setupEndpoints(server: IHttpServer) {
    server.endpoint({
      method: 'GET',
      path: '/get_resources_list',
      description: 'Lists the resourceId and label of every resource (data table). Call this first to discover valid resourceId values before using get_resource, get_resource_data, aggregate, create_record, update_record, delete_record or other resource tools.',
      agent: {
        onlyReadsData: true,
      },
      response_schema: RESOURCES_LIST_RESPONSE_SCHEMA,
      handler: async ({ tr }) => {
        const resources = await Promise.all(this.adminforth.config.resources.map(async (resource) => ({
          resourceId: resource.resourceId,
          label: await tr(resource.label, `resource.${resource.resourceId}`),
        })));

        return { resources };
      },
    });

    server.endpoint({
      method: 'GET',
      path: `${MCP_PATH}/auth-secrets`,
      agent: {
        hiddenFromAgents: true,
      },
      handler: async ({ adminUser }) => ({
        authSecrets: await this.authSecretStore.list(adminUser),
        serverReadOnly: this.options.readOnly ?? false,
      }),
    });

    server.endpoint({
      method: 'POST',
      path: `${MCP_PATH}/auth-secrets`,
      agent: {
        hiddenFromAgents: true,
      },
      handler: async (input) => {
        const name = String(input.body.name ?? '').trim();
        if (!name) {
          input.response.setStatus(400);
          return { error: 'Auth secret name is required' };
        }
        return this.authSecretStore.create(
          name,
          this.options.readOnly || input.body.readOnly === true,
          input.adminUser,
          requestExtra(input),
        );
      },
    });

    server.endpoint({
      method: 'DELETE',
      path: `${MCP_PATH}/auth-secrets`,
      agent: {
        hiddenFromAgents: true,
      },
      handler: async (input) => {
        const result = await this.authSecretStore.revoke(
          String(input.body.id),
          input.adminUser,
          requestExtra(input),
        );
        if (result.error) input.response.setStatus(404);
        return result;
      },
    });

    server.endpoint({
      method: 'POST',
      path: MCP_PATH,
      agent: {
        hiddenFromAgents: true,
      },
      noAuth: true,
      handler: async (input) => this.handleMcpRequest(input),
    });

    // Streamable HTTP clients open a GET stream for server-initiated messages; 405 tells them this server has none.
    server.endpoint({
      method: 'GET',
      path: MCP_PATH,
      agent: {
        hiddenFromAgents: true,
      },
      noAuth: true,
      handler: async ({ response }) => {
        response.setHeader('Allow', 'POST');
        response.setStatus(405, 'Method Not Allowed');
      },
    });
  }

  private async handleMcpRequest(input: IAdminForthEndpointHandlerInput) {
    if (input.headers.origin) {
      input.response.setStatus(403);
      return {
        jsonrpc: '2.0',
        id: input.body.id ?? null,
        error: { code: -32003, message: 'Browser-originated MCP requests are not allowed.' },
      };
    }

    const bearerMatch = String(input.headers.authorization ?? '').match(BEARER_SECRET_RE);
    const authenticated = bearerMatch
      ? await this.authSecretStore.authenticate(bearerMatch[1])
      : null;
    if (!authenticated) {
      input.response.setHeader('WWW-Authenticate', 'Bearer');
      input.response.setStatus(401);
      return jsonRpcAuthError(input.body.id ?? null);
    }

    const authorization = await this.adminforth.auth.runAdminUserAuthorizeHooks(
      authenticated.adminUser,
      input.response,
      requestExtra(input),
    );
    if (!authorization.allowed) {
      input.response.setStatus(403);
      return jsonRpcAuthError(input.body.id ?? null);
    }

    const toolHeaders = withoutCredentials(input.headers);
    const reportedClient = readMcpClient(input.body, toolHeaders);
    const client = reportedClient.client === UNKNOWN_CLIENT && authenticated.client
      ? authenticated.client
      : reportedClient;
    this.authSecretStore.touch(authenticated.recordId, reportedClient);

    const adminUser: AdminUserWithExecutor = {
      ...authenticated.adminUser,
      executedBy: formatMcpExecutedBy(client, authenticated.name),
    };
    const readOnly = this.options.readOnly || authenticated.readOnly;
    const protocolResponse = await handleMcpProtocol({
      ...createMcpServerPresentation(
        this.adminforth.config.customization.brandName,
        this.options.adminPanelOrigin,
        this.adminforth.config.baseUrl,
        readOnly,
      ),
      body: input.body,
      headers: toolHeaders,
      listTools: () => this.apiTools.list(readOnly),
      callTool: (name, arguments_) => this.apiTools.call({
        name,
        arguments: arguments_,
        adminUser,
        headers: toolHeaders,
        requestUrl: input.requestUrl,
        abortSignal: input.abortSignal,
        readOnly,
      }),
    });

    input.response.setStatus(protocolResponse.status);
    if (!protocolResponse.body) {
      input._raw_express_res.status(protocolResponse.status).end();
      return null;
    }
    return protocolResponse.body;
  }
}

export type { McpAuthSecretResourceOptions, PluginOptions } from './types.js';
export { canonicalAgentName, formatMcpExecutedBy, readMcpClient } from './clientInfo.js';
export { handleMcpProtocol } from './mcpProtocol.js';
