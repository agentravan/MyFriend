-- NOVA schema (applied to the Supabase project). After running, set the secret:
--   insert into private.config(key, value) values ('api_secret', '<same as NOVA_DB_SECRET>');
create schema if not exists private;
create table private.config (key text primary key, value text not null);
revoke all on schema private from anon, authenticated;
create or replace function private.nova_ok() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((current_setting('request.headers', true)::json ->> 'x-nova-key') =
    (select value from private.config where key = 'api_secret'), false) $$;
revoke all on function private.nova_ok() from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.nova_ok() to anon, authenticated;

create table public.messages (id bigint generated always as identity primary key, role text not null check (role in ('user','assistant')), content text not null, at timestamptz not null default now());
create table public.memory (id bigint generated always as identity primary key, fact text not null, at timestamptz not null default now());
create table public.proposals (id bigint generated always as identity primary key, kind text not null check (kind in ('idea','addendum','trade')), title text not null, body text not null default '', payload jsonb not null default '{}', status text not null default 'pending' check (status in ('pending','approved','rejected')), reason text, at timestamptz not null default now(), decided_at timestamptz);
create table public.trades (id bigint generated always as identity primary key, symbol text not null, entry numeric not null, stop numeric not null, target numeric not null, thesis text, status text not null default 'open' check (status in ('open','win','loss')), exit numeric, opened_at timestamptz not null default now(), closed_at timestamptz);
create table public.ledger (id bigint generated always as identity primary key, amount numeric not null, note text not null default '', at timestamptz not null default now());
create table public.addenda (id bigint generated always as identity primary key, text text not null, at timestamptz not null default now());
create table public.watchlist (symbol text primary key, at timestamptz not null default now());
create table public.digests (id bigint generated always as identity primary key, day date not null unique default (now() at time zone 'Asia/Kolkata')::date, summary text not null, at timestamptz not null default now());

do $$ declare t text; begin
  foreach t in array array['messages','memory','proposals','trades','ledger','addenda','watchlist','digests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy nova_gate on public.%I for all to anon, authenticated using ((select private.nova_ok())) with check ((select private.nova_ok()))', t);
  end loop;
end $$;
create index on public.proposals (status, at desc);
create index on public.messages (at desc);
