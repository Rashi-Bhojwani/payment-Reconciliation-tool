# Repositories — the seller isolation boundary (rule R1)

Every SQL statement that touches seller-owned data lives in this directory.
Routes, services and jobs never write SQL inline.

## A note on "seller" after the merge

These files came from the standalone order scheduling tool, where a "seller"
was a row in its own `sellers` table. In this platform a seller **is a
tenant**: `seller_id` is a foreign key to `public.tenants(id)`, and the value
passed as `sellerId` is the tenant id the JWT was issued for. The argument name
is unchanged on purpose — renaming it across every query would have been a
large diff with no behavioural difference, and `seller_id` is still the column
name in the database.

## The rule

**Every function that reads or writes seller-scoped data takes `sellerId` as its
first argument, and that value appears in the WHERE clause.** No defaults, no
optional parameter, no "if sellerId then". A query that cannot name its seller
does not belong here.

`sellerId` comes from the verified route parameter — **never** from a request
body or query string. Since the merge that verification is Fastify's
`requireTenantUser`, which checks the JWT's tenant against the `:tenantId` in
the path, and row-level security on the `scheduling` schema is a second,
independent line of defence behind it.

## Exempt tables

- `audit.js` — writes a `seller_id` column but is an append-only log, so it
  takes an explicit options object rather than a positional seller argument.
  It is also the one `scheduling` table without RLS: its `seller_id` is
  nullable and carries no foreign key, precisely so the log outlives the
  tenant it describes.

The standalone tool also had `sellers.js` and `users.js` here. Both are gone:
migration 025 dropped `scheduling.sellers`, `scheduling.users` and
`scheduling.user_seller_access` in favour of `public.tenants` and
`public.users`, so those queries had no tables left to hit — and worse, with
`search_path = scheduling, public` their unqualified `FROM sellers` would have
silently resolved to reconciliation's own `sellers` table (Amazon connection
credentials), which is a completely different thing. Tenant and staff lookups
go through `@recon/db` now.

## Why 404 and not 403

The access check answers 404 for a tenant the user cannot reach, so the UI
cannot be used to enumerate which tenants exist. Repositories support that by
returning `null`/`[]` for a mismatched `sellerId` rather than throwing.
