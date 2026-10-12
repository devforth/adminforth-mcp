import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../custom/McpConfirm.vue', import.meta.url), 'utf8')
  .split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .*;$/gm, '');
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function page(verification, response = { ok: true }) {
  const calls = [];
  const context = vm.createContext({
    ref: value => ({ value }), computed: callback => ({ get value() { return callback(); } }),
    onMounted() {}, useRoute: () => ({ query: { id: 'confirmation-1' } }),
    useI18n: () => ({ t: text => text }),
    window: { adminforthTwoFaModal: { get2FaConfirmationResult: verification } },
    callAdminForthApi: async input => { calls.push(input); return response; },
  });
  vm.runInContext(script, context);
  vm.runInContext("pending.value = { connectionName: 'Claude Code', path: '/start_custom_action', arguments: {} }", context);
  return { context, calls };
}

test('tells the user to close the page after the action succeeds', async () => {
  const { context, calls } = page(async () => ({ token: 'browser-verification' }));
  await vm.runInContext('confirm()', context);
  assert.equal(calls[0].path, '/mcp/confirmation/run');
  assert.equal(vm.runInContext('failed.value', context), false);
  assert.match(vm.runInContext('resultMessage.value', context), /You can close this page/);
});

test('cancelling the verification declines the saved action instead of leaving a live link', async () => {
  const { context, calls } = page(async () => { throw 'Cancel'; });
  await vm.runInContext('confirm()', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/mcp/confirmation/decline');
  assert.equal(calls[0].body.id, 'confirmation-1');
  assert.equal(vm.runInContext('finished.value', context), true);
});

test('a failed action finishes the page without offering a retry', async () => {
  const { context, calls } = page(async () => ({ token: 'browser-verification' }), { ok: false, error: 'Action failed' });
  await vm.runInContext('confirm()', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/mcp/confirmation/run');
  assert.equal(vm.runInContext('finished.value', context), true);
  assert.equal(vm.runInContext('failed.value', context), true);
});
