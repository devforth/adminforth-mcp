import test from 'node:test';
import assert from 'node:assert/strict';
import { McpAdminPanelConfirmation } from '../dist/adminPanelConfirmation.js';

const USER = { pk: 'user-1', executedBy: 'Claude Code' };
const ARGS = { resourceId: 'cars', recordId: '42', actionId: 'approve', extra: { note: 'original' } };
const CONNECTION = { id: 'connection-1', name: 'Claude Code' };
const ADMIN_PANEL_ORIGIN = 'https://admin.example';
const OTHER_CONNECTION = { id: 'connection-2', name: 'Cursor' };
const VERIFICATION = { token: 'browser-verification' };
const REQUIRED = { ok: false, error: 'Confirmation result is required', code: 'TWO_FACTOR_REQUIRED' };

function setup(outputs = [{ ok: true }], { executionTimeoutMs = 1_000, verification = { ok: true } } = {}) {
  const calls = [];
  const contexts = [];
  const verifyCalls = [];
  // Like the 2FA plugin, a failed verifyAuto ends the verification context with its result.
  const twoFactorsAuth = {
    withVerificationContext: async (verificationResult, extra, callback) => {
      contexts.push({ verificationResult, extra });
      try {
        return await callback();
      } catch (error) {
        if (error.verificationFailure) return error.verificationFailure;
        throw error;
      }
    },
    verifyAuto: async (adminUser) => {
      verifyCalls.push(adminUser);
      if ('error' in verification) throw Object.assign(new Error(verification.error), { verificationFailure: verification });
      return verification;
    },
  };
  const adminforth = {
    config: { baseUrl: '/admin' },
    openApi: { registeredSchemas: [{
      method: 'POST', path: '/admin/adminapi/v1/start_custom_action',
      handler: async (input) => { calls.push(input); return outputs.shift(); },
    }] },
  };
  const confirmation = new McpAdminPanelConfirmation(adminforth, twoFactorsAuth, executionTimeoutMs);
  const offer = (connection = CONNECTION, args = ARGS, user = USER) => confirmation.offer(REQUIRED, connection, user, '/start_custom_action', args, ADMIN_PANEL_ORIGIN).output.confirmationId;
  const offered = confirmation.offer(REQUIRED, CONNECTION, USER, '/start_custom_action', ARGS, ADMIN_PANEL_ORIGIN);
  const id = offered.output.confirmationId;
  const input = {
    adminUser: { pk: USER.pk },
    response: { setStatus() {} },
    requestUrl: '/admin/adminapi/v1/mcp/confirmation/run',
    _raw_express_req: {},
    _raw_express_res: {},
  };
  return { confirmation, calls, contexts, verifyCalls, offered, offer, id, input };
}

test('offers a confirmation only for the TWO_FACTOR_REQUIRED code', () => {
  const { confirmation } = setup();
  for (const output of [{ ok: false, error: 'Failed', code: 'OTHER_ERROR' }, { ok: true }, null]) {
    assert.equal(confirmation.offer(output, CONNECTION, USER, '/start_custom_action', ARGS, ADMIN_PANEL_ORIGIN), undefined);
  }
});

test('describes the action with its description', () => {
  const { confirmation } = setup();
  const required = { ...REQUIRED, actionDescription: 'Approve listing of car 42' };
  const { output } = confirmation.offer(required, CONNECTION, USER, '/start_custom_action', ARGS, ADMIN_PANEL_ORIGIN);
  const description = confirmation.describe(output.confirmationId, USER);
  assert.equal(description.actions[0].actionDescription, 'Approve listing of car 42');
});

test('groups the link with up to 20 other pending actions of the same connection', () => {
  const { confirmation, offer, id } = setup();
  const sameConnection = Array.from({ length: 24 }, () => offer());
  offer(OTHER_CONNECTION);
  const clicked = sameConnection[10];
  const { actions } = confirmation.describe(clicked, USER);
  assert.equal(actions.length, 20);
  assert.equal(actions[0].id, clicked);
  assert.deepEqual(actions.slice(1).map((action) => action.id), [id, ...sameConnection.filter((other) => other !== clicked)].slice(0, 19));
});

