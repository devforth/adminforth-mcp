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
import { canonicalAgentName, readMcpClient, UNKNOWN_CLIENT } from './clientInfo.js';
import { handleMcpProtocol } from './mcpProtocol.js';
import { McpTokenStore } from './tokenStore.js';
import type { PluginOptions } from './types.js';

const BEARER_TOKEN_RE = /^Bearer (afmcp_[A-Za-z0-9_-]+)$/i;
const MCP_PATH = '/mcp';

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

function jsonRpcAuthError(id: string | number | null = null) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32001, message: 'Invalid or revoked MCP token.' },
  };
}

export default class AdminForthMcpPlugin extends AdminForthPlugin {
  options: PluginOptions;
  pluginsScope: 'global' = 'global';
  private tokenStore!: McpTokenStore;
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
    const tokenResource = adminforth.config.resources.find(
      (resource) => resource.resourceId === this.options.tokenResource.resourceId,
    );
    if (!tokenResource) {
      throw new Error(
        `AdminForthMcpPlugin: token resource "${this.options.tokenResource.resourceId}" not found`,
      );
    }

    this.validateTokenResource(tokenResource);
    const tokenHashColumn = tokenResource.columns.find(
      (column) => column.name === this.options.tokenResource.tokenHashField,
    )!;
    tokenHashColumn.backendOnly = true;
    tokenHashColumn.showIn = {
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

    this.tokenStore = new McpTokenStore(adminforth, this.options.tokenResource);
    this.apiTools = new AdminForthApiTools(
      adminforth,
      new Set([this.options.tokenResource.resourceId]),
    );
  }

  private validateTokenResource(resource: AdminForthResource): void {
    const fields = this.options.tokenResource;
    for (const fieldName of [
      fields.idField,
      fields.nameField,
      fields.tokenHashField,
      fields.userIdField,
      fields.createdAtField,
      fields.lastUsedAtField,
      fields.agentField,
    ]) {
      if (!resource.columns.some((column) => column.name === fieldName)) {
        throw new Error(
          `AdminForthMcpPlugin: column "${fieldName}" not found in token resource "${resource.resourceId}"`,
        );
      }
    }

    if (!resource.columns.find((column) => column.name === fields.idField)!.primaryKey) {
      throw new Error(
        `AdminForthMcpPlugin: column "${fields.idField}" must be the primary key of token resource "${resource.resourceId}"`,
      );
    }
  }

  setupEndpoints(server: IHttpServer) {
    server.endpoint({
      method: 'GET',
      path: `${MCP_PATH}/tokens`,
      handler: async ({ adminUser }) => ({
        tokens: await this.tokenStore.list(adminUser),
      }),
    });

    server.endpoint({
      method: 'POST',
      path: `${MCP_PATH}/tokens`,
      handler: async (input) => {
        const name = String(input.body.name ?? '').trim();
        if (!name) {
          input.response.setStatus(400);
          return { error: 'Token name is required' };
        }
        return this.tokenStore.create(name, input.adminUser, requestExtra(input));
      },
    });

    server.endpoint({
      method: 'DELETE',
      path: `${MCP_PATH}/tokens`,
      handler: async (input) => {
        const result = await this.tokenStore.revoke(
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
      noAuth: true,
      handler: async (input) => this.handleMcpRequest(input),
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

    const bearerMatch = String(input.headers.authorization ?? '').match(BEARER_TOKEN_RE);
    const authenticated = bearerMatch
      ? await this.tokenStore.authenticate(bearerMatch[1])
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

    const reportedClient = readMcpClient(input.body, input.headers);
    const client = reportedClient.client === UNKNOWN_CLIENT && authenticated.client
      ? authenticated.client
      : reportedClient;
    this.tokenStore.touch(authenticated.recordId, reportedClient);

    const adminUser: AdminUserWithExecutor = {
      ...authenticated.adminUser,
      executedBy: canonicalAgentName(client.client),
    };
    const protocolResponse = await handleMcpProtocol({
      body: input.body,
      headers: input.headers,
      listTools: () => this.apiTools.list(),
      callTool: (name, arguments_) => this.apiTools.call({
        name,
        arguments: arguments_,
        adminUser,
        headers: input.headers,
        requestUrl: input.requestUrl,
        abortSignal: input.abortSignal,
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

export type { McpTokenResourceOptions, PluginOptions } from './types.js';
export { canonicalAgentName, readMcpClient } from './clientInfo.js';
export { handleMcpProtocol } from './mcpProtocol.js';
