# Finance overhaul — Stage 1A (backend): tests that expose every known bug

Branch `finance-overhaul`. No finance behaviour was changed. `npm run typecheck` passes; `npm test` passes:
**37 files, 322 passed + 29 expected fail (351 tests)**, up from 292.

| Commit | What |
|---|---|
| `8997883` | `test/finance-bugs.test.ts` (23 known-bug tests), `test/helpers/finance.ts`, `setup(url?)` |
| `01e710d` | `test/finance-coverage.test.ts` (11 passing tests for the untested areas) |
| `c16cec2` | `test/helpers/reconcile.ts` + `test/reconciliation.test.ts` (reconciliation harness) |
| `8b824f3` | `src/services/financeCore.ts` (scaffold, not called by anything yet) |
| `fda4837` | `test/financeCore.test.ts` (characterization + differences) |

## How the known-bug tests work

- Each known-bug test asserts the **correct** behaviour and is declared with `knownBug`, which is `it.fails` normally. Today it fails, so `it.fails` passes and the suite is green.
- When a fix lands, that test starts passing, which makes `it.fails` fail. In the same commit, change that one `knownBug(...)` to `it(...)`.
- `SHOW_BUGS=1 npx vitest run test/finance-bugs.test.ts test/reconciliation.test.ts` runs them as plain tests. I used it to check that every one fails on its **intended assertion**, not on its setup (a broken setup would also make `it.fails` pass).

---

## 1. Tests added

### `test/finance-bugs.test.ts` — 23 known-bug tests (all `it.fails`)
| ID | Asserts (correct behaviour) | What happens today |
|---|---|---|
| H1 | A company contract advance (10,000.00) comes off the company's invoice | No credit line (0) |
| H2 | A single-member contract bills its rent and uses its advance | No invoice at all |
| H3 | A legacy-plan member's advance comes off the monthly invoice | `advanceUsedCents` stays 0, invoice in full |
| H4 | Re-generating a month after the company contact left does not bill the rent twice | 2 rent invoices |
| H5a | Removing a payment leaves a record of it | Row hard-deleted |
| H5b | `paidAt` 1 year ahead or 10 years back is refused | Both 201 |
| H6a | Moving to another plan after paying credits the unused paid period | Balance 4,400.00 owed |
| H6b | A plan change whose new invoice fails changes nothing and doesn't lose the advance | Old invoice voided, no replacement, advance "used" by no invoice, shifts changed |
| M1 | Cancelled and paused members' completed bookings and amenities get billed | Never invoiced |
| M3 | Amenity desk cash is a payment with a method, so payments by method reconcile | Payments by method total 0, against 400 collected |
| M4a | Only-`members` staff can't bill a plan change | 200 (invoice voided and re-created) |
| M4b | Only-`members` staff can't take a deposit or refund one | 204 and 200 |
| M5a | No-`invoicing` package: `/amenities/invoice` refused | 201, invoice created |
| M5b | No-`invoicing` package: a plan period creates no invoice | Invoice created |
| M6 | Deleting a member never erases an issued invoice | Invoice row gone |
| R1 | When every bill is paid exactly, collected = invoiced (advance included) | 5,300.00 collected vs 3,300.00 invoiced |
| R2 | P&L income excludes the tax collected | 110.00 counted, 100.00 expected |
| R3 | A 6-year report's monthly series adds up to its totals | Monthly 0 vs total 10.00 |
| R4a | Aging is as of the report's end date | Invoice issued today aged in a report ending yesterday |
| R4b | Deposits held are as of the report's end date | Deposit received today counted |
| **T1** (new) | An advance applied later keeps the invoice's original tax rate | Re-taxed at the new 20% |
| **L4** (new) | A manual invoice whose total can't be held exactly gets a 400 | **500** (driver RangeError; rolled back) |
| **S1** (new) | Another tenant's finance ids answer 404, like ids that don't exist | 403 "No access to this location" |

