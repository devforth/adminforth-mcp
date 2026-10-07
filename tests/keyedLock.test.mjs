import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedLock } from '../dist/keyedLock.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('runs tasks with one key one at a time and tasks with other keys at once', async () => {
  const lock = new KeyedLock();
  const events = [];
  let releaseFirst;
  const first = lock.run('a', async () => {
    events.push('a1 start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push('a1 end');
  });
  const second = lock.run('a', async () => { events.push('a2'); });
  const other = lock.run('b', async () => { events.push('b'); });

  await tick();
  assert.deepEqual(events, ['a1 start', 'b']);
  releaseFirst();
  await Promise.all([first, second, other]);
  assert.deepEqual(events, ['a1 start', 'b', 'a1 end', 'a2']);
});

test('runs the next task after a failed one and returns task results', async () => {
  const lock = new KeyedLock();
  const failed = lock.run('a', async () => { throw new Error('boom'); });
  const next = lock.run('a', async () => 'done');

  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'done');
});

test('keeps no key once its tasks are done', async () => {
  const lock = new KeyedLock();
  await Promise.all(Array.from({ length: 1000 }, (_, i) => lock.run(`key-${i}`, async () => {})));
  await lock.run('a', async () => { throw new Error('boom'); }).catch(() => {});

  assert.equal(lock.tails.size, 0);
});
