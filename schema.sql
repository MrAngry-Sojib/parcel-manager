-- =====================================================================
-- Smart Parcel & Order Slip Management  —  Supabase / PostgreSQL schema
-- =====================================================================
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run. It is safe to run more than once (idempotent).
--
-- SECURITY MODEL (one shop, one account, many phones)
--   * Every table has Row Level Security (RLS) enabled.
--   * Only a user whose row in public.profiles is active ("shop member")
--     can read or change shop data. The FIRST user ever created becomes the
--     owner and is active. Anybody created later is inactive and sees
--     nothing, even if sign-ups are accidentally left enabled.
--   * The `anon` role has NO access to any table.
--   * Orders are created/edited only through the functions create_order()
--     and update_order(); clients cannot INSERT into orders directly, so the
--     Order ID can never be chosen or forged by the browser.
--   * The service_role key is never used or needed by the frontend.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;   -- fast ILIKE search

-- ---------------------------------------------------------------------
-- 1. PROFILES  (who may use the shop)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  role        text        not null default 'member' check (role in ('owner', 'member')),
  is_active   boolean     not null default false,
  created_at  timestamptz not null default now()
);

-- Create a profile whenever a user is created. First user = active owner.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first boolean;
begin
  perform pg_advisory_xact_lock(727001);               -- serialize the "first user" check
  v_first := not exists (select 1 from public.profiles where role = 'owner');
  insert into public.profiles (id, email, role, is_active)
  values (new.id, new.email, case when v_first then 'owner' else 'member' end, v_first)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- If you created your user BEFORE running this file, back-fill profiles now.
insert into public.profiles (id, email, role, is_active)
select u.id,
       u.email,
       case when row_number() over (order by u.created_at) = 1 then 'owner' else 'member' end,
       row_number() over (order by u.created_at) = 1
from auth.users u
where not exists (select 1 from public.profiles)          -- only when nothing exists yet
on conflict (id) do nothing;

-- Helper used by every RLS policy.
create or replace function public.is_shop_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.is_active
  );
$$;

-- ---------------------------------------------------------------------
-- 2. SHOP SETTINGS  (exactly one row, id = 1, shared by all devices)
-- ---------------------------------------------------------------------
create table if not exists public.shop_settings (
  id                  integer primary key default 1 check (id = 1),
  shop_name           text not null default 'Your Shop Name',
  tagline             text not null default 'Home Decorate | Kids Toy | Gadget',
  logo_path           text,                              -- object path in bucket shop-assets
  qr_path             text,                              -- object path in bucket shop-assets
  sender_name         text not null default 'Your Shop Name',
  sender_mobile       text not null default '01XXXXXXXXX',
  sender_address      text not null default 'Your full shop address',
  sender_village      text not null default 'Village / Area',
  sender_post_office  text not null default 'Post Office',
  sender_post_code    text not null default '0000',
  sender_thana        text not null default 'Thana / Upazila',
  sender_district     text not null default 'District',
  label_width_mm      numeric(6,1) not null default 100 check (label_width_mm  between 40 and 300),
  label_height_mm     numeric(6,1) not null default 150 check (label_height_mm between 40 and 400),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null
);

insert into public.shop_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 3. ORDER ID ALLOCATION  (database side, cryptographically random)
-- ---------------------------------------------------------------------
-- Format: SP-BW + 6 random digits  (e.g. SP-BW583921)
--   * Random bytes come from gen_random_uuid(), which PostgreSQL draws from
--     its strong random source (same quality as pgcrypto).
--   * Unbiased: values are rejection-sampled before the modulo.
--   * Every issued ID is recorded in order_id_registry and NEVER removed, so
--     an ID is never handed out twice, even after the order is deleted
--     (a printed parcel can never clash with a newer order).
--   * order_id also carries a UNIQUE constraint on the orders table.
--   * Capacity: 6 digits = 1,000,000 IDs. If 12 random attempts in a row
--     collide (namespace is getting crowded, roughly 70%+ used), the digit
--     count in order_id_config is raised by one (SP-BW + 7 digits, up to 9).
--     Old IDs stay valid. IDs are never reused, so duplicates are impossible.

