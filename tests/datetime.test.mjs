import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDatetime } from '../dist/datetime.js';

test('drops milliseconds of a UTC datetime without a time zone', () => {
  assert.equal(formatDatetime('2026-10-02T13:41:24.123Z', undefined), '2026-10-02T13:41:24Z');
});

test('shows a datetime in the time zone with its offset at that moment', () => {
  assert.equal(formatDatetime('2026-03-29T00:30:05.123Z', 'Europe/Kyiv'), '2026-03-29T02:30:05+02:00');
  assert.equal(formatDatetime('2026-03-29T01:30:05.123Z', 'Europe/Kyiv'), '2026-03-29T04:30:05+03:00');
  assert.equal(formatDatetime('2026-03-29T00:30:05Z', 'America/New_York'), '2026-03-28T20:30:05-04:00');
  assert.equal(formatDatetime('2026-03-29T00:30:05Z', 'Asia/Kolkata'), '2026-03-29T06:00:05+05:30');
  assert.equal(formatDatetime('2026-03-29T00:30:05Z', 'UTC'), '2026-03-29T00:30:05+00:00');
});
