# Coplaces — Complete Software Knowledge Base

> **Purpose of this file:** give any AI agent or new developer full knowledge of what Coplaces is, every feature, every business rule, and every edge case in the backend, so it can work on the code or answer questions without re-reading the whole repo.
>
> Repo: `coplaces_backend` (this repo). The web frontend is a separate repo (`coplaces_frontend`); in production this API can also serve the built web app from `WEB_DIST` (default `../web/dist`).
> Last reviewed against commit `6fa7440` (origin/ahmed-dev), on branch `finance-overhaul`.
>
> **Read §9 ("Finance rules as they behave today") before touching anything that involves money.** It lists known bugs (H1–H6) that are being fixed; do not assume the current finance behaviour is correct.

---

## 1. What Coplaces is

Coplaces is a **multi-tenant SaaS for running coworking spaces**, built for Pakistan first (default timezone `Asia/Karachi`, default currency `PKR`, payment methods include JazzCash and Easypaisa), but works in any timezone/currency.

There are three layers of users:

| Layer | Who | What they do |
|---|---|---|
| **Platform** | `superadmin` (Coplaces operator) | Sells **packages** to coworking businesses, registers **organizations** (tenants), records subscription payments, suspends/extends tenants. |
| **Tenant team** | `owner`, `manager`, `staff` | Run one coworking business: locations, floors, spaces, plans and shifts, members, company contracts, room requests, front desk, amenities, contracts, billing, expenses, maintenance, devices, reports. |
| **Tenant customers** | `member` | Use the **member portal**: ask for rooms, see their plan bookings, check in, order amenities, see invoices, register visitors, report problems, read announcements. |

Everything a tenant owns hangs off its **locations** (a branch/site). Most API calls take a `locationId`.

