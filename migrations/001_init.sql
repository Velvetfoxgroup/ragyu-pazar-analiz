-- Ragyu Pazar ve Fiyat Analiz Merkezi - ilk şema.
-- Tüm iş tabloları org_id taşır (ileride grup şirketleri için kiracı ayrımı).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  username text NOT NULL,
  display_name text NOT NULL,
  email text,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','editor','approver','viewer')),
  active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_org_username_uq ON users(org_id, lower(username));

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  key text NOT NULL,
  success boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_key_idx ON login_attempts(key, at);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid,
  actor_name text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_at_idx ON audit_log(org_id, at DESC);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  category text,
  subcategory text,
  brand text,
  image_url text,
  active boolean NOT NULL DEFAULT true,
  attrs jsonb NOT NULL DEFAULT '{}',   -- tür, kesim, işlenme, kemik, taze/donuk
  source text NOT NULL DEFAULT 'manual', -- manual | import | ticimax
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_org_code_uq ON products(org_id, lower(code));

CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku text NOT NULL,
  pack_qty numeric(14,4) NOT NULL CHECK (pack_qty > 0),
  pack_unit text NOT NULL CHECK (pack_unit IN ('g','kg','ml','l','adet')),
  price numeric(14,4),            -- Ragyu güncel satış fiyatı (TRY)
  barcode text,
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX variants_org_sku_uq ON product_variants(org_id, lower(sku));
CREATE INDEX variants_product_idx ON product_variants(product_id);

CREATE TABLE own_price_history (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  price numeric(14,4) NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX own_price_hist_idx ON own_price_history(variant_id, valid_from DESC);

-- Rakip site / kaynak
CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  domain text NOT NULL,
  adapter_key text NOT NULL DEFAULT 'generic-html',
  config jsonb NOT NULL DEFAULT '{}',        -- çıkarma ayarları (selector/regex)
  active boolean NOT NULL DEFAULT true,
  min_interval_ms integer NOT NULL DEFAULT 2000,   -- aynı kaynağa istekler arası en az süre
  check_interval_minutes integer NOT NULL DEFAULT 360,
  stale_after_hours integer NOT NULL DEFAULT 48,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sources_org_domain_uq ON sources(org_id, lower(domain));

CREATE TABLE sellers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  name text NOT NULL,
  is_self boolean NOT NULL DEFAULT false,    -- Ragyu'nun kendi ilanı rakip sayılmaz
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sellers_src_name_uq ON sellers(source_id, lower(name));

CREATE TABLE competitor_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  seller_id uuid REFERENCES sellers(id),
  title text NOT NULL,
  brand text,
  url text,                       -- bilinen ana sayfa adresi
  attrs jsonb NOT NULL DEFAULT '{}',
  discovered_by text NOT NULL DEFAULT 'auto' CHECK (discovered_by IN ('auto','manual','import')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ragyu varyantı ↔ rakip ürünü eşleşmesi
CREATE TABLE product_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  competitor_product_id uuid NOT NULL REFERENCES competitor_products(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('suggested','review','approved','rejected','invalidated')),
  origin text NOT NULL CHECK (origin IN ('auto','manual')),
  score numeric(6,3),
  mismatches jsonb NOT NULL DEFAULT '[]',
  note text,
  created_by uuid REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX links_pair_uq ON product_links(variant_id, competitor_product_id);
CREATE INDEX links_status_idx ON product_links(org_id, status);

-- İzlenen URL'ler (otomatik bulunan veya manuel girilen); URL değişirse eskisi pasifleşir, geçmiş kalır.
CREATE TABLE tracked_urls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  competitor_product_id uuid NOT NULL REFERENCES competitor_products(id) ON DELETE CASCADE,
  url text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('auto','manual')),
  active boolean NOT NULL DEFAULT true,
  extraction jsonb NOT NULL DEFAULT '{}',   -- URL'ye özel veri çıkarma ayarı
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_status text,                          -- ok | error | review
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  replaced_by uuid REFERENCES tracked_urls(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz
);
CREATE INDEX tracked_due_idx ON tracked_urls(active, next_check_at);
CREATE INDEX tracked_cp_idx ON tracked_urls(competitor_product_id);

CREATE TABLE scrape_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  tracked_url_id uuid NOT NULL REFERENCES tracked_urls(id) ON DELETE CASCADE,
  url text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('scheduled','manual','retry')),
  triggered_by uuid REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error','review')),
  http_status integer,
  error text,
  extracted jsonb
);
CREATE INDEX runs_url_idx ON scrape_runs(tracked_url_id, started_at DESC);
CREATE INDEX runs_status_idx ON scrape_runs(org_id, status, started_at DESC);

-- Gramaj düzeltmesi (URL bazlı, geçerlilik dönemli, onay gerektirir)
CREATE TABLE qty_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  tracked_url_id uuid NOT NULL REFERENCES tracked_urls(id) ON DELETE CASCADE,
  pack_qty numeric(14,4) NOT NULL CHECK (pack_qty > 0),
  pack_unit text NOT NULL CHECK (pack_unit IN ('g','kg','ml','l','adet')),
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE price_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  tracked_url_id uuid NOT NULL REFERENCES tracked_urls(id),
  competitor_product_id uuid NOT NULL REFERENCES competitor_products(id),
  scrape_run_id uuid REFERENCES scrape_runs(id),
  url text NOT NULL,                       -- gözlemin alındığı URL (URL değişse de korunur)
  observed_at timestamptz NOT NULL DEFAULT now(),
  list_price numeric(14,4),
  sale_price numeric(14,4),                -- fiilen ödenecek tek paket fiyatı
  currency text NOT NULL DEFAULT 'TRY',
  pack_qty numeric(14,4),
  pack_unit text,
  qty_source text,                         -- page | override | catalog
  base_qty numeric(18,6),                  -- g veya ml
  base_unit text,                          -- g | ml
  unit_price numeric(18,6),                -- TL/kg veya TL/l
  in_stock boolean,
  campaign text,
  shipping_fee numeric(14,4),
  multibuy_min integer,
  product_title text,
  quality text NOT NULL CHECK (quality IN ('ok','review','invalid')),
  quality_reasons jsonb NOT NULL DEFAULT '[]',
  raw jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX obs_cp_time_idx ON price_observations(competitor_product_id, observed_at DESC);
CREATE INDEX obs_url_time_idx ON price_observations(tracked_url_id, observed_at DESC);

CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  type text NOT NULL,   -- price_jump | qty_doubt | match_issue | scrape_failing | stale_source | content_mismatch
  severity text NOT NULL DEFAULT 'warning',
  ref_type text NOT NULL,
  ref_id uuid NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX alerts_open_uq ON alerts(org_id, type, ref_id) WHERE status = 'open';

CREATE TABLE import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL,
  file_name text,
  total_rows integer NOT NULL,
  ok_rows integer NOT NULL,
  error_rows integer NOT NULL,
  errors jsonb NOT NULL DEFAULT '[]',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
