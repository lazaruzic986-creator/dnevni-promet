-- Dnevni promet ugostitelja. Quantities numeric(18,4), unit costs numeric(18,6), money numeric(18,2).

create table if not exists orgs (
  id uuid primary key,
  name text not null,
  legal_name text,
  pib text,
  mb text,
  address text,
  city text,
  phone text,
  currency text not null default 'RSD',
  timezone text not null default 'Europe/Belgrade',
  business_day_end_hour int not null default 4,
  tax_mode text not null default 'ukljucen',
  valuation_method text not null default 'ponderisani_prosek',
  auto_post_invoices boolean not null default false,
  setup_complete boolean not null default false,
  opening_stock_date date,
  locked_through date,
  initial_cash numeric(18,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists members (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  user_id text not null unique,
  email text,
  display_name text,
  role text not null check (role in ('super_admin', 'admin', 'knjigovodja')),
  permissions jsonb not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists members_org_email_uq on members (org_id, lower(email)) where email is not null;

create table if not exists invites (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  email text not null,
  role text not null,
  permissions jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (org_id, email)
);

create table if not exists access_requests (
  user_id text primary key,
  email text,
  name text,
  created_at timestamptz not null default now()
);

create table if not exists categories (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  name text not null,
  kind text not null,
  unique (org_id, name)
);

create table if not exists suppliers (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  name text not null,
  pib text,
  note text,
  active boolean not null default true
);

create table if not exists articles (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  code text,
  name text not null,
  category_id uuid references categories(id),
  kind text not null,
  tracks_stock boolean not null default true,
  base_unit text not null check (base_unit in ('g', 'ml', 'kom')),
  min_qty numeric(18,4) not null default 0,
  barcode text,
  next_expiry date,
  last_price numeric(18,6),
  prev_price numeric(18,6),
  avg_cost numeric(18,6),
  on_hand numeric(18,4) not null default 0,
  active boolean not null default true,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists articles_org_idx on articles (org_id, name);

create table if not exists article_packs (
  id uuid primary key,
  article_id uuid not null references articles(id),
  name text not null,
  qty_in_base numeric(18,4) not null,
  unique (article_id, name)
);

create table if not exists supplier_item_map (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  supplier_id uuid not null references suppliers(id),
  supplier_name text not null,
  article_id uuid not null references articles(id),
  unique (org_id, supplier_id, supplier_name)
);

create table if not exists price_history (
  id uuid primary key,
  article_id uuid not null references articles(id),
  unit_price numeric(18,6) not null,
  qty numeric(18,4),
  source text,
  ref_id uuid,
  at timestamptz not null default now()
);

create table if not exists idempotency (
  org_id uuid not null,
  key text not null,
  kind text not null,
  ref_id uuid,
  created_at timestamptz not null default now(),
  primary key (org_id, key)
);

create table if not exists shifts (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  status text not null check (status in ('otvorena', 'zatvorena')),
  business_date date not null,
  opened_at timestamptz not null,
  closed_at timestamptz,
  opener_id text,
  closer_id text,
  opening_cash numeric(18,2) not null default 0,
  expected_cash numeric(18,2),
  counted_cash numeric(18,2),
  variance numeric(18,2),
  variance_note text,
  corrected boolean not null default false,
  correction_reason text,
  is_demo boolean not null default false
);

create unique index if not exists shifts_one_open on shifts (org_id) where status = 'otvorena';

create table if not exists cash_events (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  shift_id uuid references shifts(id),
  kind text not null,
  amount numeric(18,2) not null,
  ref_type text,
  ref_id uuid,
  note text,
  user_id text,
  occurred_at timestamptz not null,
  business_date date not null,
  idempotency_key text,
  is_demo boolean not null default false
);

create table if not exists invoices (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  supplier_id uuid references suppliers(id),
  doc_number text,
  doc_date date,
  received_date date,
  due_date date,
  kind text not null,
  status text not null,
  total numeric(18,2),
  note text,
  unclear boolean not null default false,
  mismatch boolean not null default false,
  is_demo boolean not null default false,
  idempotency_key text,
  created_by text,
  posted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists invoices_idem_uq on invoices (org_id, idempotency_key) where idempotency_key is not null;
create index if not exists invoices_dup_idx on invoices (org_id, supplier_id, doc_number);

create table if not exists invoice_files (
  id uuid primary key,
  invoice_id uuid not null references invoices(id) on delete cascade,
  name text,
  mime text,
  data_url text not null
);

create table if not exists invoice_lines (
  id uuid primary key,
  invoice_id uuid not null references invoices(id) on delete cascade,
  article_id uuid references articles(id),
  raw_name text not null,
  qty numeric(18,4) not null,
  unit_name text not null,
  qty_base numeric(18,4),
  unit_price numeric(18,6),
  discount numeric(18,2) not null default 0,
  line_total numeric(18,2),
  tax_rate numeric(8,2),
  needs_review boolean not null default false,
  expiry date
);

create table if not exists payments (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  invoice_id uuid references invoices(id),
  amount numeric(18,2) not null,
  method text not null,
  from_cash boolean not null default false,
  paid_at timestamptz not null,
  business_date date not null,
  shift_id uuid,
  note text,
  user_id text,
  idempotency_key text,
  is_demo boolean not null default false
);

create unique index if not exists payments_idem_uq on payments (org_id, idempotency_key) where idempotency_key is not null;

create table if not exists expenses (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  invoice_id uuid references invoices(id),
  invoice_line_id uuid unique,
  article_id uuid references articles(id),
  title text not null,
  amount numeric(18,2) not null,
  category text,
  business_date date not null,
  occurred_at timestamptz not null,
  note text,
  user_id text,
  source text not null default 'rucno',
  is_demo boolean not null default false,
  voided boolean not null default false
);

create table if not exists products (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  code text,
  name text not null,
  group_name text,
  size_label text,
  sell_price numeric(18,2) not null default 0,
  sale_unit text not null default 'kom',
  consume_mode text not null default 'recept',
  output_article_id uuid references articles(id),
  pos_code text,
  active boolean not null default true,
  is_demo boolean not null default false
);

create table if not exists recipe_versions (
  id uuid primary key,
  product_id uuid not null references products(id),
  valid_from timestamptz not null,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists recipe_lines (
  id uuid primary key,
  version_id uuid not null references recipe_versions(id) on delete cascade,
  article_id uuid not null references articles(id),
  qty numeric(18,4) not null,
  role text not null,
  addon_code text,
  yield_ratio numeric(18,4)
);

create table if not exists production_batches (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  output_article_id uuid not null references articles(id),
  planned_qty numeric(18,4) not null,
  actual_qty numeric(18,4) not null,
  status text not null,
  occurred_at timestamptz not null,
  business_date date not null,
  shift_id uuid,
  user_id text,
  note text,
  cost_value numeric(18,2),
  cost_complete boolean not null default false,
  idempotency_key text,
  is_demo boolean not null default false
);

create unique index if not exists prod_idem_uq on production_batches (org_id, idempotency_key) where idempotency_key is not null;

create table if not exists production_lines (
  id uuid primary key,
  batch_id uuid not null references production_batches(id) on delete cascade,
  article_id uuid not null references articles(id),
  qty numeric(18,4) not null
);

create table if not exists sales (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  status text not null,
  source text not null,
  external_key text,
  occurred_at timestamptz not null,
  business_date date not null,
  shift_id uuid,
  channel text not null default 'lokal',
  net numeric(18,2) not null,
  discount numeric(18,2) not null default 0,
  tender_cash numeric(18,2) not null default 0,
  tender_card numeric(18,2) not null default 0,
  tender_other numeric(18,2) not null default 0,
  tender_unpaid numeric(18,2) not null default 0,
  prepaid numeric(18,2) not null default 0,
  is_refund boolean not null default false,
  restores_stock boolean not null default false,
  refund_of uuid,
  reason text,
  is_summary boolean not null default false,
  reconcile_only boolean not null default false,
  order_id uuid,
  user_id text,
  cost_value numeric(18,2),
  cost_complete boolean not null default false,
  basic_normative boolean not null default true,
  is_demo boolean not null default false,
  note text
);

create unique index if not exists sales_ext_uq on sales (org_id, external_key) where external_key is not null;
create index if not exists sales_day_idx on sales (org_id, business_date);

create table if not exists sale_lines (
  id uuid primary key,
  sale_id uuid not null references sales(id) on delete cascade,
  product_id uuid references products(id),
  name text not null,
  qty numeric(18,4) not null,
  unit_price numeric(18,2),
  line_net numeric(18,2) not null,
  recipe_version_id uuid,
  addons jsonb not null default '[]',
  omitted jsonb not null default '[]',
  consume_mode text,
  cost_value numeric(18,2),
  cost_complete boolean not null default false
);

create table if not exists sale_consumptions (
  id uuid primary key,
  sale_line_id uuid not null references sale_lines(id) on delete cascade,
  article_id uuid not null references articles(id),
  qty numeric(18,4) not null,
  unit_cost numeric(18,6),
  value numeric(18,2)
);

create table if not exists wastes (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  article_id uuid references articles(id),
  product_id uuid references products(id),
  qty numeric(18,4) not null,
  unit_name text not null,
  qty_base numeric(18,4),
  reason text not null,
  note text,
  photo_url text,
  value numeric(18,2),
  cost_complete boolean not null default false,
  over_stock boolean not null default false,
  occurred_at timestamptz not null,
  business_date date not null,
  shift_id uuid,
  user_id text,
  status text not null default 'proknjizen',
  idempotency_key text,
  is_demo boolean not null default false
);

create unique index if not exists waste_idem_uq on wastes (org_id, idempotency_key) where idempotency_key is not null;

create table if not exists counts (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  status text not null,
  scope text not null,
  started_at timestamptz not null,
  posted_at timestamptz,
  business_date date not null,
  user_id text,
  note text,
  is_demo boolean not null default false
);

create table if not exists count_lines (
  id uuid primary key,
  count_id uuid not null references counts(id) on delete cascade,
  article_id uuid not null references articles(id),
  expected_qty numeric(18,4) not null,
  counted_qty numeric(18,4),
  diff_qty numeric(18,4),
  value numeric(18,2),
  cost_complete boolean not null default false,
  unique (count_id, article_id)
);

create table if not exists orders (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  customer_name text not null,
  company text,
  phone text,
  due_at timestamptz,
  place text,
  note text,
  status text not null,
  advance numeric(18,2) not null default 0,
  advance_applied numeric(18,2) not null default 0,
  recur_note text,
  sale_id uuid,
  is_demo boolean not null default false,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists order_lines (
  id uuid primary key,
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id),
  name text not null,
  qty numeric(18,4) not null,
  unit_price numeric(18,2) not null
);

create table if not exists audit_log (
  id uuid primary key,
  org_id uuid not null,
  user_id text,
  at timestamptz not null default now(),
  action text not null,
  entity text not null,
  entity_id text,
  reason text,
  before jsonb,
  after jsonb
);

create index if not exists audit_org_idx on audit_log (org_id, at desc);

create table if not exists stock_moves (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  article_id uuid not null references articles(id),
  qty numeric(18,4) not null,
  unit_cost numeric(18,6),
  value numeric(18,2),
  kind text not null,
  ref_type text,
  ref_id uuid,
  business_date date,
  occurred_at timestamptz not null,
  shift_id uuid,
  user_id text,
  note text,
  is_demo boolean not null default false,
  voided boolean not null default false
);

create index if not exists stock_moves_art_idx on stock_moves (article_id, occurred_at);

create table if not exists api_tokens (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  name text not null,
  token_hash text not null unique,
  scopes jsonb not null,
  created_by text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists pos_map (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  pos_code text not null,
  product_id uuid not null references products(id),
  unique (org_id, pos_code)
);