test('reports a waiting status until the user answers', async (t) => {
  const { confirmation, id } = setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = confirmation.wait(id, 'connection-1');
  t.mock.timers.tick(50_000);
  assert.equal((await waiting).output.status, 'waiting');
});

test('runs the saved action with browser verification and delivers its result', async () => {
  const { confirmation, calls, contexts, verifyCalls, offered, id, input } = setup();
  assert.equal(offered.output.confirmationUrl, `https://admin.example/admin/mcp-confirm?id=${id}`);
  assert.equal(calls.length, 0);
  assert.deepEqual(await confirmation.run([id], VERIFICATION, input), { results: [{ id, output: { ok: true }, isError: false }] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { ...ARGS, extra: { note: 'original', verificationResult: VERIFICATION } });
  assert.equal(calls[0].adminUser.executedBy, 'Claude Code');
  assert.equal(calls[0].requestUrl, '/admin/adminapi/v1/start_custom_action');
  assert.equal(calls[0]._raw_express_req, undefined);
  assert.equal(calls[0]._raw_express_res, undefined);
  assert.equal(contexts[0].verificationResult, VERIFICATION);
  assert.equal(contexts[0].extra.response, input.response);
  // A 2FA filter may depend on executedBy, so the cached check must be made as the agent that runs the action.
  assert.deepEqual(verifyCalls[0], calls[0].adminUser);
  assert.deepEqual(await confirmation.wait(id, 'connection-1'), { output: { ok: true }, isError: false });
  assert.match(confirmation.describe(id, USER).error, /already confirmed/);
});

test('confirms a group of actions with one verification and delivers each result', async () => {
  const { confirmation, calls, contexts, verifyCalls, offer, id, input } = setup([{ ok: true }, { ok: false, error: 'Sold' }, { ok: true }]);
  const ids = [id, offer(CONNECTION, { ...ARGS, recordId: '43' }), offer(CONNECTION, { ...ARGS, recordId: '44' })];
  const { results } = await confirmation.run(ids, VERIFICATION, input);
  assert.deepEqual(results.map((result) => result.isError), [false, true, false]);
  assert.deepEqual(calls.map((call) => call.body.recordId), ['42', '43', '44']);
  assert.equal(contexts.length, 1);
  assert.equal(verifyCalls.length, 1);
  assert.deepEqual((await confirmation.wait(ids[1], 'connection-1')).output, { ok: false, error: 'Sold' });
  assert.equal((await confirmation.wait(ids[2], 'connection-1')).isError, false);
});

test('reports a record a beforeSave hook saved itself as a success', async () => {
  const output = { error: 'Operation aborted by hook', ok: false, newRecordId: '7', redirectToRecordId: '7' };
  const { confirmation, id, input } = setup([output]);
  assert.deepEqual((await confirmation.run([id], VERIFICATION, input)).results, [{ id, output, isError: false }]);
});

test('a failed verification settles every action of the group without running them', async () => {
  const failure = { error: 'Wrong or expired OTP code', code: 'TWO_FACTOR_INVALID' };
  const { confirmation, calls, offer, id, input } = setup(undefined, { verification: failure });
  const ids = [id, offer()];
  const { results } = await confirmation.run(ids, VERIFICATION, input);
  assert.equal(calls.length, 0);
  for (const [index, confirmationId] of ids.entries()) {
    assert.equal(results[index].output.code, 'TWO_FACTOR_INVALID');
    assert.equal((await confirmation.wait(confirmationId, 'connection-1')).output.code, 'TWO_FACTOR_INVALID');
  }
});

test('does not confirm actions of different connections together', async () => {
  const { confirmation, calls, offer, id, input } = setup();
  const otherId = offer(OTHER_CONNECTION);
  assert.match((await confirmation.run([id, otherId], VERIFICATION, input)).error, /different MCP clients/);
  assert.match(confirmation.decline([id, otherId], USER).error, /different MCP clients/);
  assert.equal(calls.length, 0);
  assert.equal(confirmation.describe(id, USER).actions.length, 1);
  assert.equal(confirmation.describe(otherId, USER).actions.length, 1);
});

test('does not share one verification between actions run as different agents', async () => {
  const { confirmation, calls, offer, id, input } = setup();
  const otherAgentId = offer(CONNECTION, ARGS, { ...USER, executedBy: 'Cursor' });
  assert.equal(confirmation.describe(id, USER).actions.length, 1);
  assert.match((await confirmation.run([id, otherAgentId], VERIFICATION, input)).error, /different MCP clients/);
  assert.equal(calls.length, 0);
});

test('a repeated id runs the action once', async () => {
  const { confirmation, calls, id, input } = setup([{ ok: true }, { ok: true }]);
  assert.equal((await confirmation.run([id, id], VERIFICATION, input)).results.length, 1);
  assert.equal(calls.length, 1);
});

test('a failed action consumes the link and reports the error to the agent', async () => {
  const failure = { ok: false, error: 'Action failed' };
  const { confirmation, id, input, calls } = setup([failure, { ok: true }]);
  assert.deepEqual((await confirmation.run([id], VERIFICATION, input)).results[0].output, failure);
  const result = await confirmation.wait(id, 'connection-1');
  assert.equal(result.isError, true);
  assert.deepEqual(result.output, failure);
  assert.match((await confirmation.run([id], VERIFICATION, input)).error, /already confirmed/);
  assert.match(confirmation.describe(id, USER).error, /already confirmed/);
  assert.equal(calls.length, 1);
});

test('denies access by another user or MCP connection', async () => {
  const { confirmation, id, calls, input } = setup();
  assert.match(confirmation.describe(id, { pk: 'other' }).error, /another user/);
  assert.equal((await confirmation.wait(id, 'other')).isError, true);
  assert.ok((await confirmation.run([id], VERIFICATION, { ...input, adminUser: { pk: 'other' } })).error);
  assert.equal(calls.length, 0);
});

test('declining settles the wait without executing the action', async () => {
  const { confirmation, id, calls } = setup();
  assert.deepEqual(confirmation.decline([id], USER), { ok: true });
  assert.equal((await confirmation.wait(id, 'connection-1')).isError, true);
  assert.equal(calls.length, 0);
  assert.match((await confirmation.run([id], VERIFICATION, { adminUser: USER, response: { setStatus() {} } })).error, /already confirmed/);
  assert.match(confirmation.describe(id, USER).error, /already confirmed/);
});

test('execution exceptions settle the result instead of leaving the agent waiting', async () => {
  const { confirmation, id, input } = setup();
  confirmation.adminforth.openApi.registeredSchemas[0].handler = async () => { throw new Error('Database failed'); };
  assert.equal((await confirmation.run([id], VERIFICATION, input)).results[0].output.code, 'MCP_CONFIRMATION_FAILED');
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
  assert.equal((await confirmation.run([id], VERIFICATION, input)).results[0].output.code, 'MCP_CONFIRMATION_TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal((await confirmation.wait(id, 'connection-1')).isError, true);
  assert.match((await confirmation.run([id], VERIFICATION, input)).error, /already confirmed/);
});

test('parallel confirm and decline cannot execute or cancel a running action', async () => {
  const { confirmation, id, input } = setup();
  let finish;
  let calls = 0;
  confirmation.adminforth.openApi.registeredSchemas[0].handler = async () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  };
  const execution = confirmation.run([id], VERIFICATION, input);
  assert.match((await confirmation.run([id], VERIFICATION, input)).error, /already running/);
  assert.match(confirmation.decline([id], USER).error, /already running/);
  await new Promise((resolve) => setImmediate(resolve));
  finish({ ok: true });
  await execution;
  assert.equal(calls, 1);
});

test('replays GET requests as queries with the browser cookies', async () => {
  const { confirmation, id, input, calls } = setup();
  confirmation.adminforth.openApi.registeredSchemas[0].method = 'GET';
  input.cookies = [{ key: 'session', value: 'browser' }];
  await confirmation.run([id], VERIFICATION, input);
  assert.deepEqual(calls[0].body, {});
  assert.equal(calls[0].query.recordId, '42');
  assert.equal(calls[0].cookies, input.cookies);
});