create table if not exists public.order_id_config (
  id      integer primary key default 1 check (id = 1),
  digits  integer not null default 6 check (digits between 6 and 9)
);
insert into public.order_id_config (id, digits) values (1, 6) on conflict (id) do nothing;

create table if not exists public.order_id_registry (
  order_id   text primary key,
  issued_at  timestamptz not null default now()
);

create or replace function public.allocate_order_id()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_digits integer;
  v_mod    bigint;
  v_limit  bigint;
  v_val    bigint;
  v_bytes  bytea;
  v_id     text;
  v_fail   integer := 0;
begin
  select digits into v_digits from public.order_id_config where id = 1;
  v_mod   := (10::bigint ^ v_digits)::bigint;
  v_limit := (4294967296::bigint / v_mod) * v_mod;       -- largest multiple of v_mod below 2^32

  loop
    -- unbiased random number in [0, v_mod)
    loop
      v_bytes := pg_catalog.uuid_send(pg_catalog.gen_random_uuid());
      v_val := get_byte(v_bytes, 0)::bigint * 16777216
             + get_byte(v_bytes, 1)::bigint * 65536
             + get_byte(v_bytes, 2)::bigint * 256
             + get_byte(v_bytes, 3)::bigint;
      exit when v_val < v_limit;
    end loop;

    v_id := 'SP-BW' || lpad((v_val % v_mod)::text, v_digits, '0');

    insert into public.order_id_registry (order_id) values (v_id) on conflict do nothing;
    if found then
      return v_id;                                         -- reserved atomically
    end if;

    v_fail := v_fail + 1;
    if v_fail >= 12 then                                   -- crowded: expand the namespace
      if v_digits >= 9 then
        raise exception 'Order ID namespace exhausted' using errcode = '53400';
      end if;
      update public.order_id_config set digits = digits + 1 where id = 1 and digits = v_digits;
      select digits into v_digits from public.order_id_config where id = 1;
      v_mod   := (10::bigint ^ v_digits)::bigint;
      v_limit := (4294967296::bigint / v_mod) * v_mod;
      v_fail  := 0;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. ORDERS + ORDER ITEMS
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  order_id           text not null unique check (order_id ~ '^SP-BW[0-9]{6,9}$'),
  client_request_id  uuid unique,                        -- makes "Save" safe to retry (no duplicates)
  customer_name      text not null check (char_length(btrim(customer_name)) between 1 and 120),
  mobile             text not null check (char_length(btrim(mobile)) between 1 and 200),
  village            text not null,
  post_office        text not null,
  post_code          text not null,
  thana              text not null,
  district           text not null,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,
  position      integer not null default 1,
  product_name  text not null check (char_length(btrim(product_name)) between 1 and 200),
  quantity      integer not null check (quantity between 1 and 9999),
  unique (order_id, position)
);

-- Indexes
create index if not exists orders_created_at_idx   on public.orders (created_at desc);
create index if not exists orders_name_trgm_idx    on public.orders using gin (customer_name extensions.gin_trgm_ops);
create index if not exists orders_mobile_trgm_idx  on public.orders using gin (mobile extensions.gin_trgm_ops);
create index if not exists orders_oid_trgm_idx     on public.orders using gin (order_id extensions.gin_trgm_ops);
create index if not exists order_items_order_idx   on public.order_items (order_id);

-- Timestamps
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

create or replace function public.set_settings_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

drop trigger if exists shop_settings_audit on public.shop_settings;
create trigger shop_settings_audit before update on public.shop_settings
  for each row execute function public.set_settings_audit();

-- The Order ID is permanent: editing, reprinting or any UPDATE can never change it.
create or replace function public.protect_order_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.order_id is distinct from old.order_id then
    raise exception 'Order ID cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_protect_order_id on public.orders;
create trigger orders_protect_order_id before update on public.orders
  for each row execute function public.protect_order_id();

