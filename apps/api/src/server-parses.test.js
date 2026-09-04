import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
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
  assertDirectoryParses(join(here, 'jobs'), 'jobs');
});

test('every route module parses', () => {
  assertDirectoryParses(join(here, 'routes'), 'routes');
});

// The order-scheduler package was ported in from a separate repository and is
// almost entirely SQL inside template literals, which is the exact shape the
// backtick bug takes. Nothing in the test suite imports most of these files -
// the repositories all open a connection - so without this they could ship
// unparseable and the first sign would be the API failing to boot.
test('every order-scheduler module parses', () => {
  const src = join(here, '..', '..', '..', 'packages', 'order-scheduler', 'src');
  const found = assertDirectoryParses(src, 'order-scheduler', { recursive: true });
  assert.ok(found > 30, `expected the whole ported package to be walked, only saw ${found} file(s)`);
});

/** Parses every .js file in `dir`, and returns how many it checked. */
function assertDirectoryParses(dir, label, { recursive = false } = {}) {
  let checked = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (recursive && statSync(path).isDirectory()) {
      checked += assertDirectoryParses(path, `${label}/${name}`, { recursive });
      continue;
    }
    if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' }),
      `${label}/${name} does not parse`
    );
    checked += 1;
  }
  return checked;
}
