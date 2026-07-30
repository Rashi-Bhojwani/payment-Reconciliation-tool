import test from 'node:test';
import assert from 'node:assert/strict';
import { intervalsCoverRange } from './source-coverage.js';

const range = {
  start: '2026-07-01T00:00:00.000Z',
  end: '2026-07-31T00:00:00.000Z'
};

test('merges adjacent and overlapping sync intervals into complete coverage', () => {
  assert.equal(intervalsCoverRange([
    {
      data_start_time: '2026-06-25T00:00:00.000Z',
      data_end_time: '2026-07-15T00:00:00.000Z'
    },
    {
      data_start_time: '2026-07-14T23:55:00.000Z',
      data_end_time: '2026-07-31T00:00:00.000Z'
    }
  ], range), true);
});

test('rejects a real gap even when the first and last timestamps span the range', () => {
  assert.equal(intervalsCoverRange([
    {
      data_start_time: '2026-07-01T00:00:00.000Z',
      data_end_time: '2026-07-15T00:00:00.000Z'
    },
    {
      data_start_time: '2026-07-15T00:05:00.000Z',
      data_end_time: '2026-08-01T00:00:00.000Z'
    }
  ], range), false);
});

test('rejects truncated, invalid, and empty interval sets', () => {
  assert.equal(intervalsCoverRange([{
    data_start_time: '2026-07-02T00:00:00.000Z',
    data_end_time: '2026-08-01T00:00:00.000Z'
  }], range), false);
  assert.equal(intervalsCoverRange([], range), false);
  assert.equal(intervalsCoverRange([{
    data_start_time: null,
    data_end_time: '2026-08-01T00:00:00.000Z'
  }], range), false);
});
