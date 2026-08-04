import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Nothing in the test suite imports server.js - it opens a database and a port
// - so a syntax error in it ships silently and the API simply fails to boot.
// That has happened twice: once from a bad export name, and once from a
// backtick inside a SQL comment, which closed the surrounding template literal
// and turned the rest of the query into JavaScript. Both were invisible to a
// green test run.
//
// `node --check` is the cheapest possible guard: it parses without executing,
// so it needs no database, no port and no credentials.
const here = dirname(fileURLToPath(import.meta.url));

test('every API source file parses', () => {
  const files = readdirSync(here).filter(name => name.endsWith('.js') && !name.endsWith('.test.js'));
  assert.ok(files.includes('server.js'), 'the entry point must be among the files checked');
  for (const name of files) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', join(here, name)], { stdio: 'pipe' }),
      `${name} does not parse - the API would fail to start`
    );
  }
});

test('every job module parses', () => {
  const jobs = join(here, 'jobs');
  for (const name of readdirSync(jobs).filter(file => file.endsWith('.js') && !file.endsWith('.test.js'))) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', join(jobs, name)], { stdio: 'pipe' }),
      `jobs/${name} does not parse`
    );
  }
});
