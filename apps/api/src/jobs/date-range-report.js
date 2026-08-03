// Amazon's "Transactions for time period" export - the Date Range Transaction
// report a seller downloads from Seller Central Payments. It is the only
// Amazon artefact available to this tool that carries BOTH released and
// deferred activity in one file, which matters because a settlement report by
// definition contains neither deferred transactions nor anything Amazon has
// not yet paid out.
//
// Measured on a real 1-25 Jul export (455 rows): the deferred rows total
// 28,816.89, which is the amount by which settlement-derived Income fell short
// of that seller's own statement (28,816.51). Nothing is lost in parsing,
// dedup or joins - settlement documents simply never contained it.
//
// What this file is NOT: a reproduction of the Custom Unified Summary PDF.
// Verified against the real pair for the same seller and range - only the
// Expenses section reconciles (-42,315.60 here against -42,314.88 on the PDF,
// a 0.72 difference); Income and GST do not, under either the released-only or
// the all-rows population. The report also carries no fulfilment column at
// all, so the PDF's Seller-fulfilled/FBA split cannot come from it. Those are
// findings, not defects to be tuned away, and the roll-up below deliberately
// reproduces the FILE rather than the PDF.
import { createHash } from 'node:crypto';

/**
 * RFC 4180 parser. Handles the things Amazon's export actually contains - a
 * UTF-8 BOM, CRLF, quoted commas inside product titles - and the things a
 * hand-rolled `split(',')` silently corrupts: escaped quotes and embedded
 * newlines. Returns physical rows so every value stays traceable to a line
 * number in the original file.
 * @param {string} text
 */
export function parseCsv(text) {
  let input = String(text ?? '');
  if (input.charCodeAt(0) === 0xFEFF) input = input.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char !== '"') { field += char; continue; }
      if (input[i + 1] === '"') { field += '"'; i += 1; continue; }
      quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Amazon renames columns between marketplaces and over time, so every column
// this code depends on is matched by a normalised alias rather than an exact
// string. An unmatched mandatory column fails the import instead of silently
// summing zeros.
const COLUMN_ALIASES = Object.freeze({
  date: ['date', 'date time', 'datetime'],
  status: ['transaction status', 'status'],
  accountType: ['account type'],
  type: ['transaction type', 'type'],
  orderId: ['order id', 'amazon order id'],
  description: ['product details', 'description', 'details'],
  productCharges: ['total product charges', 'product charges'],
  promotionalRebates: ['total promotional rebates', 'promotional rebates'],
  amazonFees: ['amazon fees', 'fees'],
  other: ['other'],
  total: ['total inr', 'total', 'total amount']
});
const MANDATORY = ['date', 'type', 'productCharges', 'promotionalRebates', 'amazonFees', 'other', 'total'];
const normaliseHeader = value => String(value ?? '').replace(/\(.*?\)/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** @param {string[]} header */
export function mapColumns(header) {
  const normalised = header.map(normaliseHeader);
  const index = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const position = normalised.findIndex(name => aliases.includes(name));
    if (position !== -1) index[field] = position;
  }
  const missing = MANDATORY.filter(field => index[field] === undefined);
  return { index, missing };
}

// Amounts arrive as plain strings ("931.36", "-310.14", "0"), but Indian
// exports can carry grouping commas and some Amazon reports use accounting
// parentheses for negatives. Everything is converted to integer paise so that
// summing thousands of rows cannot drift: 0.1 + 0.2 is not 0.3 in binary
// floating point, and a statement that is out by a paisa is out.
/** @param {string} value */
export function toPaise(value) {
  const text = String(value ?? '').replace(/[₹\s,]/g, '');
  if (text === '' || text === '-') return 0;
  const negative = /^\(.*\)$/.test(text);
  const body = negative ? text.slice(1, -1) : text;
  if (!/^-?\d*(\.\d*)?$/.test(body) || body === '' || body === '.') return null;
  const [whole, fraction = ''] = body.replace('-', '').split('.');
  const paise = BigInt(whole || '0') * 100n + BigInt((`${fraction}00`).slice(0, 2));
  const signed = (body.startsWith('-') ? -paise : paise) * (negative ? -1n : 1n);
  return Number(signed);
}
export const paiseToRupees = paise => Math.round(Number(paise)) / 100;

