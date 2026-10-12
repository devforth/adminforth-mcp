import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../custom/McpConfirm.vue', import.meta.url), 'utf8')
  .split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .*;$/gm, '');
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

const ACTION = { id: 'confirmation-1', path: '/start_custom_action', arguments: { recordId: '42' } };

function page(verification, response = { results: [{ id: ACTION.id, output: { ok: true }, isError: false }] }, actions = [ACTION]) {
  const calls = [];
  const modalCalls = [];
  const context = vm.createContext({
    ref: value => ({ value }), computed: callback => ({ get value() { return callback(); } }),
    onMounted() {}, useRoute: () => ({ query: { id: ACTION.id } }),
    useI18n: () => ({ t: text => text }),
    window: { adminforthTwoFaModal: { get2FaConfirmationResult: (...args) => { modalCalls.push(args); return verification(); } } },
    callAdminForthApi: async input => { calls.push(input); return response; },
  });
  vm.runInContext(script, context);
  vm.runInContext(`pending.value = ${JSON.stringify({ connectionName: 'Claude Code', actions })}`, context);
  return { context, calls, modalCalls };
}

test('tells the user to close the page after the action succeeds', async () => {
  const { context, calls, modalCalls } = page(async () => ({ token: 'browser-verification' }));
  await vm.runInContext('confirm()', context);
  assert.equal(modalCalls[0][2].details, '/start_custom_action\n{\n  "recordId": "42"\n}');
  assert.equal(calls[0].path, '/mcp/confirmation/run');
  assert.deepEqual([...calls[0].body.ids], [ACTION.id]);
  assert.equal(vm.runInContext('failed.value', context), false);
  assert.match(vm.runInContext('resultMessage.value', context), /You can close this page/);
});

test('cancelling the verification declines the saved action instead of leaving a live link', async () => {
  const { context, calls } = page(async () => { throw 'Cancel'; }, { ok: true });
  await vm.runInContext('confirm()', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/mcp/confirmation/decline');
  assert.deepEqual([...calls[0].body.ids], [ACTION.id]);
  assert.equal(vm.runInContext('failed.value', context), false);
  assert.match(vm.runInContext('resultMessage.value', context), /Declined/);
});

test('a failed action finishes the page without offering a retry', async () => {
  const failure = { results: [{ id: ACTION.id, output: { ok: false, error: 'Action failed' }, isError: true }] };
  const { context, calls } = page(async () => ({ token: 'browser-verification' }), failure);
  await vm.runInContext('confirm()', context);
  assert.equal(calls.length, 1);
  assert.equal(vm.runInContext('failed.value', context), true);
  assert.equal(vm.runInContext('resultMessage.value', context), 'Action failed');
});

test('confirms a group of actions in one modal and lists the ones that failed', async () => {
  const actions = [{ ...ACTION, actionDescription: 'Approve listing of car 42' }, { ...ACTION, id: 'confirmation-2' }];
  const response = { results: [
    { id: 'confirmation-1', output: { ok: true }, isError: false },
    { id: 'confirmation-2', output: { ok: false, error: 'Sold' }, isError: true },
  ] };
  const { context, calls, modalCalls } = page(async () => ({ token: 'browser-verification' }), response, actions);
  await vm.runInContext('confirm()', context);
  assert.deepEqual([...modalCalls[0][2].items], ['Approve listing of car 42', '/start_custom_action {"recordId":"42"}']);
  assert.deepEqual([...calls[0].body.ids], ['confirmation-1', 'confirmation-2']);
  assert.equal(vm.runInContext('failed.value', context), true);
  assert.deepEqual([...vm.runInContext('failedErrors.value', context)], ['Sold']);
});
