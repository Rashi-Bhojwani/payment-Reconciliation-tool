// Parses every SQL string in server.js against a real Postgres carrying the
// project's own migrations, and checks each one is handed exactly as many
// parameters as it references. Catches "could not determine data type of
// parameter $2" (a parameter passed but never used) and "there is no
// parameter $4" (a parameter used but never passed) before a user does.
import fs from 'node:fs';
import pg from 'pg';
// Loads the repo's .env wherever this is run from, so the throwaway database
// can be configured in one place instead of pasted into the file.
import { envFileLoadedFrom } from '@recon/db/env.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const calls = [];
for (let i = 0; i < source.length; i += 1) {
  if (!source.startsWith('.query(', i)) continue;
  let j = i + '.query('.length;
  while (source[j] === ' ' || source[j] === '\n') j += 1;
  const quote = source[j];
  if (quote !== '`' && quote !== "'" && quote !== '"') continue;
  let k = j + 1;
  let text = '';
  while (k < source.length && source[k] !== quote) {
    if (source[k] === '\\') { text += source[k + 1]; k += 2; continue; }
    text += source[k];
    k += 1;
  }
  // Balance brackets from the end of the string literal to the closing paren.
  let depth = 1;
  let m = k + 1;
  let tail = '';
  while (m < source.length && depth > 0) {
    const c = source[m];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) { depth -= 1; if (depth === 0) break; }
    tail += c;
    m += 1;
  }
  calls.push({ line: source.slice(0, i).split('\n').length, text, tail });
  i = m;
}

function suppliedCount(tail) {
  const start = tail.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let current = '';
  const parts = [];
  for (let i = start; i < tail.length; i += 1) {
    const c = tail[i];
    if ('([{'.includes(c)) { depth += 1; if (depth === 1) continue; }
    if (')]}'.includes(c)) { depth -= 1; if (depth === 0) break; }
    if (c === ',' && depth === 1) { parts.push(current.trim()); current = ''; continue; }
    current += c;
  }
  if (current.trim()) parts.push(current.trim());
  // calendarDays() always spreads to exactly [startDay, endDay].
  return parts.reduce((total, part) => total + (part.startsWith('...calendarDays') ? 2 : 1), 0);
}

// Every statement found is actually executed, so this must point at a
// throwaway database carrying packages/db/migrations - never at real data.
const connectionString = process.env.SQLCHECK_DATABASE_URL;
if (!connectionString) {
  // Deliberately NOT falling back to DATABASE_URL: every statement below is
  // executed, so silently pointing this at the real database would run them
  // against live seller data.
  console.error('Set SQLCHECK_DATABASE_URL to a throwaway Postgres carrying packages/db/migrations.');
  console.error(`  Read env from: ${envFileLoadedFrom() ?? 'no .env found'}`);
  console.error('  It must NOT be your real database - every statement here is executed.');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString });
await pool.query("select set_config('app.current_tenant_id','11111111-1111-1111-1111-111111111111',false)");
let failures = 0;
for (const call of calls) {
  if (!/\$\d/.test(call.text) && !/^\s*(select|insert|update|delete|with)/i.test(call.text)) continue;
  const maxParam = Math.max(0, ...[...call.text.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
  const supplied = suppliedCount(call.tail);
  if (supplied !== null && supplied !== maxParam) {
    console.log(`server.js:${call.line}  PARAM COUNT: uses $1..$${maxParam}, caller passes ${supplied}`);
    failures += 1;
  }
  try {
    await pool.query({ text: call.text, values: Array.from({ length: maxParam }, () => null) });
  } catch (error) {
    if (/^(23|40|55)/.test(error.code ?? '')) continue; // constraint/lock issues are runtime, not shape
    console.log(`server.js:${call.line}  ${error.code} ${error.message}`);
    console.log(`   ${call.text.replace(/\s+/g, ' ').slice(0, 150)}`);
    failures += 1;
  }
}
console.log(`\n${calls.length} SQL statements checked, ${failures} problem(s)`);
await pool.end();
process.exit(failures ? 1 : 0);
