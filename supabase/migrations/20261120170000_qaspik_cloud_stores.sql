create table if not exists public.qaspik_cloud_stores (
  id text primary key,
  merchant_id text not null,
  company_name text not null,
  city_id text not null default '750000000',
  feed_token text not null unique,
  manage_token_hash text not null,
  telegram_link_code text unique,
  telegram_chat_id text,
  catalog_xml text not null,
  rules_json jsonb not null default '{}'::jsonb,
  last_standings_json jsonb not null default '{}'::jsonb,
  bot_enabled boolean not null default true,
  subscription_active boolean not null default true,
  subscription_expires_at timestamptz not null default (now() + interval '30 days'),
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_qaspik_cloud_stores_feed_token
  on public.qaspik_cloud_stores (feed_token);

create index if not exists idx_qaspik_cloud_stores_tg_code
  on public.qaspik_cloud_stores (telegram_link_code);

create table if not exists public.qaspik_price_events (
  id text primary key,
  store_id text not null references public.qaspik_cloud_stores (id) on delete cascade,
  sku text not null,
  master_sku text,
  city_id text,
  old_price integer not null,
  new_price integer not null,
  competitor_name text,
  competitor_price integer,
  decision_code text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_qaspik_price_events_store_created
  on public.qaspik_price_events (store_id, created_at desc);
