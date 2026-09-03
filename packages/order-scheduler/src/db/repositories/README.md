# Repositories — the seller isolation boundary (rule R1)

Every SQL statement that touches seller-owned data lives in this directory.
Routes, services and jobs never write SQL inline.

## The rule

**Every function that reads or writes seller-scoped data takes `sellerId` as its
first argument, and that value appears in the WHERE clause.** No defaults, no
optional parameter, no "if sellerId then". A query that cannot name its seller
does not belong here.

`sellerId` comes from the verified route parameter (`req.seller.id`, set by
`requireSellerAccess`) — **never** from a request body or query string.

## Exempt tables

Two tables are not seller-scoped and their repositories take no `sellerId`:

- `users.js` — staff accounts are global to the company.
- `audit.js` — writes a `seller_id` column but is an append-only log, so it
  takes an explicit options object rather than a positional seller argument.

`product_dimensions` is a deliberate hybrid: rows with `seller_id IS NULL` are
the shared global knowledge base. Its repository still takes `sellerId` first
and decides explicitly when to widen the lookup to global rows.

## Why 404 and not 403

`requireSellerAccess` answers 404 for a seller the user cannot reach, so the UI
cannot be used to enumerate which sellers exist. Repositories support that by
returning `null`/`[]` for a mismatched `sellerId` rather than throwing.
