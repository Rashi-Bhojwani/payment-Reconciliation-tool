import { createHash } from 'node:crypto';
import cron from 'node-cron';
import pLimit from 'p-limit';
import { z } from 'zod';
import { assertActiveTenant, pool, withTenant } from '@recon/db';
import { getSpApiEndpoint, REPORT_TYPES, SpApiClient } from '@recon/sp-api-client';
import { decryptSecret } from '../config/crypto.js';
import { putRawReport } from '../storage/s3.js';
import { runJob } from './runner.js';
import { categorizeFinanceLabel, flattenFinanceTransaction } from './finance-components.js';

export { categorizeFinanceLabel } from './finance-components.js';

const NIGHTLY_REPORTS = [...REPORT_TYPES];
const SyncParamsSchema = z.object({ tenantId: z.string().uuid(), reportType: z.enum(REPORT_TYPES), range: z.object({ start: z.string().datetime(), end: z.string().datetime() }).optional() });
const ReportRowSchema = z.record(z.string(), z.unknown());

/** @param {unknown} value */
function text(value) { return value == null ? undefined : String(value).trim() || undefined; }
/** @param {unknown} value */
function number(value) { const parsed = Number(String(value ?? '').replace(/[,₹$]/g, '')); return Number.isFinite(parsed) ? parsed : 0; }
/** @param {unknown} value */
function integer(value) { return Math.trunc(number(value)); }
function reportDate(value) {
  const input = text(value);
  if (!input) return null;
  const match = input.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(.*))?$/);
  if (!match) return input;
  const [, day, month, year, time] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${time ? ` ${time}` : ''}`;
}
function firstAttribute(attributes, names) {
  for (const name of names) {
    const value = attributes?.[name];
    if (Array.isArray(value) && value[0]) return value[0];
  }
  return undefined;
}
function catalogShippingFacts(catalog) {
  const attributes = catalog?.attributes ?? catalog?.payload?.attributes ?? {};
  const weight = firstAttribute(attributes, ['item_package_weight', 'item_weight']);
  const dimensions = firstAttribute(attributes, ['item_package_dimensions', 'item_dimensions']);
  const dimensionText = dimensions
    ? [dimensions.length, dimensions.width, dimensions.height].filter(value => value != null).join(' × ') + (dimensions.unit ? ` ${dimensions.unit}` : '')
    : null;
  return { weight: number(weight?.value), weightUnit: text(weight?.unit), dimensions: dimensionText };
}
function financeRelatedValue(transaction, wantedNames) {
  const identifiers = transaction?.relatedIdentifiers ?? transaction?.RelatedIdentifiers;
  if (Array.isArray(identifiers)) {
    const match = identifiers.find(identifier => wantedNames.includes(String(identifier?.relatedIdentifierName ?? identifier?.RelatedIdentifierName ?? '').toUpperCase()));
    return text(match?.relatedIdentifierValue ?? match?.RelatedIdentifierValue);
  }
  for (const name of wantedNames) {
    const camelName = name.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = identifiers?.[camelName] ?? identifiers?.[name] ?? identifiers?.[name.toLowerCase()];
    if (value) return text(value);
  }
  return undefined;
}
/** @param {Record<string, unknown>} row @param {string[]} names */

function sourceKey(row, parts = []) {
  const explicit = text(pick(row, ['source-key', 'source key', 'sourceKey', 'transaction-id', 'transaction id', 'transactionId', 'return-event-id', 'event-id', 'eventId']));
  if (explicit) return explicit;
  const material = parts.map(part => text(part) ?? '').join('|') || JSON.stringify(row);
  return createHash('sha256').update(material).digest('hex').slice(0, 48);
}

/**
 * Assigns each row its position within its own group, so identity can be
 * structural rather than value-based.
 *
 * A content hash can never tell apart two lines Amazon legitimately sent as
 * identical - an order shipping two units of one SKU at one price emits two
 * byte-identical settlement lines. Hashing them produced one key, and both the
 * in-chunk pre-merge and "on conflict do update" then kept only one. The lost
 * line took its tax line with it, which is why a real seller's shortfall sat
 * at exactly India's 18% GST ratio: a principal and its own tax disappearing
 * together.
 *
 * The group is the settlement document, not the sync, so "the Nth line of
 * settlement S" stays stable no matter which other documents were merged into
 * the same fetch. Settlement documents are immutable, so re-importing one
 * yields the same ordinals and the upsert stays idempotent.
 * @param {Array<Record<string, unknown>>} rows
 * @param {(row: Record<string, unknown>) => string} groupOf
 */
export function ordinalsWithinGroup(rows, groupOf) {
  const counters = new Map();
  return rows.map(row => {
    const group = groupOf(row) ?? '';
    const next = (counters.get(group) ?? 0) + 1;
    counters.set(group, next);
    return next;
  });
}

/**
 * withTenant, but the whole callback runs inside one Postgres transaction, so
 * no other connection can observe a partially applied write set.
 *
 * Any sync that refreshes a table by deleting rows and re-inserting them needs
 * this. Without a transaction those are separate autocommitted statements, and
 * a dashboard request landing between the delete and the insert reads a table
 * with rows missing - producing money figures that are silently wrong for the
 * duration of the sync. Observed live: the same tenant and date range reported
 * 4038 finance rows on one render and 1426 on the next.
 *
 * Built from `pool` here rather than exported from @recon/db so this file
 * cannot fail to start against an older or locally modified copy of that
 * package - it only needs the pool, which has always been exported.
 *
 * set_config's third argument is true so the tenant setting is scoped to the
 * transaction and released by COMMIT/ROLLBACK instead of lingering on a pooled
 * connection.
 * @template T
 * @param {string} tenantId
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTenantTransaction(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1,$2,true)', ['app.current_tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.query("select set_config('app.current_tenant_id','',false)").catch(() => undefined);
    client.release();
  }
}

function pick(row, names) {
  const lowerMap = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), value]));
  for (const name of names) {
    const value = lowerMap.get(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (value != null && String(value).trim() !== '') return value;
  }
  return undefined;
}
// pick() alone can't tell "this column doesn't exist in this file's schema"
// apart from "it exists but is blank on this row" - both return undefined.
// That distinction is exactly what a B2B/B2C mismatch check needs: a real
// B2C row genuinely has an empty Customer Bill To Gstid (consumers don't
// have GST registration - confirmed against a real B2B file, where every
// row has one), but a report format this app has never seen the column
// name for at all must not be treated as evidence of anything.
function hasColumn(row, names) {
  const keys = new Set(Object.keys(row).map(key => key.toLowerCase().replace(/[^a-z0-9]/g, '')));
  return names.some(name => keys.has(name.toLowerCase().replace(/[^a-z0-9]/g, '')));
}

const BATCH_UPSERT_CHUNK_SIZE = 500;
// Tables where a dropped row is missing money, not just a missing detail.
const LEDGER_TABLES = new Set(['settlement_rows', 'returns', 'reimbursements', 'finance_transaction_items']);

/**
 * Inserts many rows in a handful of multi-row statements instead of one
 * sequential round trip per row. A high-volume seller's settlement or
 * finance-event report is realistically tens of thousands of lines; one
 * awaited query per row at that scale is slow enough to risk the sync
 * request itself timing out mid-import (server platform, reverse proxy, or
 * browser), leaving only whatever was inserted before the cutoff actually
 * saved - a "completed" sync with silently incomplete data, indistinguishable
 * from a correct one until the totals are compared against Amazon.
 * @param {import('pg').PoolClient} client
 * @param {{ table: string, columns: string[], conflictColumns?: string[], updateColumns?: string[], rows: unknown[][], chunkSize?: number }} params
 * @returns {Promise<number>}
 */
export async function batchUpsert(client, { table, columns, conflictColumns, updateColumns, rows, chunkSize = BATCH_UPSERT_CHUNK_SIZE }) {
  if (!rows.length) return 0;
  const conflictIndexes = updateColumns?.length ? conflictColumns.map(name => columns.indexOf(name)) : null;
  const action = updateColumns?.length
    ? `on conflict (${conflictColumns.join(',')}) do update set ${updateColumns.map(name => `${name}=excluded.${name}`).join(', ')}`
    : 'on conflict do nothing';
  let imported = 0;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    let chunk = rows.slice(offset, offset + chunkSize);
    if (conflictIndexes) {
      // A single "insert ... on conflict do update" cannot affect the same
      // target row twice in one statement, so same-key rows within a chunk
      // must be pre-merged (keep the latest). But the real unique
      // constraints here include nullable columns, and Postgres never treats
      // NULL as equal to NULL for conflict purposes - two rows that are both
      // NULL in a key column are NOT duplicates of each other. A naive
      // string-join key would incorrectly collapse them, so any row with a
      // null key component always gets its own unique synthetic key instead.
      const seen = new Map();
      chunk.forEach((row, rowIndex) => {
        const keyParts = conflictIndexes.map(index => row[index]);
        const key = keyParts.some(value => value == null) ? `row${rowIndex}` : JSON.stringify(keyParts);
        seen.set(key, row);
      });
      // Silent row loss in a financial ledger is unacceptable. This pre-merge
      // exists because one INSERT cannot touch the same conflict target twice,
      // but if it ever drops a row that means two rows Amazon sent as distinct
      // collapsed to one key - money quietly leaving the ledger. It cost a real
      // seller whole order lines (a principal AND its tax, giving a shortfall
      // at exactly India's 18% GST ratio) before anyone noticed, because
      // nothing said a word.
      const dropped = chunk.length - seen.size;
      if (dropped > 0) {
        const collapsed = [...seen.entries()].filter(([, row], _index, entries) => entries.length < chunk.length).slice(0, 3).map(([key]) => key);
        const detail = `${dropped} row(s) in ${table} shared a conflict key within one batch and were merged; keys e.g. ${collapsed.join(' | ') || '(null key components)'}`;
        if (LEDGER_TABLES.has(table)) throw new Error(`Refusing to silently drop financial rows: ${detail}`);
        console.warn(`[batchUpsert] ${detail}`);
      }
      chunk = [...seen.values()];
    }
    const values = [];
    const placeholders = chunk.map((row, rowIndex) => {
      values.push(...row);
      const base = rowIndex * columns.length;
      return `(${columns.map((_, columnIndex) => `$${base + columnIndex + 1}`).join(',')})`;
    }).join(',');
    await client.query(`insert into ${table}(${columns.join(',')}) values ${placeholders} ${action}`, values);
    imported += chunk.length;
  }
  return imported;
}

/** @param {string} textContent @returns {Array<Record<string, unknown>>} */
// Amazon's own SP-API flat-file reports (settlement, GST MTR, FBA reports)
// are genuinely tab-separated with no quoting - a naive split('\t') has
// always been correct for those, confirmed against real synced report
// files in storage/raw-reports. But a report a human downloads directly
// from Seller Central's UI is not guaranteed to be the same file: a real
// Merchant Tax Report pulled from Seller Central > Manage Taxes > GST
// Monthly Reports came back as RFC4180 CSV - comma-delimited, double-quote
// wrapped fields, no tabs anywhere in the document. Fed through the old
// tab-only splitter, the entire header line collapsed into one bogus
// column and every real field (order id, invoice date, every tax amount)
// silently came back as undefined/0 - not an error, just wrong data
// stored as if it were right. Confirmed directly against that real file
// before this fix, not assumed.
//
// Delimiter is detected from the header line (tab wins if present, since
// every verified API report uses it and a value could theoretically
// contain a comma); quote handling is real RFC4180 - a field wrapped in
// "..." can contain the delimiter or a literal newline, and "" inside a
// quoted field is an escaped literal quote. Parsed as one character stream
// rather than pre-splitting on newlines specifically so an embedded
// newline inside a quoted field (e.g. a multi-line item description)
// cannot be mistaken for a row boundary.
export function parseDelimited(textContent) {
  const trimmed = z.string().parse(textContent).trim();
  if (!trimmed) return [];
  const delimiter = trimmed.slice(0, trimmed.indexOf('\n') === -1 ? trimmed.length : trimmed.indexOf('\n')).includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (inQuotes) {
      if (char === '"') {
        if (trimmed[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') { inQuotes = true; continue; }
    if (char === delimiter) { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [headerRow, ...dataRows] = rows;
  const headers = headerRow.map(header => header.trim());
  return dataRows.filter(r => r.some(value => value !== '')).map(r => Object.fromEntries(headers.map((header, index) => [header, r[index]])));
}

/** @param {Record<string, unknown>} object @returns {Record<string, unknown>} */
function flattenObjectRow(object) {
  const flat = { ...object };
  function walk(value, path = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, nestedValue] of Object.entries(value)) {
      const nextPath = [...path, key];
      flat[nextPath.join('.')] = nestedValue;
      if (path.length) flat[key] ??= nestedValue;
      if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) walk(nestedValue, nextPath);
    }
  }
  walk(object);
  return flat;
}

/** @param {unknown} value @returns {Array<Record<string, unknown>>} */
function collectObjectRows(value) {
  if (Array.isArray(value)) return value.flatMap(collectObjectRows);
  if (!value || typeof value !== 'object') return [];
  const object = value;
  const arrays = Object.values(object).filter(Array.isArray);
  if (arrays.length) return arrays.flatMap(collectObjectRows);
  return [flattenObjectRow(object)];
}

/** @param {string} reportType @param {string} content */
function parseReportRows(reportType, content) {
  const parsedType = z.enum(REPORT_TYPES).parse(reportType);
  const trimmed = z.string().parse(content).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed);
    if (parsedType === 'GET_SALES_AND_TRAFFIC_REPORT') {
      return collectObjectRows(json).filter(row => pick(row, ['date', 'parentAsin', 'childAsin', 'asin']));
    }
    return collectObjectRows(json);
  }
  return parseDelimited(trimmed);
}

/** @param {string} tenantId @param {string} content */
const settlementIdOf = row => text(pick(row, ['settlement-id', 'settlement id', 'settlementId']));

// Amazon puts a checksum in every settlement document and it has never once
// been wrong: the lines of a settlement sum exactly to the total-amount on
// its header row. Verified across 52 settlements in five real documents - 52
// balanced, 0 did not, to the paisa.
//
// So there is no need to guess whether an import is sound. Any duplication,
// truncation, dropped line or misparsed amount breaks this equality, and it
// costs one pass over rows already in memory. Refusing the import is the
// right response: a settlement stored wrong is money reported wrong, and
// because the document is then marked processed and never re-downloaded, no
// later sync would heal it.
export function settlementBalanceErrors(rows, idOf = settlementIdOf) {
  const totals = new Map();
  for (const row of rows) {
    const id = idOf(row);
    if (id == null) continue;
    const entry = totals.get(id) ?? { header: null, sum: 0 };
    // The header is the row that *states* a total-amount - not the row with a
    // blank transaction-type. Amazon leaves transaction-type empty on real
    // money rows too: a settlement's FBAInboundTransportationFee and its
    // CGST/SGST all carry amounts with no transaction-type at all. Testing
    // for the blank field instead matched those, and since number('') is 0
    // rather than null it overwrote a genuine 5,205.50 header with zero and
    // reported a balanced settlement as broken.
    const statedTotal = text(pick(row, ['total-amount', 'total amount', 'totalAmount']));
    if (statedTotal != null) entry.header = number(statedTotal);
    entry.sum += number(pick(row, ['amount']));
    totals.set(id, entry);
  }
  const errors = [];
  for (const [id, { header, sum }] of totals) {
    if (header == null) continue;
    const difference = Math.round((sum - header) * 100) / 100;
    if (Math.abs(difference) > 0.01) errors.push({ settlement_id: id, header_total: header, rows_total: Math.round(sum * 100) / 100, difference });
  }
  return errors;
}
function assertSettlementsBalance(rows, tenantId) {
  const errors = settlementBalanceErrors(rows);
  if (!errors.length) return;
  const detail = errors.slice(0, 5).map(e => `${e.settlement_id}: lines total ${e.rows_total} against Amazon's stated ${e.header_total} (${e.difference > 0 ? '+' : ''}${e.difference})`).join('; ');
  throw new Error(`Refusing to store settlement data that disagrees with Amazon's own document totals - ${errors.length} settlement(s) out of balance for tenant ${tenantId.slice(0, 8)}: ${detail}`);
}

