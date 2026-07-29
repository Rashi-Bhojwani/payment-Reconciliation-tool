ALTER TABLE returns ALTER COLUMN quantity DROP DEFAULT;
ALTER TABLE returns ALTER COLUMN quantity DROP NOT NULL;

-- Earlier imports temporarily used 1 when Amazon omitted quantity. Remove that
-- guess so the dashboard reports the source as unavailable instead.
UPDATE returns
SET quantity = NULL
WHERE coalesce(raw->>'quantity', raw->>'quantity-returned', raw->>'quantity returned', raw->>'return-quantity', '') = '';