// Amazon writes the date as d/m/yyyy in the Indian export. It is a calendar
// day in the marketplace's own timezone, with no time component - so it is
// kept as a plain YYYY-MM-DD string and never turned into an instant, which
// is exactly the conversion that produced off-by-one days elsewhere in this
// codebase.
/** @param {string} value */
export function toCalendarDay(value) {
  const text = String(value ?? '').trim();
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(text);
  if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

export const MONETARY_COMPONENTS = Object.freeze(['productCharges', 'promotionalRebates', 'amazonFees', 'other']);

/**
 * Parses a Date Range export into physical rows. Nothing is filtered, merged
 * or de-duplicated: two identical-looking rows are two real transactions and
 * both survive, keyed by their physical row number rather than by any hash of
 * their contents.
 * @param {string} text
 */
export function parseDateRangeReport(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { ok: false, error: 'The file is empty', rows: [], header: [] };
  const header = rows[0];
  const { index, missing } = mapColumns(header);
  if (missing.length) {
    return { ok: false, error: `Missing required column(s): ${missing.join(', ')}`, rows: [], header };
  }
  const parsed = [];
  const errors = [];
  for (let i = 1; i < rows.length; i += 1) {
    const raw = rows[i];
    if (raw.length <= 1 && !String(raw[0] ?? '').trim()) continue;
    const physicalRow = i + 1;
    const at = field => (index[field] === undefined ? '' : raw[index[field]] ?? '');
    const components = {};
    let broken = false;
    for (const component of MONETARY_COMPONENTS) {
      const paise = toPaise(at(component));
      if (paise === null) { errors.push({ physicalRow, column: component, value: at(component) }); broken = true; break; }
      components[component] = paise;
    }
    if (broken) continue;
    const statedTotal = toPaise(at('total'));
    if (statedTotal === null) { errors.push({ physicalRow, column: 'total', value: at('total') }); continue; }
    const day = toCalendarDay(at('date'));
    if (!day) { errors.push({ physicalRow, column: 'date', value: at('date') }); continue; }
    parsed.push({
      physicalRow,
      day,
      status: String(at('status') ?? '').trim(),
      accountType: String(at('accountType') ?? '').trim(),
      type: String(at('type') ?? '').trim(),
      orderId: String(at('orderId') ?? '').trim() || null,
      description: String(at('description') ?? '').trim(),
      ...components,
      statedTotalPaise: statedTotal,
      componentTotalPaise: MONETARY_COMPONENTS.reduce((sum, key) => sum + components[key], 0),
      raw
    });
  }
  return { ok: errors.length === 0, errors, header, rows: parsed, rawRowCount: rows.length - 1 };
}

/** SHA-256 of the exact bytes, so a re-import can be recognised as the same document. */
export const fileDigest = text => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

/**
 * Rolls parsed rows up the way the report itself adds up, in paise.
 *
 * `driftPaise` is the control total: Amazon states a Total per row, and it must
 * equal the sum of that row's four component columns. On the real 455-row
 * export the drift is exactly 0, so any non-zero value here means a parsing
 * fault rather than an Amazon quirk - it is reported, never absorbed.
 * @param {ReturnType<typeof parseDateRangeReport>['rows']} rows
 */
export function summariseDateRangeRows(rows) {
  const bucket = () => ({ rowCount: 0, productCharges: 0, promotionalRebates: 0, amazonFees: 0, other: 0, total: 0 });
  const totals = bucket();
  const byStatus = new Map();
  const byType = new Map();
  let driftPaise = 0;
  for (const row of rows) {
    driftPaise += row.statedTotalPaise - row.componentTotalPaise;
    for (const target of [totals, byStatus.get(row.status) ?? byStatus.set(row.status, bucket()).get(row.status),
      byType.get(row.type) ?? byType.set(row.type, bucket()).get(row.type)]) {
      target.rowCount += 1;
      for (const component of MONETARY_COMPONENTS) target[component] += row[component];
      target.total += row.statedTotalPaise;
    }
  }
  const asRupees = value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'rowCount' ? v : paiseToRupees(v)]));
  return {
    rowCount: rows.length,
    driftPaise,
    totals: asRupees(totals),
    byStatus: Object.fromEntries([...byStatus].map(([k, v]) => [k, asRupees(v)])),
    byType: Object.fromEntries([...byType].map(([k, v]) => [k, asRupees(v)]))
  };
}
