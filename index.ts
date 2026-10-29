import {
  AdminForthPlugin,
  type AdminForthResource,
  type AdminUser,
  type IAdminForth,
  type IAdminForthEndpointHandlerInput,
  type IHttpServer,
} from 'adminforth';
import { McpAdminPanelConfirmation, WAIT_FOR_CONFIRMATION_TOOL_NAME } from './adminPanelConfirmation.js';
import { registerConfirmationEndpoints } from './endpoints/confirmation.js';
import type { Transport } from '@modelcontextprotocol/server';
import { AdminForthApiTools } from './apiTools.js';
import { formatMcpExecutedBy, readMcpClient, UNKNOWN_CLIENT } from './clientInfo.js';
import { createMcpServerPresentation, McpProtocol, type McpProtocolContext } from './mcpProtocol.js';
import { McpAuthSecretStore, SECRET_PREFIX } from './authSecretStore.js';
import { registerMcpEndpoints } from './endpoints/mcp.js';
import { registerOAuthEndpoints } from './endpoints/oAuth.js';
import { registerSettingsEndpoints } from './endpoints/settings.js';
import { registerToolEndpoints } from './endpoints/tools.js';
import { AuthSecretRepository } from './repositories/authSecret.js';
import type { McpOAuth } from './oauth/authorizationServer.js';
import { setupOAuth } from './oauth/setup.js';
import { requestExtra } from './requestExtra.js';
import { McpResourceVisibility } from './resourceVisibility.js';
import { createServerReadOnly, type ServerReadOnly } from './serverReadOnly.js';
import { FETCH_SKILL_TOOL_NAME, McpSkills } from './skills.js';
import { findContextualTwoFactorsAuth } from './twoFactorContext.js';
import type { McpSession, PluginOptions } from './types.js';
import { adminApiPrefix, CONFIRMATION_PAGE_PATH, createMcpUrls, type McpUrls } from './urls.js';

const BEARER_TOKEN_RE = /^Bearer (\S+)$/i;
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_CALLS_PER_REQUEST = 10;
const AUDIT_LOG_PLUGIN_CLASS_NAME = 'AuditLogPlugin';

type AdminUserWithExecutor = AdminUser & { executedBy?: string };