**How members use space today (important, changed from earlier versions):**
- **Desks and offices come with a plan.** A plan has **shifts** (e.g. "Morning 09:00–14:00", each with a price). A member picks shifts and desks; the system books those desks for those shifts on every open day of the plan period and bills the sum of the shift prices.
- **Rooms are asked for, not booked.** Members send a **room request**; staff approve it (it becomes a booking at the room's hourly price) or reject it. Members cannot `POST /api/bookings`.
- **Company contracts** put a company's employees on one contract with shared spaces and/or personal desks, billed monthly to the company's contact person.
- Only spaces with an **hourly price** (`hourlyRateCents > 0`, set on the Pricing tab) can be booked by the hour. Everything else is used through plans and contracts.

---

## 2. Tech stack & project layout

- **Runtime:** Node.js, TypeScript (ES modules, `"type": "module"`), Express 5.
- **DB:** SQLite via **Turso / libSQL** (`@libsql/client`), ORM **Drizzle** (`drizzle-orm`, migrations by `drizzle-kit`).
- **Transactions:** `db.transaction` uses libsql's default `write` mode (`BEGIN IMMEDIATE`), so writers are serialized; a read-check-write inside one transaction is race-safe. Code that does several writes **outside** a transaction is not.
- **Validation:** Zod v4 (`src/lib/validate.ts` → `parse(schema, data)` throws 400 with `details` issue list). `z.number().int()` only accepts safe integers.
- **Auth:** JWT in an httpOnly cookie, bcryptjs password hashes.
- **Security headers:** helmet (CSP allows `blob:`/`data:` images and `blob:` workers for floor-plan import).
- **Tests:** Vitest + supertest, in-memory DBs (`test/*.test.ts`). Test and hook timeout is 30 s (`vitest.config.ts`).
- **Deploy:** Vercel (`server.ts` default-exports the app; `vercel-build` runs migrations) or self-hosted (`src/index.ts`).

```
server.ts                Vercel entry (no migrate on cold start)
src/index.ts             Self-host entry: HTTP, or HTTP+HTTPS on ONE port (sniffs first byte 0x16 = TLS)
src/app.ts               createApp(db): middleware, router mounting, error handler, static web app
src/config.ts            env loading & config
src/features.ts          Package feature catalogue
src/catalogue.ts         Space kinds → styles; isAssigned / isHourly / isRentable / isPriced helpers
src/db/schema.ts         ALL tables & enums (source of truth)
src/db/client.ts         createDb (connect + migrate), dropAllTables
src/db/seed.ts           Demo data (npm run seed [-- --reset])
src/db/create-superadmin.ts
src/db/migrate.ts
src/lib/                 auth, permissions, access helpers, errors, time (incl. overnight business hours), validation, sort, passwords
src/routes/              One router per area (see §7)
src/services/
  amenities.ts           Amenity orders, free daily allowance, desk collection, amenity invoices, amenity requests, amenityFinance
  billing.ts             Invoices, payments, voids, monthly generation (members + companies), amenity/booking invoice lines
  bookings.ts            Booking rules and prices, quotes, cancellation, shift matching
  checkin.ts             Check-in/out rules, stale visits, overstayers
  companyContracts.ts    Company contracts: create, activate, people, spaces, extend, discard
  contractPricing.ts     monthCharges (company rent per month, prorated by day), monthlyTotal
  contracts.ts           assignSpace, activateContract, endContract
  devices.ts             ZKTeco ADMS logic
  floorplan.ts           assertRetirable
  floors.ts              Named floors and the per-location floor limit
  memberDelete.ts        Deleting a member added by mistake
  memberMoney.ts         Member advance & security deposit; advanceCredit
  occupancy.ts           Utilisation report
  planBookings.ts        Plan periods: book shifts × desks × days, bill shift prices, change plan, renew, retime shifts
  reports.ts             Today dashboard, finance report
  roomRequests.ts        Members asking for rooms; approve/reject/cancel
drizzle/                 SQL migrations 0000–0017 + snapshots
scripts/zk-sim.ts        ZKTeco device simulator
deploy/adms-relay.js     Cloudflare Worker relaying device HTTP → Vercel HTTPS
test/                    Vitest suites
```

`src/services/pricing.ts` (the old rate card) **was removed**; see §8.2.

### npm scripts
| Script | Does |
|---|---|
| `npm run dev` | `tsx watch src/index.ts` |
| `npm run build` / `start` | tsc to `dist/`, run `dist/index.js` |
| `npm test` | vitest run |
| `npm run typecheck` | tsc --noEmit |
| `npm run seed [-- --reset]` | Demo data (refuses if DB has data unless `--reset`, which drops all tables) |
| `npm run create-superadmin -- --email x --name "X" --password "min8chars"` | Creates platform admin |
| `npm run db:generate` | drizzle-kit generate migration from schema |
| `npm run db:migrate` | Apply migrations |
| `npm run device:sim -- --sn SN --url http://localhost:4310 --tz Asia/Karachi [--poll 5]` | Fake ZKTeco device |

### Environment / config (`src/config.ts`)
| Var | Meaning |
|---|---|
| `TURSO_DATABASE_URL` | **Required** (must start `libsql://`, `https://` or `wss://`). No local fallback outside tests. |
| `TURSO_AUTH_TOKEN` | **Required.** Must be a *database* token, not a Platform API token (clear error on 401/403/404). |
| `JWT_SECRET` | Required in production; dev default `dev-only-secret-change-me`. |
| `PORT` | Default `4310`. |
| `NODE_ENV=production` | Enables secure cookies + HSTS + upgrade-insecure-requests. |
| `ALLOW_HTTP=1` | In prod, disables secure cookies (LAN installs). |
| `WEB_DIST` | Folder of built web app to serve. |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Serve HTTPS on the same port as HTTP (for attendance devices that insist on TLS). |

Fixed config: `platformTimezone = 'Asia/Karachi'` (subscriptions/platform revenue), `sessionDays = 7`.
`.env` is loaded via `process.loadEnvFile` (skipped under Vitest).

---

## 3. Data conventions (important everywhere)

- **Money = integer minor units** ("cents", i.e. paisa for PKR). Field names end in `Cents`. Never floats.
- **Tax** = basis points: `taxRateBps` 825 = 8.25%, 1600 = 16%.
- **Instants** = ISO-8601 UTC strings (`startsAt`, `checkInAt`, `paidAt`, `collectedAt`, `createdAt`…).
- **Calendar dates** = `'YYYY-MM-DD'` strings interpreted in the **location's timezone** (`startDate`, `issueDate`, `incurredOn`, `planStart`, amenity order `date`…).
- **Wall times** = `'HH:mm'` (`openTime`, shift `startTime`…). **Months** = `'YYYY-MM'`.
- **Weekdays** = comma-separated `0..6` (0 = Sunday), e.g. `closedWeekdays: "0,6"`.
- **IDs** = random UUIDs (text), except `device_commands.id` (autoincrement integer, because devices reply by number).
- **Overnight business hours:** a `closeTime` earlier than `openTime` means the business closes after midnight (open 18:00, close 04:00). `openTime === closeTime` is refused. Helpers in `src/lib/time.ts`: `crossesMidnight`, `businessMinutes`, `businessDateOf` (the small hours belong to the previous business date), `isOpenAt`, `endsNextDay`, `spanMinutes`, `spanEnd`, `fitsBusinessHours`, `shiftWindow`.
- Other timezone helpers (no date library): `zonedToUtc`, `localDate`, `localTime`, `todayIn`, `dayRange`, `monthRange`, `addDays`, `addMonths`, `addMonthsToDate` (clamps 31 Jan + 1 month → 28/29 Feb), `daysBetween`, `minutesBetween`, `toMinutes`; DST-safe two-pass offset.
- Names sort **naturally** ("Desk 2" before "Desk 10") via `byName` in `lib/sort.ts`.
- Foreign keys are enforced by libsql.

### Error responses (`src/app.ts`)
All errors are JSON `{ error: string, details?: any }`.
- `HttpError` → its status. Helpers: `badRequest` 400, `unauthorized` 401, `forbidden` 403, `notFound` 404 (`"<What> not found"`), `conflict` 409.
- SQLite UNIQUE violation → **409** `"That value is already in use"`.
- SQLite FOREIGN KEY violation → **400** `"Referenced record does not exist"`.
- Malformed JSON → 400 `"Malformed JSON"`. JSON body limit **100kb**.
- Anything else → 500 `"Something went wrong"` (logged).
- Unknown `/api/*` path → 404 `"Not found"`.

---

## 4. Multi-tenancy, packages & features

### Packages (`packages` table)
What a tenant subscribes to: `name` (unique), `description`, `interval` (`month`|`year`), `priceCents` (PKR), `features` (JSON array of keys), `maxLocations` / `maxFloors` (per location) / `maxMembers` (null = unlimited), `active` (inactive = no longer sold, but existing tenants may stay on it).

### Feature keys (`src/features.ts`)
**Core (always included):** members & plans, rooms/desks/offices, bookings, check-in & front desk. Amenities, room requests, company contracts and plan shifts have **no feature gate** of their own.

| Key | Label | Requires | Gates |
|---|---|---|---|
| `visitors` | Visitor management | – | `/api/visitors` |
| `member_portal` | Member portal | – | Members **cannot sign in at all** without it ("…has not turned on the member portal. Please ask the front desk.") |
| `floor_3d` | 3D floor view | – | `/api/floor-plan` objects, templates, save |
| `plan_import` | Floor plan import (PDF/image → 3D editor, done in web app) | `floor_3d` | Frontend feature |
| `invoicing` | Invoices and payments | – | `/api/invoices`, `/api/payments`, finance block of dashboard, member invoices in `/me/summary`. **Not** checked by plan billing, `/api/amenities/invoice`, or member deletion (see §9). |
| `expenses` | Expense tracking | – | `/api/expenses` |
| `reports` | Finance reports & exports | `invoicing` | `/api/reports/finance` |
| `team` | Team accounts | – | `/api/staff` |

`normalizeFeatures` drops unknown keys, auto-adds requirements, dedupes, orders like the catalogue. Unknown keys on package create/update → 400 `Unknown feature: x`.
`requireFeature(key)` → 403 `"This is not included in your current package. Ask Coplaces about upgrading."` with `details: { feature }`.

### Limits
`assertWithinLimit(db, user, 'locations'|'members')` → 403 `"Your <Package> package allows up to N <what>. Ask Coplaces about upgrading to add more."` with `details: { limit }`.
- Members counted = all **non-cancelled** members across the org (company employees count too; `assertRoomFor` checks the whole batch when a company contract is created).
- Checked when creating a location, creating a non-cancelled member, re-activating a cancelled member, and adding company contract people.
- **Floors:** `assertFloorsWithinLimit` (`services/floors.ts`) refuses adding *new* floor names past `maxFloors` per location (403, `details: { limit: 'floors' }`). Saving onto an existing floor is always allowed, and a location already over a lowered limit can stay put.

### Organizations (tenants)
`name, contactEmail, phone, city, status (trial|active|suspended|cancelled), packageId, periodEnd ('YYYY-MM-DD' paid/trial until), notes`.
- **`expired`** = status is trial/active AND `periodEnd < today (Asia/Karachi)`. Expired is **only a warning**; it does **not** block access.
- **Suspended / cancelled** orgs: every user is blocked (401 on API, 403 at login) with `"The subscription for <Org> is <status>. Please contact Coplaces support."` Devices of such orgs are refused too.

---

## 5. Authentication, roles & permissions

### Session
- `POST /api/auth/login {email, password}` → sets cookie **`cp_session`** (JWT `{sub: userId}`, 7 days, httpOnly, sameSite=lax, secure in prod) and returns the **session payload**: `{ user: {id,email,name,role,permissions,memberId}, org: OrgContext|null, locations: Location[] }`.
- Email is trimmed + lowercased. Unknown email still runs bcrypt against a dummy hash (timing equalisation).
- **Brute-force throttle:** 10 failures per `ip|email` within 15 min → 429 (in-memory map, per server instance; resets on success).
- Inactive user / wrong password → 401 `"Incorrect email or password"`. Blocked by org status/portal → 403 with reason.
- Login stamps `users.lastLoginAt`.
- `POST /api/auth/logout` → clears cookie, 204. `GET /api/auth/me` → session payload. `POST /api/auth/change-password {currentPassword, newPassword}` (new ≥ 8, ≤ 200) → 204.
- Every `/api/*` request re-resolves the user, org and package **in one query** (`resolveAuth`), so deactivation/suspension takes effect immediately.
- Temporary passwords (`tempPassword()`) = 9 random bytes base64url (12 chars), returned **once** when an account is created/reset without a chosen password. Company contract people are created **with** a password chosen by staff.

### Roles (`users.role`)
`superadmin` · `owner` · `manager` · `staff` · `member`.
- **superadmin:** `organizationId = null`, no locations, no permissions; only `/api/platform/*` is useful.
- **owner:** all locations of their org, **all permissions**.
- **manager / staff:** locations from `user_locations`; permissions from their stored list.
- **member:** exactly one location (their membership's), no team permissions; data is filtered to "mine".

Role guards (`lib/auth.ts`): `staffOnly` (owner/manager/staff), `managerUp` (owner/manager), `ownerOnly`, `superAdminOnly`. `assertLocation(user, locationId)` → 403 `"No access to this location"`.

### Team permissions (`src/lib/permissions.ts`)
| Key | Group | Allows |
|---|---|---|
| `front_desk` | Daily work | Check members in/out, visitors, record amenities given, serve/decline amenity requests, collect amenity charges |
| `bookings` | Daily work | Book rooms for members, approve/reject room requests, mark done/no-show, cancel |
| `members` | Daily work | Add/edit/delete members, reset passwords, assign desks/offices, **set plans & shifts, renew, record a member's advance/deposit and settle (refund) the deposit** |
| `spaces` | Setup | Add/edit spaces, photos, floors, floor plan |
| `plans` | Setup | Plans, **shifts**, **the Pricing tab (hourly prices)**, **the amenity list** |
| `holidays` | Setup | Set closed dates |
| `contracts` | Agreements | Contracts (single and company), advances and security deposits on them |
| `announcements` | Agreements | Write member notices |
| `maintenance` | Operations | Issues, cleaning/upkeep tasks, equipment |
| `invoices` | Money | See invoices/payments, manual invoices, record payments, put amenities on an invoice, collect amenities |
| `billing_admin` | Money | Generate monthly invoices, void invoices, delete payments |
| `expenses` | Money | See/record expenses |
| `reports` | Money | Finance report + finance figures on Today dashboard; list amenity orders |

Resolution (`resolvePermissions`): owner → all; manager/staff with stored JSON list → that list; **legacy accounts with `permissions = null`**: manager → all, staff → `FRONT_DESK_PRESET = [front_desk, bookings, members, invoices]`.
Looking things up (Today page, room/desk board, plans list, spaces list, occupancy) is open to the whole team.

---

## 6. Domain model (all tables)

### Platform
- **packages** — see §4 (includes `maxFloors`).
- **organizations** — see §4.
- **platform_payments** — money a tenant paid Coplaces: `organizationId, packageId, amountCents, method, reference, notes, periodStart, periodEnd, paidAt, recordedById`.

### Tenant structure
- **locations** — `organizationId, name, code` (2–6 uppercase alnum, **unique per org**, used in invoice numbers), `address, timezone, currency` (3 letters), `openTime, closeTime` (default 08:00–20:00; close before open = past midnight), `taxRateBps, closedWeekdays, invoiceSeq` (invoice counter), `active`.
- **location_floors** — floors named for a location before anything is placed on them: `locationId, name` (unique per location). A location's floors = named floors ∪ floors of non-retired spaces ∪ floors of objects (`floorsOf`).
- **location_holidays** — `locationId, date, name`; unique (location, date). Nothing can be booked/checked into on a holiday, and plan periods skip them.
- **users** — `organizationId (null = superadmin), email (globally unique), passwordHash, name, phone, role, permissions (JSON|null), active, lastLoginAt, devicePin` (unique per org).
- **user_locations** — which locations a manager/staff can act in.

### Members, plans & shifts
- **plans** (per location) — `name, description, interval (month|day), priceCents, includedMeetingMinutes` (per month, `room` kind only), `includesHotDesk` (hourly hot desk bookings free), `active`. **New plans have no price of their own** (`priceCents` defaults to 0): what members pay comes from the plan's shifts. A plan's `priceCents` is only billed for "legacy" members who have no plan period (`planStart` null).
- **shift_templates** — a named time slot with optional fixed price: `locationId, planId?` (null = old shift open to everyone), `name, startTime, endTime` (may run past midnight), `priceCents?, active`, plus legacy `resourceId?`/`kind?` scope.
- **shift_spaces** — the spaces a shift is limited to (none = every bookable space).
- **members** — `userId (unique), locationId, company, planId?, status (lead|active|paused|cancelled), startDate, endDate?, notes`, plus:
  - `planStart`, `planEnd` — the current plan period (null for members without shifts).
  - `advanceCents`, `advanceUsedCents`, `advanceReceivedAt` — a one-time advance and how much invoices have used.
  - `depositCents`, `depositStatus (pending|held|refunded|forfeited)`, `depositReturnedCents` — a one-time security deposit.
  - `meetingCredits` — free meeting-room credit hours per month (2 credits = 1 hour, i.e. 1 credit = 30 minutes). A static allowance, not a used-up balance.
- **member_shifts** — the plan shifts a member has taken (what they pay = sum of these shifts' prices).
- **member_desks** — the desks/offices given to a member by their plan.

### Spaces (`resources`)
`locationId, kind, name` (unique per location), `floor, capacity (1–500), hourlyRateCents, amenities` (comma list), `status, notes, style, planX, planZ, planW, planD, planRot (0–3), description, openTime?, closeTime?, closedWeekdays?`.

**Legacy, unused columns** still in the schema: `dailyRateCents, offPeakRateCents, peakStart, peakEnd, halfDayRateCents, fullDayRateCents, noPlanRateCents`. No code prices with them any more and the API no longer accepts them (a PATCH that only carries them changes nothing).

**Kinds** (`RESOURCE_KINDS`) and their behaviour (`src/catalogue.ts`):
| Kind | How it is used | Billing |
|---|---|---|
| `room` (meeting room) | Booked by time (`isHourly`) via room requests or staff | Hourly; plan minutes + meeting credits free first |
| `corporate_room` | Booked by time | Hourly from the first minute; never uses free minutes |
| `hot_desk` | Plan shifts, or booked by the hour/whole day if priced | Shift price, or hourly; free if plan `includesHotDesk` |
| `dedicated_desk` | Plan shifts, assignments, contracts (`isAssigned`) | Via plan shift invoices or contracts |
| `office` | Plan shifts, assignments, contracts (`isAssigned`) | Via plan shift invoices or contracts |
| `storage` (locker, mailbox, parking) | Assigned only | Via contracts |

`isPriced(r)` = `hourlyRateCents > 0`: only priced spaces appear on the booking grid and can be booked by the hour or requested. Every kind is rentable on a contract; a rented space can't be booked by anyone else while the rent runs.

**Styles** (floor-plan look; first is default, `''` = default):
- room: meeting, phone_booth, huddle, training, studio, interview, focus, video_call
- corporate_room: boardroom, training_hall, event_hall
- hot_desk: standard, standing, corner, day_office
- dedicated_desk: standard, standing, corner, team_pod
- office: standard, executive
- storage: locker, mailbox, parking

**Statuses:** `available, maintenance, cleaning, reserved, retired`. Only `available` can be booked / assigned / given by a plan. `retired` = removed.

- **resource_photos** — JPEG/PNG/WebP BLOBs, max **8 per space**, max **3 MB** each, magic-byte verified.
- **resource_assignments** — `resourceId, memberId, startDate, endDate?`. Who holds a space for a period (single contracts, company shared spaces and personal desks, manual assignments).
- **floor_objects**, **floor_templates** — as before (see §7 floor plan). Object types: amenities (kitchen, coffee_machine, lounge, print_station, reception, plant, core, pantry, water_dispenser, vending_machine, recreation, nap_pod, phone_corner, library), facilities (washroom_men, washroom_women, washroom_accessible, prayer_room, server_room, storage_room, mail_room, generator_room, security_desk), safety (fire_exit, extinguisher, first_aid), outdoors (terrace, bike_rack), structure (wall, glass_wall, door, window, column, zone, label). Variants `'' | l | double | sliding`; tints `'' | blue | green | yellow | rose | slate`.

### Activity
- **bookings** — `locationId, resourceId, memberId, startsAt, endsAt, status (confirmed|completed|cancelled|no_show), billableMinutes, priceCents, invoiceId?, notes, createdById, cancelledAt?, checkedInAt?, source (manual|plan)`. Plan bookings have `priceCents = 0`: the plan's shift invoice pays for them.
- **room_requests** — `locationId, resourceId, memberId, date, startTime, endTime, notes, status (pending|approved|rejected|cancelled|taken), reason, decidedById?, decidedAt?, bookingId?`.
- **attendance** — member visits: `locationId, memberId, resourceId?, checkInAt, checkOutAt?`.
- **staff_attendance** — team clock-in/out from devices.
- **visitors** — `locationId, hostMemberId, name, email, phone, company, purpose, expectedAt, status (expected|checked_in|checked_out|cancelled), checkInAt?, checkOutAt?`.
- **announcements** — `locationId, title, body, draft, publishAt?, createdById`.

### Amenities
- **amenities** — what the front desk hands out (tea, coffee, food): `locationId, name, priceCents (0–1e9), active`.
- **member_amenities** — how many of an amenity a member gets free **per day**: `memberId, amenityId, freePerDay (1–1000)`.
- **amenity_orders** — one handout: `locationId, memberId, amenityId, name` (snapshot), `date` (location day), `quantity, freeQuantity, chargeCents, collectedAt?` (set at once when nothing is charged), `invoiceId?, recordedById`.
- **amenity_requests** — a member asking the desk: `quantity, status (pending|served|declined|cancelled), reason, decidedById?, decidedAt?, orderId?`.

### Money
- **invoices** — `locationId, memberId, number` (`<LOCATIONCODE>-00001`, unique per location), `kind (subscription|manual), status (open|paid|void), issueDate, dueDate, periodStart?, subtotalCents, taxCents, totalCents, paidCents, notes`. `subscription` is used for monthly invoices, company invoices **and** plan-period (shift) invoices; amenity invoices are `manual`. There is no contract or company link on an invoice.
- **invoice_items** — `description, quantity, unitPriceCents, amountCents, bookingId?`. A **negative** line "Advance paid" is how a member advance is used against an invoice. Lines have no category, space or plan link.
- **payments** — `locationId, invoiceId, memberId, amountCents, method, paidAt, reference, notes, recordedById`. Methods: `cash, card, bank_transfer, jazzcash, easypaisa, cheque, other`.
- **expenses** — `locationId, category, vendor, description, amountCents, incurredOn, createdById`. Categories: `rent, utilities, internet, cleaning, supplies, salaries, maintenance, marketing, software, other`.
- **contracts** — `locationId, memberId, resourceId?, assignmentId?, startDate, endDate?, rentCents` (per month; on company contracts it is a display figure kept by `refreshRent`), `depositCents, depositStatus, depositReturnedCents, advanceCents, advanceReceivedAt?, status (draft|active|ended|cancelled), notes, createdById`, plus company fields: `companyName` (non-empty = company contract), `companyEmail, companyPhone, pricingMode (per_member|fixed), pricePerMemberCents, extraMemberCents, fixedPriceCents` (all per month).
- **contract_people** — employees on a company contract: `contractId, memberId, deskResourceId?` (own desk; null = shares the contract's spaces), `assignmentId?, joinDate, leaveDate?`.
- **contract_spaces** — spaces a company shares: `contractId, resourceId, assignmentId?`. Seats = sum of their capacities.
- **deposit_entries** — the advance/deposit ledger: `locationId, contractId?` **or** `memberId?` (member-level money), `kind (received|refunded|kept|advance), amountCents, method?` (null for kept), `reference, occurredAt, recordedById`.

### Operations
- **space_tasks**, **task_logs**, **space_assets**, **issues** — maintenance (unchanged; see §7).

### Attendance devices (ZKTeco)
- **devices**, **device_users**, **device_commands**, **device_punches** — see §10.

### Migrations (`drizzle/`)
0000 initial · 0001 · 0002 booking rules, contracts, announcements · 0003 team permissions · 0004 space features · 0005 deposit ledger · 0006 booking checked_in · 0007 shift templates · 0008 · 0009 attendance devices · **0010 floors** (`location_floors`, `packages.max_floors`) · **0011 shifts in plans** (`shift_spaces`, `shift_templates.plan_id`) · **0012 company contracts** · **0013 member plan shifts** (`member_shifts`, `member_desks`, `bookings.source`, `members.plan_start/plan_end`) · **0014 room requests** · **0015 member money** (`deposit_entries.member_id`, contract_id nullable; member advance/deposit columns) · **0016 amenities & meeting credits** · **0017 amenity invoices & requests** (`amenity_requests`, `amenity_orders.invoice_id`). `createDb` refuses a DB migrated by a pre-multi-tenant version.

---

## 7. API reference (every endpoint)

Base: `/api`. All routes below `/api` except `/health` and `/auth/*` login/logout require the session cookie. "loc" = needs `locationId` (query for GET, body for POST) and the caller must have access to it.

### Health & auth
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/api/health` | public | `{ok, database:{kind:'local'|'turso', connected, latencyMs}}`; 503 if DB doesn't answer in 5 s. |
| POST | `/api/auth/login` · `/logout` | public | see §5 |
| GET | `/api/auth/me` · POST `/change-password` | signed in | |

### Platform console — `/api/platform` (superadmin only)
| Method | Path | Notes |
|---|---|---|
| GET | `/features` | `{features, core}` |
| GET / POST / PATCH | `/packages`, `/packages/:id` | `{name, description?, interval, priceCents (≤1e11), features[], maxLocations?, maxFloors?, maxMembers?, active?}` |
| GET / POST | `/organizations` | Create = org + first location + owner (temp password) in one transaction. Default periodEnd: trial → +14 days; active → +1 month (or +12 for yearly). |
| GET / PATCH | `/organizations/:id` | detail (owners, locations, last 20 platform payments) / edit |
| POST | `/organizations/:id/reset-owner-password` | → temp password |
| POST | `/organizations/:id/payments` | `{amountCents ≥1, method, periods 1–36, reference?, notes?, paidAt?}`. Extends periodEnd from the later of periodEnd/today; trial → active. Amount is not checked against the package price; no endpoint corrects or deletes a platform payment. |
| GET | `/payments` | last 500 |
| GET | `/overview` | org counts, **MRR** (active orgs; yearly ÷ 12; snapshot only, no history), collected this month, people totals, `attention` (≤14 days left), tenants by package, 5 newest |

### Locations — `/api/locations`
GET `/` · POST `/` (owner; location limit; open ≠ close) · PATCH `/:id` (owner) · GET/POST/DELETE `/:id/holidays` (`holidays` to change).

### Floors — `/api/floors` (`spaces`)
GET `/?locationId` → `{floors, limit}` · POST `{locationId, names[] (1–100, distinct ignoring case)}` (floor limit) · DELETE `/?locationId&name` (only an **empty** floor; 409 otherwise).

### Team — `/api/staff` (feature `team` + owner only)
GET `/permissions` · GET `/` · POST `/` · PATCH `/:id` (unchanged; see §5).

### Plans — `/api/plans`
GET `/?locationId` (team) · POST `/` (`plans`; `priceCents` optional, default 0) · PATCH `/:id` (`plans`) · **DELETE `/:id`** (`plans`): sets members' `planId` to null, deletes the plan's shifts (member_shifts cascade) and the plan. It does not touch `planStart/planEnd`, future plan bookings, or open plan invoices.

### Shifts — `/api/shifts`
- GET `/?locationId[&memberId]` — anyone at the location. A member sees shifts of their own plan plus shifts with no plan; staff passing `memberId` get that member's view. Each row includes `spaceIds`.
- POST / PATCH / DELETE — **`plans`** permission. Body `{locationId, name, planId?, spaceIds[] (≤500), startTime, endTime, priceCents?, active?}`.
- Rules: start ≠ end; 15-minute steps; must fit the location's business hours (overnight allowed); plan and spaces must be in the location; spaces must be room / corporate_room / hot_desk / dedicated_desk / office.
- Changing a shift's times **moves** its members' future confirmed plan bookings to the new times (`retimeShiftBookings`), refusing (409) if a space would go over capacity.

### Members — `/api/members`
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/?locationId&q&status` | any of members/front_desk/bookings/invoices/contracts | includes `planName`, `checkedIn`, `devicePin`, `contractCompany` |
| POST | `/` | `members` | `{locationId, name, email, phone?, company?, planId?, status?, startDate?, notes?, password?, shiftIds[], deskIds[], advanceCents?, depositCents?, method?, reference?, amenities[{amenityId, freePerDay}], meetingCredits?}`. One transaction: user + member + free amenities + advance/deposit + first plan period. If the plan has shifts at least one must be chosen; desks need shifts; shifts need status active. |
| GET | `/available-spaces?locationId&planId&shiftIds&startDate[&memberId]` | `members` | desks/offices free for those shifts over the plan period, and the period end |
| PUT | `/:id/plan` | `members` | `{planId|null, shiftIds[], deskIds[], startDate?}` → `changePlan` (§8.4) |
| POST | `/:id/renew` | `members` | `{startDate?}` → next period (opens 2 days before `planEnd`) |
| POST | `/:id/money` | `members` | `{advanceCents?, depositCents?, method, reference}` — record a forgotten advance/deposit (each once) |
| POST | `/:id/deposit` | `members` | `{action: refund|forfeit, returnedCents?, method, reference}` — settle the member's deposit |
| DELETE | `/:id` | `members` | delete a member added by mistake (§8.12) |
| GET | `/:id` | staff with location, or self | plan, shifts, desks, free amenities with today's use, `amenityOwedCents`, `moneyEntries` (ledger), assignments, `balanceDueCents`, `overdueCents`, `contractCompany` |
| PATCH | `/:id` | `members` | `{name,email,phone,company,planId,status,startDate,endDate,notes,meetingCredits,amenities}`. Cancelling is refused while the member is the `memberId` of a draft/active contract; otherwise cancels future un-invoiced confirmed bookings, checks them out, disables login. **`planId` can be changed here directly, bypassing `changePlan`.** |
| POST | `/:id/reset-password` | `members` | `{tempPassword}` |

### Spaces — `/api/resources`
GET `/?locationId&kind` · POST `/` (`spaces`; no price fields) · GET `/:id` · PATCH `/:id` (`spaces`; retiring needs `assertRetirable`; floor limit) · **PUT `/pricing`** (`plans`): `{locationId, prices:[{resourceId, hourlyRateCents 0–1e12}] 1–1000}` → `{changed}` · photos: POST `/:id/photos`, GET `/photos/:photoId/file`, DELETE `/:id/photos/:photoId`.

### Assignments — `/api/assignments` (team)
GET `/?locationId` · POST `/` (`members` or `spaces`) · PATCH `/:id` `{endDate}`.

### Floor plan — `/api/floor-plan` (feature `floor_3d`)
GET `/objects` · PUT `/` (`spaces`; atomic save of spaces, objects, retirements and new `floors[]`; checks the floor limit; space create/update no longer carries prices) · GET/POST/DELETE `/templates`.

### Room requests — `/api/requests`
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/?locationId&status` | staff need `bookings`; members see own | pending first; each has `ahead` (others waiting for an overlapping time) |
| GET | `/queue?resourceId&date&startTime&endTime` | anyone at the location | `{ahead}` |
| POST | `/` | **members only** | `{resourceId, date, startTime, endTime, notes?}`. Space must be priced; every booking rule is checked via `quoteBooking`; refuses a duplicate overlapping request by the same member. |
| POST | `/:id/cancel` | the member who asked | pending only |
| POST | `/:id/approve` | `bookings` | creates the booking at the usual price; other pending overlapping requests for that room become `taken` |
| POST | `/:id/reject` | `bookings` | `{reason?}` |

### Bookings — `/api/bookings`
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/schedule?locationId&date` | any | day grid of **priced**, non-retired spaces; live bookings (identities only for staff); `inUse`; `closed`; hours |
| GET | `/?locationId&memberId&resourceId&status&from&to&limit` | any (members forced to own) | |
| POST | `/quote` | staff need `bookings`; members only for priced spaces | `{priceCents, billableMinutes, startsAt, endsAt, basis}` |
| POST | `/` | **staff with `bookings` only** (members get 403 "Members ask the owner for a room instead") | `{resourceId, memberId, date, startTime?, endTime?, notes?}` |
| POST | `/:id/cancel` | staff `bookings` or own member | |
| PATCH | `/:id` | `bookings` | `{status: confirmed|completed|no_show}` (allowed even on an invoiced booking) |

### Contracts — `/api/contracts` (`contracts` permission; no feature gate)
- Single contracts: GET `/?locationId&status&memberId` (company ones include `people`, `spaces`, `seats`, `extraPeople`) · POST `/` · PATCH `/:id` (refused for company contracts) · POST `/:id/activate` · `/:id/end {endDate?}` · `/:id/cancel` · GET `/:id/deposit-entries` · POST `/:id/advance {method?, reference?}` · POST `/:id/deposit {action: receive|refund|forfeit, returnedCents?, method?, reference?}`.
- Company contracts:
  - GET `/available-spaces?locationId&startDate&endDate` — rooms/desks/offices with `free`/`busy` reason.
  - POST `/quote` `{locationId, pricingMode, pricePerMemberCents, extraMemberCents, fixedPriceCents, people:[{hasDesk}], spaceIds}` → `{seats, totalCents, extraPeople, lines}`.
  - POST `/company` — `{locationId, companyName, companyEmail?, companyPhone?, startDate, endDate?, pricing…, advanceCents?, depositCents?, notes?, spaceIds[], people:[{name, email, phone?, password (≥8), deskResourceId?, joinDate?}] 1–200}`.
  - PATCH `/:id/company` — names, pricing, advance/deposit (until received), notes; dates only on a draft. **Not in a transaction.** Price changes apply to the next invoice generated (whole month).
  - POST `/:id/people` (add an employee), POST `/:id/people/:personId/leave {date?}`, PUT `/:id/spaces {resourceIds}` (draft only), POST `/:id/extend {endDate}`.
- Money amounts on contracts: integers 0–1e12.

### Amenities — `/api/amenities` (no feature gate)
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/?locationId` | plans, members or front_desk | active amenities |
| POST / PATCH | `/`, `/:id` | `plans` | `{locationId, name, priceCents 0–1e9}` |
| DELETE | `/:id` | `plans` | deactivated if it was ever given, else deleted |
| GET | `/orders?locationId&memberId` | front_desk, invoices or reports | last 200 |
| POST | `/orders` | `front_desk` | `{memberId, amenityId, quantity 1–100}` — free up to today's allowance, rest charged |
| POST | `/invoice` | `invoices` (**no `invoicing` feature check**) | `{memberId}` — puts everything owed on a manual invoice now (due +7 days) |
| POST | `/collect` | front_desk or invoices | `{memberId}` — marks everything owed as collected at the desk; returns `{collectedCents}` |
| GET | `/requests?locationId&pending=1` | staff need front_desk; members see own | |
| POST | `/requests` | members | `{amenityId, quantity 1–20}`; max 10 pending |
| POST | `/requests/:id/cancel` · `/serve` · `/decline {reason?}` | member (cancel) / front_desk | serving records the order |

### Announcements, operations, visitors
- `/api/announcements` — unchanged: staff see all with `state`, members only live; writing needs `announcements`.
- `/api/tasks`, `/api/assets` (`maintenance`), `/api/issues` (report: anyone; manage: `maintenance`) — unchanged.
- `/api/visitors` (feature `visitors`) — unchanged.

### Attendance — `/api/attendance`
GET `/?locationId&date|open=1` (team) · **GET `/overstaying?locationId`** (team; members still in after their booking/shift ended) · POST `/check-in` · POST `/:id/check-out` · GET `/staff` (manager+) · GET `/mine`.

### Devices — `/api/devices` and `/iclock/*`
Unchanged; see §10.

### Invoices — `/api/invoices` (feature `invoicing`)
GET `/?locationId&memberId&status(open|paid|void|overdue)&q` · GET `/:id` · POST `/` (`invoices`; manual: items with `quantity 1–10000`, `unitPriceCents ≥0`, no upper limit) · POST `/generate` (`billing_admin`; `{locationId, month, dueInDays 0–120 (7)}`) · POST `/:id/void` (`billing_admin`) · POST `/:id/payments` (`invoices`; `{amountCents ≥1, method, paidAt? (any ISO datetime), reference?, notes?}`).

### Payments — `/api/payments` (feature `invoicing`)
GET `/?locationId&method&from&to` (`invoices`) · DELETE `/:id` (`billing_admin`; **hard delete**, invoice re-derived).

### Expenses — `/api/expenses` (feature `expenses` + permission `expenses`)
GET `/?locationId&category&from&to` · POST · PATCH · DELETE (hard delete). `amountCents ≥ 1`, no upper limit.

### Reports — `/api/reports`
GET `/dashboard` (team; finance block = `reports` permission **and** `invoicing`; ops include `overstaying`) · GET `/occupancy?days&to` · GET `/finance?from&to` (feature `reports` + permission `reports`; default last 6 calendar months).

### Member self-service — `/api/me/summary` (members only)
Member + location, currency, timezone, today, plan, `meetingMinutes {included: plan minutes + credits × 30, used}`, `amenities` (menu with free per day and used today), `amenityDueCents`, `amenityRequests` (8 newest), `overstay`, open check-in, 5 upcoming confirmed bookings, open invoices + `balanceDueCents` + `overdueCents` (with `invoicing`), expected visitors (with `visitors`).

---

## 8. Business rules in detail

### 8.1 Opening hours & closures
- Location `openTime/closeTime` (may cross midnight), `closedWeekdays`, holidays. A space can override hours and add **extra** closed weekdays.
- `closedReason(loc, date)` → holiday / weekday reason / null.

### 8.2 Booking rules and prices (`services/bookings.ts → planBooking`)
Applied identically by **quote**, **create** and **room request** (create runs in a transaction):
1. Space must exist, be in the caller's locations, be **priced** (`hourlyRateCents > 0`), and be `available`.
2. Member must exist, be **active**, same location; members only for themselves (and in practice only through room requests).
3. Date not closed. **Times:** a hot desk with no times is the whole business day; everything else needs start & end. Duration > 0, **15-minute steps**, rooms and other non-desk spaces ≤ **12 hours**, inside business hours (overnight allowed when the business is open past midnight). Not already ended.
4. Not rented to someone else that day; no overlapping live booking on the space; a member can't hold two overlapping hot-desk bookings; nobody else checked in at a desk for a booking covering now.

**Price** (rate card pricing was **removed**; only the hourly rate and shifts remain):
- Hot desk and plan `includesHotDesk` → **free** (`basis: plan`).
- Else a matching **shift with a price** → that price in full (`basis: shift`); it never uses free minutes. `matchShift`: active shift with exactly the same start/end, with no plan or the member's plan; preference: listed spaces / specific space > same kind > any.
- Else **hourly**: `round(hourlyRate × billableMinutes / 60)`. For `room` only, the free monthly allowance = plan `includedMeetingMinutes` + `meetingCredits × 30` minus free minutes already used this month by live room bookings; `billableMinutes = duration − min(duration, freeLeft)`. Whole-day hot desk = hourly × business-day minutes. `dailyRateCents` is no longer used.

**Cancel:** staff need `bookings`; members only their own and only before it starts; only `confirmed`; not if invoiced.
**allDay** flag = hot desk booking spanning exactly open→close.

### 8.3 Room requests (`services/roomRequests.ts`)
Members ask; the request is validated like a booking but nothing is reserved. Approving (`bookings`) calls `createBooking` (the room must still be free) and marks other overlapping pending requests for that room `taken`. Approve is not one transaction with the request update (a failed booking leaves the request pending).

### 8.4 Plans, shifts and plan periods (`services/planBookings.ts`)
- **Period:** monthly plan → `start` to `start + 1 month − 1 day`; day plan → one day.
- **Starting a period** (`startPlanPeriod`, on member create or renew): checks chosen shifts belong to the plan, are active and don't overlap; checks chosen desks/offices are free (`freeSpaces`: covered by every shift, `available`, not assigned to anyone, and under **capacity** for every shift on every open day). Books each desk × shift × open day as `source = 'plan'`, `priceCents = 0` (in batches of 50). Stores `member_shifts`, `member_desks`, `planId/planStart/planEnd`. **Bills** one `subscription` invoice (`periodStart = planStart`, due +7 days) with one line per priced shift ("<Plan>: <Shift> HH:mm–HH:mm, start to end"), minus any unused advance (`advanceCredit`).
- **Renew** (`renewPlan`): same shifts and desks, from the day after `planEnd` (or today if lapsed). Opens 2 days before `planEnd`; in one transaction.
- **Change plan** (`changePlan`, `PUT /members/:id/plan`): in a transaction, cancels future un-checked-in plan bookings and re-books from `max(start, today)`. Then, **outside that transaction**, bills:
  - old invoice for the period open and unpaid → void it (advance returned) and bill the full new total;
  - same plan and old invoice paid/part-paid → bill only the shifts that are new;
  - otherwise → bill the full new total.
  Removing the plan cancels future plan bookings and voids an unpaid old invoice. See H6.
- Member check-in reason: a running plan booking counts (see 8.6).

### 8.5 Company contracts (`services/companyContracts.ts`, `contractPricing.ts`)
- A contract with `companyName` set. Its employees are real members (`members.company = companyName`, `planId = null`) created **paused / login disabled** until the contract is activated. The **first person is the contact**: `contracts.memberId`, who receives the invoices.
- **Seats** = capacity of the shared spaces. People without their own desk share them; those beyond the seats (by join date) are **extra people**.
- **Pricing per month** (`monthCharges`):
  - `per_member`: everyone pays `pricePerMemberCents`; extra people pay `extraMemberCents`.
  - `fixed`: the shared spaces cost `fixedPriceCents` once; only own-desk people and extra people are added on top.
  - Partial months are prorated **by calendar day**: `round(price × days / daysInMonth)`, per line.
- `refreshRent` keeps `contracts.rentCents` = the full-month total for current people (display only).
- **Activate:** employees active and can sign in; shared spaces assigned to the contact; personal desks assigned to each person. **End:** assignments stop, every remaining employee gets `leaveDate` and is cancelled once that date has passed. **Add person** (draft or active), **remove person** (draft: deleted with their login; active: leaves on a date; the contact moves to the next person if needed; at least one must remain). **Extend** the end date if nobody else holds the spaces by then. **Discard draft** (no money received) deletes the people and logins.
- **Billing:** see §9 (monthly generation).

### 8.6 Check-in / check-out (`services/checkin.ts`)
- **Stale visits auto-close** at the closing time of the business day they began in (handles overnight businesses), and their booking is completed.
- **A member needs a reason to be here:** a booking at a place (room, corporate room, desk, office; a plan shift counts) running now or starting within **30 minutes**, or a space rented to them. Otherwise 409 with a reason from `whyNotNow` (next booking time, plan ended, plan without shifts, no plan…). This also applies to fingerprint punches.
- With no space given, the space follows from the reason: the desk/office of the running shift, else the room booked, else the desk they rent.
- Rooms: only the people who booked them, inside the booking window, room available. Desks: a member with a desk booking sits there unless it went out of service (then they can be moved and the booking moves with them); not assigned/booked/occupied by someone else.
- Opening hours enforced (overnight aware) unless the member rents a space.
- **Overstayers** (`overstayers`): checked in, their latest booking ended, nothing running or about to start, no rented space → shown to the front desk (`/attendance/overstaying`, dashboard) and to the member (`/me/summary.overstay`).
- Check-out completes the booking they checked in for.

### 8.7 Assignments (`assignSpace`)
Space available, member active & same location, end ≥ start; refused if **other members** have live bookings on it in the period (plans book desks and offices too) or another assignment overlaps.

### 8.8 Retiring a space (`assertRetirable`)
Refused while it has upcoming confirmed bookings or a current/future assignment.

### 8.9 Single contracts, advances & security deposits
Lifecycle `draft → active → ended`, or `draft → cancelled`. Draft editable; running: notes only. Activate assigns the space; end stops the assignment (ending today frees it today). Cancel only drafts without money received. Contract **advance** (one-time) → ledger `advance`. Contract **deposit** `receive` → `received` (held); after the contract ended: `refund {returnedCents?}` → `refunded` + `kept` remainder, or `forfeit` → all `kept`. A member can't be cancelled while they are the `memberId` of a draft/active contract. **The contract's `rentCents` is never invoiced automatically** (H2).

### 8.10 Member advance & security deposit (`services/memberMoney.ts`)
- Recorded when the member is added or later via `/members/:id/money`; each **once** (`advanceReceivedAt`, `depositStatus`). Ledger rows carry `memberId`.
- **Advance:** income when received; then taken off plan shift invoices by `advanceCredit` (a negative "Advance paid" line, capped at the invoice subtotal; tax is computed on what is left). If an open, unpaid plan invoice for the current period already exists, `applyToOpenInvoice` adds the line to it and recomputes totals using the location's **current** tax rate. Voiding an invoice gives the used part back (`advanceUsedCents` decreases). There is no refund of unused advance.
- **Deposit:** held; settled (`refund`/`forfeit`, same rules as contracts) from 2 days before `planEnd`, or at any time once the member is not active.

### 8.11 Amenities (`services/amenities.ts`)
- Each order: `free = min(quantity, max(0, freePerDay − already had today))`; `chargeCents = (quantity − free) × price` (price at the time). Orders that charge nothing are marked collected at once.
- What is owed = orders with `chargeCents > 0`, not collected and not on an invoice. It is cleared **either** by collecting at the desk (`collectedAt`, no payment row, no method, **not in a transaction**) **or** by an invoice (immediately via `/amenities/invoice`, or on the next monthly invoice). Voiding that invoice makes the orders owed again.
- Members can request amenities (max 10 pending); the front desk serves (records the order) or declines.

### 8.12 Deleting a member (`services/memberDelete.ts`)
Only for a member with **no** check-ins, payments, advance/deposit entries, amenity orders, contracts, company contract membership, assignments, visitors, reported problems, or invoices that are not open-and-unpaid. Then, in a transaction, it **hard-deletes** their open unpaid invoices and items, bookings, room/amenity requests, shifts, desks, device links, the member and the user. Otherwise 409: "Cancel their membership instead".

### 8.13 Visitors, maintenance, reports
- Visitors: `expected → checked_in → checked_out`, `expected → cancelled`.
- Maintenance: task done → logged; repeating tasks move `nextDue`; issue → task once.
- **Today dashboard** (`dashboard`): ops counts (+ `overstaying`); finance (if allowed): **MRR** = for active members on monthly plans, the sum of their shifts' prices, or the plan price for members without shifts (contract rent is not included); collected this month = payments + advances + kept deposits + amenities collected at the desk; invoiced this month (non-void, by issue date, net of advance lines); expenses this month; outstanding; overdue amount & count.
- **Occupancy:** utilisation per non-retired space (hours for rooms, days otherwise; overnight-aware business minutes).
- **Finance report** (`financeReport`): see §9.

---

## 9. Finance rules as they behave today

This section describes what the code **does**, not what it should do. The `finance-overhaul` branch is fixing these.

### 9.1 Where money is created and changed
| Flow | Function | Writes | Transaction |
|---|---|---|---|
| Manual invoice | `createInvoice` (`billing.ts`) | invoiceSeq, invoices, items | yes |
| Monthly invoices | `generateSubscriptionInvoices` | invoices, items, bookings.invoiceId, amenity_orders.invoiceId | yes |
| Plan period invoice | `startPlanPeriod` / `renewPlan` / `changePlan` → `advanceCredit` + `createInvoice` | invoices, items, members.advanceUsedCents | yes, **except `changePlan` billing** |
| Amenity invoice | `invoiceAmenities` | invoices, items, amenity_orders.invoiceId | yes |
| Advance onto an open invoice | `applyToOpenInvoice` | items (−), invoice totals, advanceUsedCents | yes |
| Payment | `recordPayment` → `recomputeInvoice` | payments, invoice paid/status | yes |
| Payment removed | `deletePayment` | **hard delete**, recompute | yes |
| Void | `voidInvoice` | status, frees bookings/amenity orders, restores advance | yes |
| Invoice deleted | `deleteMember` | **hard delete** of unpaid invoices | yes |
| Expenses | `routes/expenses.ts` | expenses (**hard delete**) | single statements |
| Member advance / deposit | `recordMemberMoney`, `settleMemberDeposit` | deposit_entries, members | yes |
| Contract advance / deposit | `routes/contracts.ts` | deposit_entries, contracts | yes |
| Amenity given / collected | `giveAmenity` / `collectAmenities` | amenity_orders | yes / **no** |
| Platform payment | `routes/platform.ts` | platform_payments, organizations | yes |

### 9.2 Invoices
- Number `<CODE>-<5 digits>` from the location's counter. Totals: `subtotal = Σ qty × unit`; `tax = round(subtotal × taxRateBps / 10000)` once per invoice; `total = subtotal + tax`. A zero total is created `paid`.
- `paidCents` and status are always re-derived from the payments (`recomputeInvoice`). Payments can't exceed the balance or go on void/paid invoices. Voiding needs no payments.
- **Monthly generation** (`generateSubscriptionInvoices`, idempotent per member per month, in one transaction):
  - Individual members: **active** members overlapping the month who are **not on any company contract (ever)** and have no non-void subscription invoice with `periodStart = <month>-01`. Lines: the plan's monthly price **only if the member has no plan period** (legacy plans), every unbilled priced live booking that started before the month end and before now, and every amenity charge still owed.
  - Companies: each active/ended company contract overlapping the month gets one invoice to its **current contact** (`contracts.memberId`), skipped if that member already has a subscription invoice for the month: `monthCharges` rent lines + all employees' unbilled bookings + amenities.
  - Cancelled and paused members are not billed.
- **Plan shift invoices** are created when a period starts (§8.4), with the advance taken off.

### 9.3 Finance report (`financeReport`) and dashboard
- **Cash basis.** Collected = invoice payments (by `paidAt`) + advances (when received) + kept deposits (when kept) + amenities collected at the desk (by `collectedAt`). Received and refunded deposits are not income. Costs by `incurredOn`. Months are in the location's timezone.
- Returns totals (invoiced, collected, expenses, net), `monthly` (max 60 months), `previous` period of equal length, `incomeByKind` (`subscription`, `manual`, `kept_deposit`, `advance`, `amenities`), P&L by month, `expensesByCategory`, `paymentsByMethod` (invoice payments only), `receivablesAging` (open invoices as of **now**), `amenities {owedCents, collectedCents, owedBy}`, `deposits {heldCents (all-time, as of now), received, refunded, kept, advance, movements}`.
- Collected includes tax; there is no tax report. "Invoiced" is net of advance lines while the advance is counted in full as collected.

### 9.4 KNOWN ISSUES (do not assume these are correct)
- **H1 — Company contract advance is double-counted.** The advance is income when received, but company invoices are always issued in full; nothing takes the advance off.
- **H2 — Single-member contract rent is never invoiced.** `contracts.rentCents` (and the contract's advance) never reach an invoice; monthly generation only bills plans, bookings, amenities and company rent.
- **H3 — Legacy-plan members' advance is never used.** For members without a plan period (`planStart` null), monthly generation bills the plan price but never applies `advanceCredit`, and `applyToOpenInvoice` returns early. They pay the advance and the full invoices.
- **H4 — Company invoices can be generated twice for a month.** Duplicate detection looks for an invoice to the *current* contact. If the contact changes (the contact leaves) and the month is generated again, the rent is billed again.
- **H5 — Money records can be erased or backdated without a trace.** Payments and expenses are hard-deleted; payment `paidAt` and invoice dates accept any date; there is no audit log or closed-month lock, so past months' figures can change silently. Deposit/advance entries can't be reversed if entered wrongly.
- **H6 — Changing plan after paying double-bills, and isn't atomic.** Moving to a different plan (or removing shifts) with a paid invoice gives no credit for the unused period and bills the new plan in full; added shifts are billed for the full period with no proration. The billing runs after the booking transaction, so a failure can leave bookings changed with the old invoice voided and no new one, and `advanceCredit` is a read-then-write outside a transaction.

Other known risks (medium/low), for the record: cancelled/paused members' last bookings and amenities are never billed, and ex-company employees are never billed individually; desk amenity collection has no payment record and runs outside a transaction; advances and deposit refunds only need the `members` permission (in the front-desk preset); plan and amenity invoices ignore the `invoicing` feature; `deleteMember` hard-deletes issued invoices; MRR leaves out contract rent and counts lapsed plan periods; company price changes apply to the whole current month; unused advance can't be refunded and isn't reported; `PATCH /members` can change `planId` without re-billing; `no_show` bookings are never charged; the report's 60-month cap doesn't apply to totals; aging and deposits held are "as of now"; `paymentsByMethod` doesn't reconcile with collected; several amounts have no upper limit (manual invoice unit price, expense amount); platform payments can't be corrected; platform currency is fixed to PKR.

---

## 10. Attendance devices (ZKTeco ADMS) — `services/devices.ts`

- Devices **push** over plain HTTP. Only **PINs and names** are sent to devices; fingerprints stay on the device.
- **PINs:** org-unique numeric `devicePin`, assigned automatically (max + 1, retry on race) when first synced; managers can set (1–9 digits, no leading 0) or clear one.
- **Who belongs on a device:** active non-cancelled members of the location, active managers/staff linked to it, all active owners.
- **Sync:** adds missing people, removes leavers, handles PIN changes. `syncUser` runs after member/staff/company-contract changes.
- **Commands:** device polls every **30 s**, gets ≤ 20; unanswered commands resent after 10 min. Online if seen within 90 s.
- **Punches:** device wall clock → UTC in the location timezone; stored once per (device, pin, time). Unknown PIN → `unknown_pin`; before device registration → `ignored`; > 5 min in the future → `rejected`; disabled account → `rejected`; within 60 s of a successful punch → `duplicate`. **Members:** active member of that location, ≤ 24 h old; checked in → check out; else check in with the front-desk rules (§8.6; a member with no running booking/shift is `rejected` with the reason). **Team:** clock-in/out within a 16 h window, no booking rules.
- `/iclock/cdata` (handshake / ATTLOG upload), `/iclock/getrequest`, `/iclock/devicecmd`, `/iclock/ping`; `.aspx` variants accepted; 2 MB body limit. Unregistered/inactive devices or suspended orgs → 403 `Unknown device`.
- `scripts/zk-sim.ts` simulator; `deploy/adms-relay.js` Cloudflare Worker (HTTP → Vercel HTTPS, optional `ALLOWED_IPS`).

---

## 11. Security & privacy notes
- Tenant isolation via `locationIds` on every request (`assertLocation`) and org checks; another tenant's IDs are reported as not found / forbidden.
- Members never see other members' identities on the schedule/resources.
- Members only see: their own bookings, requests, invoices, visitors, issues, visits, amenity orders/requests; live announcements; spaces & floor objects of their location; shifts of their own plan.
- Passwords bcrypt cost 10; login timing equalised; throttled (per instance).
- Photo uploads magic-byte checked; served with nosniff.
- Health endpoint hides failure reasons. `trust proxy = 1`.
- Finance-specific weaknesses are listed in §9.4.

---

## 12. Demo data (`npm run seed`)
Password for all demo accounts: **`coplaces123`**.
| Role | Email | Context |
|---|---|---|
| Super admin | `admin@coplaces.test` | Platform console |
| Owner | `owner@nest.test` | Nest Cowork, **Pro** package, 2 locations (Nest Clifton, Nest Gulberg) |
| Manager | `manager@nest.test` | Nest Clifton |
| Front desk | `frontdesk@nest.test` | Nest Clifton |
| Member | `hamza.sheikh@example.pk` | Nest member |
| Owner | `owner@hive.test` | Hive Workspaces, **Growth** |
| Owner | `owner@workbay.test` | Workbay, **Starter**, on trial |

Seeded packages: **Starter** (PKR 7,500/mo; visitors; 1 location, 40 members), **Growth** (PKR 19,000/mo; visitors, member_portal, invoicing, expenses, team; 2 locations, 200 members), **Pro** (PKR 45,000/mo; everything; 10 locations, unlimited members), **Pro Yearly** (PKR 450,000/yr). No floor limits are seeded. Spaces are priced **hourly** only (hot desks e.g. PKR 150–200/hour, Day Office PKR 600/hour); the old rate-card prices were removed from the seed. Also seeds Quetta Collective, plans, spaces, shifts, equipment, issues, tasks, bookings, attendance, visitors, invoices, payments, expenses, contracts, a public holiday 10 days out, and platform payment history.

---

## 13. Tests (`test/`)
33 suites, 292 tests (all passing; typecheck clean). Suites: admin, amenities, auth, billing, bookings, bookingsList, checkin-rules, checkinPlan, companyContracts, contractPricing, contracts, deposits, devices, **financeIntegrity** (checks every invoice, payment, report and dashboard figure agree through a full sequence of money movements), floorplan, floors, flows, frontdesk, health, performance, permissions, planMembers, platform, portalFixes, pricingTab, reports, roomRequests, security, shifts, spaces, tenancy, time, usecases. `test/helpers.ts` builds in-memory DBs and signed-in agents. Run `npm test` and `npm run typecheck`.

Not yet covered: the §9.4 issues (H1–H6), cancelled/paused members' final charges, tax rate changing after issue, finance report month boundaries in a non-UTC timezone, cross-tenant IDs on payments/expenses/deposits, very large amounts, future/backdated `paidAt`, amenity invoices without `invoicing`, and concurrency outside transactions.

---

## 14. Guidance for agents changing this code
- **Schema changes:** edit `src/db/schema.ts`, run `npm run db:generate`, commit the new `drizzle/NNNN_*.sql` + snapshot. Migrations run automatically on start (`createDb`) and on Vercel build.
- **New tenant feature gate:** add to `FEATURES` in `src/features.ts` and use `requireFeature` on the router; the frontend has its own copy of labels.
- **New team permission:** add to `PERMISSIONS` in `src/lib/permissions.ts`; consider `FRONT_DESK_PRESET` and legacy-manager behaviour.
- **New space kind or style:** update `RESOURCE_KINDS`, `STYLES`, the `isAssigned/isHourly/isPriced` helpers, `PLAN_KINDS`, shift `BOOKABLE`, and the web app's catalogue copy.
- Always store money as integer cents, dates as `YYYY-MM-DD` in the location tz, instants as UTC ISO. Use the business-date helpers for anything near midnight.
- Put business rules in `src/services/*` so every path shares them (e.g. `checkInMember` is used by the front desk, the portal and fingerprint punches; `planBooking` by quotes, bookings and room requests).
- **Money changes must run in one `db.transaction`**, and every figure that depends on them (invoice status, `paidCents`, advance used, dashboard, finance report) must be checked by `financeIntegrity.test.ts`-style tests.
- Validate input with Zod via `parse()`; throw `HttpError` helpers with human-readable messages (the UI shows them verbatim).
- Never return another tenant's data; always `assertLocation` / check `organizationId`.
- Don't commit `.env`, `certs/`, `data/`, `dist/` (gitignored).
