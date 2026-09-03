// The capability shape every adapter declares. SchedulingService and the UI
// both read these flags at runtime instead of branching on marketplace code
// — this is what makes "does this marketplace support bulk scheduling" a
// config difference instead of an if/else fork in generic code.
//
// A capability an adapter has NOT implemented must be declared false here —
// never true with a method that just throws. The flag and the method must
// agree, or a caller has no reliable way to check before calling.
import { z } from 'zod';

export const MarketplaceCapabilitiesSchema = z.object({
  supportsOrderSync: z.boolean(),
  supportsSingleScheduling: z.boolean(),
  supportsBulkScheduling: z.boolean(),
  supportsShipmentTracking: z.boolean(),
  supportsCancellation: z.boolean(),
  supportsReturns: z.boolean(),
});

/** Every flag false — the safe default a stub adapter starts from. */
export const NO_CAPABILITIES = Object.freeze({
  supportsOrderSync: false,
  supportsSingleScheduling: false,
  supportsBulkScheduling: false,
  supportsShipmentTracking: false,
  supportsCancellation: false,
  supportsReturns: false,
});

/** Throws with a readable message if `capabilities` doesn't match the schema. */
export function assertValidCapabilities(marketplaceCode, capabilities) {
  const result = MarketplaceCapabilitiesSchema.safeParse(capabilities);
  if (!result.success) {
    throw new Error(
      `${marketplaceCode} adapter declares invalid capabilities: ${result.error.message}`,
    );
  }
  return result.data;
}
