import test from 'node:test';
import assert from 'node:assert/strict';
import { McpAdminPanelConfirmation } from '../dist/adminPanelConfirmation.js';
import { createMcpUrls } from '../dist/urls.js';

const USER = { pk: 'user-1', executedBy: 'Claude Code' };
const ARGS = { resourceId: 'cars', recordId: '42', actionId: 'approve', extra: { note: 'original' } };
const CONNECTION = { id: 'connection-1', name: 'Claude Code' };
const VERIFICATION = { token: 'browser-verification' };
const REQUIRED = { ok: false, error: 'Confirmation result is required', code: 'TWO_FACTOR_REQUIRED' };

function setup(outputs = [{ ok: true }], { executionTimeoutMs = 1_000 } = {}) {
  const calls = [];
  const verifications = [];
  const twoFactorsAuth = {
    withVerificationContext: (verificationResult, request, callback) => {
      verifications.push({ verificationResult, request });
      return callback();
    },
  };
  const adminforth = {
    config: { baseUrl: '/admin' },
    openApi: { registeredSchemas: [{
      method: 'POST', path: '/admin/adminapi/v1/start_custom_action',
      handler: async (input) => { calls.push(input); return outputs.shift(); },
    }] },
  };
  const confirmation = new McpAdminPanelConfirmation(
    adminforth,
    createMcpUrls('https://admin.example', '/admin'),
    twoFactorsAuth,
    executionTimeoutMs,
  );
  const offered = confirmation.offer(REQUIRED, CONNECTION, USER, '/start_custom_action', ARGS);
  const id = offered.output.confirmationId;
  const input = {
    adminUser: { pk: USER.pk },
    response: { setStatus() {} },
    requestUrl: '/admin/adminapi/v1/mcp/confirmation/run',
    _raw_express_req: {},
    _raw_express_res: {},
  };
  return { confirmation, calls, verifications, offered, id, input };
}

test('offers a confirmation only for the TWO_FACTOR_REQUIRED code', () => {
  const { confirmation } = setup();
  for (const output of [{ ok: false, error: 'Failed', code: 'OTHER_ERROR' }, { ok: true }, null]) {
    assert.equal(confirmation.offer(output, CONNECTION, USER, '/start_custom_action', ARGS), undefined);
  }
});

test('describes the action with its description and the name of the MCP connection', () => {
  const { confirmation } = setup();
  const required = { ...REQUIRED, actionDescription: 'Approve listing of car 42' };
  const { output } = confirmation.offer(required, CONNECTION, USER, '/start_custom_action', ARGS);
  const description = confirmation.describe(output.confirmationId, USER);
  assert.equal(description.actionDescription, 'Approve listing of car 42');
  assert.equal(description.connectionName, 'Claude Code');
});

test('reports a waiting status until the user answers', async (t) => {
  const { confirmation, id } = setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = confirmation.wait(id, 'connection-1');
  t.mock.timers.tick(50_000);
  assert.equal((await waiting).output.status, 'waiting');
});

