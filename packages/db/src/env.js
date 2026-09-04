// Loads .env before anything reads process.env, from anywhere in the repo.
//
// The problem this solves: index.js reads process.env.DATABASE_URL at MODULE
// LOAD time, but dotenv.config() only ran inside apps/api/src/config/secrets.js.
// Whether the URL was populated therefore depended on import order, and any
// standalone script - check-sql.mjs, repair-duplicated-settlements.mjs,
// migrate.js - never loaded dotenv at all. They saw nothing, and the only way to
// run them was to paste a live database credential into the source. That is a
// real risk, not an inconvenience: those files are committed.
//
// So the search is anchored to THIS FILE's location as well as the working
// directory. A script run from the repo root, from apps/api, or by absolute
// path from anywhere else all find the same .env.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isPlaceholder = value => {
  const text = String(value ?? '').trim();
  // Values a fresh checkout ships with, which are worse than missing: they look
  // configured and fail deep inside a driver instead of at startup.
  return text === '' || text === 'HEHE' || /^(changeme|replace[-_ ]?me|your[-_ ]?\w+|xxx+|todo)$/i.test(text);
};

/** Parses .env text. Deliberately small - no dependency, no shell evaluation. */
export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim().replace(/^export\s+/, '');
    if (!key) continue;
    let value = line.slice(equals + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    values[key] = value;
  }
  return values;
}

/** Every directory to look in, nearest first: the caller's cwd, then this package. */
function candidateDirectories() {
  const seen = new Set();
  const directories = [];
  const add = start => {
    let current = resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      if (!seen.has(current)) { seen.add(current); directories.push(current); }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  add(process.cwd());
  add(dirname(fileURLToPath(import.meta.url)));
  return directories;
}

let loadedFrom = null;

/**
 * Loads the nearest .env, without overwriting anything already set.
 * A real environment variable always wins over a file, so deployments and CI
 * keep behaving exactly as they do now.
 */
export function loadEnv() {
  if (loadedFrom !== null) return loadedFrom;
  loadedFrom = '';
  for (const directory of candidateDirectories()) {
    const file = join(directory, '.env');
    if (!existsSync(file)) continue;
    let parsed;
    try { parsed = parseEnvFile(readFileSync(file, 'utf8')); } catch { continue; }
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || isPlaceholder(process.env[key])) process.env[key] = value;
    }
    loadedFrom = file;
    break;
  }
  return loadedFrom;
}

/** The configured database URL, or null. Never returns a placeholder. */
export function databaseUrl() {
  loadEnv();
  const value = process.env.DATABASE_URL;
  return isPlaceholder(value) ? null : value;
}

/**
 * The database URL, or a clear failure explaining how to supply it.
 * Scripts call this so the answer to "why did nothing happen" is never
 * "paste your credential into the file".
 * @param {string} [purpose] what the caller needs it for
 */
export function requireDatabaseUrl(purpose = 'this command') {
  const url = databaseUrl();
  if (url) return url;
  const searched = loadedFrom || 'no .env found';
  throw new Error(
    `DATABASE_URL is not set, so ${purpose} cannot run.\n` +
    `  Loaded env from: ${searched}\n` +
    '  Set it in the repo-root .env file, or pass it for one command:\n' +
    '      DATABASE_URL=postgres://... npm run <command>\n' +
    '  Never hardcode it - these files are committed.'
  );
}

/** Where the .env was read from, for diagnostics. Never returns its contents. */
export const envFileLoadedFrom = () => { loadEnv(); return loadedFrom || null; };

loadEnv();
