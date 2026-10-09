import {
  AdminForthPlugin,
  type AdminForthResource,
  type AdminUser,
  type IAdminForth,
  type IAdminForthEndpointHandlerInput,
  type IHttpServer,
} from 'adminforth';
import { AdminForthApiTools } from './apiTools.js';
import { formatMcpExecutedBy, readMcpClient, UNKNOWN_CLIENT } from './clientInfo.js';
import { createMcpServerPresentation, McpProtocol } from './mcpProtocol.js';
import { McpAuthSecretStore, SECRET_PREFIX } from './authSecretStore.js';
import { registerMcpEndpoints } from './endpoints/mcp.js';
import { registerOAuthEndpoints } from './endpoints/oAuth.js';
import { registerSettingsEndpoints } from './endpoints/settings.js';
import { registerToolEndpoints } from './endpoints/tools.js';
import { AuthSecretRepository } from './repositories/authSecret.js';
import type { McpOAuth } from './oauth/authorizationServer.js';
import { setupOAuth } from './oauth/setup.js';
import { requestExtra } from './requestExtra.js';
import { FETCH_SKILL_TOOL_NAME, McpSkills } from './skills.js';
import type { PluginOptions } from './types.js';
import { adminApiPrefix, createMcpUrls, type McpUrls } from './urls.js';

const BEARER_TOKEN_RE = /^Bearer (\S+)$/i;
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_CALLS_PER_REQUEST = 10;

type AdminUserWithExecutor = AdminUser & { executedBy?: string };

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
  private oauth!: McpOAuth;
  private apiTools!: AdminForthApiTools;
  private skills!: McpSkills;
  private urls!: McpUrls;
  private readonly protocol = new McpProtocol();

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

    this.urls = createMcpUrls(this.options.adminPanelOrigin, adminforth.config.baseUrl);
    this.authSecretStore = new McpAuthSecretStore(
      adminforth,
      new AuthSecretRepository(adminforth, this.options.authSecretResource),
    );
    this.oauth = setupOAuth(
      adminforth,
      this.authSecretStore,
      this.urls,
      this.options,
      this.componentPath('McpAuthorize.vue'),
    );
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
      fields.oauthClientIdField,
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
    registerToolEndpoints(server, this.adminforth);
    registerSettingsEndpoints(server, this.authSecretStore, this.urls.mcpUrl, this.options.readOnly ?? false);
    registerOAuthEndpoints(server, this.oauth, adminApiPrefix(this.adminforth.config.baseUrl));
    registerMcpEndpoints(server, (input) => this.handleMcpRequest(input));
  }

  /** Accepts personal auth secrets and OAuth access tokens; access tokens are JWTs, secrets have their prefix. */
  private async authenticate(token: string) {
    if (token.startsWith(SECRET_PREFIX)) return this.authSecretStore.authenticate(token);
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

    const token = input.headers.authorization?.match(BEARER_TOKEN_RE)?.[1];
    const authenticated = token ? await this.authenticate(token) : null;
    if (!authenticated) {
      // resource_metadata leads OAuth clients to the authorization server; invalid_token makes them refresh.
      input.response.setHeader(
        'WWW-Authenticate',
        `Bearer ${token ? 'error="invalid_token", ' : ''}resource_metadata="${this.oauth.resourceMetadataUrl}"`,
      );
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
    const protocolResponse = await this.protocol.handle(
      new Request(this.urls.mcpUrl, { method: 'POST', headers: toolHeaders }),
      input.body,
      {
        ...createMcpServerPresentation(
          this.adminforth.config.customization.brandName,
          this.urls.adminPanelUrl,
          this.skills.serverInstructions(),
          readOnly,
        ),
        listTools: () => [...this.apiTools.list(readOnly), this.skills.toolDefinition()],
        callTool: async (name, arguments_) => {
          if (name === FETCH_SKILL_TOOL_NAME) return this.skills.call(arguments_);
          return this.apiTools.call({
            name,
            arguments: arguments_,
            adminUser,
            headers: toolHeaders,
            requestUrl: input.requestUrl,
            abortSignal: input.abortSignal,
            readOnly,
          });
        },
      },
    );

    protocolResponse.headers.forEach((value, name) => input.response.setHeader(name, value));
    input.response.setStatus(protocolResponse.status, await protocolResponse.text());
  }
}

export type { McpAuthSecretResourceOptions, McpOAuthClient, PluginOptions } from './types.js';
export { canonicalAgentName, formatMcpExecutedBy, readMcpClient } from './clientInfo.js';
