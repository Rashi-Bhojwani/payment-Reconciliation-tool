/** Shared scalar parsing used by every structured report importer. */
export function text(value) { return value == null ? undefined : String(value).trim() || undefined; }
export function number(value) { const parsed = Number(String(value ?? '').replace(/[,₹$]/g, '')); return Number.isFinite(parsed) ? parsed : 0; }
export function reportDate(value) {
  const input = text(value);
  if (!input) return null;
  const match = input.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(.*))?$/);
  if (!match) return input;
  const [, day, month, year, time] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${time ? ` ${time}` : ''}`;
}
/** @param {Record<string, unknown>} row @param {string[]} names */
export function pick(row, names) {
  const values = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), value]));
  for (const name of names) {
    const value = values.get(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (value != null && String(value).trim() !== '') return value;
  }
  return undefined;
}
