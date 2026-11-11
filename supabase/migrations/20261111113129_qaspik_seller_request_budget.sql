begin;

create schema qaspik_runtime;
revoke all on schema qaspik_runtime from public, anon, authenticated, service_role;

-- Provision this row separately with the SHA-256 hex digest of the server secret.
create table qaspik_runtime.limiter_config (
  singleton boolean primary key default true check (singleton),
  secret_sha256 text collate pg_catalog."C" not null
    check (secret_sha256 ~ '^[0-9a-f]{64}$')
);

-- The empty key represents the global budget. Other keys are client HMACs.
create table qaspik_runtime.seller_request_budget (
  window_minute bigint not null,
  client_digest bytea not null check (octet_length(client_digest) in (0, 32)),
  consumed integer not null check (
    consumed between 1 and case when octet_length(client_digest) = 0 then 240 else 60 end
  ),
  primary key (window_minute, client_digest)
);

alter table qaspik_runtime.limiter_config enable row level security;
alter table qaspik_runtime.seller_request_budget enable row level security;
revoke all on table qaspik_runtime.limiter_config, qaspik_runtime.seller_request_budget
  from public, anon, authenticated, service_role;

create function qaspik_runtime.consume_seller_budget(p_secret text, p_client text, p_cost integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_minute bigint;
  v_client_digest bytea;
  v_global_digest constant bytea := pg_catalog.decode('', 'hex');
  v_global_consumed integer;
  v_client_consumed integer;
begin
  if p_secret is null or pg_catalog.octet_length(p_secret) <> 64
    or p_secret collate pg_catalog."C" !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '28000', message = 'Seller budget credentials rejected';
  end if;

  if p_client is null or pg_catalog.octet_length(p_client) <> 64
    or p_client collate pg_catalog."C" !~ '^[0-9a-f]{64}$'
    or p_cost is null or p_cost not between 1 and 21 then
    raise exception using errcode = '22023', message = 'Invalid seller budget request';
  end if;

  -- The configuration row serializes authorized reservations across clients.
  perform 1 from qaspik_runtime.limiter_config
  where singleton
    and secret_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8')), 'hex')
  for update;

  if not found then
    raise exception using errcode = '28000', message = 'Seller budget credentials rejected';
  end if;

  v_window_minute := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) / 60)::bigint;
  v_client_digest := pg_catalog.decode(p_client, 'hex');

  delete from qaspik_runtime.seller_request_budget where window_minute < v_window_minute;

  select coalesce(max(consumed) filter (where client_digest = v_global_digest), 0),
         coalesce(max(consumed) filter (where client_digest = v_client_digest), 0)
  into v_global_consumed, v_client_consumed
  from qaspik_runtime.seller_request_budget
  where window_minute = v_window_minute and client_digest in (v_global_digest, v_client_digest);

  if v_global_consumed + p_cost > 240 or v_client_consumed + p_cost > 60 then
    return false;
  end if;

  insert into qaspik_runtime.seller_request_budget (window_minute, client_digest, consumed)
  values (v_window_minute, v_global_digest, v_global_consumed + p_cost),
         (v_window_minute, v_client_digest, v_client_consumed + p_cost)
  on conflict (window_minute, client_digest) do update set consumed = excluded.consumed;

  return true;
end;
$$;

-- The parsed SQL body resolves the private function without granting schema USAGE.
create function public.qaspik_consume_seller_budget(p_secret text, p_client text, p_cost integer)
returns boolean
language sql
security invoker
set search_path = ''
return qaspik_runtime.consume_seller_budget(p_secret, p_client, p_cost);

revoke all on function qaspik_runtime.consume_seller_budget(text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.qaspik_consume_seller_budget(text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function qaspik_runtime.consume_seller_budget(text, text, integer) to anon;
grant execute on function public.qaspik_consume_seller_budget(text, text, integer) to anon;

notify pgrst, 'reload schema';

commit;