-- ---------------------------------------------------------------------
-- 5. ORDER FUNCTIONS (the only way to write orders)
-- ---------------------------------------------------------------------
create or replace function public._check_order_payload(p_order jsonb, p_items jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  k     text;
  v     text;
  v_max integer;
  e     jsonb;
begin
  if p_order is null or jsonb_typeof(p_order) <> 'object' then
    raise exception 'Invalid order data' using errcode = '22023';
  end if;

  foreach k in array array['customer_name','mobile','village','post_office','post_code','thana','district'] loop
    v := btrim(coalesce(p_order ->> k, ''));
    if v = '' then
      raise exception 'Field "%" is required', k using errcode = '22023';
    end if;
    v_max := case when k = 'customer_name' then 120 else 200 end;
    if char_length(v) > v_max then
      raise exception 'Field "%" is too long', k using errcode = '22023';
    end if;
  end loop;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'Add between 1 and 50 products' using errcode = '22023';
  end if;

  for e in select * from jsonb_array_elements(p_items) loop
    if btrim(coalesce(e ->> 'product_name', '')) = '' or char_length(e ->> 'product_name') > 200 then
      raise exception 'Every product needs a name (max 200 characters)' using errcode = '22023';
    end if;
    if coalesce(e ->> 'quantity', '') !~ '^[0-9]{1,4}$' or (e ->> 'quantity')::int < 1 then
      raise exception 'Quantity must be a whole number from 1 to 9999' using errcode = '22023';
    end if;
  end loop;
end;
$$;

create or replace function public.order_to_json(o public.orders)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select to_jsonb(o) || jsonb_build_object(
    'items',
    coalesce((
      select jsonb_agg(jsonb_build_object('product_name', i.product_name, 'quantity', i.quantity)
                       order by i.position)
      from public.order_items i where i.order_id = o.id
    ), '[]'::jsonb)
  );
$$;

-- Create an order. Allocates the permanent random Order ID atomically.
-- p_request_id: a UUID made by the browser per "Save" attempt. If the same
-- request is sent again (network retry, double tap) the ORIGINAL order is
-- returned instead of creating a second one.
create or replace function public.create_order(p_order jsonb, p_items jsonb, p_request_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.orders;
  v_oid text;
begin
  if not public.is_shop_member() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  perform public._check_order_payload(p_order, p_items);

  if p_request_id is not null then
    select * into v_row from public.orders where client_request_id = p_request_id;
    if found then
      return public.order_to_json(v_row);
    end if;
  end if;

  v_oid := public.allocate_order_id();

  begin
    insert into public.orders
      (order_id, client_request_id, customer_name, mobile, village, post_office, post_code, thana, district, created_by)
    values
      (v_oid, p_request_id,
       btrim(p_order ->> 'customer_name'), btrim(p_order ->> 'mobile'),
       btrim(p_order ->> 'village'),       btrim(p_order ->> 'post_office'),
       btrim(p_order ->> 'post_code'),     btrim(p_order ->> 'thana'),
       btrim(p_order ->> 'district'),      (select auth.uid()))
    returning * into v_row;
  exception when unique_violation then
    -- the same request was submitted twice at the same instant
    select * into v_row from public.orders where client_request_id = p_request_id;
    if not found then
      raise;
    end if;
    return public.order_to_json(v_row);
  end;

  insert into public.order_items (order_id, position, product_name, quantity)
  select v_row.id, t.ord::int, btrim(t.e ->> 'product_name'), (t.e ->> 'quantity')::int
  from jsonb_array_elements(p_items) with ordinality as t(e, ord);

  return public.order_to_json(v_row);
end;
$$;

-- Edit an order (customer fields + all product rows, atomically). order_id is untouched.
create or replace function public.update_order(p_id uuid, p_order jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.orders;
begin
  if not public.is_shop_member() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  perform public._check_order_payload(p_order, p_items);

  update public.orders set
    customer_name = btrim(p_order ->> 'customer_name'),
    mobile        = btrim(p_order ->> 'mobile'),
    village       = btrim(p_order ->> 'village'),
    post_office   = btrim(p_order ->> 'post_office'),
    post_code     = btrim(p_order ->> 'post_code'),
    thana         = btrim(p_order ->> 'thana'),
    district      = btrim(p_order ->> 'district')
  where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  delete from public.order_items where order_id = p_id;
  insert into public.order_items (order_id, position, product_name, quantity)
  select p_id, t.ord::int, btrim(t.e ->> 'product_name'), (t.e ->> 'quantity')::int
  from jsonb_array_elements(p_items) with ordinality as t(e, ord);

  return public.order_to_json(v_row);
end;
$$;

-- ---------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.shop_settings     enable row level security;
alter table public.orders            enable row level security;
alter table public.order_items       enable row level security;
alter table public.order_id_config   enable row level security;   -- no policies = no client access
alter table public.order_id_registry enable row level security;   -- no policies = no client access

-- profiles: a user can read only their own profile (used to check access at login)
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

-- shop_settings: members read + update (the single row is created by this script)
drop policy if exists settings_select on public.shop_settings;
create policy settings_select on public.shop_settings
  for select to authenticated using ((select public.is_shop_member()));

drop policy if exists settings_update on public.shop_settings;
create policy settings_update on public.shop_settings
  for update to authenticated
  using ((select public.is_shop_member()))
  with check ((select public.is_shop_member()));

-- orders / order_items: members read; members delete orders. Writes go through the functions above.
drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders
  for select to authenticated using ((select public.is_shop_member()));

drop policy if exists orders_delete on public.orders;
create policy orders_delete on public.orders
  for delete to authenticated using ((select public.is_shop_member()));

drop policy if exists order_items_select on public.order_items;
create policy order_items_select on public.order_items
  for select to authenticated using ((select public.is_shop_member()));

-- ---------------------------------------------------------------------
-- 7. PRIVILEGES  (least privilege: anon gets nothing)
-- ---------------------------------------------------------------------
revoke all on table public.profiles, public.shop_settings, public.orders, public.order_items,
                    public.order_id_config, public.order_id_registry
  from anon, authenticated;

grant select         on public.profiles      to authenticated;
grant select, update on public.shop_settings to authenticated;
grant select, delete on public.orders        to authenticated;
grant select         on public.order_items   to authenticated;

revoke all on function public.is_shop_member()                    from public, anon;
revoke all on function public.create_order(jsonb, jsonb, uuid)    from public, anon;
revoke all on function public.update_order(uuid, jsonb, jsonb)    from public, anon;
revoke all on function public.allocate_order_id()                 from public, anon, authenticated;
revoke all on function public._check_order_payload(jsonb, jsonb)  from public, anon, authenticated;
revoke all on function public.order_to_json(public.orders)        from public, anon, authenticated;
revoke all on function public.handle_new_user()                   from public, anon, authenticated;

grant execute on function public.is_shop_member()                 to authenticated;
grant execute on function public.create_order(jsonb, jsonb, uuid) to authenticated;
grant execute on function public.update_order(uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 8. REALTIME  (orders and settings sync live between phones)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['orders', 'order_items', 'shop_settings'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;                                              -- already published
      end;
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. STORAGE  (logo + Facebook QR images)
-- ---------------------------------------------------------------------
-- Public-read bucket (the logo and QR are printed on parcels anyway), but
-- only shop members can upload, replace or delete. 2 MB limit, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-assets', 'shop-assets', true, 2097152, array['image/png', 'image/jpeg', 'image/svg+xml'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists shop_assets_select on storage.objects;
create policy shop_assets_select on storage.objects
  for select to authenticated
  using (bucket_id = 'shop-assets' and (select public.is_shop_member()));

drop policy if exists shop_assets_insert on storage.objects;
create policy shop_assets_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'shop-assets' and (select public.is_shop_member()));

drop policy if exists shop_assets_update on storage.objects;
create policy shop_assets_update on storage.objects
  for update to authenticated
  using (bucket_id = 'shop-assets' and (select public.is_shop_member()))
  with check (bucket_id = 'shop-assets' and (select public.is_shop_member()));

drop policy if exists shop_assets_delete on storage.objects;
create policy shop_assets_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'shop-assets' and (select public.is_shop_member()));

-- =====================================================================
-- Handy admin queries (run manually in the SQL Editor when needed)
--   How many IDs are used:   select count(*) from public.order_id_registry;
--   Current digit length:    select digits from public.order_id_config;
--   Who can log in:          select email, role, is_active from public.profiles;
-- =====================================================================
