import { z } from 'zod';
import { assertActiveTenant, withTenant } from '@recon/db';
import { getSpApiEndpoint, SpApiClient } from '@recon/sp-api-client';
import { decryptSecret } from '../config/crypto.js';
import { computeSlabFees, computeWeightFee, slabForCategory } from '../config/fee-slabs.js';
import { runJob } from './runner.js';
import { loadSourceCoverage } from './source-coverage.js';

function amount(value) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function weightKg(node) {
  const value = amount(node?.value);
  const unit = String(node?.unit ?? '').toLowerCase();
  if (!value) return null;
  if (/gram/.test(unit)) return value / 1000;
  if (/pound|lb/.test(unit)) return value * 0.45359237;
  if (/ounce|oz/.test(unit)) return value * 0.0283495;
  if (/kilogram|kg/.test(unit)) return value;
  return null;
}
function parseAmazonEstimate(response) {
  const estimate = response?.payload?.FeesEstimateResult?.FeesEstimate ?? response?.FeesEstimateResult?.FeesEstimate;
  if (!estimate) return null;
  const result = { referralFee: 0, fulfillmentFee: 0, closingFee: 0, otherFee: 0 };
  for (const detail of estimate.FeeDetailList ?? []) {
    const fee = Math.abs(amount(detail?.FinalFee?.Amount ?? detail?.FeeAmount?.Amount));
    if (/referral/i.test(detail.FeeType)) result.referralFee += fee;
    else if (/fba|fulfillment/i.test(detail.FeeType)) result.fulfillmentFee += fee;
    else if (/closing/i.test(detail.FeeType)) result.closingFee += fee;
    else result.otherFee += fee;
  }
  result.totalFee = Math.abs(amount(estimate?.TotalFeesEstimate?.Amount)) || result.referralFee + result.fulfillmentFee + result.closingFee + result.otherFee;
  return result.totalFee ? result : null;
}

