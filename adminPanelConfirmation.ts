import { randomUUID } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/server';
import type {
  AdminUser,
  HttpExtra,
  IAdminForth,
  IAdminForthEndpointHandlerInput,
  IAdminForthHttpResponse,
} from 'adminforth';
import type { ContextualTwoFactorsAuth } from './twoFactorContext.js';
import { adminApiPrefix, CONFIRMATION_PAGE_PATH, type McpUrls } from './urls.js';

export const WAIT_FOR_CONFIRMATION_TOOL_NAME = 'wait_for_confirmation';
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const WAIT_MS = 50_000;
const TWO_FACTOR_REQUIRED_CODE = 'TWO_FACTOR_REQUIRED';

type ToolCallResult = { output: unknown; isError: boolean };
type AdminUserWithExecutor = AdminUser & { executedBy?: string };
type ToolOutput = { code?: string; actionDescription?: string };
export type McpConnection = { id: string; name: string };
interface PendingCall {
  userPk: string;
  connection: McpConnection;
  executedBy?: string;
  actionDescription?: string;
  path: string;
  arguments: Record<string, unknown>;
  settled: boolean;
  running: boolean;
  settle: (result: ToolCallResult) => void;
  result: Promise<ToolCallResult>;
}

export class McpAdminPanelConfirmation {
  private readonly pageUrl: string;
  private readonly apiPrefix: string;
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly adminforth: IAdminForth,
    urls: McpUrls,
    private readonly twoFactorsAuth: ContextualTwoFactorsAuth,
    private readonly executionTimeoutMs: number,
  ) {
    this.pageUrl = new URL(`${adminforth.config.baseUrl}${CONFIRMATION_PAGE_PATH}`, urls.apiUrl).href;
    this.apiPrefix = adminApiPrefix(adminforth.config.baseUrl);
  }

  toolDefinition(): Tool {
    return {
      name: WAIT_FOR_CONFIRMATION_TOOL_NAME,
      description: 'Waits until the user confirms or declines in the admin panel an action that returned a confirmationUrl, and returns the result of the action. Returns a waiting status after about a minute; call it again to keep waiting.',
      inputSchema: {
        type: 'object',
        required: ['confirmationId'],
        properties: { confirmationId: { type: 'string' } },
      },
      annotations: { readOnlyHint: true },
    };
  }

  runUnverified<T>(extra: HttpExtra, callback: () => Promise<T>): Promise<unknown> {
    return this.twoFactorsAuth.withVerificationContext(undefined, extra, callback);
  }

  offer(
    output: unknown,
    connection: McpConnection,
    adminUser: AdminUserWithExecutor,
    path: string,
    args: Record<string, unknown>,
  ): ToolCallResult | undefined {
    const { code, actionDescription } = (output ?? {}) as ToolOutput;
    if (code !== TWO_FACTOR_REQUIRED_CODE) return undefined;
    const confirmationId = randomUUID();
    let resolve!: (result: ToolCallResult) => void;
    const pending: PendingCall = {
      userPk: adminUser.pk!,
      connection,
      executedBy: adminUser.executedBy,
      actionDescription,
      path,
      arguments: args,
      settled: false,
      running: false,
      settle: (result) => {
        pending.settled = true;
        resolve(result);
      },
      result: new Promise((settle) => { resolve = settle; }),
    };
    this.pending.set(confirmationId, pending);
    setTimeout(() => this.pending.delete(confirmationId), CONFIRMATION_TTL_MS).unref();
    return {
      output: {
        error: `This action needs a two-factor verification, which only the admin panel can ask for. Show the user the confirmationUrl, then call ${WAIT_FOR_CONFIRMATION_TOOL_NAME} with the confirmationId: it returns the result once the user confirms or declines the action there.`,
        confirmationUrl: `${this.pageUrl}?id=${confirmationId}`,
        confirmationId,
      },
      isError: true,
    };
  }

  describe(confirmationId: string, adminUser: AdminUser) {
    const pending = this.open(confirmationId, adminUser);
    if ('error' in pending) return pending;
    return {
      actionDescription: pending.actionDescription,
      connectionName: pending.connection.name,
      path: pending.path,
      arguments: pending.arguments,
    };
  }

  async run(confirmationId: string, verificationResult: Record<string, unknown>, input: IAdminForthEndpointHandlerInput & { adminUser: AdminUser }): Promise<unknown> {
    const pending = this.open(confirmationId, input.adminUser);
    if ('error' in pending) {
      input.response.setStatus(400);
      return pending;
    }
    pending.running = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.abortSignal?.addEventListener('abort', abort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let output: any;
    let responseStatus = 200;
    const response: IAdminForthHttpResponse = {
      setHeader: (key, value) => input.response.setHeader(key, value),
      setStatus: (status, message) => {
        responseStatus = status;
        input.response.setStatus(status, message);
      },
      blobStream: () => input.response.blobStream(),
    };
    try {
      const schema = this.adminforth.openApi.registeredSchemas.find((candidate) => (
        candidate.path === `${this.apiPrefix}${pending.path}`
      ))!;
      const hasBody = !['GET', 'HEAD'].includes(schema.method.toUpperCase());
      const extra = pending.arguments.extra as Record<string, unknown> | undefined;
      const args: Record<string, unknown> = { ...pending.arguments, extra: { ...extra, verificationResult } };
      const request: HttpExtra = {
        body: hasBody ? args : {},
        query: hasBody ? {} : args as Record<string, string>,
        headers: input.headers,
        cookies: input.cookies,
        requestUrl: schema.path,
        response,
      };
      const execution = this.twoFactorsAuth.withVerificationContext(verificationResult, request, async () => schema.handler!({
        ...request,
        adminUser: { ...input.adminUser, executedBy: pending.executedBy } as AdminUserWithExecutor,
        abortSignal: controller.signal,
        tr: input.tr,
        _raw_express_req: undefined as never,
        _raw_express_res: undefined as never,
      }));
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ ok: false, code: 'MCP_CONFIRMATION_TIMEOUT', error: `Action timed out after ${this.executionTimeoutMs / 1000} seconds. It may still complete; check the result before trying again.` });
        }, this.executionTimeoutMs);
      });
      output = await Promise.race([execution, timeout]);
      if (output === undefined) output = { ok: false, error: 'Action handler completed without returning a response.' };
    } catch (error) {
      output = { ok: false, code: 'MCP_CONFIRMATION_FAILED', error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      input.abortSignal?.removeEventListener('abort', abort);
      pending.running = false;
    }
    pending.settle({ output, isError: responseStatus >= 400 || Boolean(output && typeof output === 'object' && ('error' in output || output.ok === false)) });
    return output;
  }

  decline(confirmationId: string, adminUser: AdminUser): { ok: true } | { error: string } {
    const pending = this.open(confirmationId, adminUser);
    if ('error' in pending) return pending;
    pending.settle({ output: { error: 'The user declined the action in the admin panel.' }, isError: true });
    return { ok: true };
  }

  async wait(confirmationId: string, connectionId: string): Promise<ToolCallResult> {
    const pending = this.pending.get(confirmationId);
    if (pending?.connection.id !== connectionId) {
      return { output: { error: 'Unknown or expired confirmationId.' }, isError: true };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ToolCallResult>((resolve) => {
      timer = setTimeout(() => resolve({
        output: { status: 'waiting', note: `The user has not confirmed or declined the action yet. Call ${WAIT_FOR_CONFIRMATION_TOOL_NAME} again to keep waiting.` },
        isError: false,
      }), WAIT_MS);
    });
    try {
      return await Promise.race([pending.result, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private open(confirmationId: string, adminUser: AdminUser): PendingCall | { error: string } {
    const pending = this.pending.get(confirmationId);
    if (!pending) return { error: 'This confirmation link is invalid or expired. Ask your agent for a new one.' };
    if (pending.userPk !== adminUser.pk) return { error: 'This confirmation link was created for another user.' };
    if (pending.running) return { error: 'This action is already running.' };
    if (pending.settled) return { error: 'This action was already confirmed or declined.' };
    return pending;
  }
}
