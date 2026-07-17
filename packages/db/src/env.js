import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal .env loader for local development. Node does not load .env by default,
 * and this repo intentionally avoids adding a dependency just for bootstrapping.
 */
export function loadDotEnv(cwd = process.cwd()) {
  const filePath = path.join(cwd, '.env');
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}