### `test/finance-coverage.test.ts` — 11 passing tests
1. **Month boundaries (America/New_York):** 23:59 and 00:01 local at Jan/Feb, a leap Feb 29, and Mar 31 after the DST change, written as hand-computed UTC instants. Checks the monthly series, totals, previous period, a report ending on the leap day, and the payments and expenses lists on the same edges.
2. **Another tenant guessing ids:** 18 requests against invoices, payments, expenses, contracts, deposits, members, lists, the report and generation. All refused (403/404), the body carries only `error`, nothing changes, and nothing of the record leaks. Ids that don't exist answer 404.
3. **Large amounts:** exact totals at 999,999,999,999 + tax, and paying to the last cent. Unsafe integers refused for expenses, unit price, quantity over 10,000, and an advance over 1e12.
4. **Invalid and negative inputs:** 29 cases, each a 400 that changes nothing. They cover zero, negative, fractional and text amounts; unknown methods and categories; impossible dates; due before issue; month 13; due days out of range; negative rent, amenity, plan, shift and hourly prices; platform payments; and malformed JSON.
5. **Deposit return:** returning more than was held, or a negative amount, is refused; a valid refund is split into refunded and kept.
6. **Part payments and overpayment:** up to the balance; over-balance refused; paying again after fully paid refused (409); void refused while payments exist; deleting a payment reopens the invoice.
7. **Generating the same month twice** with legacy members and a company: the second run creates 0 and the invoice count is unchanged.
8. **Tax rate change:** issued invoices keep their tax; new ones use the new rate.
9. **No-`invoicing` package:** the invoice, payment, generation, finance-report and expense screens are closed with a feature error, and the dashboard finance block is null.
10. **Concurrency, file database:** six identical payments give exactly one 201; racing part payments never exceed the total.
11. **Concurrency, file database:** four simultaneous generations bill each member exactly once.

### `test/reconciliation.test.ts` + `test/helpers/reconcile.ts` — 7 tests
- **The scenario:** legacy members billed for last month; a part payment backdated into last month; a void; a company contract with an advance and a part payment; payments at 23:59 and 00:01 across the month end; an overdue invoice; a plan member whose advance comes off the shift invoice, with a part payment; contract deposits partly refunded and kept, and another still held; amenities collected at the desk and invoiced; expenses in two months.
- **The checks (more than 60):** the books are read straight from the rows, with their own local-date code, and compared with:
  - the finance report: totals, income by kind, monthly series by local date, P&L, expense categories, aging, deposits, amenities
  - a second report ending last month
  - the Today page
  - the invoice, overdue, payment and expense lists
  - every member's balance, overdue and amenities owed
  - every invoice's own arithmetic
- **1 passing test** for all untagged checks, plus **6 `it.fails`**, one per bug: **H1, L3, R1, R2, R4a, R4b**.
- L3 is "payments by method reconcile with collected". It needs both M3 (desk amenity cash) and advances/kept deposits to have a method, so it is its own ID rather than M3.

### `test/financeCore.test.ts` — 18 passing tests
- 10 characterization tests: each `financeCore` function equals today's endpoint (§3).
- 8 difference tests, D1–D8 (§3).

### Test infrastructure
- `test/helpers/finance.ts`: plan with shifts, plan member, staff with chosen permissions, the Acme company contract, generate, report, invoices with lines, advance taken, manual invoice, upgrading Hive, row readers.
- `setup(url = ':memory:')`: the concurrency tests use a file database (see §4.5 for why).

---

## 2. `src/services/financeCore.ts` (scaffold)

Pure functions over plain rows: no database and no clock. **Nothing calls them yet.**

| Function | Matches today's | Notes |
|---|---|---|
| `invoiceTaxCents` | `calcTotals` tax | |
| `invoicedCents` | report and dashboard "invoiced" | net of advance lines |
| `billedCents` | none | includes the advance part: the R1 definition |
| `taxInvoicedCents` | none | R2 |
| `collectedByKind` | report `incomeByKind` / `totals.collectedCents`, each `monthly` row, dashboard "collected this month" | |
| `paymentsByMethod` | report `paymentsByMethod` | invoice payments only (L3) |
| `outstandingCents`, `overdueCents` | dashboard, invoice list, member balance | |
| `outstandingAsOf`, `overdueAsOf` | none | as of the end of a local day |
| `agingNow` | report `receivablesAging` | |
| `agingAsOf` | none | R4a definition |
| `depositsHeldCents` | report `deposits.heldCents` | |
| `depositsHeldAsOf` | none | R4b definition |
| `advancesUnappliedCents` | none | nothing reports this today |
| `memberBalance` | `GET /members/:id` and `/me/summary` | |
| `amenitiesOwedCents` | report `amenities.owedCents`, member `amenityOwedCents` | |

---

## 3. Places where current endpoints disagree

Each D-item is pinned by a passing test in `financeCore.test.ts`; the rest are recorded by the known-bug tests named.

