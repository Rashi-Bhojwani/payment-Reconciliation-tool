import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDay, calendarDays } from './reporting-calendar.js';

test('an IST midnight sent as UTC resolves to the day the user picked', () => {
  // Exactly what the browser puts on the wire for "21 Jul" and for the
  // exclusive end of a window ending 29 Jul.
  assert.deepEqual(calendarDays({ start: '2026-07-20T18:30:00.000Z', end: '2026-07-29T18:30:00.000Z' }), ['2026-07-21', '2026-07-30']);
});

test('the answer does not move with the API process timezone', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      assert.equal(calendarDay('2026-07-20T18:30:00.000Z'), '2026-07-21', `TZ=${zone}`);
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

test('the last IST hours of a day still belong to that day', () => {
  assert.equal(calendarDay('2026-07-21T18:29:59.999Z'), '2026-07-21', '23:59:59 IST');
  assert.equal(calendarDay('2026-07-21T18:30:00.000Z'), '2026-07-22', '00:00:00 IST the next day');
});

test('a year boundary crosses in IST, not in UTC', () => {
  assert.equal(calendarDay('2026-12-31T18:30:00.000Z'), '2027-01-01');
});

test('an unusable date is rejected instead of silently becoming a wrong day', () => {
  assert.throws(() => calendarDay('not a date'), /Not a date/);
  assert.throws(() => calendarDay(undefined), /Not a date/);
});