test('runs the saved action with browser verification and delivers its result', async () => {
  const { confirmation, calls, verifications, offered, id, input } = setup();
  assert.equal(offered.output.confirmationUrl, `https://admin.example/admin/mcp-confirm?id=${id}`);
  assert.equal(calls.length, 0);
  assert.deepEqual(await confirmation.run(id, VERIFICATION, input), { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { ...ARGS, extra: { note: 'original', verificationResult: VERIFICATION } });
  assert.equal(calls[0].adminUser.executedBy, 'Claude Code');
  assert.equal(calls[0].requestUrl, '/admin/adminapi/v1/start_custom_action');
  assert.equal(calls[0]._raw_express_req, undefined);
  assert.equal(calls[0]._raw_express_res, undefined);
  assert.equal(verifications[0].verificationResult, VERIFICATION);
  assert.equal(verifications[0].request.body, calls[0].body);
  assert.deepEqual(await confirmation.wait(id, 'connection-1'), { output: { ok: true }, isError: false });
  assert.match(confirmation.describe(id, USER).error, /already confirmed/);
});

test('a failed action consumes the link and reports the error to the agent', async () => {
  const failure = { ok: false, error: 'Action failed' };
  const { confirmation, id, input, calls } = setup([failure, { ok: true }]);
  assert.deepEqual(await confirmation.run(id, VERIFICATION, input), failure);
  const result = await confirmation.wait(id, 'connection-1');
  assert.equal(result.isError, true);
  assert.deepEqual(result.output, failure);
  assert.match((await confirmation.run(id, VERIFICATION, input)).error, /already confirmed/);
  assert.match(confirmation.describe(id, USER).error, /already confirmed/);
  assert.equal(calls.length, 1);
});

test('denies access by another user or MCP connection', async () => {
  const { confirmation, id, calls, input } = setup();
  assert.match(confirmation.describe(id, { pk: 'other' }).error, /another user/);
  assert.equal((await confirmation.wait(id, 'other')).isError, true);
  assert.ok((await confirmation.run(id, VERIFICATION, { ...input, adminUser: { pk: 'other' } })).error);
  assert.equal(calls.length, 0);
});

test('declining settles the wait without executing the action', async () => {
  const { confirmation, id, calls } = setup();
  assert.deepEqual(confirmation.decline(id, USER), { ok: true });
  assert.equal((await confirmation.wait(id, 'connection-1')).isError, true);
  assert.equal(calls.length, 0);
  assert.match((await confirmation.run(id, VERIFICATION, { adminUser: USER, response: { setStatus() {} } })).error, /already confirmed/);
  assert.match(confirmation.describe(id, USER).error, /already confirmed/);
});

test('execution exceptions settle the result instead of leaving the agent waiting', async () => {
  const { confirmation, id, input } = setup();
  confirmation.adminforth.openApi.registeredSchemas[0].handler = async () => { throw new Error('Database failed'); };
  assert.equal((await confirmation.run(id, VERIFICATION, input)).code, 'MCP_CONFIRMATION_FAILED');
  const result = await confirmation.wait(id, 'connection-1');
  assert.equal(result.isError, true);
  assert.equal(result.output.error, 'Database failed');
});

test('timeout aborts the handler and settles the result without permitting a retry', async () => {
  const { confirmation, id, input } = setup(undefined, { executionTimeoutMs: 5 });
  let signal;
  confirmation.adminforth.openApi.registeredSchemas[0].handler = async (input) => {
    signal = input.abortSignal;
    return new Promise(() => {});
  };
  assert.equal((await confirmation.run(id, VERIFICATION, input)).code, 'MCP_CONFIRMATION_TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal((await confirmation.wait(id, 'connection-1')).isError, true);
  assert.match((await confirmation.run(id, VERIFICATION, input)).error, /already confirmed/);
});

test('parallel confirm and decline cannot execute or cancel a running action', async () => {
  const { confirmation, id, input } = setup();
  let finish;
  let calls = 0;
  confirmation.adminforth.openApi.registeredSchemas[0].handler = async () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  };
  const execution = confirmation.run(id, VERIFICATION, input);
  assert.match((await confirmation.run(id, VERIFICATION, input)).error, /already running/);
  assert.match(confirmation.decline(id, USER).error, /already running/);
  finish({ ok: true });
  await execution;
  assert.equal(calls, 1);
});

test('replays GET requests as queries with the browser cookies', async () => {
  const { confirmation, id, input, calls } = setup();
  confirmation.adminforth.openApi.registeredSchemas[0].method = 'GET';
  input.cookies = [{ key: 'session', value: 'browser' }];
  await confirmation.run(id, VERIFICATION, input);
  assert.deepEqual(calls[0].body, {});
  assert.equal(calls[0].query.recordId, '42');
  assert.equal(calls[0].cookies, input.cookies);
});
