import {
  AdminForthPlugin,
  type AdminForthResource,
  type AdminUser,
  type HttpExtra,
  type IAdminForth,
  type IAdminForthEndpointHandlerInput,
  type IHttpServer,
  logger,
} from 'adminforth';
import { AdminForthApiTools } from './apiTools.js';
import { formatMcpExecutedBy, readMcpClient, UNKNOWN_CLIENT } from './clientInfo.js';
import {
  createMcpServerPresentation,
  handleMcpProtocol,
  type McpServerPresentation,
} from './mcpProtocol.js';
import { McpAuthSecretStore, SECRET_PREFIX } from './authSecretStore.js';
import { CONSENT_PAGE_PATH, McpOAuth } from './oauth.js';
import { setupOAuthEndpoints } from './oauthEndpoints.js';
import { FETCH_SKILL_TOOL_NAME, McpSkills } from './skills.js';
import type { PluginOptions } from './types.js';
import { adminApiPrefix, createMcpUrls, MCP_PATH, type McpUrls } from './urls.js';

const BEARER_TOKEN_RE = /^Bearer (\S+)$/i;
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_CALLS_PER_REQUEST = 10;

const RESOURCES_LIST_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['resources'],
  properties: {
    resources: {
      type: 'array',
      description: 'Every resource of the admin panel. Access is checked when a resource is used, so the user may still be forbidden to list, show, create, edit or delete records of a listed resource.',
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
    error: { code: -32001, message: 'Authentication required: the MCP auth secret or OAuth access token is missing, invalid or revoked.' },
  };
}

export default class AdminForthMcpPlugin extends AdminForthPlugin {
  options: PluginOptions;
  pluginsScope: 'global' = 'global';
  private authSecretStore!: McpAuthSecretStore;
  /** Null when OAuth sign-in is not configured; then only auth secrets authenticate. */
  private oauth!: McpOAuth | null;
  private apiTools!: AdminForthApiTools;
  private skills!: McpSkills;
  private serverPresentation!: McpServerPresentation;
  /** Null without adminPanelOrigin; then the settings page shows the MCP URL of the address it was opened at. */
  private urls!: McpUrls | null;

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

