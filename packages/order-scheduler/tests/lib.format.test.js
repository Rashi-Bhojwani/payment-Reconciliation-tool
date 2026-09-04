import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMoney,
  formatWeight,
  formatDimensions,
  shipByUrgency,
  formatDateTime,
} from '../src/lib/format.js';

test('formatMoney keeps decimal precision and never uses floats', () => {
  // 0.1 + 0.2 territory: the string must survive exactly.
  assert.equal(formatMoney('1234.55', 'INR'), '₹1234.55');
  assert.equal(formatMoney('0.10', 'INR'), '₹0.10');
  assert.equal(formatMoney('19.999', 'USD'), '$20.00');
  assert.equal(formatMoney(null), '—');
});

test('formatWeight switches to kg above 1000g', () => {
  assert.equal(formatWeight('850'), '850 g');
  assert.equal(formatWeight('1000'), '1.00 kg');
  assert.equal(formatWeight('2450.5'), '2.45 kg');
  assert.equal(formatWeight(null), '—');
});

test('formatDimensions renders L × W × H', () => {
  assert.equal(formatDimensions('30.00', '20.50', '10.00'), '30 × 20.5 × 10 cm');
  assert.equal(formatDimensions('30', null, '10'), '—');
});

test('shipByUrgency bands on 6h and 12h (rule R6)', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const at = (hours) => new Date(now.getTime() + hours * 3_600_000);

  assert.equal(shipByUrgency(at(24), now).level, 'ok');
  assert.equal(shipByUrgency(at(11.5), now).level, 'warning');
  assert.equal(shipByUrgency(at(12.5), now).level, 'ok');
  assert.equal(shipByUrgency(at(5), now).level, 'critical');
  assert.equal(shipByUrgency(at(-2), now).level, 'overdue');
  assert.match(shipByUrgency(at(-2), now).label, /Overdue by 2h/);
  assert.equal(shipByUrgency(null, now).level, 'none');
});

test('formatDateTime renders UTC storage in Asia/Kolkata', () => {
  // 18:30 UTC is 00:00 the next day in IST (+05:30).
  assert.equal(formatDateTime('2026-01-01T18:30:00Z'), '02 Jan 2026, 00:00');
});
