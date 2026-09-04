// Zod schemas for SP-API Orders v2026-01-01 responses. Every response is
// parsed through one of these before the adapter touches it — Amazon's
// payloads change, and a shape mismatch must fail loudly (SpApiValidationError)
// rather than silently propagate a wrong/missing field into an order row.
import { z } from 'zod';
import { SpApiValidationError } from '../errors.js';

// searchOrders' real shape — confirmed against a live SP-API v2026-01-01
// response: no `payload` wrapper, camelCase field names throughout,
// orderItems already inline (no separate getOrderItems call needed to list
// orders), and notably NO order status, ship-by/delivery-by dates, order
// total, or buyer PII anywhere in a list result — those come from a
// per-order getOrder call instead (see GetOrderSchema below; buyer PII
// additionally needs a Restricted Data Token regardless — see
// APP_ARCHITECTURE.md's Merchant Fulfillment API discussion).
const SearchMoneySchema = z.object({ amount: z.string().optional(), currencyCode: z.string().optional() }).partial();

const SearchProductSchema = z
  .object({
    asin: z.string().optional(),
    sellerSku: z.string().optional(),
    title: z.string().optional(),
    price: z.object({ unitPrice: SearchMoneySchema.optional() }).partial().optional(),
    condition: z
      .object({ conditionType: z.string().optional(), conditionSubtype: z.string().optional() })
      .partial()
      .optional(),
  })
  .passthrough();

const SearchOrderItemSchema = z
  .object({
    orderItemId: z.string(),
    quantityOrdered: z.number(),
    quantityShipped: z.number().optional(),
    product: SearchProductSchema.optional(),
  })
  .passthrough();

const SalesChannelSchema = z
  .object({
    marketplaceId: z.string().optional(),
    marketplaceName: z.string().optional(),
    channelName: z.string().optional(),
  })
  .partial()
  .passthrough();

export const SearchOrderSchema = z
  .object({
    orderId: z.string(),
    createdTime: z.string(),
    lastUpdatedTime: z.string(),
    programs: z.array(z.string()).optional(),
    salesChannel: SalesChannelSchema.optional(),
    orderItems: z.array(SearchOrderItemSchema).optional(),
    associatedOrders: z.array(z.object({ orderId: z.string(), associationType: z.string() }).passthrough()).optional(),
  })
  .passthrough(); // unknown fields survive into raw_response, nothing is silently dropped

export const SearchOrdersResponseSchema = z
  .object({
    orders: z.array(SearchOrderSchema),
    pagination: z.object({ nextToken: z.string().optional() }).partial().optional(),
    createdBefore: z.string().optional(),
  })
  .passthrough();

// getOrder's real shape — confirmed against multiple live SP-API
// v2026-01-01 responses (captured via rawResponse on the validation errors
// this schema replaces). Same shift as searchOrders: no `payload` wrapper,
// camelCase throughout, and orderItems already inline (a live getOrder
// response always carried its own orderItems array — the separate
// getOrderItems call this app used to make afterwards is redundant against
// this API version and has been dropped, which also halves the SP-API
// calls the per-order enrichment loop makes). The real status this app
// needs lives at fulfillment.fulfillmentStatus (confirmed values seen:
// "SHIPPED", "CANCELLED" — not the OrderStatus field the old v0-shaped
// guess assumed). recipient.deliveryAddress carries only geographic fields
// in every sample seen (city/state/postalCode/countryCode/addressType) —
// no name, phone or street line ever appeared, consistent with full buyer
// PII being gated behind a Restricted Data Token this app does not fetch.
const OrderFulfillmentWindowSchema = z
  .object({ earliestDateTime: z.string().optional(), latestDateTime: z.string().optional() })
  .partial()
  .passthrough();

const OrderRecipientSchema = z
  .object({
    name: z.string().optional(),
    deliveryAddress: z
      .object({
        city: z.string().optional(),
        stateOrRegion: z.string().optional(),
        postalCode: z.string().optional(),
        countryCode: z.string().optional(),
        addressType: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
  })
  .partial()
  .passthrough();

const OrderFulfillmentSchema = z
  .object({
    fulfilledBy: z.string().optional(),
    fulfillmentStatus: z.string().optional(),
    fulfillmentServiceLevel: z.string().optional(),
    shipByWindow: OrderFulfillmentWindowSchema.optional(),
    deliverByWindow: OrderFulfillmentWindowSchema.optional(),
  })
  .partial()
  .passthrough();

const OrderItemFulfillmentSchema = z
  .object({
    quantityFulfilled: z.number().optional(),
    quantityUnfulfilled: z.number().optional(),
  })
  .partial()
  .passthrough();

export const GetOrderItemSchema = z
  .object({
    orderItemId: z.string(),
    quantityOrdered: z.number(),
    product: SearchProductSchema.optional(),
    fulfillment: OrderItemFulfillmentSchema.optional(),
  })
  .passthrough();

export const GetOrderSchema = z
  .object({
    orderId: z.string(),
    createdTime: z.string(),
    lastUpdatedTime: z.string(),
    programs: z.array(z.string()).optional(),
    recipient: OrderRecipientSchema.optional(),
    fulfillment: OrderFulfillmentSchema.optional(),
    salesChannel: SalesChannelSchema.optional(),
    orderItems: z.array(GetOrderItemSchema).optional(),
  })
  .passthrough();

export const GetOrderResponseSchema = z.object({
  order: GetOrderSchema,
});

/** Parses `data` with `schema`, throwing SpApiValidationError (not a bare ZodError) on mismatch. */
export function parseOrThrow(schema, data, context) {
  const result = schema.safeParse(data);
  if (!result.success) {
    // rawResponse is server-log-only — SpApiValidationError's expose:false
    // (like every SP-API error class) already keeps it out of any browser
    // response; without it, diagnosing a shape mismatch meant guessing
    // blind, since the Zod issue list alone doesn't say what Amazon
    // actually sent (e.g. "payload: Required" — is payload nested one level
    // deeper than expected? Renamed? Missing entirely? unanswerable from
    // the issue list alone).
    throw new SpApiValidationError(`Unexpected SP-API response shape (${context})`, {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      rawResponse: data,
    });
  }
  return result.data;
}
