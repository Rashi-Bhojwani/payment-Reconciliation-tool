import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseUrlConfigured, pool } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../migrations');

if (!databaseUrlConfigured) {
  console.error('DATABASE_URL is not configured. Set it before running migrations.');
  process.exit(1);
}

const files = (await readdir(migrationsDir)).filter(file => file.endsWith('.sql')).sort();

for (const file of files) {
  const sql = await readFile(path.join(migrationsDir, file), 'utf8');
  console.log(`Applying ${file}...`);
  await pool.query(sql);
}

await pool.end();
console.log(`Applied ${files.length} migration file(s).`);
