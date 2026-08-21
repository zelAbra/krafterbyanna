KRAFTED — Backend: Supabase (Postgres)

This project runs on Supabase, not Firebase. If you're setting this up for
the first time, follow SUPABASE_SETUP_GUIDE.md — it walks through creating
the project, running supabase-schema.sql, enabling email/password auth,
and filling in supabase-config.js. This file is just a quick orientation.

---

Why a real database instead of browser storage

Product data, orders, and the sales log live in Supabase (Postgres +
PostgREST + Realtime), not in localStorage/IndexedDB. That means every
device — a customer's phone, Anna's laptop, a second staff member's
tablet — reads and writes the same data, and changes on one device show
up live on the others via Supabase Realtime subscriptions.

---

What lives where

  supabase-config.js       Project URL + anon/public API key. Safe to be
                            public — it only tells the browser which
                            project to talk to, it's not a secret.
  supabase-schema.sql       Tables, Row Level Security policies, and the
                            database functions (create_order, refund_sale,
                            reset_sales_data, restore_backup, etc.) that
                            the app calls. Source of truth for the data
                            model — see the comments inside it before
                            changing anything in krafted.js that touches
                            the database.
  krafted.js                 Storage layer + all page logic. Talks to
                            Supabase via the `sb` client from
                            supabase-config.js.
  KRAFTED.html                Public storefront.
  KRAFTEDlogin.html            One login form for both admins and
                            customers (real Supabase Auth accounts).
                            Signing in successfully is not enough by
                            itself — the account must also have a row in
                            the `admins` table (see schema) to reach the
                            panels below; otherwise it's treated as an
                            ordinary customer account.
  KRAFTEDregister.html         Customer signup (real Supabase Auth
                            accounts, no admin access).
  KRAFTEDaccount.html           Account Settings. Available to any
                            signed-in user (buyer or admin). Buyers can
                            edit their username/contact number; everyone
                            can change their password (re-verified via a
                            reauthentication step before the change goes
                            through).
  KRAFTEDMP.html               Maintenance Panel (add/remove products,
                            backup/restore). Admin-only.
  KRAFTEDinv.html               Inventory & Sales Dashboard. Admin-only.

---

Security model, in short

- Admin status is a real row in the `admins` table, checked server-side
  via is_admin() — not just "is someone signed in." Customers get
  ordinary Supabase Auth accounts through KRAFTEDregister.html using the
  exact same auth system, so this distinction matters.
- Checkout, refunds, cancelling a whole transaction, resetting sales
  history, and restoring a backup all go through SECURITY DEFINER
  Postgres functions, not direct table writes from the browser. The
  browser only ever sends
  {product id, quantity} at checkout; price and stock are re-read from
  the live database inside the function, so editing the cart in devtools
  can't change what actually gets charged or recorded.
- The Inventory Dashboard's sales log has two related but distinct admin
  actions: Refund voids a single line item within an order; Cancel
  Transaction (shown once per order) voids every non-refunded item in
  that order in one atomic call. Both check is_admin() the same way, so
  any co-admin can use either — this isn't restricted to the main admin.
- Row Level Security (defined in supabase-schema.sql) is the actual
  access-control layer. The krafted_is_logged_in localStorage flag some
  pages check on load is only there so protected pages can redirect
  instantly without a network round-trip — it is not what protects the
  data.

---

Admin roles: main admin vs. co-admin

There are two kinds of admin row now, distinguished by `admins.role`:

  - super_admin  The main admin -- currently tomas.anna29@gmail.com, the
                 only account with this role. Gets everything a regular
                 admin gets, PLUS a "Admin Team" and "User Accounts"
                 section at the bottom of the Maintenance Panel (only
                 she sees this section) where she can add/remove
                 co-admins and disable/delete any non-main-admin account.
  - admin        A regular co-admin. Same Maintenance Panel + Inventory
                 Dashboard access as before. Cannot see or use the main
                 admin's user-management panel, and every RPC it would
                 call (promote_to_admin, demote_admin, set_user_banned,
                 delete_platform_user) checks is_super_admin() server-
                 side, so a co-admin calling them directly (e.g. from the
                 browser console) is rejected regardless of what the UI
                 shows.

There is still no public "become an admin" flow, on purpose. Adding the
FIRST admin (which is then promoted to super_admin) still requires
direct database access:

    insert into admins (id)
    select id from auth.users where email = 'admin@example.com';

    update admins set role = 'super_admin'
    where id = (select id from auth.users where email = 'admin@example.com');

After that one-time setup, the super_admin adds every subsequent
co-admin from the Maintenance Panel itself -- no SQL needed.

Disabling vs. deleting an account (from the main admin's panel)

  - Disable   Instantly blocks sign-in (uses Supabase Auth's own
              banned_until) without touching any of their data. Re-
              enabling is one click. Cannot be used on your own account
              or the main admin account.
  - Delete    Permanently removes the account (auth.users row), which
              cascades to their admins/buyers row automatically. Past
              orders and sales_log entries are untouched -- they were
              never tied to a user id in the first place, so deleting a
              buyer or a former co-admin never rewrites sales history.

---

Good habits

- Maintenance Panel → Download Backup exports the full catalog, orders,
  and sales log as JSON straight from Supabase. Worth doing periodically
  regardless of where data lives.
- The shopping cart itself stays in sessionStorage, per browser tab —
  that's intentional, it's disposable per-visit state and doesn't belong
  in the database.
- Supabase's free tier is generous for a small shop, but keep an eye on
  usage under Project Settings → Usage if it grows a lot.
