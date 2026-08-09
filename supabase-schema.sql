-- ============================================================================
-- KRAFTED by ANNA — Supabase schema
--
-- Run this once in your Supabase project's SQL Editor (Dashboard → SQL
-- Editor → New query → paste all of this → Run). It creates the three
-- tables, a stock-calculation view, Row Level Security policies, and the
-- database functions that the app calls for checkout/refund/reset.
--
-- DESIGN NOTE ON SECURITY (read this if you're the one maintaining it):
-- Unlike a naive port where the browser writes orders directly to a table,
-- checkout here goes through `create_order()`, a SECURITY DEFINER function.
-- That function re-reads the live product price and live available stock
-- from the database itself before writing anything — so a customer editing
-- their cart's price or quantity in devtools cannot affect what actually
-- gets charged/recorded, because the browser only ever sends
-- {product_id, quantity} pairs; price is never taken from the client.
-- Refunds and the "reset sales history" action are similarly locked behind
-- functions that check auth.uid() IS NOT NULL (i.e. an actual signed-in
-- admin session), independent of anything the client claims.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABLES
-- ----------------------------------------------------------------------------

create table if not exists products (
    id          bigint generated always as identity primary key,
    title       text not null,
    category    text not null,
    -- Must be a positive amount: the Maintenance Panel's price field is
    -- min="1" (no free listings), so the database enforces the same rule
    -- rather than silently allowing 0/negative values that could only
    -- get in via a direct SQL edit or a malformed backup restore.
    price       numeric(10,2) not null check (price > 0),
    stock       integer not null default 0 check (stock >= 0),
    image       text,                       -- base64 data URL, same as before
    date_added  timestamptz not null default now()
);

-- Keeps `category` in sync with CATEGORIES in krafted.js. That JS array
-- is the only thing enforcing the category list client-side (it drives
-- every <select> on the site), so without this constraint a restored
-- backup or a direct SQL edit could insert a category that no filter
-- dropdown can ever select again. If you add a category in krafted.js,
-- add it here too (or this insert/update will start failing).
-- Guarded with drop-if-exists so re-running this file is a no-op once
-- applied, matching the style of the rest of this schema.
alter table products drop constraint if exists products_category_check;
alter table products add constraint products_category_check
    check (category in ('Sewn', 'Crochet'));

create table if not exists orders (
    order_id    text primary key,
    order_date  timestamptz not null default now(),
    items       jsonb not null,             -- [{id, title, category, price, quantity, refunded}, ...]
    total       numeric(10,2) not null
);

create table if not exists sales_log (
    sale_id         text primary key,
    transaction_id  text not null references orders(order_id) on delete cascade,
    -- Deliberately NOT a foreign key to products(id). Sales history must
    -- survive a product being deleted from the catalog -- product_name/
    -- category are captured at sale time precisely so this row stays
    -- meaningful on its own. krafted.js's renderInventoryDashboard()
    -- already handles a since-deleted product_id gracefully (falls back
    -- to "Deleted Product"). Adding a FK here would either cascade-delete
    -- sales history on product removal or block the deletion outright --
    -- both wrong for this app.
    product_id      bigint not null,
    product_name    text,
    category        text,
    quantity        integer not null,
    price           numeric(10,2) not null,
    total_revenue   numeric(10,2) not null,
    sold_at         timestamptz not null default now(),
    refunded        boolean not null default false,
    refunded_at     timestamptz
);

create index if not exists idx_sales_log_transaction on sales_log(transaction_id);
create index if not exists idx_sales_log_product on sales_log(product_id);

-- If this project already had `products` from an earlier version of this
-- schema, `create table if not exists` above left its `id` column as a
-- plain bigint (the client used to generate ids with Date.now()). This
-- upgrades it to an identity column in place, without touching existing
-- rows, so newly added products get a safe auto-assigned id going
-- forward. Guarded so re-running this file is a no-op once done.
do $$
begin
    if not exists (
        select 1 from pg_attribute a
        join pg_class c on a.attrelid = c.oid
        where c.relname = 'products' and a.attname = 'id' and a.attidentity <> ''
    ) then
        alter table products alter column id add generated always as identity;
    end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. AVAILABLE-STOCK VIEW
--    (initial stock minus everything sold and not refunded, across all
--    orders — same math as the old client-side calculateAvailableStock)
-- ----------------------------------------------------------------------------

create or replace view product_stock_available as
select
    p.*,
    greatest(0, p.stock - coalesce(sold.qty, 0))::int as available_stock
from products p
left join (
    select
        (item->>'id')::bigint as product_id,
        sum((item->>'quantity')::int) as qty
    from orders o, jsonb_array_elements(o.items) as item
    where coalesce((item->>'refunded')::boolean, false) = false
    group by (item->>'id')::bigint
) sold on sold.product_id = p.id;

-- ----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
--    - products: anyone can read (storefront); only signed-in admins can
--      write (Maintenance Panel).
--    - orders / sales_log: anyone can read (needed for public stock counts
--      and, if you ever expose order history), but there are NO insert/
--      update/delete policies here on purpose — those tables are only ever
--      written to via the SECURITY DEFINER functions below, which bypass
--      RLS deliberately and re-validate everything server-side. This means
--      even a fully authenticated customer session cannot INSERT into
--      orders/sales_log directly.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 3a. ADMINS TABLE — the actual admin/buyer boundary
--    Everything below used to treat "is signed in" as "is an admin", which
--    is wrong: KRAFTEDregister.html creates ordinary Supabase Auth accounts
--    for customers using that exact same auth system, so a signed-in buyer
--    and a signed-in admin were indistinguishable to every RLS policy and
--    function below. This table is the real boundary — a user is an admin
--    if and only if their auth.users id has a row here. Nothing public can
--    write to it (no insert/update/delete policy at all), so the only way
--    to grant admin access is for you to add the row yourself.
--
--    After creating an admin account (Supabase Dashboard → Authentication →
--    Add user, or having them register normally and you promoting them),
--    run this once per admin, substituting the real email:
--
--      insert into admins (id)
--      select id from auth.users where email = 'admin@example.com';
-- ----------------------------------------------------------------------------

create table if not exists admins (
    id          uuid primary key references auth.users(id) on delete cascade,
    -- 'super_admin' | 'admin'. There is exactly one super_admin -- the
    -- account this schema was set up for -- who alone can add/remove
    -- co-admins and disable/delete accounts (see the functions below).
    -- Regular 'admin' rows get exactly the access admins always had:
    -- Maintenance Panel + Inventory Dashboard, gated by is_admin() same
    -- as before. Defaults to 'admin' so re-running this file against an
    -- existing database never silently promotes anyone.
    role        text not null default 'admin',
    created_at  timestamptz not null default now()
);

alter table admins add column if not exists role text not null default 'admin';
alter table admins drop constraint if exists admins_role_check;
alter table admins add constraint admins_role_check check (role in ('super_admin', 'admin'));

alter table admins enable row level security;

drop policy if exists "admins can read their own row" on admins;
create policy "admins can read their own row"
    on admins for select
    using (auth.uid() = id);

-- No insert/update/delete policy on purpose: the FIRST admin (the
-- super_admin) can only be granted by someone with direct database
-- access (you) -- see the note at the bottom of this section. After
-- that, the super_admin manages everyone else through the app via
-- promote_to_admin()/demote_admin()/set_user_banned()/
-- delete_platform_user() below, never through a client-writable policy
-- on this table.

create or replace function is_admin(p_uid uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
    select p_uid is not null and exists (select 1 from admins where id = p_uid);
$$;

-- authenticated only: an anon (not-signed-in) caller can never have a
-- session, so is_admin() is always false for them and the grant was
-- unused in practice. isCurrentUserAdmin() in krafted.js only calls this
-- after waitForAuthUser() confirms a session exists.
grant execute on function is_admin(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3b. SUPER ADMIN -- one level above is_admin(). Only the super_admin can
--    add/remove co-admins or disable/delete any account, enforced inside
--    each function below (not just in the UI -- see krafted.js's
--    initSuperAdminPanel(), which is a convenience that hides the panel
--    for co-admins, not the actual access control).
--
--    To make the FIRST account a super_admin (there should only ever be
--    one), run once, substituting the real email:
--
--      update admins set role = 'super_admin'
--      where id = (select id from auth.users where email = 'admin@example.com');
--
--    (That account must already have a plain 'admin' row -- see the
--    "Adding an admin" instructions in README.txt / SUPABASE_SETUP_GUIDE.md
--    for creating the first admin row at all.)
-- ----------------------------------------------------------------------------

create or replace function is_super_admin(p_uid uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
    select p_uid is not null and exists (
        select 1 from admins where id = p_uid and role = 'super_admin'
    );
$$;

grant execute on function is_super_admin(uuid) to authenticated;

-- Any signed-in admin can see the co-admin roster (read-only for
-- co-admins in practice, since only the super_admin's client renders
-- add/remove controls) -- the read itself isn't sensitive.
create or replace function list_admins()
returns table(id uuid, email text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not is_admin() then
        raise exception 'Not authorized.';
    end if;

    return query
        select a.id, u.email::text, a.role, a.created_at
        from admins a
        join auth.users u on u.id = a.id
        order by (a.role = 'super_admin') desc, a.created_at asc;
end;
$$;

grant execute on function list_admins() to authenticated;

-- Target account must already exist (register normally, or create one in
-- the dashboard) -- this only grants the admin row, never creates an
-- auth account itself.
create or replace function promote_to_admin(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid;
begin
    if not is_super_admin() then
        raise exception 'Only the main admin can add co-admins.';
    end if;

    select id into v_uid from auth.users where lower(email) = lower(p_email);
    if v_uid is null then
        raise exception 'No account found for that email. They need an account (register at the shop, or create one in the Supabase dashboard) before they can be made a co-admin.';
    end if;

    if exists (select 1 from admins where id = v_uid) then
        raise exception 'That account is already an admin.';
    end if;

    insert into admins (id, role) values (v_uid, 'admin');
end;
$$;

grant execute on function promote_to_admin(text) to authenticated;

-- Can only ever remove role='admin' rows -- the where clause makes it
-- structurally impossible to demote a super_admin through this function,
-- regardless of what id is passed in.
create or replace function demote_admin(p_admin_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not is_super_admin() then
        raise exception 'Only the main admin can remove co-admins.';
    end if;

    delete from admins where id = p_admin_id and role = 'admin';
end;
$$;

grant execute on function demote_admin(uuid) to authenticated;

-- Surfaces auth.users (never otherwise readable by the client -- anon/
-- authenticated have no access to the auth schema at all) joined against
-- admins/buyers so the panel can show everyone: admins, co-admins,
-- buyers, and anyone currently banned.
create or replace function list_platform_users()
returns table(
    id uuid,
    email text,
    admin_role text,
    username text,
    banned boolean,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not is_super_admin() then
        raise exception 'Not authorized.';
    end if;

    return query
        select
            u.id,
            u.email::text,
            a.role as admin_role,
            b.username,
            (u.banned_until is not null and u.banned_until > now()) as banned,
            u.created_at
        from auth.users u
        left join admins a on a.id = u.id
        left join buyers b on b.id = u.id
        order by u.created_at asc;
end;
$$;

grant execute on function list_platform_users() to authenticated;

-- Uses Supabase Auth's own banned_until column (a banned user's session
-- is rejected by GoTrue itself), rather than inventing a parallel
-- "disabled" flag the rest of the auth stack wouldn't know about.
-- Explicitly refuses to act on yourself or on any super_admin, so the
-- main admin account can never be locked out via this panel.
create or replace function set_user_banned(p_user_id uuid, p_banned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not is_super_admin() then
        raise exception 'Only the main admin can disable or re-enable accounts.';
    end if;

    if p_user_id = auth.uid() then
        raise exception 'You cannot disable your own account.';
    end if;

    if exists (select 1 from admins where id = p_user_id and role = 'super_admin') then
        raise exception 'The main admin account cannot be disabled.';
    end if;

    update auth.users
    set banned_until = case when p_banned then 'infinity'::timestamptz else null end
    where id = p_user_id;
end;
$$;

grant execute on function set_user_banned(uuid, boolean) to authenticated;

-- Deletes the auth.users row; admins.id and buyers.id both reference
-- auth.users(id) on delete cascade, so their admin/buyer row goes with
-- it automatically. Orders/sales_log are deliberately NOT tied to a user
-- id at all (see the note on sales_log.product_id above), so deleting an
-- account never touches sales history.
create or replace function delete_platform_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not is_super_admin() then
        raise exception 'Only the main admin can delete accounts.';
    end if;

    if p_user_id = auth.uid() then
        raise exception 'You cannot delete your own account.';
    end if;

    if exists (select 1 from admins where id = p_user_id and role = 'super_admin') then
        raise exception 'The main admin account cannot be deleted.';
    end if;

    delete from auth.users where id = p_user_id;
end;
$$;

grant execute on function delete_platform_user(uuid) to authenticated;

alter table products enable row level security;
alter table orders enable row level security;
alter table sales_log enable row level security;

drop policy if exists "products are publicly readable" on products;
create policy "products are publicly readable"
    on products for select
    using (true);

drop policy if exists "only admins can write products" on products;
create policy "only admins can write products"
    on products for all
    using (is_admin())
    with check (is_admin());

drop policy if exists "orders are publicly readable" on orders;
create policy "orders are publicly readable"
    on orders for select
    using (true);

drop policy if exists "sales_log is publicly readable" on sales_log;
create policy "sales_log is publicly readable"
    on sales_log for select
    using (true);

-- NOTE: orders and sales_log intentionally have NO insert/update/delete
-- policy at all -- not even for signed-in admins. Every write to these
-- two tables goes through a SECURITY DEFINER function (create_order,
-- refund_sale, reset_sales_data, restore_backup below), which bypasses
-- RLS and re-validates everything itself. This closes a gap in the
-- previous version of this schema, where a signed-in admin session could
-- have been used to write arbitrary rows directly to these tables (e.g.
-- forging a "sale" with any revenue figure) via the client library,
-- bypassing create_order's price/stock validation entirely. Restoring
-- from a backup now goes through restore_backup() instead of a client-
-- side bulk delete+insert, so no direct table policy is needed for it.

-- ----------------------------------------------------------------------------
-- 4. CHECKOUT FUNCTION
--    Client calls: supabase.rpc('create_order', { p_items: [{id, quantity}, ...] })
--    Only product id + requested quantity are ever sent by the browser.
--    Price, title, category, and the stock check all come from the live
--    `products` table / `product_stock_available` view inside this function.
-- ----------------------------------------------------------------------------

create or replace function create_order(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_item          jsonb;
    v_product_id    bigint;
    v_qty           integer;
    v_product       record;
    v_order_id      text;
    v_built_items   jsonb := '[]'::jsonb;
    v_total         numeric(10,2) := 0;
    v_now           timestamptz := now();
    v_sale_id       text;
begin
    if p_items is null or jsonb_array_length(p_items) = 0 then
        raise exception 'Cart is empty.';
    end if;

    v_order_id := 'ORD-' || to_char(v_now, 'YYMMDDHH24MISS') || '-' || upper(substr(md5(random()::text), 1, 4));

    for v_item in select * from jsonb_array_elements(p_items)
    loop
        v_product_id := (v_item->>'id')::bigint;
        v_qty := (v_item->>'quantity')::int;

        if v_qty is null or v_qty <= 0 then
            raise exception 'Invalid quantity for product %', v_product_id;
        end if;

        -- Lock the product row first (SELECT ... FOR UPDATE on the base
        -- table, not the view) so two concurrent checkouts for the same
        -- product can't both read "1 available" and both succeed. The
        -- second transaction blocks here until the first one commits or
        -- rolls back, then re-reads a stock figure that already accounts
        -- for it. Without this lock, two customers buying the last unit
        -- at the same moment could both pass the check below (classic
        -- check-then-act race) and the shop would oversell.
        perform 1 from products where id = v_product_id for update;

        select * into v_product from product_stock_available where id = v_product_id;

        if v_product is null then
            raise exception 'Product % is no longer available.', v_product_id;
        end if;

        if v_qty > v_product.available_stock then
            raise exception 'Only % unit(s) of "%" left in stock.', v_product.available_stock, v_product.title;
        end if;

        v_built_items := v_built_items || jsonb_build_object(
            'id', v_product.id,
            'title', v_product.title,
            'category', v_product.category,
            'price', v_product.price,
            'quantity', v_qty,
            'refunded', false
        );

        v_total := v_total + (v_product.price * v_qty);
    end loop;

    insert into orders (order_id, order_date, items, total)
    values (v_order_id, v_now, v_built_items, v_total);

    for v_item in select * from jsonb_array_elements(v_built_items)
    loop
        v_sale_id := v_order_id || '-' || (v_item->>'id');
        insert into sales_log (sale_id, transaction_id, product_id, product_name, category, quantity, price, total_revenue, sold_at, refunded)
        values (
            v_sale_id,
            v_order_id,
            (v_item->>'id')::bigint,
            v_item->>'title',
            v_item->>'category',
            (v_item->>'quantity')::int,
            (v_item->>'price')::numeric,
            (v_item->>'price')::numeric * (v_item->>'quantity')::int,
            v_now,
            false
        );
    end loop;

    return jsonb_build_object('order_id', v_order_id, 'items', v_built_items, 'total', v_total, 'order_date', v_now);
end;
$$;

grant execute on function create_order(jsonb) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. REFUND FUNCTION — admin only
-- ----------------------------------------------------------------------------

create or replace function refund_sale(p_transaction_id text, p_product_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_items jsonb;
    v_updated jsonb;
    v_now timestamptz := now();
begin
    if not is_admin() then
        raise exception 'Not authorized.';
    end if;

    select items into v_items from orders where order_id = p_transaction_id for update;
    if v_items is null then
        raise exception 'Order not found.';
    end if;

    select jsonb_agg(
        case
            when (elem->>'id')::bigint = p_product_id and coalesce((elem->>'refunded')::boolean, false) = false
                then elem || jsonb_build_object('refunded', true)
            else elem
        end
    ) into v_updated
    from jsonb_array_elements(v_items) as elem;

    update orders set items = v_updated where order_id = p_transaction_id;

    update sales_log
    set refunded = true, refunded_at = v_now
    where transaction_id = p_transaction_id
      and product_id = p_product_id
      and refunded = false;
end;
$$;

grant execute on function refund_sale(text, bigint) to authenticated;

-- ----------------------------------------------------------------------------
-- 5b. CANCEL ORDER FUNCTION — admin only
--    Sibling to refund_sale() above, but voids every non-refunded item in
--    an order at once instead of one product line at a time. Same admin
--    bar as refund_sale() -- is_admin(), not is_super_admin() -- so any
--    co-admin can cancel a transaction, matching the existing per-item
--    refund permission level. Locks the order row first (same reasoning
--    as create_order()'s stock lock), so a concurrent single-item refund
--    on the same order can't race with a full cancellation.
-- ----------------------------------------------------------------------------

create or replace function cancel_order(p_transaction_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_items jsonb;
    v_updated jsonb;
    v_now timestamptz := now();
begin
    if not is_admin() then
        raise exception 'Not authorized.';
    end if;

    select items into v_items from orders where order_id = p_transaction_id for update;
    if v_items is null then
        raise exception 'Order not found.';
    end if;

    if not exists (
        select 1 from jsonb_array_elements(v_items) as elem
        where coalesce((elem->>'refunded')::boolean, false) = false
    ) then
        raise exception 'This order has already been fully cancelled/refunded.';
    end if;

    select jsonb_agg(
        case
            when coalesce((elem->>'refunded')::boolean, false) = false
                then elem || jsonb_build_object('refunded', true)
            else elem
        end
    ) into v_updated
    from jsonb_array_elements(v_items) as elem;

    update orders set items = v_updated where order_id = p_transaction_id;

    update sales_log
    set refunded = true, refunded_at = v_now
    where transaction_id = p_transaction_id
      and refunded = false;
end;
$$;

grant execute on function cancel_order(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. RESET SALES HISTORY FUNCTION — admin only
--    Clears orders + sales_log, leaves the product catalog untouched.
-- ----------------------------------------------------------------------------

create or replace function reset_sales_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not is_admin() then
        raise exception 'Not authorized.';
    end if;

    -- Supabase's Postgres has the pg-safeupdate extension enabled, which
    -- rejects any DELETE/UPDATE with no WHERE clause (a guard against
    -- accidentally wiping a table). "where true" is a no-op condition
    -- that matches every row, so it deletes everything while still
    -- satisfying that check.
    delete from sales_log where true;
    delete from orders where true;
end;
$$;

grant execute on function reset_sales_data() to authenticated;

-- ----------------------------------------------------------------------------
-- 6b. RESTORE FROM BACKUP FUNCTION — admin only
--    Replaces the client-side saveStoredProducts/saveStoredOrders/
--    saveStoredSalesLog sequence (three separate delete+insert round
--    trips with no rollback if one failed partway through) with a single
--    server-side transaction: either the whole restore applies, or none
--    of it does. Also means orders/sales_log no longer need a direct
--    client-writable RLS policy just to support this one feature.
--
--    p_products / p_orders / p_sales_log are JSON arrays shaped like the
--    "products" / "orders" / "salesLog" arrays in a downloaded backup
--    file. Product ids in the backup are preserved via OVERRIDING SYSTEM
--    VALUE (products.id is now an identity column, see section 1).
-- ----------------------------------------------------------------------------

create or replace function restore_backup(p_products jsonb, p_orders jsonb, p_sales_log jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not is_admin() then
        raise exception 'Not authorized.';
    end if;

    -- See the note in reset_sales_data() above -- pg-safeupdate requires
    -- an explicit WHERE clause even for a full-table delete.
    delete from sales_log where true;
    delete from orders where true;
    delete from products where true;

    insert into products (id, title, category, price, stock, image, date_added)
    overriding system value
    select
        (p->>'id')::bigint,
        p->>'title',
        p->>'category',
        (p->>'price')::numeric,
        (p->>'stock')::int,
        p->>'image',
        coalesce((p->>'dateAdded')::timestamptz, now())
    from jsonb_array_elements(p_products) as p;

    -- Keep products' identity sequence ahead of any restored ids so the
    -- next admin-added product doesn't collide with a restored one.
    perform setval(
        pg_get_serial_sequence('products', 'id'),
        greatest(coalesce((select max(id) from products), 0), 1)
    );

    insert into orders (order_id, order_date, items, total)
    select
        o->>'orderId',
        coalesce((o->>'date')::timestamptz, now()),
        o->'items',
        (o->>'total')::numeric
    from jsonb_array_elements(p_orders) as o;

    insert into sales_log (sale_id, transaction_id, product_id, product_name, category, quantity, price, total_revenue, sold_at, refunded, refunded_at)
    select
        s->>'saleId',
        s->>'transactionId',
        (s->>'productId')::bigint,
        s->>'productName',
        s->>'category',
        (s->>'quantity')::int,
        (s->>'price')::numeric,
        (s->>'totalRevenue')::numeric,
        coalesce((s->>'soldAt')::timestamptz, now()),
        coalesce((s->>'refunded')::boolean, false),
        (s->>'refundedAt')::timestamptz
    from jsonb_array_elements(p_sales_log) as s;
end;
$$;

grant execute on function restore_backup(jsonb, jsonb, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 7b. BUYER (CUSTOMER) ACCOUNTS
--    Buyers register through KRAFTEDregister.html via sb.auth.signUp(),
--    the same underlying Supabase Auth mechanism the admin login uses --
--    but this is a separate population of users. A buyer account never
--    gets admin/write access to products, refunds, or the sales log:
--    those RLS policies and functions above now check is_admin(), which
--    keys off membership in the `admins` table (section 3a), not merely
--    "is signed in". A buyer who registers here has no row in `admins`,
--    so is_admin() is false for them regardless of how they got a
--    session -- including via KRAFTEDlog.html, the admin login form.
--
--    Username + contact number are passed in as auth metadata
--    (auth.signUp({ options: { data: {...} } })), and the trigger below
--    copies them into this table the instant the auth.users row is
--    created. Doing it via trigger (rather than the browser inserting a
--    row right after signUp) means it still works correctly even when
--    your project's email-confirmation setting means the browser does
--    NOT get a live session back immediately after signUp.
-- ----------------------------------------------------------------------------

create table if not exists buyers (
    id              uuid primary key references auth.users(id) on delete cascade,
    username        text not null,
    contact_number  text,
    email           text,
    created_at      timestamptz not null default now()
);

-- Case-insensitive uniqueness ("Anna" and "anna" count as the same name).
create unique index if not exists idx_buyers_username_lower on buyers (lower(username));

alter table buyers enable row level security;

drop policy if exists "buyers can read their own profile" on buyers;
create policy "buyers can read their own profile"
    on buyers for select
    using (auth.uid() = id);

drop policy if exists "buyers can update their own profile" on buyers;
create policy "buyers can update their own profile"
    on buyers for update
    using (auth.uid() = id)
    with check (auth.uid() = id);

-- No client-facing INSERT policy on purpose: rows are only ever created
-- by the trigger below (SECURITY DEFINER, bypasses RLS), never written
-- directly by the browser.

create or replace function handle_new_buyer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.buyers (id, username, contact_number, email)
    values (
        new.id,
        coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
        new.raw_user_meta_data->>'contact_number',
        new.email
    );
    return new;
exception
    when unique_violation then
        raise exception 'That username is already taken.';
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function handle_new_buyer();

-- Lets the registration page check "is this username free?" before
-- calling auth.signUp(), without exposing the full buyers table (which
-- RLS above otherwise keeps private to each buyer) to anonymous visitors.
create or replace function username_is_taken(p_username text)
returns boolean
language sql
security definer
set search_path = public
as $$
    select exists (
        select 1 from buyers where lower(username) = lower(p_username)
    );
$$;

grant execute on function username_is_taken(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. REALTIME
--    Lets the storefront/dashboard get live updates the same way the
--    Firestore onSnapshot listeners did. Wrapped in existence checks so
--    this file can be re-run safely -- `alter publication ... add table`
--    has no "if not exists" form and errors if the table is already a
--    publication member, unlike every other statement in this file.
-- ----------------------------------------------------------------------------

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'products'
    ) then
        alter publication supabase_realtime add table products;
    end if;

    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
    ) then
        alter publication supabase_realtime add table orders;
    end if;

    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sales_log'
    ) then
        alter publication supabase_realtime add table sales_log;
    end if;
end $$;