// Amazon's settlement documents are not one-settlement-each: every report is
// a rolling window that repeats the settlements the previous reports already
// contained. Verified against five real documents from one account - they
// hold 1, 10, 10, 15 and 16 settlements, and 13 settlements appear in up to
// four documents at once, byte-for-byte identical.
//
// The downloader merges the documents of one fetch into a single blob before
// parsing, so a repeated settlement arrives twice in the same parse. Its rows
// are identical, but the ordinal tiebreak - which exists so that two
// genuinely identical Amazon lines stay two rows - numbers the second copy
// differently, giving it a different source_key. The upsert then cannot
// collapse them and both copies persist. Measured on two real overlapping
// documents: 2,009 real rows became 3,350 persisted, and all 8 shared
// settlements landed at exactly 2.00x their true value - 72,456.77 of
// invented money out of 89,643.18.
//
// Keeping the first copy is safe because the repeats are identical. The block
// boundary is the header row - the one that states a total-amount - because
// every settlement begins with exactly one (verified: 15 headers for 15
// settlements in the largest document, with no unattributed rows). Watching
// for the settlement-id to *change* instead is not enough: when one document
// ends with the settlement the next begins with, the two copies sit side by
// side and the id never changes between them, so both survive.
//
// Across separate syncs no dedup is needed: each blob then holds one copy,
// the ordinals come out the same, and source_key makes the re-import
// idempotent by itself.
export function dropRepeatedSettlements(rows, idOf = settlementIdOf) {
  const seen = new Set();
  const kept = [];
  let skipping = false;
  for (const row of rows) {
    const startsBlock = text(pick(row, ['total-amount', 'total amount', 'totalAmount'])) != null;
    if (startsBlock) {
      const id = idOf(row);
      skipping = id != null && seen.has(id);
      if (id != null) seen.add(id);
    }
    if (!skipping) kept.push(row);
  }
  return kept;
}

async function saveSettlementRows(tenantId, content) {
  const parsed = z.array(ReportRowSchema).parse(parseReportRows('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', content));
  const rows = dropRepeatedSettlements(parsed);
  if (rows.length !== parsed.length) {
    console.log(`[sync ${tenantId.slice(0, 8)}:settlement] ${parsed.length - rows.length} row(s) dropped - documents in this fetch repeated settlements Amazon had already included in an earlier one`);
  }
  assertSettlementsBalance(rows, tenantId);
  // Position within the settlement document this line belongs to.
  const ordinals = ordinalsWithinGroup(rows, settlementIdOf);
  let persisted = 0;
  await withTenantTransaction(tenantId, async client => {
    const batch = rows.map((row, rowIndex) => {
      const amount = number(pick(row, ['amount']));
      return [tenantId, text(pick(row, ['settlement-id', 'settlement id', 'settlementId'])), text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId'])), text(pick(row, ['amount-type', 'amount type', 'amountType'])), text(pick(row, ['amount-description', 'amount description', 'amountDescription'])), amount, reportDate(pick(row, ['posted-date', 'posted date', 'postedDate'])), row, sourceKey(row, [
        pick(row, ['settlement-id', 'settlement id', 'settlementId']),
        pick(row, ['transaction-type', 'transaction type', 'transactionType']),
        pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId']),
        pick(row, ['amount-type', 'amount type', 'amountType']),
        pick(row, ['amount-description', 'amount description', 'amountDescription']),
        pick(row, ['posted-date', 'posted date', 'postedDate']),
        amount,
        // Every discriminator Amazon supplies. Without these, two units of one
        // SKU on one order collapse to a single row and take their tax with them.
        pick(row, ['order-item-code', 'order item code', 'orderItemCode']),
        pick(row, ['merchant-order-item-id', 'merchant order item id', 'merchantOrderItemId']),
        pick(row, ['merchant-adjustment-item-id', 'merchant adjustment item id']),
        pick(row, ['shipment-id', 'shipment id', 'shipmentId']),
        pick(row, ['adjustment-id', 'adjustment id', 'adjustmentId']),
        pick(row, ['sku', 'seller-sku', 'sellerSku']),
        pick(row, ['quantity-purchased', 'quantity purchased', 'quantityPurchased']),
        pick(row, ['promotion-id', 'promotion id', 'promotionId']),
        pick(row, ['posted-date-time', 'posted date time', 'postedDateTime']),
        // Structural tiebreak: Amazon can legitimately emit two fully identical
        // lines, and no hash of their content can ever separate them.
        `#${ordinals[rowIndex]}`
      ])];
    });
    // source_key is deterministic per settlement/transaction line, and is
    // the real conflict identity here - not the business columns. Settlement
    // header rows deliberately share NULL order_id/amount_type/
    // amount_description/posted_date across *different* settlements
    // (Postgres never treats two NULLs as equal, so a composite target on
    // those columns can never tell one settlement's header from another's,
    // by design), but re-syncing the *same* settlement a second time
    // produces the exact same source_key both times - so source_key is what
    // actually needs to drive the update-vs-insert decision, refreshing
    // deposit metadata on re-sync instead of erroring or duplicating.
    persisted = await batchUpsert(client, {
      table: 'settlement_rows',
      columns: ['tenant_id', 'settlement_id', 'order_id', 'amount_type', 'amount_description', 'amount', 'posted_date', 'raw', 'source_key'],
      conflictColumns: ['tenant_id', 'source_key'],
      updateColumns: ['settlement_id', 'order_id', 'amount_type', 'amount_description', 'amount', 'posted_date', 'raw'],
      rows: batch
    });
    // Distinct keys must equal parsed rows. If two lines Amazon sent as
    // separate share a key, one overwrites the other and the money is gone -
    // and because the document is then recorded as processed and never
    // re-downloaded, no later sync can heal it.
    const distinctKeys = new Set(batch.map(row => row[row.length - 1])).size;
    if (distinctKeys !== rows.length) {
      throw new Error(`Settlement import would lose rows: ${rows.length} parsed but only ${distinctKeys} distinct source_key values`);
    }
  });
  return { parsed: rows.length, persisted };
}

