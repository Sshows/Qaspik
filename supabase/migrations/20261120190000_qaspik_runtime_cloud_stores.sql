begin;

create schema if not exists qaspik_runtime;
revoke all on schema qaspik_runtime from public, anon, authenticated, service_role;

create table if not exists qaspik_runtime.cloud_stores (
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
  subscription_active boolean not null default false,
  subscription_expires_at timestamptz not null default now(),
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_qaspik_rt_cloud_stores_feed_token
  on qaspik_runtime.cloud_stores (feed_token);

create index if not exists idx_qaspik_rt_cloud_stores_tg_code
  on qaspik_runtime.cloud_stores (telegram_link_code);

create table if not exists qaspik_runtime.price_events (
  id text primary key,
  store_id text not null references qaspik_runtime.cloud_stores (id) on delete cascade,
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

create index if not exists idx_qaspik_rt_price_events_store_created
  on qaspik_runtime.price_events (store_id, created_at desc);

create table if not exists qaspik_runtime.worker_status (
  singleton boolean primary key default true check (singleton),
  last_heartbeat_at timestamptz not null default now()
);

-- Preserve any existing rows from public tables without dropping them yet (zero-downtime cutover)
do $$
begin
  if to_regclass('public.qaspik_cloud_stores') is not null then
    insert into qaspik_runtime.cloud_stores (
      id, merchant_id, company_name, city_id, feed_token, manage_token_hash,
      telegram_link_code, telegram_chat_id, catalog_xml, rules_json,
      last_standings_json, bot_enabled, subscription_active,
      subscription_expires_at, last_run_at, created_at, updated_at
    )
    select
      id, merchant_id, company_name, city_id, feed_token, manage_token_hash,
      telegram_link_code, telegram_chat_id, catalog_xml, rules_json,
      last_standings_json, bot_enabled, subscription_active,
      subscription_expires_at, last_run_at, created_at, updated_at
    from public.qaspik_cloud_stores
    on conflict (id) do nothing;
  end if;

  if to_regclass('public.qaspik_price_events') is not null then
    insert into qaspik_runtime.price_events (
      id, store_id, sku, master_sku, city_id, old_price, new_price,
      competitor_name, competitor_price, decision_code, message, created_at
    )
    select
      id, store_id, sku, master_sku, city_id, old_price, new_price,
      competitor_name, competitor_price, decision_code, message, created_at
    from public.qaspik_price_events
    on conflict (id) do nothing;
  end if;
end;
$$;

alter table qaspik_runtime.cloud_stores enable row level security;
alter table qaspik_runtime.price_events enable row level security;
alter table qaspik_runtime.worker_status enable row level security;

revoke all on table
  qaspik_runtime.cloud_stores,
  qaspik_runtime.price_events,
  qaspik_runtime.worker_status
  from public, anon, authenticated, service_role;

-- Server-only RPCs (granted EXCLUSIVELY to service_role, never anon/authenticated)
create or replace function public.qaspik_upsert_cloud_store(p_store jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row qaspik_runtime.cloud_stores;
begin
  insert into qaspik_runtime.cloud_stores (
    id, merchant_id, company_name, city_id, feed_token, manage_token_hash,
    telegram_link_code, telegram_chat_id, catalog_xml, rules_json,
    last_standings_json, bot_enabled, subscription_active,
    subscription_expires_at, last_run_at, created_at, updated_at
  )
  values (
    p_store->>'id',
    p_store->>'merchant_id',
    p_store->>'company_name',
    coalesce(p_store->>'city_id', '750000000'),
    p_store->>'feed_token',
    p_store->>'manage_token_hash',
    p_store->>'telegram_link_code',
    p_store->>'telegram_chat_id',
    p_store->>'catalog_xml',
    coalesce(p_store->'rules_json', '{}'::jsonb),
    coalesce(p_store->'last_standings_json', '{}'::jsonb),
    coalesce((p_store->>'bot_enabled')::boolean, true),
    coalesce((p_store->>'subscription_active')::boolean, false),
    coalesce((p_store->>'subscription_expires_at')::timestamptz, now()),
    (p_store->>'last_run_at')::timestamptz,
    coalesce((p_store->>'created_at')::timestamptz, now()),
    now()
  )
  on conflict (id) do update set
    company_name = excluded.company_name,
    city_id = excluded.city_id,
    telegram_chat_id = excluded.telegram_chat_id,
    catalog_xml = excluded.catalog_xml,
    rules_json = excluded.rules_json,
    last_standings_json = excluded.last_standings_json,
    bot_enabled = excluded.bot_enabled,
    subscription_active = excluded.subscription_active,
    subscription_expires_at = excluded.subscription_expires_at,
    last_run_at = excluded.last_run_at,
    updated_at = now()
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.qaspik_get_cloud_store(
  p_id text default null,
  p_feed_token text default null,
  p_tg_code text default null,
  p_tg_chat_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row qaspik_runtime.cloud_stores;
begin
  if p_id is not null then
    select * into v_row from qaspik_runtime.cloud_stores where id = p_id limit 1;
  elsif p_feed_token is not null then
    select * into v_row from qaspik_runtime.cloud_stores where feed_token = p_feed_token limit 1;
  elsif p_tg_code is not null then
    select * into v_row from qaspik_runtime.cloud_stores where telegram_link_code = p_tg_code limit 1;
  elsif p_tg_chat_id is not null then
    select * into v_row from qaspik_runtime.cloud_stores where telegram_chat_id = p_tg_chat_id order by updated_at desc limit 1;
  end if;

  if not found then
    return null;
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.qaspik_list_active_cloud_stores()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
  from qaspik_runtime.cloud_stores s
  where s.bot_enabled = true
    and s.subscription_active = true
    and s.subscription_expires_at > now();
$$;

create or replace function public.qaspik_add_price_event(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row qaspik_runtime.price_events;
begin
  insert into qaspik_runtime.price_events (
    id, store_id, sku, master_sku, city_id, old_price, new_price,
    competitor_name, competitor_price, decision_code, message, created_at
  )
  values (
    p_event->>'id',
    p_event->>'store_id',
    p_event->>'sku',
    p_event->>'master_sku',
    p_event->>'city_id',
    (p_event->>'old_price')::integer,
    (p_event->>'new_price')::integer,
    p_event->>'competitor_name',
    (p_event->>'competitor_price')::integer,
    p_event->>'decision_code',
    p_event->>'message',
    coalesce((p_event->>'created_at')::timestamptz, now())
  )
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.qaspik_list_price_events(p_store_id text, p_limit integer default 30)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb)
  from (
    select *
    from qaspik_runtime.price_events
    where store_id = p_store_id
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 30), 100))
  ) e;
$$;

create or replace function public.qaspik_touch_worker_heartbeat()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
begin
  insert into qaspik_runtime.worker_status (singleton, last_heartbeat_at)
  values (true, v_now)
  on conflict (singleton) do update set last_heartbeat_at = v_now;
  return v_now;
end;
$$;

create or replace function public.qaspik_get_worker_heartbeat()
returns timestamptz
language sql
security definer
set search_path = ''
as $$
  select last_heartbeat_at from qaspik_runtime.worker_status where singleton = true limit 1;
$$;

revoke all on function
  public.qaspik_upsert_cloud_store(jsonb),
  public.qaspik_get_cloud_store(text, text, text, text),
  public.qaspik_list_active_cloud_stores(),
  public.qaspik_add_price_event(jsonb),
  public.qaspik_list_price_events(text, integer),
  public.qaspik_touch_worker_heartbeat(),
  public.qaspik_get_worker_heartbeat()
  from public, anon, authenticated;

grant execute on function
  public.qaspik_upsert_cloud_store(jsonb),
  public.qaspik_get_cloud_store(text, text, text, text),
  public.qaspik_list_active_cloud_stores(),
  public.qaspik_add_price_event(jsonb),
  public.qaspik_list_price_events(text, integer),
  public.qaspik_touch_worker_heartbeat(),
  public.qaspik_get_worker_heartbeat()
  to service_role;

notify pgrst, 'reload schema';

commit;
