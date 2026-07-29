# Amazon Account Activity data contract

## Selected-period trace

The browser sends the selected inclusive calendar dates as `startDate` and
`endDateExclusive` (the day after the selected end), not as browser/UTC
midnights. The API looks up the seller marketplace, resolves its IANA timezone,
and converts both local midnights to a half-open UTC instant range. For India,
27 June through 26 July 2026 is therefore
`[2026-06-26T18:30:00.000Z, 2026-07-26T18:30:00.000Z)`.

The Reports API lists every completed scheduled V2 settlement report, follows
every `nextToken`, and selects documents only where
`dataEndTime > requestedStart && dataStartTime < requestedEnd`. Each document is
stored separately with report/document IDs and coverage. Settlement detail uses
`posted-date-time` and the same half-open SQL predicate. Transfer headers use
`deposit-date`. A report overlapping the period does not make all its lines
eligible. Calculation evidence contains the requested local/UTC range, report
coverage, included source line IDs, cross-report duplicates, explicit unmapped
rows, and classification reasons.

## Source precedence

Settlement monetary rows are the sole Account Activity source. Finances is a
coverage-gap fallback for business KPIs and drill-down only and is never added
to settlement rows. Orders/order items supply order and shipped-unit metrics;
the customer returns report supplies physical returned units. GST B2B/B2C
reports supply only the invoice taxable-value KPI. Settlement rows supply the
Account Activity GST section. The reimbursements report is used only if the
selected financial source contains no reimbursement event.

## Exactness and reconciliation

Source amounts are parsed once into signed integer minor units. A declarative
mapping of normalized transaction type, amount type, and exact description
assigns every non-zero row to Income, Expenses, Tax, or GST. Successful
settlement headers assign Transfers. Each section reports debit magnitude,
credit, and `credit - debit`; no absolute-value correction is applied. Unknown
non-zero labels make the result **Does not reconcile**, missing report coverage
makes it **Incomplete**, and absent settlement data makes it **Unavailable**.

Repeated sync of one document is idempotent by report ID plus deterministic
source-line identity. Cross-report duplicate detection uses event fields while
line-number identity preserves legitimate identical-value lines inside a
document.