/** @param {string} tenantId @param {string} content @param {'b2b'|'b2c'} invoiceType */
// A real Merchant Tax Report has one row per SHIPMENT ITEM, not one per
// order - a two-SKU order invoiced on the same date produces two distinct
// rows. The old conflict target here was (tenant_id, invoice_type, order_id,
// invoice_date) - no line-item discriminator at all - so those two genuinely
// separate GST lines silently collapsed into one upsert, confirmed live: "69
// row(s) in gst_invoices shared a conflict key within one batch and were
// merged" on a single real file. gst_invoices also never received the
// source_key treatment settlement_rows/returns/order_items/reimbursements
// got in migrations 011/012/014 - source_key is what actually keys the
// database row now too (see 024_gst_invoices_source_key.sql), so this must
// generate one for every row and use it as the real upsert identity, the
// same fix already proven for those other tables.
/**
 * True when Amazon refused a report because this application was not allowed
 * to ask for it, as opposed to any other reason a report can fail.
 *
 * The distinction decides what the sync ledger shows, and getting it wrong is
 * expensive in a specific way. "Amazon has no data for this period" is a
 * correct, finished answer and deserves a green COMPLETED pill. A permission
 * refusal is not an answer at all - it means the request never happened, there
 * is a concrete fix (grant the role, then RE-AUTHORIZE so a new refresh token
 * carries it), and marking it completed hides both the problem and the fix.
 *
 * It also stops the fix working: findMissingReportTypes treats a completed row
 * as coverage, so the automatic sync would not retry the real report even
 * after the seller re-authorized and it would finally have succeeded. Observed
 * live on GST B2B/B2C, where a seller saw a green COMPLETED pill sitting
 * directly above Amazon's own 403 naming the missing Tax Invoicing role, and
 * reasonably concluded the sync had worked and the invoices did not exist.
 *
 * @param {unknown} message
 */
export function isPermissionRefusal(message) {
  const text = String(message ?? '');
  // The digit guards are not decoration. `\b403\b` matches the "403" in
  // 403-2036854-8535523 - a perfectly ordinary Amazon India order id, since a
  // hyphen is a word boundary - and in "4030 rows" it does not, but only by
  // luck of which side you look at. Any message quoting an order id would have
  // been read as a permission refusal and shown as a hard failure. Requiring
  // the code to be bounded by neither a digit nor a hyphen keeps "403 -",
  // "403:" and "status code 401" while excluding both.
  //
  // The role phrasing is matched explicitly because the SP-API client wraps a
  // 403 with its own guidance ('requires the "Tax Invoicing" role...'), and a
  // future wording change there should not silently turn a refusal back into
  // a success.
  return /(?<![\d-])(?:401|403)(?![\d-])|forbidden|unauthorized|access to the resource is denied|requires the "[^"]+" role/i.test(text);
}

const GSTID_FIELD_NAMES = ['customer-bill-to-gstid', 'customer bill to gstid', 'customerbilltogstid', 'customer-ship-to-gstid', 'customer ship to gstid', 'customershiptogstid'];
// Catches uploading a B2C file to the B2B button or vice versa - a real
// mistake to worry about, since the upload endpoint has no other way to
// know which type a file actually is; it trusts whichever button was
// clicked entirely. A B2B invoice legally requires the buyer's GSTIN, a B2C
// one never has one (confirmed against a real file: every B2B row carries a
// populated Customer Bill To Gstid). Only fires when the column is present
// in the file's own schema at all (see hasColumn) - a report shape this
// check has never seen a sample of is left unvalidated rather than blocked
// on a guess.
export function assertGstInvoiceTypeMatchesContent(rows, invoiceType) {
  if (!rows.length || !rows.some(row => hasColumn(row, GSTID_FIELD_NAMES))) return;
  const withGstid = rows.filter(row => pick(row, GSTID_FIELD_NAMES) != null).length;
  if (invoiceType === 'b2b' && withGstid === 0) {
    throw new Error(`This looks like a B2C file, not B2B - none of the ${rows.length} row(s) have a buyer GSTIN, which every B2B invoice requires. Check you picked the right file/button.`);
  }
  if (invoiceType === 'b2c' && withGstid === rows.length) {
    throw new Error(`This looks like a B2B file, not B2C - every one of the ${rows.length} row(s) has a buyer GSTIN, which a B2C (consumer) invoice never has. Check you picked the right file/button.`);
  }
}
/**
 * The invoice date for one GST row, normalised.
 *
 * reportDate(), not text(). Settlement's posted-date has always gone through
 * it; this one did not, and it is the same family of Indian Amazon report with
 * the same DD-MM-YYYY dates. Handed to Postgres raw, "04-08-2026" (4 August)
 * is read as 8 April under the default MDY DateStyle - a row silently filed
 * four months from where it belongs, and therefore invisible on every date
 * range that should contain it - while "14-07-2026" is not a date at all under
 * MDY and fails the whole import. reportDate() leaves an ISO date untouched,
 * so this is safe whichever format Amazon's API actually sends.
 */
export function gstInvoiceDate(row) {
  return reportDate(pick(row, ['invoice-date', 'invoice date', 'invoiceDate', 'transaction-date', 'transaction date']));
}

/**
 * One tax component (cgst / sgst / igst) for a GST invoice row, summed across
 * every place Amazon splits it.
 *
 * Confirmed against a real Merchant Tax Report: each row carries the tax three
 * times over - once on the item, once on the shipping charge and once on the
 * gift wrap ("Cgst Tax", "Shipping Cgst Tax", "Gift Wrap Cgst Tax") - and the
 * file's own "Total Tax Amount" is their sum. Reading only the item column, as
 * this did, silently under-reports GST on any order that carried a shipping
 * charge. It happened to be exactly right on the July file because every
 * shipping and gift-wrap tax there was zero, which is precisely the kind of
 * sample that makes a wrong rule look correct.
 *
 * UTGST folds into SGST deliberately. Union territories levy CGST + UTGST
 * where states levy CGST + SGST; the two occupy the same half of the split and
 * this table has no fourth column for it. Dropping it would lose real tax and
 * leave the components short of Total Tax Amount.
 *
 * Falls back to the single-column names if none of the component columns are
 * present, so a file shaped differently from the MTR still reads.
 */
export function gstTaxComponent(row, base) {
  const components = base === 'sgst'
    ? ['sgst tax', 'shipping sgst tax', 'gift wrap sgst tax', 'utgst tax', 'shipping utgst tax', 'gift wrap utgst tax']
    : [`${base} tax`, `shipping ${base} tax`, `gift wrap ${base} tax`];
  if (components.some(name => hasColumn(row, [name]))) {
    return round2(components.reduce((sum, name) => sum + number(pick(row, [name])), 0));
  }
  return number(pick(row, [base, `${base} tax`, `${base} amount`]));
}

function round2(value) { return Math.round(value * 100) / 100; }

