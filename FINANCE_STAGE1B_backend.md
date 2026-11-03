# Finance overhaul — Stage 1B (backend): every known finance bug fixed

Branch `finance-overhaul` (local only, nothing pushed). `npm run typecheck` passes; `npm test` passes: **39 files, 367 tests, 0 expected
fail** (Stage 1A ended at 322 + 29 expected fail). Every `it.fails` known-bug test from Stage 1A now runs as a plain `it` and passes; the
reconciliation harness has no known bug left.

## Commits
| Commit | What |
|---|---|
| `067a9ba` | Migration 0018: invoice tax rate and contract link, line category/space/plan, payment reversals, contract advance used, member credit, `audit_log` (with backfills, checked on seeded data) |
| `a7342ff` | T1 (issue tax rate kept), L4 (safe totals, money limits), S1 (other tenants' ids answer 404) |
| `e268b23` | H5: payments are reversed, never deleted; payment dates limited; append-only audit log + `GET /api/audit` |
| `82e3e6c` | H1, H2, H3, H4, M1: monthly billing rebuilt (one invoice per contract per month, single-contract rent, advances, cancelled/paused members) |
| `fd7cbd8` | H6, M5b: plan changes atomic, prorated by day, paid unused days become credit |
| `9a6f3f1` | M3, M4, M5a, M6: desk amenity receipts, money permissions, invoicing gate, members with invoices are never deleted |
| `6b2d09f` | R1–R4, L3, M7: one set of definitions (`financeCore` + `financeBooks`) for report, Today page and new charts endpoint; platform MRR trend |
| `b813e54`, `f821ace` | M9 advance refunds, M10, L8, plan deletion guard |

## What changed for the people using it
- **Payments** can't be deleted any more. "Remove" writes a reversal, so last month's figures stay as they were. They can't be dated in the future or more than 5 years back.
- **Monthly invoices:**
  - Each contract gets its own rent invoice, single-member contracts included. Part months are billed by the day.
  - Contract and member advances come off the invoices.
  - Cancelled and paused members still get billed for completed bookings and amenities.
  - Running the same month twice never bills twice, even after a company's contact person changes.
- **Plan changes** bill by the day. Days already paid but not used become credit, and a change either happens fully or not at all.
- **Amenities paid at the desk** become a receipt (an invoice plus a payment) with a payment method, taxed like every invoice.
- **Finance report:**
  - Tax is reported separately and kept out of income.
  - "Invoiced" includes the part paid by an advance.
  - Aging and deposits held are as of the report's end date.
  - Money in by method adds up to money collected.
  - There's no 60-month cap.
- **New endpoints:**
  - `GET /api/reports/finance/charts`: monthly billed, collected, collection rate, tax, income by category and method, costs, and owed, overdue and deposits at each month end; plus top debtors, invoices by status, and income by space and by plan.
  - `GET /api/platform/mrr-trend`.
  - `GET /api/audit`.
  - `POST /api/payments/:id/reverse`.
  - `POST /api/members/:id/advance-refund` and `POST /api/contracts/:id/advance-refund`.
- **Permissions:** taking money needs `invoices`; giving money back, voiding, reversing and generating need `billing_admin`. Another tenant's ids look exactly like ids that don't exist (404).

## Policy decisions (defaults chosen; change in COPLACES_KNOWLEDGE.md §9.6 if the business wants otherwise)
| Topic | Decision |
|---|---|
| Removing a payment | Reversal row; the original stays |
| Payment dates | Not in the future (10 min leeway), not more than 5 years back |
| Changing plan after paying | The paid share of unused days becomes credit for the next invoices |
| Paused / cancelled members | Billed for completed bookings and amenities, never for a plan |
| Desk amenity collection | A receipt (invoice + payment), taxed like every invoice |
| Deleting a member | Refused once they have any invoice: void and cancel instead |
| Tax on advances | An advance carries no tax when received; invoices are taxed on what is left after it |
| Single-member contract rent | **Now billed by the monthly run.** Anyone billing it by hand must stop, or it is billed twice |
| No-show bookings | Not charged (unchanged) |

## Tests changed on purpose (each because the old assertion encoded a bug)
- Five tests expected **403** for another member's or tenant's record. They now expect **404** (S1).
- A plan test faked a payment by editing `paidCents`. It now pays through the API (H6).
- The member deletion test uses unpriced shifts, because a member with an invoice is no longer deleted (M6).
- The finance integrity, report and deposit tests now check money in **by method**, income **before tax**, and **billed** (R1, R2, L3).
- An amenity test expects a desk receipt in place of an untaxed collection (M3).

## Deploying this
- Migration 0018 runs automatically: on start for self-hosting, and in `vercel-build` on Vercel.
- It only adds columns and a table, then backfills. Nothing is dropped.
- **Back up the database first anyway.** It hasn't been run against your real Turso database; all testing used local databases.

## Still open
- Company contract price changes have no effective date.
- Platform payments can't be corrected.
- Platform currency is fixed to PKR.
- The login throttle works per server instance.