/**
 * Credentials never reach tool handlers, which may log, persist or forward the headers they are given: neither the
 * long-lived MCP auth secret of an HTTP request nor the admin session cookie of an in-memory connection.
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
  private resourceVisibility!: McpResourceVisibility;
  private adminPanelConfirmation?: McpAdminPanelConfirmation;
  private skills!: McpSkills;
  private urls!: McpUrls;
  private readonly protocol = new McpProtocol();
  private readonly serverReadOnly: ServerReadOnly;

  constructor(options: PluginOptions) {
    super(options, import.meta.url);
    this.options = options;
    this.serverReadOnly = createServerReadOnly(options.readOnly);
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
    authSecretResource.options.agent = { ...authSecretResource.options.agent, hiddenFromAgents: true };
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
        icon: 'lucide:bot',
        pageLabel: 'MCP',
        slug: 'mcp',
        component: this.componentPath('McpSettings.vue'),
        isVisible: () => true,
      });
    }
    this.showAgentLogosInAuditLog(adminforth.config.resources);

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
      this.serverReadOnly,
    );
    const toolTimeoutMs = this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const twoFactorsAuth = findContextualTwoFactorsAuth(adminforth);
    if (twoFactorsAuth) {
      adminforth.config.customization.customPages.push({
        path: CONFIRMATION_PAGE_PATH,
        component: { file: this.componentPath('McpConfirm.vue'), meta: { sidebarAndHeader: 'none' } },
      });
      this.adminPanelConfirmation = new McpAdminPanelConfirmation(
        adminforth,
        this.urls,
        twoFactorsAuth,
        toolTimeoutMs,
      );
    }
    const pageSize = {
      default: this.options.pageSize?.default ?? DEFAULT_PAGE_SIZE,
      max: this.options.pageSize?.max ?? MAX_PAGE_SIZE,
    };
    this.resourceVisibility = new McpResourceVisibility(adminforth);
    this.apiTools = new AdminForthApiTools(
      adminforth,
      this.resourceVisibility,
      pageSize,
      toolTimeoutMs,
      this.adminPanelConfirmation,
    );
    const { customComponentsDir } = adminforth.config.customization;
    const otherPlugins = [
      ...(adminforth.config.globalPlugins ?? []),
      ...adminforth.config.resources.flatMap((resource) => resource.plugins ?? []),
    ].filter((plugin) => plugin !== this);
    this.skills = new McpSkills(
      this.customFolderPath,
      {
        'pageSize.default': pageSize.default,
        'pageSize.max': pageSize.max,
        toolCallsPerRequest: this.options.toolCallsPerRequest ?? DEFAULT_TOOL_CALLS_PER_REQUEST,
      },
      [...new Set([
        ...(customComponentsDir ? [customComponentsDir] : []),
        ...otherPlugins.map((plugin) => plugin.customFolderPath),
      ])],
    );
  }

  /**
   * Shows agents with their logos in the "executed by" column of the audit log, when the audit log has one.
   * The audit log plugin is found in the config, it may be not activated yet.
   */
  private showAgentLogosInAuditLog(resources: AdminForthResource[]): void {
    for (const resource of resources) {
      const auditLog = resource.plugins?.find((plugin) => plugin.className === AUDIT_LOG_PLUGIN_CLASS_NAME);
      const executedByColumnName = auditLog?.pluginOptions.resourceColumns.resourceExecutedByColumnName;
      if (!executedByColumnName) continue;

      const executedByColumn = resource.columns.find((column) => column.name === executedByColumnName)!;
      // components set in the resource config win
      executedByColumn.components = {
        list: { file: this.componentPath('ExecutedBy.vue') },
        show: { file: this.componentPath('ExecutedBy.vue') },
        ...executedByColumn.components,
      };
    }
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
    registerToolEndpoints(server, this.adminforth, this.resourceVisibility);
    registerSettingsEndpoints(server, this.authSecretStore, this.urls.mcpUrl, this.serverReadOnly);
    registerOAuthEndpoints(server, this.oauth, adminApiPrefix(this.adminforth.config.baseUrl));
    if (this.adminPanelConfirmation) registerConfirmationEndpoints(server, this.adminPanelConfirmation);
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

    const reportedClient = readMcpClient(input.body, input.headers);
    const client = reportedClient.client === UNKNOWN_CLIENT && authenticated.client
      ? authenticated.client
      : reportedClient;
    this.authSecretStore.touch(authenticated.recordId, reportedClient);

    const adminUser: AdminUserWithExecutor = {
      ...authenticated.adminUser,
      executedBy: formatMcpExecutedBy(client, authenticated.name),
    };
    const protocolResponse = await this.protocol.handle(
      new Request(this.urls.mcpUrl, { method: 'POST', headers: input.headers, signal: input.abortSignal }),
      input.body,
      await this.sessionContext({
        adminUser,
        connection: { id: authenticated.recordId, name: authenticated.name },
        readOnly: authenticated.readOnly,
        headers: input.headers,
        requestUrl: input.requestUrl,
      }),
    );

    protocolResponse.headers.forEach((value, name) => input.response.setHeader(name, value));
    input.response.setStatus(protocolResponse.status, await protocolResponse.text());
  }

  async openConnection(session: McpSession): Promise<Transport> {
    return this.protocol.open(await this.sessionContext(session));
  }

  private async sessionContext(session: McpSession): Promise<McpProtocolContext> {
    const readOnly = session.readOnly || await this.serverReadOnly(session.adminUser);
    const headers = withoutCredentials(session.headers);
    return {
      ...createMcpServerPresentation(
        this.adminforth.config.customization.brandName,
        this.urls.adminPanelUrl,
        this.skills.serverInstructions(),
        readOnly,
      ),
      listTools: () => [
        ...this.apiTools.list(readOnly),
        this.skills.toolDefinition(),
        ...(this.adminPanelConfirmation ? [this.adminPanelConfirmation.toolDefinition()] : []),
      ],
      callTool: async (name, arguments_, signal) => {
        if (name === FETCH_SKILL_TOOL_NAME) return this.skills.call(arguments_);
        if (name === WAIT_FOR_CONFIRMATION_TOOL_NAME && this.adminPanelConfirmation) {
          return this.adminPanelConfirmation.wait(String(arguments_?.confirmationId), session.connection.id);
        }
        return this.apiTools.call({
          name,
          arguments: arguments_,
          adminUser: session.adminUser,
          headers,
          requestUrl: session.requestUrl,
          abortSignal: signal,
          readOnly,
          connection: session.connection,
          timeZone: session.timeZone,
        });
      },
    };
  }
}

export type { McpAuthSecretResourceOptions, McpOAuthClient, McpSession, PluginOptions } from './types.js';
export { canonicalAgentName, formatMcpExecutedBy, readMcpClient } from './clientInfo.js';