async function saveGstInvoices(tenantId, content, invoiceType) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows(invoiceType === 'b2b' ? 'GET_GST_MTR_B2B_CUSTOM' : 'GET_GST_MTR_B2C_CUSTOM', content));
  assertGstInvoiceTypeMatchesContent(rows, invoiceType);
  const ordinals = ordinalsWithinGroup(rows, row => text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId'])));
  await withTenantTransaction(tenantId, async client => {
    // 'tax exclusive gross' is the column a real Seller Central Merchant Tax
    // Report download uses for this - there is no column literally called
    // "taxable value" in that file at all. Confirmed arithmetically against
    // three real rows before adding this, not assumed: Tax Exclusive Gross +
    // Total Tax Amount = Invoice Amount, exactly, to the paisa, on every row -
    // that is the taxable value. Kept alongside the original candidates
    // rather than replacing them, in case the API's own report (never yet
    // seen live for this tenant - Tax Invoicing role still pending) uses
    // different naming.
    //
    // Collected alongside the batch so the "did anything get a date?" check
    // below reads a named list instead of counting columns into a positional
    // array - the kind of index that silently means something else the next
    // time a column is added.
    const invoiceDates = [];
    const batch = rows.map((row, rowIndex) => {
      const orderId = text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId']));
      const invoiceDate = gstInvoiceDate(row);
      invoiceDates.push(invoiceDate);
      const taxableValue = number(pick(row, ['taxable-value', 'taxable value', 'taxableValue', 'taxable amount', 'tax exclusive gross']));
      return [tenantId, invoiceType, orderId, gstTaxComponent(row, 'cgst'), gstTaxComponent(row, 'sgst'), gstTaxComponent(row, 'igst'), taxableValue, invoiceDate, row, sourceKey(row, [
        orderId, invoiceDate, taxableValue,
        pick(row, ['invoice-number', 'invoice number', 'invoiceNumber']),
        pick(row, ['shipment-item-id', 'shipment item id', 'shipmentItemId']),
        pick(row, ['sku', 'seller-sku', 'sellerSku']),
        pick(row, ['asin']),
        `#${ordinals[rowIndex]}`
      ])];
    });
    await batchUpsert(client, {
      table: 'gst_invoices',
      columns: ['tenant_id', 'invoice_type', 'order_id', 'cgst', 'sgst', 'igst', 'taxable_value', 'invoice_date', 'raw', 'source_key'],
      conflictColumns: ['tenant_id', 'source_key'],
      updateColumns: ['invoice_type', 'order_id', 'cgst', 'sgst', 'igst', 'taxable_value', 'invoice_date', 'raw'],
      rows: batch
    });
    // Same guarantee settlement_rows already makes: distinct keys must equal
    // parsed rows, or two genuinely separate GST lines just silently became
    // one and real tax data is gone.
    const distinctKeys = new Set(batch.map(row => row[row.length - 1])).size;
    if (distinctKeys !== rows.length) {
      throw new Error(`GST invoice import would lose rows: ${rows.length} parsed but only ${distinctKeys} distinct source_key values`);
    }
    // A row with no invoice_date is stored and then invisible: every page that
    // shows GST filters by date, so it can never appear on any range. That is
    // the worst shape a failure can take here - the ledger says "1,274 rows
    // imported" and the dashboard says "No invoices yet", and both are telling
    // the truth about different things. It happened exactly that way on a live
    // account the first time Amazon's own MTR document was ever seen, because
    // its date column is named something this importer does not recognise.
    //
    // Thrown, not logged: rows that cannot be read are not an import, and
    // recording it as a success is what made this take days to find. The
    // message names the columns Amazon actually sent so the fix is one edit.
    const undated = invoiceDates.filter(date => !date).length;
    if (undated === rows.length) {
      throw new Error(
        `GST ${invoiceType.toUpperCase()} import read ${rows.length} row(s) but not one had a usable invoice date, so none of them could ever appear on a dated page. ` +
        `The date column is named something this importer does not know. Columns Amazon sent: ${Object.keys(rows[0]).join(' | ')}`
      );
    }
    if (undated) {
      console.warn(`[gst ${invoiceType}] ${undated} of ${rows.length} row(s) have no invoice date and will not appear on any date range`);
    }
    // The MTR carries its own checksum and it is worth using, for the same
    // reason the settlement importer uses Amazon's stamped total: cgst + sgst
    // + igst must equal "Total Tax Amount" on every row, so a tax column this
    // code does not know about shows up as a discrepancy instead of as a
    // quietly smaller GST figure. Verified against a real file: the two rows
    // with real values balance to the paisa.
    //
    // Reported, not thrown. A mismatch means the stored tax is short, which is
    // wrong and worth saying loudly - but refusing the whole import would also
    // deny the seller the taxable values and dates in the same file, which are
    // independently correct. The settlement importer throws because a dropped
    // settlement line is unrecoverable; a GST row can simply be re-imported
    // once the column is mapped.
    const taxMismatches = rows.reduce((count, row, index) => {
      const stated = pick(row, ['total tax amount', 'total-tax-amount']);
      if (stated == null) return count;
      const components = batch[index][3] + batch[index][4] + batch[index][5];
      return Math.abs(round2(components - number(stated))) > 0.01 ? count + 1 : count;
    }, 0);
    if (taxMismatches) {
      console.warn(`[gst ${invoiceType}] ${taxMismatches} of ${rows.length} row(s) have cgst+sgst+igst not matching the file's own Total Tax Amount - a tax column is being missed, so stored GST is short for those rows`);
    }
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
// Amazon names the returned-unit column differently across return report
// generations and between FBA and seller-fulfilled returns, and pick() only
// matches names it is given. A name we do not list arrives as a null quantity,
// which used to blank Net Qty and Return Rate entirely.
const RETURN_QUANTITY_FIELDS = Object.freeze(['quantity', 'quantity-returned', 'return quantity', 'return-quantity', 'returnQuantity', 'quantity-shipped', 'units', 'unit-count', 'item-quantity']);

async function saveReturns(tenantId, content) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', content));
  const ordinals = ordinalsWithinGroup(rows, row => text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId'])));
  await withTenantTransaction(tenantId, async client => {
    const batch = rows.map((row, rowIndex) => [tenantId, text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId'])), text(pick(row, ['reason', 'return-reason', 'return reason', 'returnReason'])), text(pick(row, ['disposition', 'detailed-disposition', 'detailed disposition'])), 'yet_to_receive', text(pick(row, ['return-date', 'return date', 'returnDate', 'date'])) ?? null, pick(row, RETURN_QUANTITY_FIELDS) == null ? null : integer(pick(row, RETURN_QUANTITY_FIELDS)), row, sourceKey(row, [pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId']), pick(row, ['return-date', 'return date', 'returnDate', 'date']), pick(row, ['reason', 'return-reason', 'return reason', 'returnReason']), pick(row, ['disposition', 'detailed-disposition', 'detailed disposition']), pick(row, ['sku', 'seller-sku', 'sellerSku']), pick(row, ['asin']), pick(row, ['license-plate-number', 'lpn']), pick(row, RETURN_QUANTITY_FIELDS), `#${ordinals[rowIndex]}`])]);
    // Same reasoning as settlement_rows: source_key, not the business
    // columns, is the deterministic identity of a source row, and is what
    // the ON CONFLICT target must actually be to update-not-error on re-sync.
    await batchUpsert(client, {
      table: 'returns',
      columns: ['tenant_id', 'order_id', 'return_reason', 'disposition', 'status', 'return_date', 'quantity', 'raw', 'source_key'],
      conflictColumns: ['tenant_id', 'source_key'],
      updateColumns: ['order_id', 'return_reason', 'disposition', 'status', 'return_date', 'quantity', 'raw'],
      rows: batch
    });
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
async function saveReimbursements(tenantId, content) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_FBA_REIMBURSEMENTS_DATA', content));
  const ordinals = ordinalsWithinGroup(rows, row => text(pick(row, ['reimbursement-id', 'reimbursement id', 'approval-date', 'reimbursement-date'])));
  await withTenantTransaction(tenantId, async client => {
    // 'amount total', 'merchant sku' are the columns a real Seller Central
    // "Fulfillment by Amazon Reports > Reimbursements" download uses for
    // these - reversed word order from the API's 'total-amount', and a
    // different name entirely from 'seller-sku'. Caught from the report's
    // own column headers before any upload, same pattern as the GST 'Tax
    // Exclusive Gross' fix. 'date' is deliberately last/lowest-priority in
    // each list - it's the only date column this report has, but "date" is
    // generic enough that a more specific candidate should always win first
    // if one exists.
    const batch = rows.map((row, rowIndex) => {
      const amount = number(pick(row, ['amount', 'total-amount', 'total amount', 'reimbursement amount', 'amount total']));
      const reason = text(pick(row, ['reason', 'reason-code', 'reason code', 'approval-reason']));
      const sku = text(pick(row, ['sku', 'seller-sku', 'seller sku', 'merchant sku', 'merchant-sku']));
      const reimbursementDate = text(pick(row, ['reimbursement-date', 'reimbursement date', 'approval-date', 'approval date', 'date'])) ?? null;
      return [tenantId, amount, reason, sku, reimbursementDate, sourceKey(row, [sku, reimbursementDate, amount, reason,
        pick(row, ['reimbursement-id', 'reimbursement id', 'reimbursementId']),
        pick(row, ['case-id', 'case id', 'caseId']),
        pick(row, ['amazon-order-id', 'order-id', 'order id']),
        pick(row, ['fnsku']), pick(row, ['asin']),
        pick(row, ['quantity-reimbursed-total', 'quantity-reimbursed-cash', 'quantity']),
        `#${ordinals[rowIndex]}`])];
    });
    await batchUpsert(client, {
      table: 'reimbursements',
      columns: ['tenant_id', 'amount', 'reason', 'sku', 'reimbursement_date', 'source_key'],
      rows: batch
    });
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
async function saveInventorySnapshots(tenantId, content) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', content));
  const snapshotDate = new Date().toISOString().slice(0, 10);
  await withTenantTransaction(tenantId, async client => {
    const batch = rows
      .map(row => [row, text(pick(row, ['sku', 'seller-sku', 'seller sku']))])
      .filter(([, sku]) => sku)
      .map(([row, sku]) => [tenantId, sku, integer(pick(row, ['fulfillable-quantity', 'fulfillable quantity', 'afn-fulfillable-quantity', 'afn fulfillable quantity', 'quantity'])), snapshotDate]);
    await batchUpsert(client, {
      table: 'inventory_snapshots',
      columns: ['tenant_id', 'sku', 'fulfillable_quantity', 'snapshot_date'],
      conflictColumns: ['tenant_id', 'sku', 'snapshot_date'],
      updateColumns: ['fulfillable_quantity'],
      rows: batch
    });
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
async function saveSalesTrafficDaily(tenantId, content, range) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_SALES_AND_TRAFFIC_REPORT', content));
  const fallbackDate = range?.start ? new Date(range.start).toISOString().slice(0, 10) : null;
  await withTenantTransaction(tenantId, async client => {
    const batch = rows
      .map(row => [row, text(pick(row, ['date', 'startDate', 'start-date'])) ?? fallbackDate])
      .filter(([, date]) => date)
      .map(([row, date]) => [tenantId, date, text(pick(row, ['asin', 'parentAsin', 'parent-asin', 'childAsin', 'child-asin'])) ?? 'ALL', integer(pick(row, ['sessions', 'sessionsTotal'])), integer(pick(row, ['pageViews', 'page-views', 'page views', 'pageViewsTotal'])), integer(pick(row, ['unitsOrdered', 'units-ordered', 'units ordered'])), number(pick(row, ['orderedProductSales.amount', 'salesByDate.orderedProductSales.amount', 'salesByAsin.orderedProductSales.amount', 'orderedProductSales', 'ordered-product-sales', 'ordered product sales', 'orderedProductSalesAmount', 'amount'])), number(pick(row, ['featuredOfferPercentage', 'featured-offer-percentage', 'featured offer percentage', 'buyBoxPercentage'])), integer(pick(row, ['unitsRefunded', 'units-refunded', 'units refunded'])), number(pick(row, ['shippedProductSales', 'shipped-product-sales', 'shipped product sales', 'shippedProductSalesAmount'])), number(pick(row, ['orderedProductSalesB2B.amount', 'salesByDate.orderedProductSalesB2B.amount', 'salesByAsin.orderedProductSalesB2B.amount', 'orderedProductSalesB2B', 'ordered-product-sales-b2b', 'ordered product sales b2b', 'orderedProductSalesB2BAmount'])), integer(pick(row, ['unitsOrderedB2B', 'units-ordered-b2b', 'units ordered b2b'])), integer(pick(row, ['totalOrderItems', 'total-order-items', 'total order items'])), integer(pick(row, ['totalOrderItemsB2B', 'total-order-items-b2b', 'total order items b2b'])), number(pick(row, ['averageSalesPerOrderItem.amount', 'salesByDate.averageSalesPerOrderItem.amount', 'salesByAsin.averageSalesPerOrderItem.amount', 'averageSalesPerOrderItem', 'average-sales-per-order-item', 'average sales per order item'])), number(pick(row, ['averageSalesPerOrderItemB2B.amount', 'salesByDate.averageSalesPerOrderItemB2B.amount', 'salesByAsin.averageSalesPerOrderItemB2B.amount', 'averageSalesPerOrderItemB2B', 'average-sales-per-order-item-b2b', 'average sales per order item b2b'])), number(pick(row, ['averageUnitsPerOrderItem', 'average-units-per-order-item', 'average units per order item'])), number(pick(row, ['averageUnitsPerOrderItemB2B', 'average-units-per-order-item-b2b', 'average units per order item b2b'])), number(pick(row, ['averageSellingPrice.amount', 'salesByDate.averageSellingPrice.amount', 'salesByAsin.averageSellingPrice.amount', 'averageSellingPrice', 'average-selling-price', 'average selling price'])), row]);
    await batchUpsert(client, {
      table: 'sales_traffic_daily',
      columns: ['tenant_id', 'date', 'asin', 'sessions', 'page_views', 'units_ordered', 'ordered_product_sales', 'featured_offer_percentage', 'units_refunded', 'shipped_product_sales', 'ordered_product_sales_b2b', 'units_ordered_b2b', 'total_order_items', 'total_order_items_b2b', 'average_sales_per_order_item', 'average_sales_per_order_item_b2b', 'average_units_per_order_item', 'average_units_per_order_item_b2b', 'average_selling_price', 'raw'],
      conflictColumns: ['tenant_id', 'date', 'asin'],
      updateColumns: ['sessions', 'page_views', 'units_ordered', 'ordered_product_sales', 'featured_offer_percentage', 'units_refunded', 'shipped_product_sales', 'ordered_product_sales_b2b', 'units_ordered_b2b', 'total_order_items', 'total_order_items_b2b', 'average_sales_per_order_item', 'average_sales_per_order_item_b2b', 'average_units_per_order_item', 'average_units_per_order_item_b2b', 'average_selling_price', 'raw'],
      rows: batch
    });
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} reportType @param {string} content */
export async function saveStructuredRows(tenantId, reportType, content, range) {
  switch (reportType) {
    case 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2': return saveSettlementRows(tenantId, content).then(result => result.parsed);
    case 'GET_GST_MTR_B2B_CUSTOM': return saveGstInvoices(tenantId, content, 'b2b');
    case 'GET_GST_MTR_B2C_CUSTOM': return saveGstInvoices(tenantId, content, 'b2c');
    case 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA': return saveReturns(tenantId, content);
    case 'GET_FBA_REIMBURSEMENTS_DATA': return saveReimbursements(tenantId, content);
    case 'GET_SALES_AND_TRAFFIC_REPORT': return saveSalesTrafficDaily(tenantId, content, range);
    case 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA': return saveInventorySnapshots(tenantId, content);
    default: return 0;
  }
}

/** @param {{ tenantId: string, reportType: string, range?: { start: string, end: string } }} params */
export async function syncReportForTenant(params) {
  const parsed = SyncParamsSchema.parse(params);
  const range = parsed.range ?? { start: new Date(Date.now() - 30 * 864e5).toISOString(), end: new Date().toISOString() };
  await assertActiveTenant(parsed.tenantId);
  // A report request creates a remote Amazon job. Retrying this whole block can
  // create duplicate remote reports and keep the ledger running for 45+ minutes.
  // The SP-API client already retries throttled HTTP calls, so execute each
  // user-triggered report job only once.
  return runJob(`sync:${parsed.reportType}:${parsed.tenantId}`, async () => {
    const startedAt = Date.now();
    const logLabel = `sync ${parsed.tenantId.slice(0, 8)}:${parsed.reportType}`;
    console.log(`[${logLabel}] starting (range ${range.start} to ${range.end})`);
    const sync = await pool.query('insert into sync_jobs(tenant_id, report_type, status, started_at, range_start, range_end) values($1,$2,$3,now(),$4,$5) returning id', [parsed.tenantId, parsed.reportType, 'running', range.start, range.end]);
    try {
      const seller = await pool.query("select refresh_token_encrypted, marketplace_id from sellers where tenant_id = $1 and auth_status = 'authorized' order by connected_at desc limit 1", [parsed.tenantId]);
      if (!seller.rowCount) throw new Error('No connected Amazon seller account');
      const client = new SpApiClient(decryptSecret(seller.rows[0].refresh_token_encrypted), { baseUrl: getSpApiEndpoint(seller.rows[0].marketplace_id), label: logLabel });
      // Settlement report documents are immutable once generated - skip any
      // this tenant has already downloaded and saved, so a long settlement
      // history doesn't get re-fetched in full on every sync (see fetchReport).
      const alreadyProcessed = await withTenant(parsed.tenantId, db => db.query('select report_document_id from processed_report_documents where tenant_id=$1 and report_type=$2', [parsed.tenantId, parsed.reportType]));
      const skipDocumentIds = new Set(alreadyProcessed.rows.map(row => row.report_document_id));
      const report = await client.fetchReport(parsed.reportType, parsed.tenantId, range, seller.rows[0].marketplace_id, { skipDocumentIds });
      if (report.allAlreadyProcessed) {
        console.log(`[${logLabel}] completed in ${Date.now() - startedAt}ms - all ${report.reportsAvailable} available document(s) already synced, nothing new`);
        await pool.query('update sync_jobs set status=$1, completed_at=now() where id=$2', ['completed', sync.rows[0].id]);
        return { rowsImported: 0, alreadyUpToDate: true };
      }
      const s3Key = await putRawReport({ tenantId: parsed.tenantId, reportType: parsed.reportType, reportId: report.reportId, content: report.content });
      // If saveStructuredRows throws - which it now does when a settlement
      // import would lose rows - control never reaches the line below, so the
      // documents stay unprocessed and the next sync re-downloads them. That
      // ordering is the whole point: a document recorded as processed is never
      // fetched again, so recording one whose rows were dropped makes the loss
      // permanent and unrecoverable by re-syncing.
      const rowsImported = await saveStructuredRows(parsed.tenantId, parsed.reportType, report.content, range);
      if (report.documentIds?.length) {
        await withTenantTransaction(parsed.tenantId, db => batchUpsert(db, {
          table: 'processed_report_documents',
          columns: ['tenant_id', 'report_document_id', 'report_type'],
          rows: report.documentIds.map(documentId => [parsed.tenantId, documentId, parsed.reportType])
        }));
      }
      const outstandingDocuments = report.reportsTruncated
        ? (report.reportsOutstanding ?? report.reportsAvailable - (report.reportsMerged ?? 0))
        : 0;
      console.log(`[${logLabel}] completed in ${Date.now() - startedAt}ms - ${rowsImported} rows imported from ${report.reportsMerged ?? 0} of ${report.reportsAvailable} document(s) Amazon has for this range` + (outstandingDocuments ? ` - ${outstandingDocuments} STILL OUTSTANDING, figures are incomplete until they are fetched` : ''));
      // A truncated sync fetched only part of what Amazon has, so it must not
      // be recorded as a sync that covers this range. It used to be stored
      // with the full range and status 'completed', which made
      // findReusableSync treat the range as fully synced for the next hour -
      // so the remaining documents were not fetched, the backlog drained at
      // best one capped batch per hour, and the dashboard showed money
      // computed from a partial settlement history with nothing to indicate
      // it. Leaving the range null keeps the job visible in the ledger while
      // letting the next dashboard load pick up where this one stopped;
      // already-processed documents are skipped, so it converges instead of
      // re-fetching, and the in-flight and backoff guards bound the traffic.
      await pool.query(
        outstandingDocuments
          ? 'update sync_jobs set status=$1, completed_at=now(), s3_key=$2, range_start=null, range_end=null, error_message=$4 where id=$3'
          : 'update sync_jobs set status=$1, completed_at=now(), s3_key=$2 where id=$3',
        outstandingDocuments
          ? ['completed', s3Key, sync.rows[0].id, `Partial: ${outstandingDocuments} settlement document(s) still to fetch`]
          : ['completed', s3Key, sync.rows[0].id]
      );
      return { rowsImported, s3Key, documentsMerged: report.reportsMerged ?? 0, documentsAvailable: report.reportsAvailable, outstandingDocuments };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`[${logLabel}] failed after ${Date.now() - startedAt}ms: ${message}`);
      await pool.query('update sync_jobs set status=$1, completed_at=now(), error_message=$2 where id=$3', ['failed', message, sync.rows[0].id]);
      throw error;
    }
  }, 1);
}


// Settlements/Sales & Traffic/Inventory/Reimbursements all fall back to this
// same direct-API sync whenever their own Amazon report isn't ready, and the
// base Orders & Finance sync calls it directly too - so a user (or the sync
// ledger) can easily trigger two or three of these for the same tenant
// within seconds of each other. Nothing previously stopped them running
// concurrently: they'd both hit Amazon's per-account rate limits at once,
// each slowing (and 429-ing) the other, which is consistent with jobs
// sitting in 'running' well past when a single sync would finish. Queue
// same-tenant calls instead so only one is ever in flight against Amazon.
const tenantSyncMutex = new Map();
export function withTenantSyncMutex(tenantId, fn) {
  const previous = tenantSyncMutex.get(tenantId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  tenantSyncMutex.set(tenantId, run.catch(() => undefined));
  return run;
}

/** @param {string} tenantId @param {{ days?: number }} [options] */
export function syncRecentApiDataForTenant(tenantId, options = {}) {
  return withTenantSyncMutex(tenantId, () => syncRecentApiDataForTenantDirect(tenantId, options));
}

async function syncRecentApiDataForTenantDirect(tenantId, options = {}) {
  const parsedTenantId = z.string().uuid().parse(tenantId);
  const range = options.range ? z.object({ start: z.string().datetime(), end: z.string().datetime() }).parse(options.range) : null;
  const defaultCreatedAfter = range ? new Date(range.start) : new Date(Date.now() - (options.days ?? 30) * 864e5);
  const lastCompletedSync = (await pool.query(
    `select completed_at from sync_jobs
     where tenant_id=$1 and report_type='DIRECT_SP_API_SYNC' and status='completed' and completed_at is not null
     order by completed_at desc limit 1`,
    [parsedTenantId]
  )).rows[0]?.completed_at;
  const incrementalCreatedAfter = lastCompletedSync ? new Date(new Date(lastCompletedSync).getTime() - 5 * 60 * 1000) : defaultCreatedAfter;
  const createdAfterDate = range || options.full ? defaultCreatedAfter : new Date(Math.max(defaultCreatedAfter.getTime(), incrementalCreatedAfter.getTime()));
  const createdAfter = createdAfterDate.toISOString();
  const safeNow = new Date(Date.now() - 2 * 60 * 1000);
  const requestedCreatedBefore = range ? new Date(range.end) : safeNow;
  const createdBefore = new Date(Math.min(requestedCreatedBefore.getTime(), safeNow.getTime())).toISOString();
  const includeOrders = options.includeOrders ?? true;
  const includeFinance = options.includeFinance ?? true;
  const includeInventory = options.includeInventory ?? true;
  const maxOrderPages = Math.max(1, Math.min(Number(options.maxOrderPages ?? 100), 100));
  const maxOrderItems = Math.max(0, Math.min(Number(options.maxOrderItems ?? 1000), 1000));
  await assertActiveTenant(parsedTenantId);
  return runJob(`sync:direct-api:${parsedTenantId}`, async () => {
    const startedAt = Date.now();
    const logLabel = `sync ${parsedTenantId.slice(0, 8)}:DIRECT_SP_API_SYNC`;
    console.log(`[${logLabel}] starting (createdAfter=${createdAfter}, createdBefore=${createdBefore})`);
    const sync = await pool.query('insert into sync_jobs(tenant_id, report_type, status, started_at, range_start, range_end) values($1,$2,$3,now(),$4,$5) returning id', [parsedTenantId, 'DIRECT_SP_API_SYNC', 'running', range?.start ?? null, range?.end ?? null]);
    try {
      const seller = await pool.query("select refresh_token_encrypted, marketplace_id from sellers where tenant_id = $1 and auth_status = 'authorized' order by connected_at desc limit 1", [parsedTenantId]);
      if (!seller.rowCount) throw new Error('No connected Amazon seller account');
      const marketplaceId = seller.rows[0].marketplace_id;
      const client = new SpApiClient(decryptSecret(seller.rows[0].refresh_token_encrypted), { baseUrl: getSpApiEndpoint(marketplaceId), label: logLabel });
      let ordersWarning;
      const orderPages = [];
      if (includeOrders) {
        try {
          let ordersResponse = await client.listOrders(createdAfter, marketplaceId, createdBefore);
          orderPages.push(ordersResponse);
          for (let page = 1; page < maxOrderPages; page += 1) {
            const nextToken = ordersResponse?.payload?.NextToken ?? ordersResponse?.NextToken;
            if (!nextToken) break;
            ordersResponse = await client.listOrdersByNextToken(nextToken);
            orderPages.push(ordersResponse);
          }
        } catch (error) {
          ordersWarning = error instanceof Error ? error.message : 'Orders sync failed';
        }
      }
      const orders = orderPages.flatMap(page => page?.payload?.Orders ?? page?.Orders ?? []);
      // A shipped order is often posted to Transaction View days after its
      // purchase date. Extend only the finance window so selecting Jul 1–2 can
      // still retrieve Amazon's Jul 10 payment for those orders.
      const financeBefore = range ? new Date(Math.min(safeNow.getTime(), new Date(range.end).getTime() + 45 * 864e5)).toISOString() : createdBefore;
      let financeResponse = includeFinance ? await client.listFinanceTransactions(createdAfter, financeBefore).catch(error => ({ syncError: error instanceof Error ? error.message : 'Finance sync failed' })) : null;
      const financePages = financeResponse ? [financeResponse] : [];
      const financeTokens = new Set();
      for (let page = 1; includeFinance && page < 100; page += 1) {
        const nextToken = financeResponse?.payload?.nextToken ?? financeResponse?.nextToken ?? financeResponse?.payload?.NextToken ?? financeResponse?.NextToken;
        if (!nextToken || financeTokens.has(nextToken)) break;
        financeTokens.add(nextToken);
        financeResponse = await client.listFinanceTransactions(undefined, undefined, nextToken).catch(error => ({ syncError: error instanceof Error ? error.message : 'Finance pagination failed' }));
        financePages.push(financeResponse);
        if (financeResponse.syncError) break;
      }
      const transactions = financePages.flatMap(page => page?.payload?.transactions ?? page?.transactions ?? page?.payload?.Transactions ?? page?.Transactions ?? []);
      const inventoryResponse = includeInventory ? await client.listInventorySummaries(marketplaceId).catch(error => ({ syncError: error instanceof Error ? error.message : 'Inventory sync failed' })) : null;
      const inventorySummaries = inventoryResponse?.payload?.inventorySummaries ?? inventoryResponse?.inventorySummaries ?? [];
      const snapshotDate = new Date().toISOString().slice(0, 10);
      let ordersImported = 0;
      let transactionsImported = 0;
      let inventoryImported = 0;
      let reimbursementsImported = 0;
      let orderItemsSkipped = 0;
      let catalogItemsImported = 0;
      const catalogCache = new Map();
      // A 403 from the Catalog Items API means this app's SP-API
      // authorization does not include catalog access for this account -
      // that is an Amazon-side permission grant, not a transient failure,
      // and retrying it will never succeed. Once seen, stop spending any
      // more of this run's calls on catalog lookups that are guaranteed to
      // fail the same way.
      let catalogAccessDenied = false;
      const fetchCatalogItem = async asin => {
        if (catalogAccessDenied) return { unavailable: true };
        try {
          const catalog = await client.getCatalogItem(asin, marketplaceId);
          catalogItemsImported += 1;
          return catalog;
        } catch (error) {
          if (error instanceof Error && /\b403\b/.test(error.message)) catalogAccessDenied = true;
          return { unavailable: true };
        }
      };
      await withTenant(parsedTenantId, async db => {
        // Orders/items themselves are cheap to batch; what genuinely must
        // stay sequential is the per-order Order Items API call and the
        // per-ASIN Catalog Items API call, since both are real, rate-limited
        // network requests to Amazon, not database writes. So this loop only
        // fetches from Amazon and collects rows - every DB write is issued
        // once, in batches, after the loop instead of once per row inside it.
        const orderRows = [];
        const orderItemRows = [];
        let orderItemsFetched = 0;
        for (const order of orders) {
          const orderId = order.AmazonOrderId ?? order.amazonOrderId;
          if (!orderId) continue;
          orderRows.push([parsedTenantId, orderId, order.PurchaseDate ?? order.purchaseDate ?? null, number(order.OrderTotal?.Amount ?? order.orderTotal?.amount), order.OrderStatus ?? order.orderStatus ?? null, order.FulfillmentChannel ?? order.fulfillmentChannel ?? null, order.SalesChannel ?? order.salesChannel ?? null, order]);
          ordersImported += 1;
          const existingItems = await db.query('select 1 from order_items where tenant_id=$1 and amazon_order_id=$2 limit 1', [parsedTenantId, orderId]);
          if (existingItems.rowCount) {
            orderItemsSkipped += 1;
            continue;
          }
          if (orderItemsFetched >= maxOrderItems) {
            orderItemsSkipped += 1;
            continue;
          }
          const itemsResponse = await client.listOrderItems(orderId).catch(() => undefined);
          orderItemsFetched += 1;
          const items = itemsResponse?.payload?.OrderItems ?? itemsResponse?.OrderItems ?? [];
          for (const item of items) {
            const asin = item.ASIN ?? item.asin ?? null;
            let catalog = asin ? catalogCache.get(asin) : null;
            if (asin && !catalogCache.has(asin)) {
              catalog = await fetchCatalogItem(asin);
              catalogCache.set(asin, catalog);
            }
            const shipping = catalogShippingFacts(catalog?.unavailable ? null : catalog);
            const sku = item.SellerSKU ?? item.sellerSku ?? null;
            const orderItemId = item.OrderItemId ?? item.orderItemId ?? null;
            orderItemRows.push([parsedTenantId, orderId, asin, sku, item.Title ?? item.title ?? null, integer(item.QuantityOrdered ?? item.quantityOrdered), number(item.ItemPrice?.Amount ?? item.itemPrice?.amount), number(item.ItemTax?.Amount ?? item.itemTax?.amount), number(item.PromotionDiscount?.Amount ?? item.promotionDiscount?.amount), item, shipping.weight || null, shipping.weightUnit ?? null, shipping.dimensions, catalog ?? {}, sourceKey({}, [orderId, orderItemId, sku, asin])]);
          }
        }
        await batchUpsert(db, {
          table: 'orders',
          columns: ['tenant_id', 'amazon_order_id', 'order_date', 'total_amount', 'status', 'fulfillment_channel', 'sales_channel', 'raw'],
          conflictColumns: ['tenant_id', 'amazon_order_id'],
          updateColumns: ['order_date', 'total_amount', 'status', 'fulfillment_channel', 'sales_channel', 'raw'],
          rows: orderRows
        });
        // source_key (order_id + order-item-id + sku + asin) is the real,
        // always-non-null identity of a line item. sku/asin alone can both
        // be null for the same order (e.g. bundle components), and Postgres
        // never treats two NULLs as a match, so a (tenant_id, amazon_order_id,
        // sku, asin) conflict target could insert duplicate rows for those
        // instead of updating the existing one.
        await batchUpsert(db, {
          table: 'order_items',
          columns: ['tenant_id', 'amazon_order_id', 'asin', 'sku', 'title', 'quantity_ordered', 'item_price', 'item_tax', 'promotion_discount', 'raw', 'package_weight', 'weight_unit', 'package_dimensions', 'catalog_raw', 'source_key'],
          conflictColumns: ['tenant_id', 'source_key'],
          updateColumns: ['amazon_order_id', 'asin', 'sku', 'title', 'quantity_ordered', 'item_price', 'item_tax', 'promotion_discount', 'raw', 'package_weight', 'weight_unit', 'package_dimensions', 'catalog_raw'],
          rows: orderItemRows
        });
        // Backfill catalog facts for previously imported order items as well;
        // otherwise only brand-new orders would ever receive shipping weight.
        // catalog_raw='{}' distinguishes "never attempted" from "attempted
        // and Amazon denied it" (stored as {unavailable:true} below) - without
        // that distinction this query would re-select, and re-attempt, the
        // exact same permission-denied ASINs on every single future sync.
        const missingCatalogItems = (await db.query(
          `select distinct asin from order_items
           where tenant_id=$1 and asin is not null and package_weight is null and catalog_raw = '{}'::jsonb
           limit 25`,
          [parsedTenantId]
        )).rows;
        for (const { asin } of missingCatalogItems) {
          let catalog = catalogCache.get(asin);
          if (!catalogCache.has(asin)) {
            catalog = await fetchCatalogItem(asin);
            catalogCache.set(asin, catalog);
          }
          if (catalog?.unavailable) {
            await db.query('update order_items set catalog_raw=$3 where tenant_id=$1 and asin=$2', [parsedTenantId, asin, catalog]);
            continue;
          }
          const shipping = catalogShippingFacts(catalog);
          await db.query(
            `update order_items set package_weight=$3, weight_unit=$4, package_dimensions=$5, catalog_raw=$6
             where tenant_id=$1 and asin=$2`,
            [parsedTenantId, asin, shipping.weight || null, shipping.weightUnit ?? null, shipping.dimensions, catalog]
          );
        }
        const inventoryRows = inventorySummaries
          .map(summary => [summary, summary.sellerSku ?? summary.SellerSKU ?? summary.sellerSKU])
          .filter(([, sku]) => sku)
          .map(([summary, sku]) => [parsedTenantId, sku, integer(summary.inventoryDetails?.fulfillableQuantity ?? summary.InventoryDetails?.FulfillableQuantity ?? summary.fulfillableQuantity ?? summary.FulfillableQuantity), snapshotDate]);
        inventoryImported = await batchUpsert(db, {
          table: 'inventory_snapshots',
          columns: ['tenant_id', 'sku', 'fulfillable_quantity', 'snapshot_date'],
          conflictColumns: ['tenant_id', 'sku', 'snapshot_date'],
          updateColumns: ['fulfillable_quantity'],
          rows: inventoryRows
        });
        // flattenFinanceTransaction is pure CPU work (no network/DB calls),
        // so every transaction can be flattened up front and every resulting
        // write batched, instead of one delete + N inserts per transaction.
        const financeTransactionRows = [];
        const financeTransactionIds = [];
        const financeItemRows = [];
        const reimbursementRows = [];
        for (const transaction of transactions) {
          const transactionId = transaction.transactionId ?? transaction.TransactionId ?? transaction.financialEventGroupId ?? transaction.FinancialEventGroupId;
          if (!transactionId) continue;
          financeTransactionRows.push([parsedTenantId, transactionId, transaction.transactionType ?? transaction.TransactionType ?? null, transaction.postedDate ?? transaction.PostedDate ?? null, number(transaction.totalAmount?.currencyAmount ?? transaction.TotalAmount?.CurrencyAmount ?? transaction.totalAmount?.Amount ?? transaction.TotalAmount?.Amount), transaction.totalAmount?.currencyCode ?? transaction.TotalAmount?.CurrencyCode ?? 'INR', financeRelatedValue(transaction, ['ORDER_ID', 'AMAZON_ORDER_ID']) ?? null, transaction]);
          financeTransactionIds.push(transactionId);
          // Finances API field casing and nested breakdown names can vary by
          // generation. Persist every source node in raw so classifications
          // that land in `other` can be inspected and improved safely.
          const components = flattenFinanceTransaction(transaction);
          for (const component of components) {
            financeItemRows.push([parsedTenantId, component.transactionId, component.orderId ?? null, component.sku ?? null, component.asin ?? null, component.category, component.description ?? null, component.amount, component.currency ?? 'INR', component.postedDate, component.raw, sourceKey({}, [component.transactionId, component.orderId, component.sku, component.category, component.description, component.amount, component.postedDate])]);
          }
          transactionsImported += 1;
          // transactionType only ever documents "Shipment" as a value - it is
          // a structural field, not a reason. Reimbursement events (SAFE-T,
          // lost/damaged inventory, etc.) are only identifiable by their
          // description/breakdown label, which flattenFinanceTransaction
          // already categorizes correctly via the same rules used everywhere
          // else in the app. Reuse that instead of re-deriving it here from a
          // field that can't actually carry the signal.
          for (const component of components.filter(row => row.category === 'reimbursement')) {
            reimbursementRows.push([parsedTenantId, component.amount, component.description ?? 'Finance reimbursement', component.sku ?? component.orderId ?? transactionId, component.postedDate ?? transaction.postedDate ?? transaction.PostedDate ?? null]);
          }
        }
        // finance_transaction_items is refreshed by deleting a transaction's
        // rows and re-inserting them. Outside a transaction those are separate
        // autocommitted statements, so any dashboard request landing between
        // the delete and the insert reads a table with rows missing and
        // silently reports wrong money for the duration of the sync. Observed
        // live on one tenant and date range across consecutive renders: 4038
        // finance rows, then 1426, then 4038 again. All of it is pure DB work
        // with no Amazon calls in between, so one short transaction makes the
        // refresh atomic without holding a connection across the network.
        await withTenantTransaction(parsedTenantId, async tx => {
          await batchUpsert(tx, {
            table: 'finance_transactions',
            columns: ['tenant_id', 'transaction_id', 'transaction_type', 'posted_date', 'total_amount', 'currency', 'related_order_id', 'raw'],
            conflictColumns: ['tenant_id', 'transaction_id'],
            updateColumns: ['transaction_type', 'posted_date', 'total_amount', 'currency', 'related_order_id', 'raw'],
            rows: financeTransactionRows
          });
          if (financeTransactionIds.length) await tx.query('delete from finance_transaction_items where tenant_id=$1 and transaction_id = any($2::text[])', [parsedTenantId, financeTransactionIds]);
          await batchUpsert(tx, {
            table: 'finance_transaction_items',
            columns: ['tenant_id', 'transaction_id', 'order_id', 'sku', 'asin', 'category', 'amount_description', 'amount', 'currency', 'posted_date', 'raw', 'source_key'],
            rows: financeItemRows
          });
          reimbursementsImported = await batchUpsert(tx, {
            table: 'reimbursements',
            columns: ['tenant_id', 'amount', 'reason', 'sku', 'reimbursement_date'],
            rows: reimbursementRows
          });
        });
      });
      console.log(`[${logLabel}] completed in ${Date.now() - startedAt}ms - ${ordersImported} orders, ${transactionsImported} finance transactions, ${inventoryImported} inventory rows, ${reimbursementsImported} reimbursements` + (ordersWarning ? ` (orders warning: ${ordersWarning})` : '') + (financeResponse?.syncError ? ` (finance warning: ${financeResponse.syncError})` : '') + (inventoryResponse?.syncError ? ` (inventory warning: ${inventoryResponse.syncError})` : ''));
      await pool.query('update sync_jobs set status=$1, completed_at=now() where id=$2', ['completed', sync.rows[0].id]);
      return { ordersImported, transactionsImported, inventoryImported, reimbursementsImported, catalogItemsImported, orderItemsSkipped, incrementalSince: createdAfter, incrementalUntil: createdBefore, ordersWarning, financeWarning: financeResponse?.syncError, inventoryWarning: inventoryResponse?.syncError };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`[${logLabel}] failed after ${Date.now() - startedAt}ms: ${message}`);
      await pool.query('update sync_jobs set status=$1, completed_at=now(), error_message=$2 where id=$3', ['failed', message, sync.rows[0].id]);
      throw error;
    }
  }, 1);
}


/** @param {string} tenantId @param {'b2b'|'b2c'} invoiceType */
export async function buildGstInvoicesFromOrderItems(tenantId, invoiceType) {
  const parsedTenantId = z.string().uuid().parse(tenantId);
  const parsedInvoiceType = z.enum(['b2b', 'b2c']).parse(invoiceType);
  await assertActiveTenant(parsedTenantId);
  return withTenant(parsedTenantId, async db => {
    // source_key here mirrors this query's own GROUP BY exactly (order_id +
    // invoice_type + date) rather than the per-shipment-item identity
    // saveGstInvoices now uses - this fallback already aggregates every
    // item on an order into one row per order+day, so that coarser grain is
    // its real, correct identity, not a bug to fix. It just needs to be
    // deterministic (same order+type+day always hashes the same way) so a
    // re-run updates the existing estimate instead of duplicating it. Must
    // target (tenant_id, source_key) now, not the old composite key - that
    // unique constraint no longer exists on this table (see
    // 024_gst_invoices_source_key.sql), so the previous ON CONFLICT target
    // here would fail outright on every call once that migration runs.
    const result = await db.query(
      `insert into gst_invoices(tenant_id, invoice_type, order_id, taxable_value, cgst, sgst, igst, invoice_date, source_key)
       select oi.tenant_id,
         $2,
         oi.amazon_order_id,
         sum(greatest(coalesce(oi.item_price,0) - coalesce(oi.item_tax,0), 0)) taxable_value,
         sum(coalesce(oi.item_tax,0) / 2) cgst,
         sum(coalesce(oi.item_tax,0) / 2) sgst,
         0 igst,
         date(coalesce(o.order_date, now())) invoice_date,
         encode(digest(oi.amazon_order_id || '|' || $2 || '|' || date(coalesce(o.order_date, now()))::text, 'sha256'), 'hex') source_key
       from order_items oi
       left join orders o on o.tenant_id=oi.tenant_id and o.amazon_order_id=oi.amazon_order_id
       where oi.tenant_id=$1
       group by oi.tenant_id, oi.amazon_order_id, date(coalesce(o.order_date, now()))
       on conflict (tenant_id, source_key) do update set
         taxable_value=excluded.taxable_value,
         cgst=excluded.cgst,
         sgst=excluded.sgst,
         igst=excluded.igst`,
      [parsedTenantId, parsedInvoiceType]
    );
    return result.rowCount ?? 0;
  });
}

// The one-time 90-day catch-up run right after a seller authorizes. Amazon
// retains report documents for a maximum of 90 days (confirmed against the
// official SP-API getReports reference - "Reports are retained for a
// maximum of 90 days" - and against a real settlement 400 hit trying to ask
// for more), so the moment of authorization is the only chance this history
// is ever reachable; the nightly scheduler (startScheduler, below) keeps
// everything current from here on, so this function only has one job to do,
// once, per seller.
//
// Every source is synced ONE AT A TIME, never in parallel - this keeps the
// traffic pattern against Amazon identical to a seller manually clicking
// Sync eight times over a few minutes, which the app already does safely
// today; nothing here asks Amazon for more than that, just in one
// automatic pass instead of eight manual ones. A source that comes back
// truncated (a 90-day settlement history can span more documents than one
// call fetches) is re-run in place until Amazon has nothing left for this
// window, using the exact same convergence signal (outstandingDocuments)
// the demand-driven per-page sync already relies on - only here an
// unattended loop drives it instead of repeated dashboard loads. A source
// Amazon refuses outright (a missing SP-API role, exactly like the Brand
// Analytics 403 hit on GET_SALES_AND_TRAFFIC_REPORT) is recorded failed and
// skipped rather than aborting the other seven.
const INITIAL_BACKFILL_DAYS = 90;
const INITIAL_BACKFILL_MAX_ATTEMPTS_PER_SOURCE = 20;
const INITIAL_BACKFILL_REPORT_TYPES = [
  'DIRECT_SP_API_SYNC',
  'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
  'GET_SALES_AND_TRAFFIC_REPORT',
  'GET_GST_MTR_B2B_CUSTOM',
  'GET_GST_MTR_B2C_CUSTOM',
  'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA',
  'GET_FBA_REIMBURSEMENTS_DATA',
  'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'
];
// Guards against two backfills running at once for the same tenant.
// queueInitialSellerSync fires on every OAuth callback with no await and no
// idea whether a previous run is still going - a double callback (a
// re-authorize whose redirect gets hit twice, a double-click, a browser
// retry) used to launch two full backfill loops in parallel, each
// independently calling createReport for the same report types around the
// same time. Amazon's own answer to that is to CANCEL the superseded
// request, not error it - which showed up as "Report ... CANCELLED" on
// Inventory/Reimbursements/Returns for a seller who had just re-authorized,
// with nothing about permissions wrong at all. This makes a second call for
// a tenant that's already running a no-op instead of a race.
const backfillInFlight = new Set();
export async function runInitialSellerBackfill(tenantId) {
  const parsedTenantId = z.string().uuid().parse(tenantId);
  const label = `[backfill ${parsedTenantId.slice(0, 8)}]`;
  if (backfillInFlight.has(parsedTenantId)) { console.log(`${label} skipped - already running for this tenant`); return; }
  backfillInFlight.add(parsedTenantId);
  try {
    const range = { start: new Date(Date.now() - INITIAL_BACKFILL_DAYS * 864e5).toISOString(), end: new Date().toISOString() };
    // Scoped to the CURRENT authorized seller row, not the tenant generally -
    // if the tenant reconnects a different Amazon account before this finishes,
    // progress must not be attributed to a seller row it no longer describes.
    const active = await pool.query("select id, backfill_completed_at, data_floor_date from sellers where tenant_id=$1 and auth_status='authorized' order by connected_at desc limit 1", [parsedTenantId]);
    if (!active.rowCount) { console.warn(`${label} skipped - no authorized seller found`); return; }
    const seller = active.rows[0];
    const sellerId = seller.id;

    // A RE-AUTHORIZATION IS NOT A FIRST CONNECTION, and treating it as one is
    // what made "re-authorize to pick up the Tax Invoicing role" cost a seller
    // their whole dashboard for a day. Re-authorizing ran this entire
    // eight-source, ninety-day pass again - re-fetching six sources that were
    // already stored and complete - and blocked every page in the app while it
    // did, for data the tenant already had.
    //
    // A top-up only fetches what has never successfully arrived, which is
    // exactly the set a re-authorization can newly unlock: a report Amazon was
    // refusing for a missing role has no successful sync, and every source
    // that was already working has one. If nothing qualifies, there is nothing
    // to do at all.
    const firstEver = !seller.backfill_completed_at && !seller.data_floor_date;
    let reportTypes = INITIAL_BACKFILL_REPORT_TYPES;
    if (!firstEver) {
      const succeeded = await pool.query(
        `select distinct report_type from sync_jobs
          where tenant_id=$1 and status='completed' and report_type = any($2)`,
        [parsedTenantId, INITIAL_BACKFILL_REPORT_TYPES]
      );
      const have = new Set(succeeded.rows.map(row => row.report_type));
      reportTypes = INITIAL_BACKFILL_REPORT_TYPES.filter(type => !have.has(type));
      if (!reportTypes.length) {
        console.log(`${label} skipped - every source already has data; a re-authorization does not re-fetch it`);
        return;
      }
      console.log(`${label} top-up after re-authorization - ${reportTypes.length} of ${INITIAL_BACKFILL_REPORT_TYPES.length} source(s) have never synced: ${reportTypes.join(', ')}`);
    }

    // Only a genuine first backfill sets 'running', because only that one has
    // grounds to block the dashboard: there is no data yet, so any figure
    // shown would be built from a partial range. A top-up runs against a
    // tenant that already has a full dataset, so it stays out of the way and
    // the seller keeps working while it fills the gaps in the background.
    //
    // COALESCE on data_floor_date, not a plain overwrite: a later re-backfill
    // computes a range that starts LATER than the original one, because
    // Amazon's 90-day retention is measured from "now" - so only the
    // first-ever backfill may set this floor. See 020_seller_data_floor.sql.
    await pool.query(
      firstEver
        ? "update sellers set backfill_status='running', backfill_started_at=now(), backfill_heartbeat_at=now(), backfill_progress='{}'::jsonb, data_floor_date=coalesce(data_floor_date, $2::date) where id=$1"
        : "update sellers set backfill_heartbeat_at=now(), data_floor_date=coalesce(data_floor_date, $2::date) where id=$1",
      [sellerId, range.start]
    );
    console.log(`${label} starting - ${reportTypes.length} source(s), ${INITIAL_BACKFILL_DAYS} day window`);
    const progress = {};
    // Every write here also beats the heartbeat. That is what lets a later
    // dashboard load tell "still working" from "the process died an hour ago"
    // - see 026_seller_backfill_heartbeat.sql. Without it the only signal is
    // the start time, which says nothing about whether anything is still alive.
    async function setProgress(reportType, state) {
      progress[reportType] = state;
      await pool.query('update sellers set backfill_progress=$2, backfill_heartbeat_at=now() where id=$1', [sellerId, JSON.stringify(progress)]);
    }
    const beat = () => pool.query('update sellers set backfill_heartbeat_at=now() where id=$1', [sellerId]).catch(() => undefined);
    for (const reportType of reportTypes) {
      const startedAt = Date.now();
      await setProgress(reportType, 'running');
      try {
        if (reportType === 'DIRECT_SP_API_SYNC') {
          await syncRecentApiDataForTenant(parsedTenantId, { range });
        } else {
          for (let attempt = 0; attempt < INITIAL_BACKFILL_MAX_ATTEMPTS_PER_SOURCE; attempt += 1) {
            const result = await syncReportForTenant({ tenantId: parsedTenantId, reportType, range });
            // Beat between attempts, not just between sources: settlements can
            // legitimately spend a long time here working through a long
            // history one throttled batch at a time, and a source that never
            // beats looks identical to a dead process.
            await beat();
            if (!result?.outstandingDocuments) break;
          }
        }
        await setProgress(reportType, 'completed');
        console.log(`${label} ${reportType} completed in ${Date.now() - startedAt}ms`);
      } catch (error) {
        await setProgress(reportType, 'failed');
        console.error(`${label} ${reportType} failed after ${Date.now() - startedAt}ms:`, error instanceof Error ? error.message : error);
      }
    }
    if (firstEver) {
      await pool.query("update sellers set backfill_status='completed', backfill_completed_at=now(), backfill_heartbeat_at=now() where id=$1", [sellerId]);
    } else {
      await pool.query('update sellers set backfill_heartbeat_at=now() where id=$1', [sellerId]);
    }
    console.log(`${label} finished`);
  } finally {
    backfillInFlight.delete(parsedTenantId);
  }
}

/** @param {string} reportType */
// DIRECT_SP_API_SYNC (Orders + Finances + Inventory) is not an Amazon report
// type - it is not in REPORT_TYPES/NIGHTLY_REPORTS at all - so it was never
// part of the nightly run, only synced once at connection and again
// whenever a seller happened to view a range that needed it. Every other
// figure on this dashboard is built from it, so "every day gets saved" was
// only true for the seven report-based sources; Orders/Finance activity on a
// day nobody happened to open the dashboard was not captured until someone
// eventually did. It is included here as its own branch (syncActiveTenants
// is called once per source, and this source uses a different sync
// function, not syncReportForTenant).
async function syncActiveTenants(reportType) {
  const isDirect = reportType === 'DIRECT_SP_API_SYNC';
  const parsedReportType = isDirect ? reportType : z.enum(REPORT_TYPES).parse(reportType);
  const tenants = await pool.query("select id from tenants where status = 'active'");
  const limit = pLimit(3);
  // One tenant's report failure (e.g. Amazon has no settlement report ready
  // yet for this period) must never stop every other tenant's nightly sync,
  // and must never surface as an unhandled rejection that could take the
  // whole scheduler down. Both sync functions already record the failure on
  // the tenant's own sync_jobs row, so it is safe to swallow here.
  await Promise.all(tenants.rows.map(row => limit(() =>
    (isDirect ? syncRecentApiDataForTenant(row.id, { days: 2 }) : syncReportForTenant({ tenantId: row.id, reportType: parsedReportType }))
      .catch(error => { console.error(`Nightly sync failed for tenant ${row.id} (${parsedReportType}):`, error instanceof Error ? error.message : error); })
  )));
}

// Returns the scheduled task so a caller can stop it. Without that handle the
// cron timer keeps the event loop alive forever, which is right for a server
// and wrong for anything that boots the server and then wants to finish.
export function startScheduler() {
  return cron.schedule('0 2 * * *', () => {
    Promise.all([...NIGHTLY_REPORTS, 'DIRECT_SP_API_SYNC'].map(reportType => syncActiveTenants(reportType)))
      .catch(error => console.error('Nightly sync scheduler run failed:', error instanceof Error ? error.message : error));
  });
}
