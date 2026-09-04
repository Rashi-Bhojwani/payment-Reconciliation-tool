import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile } from './env.js';

// Loading is verified through parseEnvFile and a child process rather than by
// re-importing this module: loadEnv() caches, deliberately, so that importing it
// from several places cannot re-read the file mid-run.
const withEnvFile = (contents, run) => {
  const directory = mkdtempSync(join(tmpdir(), 'envtest-'));
  try {
    writeFileSync(join(directory, '.env'), contents);
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('parses the shapes a real .env contains', () => {
  const parsed = parseEnvFile([
    '# a comment',
    '',
    'DATABASE_URL=postgres://user:pa55@host:5432/db',
    'export EXPORTED=yes',
    'QUOTED="spaced value"',
    "SINGLE='single quoted'",
    'TRAILING=value # not part of it',
    'EMPTY=',
    'no_equals_sign'
  ].join('\n'));
  assert.equal(parsed.DATABASE_URL, 'postgres://user:pa55@host:5432/db', 'a URL with : / @ survives intact');
  assert.equal(parsed.EXPORTED, 'yes', 'a leading "export" is not part of the name');
  assert.equal(parsed.QUOTED, 'spaced value');
  assert.equal(parsed.SINGLE, 'single quoted');
  assert.equal(parsed.TRAILING, 'value', 'an inline comment is stripped from an unquoted value');
  assert.equal(parsed.EMPTY, '');
  assert.equal('no_equals_sign' in parsed, false);
});

test('a password containing # or = is not truncated', () => {
  // Both are legal in a Postgres password and both would be lost by a naive
  // split on "=" or a blind comment strip.
  const parsed = parseEnvFile('DATABASE_URL="postgres://u:p#a=ss@host/db"\nPLAIN=a=b=c');
  assert.equal(parsed.DATABASE_URL, 'postgres://u:p#a=ss@host/db');
  assert.equal(parsed.PLAIN, 'a=b=c', 'only the FIRST = separates name from value');
});

test('a real environment variable always beats the file', () => {
  // Deployments and CI set real variables; the file is only a developer
  // convenience and must never override them.
  const script = `
    process.env.DATABASE_URL = 'postgres://from-the-shell/db';
    const m = await import(${JSON.stringify(new URL('./env.js', import.meta.url).href)});
    console.log(m.databaseUrl() === 'postgres://from-the-shell/db' ? 'SHELL_WINS' : 'FILE_WON');
  `;
  const out = withEnvFile('DATABASE_URL=postgres://from-the-file/db\n', directory =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' }));
  assert.match(out, /SHELL_WINS/);
});

test('the file is used when nothing is set, and found from a subdirectory', () => {
  const script = `
    delete process.env.DATABASE_URL;
    const m = await import(${JSON.stringify(new URL('./env.js', import.meta.url).href)});
    console.log(m.databaseUrl());
  `;
  const out = withEnvFile('DATABASE_URL=postgres://from-the-file/db\n', directory =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' }));
  assert.match(out, /postgres:\/\/from-the-file\/db/);
});

test('a placeholder counts as missing, and the error says how to fix it', () => {
  // A checkout that still carries the sample value looks configured and then
  // fails deep inside the driver. Failing at startup with instructions is the
  // whole point, and the message must not tell anyone to hardcode it.
  const script = `
    process.env.DATABASE_URL = 'HEHE';
    const m = await import(${JSON.stringify(new URL('./env.js', import.meta.url).href)});
    console.log(m.databaseUrl() === null ? 'TREATED_AS_MISSING' : 'ACCEPTED_PLACEHOLDER');
    try { m.requireDatabaseUrl('the repair'); } catch (e) { console.log(e.message); }
  `;
  const out = withEnvFile('# nothing useful here\n', directory =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' }));
  assert.match(out, /TREATED_AS_MISSING/);
  assert.match(out, /the repair cannot run/);
  assert.match(out, /Never hardcode it/);
});

test('no value is ever echoed by the diagnostic helper', () => {
  // envFileLoadedFrom() exists so a script can say where it looked. It must
  // report the path and nothing that was in it.
  const script = `
    delete process.env.DATABASE_URL;
    const m = await import(${JSON.stringify(new URL('./env.js', import.meta.url).href)});
    console.log(String(m.envFileLoadedFrom()));
  `;
  const out = withEnvFile('DATABASE_URL=postgres://secret-host/db\nAPI_KEY=supersecret\n', directory =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' }));
  assert.match(out, /\.env$/m, 'it reports the path it read');
  assert.equal(/secret-host|supersecret/.test(out), false, 'and never the contents');
});
