ALTER TABLE order_items ADD COLUMN IF NOT EXISTS amazon_order_item_id text;
ALTER TABLE order_items ALTER COLUMN quantity_ordered DROP DEFAULT;

UPDATE order_items SET quantity_ordered=NULL
WHERE quantity_ordered=0 AND raw<>'{}'::jsonb
  AND coalesce(raw->>'QuantityOrdered',raw->>'quantityOrdered','')='';

UPDATE order_items
SET amazon_order_item_id = coalesce(raw->>'OrderItemId', raw->>'orderItemId', raw->>'order-item-id')
WHERE amazon_order_item_id IS NULL;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_tenant_id_amazon_order_id_sku_asin_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_items_amazon_identity
  ON order_items(tenant_id, amazon_order_item_id)
  WHERE amazon_order_item_id IS NOT NULL;