export async function runFeeAuditForTenant(tenantId, options = {}) {
  const parsedTenantId = z.string().uuid().parse(tenantId);
  const range = z.object({ start: z.string().datetime(), end: z.string().datetime() }).parse(options.range ?? { start: new Date(Date.now() - 30 * 864e5).toISOString(), end: new Date().toISOString() });
  const threshold = z.number().min(0).parse(Number(options.varianceThreshold ?? 5));
  await assertActiveTenant(parsedTenantId);
  return runJob(`fee-audit:${parsedTenantId}`, async () => {
    const seller = await withTenant(parsedTenantId, async db => (await db.query("select refresh_token_encrypted, marketplace_id from sellers where tenant_id=$1 and auth_status='authorized' order by connected_at desc limit 1", [parsedTenantId])).rows[0]);
    if (!seller) throw new Error('No connected Amazon seller account');
    const spApi = new SpApiClient(decryptSecret(seller.refresh_token_encrypted), { baseUrl: getSpApiEndpoint(seller.marketplace_id) });
    return withTenant(parsedTenantId, async db => {
      const coverage = await loadSourceCoverage(db, parsedTenantId, range);
      if (!coverage.ordersComplete || !coverage.financeComplete) {
        throw new Error('Fee audit requires complete Orders and Finances coverage for the selected range. Run Orders & finance sync first.');
      }
      const items = (await db.query(`select oi.amazon_order_id,oi.sku,oi.asin,oi.item_price,oi.quantity_ordered,
          case when oi.quantity_ordered>0 then oi.item_price/oi.quantity_ordered else null end unit_price,
          o.fulfillment_channel
        from order_items oi join orders o on o.tenant_id=oi.tenant_id and o.amazon_order_id=oi.amazon_order_id
        where oi.tenant_id=$1 and o.order_date >= $2 and o.order_date < $3 and oi.sku is not null`, [parsedTenantId, range.start, range.end])).rows;
      let audited = 0; let flagged = 0; let unaudited = 0;
      const estimates = new Map();
      const orderEstimates = new Map();
      for (const item of items) {
        const quantity = Number(item.quantity_ordered);
        if (!Number.isInteger(quantity) || quantity <= 0 || item.unit_price == null) {
          unaudited += 1;
          continue;
        }
        const cacheKey = `${item.sku}:${Number(item.unit_price)}`;
        let estimate = estimates.get(cacheKey);
        if (!estimate) estimate = (await db.query(`select * from fee_estimates where tenant_id=$1 and sku=$2 and price_snapshot=$3 and estimated_at > now()-interval '30 days'`, [parsedTenantId, item.sku, item.unit_price])).rows[0];
        if (!estimate) {
          const request = { FeesEstimateRequest: { MarketplaceId: seller.marketplace_id, IsAmazonFulfilled: item.fulfillment_channel === 'AFN', PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'INR', Amount: amount(item.unit_price) }, Shipping: { CurrencyCode: 'INR', Amount: 0 } }, Identifier: `fee-estimate-${item.sku}-${Date.now()}` } };
          let parsed; let source; let raw;
          try { raw = await spApi.estimateListingFees(item.sku, request); parsed = parseAmazonEstimate(raw); source = 'amazon_estimate'; } catch { parsed = null; }
          if (!parsed && item.asin) {
            try {
              const catalog = await spApi.getCatalogItem(item.asin, seller.marketplace_id); const slab = slabForCategory(catalog.category); const weightFee = computeWeightFee(weightKg(catalog.weightNode)); const priceFees = computeSlabFees(slab, amount(item.unit_price));
              if (slab && weightFee != null && priceFees) { parsed = { ...priceFees, fulfillmentFee: weightFee, otherFee: 0, totalFee: priceFees.referralFee + priceFees.closingFee + weightFee }; source = 'slab_fallback'; raw = catalog.raw; }
            } catch { parsed = null; }
          }
          if (parsed) estimate = (await db.query(`insert into fee_estimates(tenant_id,sku,asin,price_snapshot,category,referral_fee,fulfillment_fee,closing_fee,other_fee,total_fee,source,raw)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(tenant_id,sku,price_snapshot) do update set referral_fee=excluded.referral_fee,fulfillment_fee=excluded.fulfillment_fee,closing_fee=excluded.closing_fee,other_fee=excluded.other_fee,total_fee=excluded.total_fee,source=excluded.source,raw=excluded.raw,estimated_at=now() returning *`, [parsedTenantId,item.sku,item.asin,item.unit_price,null,parsed.referralFee,parsed.fulfillmentFee,parsed.closingFee,parsed.otherFee,parsed.totalFee,source,raw ?? {}])).rows[0];
        }
        if (!estimate) { unaudited += 1; continue; }
        estimates.set(cacheKey, estimate);
        const orderEstimate = orderEstimates.get(item.amazon_order_id) ?? { expected: 0, skus: new Set(), sources: new Set() };
        orderEstimate.expected += amount(estimate.total_fee) * quantity; orderEstimate.skus.add(item.sku); orderEstimate.sources.add(estimate.source); orderEstimates.set(item.amazon_order_id, orderEstimate);
      }
      for (const [orderId, estimate] of orderEstimates) {
        const actualRow = (await db.query(`select count(*) count,greatest(0,-coalesce(sum(fi.amount),0)) actual
          from finance_transaction_items fi
          join finance_transactions ft
            on ft.tenant_id=fi.tenant_id and ft.transaction_id=fi.transaction_id
          where fi.tenant_id=$1 and fi.order_id=$2 and not fi.is_summary
            and lower(coalesce(ft.transaction_status,'released')) in ('released','deferred_released','deferredreleased')
            and fi.category=any($3)`,
        [parsedTenantId,orderId,['referral_commission','refund_commission','fulfillment_fee_per_order','fulfillment_fee_per_unit','fulfillment_fee_weight','closing_fee']])).rows[0];
        if (!Number(actualRow.count)) { unaudited += 1; continue; }
        audited += 1; const actual = amount(actualRow.actual); const expected = estimate.expected; const variance = actual - expected; const source = estimate.sources.size === 1 ? [...estimate.sources][0] : 'mixed';
        if (Math.abs(variance) >= threshold) { await db.query(`insert into fee_leak_flags(tenant_id,order_id,sku,category,source,expected_fee,actual_fee,variance,flagged_at,resolved) values($1,$2,$3,$4,$5,$6,$7,$8,now(),false) on conflict(tenant_id,order_id) do update set sku=excluded.sku,category=excluded.category,source=excluded.source,expected_fee=excluded.expected_fee,actual_fee=excluded.actual_fee,variance=excluded.variance,flagged_at=now(),resolved=false`, [parsedTenantId,orderId,[...estimate.skus].join(', '),'total_fees',source,expected,actual,variance]); flagged += 1; }
        else await db.query('delete from fee_leak_flags where tenant_id=$1 and order_id=$2', [parsedTenantId,orderId]);
      }
      return { audited, flagged, unaudited };
    });
  });
}