    this.urls = this.options.adminPanelOrigin
      ? createMcpUrls(this.options.adminPanelOrigin, adminforth.config.baseUrl)
      : null;
    this.authSecretStore = new McpAuthSecretStore(adminforth, this.options.authSecretResource);
    this.oauth = this.options.authSecretResource.oauthClientIdField ? this.createOAuth(adminforth) : null;
    const pageSize = {
      default: this.options.pageSize?.default ?? DEFAULT_PAGE_SIZE,
      max: this.options.pageSize?.max ?? MAX_PAGE_SIZE,
    };
    this.apiTools = new AdminForthApiTools(
      adminforth,
      new Set([this.options.authSecretResource.resourceId]),
      pageSize,
      this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    );
    this.skills = new McpSkills(this.customFolderPath, {
      'pageSize.default': pageSize.default,
      'pageSize.max': pageSize.max,
      toolCallsPerRequest: this.options.toolCallsPerRequest ?? DEFAULT_TOOL_CALLS_PER_REQUEST,
    });
    this.serverPresentation = createMcpServerPresentation(
      adminforth.config.customization.brandName,
      this.urls?.adminPanelUrl,
      this.skills.serverInstructions(),
    );
  }

  private createOAuth(adminforth: IAdminForth): McpOAuth {
    if (!this.urls) {
      throw new Error(
        'AdminForthMcpPlugin: adminPanelOrigin is required with authSecretResource.oauthClientIdField, '
        + 'OAuth issuer and MCP resource URLs are built from it',
      );
    }

    adminforth.config.customization.customPages.push({
      path: CONSENT_PAGE_PATH,
      component: {
        file: this.componentPath('McpAuthorize.vue'),
        meta: { sidebarAndHeader: 'none' },
      },
    });

    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && this.options.devOAuthClients?.length) {
      logger.warn('AdminForthMcpPlugin: devOAuthClients are ignored because NODE_ENV is "production"');
    }
    return new McpOAuth(
      adminforth,
      this.authSecretStore,
      this.urls,
      isProduction ? [] : this.options.devOAuthClients,
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
      ...(fields.oauthClientIdField ? [fields.oauthClientIdField] : []),
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
      description: 'Lists the resourceId and label of every resource (data table), including resources the user cannot access: access is checked when a resource is used. Call this first to discover valid resourceId values before using get_resource, get_resource_data, aggregate, create_record, update_record, delete_record or other resource tools.',
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
      handler: async ({ adminUser }) => ({
        authSecrets: await this.authSecretStore.list(adminUser),
        oauthEnabled: Boolean(this.oauth),
        mcpUrl: this.urls?.mcpUrl ?? null,
      }),
    });

    server.endpoint({
      method: 'POST',
      path: `${MCP_PATH}/auth-secrets`,
      handler: async (input) => {
        const name = String(input.body.name ?? '').trim();
        if (!name) {
          input.response.setStatus(400);
          return { error: 'Auth secret name is required' };
        }
        return this.authSecretStore.create(name, input.adminUser, requestExtra(input));
      },
    });

    server.endpoint({
      method: 'DELETE',
      path: `${MCP_PATH}/auth-secrets`,
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

    if (this.oauth) {
      setupOAuthEndpoints(server, this.oauth, adminApiPrefix(this.adminforth.config.baseUrl));
    }

    server.endpoint({
      method: 'POST',
      path: MCP_PATH,
      noAuth: true,
      handler: async (input) => this.handleMcpRequest(input),
    });

    // Streamable HTTP clients open a GET stream for server-initiated messages; 405 tells them this server has none.
    server.endpoint({
      method: 'GET',
      path: MCP_PATH,
      noAuth: true,
      handler: async ({ response }) => {
        response.setHeader('Allow', 'POST');
        response.setStatus(405, 'Method Not Allowed');
      },
    });
  }

  /** Accepts personal auth secrets and OAuth access tokens; access tokens are JWTs, secrets have their prefix. */
  private async authenticate(token: string) {
    if (token.startsWith(SECRET_PREFIX)) return this.authSecretStore.authenticate(token);
    if (!this.oauth) return null;
    const accessToken = await this.oauth.verifyAccessToken(token);
    return accessToken && this.authSecretStore.authenticateOAuthGrant(accessToken.grantId, accessToken.pk);
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

    const token = String(input.headers.authorization ?? '').match(BEARER_TOKEN_RE)?.[1];
    const authenticated = token ? await this.authenticate(token) : null;
    if (!authenticated) {
      // resource_metadata leads OAuth clients to the authorization server; invalid_token makes them refresh.
      input.response.setHeader('WWW-Authenticate', this.oauth
        ? `Bearer ${token ? 'error="invalid_token", ' : ''}resource_metadata="${this.oauth.resourceMetadataUrl}"`
        : 'Bearer');
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
    const protocolResponse = await handleMcpProtocol({
      ...this.serverPresentation,
      body: input.body,
      headers: toolHeaders,
      listTools: () => [...this.apiTools.list(), this.skills.toolDefinition()],
      callTool: async (name, arguments_) => {
        if (name === FETCH_SKILL_TOOL_NAME) return this.skills.call(arguments_);
        return this.apiTools.call({
          name,
          arguments: arguments_,
          adminUser,
          headers: toolHeaders,
          requestUrl: input.requestUrl,
          abortSignal: input.abortSignal,
        });
      },
    });

    input.response.setStatus(protocolResponse.status);
    if (!protocolResponse.body) {
      input._raw_express_res.status(protocolResponse.status).end();
      return null;
    }
    return protocolResponse.body;
  }
}

export type { McpAuthSecretResourceOptions, McpOAuthClient, PluginOptions } from './types.js';
export { canonicalAgentName, formatMcpExecutedBy, readMcpClient } from './clientInfo.js';
export { handleMcpProtocol } from './mcpProtocol.js';