| # | What | Disagreement |
|---|---|---|
| D1 | Outstanding | A payment dated in the future already reduces the Today page, the invoice list and the member balance. "As of today" it wouldn't (7,000.00 vs 11,000.00). |
| D2 / R4a | Aging | A report ending last month still ages invoices issued today, using today's date. |
| D3 / R4b | Deposits held | Always "as of now", whatever the end date. |
| D4 / R1 | Invoiced vs collected | Invoiced is net of the advance lines; collected counts the advance in full. So collected can exceed invoiced, and a collection rate is meaningless. |
| D5 / R2 | Tax | Collected and P&L income include the tax; nothing reports tax. |
| D6 / L3 | Payments by method | Covers invoice payments only. Advances (which have a method), kept deposits and desk amenity cash (no method) are missing, so it never adds up to collected. |
| D7 | What a member owes | The member balance, `/me/summary` and the Today outstanding all leave out amenities owed at the desk, which appear as a second figure on the member page and in the report. |
| D8 | Unapplied advances | Advances not yet used against invoices aren't reported anywhere (the company's 10,000.00 in the scenario). |
| R3 | Monthly series vs totals | Over 60 months, the monthly series and P&L keep the **first** 60 months and drop the **latest** ones; totals keep everything. |
| H1 / H2 | Contract figures vs invoices | The contract list shows `rentCents` and the advance, but invoices never reflect the advance (H1) or the rent of single contracts (H2). |
| M3 | Desk amenity cash | Counted as collected, but absent from the payments list and from payments by method. |
| Known, not covered by a test here | MRR | The dashboard MRR leaves out contract rent and counts lapsed plan periods, so it disagrees with what is billed (needs a policy decision before it can be tested). |

The dashboard "this month", the report for this month, the invoice list, the payments list, the expense list and the member balances **all agree** on the definitions that are right today; the reconciliation harness checks this.

---

## 4. New bugs and findings while writing the tests

1. **T1: an advance applied after a tax-rate change re-taxes the invoice at the new rate.**
   - Where: `applyToOpenInvoice` (`services/memberMoney.ts`) recomputes tax with the location's *current* `taxRateBps`.
   - Example: an invoice issued at 10% ended up with 60,000 tax (20%) instead of 30,000.
   - Fix: keep the issue rate on the invoice (store `taxRateBps` on `invoices`) and use it.
2. **L4: unsafe totals give a 500.**
   - Quantity 10,000 × unit `Number.MAX_SAFE_INTEGER` passes validation; the driver then throws `RangeError: Received integer which cannot be safely represented`. The transaction rolls back, so nothing is stored.
   - Fix: limit each amount and check the line and invoice totals are safe integers, giving a 400.
3. **S1: another tenant's ids answer 403 "No access to this location", while unknown ids answer 404.**
   - That tells an attacker the id exists. It applies to invoices, payments, expenses, contracts, deposit entries and members.
   - Fix: answer `notFound` when the record's location isn't the caller's.
4. **R3 is worse than the audit said.** The 60-month cap drops the *most recent* months. A six-year report shows the oldest five years and silently omits the latest one.
5. **H6 also leaves a gap in invoice numbers.** When `createInvoice` fails outside a transaction, the location's invoice counter has already been incremented and committed.
6. **Concurrency inside transactions is sound.** On a file database, racing payments get one 201 and the rest 409 "already paid"; racing generations get one that creates and the rest that create 0. No 500s.
7. **In-memory test databases can't test concurrency.** libsql gives `:memory:` exactly one connection, so a second request during a transaction fails at once (`TRANSACTION_ACTIVE`). The concurrency tests use a file database. (On Turso this doesn't apply.)
8. **Plan deletion** (`DELETE /api/plans/:id`) leaves the members' `planStart`/`planEnd`, their future plan bookings and their open plan invoices untouched. It's not money-moving on its own, but it leaves billing state inconsistent. Not tested yet.

---

## 5. Assumptions built into the known-bug tests (please confirm)

These tests encode a policy that the audit questions haven't settled yet. If an answer differs, the test changes before its fix.

| Test | Assumption |
|---|---|
| H5a | A "removed" payment keeps its row (a reversal), rather than only writing an audit log |
| H5b | Payments dated more than about a year ahead or 10 years back are refused (exact window to be decided) |
| H6a | Moving plan credits the **whole** unused, already-paid period |
| M1 | **Paused** members are billed for completed bookings and amenities, like cancelled ones |
| M4a / M4b | Billing a plan change, and taking or refunding money, need a money permission, not just `members` |
| M5b | A package without invoicing creates **no** invoice for a plan period (it doesn't block the plan) |
| M6 | Deleting a member with an issued invoice is either refused or keeps the invoice (voided) |
| R1 | "Invoiced" includes the part of a bill an advance paid |
| R2 | The report exposes `totals.taxCollectedCents`, and P&L income excludes it |
| S1 | Another tenant's ids answer exactly 404 |
