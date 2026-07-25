export const FASHION_JEWELLERY_SLAB = Object.freeze({
  price: [
    { max: 300, referralRate: 0, closingFee: 1 },
    { max: 500, referralRate: 0, closingFee: 22 },
    { max: 1000, referralRate: 0, closingFee: 45 },
    { max: Infinity, referralRate: 0.225, closingFee: 76 }
  ]
});

export const CATEGORY_TO_SLAB = Object.freeze({
  'fashion jewellery': FASHION_JEWELLERY_SLAB,
  jewellery: FASHION_JEWELLERY_SLAB,
  'fashion jewelry': FASHION_JEWELLERY_SLAB
});

export function computeSlabFees(slab, price) {
  const row = slab?.price?.find(entry => Number(price) <= entry.max);
  return row ? { referralFee: Number(price) * row.referralRate, closingFee: row.closingFee } : null;
}

export function computeWeightFee(weightKg) {
  const kg = Number(weightKg);
  if (!Number.isFinite(kg) || kg <= 0) return null;
  if (kg <= 0.5) return 55;
  if (kg <= 1) return 75;
  if (kg <= 2) return 112;
  const throughFive = Math.min(3, Math.ceil(kg - 2));
  const afterFive = Math.max(0, Math.ceil(kg - 5));
  return 112 + throughFive * 34 + afterFive * 18;
}

export function slabForCategory(category) {
  const normalized = String(category ?? '').trim().toLowerCase();
  return CATEGORY_TO_SLAB[normalized] ?? Object.entries(CATEGORY_TO_SLAB).find(([name]) => normalized.includes(name))?.[1] ?? null;
}
