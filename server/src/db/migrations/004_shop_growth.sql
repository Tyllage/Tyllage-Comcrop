-- Farm-approved consumer packs share the existing harvest allocation ledger.
ALTER TABLE community_drops ADD COLUMN min_orders INTEGER NOT NULL DEFAULT 1 CHECK (min_orders BETWEEN 1 AND 1000);
CREATE TABLE shop_listings (
  id SERIAL PRIMARY KEY,
  farm_id INTEGER NOT NULL REFERENCES farms(id),
  harvest_batch_id INTEGER NOT NULL REFERENCES harvest_batches(id),
  title VARCHAR(150) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('PREORDER','SURPRISE_BAG','REWARD')),
  quantity_per_pack NUMERIC(10,2) NOT NULL CHECK (quantity_per_pack > 0),
  pack_price NUMERIC(10,2) NOT NULL CHECK (pack_price >= 0),
  original_value NUMERIC(10,2) NOT NULL CHECK (original_value >= pack_price),
  points_cost INTEGER NOT NULL DEFAULT 0 CHECK (points_cost >= 0),
  max_packs INTEGER NOT NULL CHECK (max_packs > 0),
  pickup_date DATE NOT NULL,
  pickup_start TIME NOT NULL,
  pickup_end TIME NOT NULL CHECK (pickup_end > pickup_start),
  community_drop_id INTEGER REFERENCES community_drops(id),
  packaging_cost NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (packaging_cost >= 0),
  margin_override_reason TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  approved_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE orders ADD COLUMN shop_listing_id INTEGER REFERENCES shop_listings(id);
ALTER TABLE orders ADD COLUMN shop_pack_count INTEGER CHECK (shop_pack_count > 0);
ALTER TABLE orders ADD COLUMN reward_discount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN payment_status VARCHAR(20) CHECK (payment_status IN ('DEMO_PAID','DEMO_REFUNDED','NO_PAYMENT'));
CREATE INDEX shop_orders_listing_idx ON orders(shop_listing_id);
CREATE TABLE reward_accounts (
  buyer_id INTEGER NOT NULL REFERENCES buyer_profiles(id),
  farm_id INTEGER NOT NULL REFERENCES farms(id),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  PRIMARY KEY (buyer_id, farm_id)
);
CREATE TABLE reward_ledger (
  id SERIAL PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES buyer_profiles(id),
  farm_id INTEGER NOT NULL REFERENCES farms(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('EARN','REDEEM','RESTORE')),
  points INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(order_id, kind)
);
CREATE TABLE buyer_relationships (
  farm_id INTEGER NOT NULL REFERENCES farms(id),
  buyer_id INTEGER NOT NULL REFERENCES buyer_profiles(id),
  notes TEXT NOT NULL DEFAULT '',
  next_follow_up DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (farm_id, buyer_id)
);
