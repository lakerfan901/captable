# LLC mode — 02 Economics (implementation plan)

Scope: capital calls, default workflow, revenue / Management Fee / expenses / reserves, Manager payment ledger, distributions, derived balances, member statement, fair-value calculator, term clock, Overview widgets, and the pure calculation library `src/lib/llc/**`.

Specification: the Operating Agreement of OCTAGON GPU I LLC ("OA"), final v2. Section numbers below refer to it. Where this plan and the OA differ, the OA wins and the plan must be corrected, not the code bent.

Companion plans: `01-foundation.md` (FOUNDATION, packages `F0`–`F15`) and `03-governance.md` (GOVERNANCE, packages `G1`–`G19`). This plan was reconciled with both as written on 2026-11-12; where it names one of their files, functions or packages, the name is taken from those documents.

Conventions used in every package (B1–B7 of `01-foundation.md` are binding; this list restates them for economics):

- **Money** is integer cents. Database: `BigInt` columns named `…Cents`. Library and server code: `bigint` (`Cents`). **On every boundary** (tRPC input and output, client props, `Json` columns, audit summaries, CSV, job payloads) cents are a JS `number` (FOUNDATION `ZCents`, `numberToCents`, `centsToNumber` from `src/lib/money.ts`) or, in CSV and the GOVERNANCE adapters, a decimal string (`centsToDecimalString`). Wherever a procedure table below shows `Cents` or `zCents`, the wire type is `number`; handlers convert inputs with `numberToCents` and return `toWire(result)` (E7).
- **Units** are `MicroUnits = bigint` (units × 1,000,000) inside the library, `Decimal @db.Decimal(18, 6)` in the database and a 6-decimal string (`"40.000000"`) on the wire. At $1,000 per unit, 1 cent = 10 micro-units, so every cent amount maps to units exactly.
- **Rates** are integer basis points (8% = 800).
- **Dates** are calendar dates `IsoDate = "YYYY-MM-DD"` strings (identical to FOUNDATION's `DateOnly`) in the library, in server code and on the wire; `DateTime @db.Date` in the database, converted only with FOUNDATION's `fromDateOnly` / `toDateOnly` (`src/lib/date-only.ts`). Never call `new Date()` or `Date.now()` in `src/lib/llc/**`; "today" is computed once per request in the server layer with `economicsToday(ctx.company.timezone)` (E7; FOUNDATION's `todayInTimeZone` plus a non-production test clock) and passed in.
- **Rounding**: half-up to the cent (`roundDiv`), once per holder per as-of date for accruals; pro-rata splits use largest remainder (`allocateProRata`) so parts always sum to the whole.
- **Procedures** use FOUNDATION's `withLlcAccessControl` (adds `ctx.company = { id, publicId, name, entityType, timezone }`), declare `.meta({ policies })`, take the company from `ctx.membership.companyId`, throw `TRPCError` (`BAD_REQUEST` for a rule violation with a message naming the OA section, `NOT_FOUND` for an id outside the company, `CONFLICT` when a confirmed proposal no longer matches) and never return `{ success: false }`.
- **Pages** start with `await requireLlc()` (`src/server/entity.ts`) and then follow A.2.7. Dialogs are local `<Dialog>` components; nothing is registered in `src/components/modals/index.ts`. Money inputs use `NumericFormat` from `react-number-format` (`thousandSeparator`, `decimalScale={2}`, `prefix="$"`) and submit `Math.round(floatValue * 100)`.

## 0. Published signatures (FOUNDATION and GOVERNANCE code against these)

All in `src/lib/llc/`, pure, no imports outside the folder, relative imports only. Package **E1** delivers every file in this section (it is the "E-lib" that FOUNDATION's F6 waits for).

```ts
// dates.ts — only what FOUNDATION's src/lib/date-only.ts does not provide, plus identical-semantics helpers the library needs internally
export type IsoDate = string; // "YYYY-MM-DD" (= FOUNDATION DateOnly)
export function isIsoDate(v: string): v is IsoDate;                 // same rule as isValidDateOnly
export function compareIso(a: IsoDate, b: IsoDate): -1 | 0 | 1;
export function daysBetween(from: IsoDate, to: IsoDate): number;    // to − from (= diffInDays), may be negative
export function addDays(d: IsoDate, n: number): IsoDate;
export function addMonths(d: IsoDate, n: number): IsoDate;          // clamps to month end
export function addYears(d: IsoDate, n: number): IsoDate;           // = addMonths(d, 12 * n); Feb 29 → Feb 28
export function minIso(...d: IsoDate[]): IsoDate;
export function maxIso(...d: IsoDate[]): IsoDate;
export function dayOfWeek(d: IsoDate): 0 | 1 | 2 | 3 | 4 | 5 | 6;   // 0 = Sunday
export function quarterOf(d: IsoDate): { year: number; quarter: 1 | 2 | 3 | 4; start: IsoDate; end: IsoDate };
// NOT here (use FOUNDATION): todayInTimeZone, fromDateOnly, toDateOnly, formatDateOnly, ZDateOnly.

// business-days.ts — date strings in, date strings out (GOVERNANCE: wrap with fromDateOnly/toDateOnly if you hold Date objects)
export interface BusinessDayOptions {
  holidays?: "US_FEDERAL" | "NONE";     // default "US_FEDERAL"
  saturdayObservedOnFriday?: boolean;   // default true (5 U.S.C. 6103 rule); Sunday holidays always observed Monday
  extraHolidays?: readonly IsoDate[];   // default []
}
export function usFederalHolidays(year: number, opts?: Pick<BusinessDayOptions, "saturdayObservedOnFriday">):
  { name: string; date: IsoDate; observedOn: IsoDate }[];           // 11 holidays, see E1
export function isBusinessDay(d: IsoDate, opts?: BusinessDayOptions): boolean;
export function addBusinessDays(d: IsoDate, n: number, opts?: BusinessDayOptions): IsoDate;
  // n ≥ 1: the n-th business day strictly after d (the day after d is the first candidate).  n = 0: d unchanged (no roll).
  // n < 0: the |n|-th business day strictly before d.
export function nextBusinessDay(d: IsoDate, opts?: BusinessDayOptions): IsoDate;       // addBusinessDays(d, 1)
export function businessDaysBetween(from: IsoDate, to: IsoDate, opts?: BusinessDayOptions): number; // business days in (from, to]; 0 if to ≤ from

// units.ts — signature and reference values fixed by 01-foundation.md E2.2
export function unitsForAmount(amountCents: bigint, pricePerUnitCents: bigint, fractionalAllowed: boolean): string;
  // 6-dp string, truncated toward zero; floor to whole units when fractionalAllowed is false; throws when price ≤ 0 or amount < 0
export function microUnitsForAmount(amountCents: bigint, pricePerUnitCents: bigint, fractionalAllowed: boolean): MicroUnits; // same value as bigint
export function unitFractionMillionths(units: MicroUnits, totalUnits: MicroUnits): number; // display: 25% → 250000; 0 when total = 0
export function pctString(units: MicroUnits, totalUnits: MicroUnits): string;             // wire percentage, 4 dp: "22.2222"

// money.ts — no parsing or formatting of dollars here (use parseDollarsToCents / formatCents from src/lib/money.ts)
export type Cents = bigint;
export type MicroUnits = bigint;
export class LlcMathError extends Error { constructor(public code: string, message: string) }
export function roundDiv(n: bigint, d: bigint): bigint;            // half away from zero; d > 0
export function centsToDecimalString(c: Cents): string;            // "1234.56", "-0.05" (CSV, GOVERNANCE adapters)
export function microUnitsFromDecimal(v: string | { toString(): string }): MicroUnits; // "12.345670" or a Prisma Decimal → 12345670n
export function microUnitsToDecimalString(u: MicroUnits): string;  // "12.345670" (wire format for units)

// config.ts — LlcEconomicsConfig and OA_DEFAULTS (full definition in E1)
```

Server functions exported for the other plans are listed in section E.

---

## A. Findings (current code)

### A.1 Stack facts that constrain the design

| Fact | Where | Consequence |
|---|---|---|
| `relationMode = "prisma"` (no database foreign keys) | `prisma/schema.prisma:7-10` | Every relation scalar needs its own `@@index`. Referential integrity and tenant scoping are application code. |
| Enums are re-exported to `prisma/enums.ts` by a custom generator | `prisma/schema.prisma:16-18`, `prisma/enum-generator.cjs` | After any schema edit run `node_modules/.bin/prisma generate`; import enums from `@/prisma/enums`, never from `@prisma/client` in client components. |
| Existing money columns are `Float` | `prisma/schema.prisma:350-351, 687-690, 776, 830, 896` | Do not copy. Economics columns are integer cents. |
| Prisma CLI config is `prisma.config.ts`; production runs `prisma migrate deploy` | `prisma.config.ts:1-27` | Migrations must be plain additive SQL that deploys on a live database. Last migration: `prisma/migrations/20240906132847_add_new_status`. |
| tRPC uses `superjson` on both ends | `src/trpc/api/trpc.ts:132`, `src/trpc/shared.ts:7` | `bigint` would survive tRPC, but not `JSON.stringify` (audit rows, `Json` columns, Sentry's `attachRpcInput`, job payloads). FOUNDATION's binding convention B1 therefore puts cents on every boundary as a JS `number`; economics follows it (`toWire`, E7). |
| TypeScript target ES2022, `noUncheckedIndexedAccess: true` | `tsconfig.json:6,14` | `bigint` literals (`10n`) are fine. Array indexing yields `T \| undefined`; write loops with `for…of`. |
| No vitest config file; tests are colocated `*.test.ts` | `package.json:30`, e.g. `src/server/tenant-ownership.test.ts` | The `@/` alias does not resolve in tests. `src/lib/llc/**` must use relative imports only and must not import `server-only`, `@/env`, Prisma or Next. Same reason as the header comment in `src/server/tenant-ownership.ts:15-16`. |
| Biome: `suspicious/useAwait` = error, `style/useImportType` = error, pre-commit runs `lint-staged` | `biome.json:27-31`, `.husky/pre-commit` | No `async` function without `await`; use `import type` for type-only imports. |
| Zod 4 with global v3-style error map | `src/lib/zod-error-map.ts`, imported at `src/trpc/api/trpc.ts:15` | Use `z.coerce.number<number>()` style as in `src/trpc/routers/share-class/schema.ts:11`. `z.bigint()` works over superjson. |

### A.2 How an existing feature is wired end to end (model for every package)

1. **Schema**: model with `companyId` + `@@index([companyId])`, back-relation array on `Company` (`prisma/schema.prisma:125-165`).
2. **Router**: `src/trpc/routers/<name>/router.ts` exports `createTRPCRouter({...})`, registered by hand in `src/trpc/api/root.ts:32-57`.
3. **Procedure with RBAC and tenant scope** — the pattern to copy is `src/trpc/routers/stakeholder-router/procedures/update-stakeholder.ts:5-66`:
   - `withAccessControl.meta({ policies: { <subject>: { allow: ["<action>"] } } }).input(schema).mutation(...)`;
   - `ctx.membership.companyId` (set in `src/trpc/api/trpc.ts:110-114`) is the only company id ever used; every `where` includes `companyId`;
   - writes run in `db.$transaction(async (tx) => { … await Audit.create({...}, tx) })`.
   - Do **not** copy `src/trpc/routers/share-class/router.ts` (`withAuth` + `checkMembership`, no RBAC subject) or its catch-all that swallows errors into `{ success: false }`. Economics mutations throw `TRPCError`.
4. **Client-supplied ids**: `assertCompanyOwns(tx, companyId, { stakeholderIds: [...] })` from `src/server/tenant-ownership.ts:193-209` for stakeholders/documents/members. Its entity list is closed (`CompanyScopedEntity`, lines 33-38); FOUNDATION's F1 extends it with `unitClassIds`, `commitmentIds`, `capitalReceiptIds`; economics rows are read with `findFirst({ where: { id, companyId } })` and a miss throws `NOT_FOUND` (`notFound`, package E7). Never `findUnique({ where: { id } })` on a client id.
5. **RBAC**: subjects are a closed tuple in `src/lib/rbac/subjects.ts:1-11`; `ADMIN` gets `*` on every subject automatically (`src/lib/rbac/constants.ts:6-9`). Actions: `create | read | update | delete | *` (`src/lib/rbac/actions.ts`).
6. **Audit**: `Audit.create(data, tx)` (`src/server/audit/index.ts:26-30`); `action` and `target.type` are closed Zod enums (`src/server/audit/schema.ts:5-81` and `:90-107`) — new values must be appended there or TypeScript rejects the call. `context: { requestIp, userAgent }` come from `ctx`.
7. **Server page**: `src/app/(authenticated)/(dashboard)/[publicId]/settings/bank-accounts/page.tsx:14-24` — `const { allow } = await serverAccessControl(); const data = await allow(api.x.y(), ["subject", "read"]); if (!data) return <UnAuthorizedState />;` using the RSC caller `api` from `src/trpc/server.ts:28`. The layout already redirects when `publicId` is not the session company (`[publicId]/layout.tsx:26-28`).
8. **Client components**: forms are `react-hook-form` + `zodResolver`, mutation via `api.<router>.<proc>.useMutation`, `toast` from `sonner`, then `router.refresh()` — see `src/components/modals/share-class/share-class-form.tsx:67-107`. Modals are registered in `src/components/modals/index.ts:23-46` (`pushModal("Name", props)`). Multi-step flows: `src/components/ui/stepper.tsx`. Tables: plain `src/components/ui/table.tsx` (example `[publicId]/share-classes/table.tsx`) or the TanStack wrapper in `src/components/ui/data-table/`. Empty state: `src/components/common/empty-state.tsx`.
9. **Navigation**: pure config in `src/components/dashboard/sidebar/nav-config.ts` (`getNavSections`), rendered by `src/components/dashboard/sidebar/index.tsx` (owned by FOUNDATION in LLC mode).

### A.3 Email, jobs, PDF

- `sendMail(options, log?)` in `src/server/mailer.ts` (nodemailer, `from` = `Captable <EMAIL_FROM>` unless header `X-From-Name` is set) writes the `EmailLog` row itself (there is no separate wrapper) and returns `{ emailLogId: string | null, sentAt: Date, messageId: string | null }`; `emailLogId` can be null when logging failed. It throws when the send fails.
- Templates: `src/emails/*.tsx` built from `react-email` components (`src/emails/ShareUpdateEmail.tsx:1-83`), rendered with `render()` from `react-email` (`src/jobs/share-update-email.ts:1,38`). Each template sets `PreviewProps`.
- Jobs: `defineWorkerConfig` / `defineJob` / `defineWorker` in `src/lib/queue.ts:94-139`; job names are typed from `src/constants/job.ts`; workers are registered in `src/jobs/register.ts` which runs from `src/instrumentation.ts`. Economics sends its two emails **synchronously inside the mutation** (reason: a Call Notice is "effective when sent by email", so the due date must be computed from the actual send; ≤ 50 recipients). No new job types.
- PDF: `renderToBuffer(<Template … />)` from `@react-pdf/renderer`, see `src/server/esign.ts:187-189` with the template `src/pdf-templates/audit-log-template.tsx`. Economics produces no PDF; GOVERNANCE's reports consume the data functions in section E.

### A.4 Traps

1. **`BankAccount` is not usable today.** `create` and `delete` are empty stubs (`src/trpc/routers/bank-accounts/router.ts:36-55`), the modal is a placeholder (`src/components/modals/bank-account-modal.tsx`), the table renders the text "Table", `getAll` selects only `id, bankName, accountNumber, primary, createdAt`, and `@@unique([companyId, primary])` (`prisma/schema.prisma:194`) permits at most one primary and one non-primary account per company. Call Notice emails need the full wire block. `01-foundation.md` (E2.7) assigns this to ECONOMICS: package **E8** implements create/list/delete. The unique index is left as it is (changing it is not additive).
2. **`Member` is the team user**, `Stakeholder` is the LLC member. `ctx.membership.memberId` is a team-user id; store it in `createdById` columns.
3. `Stakeholder.email` is globally unique today (`prisma/schema.prisma:280`); FOUNDATION's wave makes it unique per company. Call Notices go to `noticeEmail ?? email`.
4. The Overview page is static placeholder numbers (`[publicId]/page.tsx:34-40`); FOUNDATION replaces it for LLC companies and renders the economics widget slot.
5. Prisma returns `@db.Date` as a JS `Date` at UTC midnight. Use FOUNDATION's `toDateOnly`; never `getDate()`/`toLocaleDateString()` on it (off-by-one west of UTC).
6. Shared closed registries are edited by all three plans: `src/server/audit/schema.ts`, `src/lib/rbac/subjects.ts`, `src/trpc/api/root.ts`. FOUNDATION's F1 edits them first; economics appends to them **only in package E6** (after F1 is merged, one block each); later packages fill in files E6 created. `prisma/schema.prisma` and `prisma/migrations/**` are edited only by FOUNDATION's package F0, which pastes section C of this plan.
7. Interactive transactions default to a 5 s timeout in Prisma; the finalize transaction passes `{ timeout: 30_000, maxWait: 10_000 }`.
8. **Receipts belong to FOUNDATION.** `CapitalReceipt` rows are written only through the services in `src/server/llc/commitments.ts` (F6): `recordCapitalReceipt`, `voidCapitalReceipt`, `setReceiptPrefReturnStart`, `reduceAcceptedCommitment`, `createCommitment`, `decideCommitment`. A receipt's capital is `appliedCents` (not `amountCents`), its units `unitsIssued`, its effective date `appliedOn`; void rows (`voidedAt` not null) and unapplied rows (`appliedCents = 0` and `unitsIssued = 0`) are ignored. There is a fifth kind `FORFEITURE` (negative `appliedCents` and `unitsIssued`).
9. FOUNDATION's F2 creates placeholder pages at `[publicId]/capital-calls/page.tsx`, `distributions/page.tsx`, `fair-value/page.tsx`, `financials/revenue/page.tsx`, `financials/manager-payments/page.tsx`, `financials/reserves/page.tsx`, `financials/loans-advances/page.tsx`. Where a package below says "create" for one of these files, it **replaces the placeholder's content**; routes are never renamed.

---

## B. Agreement rules as implemented

Each rule: OA section → rule → default for any ambiguity (with the switch) → enforcing function. Switches live in `LlcEconomicsConfig` (built from `LlcTerm` + FOUNDATION's Preferred `UnitClass`; see E1, E7 and C.3). Offering terms that FOUNDATION keeps on `UnitClass` (`pricePerUnitCents`, `prefReturnBps`, `residualSplitBps`, `fractionalUnitsAllowed`, `balanceReturnStartRule`, `finalClosingDate`, `balanceOutsideDate`) are read from there and are not duplicated on `LlcTerm`. "Proposal" = computed, shown to the Manager, nothing written until confirmed.

### Units and capital

**R1 — Units follow cash received.** §1.24 "one (1) Preferred Unit for each One Thousand Dollars ($1,000) of Capital Contribution"; §1.5 "Preferred Units, the Preferred Return, Unreturned Capital Contributions, and Capital Accounts are based only on amounts actually received by the LLC (or credited under Section 4.9(iv))". Units = amount ÷ `pricePerUnit`. Units are **not** reduced by returns of capital (§5.6(d) reduces Unreturned Capital Contributions only); they change only by receipt, forfeiture (R34), credit (R36) and transfer (R39). Units are computed and stored by FOUNDATION on each receipt (`CapitalReceipt.unitsIssued`); economics sums them. → `unitsForAmount`.

**R2 — Fractional units.** §4.9(iv) expressly allows "fractional Preferred Units" for credits; §1.24 is silent for ordinary receipts. Default: fractional units allowed everywhere, 6 decimals (switch: FOUNDATION's `UnitClass.fractionalUnitsAllowed`, default `true`). When `false`, each receipt issues `floor(amount ÷ price)` whole units (FOUNDATION F6). → `unitsForAmount`.

**R3 — Capital Contributions vs Unreturned Capital Contributions.** §5.6(b): "the aggregate Capital Contributions made (or credited under Section 4.9(iv)) with respect to the Preferred Units held by that holder, including, for a transferee, the amounts attributable to the transferred Units, reduced by any distributions made pursuant to Section 5.6(d)". Two per-holder balances: `contributed` (receipts + credits − forfeitures ± transfers; drives units) and `unreturned` (`contributed` − tier (d) distributions; drives accrual and tier (d)). → `computePositions`.

### Preferred Return

**R4 — Rate and day count.** §5.6(b): "cumulative, non-compounding preferred return at the rate of eight percent (8.0%) per annum, computed on the basis of a 365-day year for the actual number of days elapsed, on their respective Unreturned Capital Contributions". Accrual for a lot = `outstanding × days × 800 / (365 × 10,000)`; always ÷365, including leap years (a full leap year yields 366/365 × 8%). Unpaid Preferred Return never earns a return. Day convention (ambiguity: endpoints): a change on date *t* (receipt, start date, return of capital, forfeiture) affects accrual for days **after** *t*; accrual through as-of date *D* counts `D − start` days. So capital received 2026-11-16 has accrued 0 on 2026-11-16 and exactly 8.00% on 2027-11-16. No switch. → `computePositions`.

**R5 — Accrual start.** §5.6(b): "Beginning, for each Preferred Unit, on the date the Capital Contribution for that Preferred Unit is received by the LLC (or, for any part of a Balance under Section 4.9, the date it is due under Section 4.9, if later)"; §4.9: "the Preferred Return on any part of the Balance accrues only from the date that part is due (under a Call Notice or, if none is given, March 31, 2027)"; §4.9(iv): credits accrue "from the Credit Date". Start date per lot:
- `INITIAL`, `REPLACEMENT`: `receivedOn` (for money wired before acceptance this is the wire date, FOUNDATION Q3, even though the capital and units exist only from `appliedOn`);
- `BALANCE` allocated to a Call Notice line: `max(receivedOn, line.dueOn)` (switch: FOUNDATION's `UnitClass.balanceReturnStartRule`; with `RECEIPT_DATE` every Balance lot starts on `receivedOn`);
- `BALANCE` not allocated to any line (prepaid, no notice yet): `max(receivedOn, balanceOutsideDate)`; when a later Call Notice covers that money the allocation fixes the start at that line's `dueOn` (R28);
- `CREDIT`: the Credit Date.
- `FORFEITURE`: not a lot and has no start date (`prefReturnStartDate` is null), but it is not "no effect": its negative `appliedCents` reduces the holder's accrual base from the Forfeiture Date (the row's `receivedOn`, equal to its `appliedOn`), so the return on the Forfeited Amount stops there (§4.9(iv); R34). `loadLedger` (E7) must map the row to a `FORFEITURE` event and `computePositions` (step 6) must reduce the lots by it; code that sums accrual per receipt from `prefReturnStartDate` alone would keep accruing on the forfeited capital.
→ `resolvePrefReturnStart`, `buildCapitalLots`.

**R6 — Accrued and unpaid.** Per holder: `accrued(D) = roundDiv(Σ lot numerators, 365 × 10,000)` computed from the full ledger as of *D* and rounded once; `unpaid(D) = accrued(D) − tier (c) paid − extinguished (R34) − carried out + carried in (R39)`. Never negative (enforced by tier (c) cap). → `computePositions`.

**R7 — Measurement date for tier (c).** §5.6(c) says "accrued and unpaid Preferred Return" without a date. Default: accrued through the distribution **payment date** (switch `prefAccrualCutoff: "PAYMENT_DATE" | "PERIOD_END"`, default `"PAYMENT_DATE"`). → distribution run (E15) chooses the as-of date passed to `computePositions`.

**R8 — Defaulting member's paid capital keeps accruing.** §4.9(iii) suspends votes and distributions, not accrual. Default: accrual continues (switch `accrueOnDefaulterCapital`, default `true`; when `false` the engine skips days inside each default window `(dueOn, curedOn]`). → `computePositions` (`accrualPauses` argument).

### Waterfall

**R9 — Tier (c).** §5.6(c): "Available Cash shall first be distributed to the holders of Preferred Units, pro rata in proportion to their respective accrued and unpaid Preferred Return, until all accrued and unpaid Preferred Return has been paid in full." Pay `min(amount, Σ unpaid)`, split by `allocateProRata` with weights `unpaid`. → `runWaterfall`.

**R10 — Tier (d).** §5.6(d): "one hundred percent (100%) to the holders of Preferred Units, pro rata in proportion to their respective Unreturned Capital Contributions, until each such holder's Unreturned Capital Contributions have been reduced to zero. Distributions under Section 5.6(c) do not reduce Unreturned Capital Contributions." Pay `min(remaining, Σ unreturned)`, weights `unreturned` (as of the payment date, before this distribution). Within a holder the return reduces every lot pro rata to its outstanding amount (ambiguity; switch `capitalReturnLotOrder: "PRO_RATA" | "FIFO" | "LIFO"`, default `"PRO_RATA"` — only matters while a lot is not yet accruing). → `runWaterfall`, `computePositions`.

**R11 — Tier (e).** §5.6(e): "(i) seventy percent (70%) to the holders of Preferred Units, pro rata in accordance with their respective Preferred Unit Percentage Interests; and (ii) thirty percent (30%) to the holders of Common Units, pro rata in accordance with their respective Common Unit Percentage Interests." Split the remainder into two pools with `allocateProRata` weights `[7000, 3000]` (`UnitClass.residualSplitBps`), then each pool by units held. The split is `UnitClass.residualSplitBps` of the Preferred class (7000); the Common share is the complement. Preferred Unit Percentage Interest uses **all** outstanding Preferred Units including a Defaulting Member's (R17) and Financial-Interest-only holders (R19). → `runWaterfall`.

**R12 — One waterfall for everything; no other tiers.** §5.6(f), (g). Sale, insurance, casualty and liquidation proceeds run through (c)→(d)→(e) with the same function. → `runWaterfall`.

**R13 — Return of unused capital goes straight to (d).** §1.15: unused Capital Contributions "shall be returned … to the holders of Preferred Units in proportion to their Unreturned Capital Contributions; such a return is treated as a distribution under Section 5.6(d) (and reduces Unreturned Capital Contributions) whether or not accrued Preferred Return has been paid, and is not a distribution under Section 5.6(c)." Mode `D_ONLY`: tier (d) only; an amount greater than Σ unreturned is a validation error. → `runWaterfall({ mode: "D_ONLY" })`.

**R14 — Cent rounding.** Not in the OA. `allocateProRata(total, weights)`: each share = `floor(total × w / W)`; leftover cents go one each to the largest remainders `(total × w) mod W`; ties → larger weight, then smaller key (string compare). Tier totals and line totals always sum exactly to the amount distributed. → `allocateProRata`.

### Netting on a member's line

**R15 — Statute limit.** §5.6(a): distributions are "Subject to the limitations of the Statute (including W.S. 17-29-405)". Not computed. The finalize step requires the Manager to tick "The LLC will be able to pay its debts as they come due and its assets will exceed its liabilities after this distribution (W.S. 17-29-405)"; the tick is stored. → E15 `finalize`.

**R16 — Tax paid for a member is an advance.** §9.2: "any tax paid on a Member's behalf is treated as an advance against, and reduces, the next distributions otherwise payable to that Member under Sections 5.6 and 11.4, and, if not recovered from distributions, shall be repaid by the Member on demand." The line's gross amount counts as distributed (tiers unchanged); cash paid is reduced by `min(remaining payable, outstanding advance)`. Default: no tax distributions exist. → `netDistributionLine`.

**R17 — Defaulting Member: computed, withheld, applied.** §4.9(iii): "no distribution under Section 5.6 shall be made on them; amounts so withheld are applied against the unpaid Balance, interest, and costs (and are treated for all purposes as distributed to the Defaulting Member and immediately paid by it to the LLC), with any excess paid to the Defaulting Member when the default is cured". The Defaulting Member **stays in the waterfall** (its units and balances count in every tier). Its whole gross line is withheld and applied; default order of application follows the text: Balance, then interest, then costs (ambiguity; switch `defaultOffsetOrder`, default `["BALANCE","INTEREST","COSTS"]`, alternative `["COSTS","INTEREST","BALANCE"]`). The part applied to Balance is a Capital Contribution received on the payment date: a `CapitalReceipt` (kind `BALANCE`) with units and Preferred Return from that date, sequenced **after** the distribution so it does not change the same distribution's percentages. If the application pays everything owed the default is cured and the excess is payable in the same run; otherwise nothing is paid. Order with R16: default offset first, tax advance from any excess. → `applyDefaultOffset`, `netDistributionLine`.

**R18 — Costs and interest still owed after a cure by replacement funding** (§4.9(v): "the LLC may withhold those amounts from distributions otherwise payable to the Defaulting Member"). Default: unpaid default interest and costs of a `CURED` default continue to be netted from that member's distributions (same function, `suspended = false`: only interest and costs are taken, the rest is paid). → `applyDefaultOffset`.

**R19 — Financial-Interest-only holders are paid.** §1.8: "For purposes of Sections 4.4, 4.5, 5, 9.2, and 11.4, a Person holding only a Financial Interest is treated as the holder of the Units concerned". Distribution lines are keyed by the holder of record regardless of FOUNDATION's `memberStatus`. → ledger loader (E7).

### Available Cash, reserves, fee, expenses

**R20 — Available Cash.** §1.15: "all cash received by the LLC from operations, interest and other income, the sale or other disposition of LLC assets, and insurance or casualty proceeds, less (i) all expenses and obligations of the LLC paid or payable for such period, including colocation, power, insurance, marketplace and payment fees, equipment repair and replacement, and the Management Fee, and (ii) the minimum operating reserve required by, and any additional reserves established by the Manager under, Section 5.6(a); and increased by any reserves previously established that the Manager determines are no longer needed. Capital Contributions are not Available Cash." Implemented cumulatively so that shortfalls and undistributed amounts carry forward:

```
availableCash(asOf) = max(0, raw)
raw = Σ grossRevenue(months ≤ asOf)            // customer receipts − pass-through fees (R22)
    + Σ otherIncome + assetSaleProceeds + insuranceProceeds (months ≤ asOf)
    + Σ default interest and costs collected (≤ asOf)
    − Σ ExpenseEntry.amount where fundingSource = OPERATING_CASH (incurredOn ≤ asOf)
    − Σ managementFee accrued (months ≤ asOf)
    − Σ member-loan interest paid and principal repaid from operating cash (≤ asOf)
    − net reserve balance funded from OPERATING_CASH (≤ asOf)
    − Σ gross amount of finalized, unreversed OPERATING and SALE_OR_LIQUIDATION distributions
```
Capital-side cash (contributions, equipment and organizational costs paid from capital, reserves funded from capital, returns of unused capital) is tracked separately as `unusedCapital` and never enters `availableCash`. Marketplace and payment fees are deducted **once**, inside Gross Revenue; they must not also be entered as expenses (the expense categories have no such category and the form says so). The Manager cannot type the amount of an OPERATING distribution: it equals `availableCash`; to distribute less, establish a reserve (R21). → `computeAvailableCash`.

**R21 — Reserves.** §5.6(a): "The Manager shall maintain a minimum operating reserve of Fifty Thousand Dollars ($50,000) and may establish additional reserves … for anticipated expenses, liabilities, equipment repair and replacement, colocation deposits, insurance deductibles, taxes, working capital, and wind-down costs, and shall report the reserve balance to the Members with each quarterly distribution". `ReserveEntry` ledger of `ESTABLISH` / `RELEASE` per named reserve, each with a funding source (`OPERATING_CASH` reduces Available Cash; `CAPITAL_CONTRIBUTIONS` reduces unused capital — §1.15 lists "the reserves under Section 5.6(a)" among permitted uses of capital). Finalizing an OPERATING distribution is blocked while the `MINIMUM_OPERATING` balance is below `minimumOperatingReserveCents`. A release returns to the pool it was funded from (ambiguity: §1.15 sentence 1 would make every release Available Cash; default `SAME_AS_FUNDING`, per-release override allowed with a reason). The reserve balance is stored on every finalized distribution. → `reserveBalances`, `computeAvailableCash`.

**R22 — Management Fee.** §6.18: "five percent (5.0%) of Gross Revenue"; "'Gross Revenue' means all revenue actually received by the Company from customers for computing services, after deduction of third-party marketplace commissions, platform fees, payment-processing fees, and similar pass-through transaction fees. Gross Revenue does not include Capital Contributions, Member advances, or insurance, casualty, or asset-sale proceeds"; "accrued monthly and paid quarterly"; "payable before any distribution under Section 5.6"; continues during extensions and winding up. Per month: `grossRevenue = customerReceipts − passThroughFees`; `fee = roundDiv(grossRevenue × 500, 10,000)` (rounded per month; a negative month produces a negative accrual that nets against later months). Interest and other income, asset-sale and insurance proceeds are **not** in the fee base. Cash basis, entered monthly by the Manager. The accrued fee reduces Available Cash when accrued; payments to the Manager are `ManagerPayment` rows (category `MANAGEMENT_FEE`); unpaid fee = accrued − paid and is a creditor claim in liquidation (R40). → `managementFeeForMonth`, `managementFeeSummary`.

**R23 — Organizational and offering expense cap.** §6.21: the LLC "shall bear, and shall reimburse the Manager and its Affiliates for, all documented third-party out-of-pocket organizational, offering, formation, legal, filing, and other expenses … incurred in connection with the formation of the LLC, the offering of the Preferred Units, and the acquisition of the LLC's servers, not to exceed Forty Thousand Dollars ($40,000) in the aggregate without the approval of a Preferred Supermajority." The cap applies to what the LLC **bears**, whether paid directly or reimbursed. Counter = Σ `ExpenseEntry.amountCents` where `countsTowardOrgCap` + Σ `ManagerPayment.amountCents` where `countsTowardOrgCap` and no linked `ExpenseEntry` (reversals negative). `countsTowardOrgCap` defaults to `true` for category `ORGANIZATIONAL_OFFERING` and `false` otherwise; reimbursements under §3.6 of ordinary operating expenses are not capped. A write that would take the counter above `orgExpenseCapCents + approved increases` is rejected unless it carries a `resolutionId` (GOVERNANCE `Resolution`, Preferred Supermajority). The price of the servers themselves is category `EQUIPMENT_ACQUISITION` and is not counted. → `orgExpenseCapStatus`.

**R24 — Amounts paid to or through the Manager and Affiliates.** §8.2: "Each such quarterly report and annual statement shall also list all amounts paid by the LLC to or through the Manager and its Affiliates during the period." The list = every `ManagerPayment` in the period (to: `MANAGEMENT_FEE`, `EXPENSE_REIMBURSEMENT`, `OTHER`; through: `PURCHASING_AGENT_PASS_THROUGH`) **plus**, read literally, distributions and loan repayments paid to holders flagged `isInsider` (FOUNDATION) including the Common Member (parameter `includeInsiderDistributions`, default `true`, shown as a separate sub-list). → `getPeriodEconomics`.

**R25 — Member loans.** §4.6: an advance "is not a Capital Contribution, shall be documented by a promissory note stating its interest rate and maturity, and shall be repaid in accordance with that note before distributions are made under Section 5.6"; §11.4(b). `MemberLoan` + `MemberLoanPayment`. Finalizing an OPERATING or SALE distribution is blocked while any loan has `maturityOn ≤ paymentDate` and outstanding principal > 0. Loan interest is simple, actual/365, informational (`loanAccruedInterest`); the amounts actually paid are entered. In liquidation the full outstanding principal and accrued interest rank ahead of members (R40). Approvals (§6.16(d), (i)) are GOVERNANCE; the loan row stores a `resolutionId`.

### Call Notices and default

**R26 — Balance and Call Notice.** §4.9: "(a) not less than forty percent (40%) of its Capital Contribution at the time its signature page is accepted (the 'Initial Installment'), and (b) the balance (the 'Balance') within three (3) business days after written notice from the Manager (a 'Call Notice') … in any event the Balance is due not later than March 31, 2027, whether or not a Call Notice has been given. A Call Notice is effective when sent by email to the address shown on Exhibit A". Balance of a commitment = `acceptedCents` − applied `INITIAL` receipts; FOUNDATION's `Commitment.acceptedCents` is the single commitment figure and is reduced through `reduceAcceptedCommitment` when a Replacement Funder funds part of a defaulted call (R31), so the **uncalled** Balance is `(acceptedCents + Σ replacement funding) − initial − Σ called`. A notice may call all or part of each selected member's uncalled Balance ("the date that part is due"). `dueOn = min(addBusinessDays(sentOn, 3), balanceOutsideDate)` where `sentOn` is the calendar date of the successful send in `Company.timezone` (the day of sending is not counted; a notice sent on a non-business day counts from that calendar day). No Call Notice can be sent after `balanceOutsideDate`. → `callNoticeDueDate`.

**R27 — Outside date.** On `balanceOutsideDate` every uncalled Balance is due without notice. The system proposes a notice of kind `OUTSIDE_DATE` (lines for every commitment with uncalled Balance, `dueOn = balanceOutsideDate`, optional courtesy email) which the Manager confirms; defaults always attach to a line. → `uncalledBalance`, E9.

**R28 — Prepaid Balance.** §4.9: "A Preferred Member may pay all or part of its Balance before a Call Notice, but the Preferred Return on any part of the Balance accrues only from the date that part is due". Units are issued on receipt. A `BALANCE` receipt not matched to a line accrues from `balanceOutsideDate` (R5). When a line is later sent to that member, unallocated prepaid money is allocated to it first (oldest receipt first) with `prefReturnStartOn = line.dueOn` (under FOUNDATION's `balanceReturnStartRule = RECEIPT_DATE`: the receipt's `receivedOn`); only the rest of the line is payable. → `allocatePaymentToLines`, `buildCapitalLots`.

**R29 — Payment matching.** A recorded Balance payment is applied to the member's open lines oldest `dueOn` first; any excess is prepaid (R28). Each allocation's `prefReturnStartOn = max(receivedOn, line.dueOn)` (`receivedOn` when `balanceReturnStartRule = RECEIPT_DATE`). → `allocatePaymentToLines`.

**R30 — Default and interest.** §4.9: "If a Preferred Member fails to pay its Balance in full when due (a 'Defaulting Member'): (i) the unpaid amount bears interest at twelve percent (12%) per annum from the due date until paid". A line is overdue from the day after `dueOn` if any part is unpaid. Interest: simple, actual/365 (ambiguity: basis not stated; switch `defaultInterestDayBasis`, default 365), on each dollar from `dueOn` until that dollar is paid by the member, offset under R17, or funded by a Replacement Funder (ambiguity: "until paid"; interest accrued up to funding stays owed). Computed piecewise on the outstanding amount and rounded once: `roundDiv(Σ outstanding_i × days_i × 1200, 365 × 10,000)`. → `defaultInterest`.

**R31 — Replacement Funders.** §4.9(ii): "beginning on the first business day after the due date … the Manager may offer all or any part of the unpaid Balance to any one or more Persons who satisfy Section 3.2 (the minimum in Section 3.7 does not apply to a Replacement Funder) … each Person who funds any part of it (a 'Replacement Funder') receives the corresponding Preferred Units … and the Defaulting Member's committed Capital Contribution is reduced by the amount so funded"; §4.8(b): such units "may be issued at any time on or before June 30, 2027". Funding is recorded as `MemberDefaultFunding` + a Replacement Funder `Commitment` (`isReplacement`) with a `CapitalReceipt` of kind `REPLACEMENT` (Preferred Return from receipt), and the Defaulting Member's `acceptedCents` is reduced by the amount (`reduceAcceptedCommitment`). Required order, in one transaction: reduce the defaulting member's commitment first, then create and accept the Replacement commitment (then record its `REPLACEMENT` receipt), because FOUNDATION's offering-cap check counts the defaulter's accepted amount until it is reduced. A Replacement commitment accepted at a reduced amount (`REDUCED`) can be funded too. Validation: `fundedOn ≥ nextBusinessDay(dueOn)`, `fundedOn ≤ replacementFunderOutsideDate`, amount ≤ outstanding unpaid Balance. The funder must already exist as a `Stakeholder` (accreditation is recorded there by FOUNDATION). → `replacementWindow`, E11.

**R32 — Suspension.** §4.9(iii) and §1.23: "while the default continues, the Defaulting Member's Preferred Units do not vote and are not treated as outstanding for any vote, consent, quorum, or right to call a meeting". **All** of the member's Preferred Units are suspended for `dueOn < asOf` and (`curedOn` is null or `asOf < curedOn`). Only confirmed (`MemberDefault`) defaults count; overdue lines without a declared default are returned separately as warnings. Suspension never removes units from distribution percentages (R17). → `isSuspended`, `getSuspendedUnits`.

**R33 — Forfeiture Date and amount.** §4.9(iv): "if the default is not cured within five (5) business days after the due date (the 'Forfeiture Date'), the Defaulting Member forfeits, as liquidated damages and not as a penalty, an amount equal to fifty percent (50%) of its unpaid Balance on the Forfeiture Date, but not more than the Capital Contributions it has paid (the 'Forfeited Amount')". `forfeitureDate = addBusinessDays(dueOn, 5)`. A cure on the Forfeiture Date itself is in time; the forfeiture is determined at the end of that day and is effective on it. `forfeited = min(roundDiv(unpaidAtForfeiture × 5000, 10,000), capitalPaid)` where:
- `unpaidAtForfeiture` = line amount − amounts paid **by the Defaulting Member** (cash and R17 offsets) on or before the Forfeiture Date. Default: **not** reduced by Replacement Funder funding (ambiguity; switch `forfeitureBaseNetOfReplacementFunding`, default `false`). Reason: §4.9(iv)(A) measures "the fraction of the unpaid Balance funded by Replacement Funders", the Credit Date definition contemplates full replacement funding before the Forfeiture Date ("the later of the Forfeiture Date and …"), and the cure sentence requires "funded in full by Replacement Funders **and** the Forfeited Amount has been applied" — all three only work if replacement funding does not shrink the base.
- `capitalPaid` = the member's `contributed` balance on the Forfeiture Date (receipts − earlier forfeitures; not reduced by returns of capital).
→ `forfeitureDate`, `computeForfeiture`.

**R34 — Effects of forfeiture.** §4.9(iv): "on the Forfeiture Date the Forfeited Amount is deducted from the Defaulting Member's Capital Contributions, Unreturned Capital Contributions, and Capital Account and held in suspense by the LLC until the Credit Date, any accrued and unpaid Preferred Return attributable to the Forfeited Amount is extinguished, and its Preferred Units are reduced to one (1) Preferred Unit for each One Thousand Dollars ($1,000) of its remaining Capital Contributions". `contributed −= forfeited`; `unreturned −= min(forfeited, unreturned)` pro rata across lots; extinguished = `roundDiv(unpaidPref × min(forfeited, unreturned), unreturned)` (ambiguity: "attributable"; pro rata by Unreturned Capital at the Forfeiture Date; 0 if `unreturned = 0`); units −= `unitsForAmount(forfeited)` (equal to one unit per $1,000 of remaining Capital Contributions). The forfeiture is written to FOUNDATION's ledger as a `CapitalReceipt` of kind `FORFEITURE`. No one accrues on the amount in suspense. "a payment by the Defaulting Member after the Forfeiture Date does not reverse a forfeiture that has occurred". Capital Accounts are not kept by this system. → `computeForfeiture`, `computePositions` (`FORFEITURE` event).

**R35 — Credit Date.** §4.9(iv): "on the later of the Forfeiture Date and the earlier of (x) the thirtieth (30th) day after the due date and (y) the date on which the unpaid Balance has been funded in full by Replacement Funders (the 'Credit Date')". `creditDate = max(forfeitureDate, min(addDays(dueOn, 30), fullyFundedOn ?? +∞))`; `fullyFundedOn` = first date on which the outstanding unpaid Balance is zero and the last reduction was a Replacement Funder funding. → `creditDate`.

**R36 — Credit allocation.** §4.9(iv): "(A) an amount equal to fifty percent (50%) of the Forfeited Amount multiplied by the fraction of the unpaid Balance funded by Replacement Funders on or before the Credit Date, to those Replacement Funders in proportion to the amounts each funded; and (B) the remainder, to all holders of Preferred Units other than the Defaulting Member, in proportion to the Preferred Units they held on the due date; provided that any amount that would be credited under clause (A) to the Manager, Isaac Reid, Karl Schoen, or any of their Affiliates is instead credited under clause (B)".
- `fraction = min(1, fundedByReplacementFunders(≤ creditDate) / unpaidAtForfeiture)` (same base as R33);
- `poolA = roundDiv(forfeited × 5000 × funded, 10,000 × unpaidAtForfeiture)`; split among funders by amount funded (`allocateProRata`); the shares of funders flagged `isInsider` are moved to pool B;
- `poolB = forfeited − poolA + redirected`; split among holders of Preferred Units **on the due date**, excluding the Defaulting Member, by units held on the due date (insiders included; other defaulting members included; holders who first acquired units after the due date excluded);
- each credited amount becomes a `CapitalReceipt` (kind `CREDIT`, `receivedOn = prefReturnStartOn = creditDate`, units fractional).
If nobody other than the Defaulting Member held Preferred Units on the due date, pool B cannot be allocated: the proposal is flagged and cannot be confirmed (counsel needed). → `computeCreditAllocation`.

**R37 — Cure.** §4.9: "A default is cured when the Defaulting Member has paid its unpaid Balance with interest and costs, or when the unpaid Balance has been funded in full by Replacement Funders and the Forfeited Amount has been applied under clause (iv)". Route 1 `PAID_IN_FULL`: outstanding Balance, interest and costs all zero (cash and/or offsets). Route 2 `REPLACEMENT_FUNDED`: outstanding Balance zero through funding **and** the credit confirmed. Cure is a proposal the Manager confirms; `curedOn` is the date the condition was first met. §4.9(v), (vi): costs of collection are `MemberDefaultCharge` rows entered by the Manager; the unfunded Balance stays owed after forfeiture. → `cureStatus`.

**R38 — Nothing punitive is automatic.** Not in the OA (owner requirement). Declaring a default, confirming a forfeiture, confirming a credit, applying an offset and marking a cure are each a Manager action on a computed proposal; the proposal is recomputed inside the confirming transaction and rejected if it differs from what the Manager saw.

### Liquidation, term, fair value, transfers

**R39 — Transfers.** §5.6(b) (transferee succeeds to "the amounts attributable to the transferred Units"), §7.9.1 (effective "on the first day of the month following receipt by the Manager of written notice"; allocation between transferor and transferee "using any method permitted by Code § 706 selected by the Manager"). A completed GOVERNANCE `UnitTransfer` of *n* of the transferor's *N* units, effective *t*: fraction `f = n / N`; from each lot move `f` of its outstanding amount (largest-remainder across lots so the total moved = `roundDiv(unreturned × n, N)`) into a new lot of the transferee with accrual start `max(lot start, t)`; move `roundDiv(contributed × n, N)` of `contributed`; move `roundDiv(unpaid × n, N)` of accrued-and-unpaid Preferred Return as a fixed carry (default: unpaid Preferred Return travels with the units — the holder of record at payment receives it). → `computePositions` (`TRANSFER` event).

**R40 — Liquidation order.** §11.4: "(a) to the payment of creditors, excluding Members (but including the Manager in respect of accrued and unpaid Management Fee and reimbursable expenses under Sections 3.6 and 6.21) …; (b) to the payment of loans or advances made by the Members; (c) the remaining net proceeds … in accordance with the distribution waterfall set forth in Section 5.6(c) through (e)". `netToMembers = cash − creditors − memberLoans − windDownReserveRetained`, must be ≥ 0, then `runWaterfall` mode `FULL`. In-kind distributions are out of scope (they need a Preferred Supermajority). → `liquidationWaterfall`.

**R41 — Term clock.** §1.21, §2.4, §2.5, §11.1(d):
- OCD notice due `addBusinessDays(ocd, 10)` ("within ten (10) business days after it occurs");
- `baseTargetSaleDate = addYears(ocd, 5)` ("no later than the fifth (5th) anniversary");
- each approved extension adds one year to the base ("extended to the end of the extension period"); the number of approved extensions is the count of GOVERNANCE `Resolution` rows with `type = TERM_EXTENSION` and `status = EFFECTIVE` (economics stores no extension rows);
- LOI extension: `effectiveTargetSaleDate = addDays(extendedBase, loiDays)`, `loiDays ≤ 180`, allowed only if the Manager records that a signed LOI or purchase agreement is in effect on the Target Sale Date; default: one-year extensions are measured from the un-LOI'd date (ambiguity);
- extension request deadline `addMonths(currentTargetSaleDate, −9)` ("Not later than nine (9) months before the Target Sale Date (and … before the end of each extension period)");
- deemed-against date `addDays(requestSentOn, 30)`;
- dissolution election available after `addDays(effectiveTargetSaleDate, 180)`;
- a sale closing before the Target Sale Date needs a Preferred Supermajority (flag only).
→ `computeTermClock`.

**R42 — Distribution and report deadlines.** §5.6(a) and §8.2: "quarterly, within forty-five (45) days after the end of each fiscal quarter"; fiscal year ends December 31 (§8.5). `deadline = addDays(quarterEnd, 45)` in calendar days, not rolled to a business day. → `distributionDeadline`.

**R43 — Fair value.** §7.1(ii): "the fair value of the Units, meaning the amount the transferring Member would receive under Section 5.6 if the LLC's assets were sold at their fair market value"; §7.2 same. Hypothetical: `netToMembers = assetFmv + cashOnHand − liabilities − memberLoans`, `runWaterfall` as of the valuation date; value of *n* of a holder's *N* units = `roundDiv(holderGross × n, N)`. Read-only calculator; the appraisal process is GOVERNANCE's. → `hypotheticalLiquidation`.

**R44 — Business days.** Not defined in the OA. Default: Monday–Friday excluding the 11 US federal holidays on their observed dates (Saturday → preceding Friday, Sunday → following Monday), generated by rule; `LlcTerm.extraHolidays` adds ad-hoc closures; time zone for "today" and "the day an email was sent" = FOUNDATION's `Company.timezone` (single source of truth by the team lead's ruling; default `America/Denver`, editable in Settings). → `business-days.ts`.

---

## C. Data model

### C.1 Design rules

0. **Models.** Beyond the names in the shared contract (`CallNotice`, `CallNoticeLine`, `MemberDefault`, `RevenuePeriod`, `ManagerPayment`, `ReserveEntry`, `Distribution`, `DistributionLine`, `LlcTerm`) this plan adds: `CallNoticeAllocation`, `MemberDefaultFunding`, `MemberDefaultPayment`, `MemberDefaultCharge`, `MemberDefaultCredit`, `ExpenseEntry`, `MemberLoan`, `MemberLoanPayment`, `MemberAdvance` (tax advances, §9.2), `MemberAdvanceRecovery`.
1. **Relations.** Economics models declare Prisma relations only to `Company` and to each other. References to FOUNDATION and GOVERNANCE rows (`stakeholderId`, `commitmentId`, `capitalReceiptId`, `unitClassId`, `emailLogId`, `resolutionId`), to `Document`, `BankAccount` and team `Member` (`createdById`) are **plain indexed `String` columns without a Prisma relation**. With `relationMode = "prisma"` there are no database foreign keys either way; this keeps the three plans from editing each other's models. Names are joined in code (`findMany({ where: { companyId, id: { in } } })`).
2. **Every row has `companyId`** and every query filters on it.
3. **Append-only ledgers.** Rows marked *immutable* below are never updated or deleted by any procedure. A correction is a new row that points at the row it reverses (`reverses…Id`, unique) with negated amounts; loaders net them. The only permitted updates are the operational columns listed in the table.
4. No database triggers (Prisma emulates `onDelete: Cascade` with row deletes in `relationMode = "prisma"`, which a trigger would block). Immutability is enforced by construction: all writes go through `src/server/llc/economics/*.ts` service functions; routers never call `update`/`delete` on immutable models (acceptance check in each package: `grep`).

| Model | Mutability |
|---|---|
| `LlcTerm` | Editable (audit event records before/after). |
| `CallNotice` | Editable while `DRAFT`. After send only `status` (`SENT` → `SETTLED`). |
| `CallNoticeLine` | Editable while notice is `DRAFT`. After send only `status`, `sentAt`, `sentOn`, `sentToEmail`, `emailLogId`, `dueOn` (set once at send), `paidInFullOn`. |
| `CallNoticeAllocation` | Immutable (reversal row). |
| `MemberDefault` | Stage columns are each written once (declare → forfeiture → credit → cure/void). Never deleted. |
| `MemberDefaultFunding`, `MemberDefaultPayment`, `MemberDefaultCharge`, `MemberDefaultCredit` | Immutable (reversal row where a `reverses…Id` exists). |
| `RevenuePeriod` | Editable while `month` > `LlcTerm.booksClosedThrough`; locked afterwards. |
| `ExpenseEntry`, `ManagerPayment`, `ReserveEntry`, `MemberLoanPayment`, `MemberAdvance`, `MemberAdvanceRecovery` | Immutable (reversal row). New rows must be dated after `booksClosedThrough`. |
| `MemberLoan` | Immutable except `notes`. |
| `Distribution` | Editable and deletable while `DRAFT`. On finalize all columns freeze; the only later update is `status` → `REVERSED` with `reversedAt`, `reversedById`, `reversalReason`. |
| `DistributionLine` | Created at finalize. Only `paidOn`, `paymentReference`, `noticeEmailLogId`, `noticeSentAt` may be set afterwards. |

### C.2 Additions to the existing `Company` model (no SQL change)

Add these back-relation fields inside `model Company { … }` after `BankAccount BankAccount[]`:

```prisma
  llcTerm               LlcTerm?
  callNotices           CallNotice[]
  callNoticeLines       CallNoticeLine[]
  callNoticeAllocations CallNoticeAllocation[]
  memberDefaults        MemberDefault[]
  memberDefaultFundings MemberDefaultFunding[]
  memberDefaultPayments MemberDefaultPayment[]
  memberDefaultCharges  MemberDefaultCharge[]
  memberDefaultCredits  MemberDefaultCredit[]
  revenuePeriods        RevenuePeriod[]
  expenseEntries        ExpenseEntry[]
  managerPayments       ManagerPayment[]
  reserveEntries        ReserveEntry[]
  memberLoans           MemberLoan[]
  memberLoanPayments    MemberLoanPayment[]
  memberAdvances        MemberAdvance[]
  memberAdvanceRecoveries MemberAdvanceRecovery[]
  distributions         Distribution[]
  distributionLines     DistributionLine[]
```

### C.3 Models and enums (paste at the end of `prisma/schema.prisma`)

```prisma
// ───────────────────────── LLC ECONOMICS ─────────────────────────

enum LlcPrefCutoffEnum {
  PAYMENT_DATE
  PERIOD_END
}

enum LlcLotOrderEnum {
  PRO_RATA
  FIFO
  LIFO
}

enum LlcOffsetOrderEnum {
  BALANCE_INTEREST_COSTS
  COSTS_INTEREST_BALANCE
}

enum LlcHolidayCalendarEnum {
  US_FEDERAL
  NONE
}

/// One row per LLC company: agreement dates, parameters (defaults = OA text) and interpretation switches.
model LlcTerm {
  id        String  @id @default(cuid())
  companyId String  @unique
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  // Dates (finalClosingDate and balanceOutsideDate live on FOUNDATION's UnitClass)
  replacementFunderOutsideDate DateTime  @db.Date /// 4.8(b) 2027-06-30
  operationsCommencementDate   DateTime? @db.Date /// 1.21
  ocdNoticeSentOn              DateTime? @db.Date
  loiExtensionDays             Int       @default(0) /// 2.4, 0..loiExtensionMaxDays
  loiDocumentId                String?

  // Parameters
  callNoticeBusinessDays       Int    @default(3)
  forfeitureCureBusinessDays   Int    @default(5)
  creditDateMaxDays            Int    @default(30)
  defaultInterestBps           Int    @default(1200)
  defaultInterestDayBasis      Int    @default(365)
  forfeitureBps                Int    @default(5000)
  replacementCreditBps         Int    @default(5000)
  managementFeeBps             Int    @default(500)
  minimumOperatingReserveCents BigInt @default(5000000)
  orgExpenseCapCents           BigInt @default(4000000)
  distributionDeadlineDays     Int    @default(45)
  targetSaleYears              Int    @default(5)
  loiExtensionMaxDays          Int    @default(180)
  extensionRequestMonthsBefore Int    @default(9)
  extensionConsentWindowDays   Int    @default(30)
  dissolutionElectionDays      Int    @default(180)
  ocdNoticeBusinessDays        Int    @default(10)

  // Interpretation switches (section B)
  prefAccrualCutoff                        LlcPrefCutoffEnum  @default(PAYMENT_DATE)
  accrueOnDefaulterCapital                 Boolean            @default(true)
  capitalReturnLotOrder                    LlcLotOrderEnum    @default(PRO_RATA)
  forfeitureBaseNetOfReplacementFunding    Boolean            @default(false)
  defaultOffsetOrder                       LlcOffsetOrderEnum @default(BALANCE_INTEREST_COSTS)
  includeInsiderDistributionsInManagerList Boolean            @default(true)

  // Calendar (the time zone is Company.timezone)
  holidayCalendar               LlcHolidayCalendarEnum @default(US_FEDERAL)
  saturdayHolidayObservedFriday Boolean                @default(true)
  extraHolidays                 DateTime[]             @db.Date

  /// Books are closed through this date (inclusive): no dated ledger row on or before it may be created.
  booksClosedThrough DateTime? @db.Date

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// ───────── Call Notices (4.9) ─────────

enum CallNoticeKindEnum {
  CALL
  OUTSIDE_DATE
}

enum CallNoticeStatusEnum {
  DRAFT
  SENT
  SETTLED
  CANCELLED
}

enum CallNoticeLineStatusEnum {
  UNSENT
  SENT
  SEND_FAILED
  PAID
}

model CallNotice {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  number        Int /// sequential per company, assigned at creation
  kind          CallNoticeKindEnum   @default(CALL)
  status        CallNoticeStatusEnum @default(DRAFT)
  purpose       String? /// shown in the email ("to pay for the LLC's servers…")
  bankAccountId String? /// BankAccount whose wire details are printed
  sentAt        DateTime? /// first successful line send
  cancelledAt   DateTime?
  cancelReason  String?
  createdById   String

  lines CallNoticeLine[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([companyId, number])
  @@index([companyId])
  @@index([bankAccountId])
}

model CallNoticeLine {
  id           String     @id @default(cuid())
  companyId    String
  company      Company    @relation(fields: [companyId], references: [id], onDelete: Cascade)
  callNoticeId String
  callNotice   CallNotice @relation(fields: [callNoticeId], references: [id], onDelete: Cascade)

  stakeholderId     String
  commitmentId      String
  amountCalledCents BigInt

  status       CallNoticeLineStatusEnum @default(UNSENT)
  sentAt       DateTime? /// instant the email was accepted by the mail server (13.6)
  sentOn       DateTime? @db.Date /// calendar date of sentAt in Company.timezone
  sentToEmail  String?
  emailLogId   String?
  dueOn        DateTime? @db.Date /// set once at send (R26); for OUTSIDE_DATE = balanceOutsideDate
  paidInFullOn DateTime? @db.Date

  allocations   CallNoticeAllocation[]
  memberDefault MemberDefault?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([callNoticeId, commitmentId])
  @@index([companyId])
  @@index([callNoticeId])
  @@index([stakeholderId])
  @@index([commitmentId])
}

enum CallNoticeAllocationSourceEnum {
  PAYMENT /// cash received against the line
  PREPAID /// money received before the notice, matched when the notice was sent
  OFFSET /// distribution withheld under 4.9(iii)
}

/// Links (part of) a CapitalReceipt to a line and fixes that slice's Preferred Return start. Immutable.
model CallNoticeAllocation {
  id               String         @id @default(cuid())
  companyId        String
  company          Company        @relation(fields: [companyId], references: [id], onDelete: Cascade)
  callNoticeLineId String
  callNoticeLine   CallNoticeLine @relation(fields: [callNoticeLineId], references: [id], onDelete: Cascade)

  capitalReceiptId     String
  amountCents          BigInt /// negative on a reversal row
  receivedOn           DateTime                       @db.Date
  prefReturnStartOn    DateTime                       @db.Date /// max(receivedOn, line.dueOn)
  source               CallNoticeAllocationSourceEnum
  reversesAllocationId String?                        @unique
  createdById          String
  createdAt            DateTime                       @default(now())

  @@index([companyId])
  @@index([callNoticeLineId])
  @@index([capitalReceiptId])
}

// ───────── Default (4.9(i)–(vii)) ─────────

enum MemberDefaultStatusEnum {
  OPEN
  CURED
  VOIDED
}

enum MemberDefaultCureMethodEnum {
  PAID_IN_FULL
  REPLACEMENT_FUNDED
}

model MemberDefault {
  id               String         @id @default(cuid())
  companyId        String
  company          Company        @relation(fields: [companyId], references: [id], onDelete: Cascade)
  callNoticeLineId String         @unique
  callNoticeLine   CallNoticeLine @relation(fields: [callNoticeLineId], references: [id], onDelete: Cascade)

  stakeholderId String
  commitmentId  String
  status        MemberDefaultStatusEnum @default(OPEN)

  // Stage 1: declared
  dueOn            DateTime @db.Date
  unpaidAtDueCents BigInt
  forfeitureDate   DateTime @db.Date /// addBusinessDays(dueOn, 5), stored at declaration
  declaredAt       DateTime @default(now())
  declaredById     String

  // Stage 2: forfeiture confirmed (all null until then)
  forfeitedOn                  DateTime? @db.Date
  unpaidAtForfeitureCents      BigInt?
  capitalPaidAtForfeitureCents BigInt?
  forfeitedAmountCents         BigInt?
  forfeitureReceiptId          String? /// FOUNDATION CapitalReceipt of kind FORFEITURE
  unreturnedDeductedCents      BigInt?
  extinguishedReturnCents      BigInt?
  unitsBefore                  Decimal?  @db.Decimal(18, 6)
  unitsAfter                   Decimal?  @db.Decimal(18, 6)
  forfeitureConfirmedAt        DateTime?
  forfeitureConfirmedById      String?

  // Stage 3: credit confirmed
  creditDate            DateTime? @db.Date
  fundedAtCreditCents   BigInt?
  creditPoolACents      BigInt?
  creditRedirectedCents BigInt?
  creditPoolBCents      BigInt?
  creditConfirmedAt     DateTime?
  creditConfirmedById   String?

  // Stage 4: cure or void
  curedOn    DateTime?                    @db.Date
  cureMethod MemberDefaultCureMethodEnum?
  curedAt    DateTime?
  curedById  String?
  voidedAt   DateTime?
  voidedById String?
  voidReason String?

  notes String?

  fundings MemberDefaultFunding[]
  payments MemberDefaultPayment[]
  charges  MemberDefaultCharge[]
  credits  MemberDefaultCredit[]

  updatedAt DateTime @updatedAt

  @@index([companyId])
  @@index([stakeholderId])
  @@index([commitmentId])
}

/// 4.9(ii): a Replacement Funder funded part of the unpaid Balance. Immutable.
model MemberDefaultFunding {
  id              String        @id @default(cuid())
  companyId       String
  company         Company       @relation(fields: [companyId], references: [id], onDelete: Cascade)
  memberDefaultId String
  memberDefault   MemberDefault @relation(fields: [memberDefaultId], references: [id], onDelete: Cascade)

  funderStakeholderId String
  funderCommitmentId  String /// the Replacement Funder commitment (isReplacement) created for this funding
  funderIsInsider     Boolean /// snapshot of Stakeholder.isInsider when recorded
  amountCents         BigInt
  fundedOn            DateTime @db.Date
  capitalReceiptId    String   @unique /// kind REPLACEMENT
  createdById         String
  createdAt           DateTime @default(now())

  @@index([companyId])
  @@index([memberDefaultId])
  @@index([funderStakeholderId])
}

enum MemberDefaultPaymentSourceEnum {
  CASH
  DISTRIBUTION_OFFSET
}

/// Money from the Defaulting Member applied to Balance / interest / costs. Immutable (reversal row).
model MemberDefaultPayment {
  id              String        @id @default(cuid())
  companyId       String
  company         Company       @relation(fields: [companyId], references: [id], onDelete: Cascade)
  memberDefaultId String
  memberDefault   MemberDefault @relation(fields: [memberDefaultId], references: [id], onDelete: Cascade)

  paidOn             DateTime                       @db.Date
  source             MemberDefaultPaymentSourceEnum
  toBalanceCents     BigInt                         @default(0)
  toInterestCents    BigInt                         @default(0)
  toCostsCents       BigInt                         @default(0)
  capitalReceiptId   String? /// receipt created for toBalanceCents
  distributionLineId String? /// when source = DISTRIBUTION_OFFSET
  reversesPaymentId  String?                        @unique
  createdById        String
  createdAt          DateTime                       @default(now())

  @@index([companyId])
  @@index([memberDefaultId])
  @@index([distributionLineId])
}

/// 4.9(v): costs of collection and enforcement charged to the Defaulting Member. Immutable (reversal row).
model MemberDefaultCharge {
  id              String        @id @default(cuid())
  companyId       String
  company         Company       @relation(fields: [companyId], references: [id], onDelete: Cascade)
  memberDefaultId String
  memberDefault   MemberDefault @relation(fields: [memberDefaultId], references: [id], onDelete: Cascade)

  incurredOn       DateTime @db.Date
  amountCents      BigInt
  description      String
  documentId       String?
  reversesChargeId String?  @unique
  createdById      String
  createdAt        DateTime @default(now())

  @@index([companyId])
  @@index([memberDefaultId])
}

enum MemberDefaultCreditClauseEnum {
  A
  B
}

/// 4.9(iv)(A)/(B): one row per credited holder and clause. Immutable.
model MemberDefaultCredit {
  id              String        @id @default(cuid())
  companyId       String
  company         Company       @relation(fields: [companyId], references: [id], onDelete: Cascade)
  memberDefaultId String
  memberDefault   MemberDefault @relation(fields: [memberDefaultId], references: [id], onDelete: Cascade)

  stakeholderId    String
  commitmentId     String
  clause           MemberDefaultCreditClauseEnum
  amountCents      BigInt
  units            Decimal                       @db.Decimal(18, 6)
  capitalReceiptId String                        @unique /// kind CREDIT
  createdAt        DateTime                      @default(now())

  @@unique([memberDefaultId, stakeholderId, clause])
  @@index([companyId])
  @@index([memberDefaultId])
  @@index([stakeholderId])
}

// ───────── Revenue, fee, expenses, reserves, Manager ledger ─────────

/// One row per calendar month, cash basis, entered by the Manager (6.18, 1.15, 8.2).
model RevenuePeriod {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  month                  DateTime @db.Date /// first day of the month
  customerReceiptsCents  BigInt   @default(0) /// cash received from customers for computing services
  passThroughFeesCents   BigInt   @default(0) /// marketplace commissions, platform and payment-processing fees
  otherIncomeCents       BigInt   @default(0) /// interest and other income (not in the fee base)
  assetSaleProceedsCents BigInt   @default(0)
  insuranceProceedsCents BigInt   @default(0)
  utilizationBps         Int? /// 8.2 report, 0..10000
  managementFeeBps       Int /// snapshot of LlcTerm.managementFeeBps at save
  managementFeeCents     BigInt /// roundDiv((receipts − fees) × bps, 10000), stored at save
  notes                  String?
  updatedById            String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([companyId, month])
  @@index([companyId])
}

enum ExpenseCategoryEnum {
  COLOCATION
  POWER
  NETWORK
  INSURANCE
  REPAIR_AND_REPLACEMENT
  SOFTWARE_AND_SUPPORT
  PROFESSIONAL_FEES
  TAXES_AND_FILING_FEES
  BANK_FEES
  ORGANIZATIONAL_OFFERING
  EQUIPMENT_ACQUISITION
  DEFAULT_COLLECTION
  OTHER
}

enum FundingSourceEnum {
  OPERATING_CASH
  CAPITAL_CONTRIBUTIONS
}

/// Cost ledger: feeds Available Cash (OPERATING_CASH), unused capital (CAPITAL_CONTRIBUTIONS) and the 6.21 cap. Immutable.
model ExpenseEntry {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  incurredOn         DateTime            @db.Date /// paid or payable date
  category           ExpenseCategoryEnum
  payee              String
  amountCents        BigInt /// negative on a reversal row
  fundingSource      FundingSourceEnum   @default(OPERATING_CASH)
  countsTowardOrgCap Boolean             @default(false)
  memo               String?
  documentId         String?
  managerPaymentId   String? /// set when the cost was reimbursed to / passed through the Manager
  resolutionId       String? /// GOVERNANCE Resolution authorising an amount above the 6.21 cap
  reversesEntryId    String?             @unique
  createdById        String
  createdAt          DateTime            @default(now())

  @@index([companyId, incurredOn])
  @@index([managerPaymentId])
}

enum ManagerPaymentCategoryEnum {
  MANAGEMENT_FEE
  EXPENSE_REIMBURSEMENT
  PURCHASING_AGENT_PASS_THROUGH
  OTHER
}

/// 8.2: every amount paid by the LLC to or through the Manager and its Affiliates. Immutable.
model ManagerPayment {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  paidOn             DateTime                   @db.Date
  payee              String /// e.g. "Octagon Compute LLC"
  payeeStakeholderId String?
  amountCents        BigInt /// negative on a reversal row
  category           ManagerPaymentCategoryEnum
  countsTowardOrgCap Boolean                    @default(false)
  memo               String?
  documentId         String?
  resolutionId       String?
  reversesPaymentId  String?                    @unique
  createdById        String
  createdAt          DateTime                   @default(now())

  @@index([companyId, paidOn])
}

enum ReserveKindEnum {
  MINIMUM_OPERATING
  ANTICIPATED_EXPENSES
  LIABILITIES
  EQUIPMENT_REPAIR_AND_REPLACEMENT
  COLOCATION_DEPOSITS
  INSURANCE_DEDUCTIBLES
  TAXES
  WORKING_CAPITAL
  WIND_DOWN
}

enum ReserveEntryTypeEnum {
  ESTABLISH
  RELEASE
}

/// 5.6(a) reserve ledger. Immutable.
model ReserveEntry {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  effectiveOn     DateTime             @db.Date
  kind            ReserveKindEnum
  type            ReserveEntryTypeEnum
  amountCents     BigInt /// always positive; negative only on a reversal row
  fundingSource   FundingSourceEnum /// ESTABLISH: where the cash comes from. RELEASE: the pool it is released from
  releaseTo       FundingSourceEnum? /// RELEASE only: pool that receives it (default = fundingSource)
  reason          String
  reversesEntryId String?              @unique
  createdById     String
  createdAt       DateTime             @default(now())

  @@index([companyId, effectiveOn])
}

// ───────── Member loans (4.6) and tax advances (9.2) ─────────

model MemberLoan {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  lenderStakeholderId String
  principalCents      BigInt
  interestBps         Int
  madeOn              DateTime @db.Date
  maturityOn          DateTime @db.Date
  noteDocumentId      String?
  resolutionId        String?
  notes               String?
  createdById         String

  payments MemberLoanPayment[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([companyId])
  @@index([lenderStakeholderId])
}

model MemberLoanPayment {
  id           String     @id @default(cuid())
  companyId    String
  company      Company    @relation(fields: [companyId], references: [id], onDelete: Cascade)
  memberLoanId String
  memberLoan   MemberLoan @relation(fields: [memberLoanId], references: [id], onDelete: Cascade)

  paidOn            DateTime          @db.Date
  principalCents    BigInt            @default(0)
  interestCents     BigInt            @default(0)
  fundingSource     FundingSourceEnum @default(OPERATING_CASH)
  distributionId    String? /// set when paid in a liquidation run (11.4(b))
  reversesPaymentId String?           @unique
  createdById       String
  createdAt         DateTime          @default(now())

  @@index([companyId, paidOn])
  @@index([memberLoanId])
}

enum MemberAdvanceKindEnum {
  TAX_WITHHOLDING
  COMPOSITE_RETURN
  ENTITY_LEVEL_TAX
  IMPUTED_UNDERPAYMENT
}

/// 9.2: tax paid on a member's behalf. Immutable.
model MemberAdvance {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  stakeholderId     String
  paidOn            DateTime              @db.Date
  kind              MemberAdvanceKindEnum
  amountCents       BigInt
  jurisdiction      String?
  taxYear           Int?
  memo              String?
  documentId        String?
  reversesAdvanceId String?               @unique
  createdById       String
  createdAt         DateTime              @default(now())

  @@index([companyId])
  @@index([stakeholderId])
}

enum MemberAdvanceRecoverySourceEnum {
  DISTRIBUTION_OFFSET
  CASH_REPAYMENT
}

model MemberAdvanceRecovery {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  stakeholderId      String
  recoveredOn        DateTime                        @db.Date
  amountCents        BigInt
  source             MemberAdvanceRecoverySourceEnum
  distributionLineId String?
  reversesRecoveryId String?                         @unique
  createdById        String
  createdAt          DateTime                        @default(now())

  @@index([companyId])
  @@index([stakeholderId])
  @@index([distributionLineId])
}

// ───────── Distributions (5.6, 11.4) ─────────

enum DistributionTypeEnum {
  OPERATING
  RETURN_OF_UNUSED_CAPITAL
  SALE_OR_LIQUIDATION
}

enum DistributionStatusEnum {
  DRAFT
  FINALIZED
  REVERSED
}

model Distribution {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  number                 Int? /// sequential per company, assigned at finalize
  type                   DistributionTypeEnum
  status                 DistributionStatusEnum @default(DRAFT)
  isLiquidation          Boolean                @default(false) /// 11.4 worksheet used
  isReversal             Boolean                @default(false)
  reversesDistributionId String?                @unique

  periodStart DateTime? @db.Date
  periodEnd   DateTime  @db.Date /// Available Cash is measured as of this date
  paymentDate DateTime  @db.Date /// accrual cut-off (R7) and effective date of the ledger entries

  /// Draft inputs (wizard state). Cents as JSON numbers. Shape: DistributionInputs (E15).
  inputs Json

  // Frozen at finalize (null while DRAFT)
  availableCashCents     BigInt?
  amountCents            BigInt? /// gross amount run through the waterfall
  tierCCents             BigInt?
  tierDCents             BigInt?
  tierEPreferredCents    BigInt?
  tierECommonCents       BigInt?
  totalDefaultOffsetCents BigInt?
  totalTaxOffsetCents    BigInt?
  totalNetCents          BigInt?
  reserveBalanceCents    BigInt? /// reported under 5.6(a)
  /// Full computation snapshot (toWire output): Available Cash breakdown, positions before, config (E15).
  snapshot               Json?
  solvencyConfirmed      Boolean  @default(false) /// R15
  finalizedAt            DateTime?
  finalizedById          String?
  reversedAt             DateTime?
  reversedById           String?
  reversalReason         String?
  notes                  String?
  createdById            String

  lines DistributionLine[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([companyId, number])
  @@index([companyId, status])
}

model DistributionLine {
  id             String       @id @default(cuid())
  companyId      String
  company        Company      @relation(fields: [companyId], references: [id], onDelete: Cascade)
  distributionId String
  distribution   Distribution @relation(fields: [distributionId], references: [id], onDelete: Cascade)

  stakeholderId String

  // Position immediately before this distribution
  preferredUnits        Decimal @db.Decimal(18, 6)
  commonUnits           Decimal @db.Decimal(18, 6)
  unpaidReturnBeforeCents BigInt
  unreturnedBeforeCents BigInt

  // Tiers (negative on the lines of a reversal distribution)
  tierCCents          BigInt @default(0)
  tierDCents          BigInt @default(0)
  tierEPreferredCents BigInt @default(0)
  tierECommonCents    BigInt @default(0)
  grossCents          BigInt

  // Netting
  defaultOffsetBalanceCents  BigInt @default(0)
  defaultOffsetInterestCents BigInt @default(0)
  defaultOffsetCostsCents    BigInt @default(0)
  taxAdvanceOffsetCents      BigInt @default(0)
  netCents                   BigInt /// cash payable = gross − offsets

  // Operational (may be set after finalize)
  paidOn           DateTime? @db.Date
  paymentReference String?
  noticeEmailLogId String?
  noticeSentAt     DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([distributionId, stakeholderId])
  @@index([companyId])
  @@index([distributionId])
  @@index([stakeholderId])
}
```

### C.4 Migration plan

- **Who**: FOUNDATION's package **F0** writes the single schema migration for all three areas (team lead's ruling; `01-foundation.md` C1, C5). F0 pastes C.2 and C.3 of this plan verbatim. No economics package in this plan edits `prisma/schema.prisma`. If a later economics package finds a column missing, it stops and reports; the fix is a small additive migration (new nullable/defaulted column, table or index only) owned by the package that needs it. Economics does not add `Document.recordCategory` (GOVERNANCE's).
- **Contents contributed by economics**: 21 enums and 19 tables (C.3) with their indexes, and the back-relation lines of C.2 (no SQL). No `ALTER TABLE` on a pre-existing table, no `DROP`, no foreign keys. The C.2/C.3 blocks were validated with `prisma validate` against a copy of the current schema.
- **Dependencies on other areas' models**: none at the database level (plain scalar ids). At run time economics reads FOUNDATION's `Company.entityType/timezone`, `UnitClass`, `Commitment`, `CapitalReceipt`, `Stakeholder` and GOVERNANCE's `Resolution` (term extensions) and `UnitTransfer`.
- **Data**: no backfill. `LlcTerm` is created lazily by `getOrCreateLlcTerm` (E7) the first time an LLC company opens an economics page, with `replacementFunderOutsideDate = 2027-06-30` and the column defaults.
- **`BankAccount`**: unchanged (the `@@unique([companyId, primary])` index stays; E8 works within it).
- **Rollback**: the economics tables and types can be dropped without touching existing data.

---

## D. Work packages

### D.0 Order, parallelism, common rules

| Id | Title | Prerequisites | Can run in parallel with |
|---|---|---|---|
| E1 | Library core ("E-lib"): money, dates, allocation, business days, units, config | — | F0, F1 |
| E2 | Library: positions, Preferred Return | E1 | E3, E5, E6 |
| E3 | Library: waterfall, netting, liquidation | E1 | E2, E5, E6 |
| E4 | Library: Call Notice and default math | E2 | E3, E5, E6 |
| E5 | Library: Management Fee, Available Cash, term clock | E1 | E2, E3, E4, E6 |
| E6 | Registry wiring and router stubs (no schema) | F0, F1 | E1–E5 |
| E7 | Server core: term service, ledger loader, positions, suspension for GOVERNANCE, LLC term page | E2, E3, E4, E5, E6, F2, F6, GOVERNANCE tables in the Prisma client | — |
| E8 | Bank accounts: create, list, delete | E6, E7 | E13 |
| E9 | Call Notices: backend and email | E7, E8, F6, F10 | E13 |
| E10 | Call Notices: pages | E9, F2 | E11, E13, E14 |
| E11 | Default workflow: backend | E9 | E10, E13 |
| E12 | Default workflow: pages | E10, E11 | E14, E15 |
| E13 | Financials: backend | E7 | E8, E9, E10, E11 |
| E14 | Financials: pages | E13, F2 | E12, E15 |
| E15 | Distributions: draft, compute, finalize, reverse | E11, E13 | E12, E14 |
| E16 | Distributions: wizard and detail pages | E14, E15, F2 | E18 |
| E17 | Distribution notices, CSV export, payment marking | E15, E16, F10 | E18 |
| E18 | Member statement, economics tab, fair-value page | E15, F7, F10 | E16, E17 |
| E19 | Period data and compliance dates for GOVERNANCE, Overview widgets | E11, E13, E15, E18 | E16, E17 |

FOUNDATION packages referenced (see `01-foundation.md`): **F0** = the single schema migration for all three areas (includes section C of this plan); **F1** = shared conventions (`src/lib/money.ts`, `src/lib/date-only.ts`, `withLlcAccessControl`, `requireLlc`, `src/server/llc/serialize.ts`, first edits of the registries); **F2** = navigation, placeholder pages, `settings/llc` page with the `LlcTerm` slot; **F6** = `src/server/llc/commitments.ts` and `positions.ts`; **F7** = commitments UI and member detail tabs; **F10** = logged `sendMail`. F6 itself waits for E1. GOVERNANCE: `Resolution` and `UnitTransfer` tables exist after F0; their rows appear when GOVERNANCE's packages land (economics reads them defensively: no rows = no extensions, no transfers).

File-ownership rule: a package may create or modify only the files it lists. Shared registries are touched only by E6. Two packages marked parallel never list the same file.

Verification commands (every package, from the repo root; all must pass with zero errors):

```
node_modules/.bin/tsc --noEmit
node_modules/.bin/biome check ./src
node_modules/.bin/vitest run
SKIP_ENV_VALIDATION=1 NODE_ENV=production node_modules/.bin/next build
```

Library packages E1–E5 may skip `next build`. Global "do not touch" list for all economics packages: `prisma/**` (F0 only), `src/lib/money.ts`, `src/lib/date-only.ts`, `src/lib/admission/**`, `src/server/llc/positions.ts`, `src/server/llc/commitments.ts` (except the `companyToday` line changed by E7 and the two guard calls added by E9), `src/trpc/api/trpc.ts`, `src/server/auth.ts`, `src/server/tenant-ownership.ts`, `src/server/mailer.ts`, `src/lib/queue.ts`, `src/jobs/**`, everything under `src/components/dashboard/sidebar` and `src/components/dashboard/navbar` (FOUNDATION's F2 owns navigation), `src/components/ui/**`, `src/components/modals/index.ts`, the corporation features (`share-classes`, `securities`, `equity-plans`, `fundraise`, `captable`).

Library rules (E1–E5): files live in `src/lib/llc/`; relative imports only; no `Date.now()`, `new Date()` without arguments, `Math.random`, `process.env`; no floating point in any money, unit or rate computation (`number` is allowed only for day counts, basis points, counters); errors are `throw new LlcMathError(code, message)` (class in `money.ts`, `code` is a string literal union extended per file); every exported function has a test.

Test fixture used by several packages — **Scenario S** (define once in `src/lib/llc/fixtures/scenario-s.ts`, package E2; not a test file, imported only by tests):

| Holder | Class | Receipt | Received | Accrual start | Amount | Units |
|---|---|---|---|---|---|---|
| A | Preferred | a1 INITIAL | 2026-11-16 | 2026-11-16 | $100,000.00 | 100 |
| B | Preferred | b1 INITIAL | 2026-11-23 | 2026-11-23 | $250,000.00 | 250 |
| C | Preferred | c1 INITIAL | 2026-11-30 | 2026-11-30 | $40,000.00 | 40 |
| C | Preferred | c2 BALANCE | 2027-01-19 | 2027-01-20 (line due date) | $60,000.00 | 60 |
| M | Common | — | — | — | $0 | 100 |

Config: 8% (800 bps), basis 365, $1,000 per unit, 70/30. In this fixture `on` (the date the capital exists) equals the received date for every receipt.

---

### E1 — Library core ("E-lib"): money, dates, allocation, business days, units, config

**Goal**: the primitives every other package and both other plans use; FOUNDATION's F6 cannot start without `business-days.ts` and `units.ts`. **Prerequisites**: none (does not import FOUNDATION's `src/lib/money.ts` or `date-only.ts`).

**Create**: `src/lib/llc/money.ts`, `dates.ts`, `allocate.ts`, `business-days.ts`, `units.ts`, `config.ts`, and `money.test.ts`, `dates.test.ts`, `allocate.test.ts`, `business-days.test.ts`, `units.test.ts`.

**Functions** (signatures in section 0; additional detail):

`money.ts`
- `class LlcMathError extends Error { constructor(public code: string, message: string) }`.
- `roundDiv(n, d)`: `d ≤ 0n` → throw `BAD_DIVISOR`. For `n ≥ 0`: `(2n + d) / (2d)`; for `n < 0`: `−roundDiv(−n, d)`. (Same result as FOUNDATION's `mulDivRoundHalfUp(a, b, c)` for `n = a × b`, `d = c`.)
- `microUnitsFromDecimal`: `toString()` must match `/^-?\d+(\.\d{1,6})?$/`, else throw `BAD_UNITS`.
- `centsToDecimalString`, `microUnitsToDecimalString`: string operations on `bigint` (no `Number`, no `Intl`).

`dates.ts`
- All arithmetic via `Date.UTC(y, m − 1, d)` and `86_400_000`; never local-time getters.
- `addMonths`: target month = month + n; day = `min(day, daysInTargetMonth)`.
- `quarterOf("2027-05-14")` → `{ year: 2027, quarter: 2, start: "2027-04-01", end: "2027-06-30" }`.

`allocate.ts`
```ts
export interface Weighted { key: string; weight: bigint }
export function allocateProRata(total: bigint, items: readonly Weighted[]): Map<string, bigint>;
```
Rules (R14): `total < 0n` or any `weight < 0n` → throw `NEGATIVE`; duplicate key → throw `DUPLICATE_KEY`; `total === 0n` → all zero; `Σ weight === 0n` and `total > 0n` → throw `ZERO_WEIGHT`; base share `floor(total × w / W)`; leftover cents one each in order: remainder `(total × w) mod W` descending, then weight descending, then key ascending (plain `<` string comparison). The returned map contains every key (zero-weight keys get `0n`). Input order must not affect the result.

`business-days.ts` (R44)
- Holidays by rule: New Year's Day (Jan 1), Birthday of Martin Luther King, Jr. (3rd Monday of January), Washington's Birthday (3rd Monday of February), Memorial Day (last Monday of May), Juneteenth National Independence Day (Jun 19), Independence Day (Jul 4), Labor Day (1st Monday of September), Columbus Day (2nd Monday of October), Veterans Day (Nov 11), Thanksgiving Day (4th Thursday of November), Christmas Day (Dec 25). Observed date: Saturday → previous day (only if `saturdayObservedOnFriday`), Sunday → next day.
- `isBusinessDay(d)`: not Saturday/Sunday, not an observed holiday of year(d) − 1, year(d) or year(d) + 1 (New Year's Day 2028 is observed on 2027-12-31), not in `extraHolidays`.

**Tests** (exact expectations):

`business-days.test.ts`

| Case | Expect |
|---|---|
| `usFederalHolidays(2027)` observed dates | 2027-01-01, 2027-01-18, 2027-02-15, 2027-05-31, **2027-06-18** (Jun 19 is a Saturday), **2027-07-05** (Jul 4 is a Sunday), 2027-09-06, 2027-10-11, 2027-11-11, 2027-11-25, **2027-12-24** (Dec 25 is a Saturday) |
| `usFederalHolidays(2026)` Independence Day | date 2026-07-04, observedOn 2026-07-03 |
| `usFederalHolidays(2028)` | New Year's Day observedOn **2027-12-31**; MLK 2028-01-17; Washington 2028-02-21; Memorial 2028-05-29; Juneteenth 2028-06-19; Jul 4 2028-07-04; Labor 2028-09-04; Columbus 2028-10-09; Veterans observedOn 2028-11-10; Thanksgiving 2028-11-23; Christmas 2028-12-25 |
| `isBusinessDay` | 2027-06-18 false; 2027-06-19 false; 2027-12-31 false; 2027-11-11 false; 2027-01-19 true |
| `isBusinessDay("2027-06-18", { saturdayObservedOnFriday: false })` | true |
| `isBusinessDay("2027-01-18", { holidays: "NONE" })` | true |
| `isBusinessDay("2027-03-10", { extraHolidays: ["2027-03-10"] })` | false |
| `addBusinessDays("2027-01-14", 3)` (Thu; MLK Day Mon Jan 18) | 2027-01-20 (Fri 15, Tue 19, Wed 20) |
| `addBusinessDays("2027-01-16", 3)` (Saturday) | 2027-01-21 |
| `addBusinessDays("2027-01-20", 5)` | 2027-01-27 |
| `addBusinessDays("2027-01-20", 1)` / `nextBusinessDay` | 2027-01-21 |
| `addBusinessDays("2027-03-29", 3)` | 2027-04-01 |
| `addBusinessDays("2027-03-26", 3)` | 2027-03-31 |
| `addBusinessDays("2027-03-31", 5)` | 2027-04-07 |
| `addBusinessDays("2026-11-25", 3)` (Thanksgiving Nov 26) | 2026-12-01 |
| `addBusinessDays("2026-12-23", 3)` (Christmas Fri) | 2026-12-29 |
| `addBusinessDays("2027-12-23", 3)` (Christmas observed Fri Dec 24) | 2027-12-29 |
| `addBusinessDays("2027-12-30", 1)` (New Year's observed Fri Dec 31) | 2028-01-03 |
| `addBusinessDays("2027-06-17", 1)` | 2027-06-21 |
| `addBusinessDays("2027-07-02", 1)` | 2027-07-06 |
| `addBusinessDays("2027-01-19", -1)` | 2027-01-15 |
| `addBusinessDays("2026-11-16", 10)` | 2026-12-01 |
| `addBusinessDays("2026-11-16", 5)` | 2026-11-23 |
| `addBusinessDays("2027-02-15", 10)` (starts on a holiday) | 2027-03-01 |
| `addBusinessDays("2027-01-16", 0)` | 2027-01-16 |
| FOUNDATION reference values (01-foundation.md E2.1): `("2026-11-02", 10)`, `("2026-11-17", 5)`, `("2026-11-20", 10)`, `("2026-12-07", 5)`, `("2026-11-12", 10)` | 2026-11-17, 2026-11-24, 2026-12-07, 2026-12-14, 2026-11-27 |
| `businessDaysBetween("2027-01-14", "2027-01-20")` | 3 |
| `businessDaysBetween("2027-01-15", "2027-01-19")` | 1 |
| `businessDaysBetween("2027-01-20", "2027-01-14")` | 0 |

`dates.test.ts`: `daysBetween("2026-11-16","2027-02-14")` = 90; `daysBetween("2027-12-31","2028-12-31")` = 366; `daysBetween("2027-02-14","2026-11-16")` = −90; `addDays("2027-01-20", 30)` = 2027-02-19; `addDays("2027-03-31", 45)` = 2027-05-15; `addMonths("2032-02-15", -9)` = 2031-05-15; `addMonths("2031-11-30", -9)` = 2031-02-28; `addMonths("2032-05-31", -9)` = 2031-08-31; `addMonths("2027-01-31", 1)` = 2027-02-28; `addMonths("2028-01-31", 1)` = 2028-02-29; `addYears("2028-02-29", 5)` = 2033-02-28; `addYears("2027-02-15", 5)` = 2032-02-15; `isIsoDate("2027-02-30")` false, `isIsoDate("2027-2-3")` false; `dayOfWeek("2027-03-31")` = 3; `quarterOf("2027-12-31")` → Q4, 2027-10-01..2027-12-31.

`allocate.test.ts`: `allocateProRata(100n, a:1,b:1,c:1)` → a 34, b 33, c 33; `(1000n, a:50,b:30,c:20)` → 500/300/200; `(101n, a:2,b:1,c:1)` → 51/25/25; `(7n, [b:1, a:1])` → a 4, b 3 (input order irrelevant); `(0n, a:1)` → a 0; `(5n, a:0,b:1)` → a 0, b 5; `(5n, a:0)` throws `ZERO_WEIGHT`; property test over 200 pseudo-random cases (fixed LCG seed, no `Math.random`): sum of shares = total and every share ≥ 0 and `|share − exact| < 1`.

`money.test.ts`: `roundDiv(5n, 10n)` = 1; `roundDiv(4n, 10n)` = 0; `roundDiv(-5n, 10n)` = −1; `roundDiv(15n, 10n)` = 2; `roundDiv(1n, 0n)` throws; `centsToDecimalString(123456n)` = "1234.56"; `centsToDecimalString(-5n)` = "-0.05"; `centsToDecimalString(0n)` = "0.00"; `microUnitsFromDecimal("12.345670")` = 12345670n; `microUnitsFromDecimal({ toString: () => "100" })` = 100000000n; `microUnitsFromDecimal("1.2345678")` throws; `microUnitsToDecimalString(12345670n)` = "12.345670"; `microUnitsToDecimalString(-30000000n)` = "-30.000000".

`units.ts` (R1, R2): `microUnitsForAmount` = `amount × 1_000_000 / price` (bigint division truncates), then, when `fractionalAllowed` is false, floored to a multiple of 1,000,000; `unitsForAmount` = `microUnitsToDecimalString` of it; `price ≤ 0n` or `amount < 0n` → throw `BAD_UNITS_INPUT`. `unitFractionMillionths` = `Number(roundDiv(units × 1_000_000n, total))`; `pctString` = `roundDiv(units × 1_000_000n, total)` rendered with 4 decimals ("22.2222"; "0.0000" when total = 0).

`units.test.ts` (price 100000n; first five are FOUNDATION's reference values): `unitsForAmount(10000000n, …, true)` = "100.000000"; `(4020000n, true)` = "40.200000"; `(1234567n, true)` = "12.345670"; `(1n, true)` = "0.000010"; `(4020000n, false)` = "40.000000"; `(0n, true)` = "0.000000"; `(-1n, true)` throws; price `0n` throws; `microUnitsForAmount(4000000n, 100000n, true)` = 40000000n; `unitFractionMillionths(100000000n, 450000000n)` = 222222; `pctString(100000000n, 450000000n)` = "22.2222"; `pctString(1n, 0n)` = "0.0000".

`config.ts` — types only plus one constant:
```ts
export type OffsetTarget = "BALANCE" | "INTEREST" | "COSTS";
export interface LlcEconomicsConfig {
  // from FOUNDATION's Preferred UnitClass
  pricePerUnitCents: Cents;          // 100_000n
  fractionalUnitsAllowed: boolean;   // true
  prefReturnBps: number;             // 800
  dayCountBasis: number;             // 365 (UnitClass.prefReturnDayCount = ACTUAL_365)
  residualPreferredBps: number;      // 7000 (UnitClass.residualSplitBps of the Preferred class)
  balanceReturnStartRule: "LATER_OF_RECEIPT_AND_DUE" | "RECEIPT_DATE";
  finalClosingDate: IsoDate | null;  // "2026-11-30"
  balanceOutsideDate: IsoDate | null;// "2027-03-31"; null until the Manager enters it on the unit class
  // from LlcTerm
  replacementFunderOutsideDate: IsoDate; // "2027-06-30"
  prefAccrualCutoff: "PAYMENT_DATE" | "PERIOD_END";
  accrueOnDefaulterCapital: boolean; // true
  capitalReturnLotOrder: "PRO_RATA" | "FIFO" | "LIFO";
  callNoticeBusinessDays: number;    // 3
  forfeitureCureBusinessDays: number;// 5
  creditDateMaxDays: number;         // 30
  defaultInterestBps: number;        // 1200
  defaultInterestDayBasis: number;   // 365
  forfeitureBps: number;             // 5000
  replacementCreditBps: number;      // 5000
  forfeitureBaseNetOfReplacementFunding: boolean; // false
  defaultOffsetOrder: readonly OffsetTarget[];    // ["BALANCE","INTEREST","COSTS"]
  managementFeeBps: number;          // 500
  minimumOperatingReserveCents: Cents; // 5_000_000n
  orgExpenseCapCents: Cents;         // 4_000_000n
  distributionDeadlineDays: number;  // 45
  targetSaleYears: number;           // 5
  loiExtensionMaxDays: number;       // 180
  extensionRequestMonthsBefore: number; // 9
  extensionConsentWindowDays: number;   // 30
  dissolutionElectionDays: number;   // 180
  ocdNoticeBusinessDays: number;     // 10
  includeInsiderDistributionsInManagerList: boolean; // true
  businessDays: BusinessDayOptions;  // { holidays: "US_FEDERAL", saturdayObservedOnFriday: true, extraHolidays: [] }
}
export const OA_DEFAULTS: LlcEconomicsConfig; // exactly the values in the comments above, with finalClosingDate "2026-11-30" and balanceOutsideDate "2027-03-31"
```
Library functions that need `balanceOutsideDate` throw `LlcMathError("TERMS_INCOMPLETE", …)` when it is null.

**Acceptance**: all tables pass, including FOUNDATION's reference values; `grep -rn 'from "@/' src/lib/llc` returns nothing; `grep -rnE 'new Date\(\)|Date\.now' src/lib/llc` returns nothing.

---

### E2 — Library: positions, Preferred Return

**Goal**: derive every holder balance as of any date from immutable events (R1–R8, R34, R39). **Prerequisites**: E1.

**Create**: `src/lib/llc/positions.ts`, `preferred-return.ts`, `fixtures/scenario-s.ts`, tests `positions.test.ts`, `preferred-return.test.ts`.

`preferred-return.ts` (R4, R5)
```ts
export type ReceiptKind = "INITIAL" | "BALANCE" | "REPLACEMENT" | "CREDIT";   // FORFEITURE receipts are not lots; they become FORFEITURE events
export function resolvePrefReturnStart(i: { kind: ReceiptKind; receivedOn: IsoDate; lineDueOn: IsoDate | null; balanceOutsideDate: IsoDate | null;
  rule: "LATER_OF_RECEIPT_AND_DUE" | "RECEIPT_DATE" }): IsoDate;
  // INITIAL, REPLACEMENT, CREDIT → receivedOn (a CREDIT's receivedOn is the Credit Date)
  // BALANCE, rule RECEIPT_DATE → receivedOn
  // BALANCE, rule LATER_OF_RECEIPT_AND_DUE → maxIso(receivedOn, lineDueOn ?? balanceOutsideDate); both null → throw TERMS_INCOMPLETE
export function simpleInterest(principal: Cents, days: number, bps: number, basis: number): Cents;
  // roundDiv(principal × days × bps, basis × 10_000); days < 0 → throw
export interface ReceiptRow { receiptId: string; holderId: string; kind: ReceiptKind; on: IsoDate /* appliedOn: the date capital and units exist */; receivedOn: IsoDate;
  amount: Cents /* appliedCents */; units: MicroUnits /* unitsIssued */; prefReturnStartOn: IsoDate /* CapitalReceipt.prefReturnStartDate */; seq: number }
export interface AllocationRow { receiptId: string; amount: Cents; prefReturnStartOn: IsoDate } // net of reversals, amount > 0
export function buildCapitalLots(receipts: readonly ReceiptRow[], allocations: readonly AllocationRow[]): ContributionEvent[];
```
`buildCapitalLots`: every lot's event date is the receipt's `on`. For each receipt, each allocation of that receipt becomes a lot (`lotId = receiptId + ":" + index`, `accrualStartOn = allocation.prefReturnStartOn`, `amount = allocation.amount`); the unallocated remainder (receipt amount − Σ allocations, if > 0) becomes a lot `receiptId + ":rest"` with `accrualStartOn = receipt.prefReturnStartOn`. Units are split across the receipt's lots pro rata to amount with `allocateProRata`. Σ allocations > receipt amount → throw `OVER_ALLOCATED`. Non-`BALANCE` receipts have no allocations.

`positions.ts`
```ts
export interface ContributionEvent { kind: "CONTRIBUTION"; on: IsoDate; seq: number; holderId: string; lotId: string; amount: Cents; units: MicroUnits; accrualStartOn: IsoDate }
export interface ForfeitureEvent   { kind: "FORFEITURE";   on: IsoDate; seq: number; holderId: string; amount: Cents /* positive */; units: MicroUnits /* positive, units cancelled */ }
export interface TransferEvent     { kind: "TRANSFER";     on: IsoDate; seq: number; fromHolderId: string; toHolderId: string; units: MicroUnits }
export interface DistributionEvent { kind: "DISTRIBUTION"; on: IsoDate; seq: number; distributionId: string; lines: readonly { holderId: string; tierC: Cents; tierD: Cents }[] }
export type LedgerEvent = ContributionEvent | ForfeitureEvent | TransferEvent | DistributionEvent;

export interface LotState { lotId: string; accrualStartOn: IsoDate; original: Cents; outstanding: Cents }
export interface HolderPosition {
  holderId: string;
  contributed: Cents;        // R3
  unreturned: Cents;         // R3
  capitalReturned: Cents;    // Σ tier (d)
  forfeited: Cents;
  preferredUnits: MicroUnits;
  accruedReturn: Cents;      // rounded once (R6)
  returnPaid: Cents;         // Σ tier (c)
  returnExtinguished: Cents; // R34
  returnCarriedIn: Cents;    // R39
  returnCarriedOut: Cents;
  unpaidReturn: Cents;       // accrued − paid − extinguished − carriedOut + carriedIn
  lots: LotState[];
}
export interface PositionsResult {
  asOf: IsoDate;
  holders: Map<string, HolderPosition>;   // only holders that appear in events
  totals: { contributed: Cents; unreturned: Cents; unpaidReturn: Cents; preferredUnits: MicroUnits };
  forfeitures: { holderId: string; on: IsoDate; amount: Cents; unreturnedDeducted: Cents; extinguishedReturn: Cents; unitsBefore: MicroUnits; unitsAfter: MicroUnits }[];
}
export interface PositionOptions {
  /** Process events with on < asOf, plus events on asOf with seq < untilSeq. Default: all events with on ≤ asOf. */
  untilSeq?: number;
  /** R8: windows during which a holder's lots do not accrue: days d with from < d ≤ (to ?? asOf). */
  accrualPauses?: readonly { holderId: string; from: IsoDate; to: IsoDate | null }[];
}
export function computePositions(
  events: readonly LedgerEvent[], asOf: IsoDate,
  cfg: Pick<LlcEconomicsConfig, "prefReturnBps" | "dayCountBasis" | "capitalReturnLotOrder">,
  opts?: PositionOptions,
): PositionsResult;
```

Algorithm (normative):
1. Select events per `asOf` / `untilSeq`; sort by `on`, then `seq` (the caller assigns `seq`; the ledger loader in E7 defines the same-day order). `seq` values must be unique (throw `DUPLICATE_SEQ`).
2. Each lot carries an exact numerator `numer: bigint` (cents × days × bps) and `accruedThrough: IsoDate` (initially `accrualStartOn`). `advance(holder, t)`: for each lot, `from = max(accruedThrough, accrualStartOn)`; if `t > from`: `numer += outstanding × accruingDays(from, t) × prefReturnBps`, `accruedThrough = t`. `accruingDays` = `daysBetween(from, t)` minus the days inside that holder's pause windows.
3. Before applying any event on date `t`, `advance` every holder the event touches to `t`. A `CONTRIBUTION` whose `on` is before its `accrualStartOn` creates a lot that starts accruing later. A `CONTRIBUTION` whose `accrualStartOn` is **before** its `on` (money wired before acceptance) accrues from `accrualStartOn`: the lot's `accruedThrough` starts at `accrualStartOn`, so the first `advance` after creation adds the days back to it.
4. `CONTRIBUTION`: push lot, `contributed += amount`, `preferredUnits += units`.
5. `DISTRIBUTION` line: `returnPaid += tierC` (throw `OVERPAID_RETURN` if `tierC > unpaidReturn` at `t`); tier (d): throw `OVER_RETURNED` if `tierD > unreturned`; reduce lots per `capitalReturnLotOrder` (`PRO_RATA`: `allocateProRata(tierD, lots by outstanding)`; `FIFO`/`LIFO`: by `accrualStartOn` then `lotId`); `capitalReturned += tierD`. Negative tier amounts are not allowed (reversed distributions are filtered out by the loader).
6. `FORFEITURE` (R34; the FOUNDATION `FORFEITURE` receipt, see R5): from `t` (the Forfeiture Date) on, the reduced lots accrue only on what remains, which stops the return on the Forfeited Amount. `x = min(amount, unreturned)`; `extinguished = unreturned === 0n ? 0n : roundDiv(unpaidReturn(t) × x, unreturned)`; reduce lots pro rata by `x`; `contributed −= amount` (throw `FORFEIT_EXCEEDS_CAPITAL` if negative); `forfeited += amount`; `preferredUnits −= units` (throw `FORFEIT_EXCEEDS_UNITS` if negative); record in `forfeitures`.
7. `TRANSFER` (R39): `N = from.preferredUnits` (throw `TRANSFER_EXCEEDS_UNITS` if `units > N` or `N = 0`); `movedCapital = roundDiv(from.unreturned × units, N)` split over lots with `allocateProRata` by outstanding; for each lot with a moved part > 0 create a transferee lot `lotId + ">" + toHolderId + "@" + on`, `accrualStartOn = maxIso(lot.accrualStartOn, on)`, numerator 0; `movedContributed = roundDiv(from.contributed × units, N)`; `carry = roundDiv(from.unpaidReturn(t) × units, N)`; `from.returnCarriedOut += carry`, `to.returnCarriedIn += carry`; units move.
8. After the last event, `advance` every holder to `asOf`. `accruedReturn = roundDiv(Σ lot numerators, dayCountBasis × 10_000)`.

**Tests** — `positions.test.ts` / `preferred-return.test.ts` (8%, basis 365):

| Id | Setup | As of | Expect |
|---|---|---|---|
| PR-1a | $100,000 received and accruing from 2026-11-16 | 2026-11-16 | accrued $0.00 |
| PR-1b | same | 2026-12-31 (45 days) | 100,000 × 0.08 × 45 / 365 = 986.301… → **$986.30** |
| PR-1c | same (crosses year end) | 2027-02-14 (90 days) | 1,972.602… → **$1,972.60** |
| PR-1d | same | 2027-11-16 (365 days) | **$8,000.00** |
| PR-2a | $250,000 from 2027-12-31 | 2028-02-29 (60 days) | 3,287.671… → **$3,287.67** |
| PR-2b | same (leap year 2028) | 2028-12-31 (366 days) | 250,000 × 0.08 × 366 / 365 = 20,054.794… → **$20,054.79** |
| PR-3a | A: a1 $40,000 from 2026-11-16; a2 $60,000 received 2027-01-11, accrual start 2027-01-20 | 2027-05-14 | a1 179 days = 1,569.315…; a2 114 days = 1,499.178…; total 3,068.493… → **$3,068.49**; unreturned $100,000.00 |
| PR-3b | + DISTRIBUTION 2027-05-14: A tierD $25,000.00 | 2027-05-14 | unreturned **$75,000.00**; lots a1 **$30,000.00**, a2 **$45,000.00**; accrued still $3,068.49; units 100 |
| PR-3c | same | 2027-08-13 (+91 days on $75,000) | numerator: 40,000×179 + 60,000×114 + 75,000×91 = 20,825,000 dollar-days → × 0.08 / 365 = 4,564.383… → **$4,564.38** |
| PR-4a | $100,000 from 2026-11-16; DISTRIBUTION 2027-02-12 tierC $1,000.00 | 2027-02-12 (88 days) | accrued **$1,928.77**, paid $1,000.00, unpaid **$928.77** |
| PR-4b | same (unpaid return earns nothing) | 2027-05-14 (179 days) | accrued **$3,923.29**, unpaid **$2,923.29** |
| PR-5a | prepaid Balance: a1 $40,000 from 2026-11-16; a2 $60,000 received 2026-12-01, no Call Notice → start 2027-03-31 | 2027-03-31 | a1 135 days = **$1,183.56**; a2 $0; unreturned $100,000.00; units 100 |
| PR-5b | same | 2027-06-30 | a1 226 days 1,981.369… + a2 91 days 1,196.712… = 3,178.082… → **$3,178.08** |
| PR-6 | tierC greater than unpaid | — | throws `OVERPAID_RETURN` |
| PR-7 | tierD greater than unreturned | — | throws `OVER_RETURNED` |
| PR-8 | `untilSeq`: PR-4a with the distribution `seq = 5`, `asOf = 2027-02-12`, `untilSeq = 5` | — | unpaid **$1,928.77** (distribution excluded) |
| PR-9 | pause: $100,000 from 2026-11-16, `accrualPauses: [{ holderId: "A", from: "2027-01-20", to: "2027-02-09" }]` | 2027-02-14 | 90 − 20 = 70 days → 1,534.246… → **$1,534.25** |
| S-0 | Scenario S | 2027-05-14 | A 179 days **$3,923.29**; B 172 days **$9,424.66**; C (40,000×165 + 60,000×114) → **$2,945.75**; total unpaid **$16,293.70**; units A 100, B 250, C 100; total unreturned $450,000.00 |
| PR-10 | wired before acceptance: CONTRIBUTION `on` 2026-11-13, `accrualStartOn` 2026-11-12, $100,000 | 2026-11-12: holder absent; 2026-11-16 | 4 days → 87.671… → **$87.67** |
| F-1 | forfeiture: A $100,000 (2026-11-16), B $250,000 (2026-11-23), C $40,000 (2026-11-30); FORFEITURE C $30,000.00 / 30 units on 2027-01-27 | 2027-01-27 | C accrued (58 days) **$508.49**; extinguished 508.49 × 30,000 / 40,000 = 381.3675 → **$381.37**; unpaid **$127.12**; contributed **$10,000.00**; unreturned **$10,000.00**; units 40 → **10**; A unpaid $1,578.08; B unpaid $3,561.64 |
| F-2 | cap case: D $25,000 from 2026-11-30; FORFEITURE D $25,000.00 / 25 units on 2027-01-27 | 2027-01-27 | contributed $0.00, unreturned $0.00, units 0, accrued (58 days) $317.81, extinguished **$317.81**, unpaid $0.00 |
| T-1 | A $100,000 from 2026-11-16; TRANSFER 40 units A → N effective 2027-06-01 | 2027-06-01 | A unpaid before = 197 days **$4,317.81**; carry 1,727.124 → **$1,727.12**; A: contributed $60,000.00, unreturned $60,000.00, units 60, unpaid **$2,590.69**; N: contributed $40,000.00, unreturned $40,000.00, units 40, unpaid **$1,727.12** |
| T-2 | same | 2027-08-13 (+73 days) | A accrued (100,000×197 + 60,000×73 dollar-days) **$5,277.81**, unpaid **$3,550.69**; N accrued **$640.00**, unpaid **$2,367.12**; A + N = **$5,917.81** (= untransferred A at 270 days) |

`preferred-return.test.ts` — `resolvePrefReturnStart` (rule `LATER_OF_RECEIPT_AND_DUE`, outside date 2027-03-31): INITIAL 2026-11-16 → 2026-11-16; BALANCE received 2027-01-11, line due 2027-01-20 → 2027-01-20; BALANCE received 2027-01-25, line due 2027-01-20 → 2027-01-25; BALANCE received 2026-12-01, no line → 2027-03-31; BALANCE received 2027-04-05, no line → 2027-04-05; CREDIT 2027-02-19 → 2027-02-19; rule `RECEIPT_DATE`: BALANCE received 2027-01-11, line due 2027-01-20 → 2027-01-11; BALANCE with no line and `balanceOutsideDate` null → throws `TERMS_INCOMPLETE`. `simpleInterest($100,000, 90, 800, 365)` = $1,972.60. `buildCapitalLots`: receipt $60,000 (60 units) with one allocation $20,000 @2027-01-20, receipt start 2027-03-31 → two lots: $20,000 / 20 units @2027-01-20 and $40,000 / 40 units @2027-03-31; allocations totalling $70,000 on that receipt → throws `OVER_ALLOCATED`.

**Acceptance**: all rows pass with exact cents; `computePositions` is deterministic under shuffled input order (test: shuffle Scenario S events with a fixed permutation, same result).

---

### E3 — Library: waterfall, netting, liquidation

**Goal**: R9–R14, R16–R18, R40, R43. **Prerequisites**: E1 (uses `allocateProRata`; takes plain holder rows, no dependency on E2 code — tests construct rows by hand from the numbers below).

**Create**: `src/lib/llc/waterfall.ts`, `waterfall.test.ts`.

```ts
export interface WaterfallHolder { holderId: string; unpaidReturn: Cents; unreturned: Cents; preferredUnits: MicroUnits; commonUnits: MicroUnits }
export interface WaterfallLine { holderId: string; tierC: Cents; tierD: Cents; tierEPreferred: Cents; tierECommon: Cents; gross: Cents }
export interface WaterfallResult { amount: Cents; tierC: Cents; tierD: Cents; tierEPreferred: Cents; tierECommon: Cents; lines: WaterfallLine[] } // lines sorted by holderId, one per input holder
export function runWaterfall(amount: Cents, holders: readonly WaterfallHolder[], opts: { mode: "FULL" | "D_ONLY"; residualPreferredBps: number }): WaterfallResult;
```
Rules: `amount < 0` → throw `NEGATIVE`. `FULL`: tier C = `min(amount, Σ unpaidReturn)` by weights `unpaidReturn` (R9); tier D = `min(rest, Σ unreturned)` by weights `unreturned` (R10); tier E on the rest (R11): pools = `allocateProRata(rest, [{ key: "0-preferred", weight: BigInt(bps) }, { key: "1-common", weight: BigInt(10000 − bps) }])`; preferred pool by `preferredUnits`, common pool by `commonUnits`; a pool > 0 with zero total units → throw `NO_UNITS_IN_CLASS`. `D_ONLY` (R13): tier D only; `amount > Σ unreturned` → throw `EXCEEDS_UNRETURNED_CAPITAL`. Skip a tier whose total weight is zero. Invariant (asserted before return): Σ line.gross = amount and every tier total = Σ its line parts.

```ts
export interface DefaultOwed { memberDefaultId: string; dueOn: IsoDate; suspended: boolean; balance: Cents; interest: Cents; costs: Cents;
  cureNeedsConfirmation: boolean /* true when paying everything owed would still not cure: replacement funding exists and the forfeiture or credit is not confirmed */ }
export interface OffsetApplication { memberDefaultId: string; toBalance: Cents; toInterest: Cents; toCosts: Cents; paysInFull: boolean }
export interface NetLine { gross: Cents; offsets: OffsetApplication[]; defaultOffsetBalance: Cents; defaultOffsetInterest: Cents; defaultOffsetCosts: Cents; taxAdvanceOffset: Cents; net: Cents;
  excessHeld: boolean /* a suspended default with cureNeedsConfirmation was paid in full and money was left over: the caller must block (E15 DEFAULT_EXCESS_HELD) */ }
export function applyDefaultOffset(available: Cents, owed: DefaultOwed, order: readonly OffsetTarget[]): OffsetApplication & { remaining: Cents };
export function netDistributionLine(i: { gross: Cents; defaults: readonly DefaultOwed[]; taxAdvanceOutstanding: Cents; order: readonly OffsetTarget[] }): NetLine;
```
`applyDefaultOffset` (R17, R18): walk `order`; for a `suspended` default take `min(available, owed[target])` for each target; for a non-suspended (cured) default skip `BALANCE` (it is zero or no longer withheld) and take only `INTEREST` and `COSTS`. `paysInFull` = everything owed on that default is covered. `netDistributionLine`: process defaults by `dueOn` ascending then id, each taking from what the previous left (`remaining`). A suspended default absorbs everything until it is paid in full, so `remaining > 0` after the loop implies every suspended default was paid in full. Then `taxAdvanceOffset = min(remaining, taxAdvanceOutstanding)` (R16) and `net = remaining − taxAdvanceOffset`. Invariant: `gross = Σ offsets + taxAdvanceOffset + net`. `gross = 0` → all zeros. `excessHeld` = some default has `suspended && cureNeedsConfirmation && paysInFull` and `remaining > 0` after the defaults loop (the amounts are still computed as if payable; the flag only reports the condition).

```ts
export function liquidationWaterfall(i: { cash: Cents; creditors: Cents; memberLoans: Cents; windDownReserve: Cents; holders: readonly WaterfallHolder[]; residualPreferredBps: number }):
  { netToMembers: Cents; waterfall: WaterfallResult };            // R40; netToMembers < 0 → throw INSUFFICIENT_FOR_CREDITORS
export function hypotheticalLiquidation(i: { assetFmv: Cents; cashOnHand: Cents; liabilities: Cents; memberLoans: Cents; holders: readonly WaterfallHolder[]; residualPreferredBps: number }):
  { netToMembers: Cents; waterfall: WaterfallResult };            // R43; negative net → netToMembers 0n and an all-zero waterfall
export function fairValueOfUnits(holderGross: Cents, unitsValued: MicroUnits, unitsHeld: MicroUnits): Cents; // roundDiv(gross × n, N); n > N or N = 0 → throw
```

**Tests** (`waterfall.test.ts`; M has 100 Common Units = 100,000,000 micro; 70/30):

| Id | Input | Expect |
|---|---|---|
| W-1 partial tier (c) | amount $12,000.00; A unpaid 3,923.29 / unreturned 100,000 / 100 u; B 9,424.66 / 250,000 / 250 u; C 2,945.75 / 100,000 / 100 u (Σ unpaid 16,293.70) | tierC $12,000.00: A **$2,889.43**, B **$6,941.08**, C **$2,169.49**; tierD 0; tierE 0; M $0.00 |
| W-2 exhausts (c), part of (d) | amount $60,000.00; A 3,028.38 / 100,000; B 7,469.88 / 250,000; C 2,770.78 / 100,000 (positions on 2027-08-13 after W-1) | tierC **$13,269.04** (A 3,028.38, B 7,469.88, C 2,770.78); tierD **$46,730.96**: A **$10,384.66**, B **$25,961.64**, C **$10,384.66**; gross A $13,413.04, B $33,431.52, C $13,155.44 |
| W-3 full exit through (e) | amount $1,000,000.00; A 29,201.25 / 79,615.34 / 100 u; B 73,003.12 / 199,038.36 / 250 u; C 29,201.25 / 79,615.34 / 100 u; M 100 common | tierC **$131,405.62**; tierD **$358,269.04**; rest $510,325.34 → preferred pool **$357,227.74**, common pool **$153,097.60**; tierE A **$79,383.94**, B **$198,459.86**, C **$79,383.94**; gross A **$188,200.53**, B **$470,501.34**, C **$188,200.53**, M **$153,097.60**; Σ = $1,000,000.00 |
| W-4 return of unused capital | mode `D_ONLY`, amount $45,000.00; A 1,787.39 / 89,615.34; B 4,468.49 / 224,038.36; C 1,787.40 / 89,615.34 | tierC 0 (unpaid return untouched); tierD A **$10,000.00**, B **$25,000.00**, C **$10,000.00** |
| W-5 `D_ONLY` too large | amount $500,000.00, same holders | throws `EXCEEDS_UNRETURNED_CAPITAL` |
| W-6 cents | amount $100.00; X, Y, Z each unpaid $10.00, unreturned 0, 1 unit (1,000,000 micro) | tierC 30.00 (10/10/10); preferred pool **$49.00**: X **$16.34**, Y $16.33, Z $16.33; common **$21.00** |
| W-7 cents | amount $1.00; same holders | tierC X **$0.34**, Y $0.33, Z $0.33 |
| W-8 cents | amount $0.05; X, Y nothing owed, 1 unit each | preferred pool **$0.04** (X 0.02, Y 0.02), common **$0.01** |
| W-9 amount 0 | amount 0 | all zeros, one line per holder |
| W-10 no common units | amount $10.00, no unpaid, no unreturned, no common holder | throws `NO_UNITS_IN_CLASS` |
| N-1 suspended, text order | gross $5,000.00; default owed balance 60,000.00, interest 2,248.77, costs 1,200.00, suspended; order BALANCE, INTEREST, COSTS | toBalance **$5,000.00**; net **$0.00** |
| N-2 alternative order | same, order COSTS, INTEREST, BALANCE | toCosts **$1,200.00**, toInterest **$2,248.77**, toBalance **$1,551.23**; net $0.00 |
| N-3 pays in full | gross $70,000.00, same owed, text order | toBalance 60,000.00, toInterest 2,248.77, toCosts 1,200.00, `paysInFull` true; net **$6,551.23** |
| N-4 tax advance | gross $13,413.04; no default; advance outstanding $2,500.00 | taxAdvanceOffset **$2,500.00**; net **$10,913.04** |
| N-5 tax advance larger than line | gross $2,889.43; advance $4,000.00 | taxAdvanceOffset **$2,889.43**; net $0.00 (remaining advance $1,110.57 is the caller's arithmetic) |
| N-6 cured default, costs still owed | gross $1,000.00; default `suspended: false`, balance 0, interest 256.44, costs 300.00 | toInterest 256.44, toCosts 300.00; net **$443.56** |
| N-7 default then tax advance | gross $70,000.00; owed as N-3; advance $5,000.00 | offsets as N-3; taxAdvanceOffset **$5,000.00**; net **$1,551.23** |
| N-8 excess held | gross $1,000.00; default `suspended: true`, `cureNeedsConfirmation: true`, balance 0, interest 100.00, costs 0 | toInterest 100.00, `paysInFull` true, net $900.00, **`excessHeld` true** (with `cureNeedsConfirmation: false` the same input gives `excessHeld` false) |
| L-1 liquidation | cash $1,050,000.00; creditors $30,000.00; member loans $20,000.00; reserve 0; holders as W-3 | netToMembers **$1,000,000.00**; waterfall = W-3 |
| L-2 | cash $40,000.00; creditors $50,000.00 | throws `INSUFFICIENT_FOR_CREDITORS` |
| H-1 fair value | assetFmv $900,000.00, cash $150,000.00, liabilities $30,000.00, loans $20,000.00; holders as W-3 | netToMembers $1,000,000.00; A gross $188,200.53; `fairValueOfUnits(18,820,053n, 25 u, 100 u)` = 47,050.1325 → **$47,050.13** |

**Acceptance**: every row passes; invariant test over 300 pseudo-random cases (fixed seed): Σ lines = amount, tier D never exceeds a holder's `unreturned`, tier C never exceeds a holder's `unpaidReturn`.

---

### E4 — Library: Call Notice and default math

**Goal**: R26–R37. **Prerequisites**: E2. **Create**: `src/lib/llc/default.ts`, `default.test.ts`.

```ts
type Cfg = LlcEconomicsConfig;
export function callNoticeDueDate(sentOn: IsoDate, cfg: Pick<Cfg, "callNoticeBusinessDays" | "balanceOutsideDate" | "businessDays">): IsoDate;
  // R26: minIso(addBusinessDays(sentOn, n), balanceOutsideDate); sentOn > balanceOutsideDate → throw AFTER_OUTSIDE_DATE
export function uncalledBalance(i: { acceptedCommitment: Cents; initialPaid: Cents; calledTotal: Cents }): Cents;
  // max(0, accepted − initialPaid − calledTotal); calledTotal = Σ amountCalled of lines of SENT/SETTLED notices.
  // Replacement funding reduces a called (defaulted) line, never the uncalled Balance, so it is not an input here.
export interface OpenLine { lineId: string; dueOn: IsoDate | null; outstanding: Cents; createdSeq: number }
export function allocatePaymentToLines(amount: Cents, receivedOn: IsoDate, lines: readonly OpenLine[], rule: "LATER_OF_RECEIPT_AND_DUE" | "RECEIPT_DATE"):
  { allocations: { lineId: string; amount: Cents; prefReturnStartOn: IsoDate }[]; unallocated: Cents };
  // R29: lines with dueOn first, oldest dueOn first, then createdSeq; lines with dueOn null are skipped;
  // prefReturnStartOn = rule === "RECEIPT_DATE" ? receivedOn : maxIso(receivedOn, dueOn) (FOUNDATION's UnitClass.balanceReturnStartRule, R5)
export function forfeitureDate(dueOn: IsoDate, cfg): IsoDate;                    // R33: addBusinessDays(dueOn, 5)
export function replacementWindow(dueOn: IsoDate, cfg): { opensOn: IsoDate; closesOn: IsoDate }; // R31: nextBusinessDay(dueOn) .. replacementFunderOutsideDate
export function creditDate(i: { dueOn: IsoDate; forfeitureDate: IsoDate; fullyFundedOn: IsoDate | null }, cfg): IsoDate; // R35

export interface BalanceReduction { on: IsoDate; amount: Cents; by: "MEMBER" | "REPLACEMENT_FUNDER" }  // MEMBER includes distribution offsets
export function outstandingBalance(unpaidAtDue: Cents, reductions: readonly BalanceReduction[], asOf: IsoDate): Cents; // reductions with on ≤ asOf
export function fullyFundedOn(unpaidAtDue: Cents, reductions: readonly BalanceReduction[]): IsoDate | null;
  // first date the running balance reaches 0 where the reduction that reached 0 is by REPLACEMENT_FUNDER; else null
export function defaultInterest(i: { unpaidAtDue: Cents; dueOn: IsoDate; reductions: readonly BalanceReduction[]; asOf: IsoDate }, cfg): Cents;
  // R30: Σ over segments between consecutive reduction dates of outstanding × days × bps, one roundDiv by basis × 10_000; asOf ≤ dueOn → 0
export interface ForfeitureProposal { unpaidAtForfeiture: Cents; halfOfUnpaid: Cents; capitalPaid: Cents; capBinding: boolean; forfeited: Cents;
  unreturnedDeducted: Cents; extinguishedReturn: Cents; contributedAfter: Cents; unitsBefore: MicroUnits; unitsAfter: MicroUnits }
export function computeForfeiture(i: { unpaidAtDue: Cents; reductions: readonly BalanceReduction[]; forfeitureDate: IsoDate;
  position: Pick<HolderPosition, "contributed" | "unreturned" | "unpaidReturn" | "preferredUnits"> }, cfg): ForfeitureProposal;
  // R33/R34. unpaidAtForfeiture = unpaidAtDue − Σ MEMBER reductions ≤ forfeitureDate (− REPLACEMENT_FUNDER ones too iff forfeitureBaseNetOfReplacementFunding)
  // unitsAfter = unitsBefore − microUnitsForAmount(forfeited, pricePerUnitCents, fractionalUnitsAllowed) (the units FOUNDATION cancels on the FORFEITURE receipt)
  // position = the member's position as of forfeitureDate BEFORE the forfeiture event
export interface CreditProposal { fundedCounted: Cents; poolA: Cents; redirected: Cents; poolB: Cents; blocked: null | "NO_ELIGIBLE_HOLDERS";
  credits: { holderId: string; clause: "A" | "B"; amount: Cents; units: MicroUnits }[] }  // zero-amount credits omitted
export function computeCreditAllocation(i: { forfeited: Cents; unpaidAtForfeiture: Cents;
  fundings: readonly { holderId: string; amount: Cents; isInsider: boolean }[];          // fundings on or before the Credit Date, summed per holder
  holdersOnDueDate: readonly { holderId: string; units: MicroUnits }[] }, cfg): CreditProposal; // Preferred holders on dueOn, Defaulting Member already excluded
export function cureStatus(i: { outstandingBalance: Cents; interestOwed: Cents; costsOwed: Cents; lastReductionBy: "MEMBER" | "REPLACEMENT_FUNDER" | null;
  forfeitureConfirmed: boolean; creditConfirmed: boolean; forfeitureDatePassed: boolean }): { cured: boolean; method: "PAID_IN_FULL" | "REPLACEMENT_FUNDED" | null };
  // R37: PAID_IN_FULL when balance, interest, costs are all 0 and no Replacement Funder reduced the Balance; REPLACEMENT_FUNDED when balance = 0 with any
  // replacement funding and (forfeiture and credit confirmed); a fully replacement-funded default before the Forfeiture Date is not cured until then
export function isSuspended(d: { status: "OPEN" | "CURED" | "VOIDED"; dueOn: IsoDate; curedOn: IsoDate | null }, asOf: IsoDate): boolean;
  // R32: status ≠ VOIDED && dueOn < asOf && (curedOn === null || asOf < curedOn)
export function suspendedHolderIds(defaults: readonly { stakeholderId: string; status; dueOn; curedOn }[], asOf: IsoDate): Set<string>;
```
`computeCreditAllocation` (R36): `fundedCounted = min(Σ fundings, unpaidAtForfeiture)`; `poolA = unpaidAtForfeiture === 0n ? 0n : roundDiv(forfeited × BigInt(replacementCreditBps) × fundedCounted, 10_000n × unpaidAtForfeiture)`; split `poolA` by funding amounts; `redirected` = Σ shares of insiders; `poolB = forfeited − poolA + redirected`; if `poolB > 0` and Σ units of `holdersOnDueDate` = 0 → `blocked = "NO_ELIGIBLE_HOLDERS"` and no credits; else split `poolB` by units; `units = microUnitsForAmount(amount, pricePerUnitCents, true)` (always fractional, §4.9(iv) "including fractional Preferred Units"; E11 refuses to confirm a credit while the Preferred class has `fractionalUnitsAllowed = false`, because FOUNDATION would floor the units). A holder can have both an A and a B credit. Σ credits = `forfeited`.

**Tests** (`default.test.ts`, OA defaults; `allocatePaymentToLines` rows use `rule` `LATER_OF_RECEIPT_AND_DUE` unless stated):

| Id | Input | Expect |
|---|---|---|
| CN-1 | `callNoticeDueDate("2027-01-14")` | 2027-01-20 |
| CN-2 | `callNoticeDueDate("2027-03-29")` (would be 2027-04-01) | **2027-03-31** |
| CN-3 | `callNoticeDueDate("2027-03-26")` | 2027-03-31 |
| CN-4 | `callNoticeDueDate("2027-04-01")` | throws `AFTER_OUTSIDE_DATE` |
| CN-5 | `uncalledBalance({ accepted 100,000, initialPaid 40,000, calledTotal 30,000 })`; and with calledTotal 70,000 | $30,000.00; $0.00 |
| CN-6 | `allocatePaymentToLines($50,000, "2027-01-19", [L1 due 2027-01-20 outstanding 30,000; L2 due 2027-02-10 outstanding 30,000])` | L1 $30,000 start 2027-01-20; L2 $20,000 start 2027-02-10; unallocated 0 |
| CN-6r | CN-6 with `rule` `RECEIPT_DATE` | L1 $30,000 start **2027-01-19**; L2 $20,000 start **2027-01-19**; unallocated 0 |
| CN-7 | `allocatePaymentToLines($70,000, "2027-01-25", [L1 due 2027-01-20 outstanding 60,000])` | L1 $60,000 start **2027-01-25** (late); unallocated $10,000 |
| D-dates | `forfeitureDate("2027-01-20")` | 2027-01-27; window opens 2027-01-21, closes 2027-06-30 |
| D-dates-2 | `forfeitureDate("2027-03-31")` | 2027-04-07 |
| CD-1 | `creditDate({ dueOn 2027-01-20, forfeitureDate 2027-01-27, fullyFundedOn null })` | **2027-02-19** |
| CD-2 | fullyFundedOn 2027-02-03 | 2027-02-03 |
| CD-3 | fullyFundedOn 2027-01-25 (before the Forfeiture Date) | 2027-01-27 |
| CD-4 | fullyFundedOn 2027-03-15 | 2027-02-19 |
| I-1 | $60,000 unpaid from 2027-01-20, no reductions, asOf 2027-02-09 (20 days) | 60,000 × 0.12 × 20 / 365 = 394.520… → **$394.52** |
| I-2 | same, asOf 2027-05-14 (114 days) | **$2,248.77** |
| I-3 | reductions: 2027-01-25 $30,000 (RF), 2027-02-01 $15,000 (RF); asOf 2027-02-19 | dollar-days 60,000×5 + 30,000×7 + 15,000×18 = 780,000 → × 0.12 / 365 = 256.438… → **$256.44** |
| I-4 | one reduction 2027-02-09 $30,000 (MEMBER); asOf 2027-05-14 | (60,000×20 + 30,000×94) × 0.12 / 365 = 1,321.643… → **$1,321.64** (rounded once, not 394.52 + 927.12) |
| I-5 | asOf = dueOn | $0.00 |
| FF-1 cap not binding | unpaidAtDue $60,000; reductions: 2027-01-25 $30,000 by RF; forfeitureDate 2027-01-27; position: contributed 40,000, unreturned 40,000, unpaidReturn 508.49, units 40 | unpaidAtForfeiture **$60,000.00** (RF funding not deducted); half $30,000.00; cap $40,000.00; `capBinding` false; forfeited **$30,000.00**; extinguished **$381.37**; contributedAfter $10,000.00; units 40 → **10** |
| FF-2 switch on | same with `forfeitureBaseNetOfReplacementFunding: true` | unpaidAtForfeiture $30,000.00; forfeited **$15,000.00**; extinguished 508.49 × 15,000 / 40,000 = 190.68375 → **$190.68**; units → 25 |
| FF-3 cap binding | unpaidAtDue $75,000; no reductions; position: contributed 25,000, unreturned 25,000, unpaidReturn 317.81, units 25 | half $37,500.00; cap $25,000.00; `capBinding` true; forfeited **$25,000.00**; extinguished **$317.81**; units → **0** |
| FF-4 member paid part before | unpaidAtDue $60,000; reduction 2027-01-22 $20,000 by MEMBER; position contributed 60,000, unreturned 60,000, unpaidReturn 0 | unpaidAtForfeiture $40,000.00; forfeited **$20,000.00**; contributedAfter $40,000.00 |
| FF-5 capital already returned | unpaidAtDue $60,000; position contributed 40,000, unreturned 20,000, unpaidReturn 100.00 | forfeited $30,000.00; unreturnedDeducted **$20,000.00**; extinguished **$100.00**; contributedAfter $10,000.00 |
| CR-1 insider redirect | forfeited $30,000; unpaidAtForfeiture $60,000; fundings A $30,000 (outsider), K $15,000 (insider); holdersOnDueDate A 100 u, B 250 u, K 50 u | fundedCounted $45,000; poolA 30,000 × 50% × 45/60 = **$11,250.00** (A 7,500.00; K 3,750.00 → redirected **$3,750.00**); poolB **$22,500.00**: A 5,625.00, B 14,062.50, K 2,812.50; credits: A clause A $7,500.00 (7.5 u), A clause B $5,625.00 (5.625 u), B clause B $14,062.50 (14.0625 u), K clause B $2,812.50 (2.8125 u); Σ $30,000.00 |
| CR-2 no funders | same, no fundings | poolA 0; poolB $30,000.00: A **$7,500.00**, B **$18,750.00**, K **$3,750.00** |
| CR-3 new investor funds all | fundings N $60,000 (outsider, not a holder on the due date) | poolA **$15,000.00** all to N (15 u); poolB $15,000.00: A 3,750.00, B 9,375.00, K 1,875.00 |
| CR-4 odd cents | forfeited $12,345.67; unpaidAtForfeiture $24,691.34; fundings A $10,000, N $5,000 | poolA **$3,750.00** (A 2,500.00, N 1,250.00); poolB **$8,595.67**: A **$2,148.92**, B **$5,372.29**, K **$1,074.46**; Σ $12,345.67 |
| CR-5 nobody else | forfeited $30,000, no fundings, `holdersOnDueDate` empty | `blocked` "NO_ELIGIBLE_HOLDERS", no credits |
| SU-1 | default due 2027-01-20, cured 2027-03-10: asOf 2027-01-20 / 01-21 / 03-09 / 03-10 | false / true / true / false |
| SU-2 | VOIDED default | false for every date |
| CU-1 | balance 0, interest 0, costs 0, lastReductionBy MEMBER | cured, `PAID_IN_FULL` |
| CU-2 | balance 0 by RF, forfeiture confirmed, credit not confirmed | not cured |
| CU-3 | balance 0 by RF, forfeiture and credit confirmed, interest 256.44 still owed | cured, `REPLACEMENT_FUNDED` |
| CU-4 | balance 15,000 | not cured |

**Acceptance**: all rows pass.

---

### E5 — Library: Management Fee, Available Cash, term clock

**Goal**: R20–R25, R41, R42. **Prerequisites**: E1. **Create**: `src/lib/llc/management-fee.ts`, `available-cash.ts`, `term.ts`, tests `management-fee.test.ts`, `available-cash.test.ts`, `term.test.ts`. There is deliberately **no barrel file** in `src/lib/llc` (parallel packages would collide on it): consumers import by module, e.g. `import { runWaterfall } from "@/lib/llc/waterfall"`.

```ts
// management-fee.ts
export interface RevenueMonth { month: IsoDate /* first of month */; customerReceipts: Cents; passThroughFees: Cents; otherIncome: Cents; assetSaleProceeds: Cents; insuranceProceeds: Cents; managementFee: Cents }
export function grossRevenue(m: Pick<RevenueMonth, "customerReceipts" | "passThroughFees">): Cents;   // receipts − fees (may be negative)
export function managementFeeForMonth(gross: Cents, bps: number): Cents;                              // roundDiv(gross × bps, 10_000)
export function managementFeeSummary(months: readonly RevenueMonth[], feePayments: readonly { paidOn: IsoDate; amount: Cents }[], range: { from: IsoDate; to: IsoDate }):
  { accruedInRange: Cents; paidInRange: Cents; accruedToDate: Cents; paidToDate: Cents; unpaid: Cents }; // "toDate" = through range.to; a month is in range when its first day is in [from, to]

// available-cash.ts
export interface CashLedger {
  months: readonly RevenueMonth[];
  expenses: readonly { on: IsoDate; amount: Cents; fundingSource: "OPERATING_CASH" | "CAPITAL_CONTRIBUTIONS"; category: string; countsTowardOrgCap: boolean }[];
  reserves: readonly { on: IsoDate; kind: string; type: "ESTABLISH" | "RELEASE"; amount: Cents; fundingSource: "OPERATING_CASH" | "CAPITAL_CONTRIBUTIONS"; releaseTo: "OPERATING_CASH" | "CAPITAL_CONTRIBUTIONS" | null }[];
  defaultIncome: readonly { on: IsoDate; amount: Cents }[];               // interest + costs collected from Defaulting Members
  loanPayments: readonly { on: IsoDate; principal: Cents; interest: Cents; fundingSource: "OPERATING_CASH" | "CAPITAL_CONTRIBUTIONS" }[];
  loanProceeds: readonly { on: IsoDate; amount: Cents }[];               // member loans received (go to the capital pool)
  distributions: readonly { on: IsoDate /* periodEnd */; type: "OPERATING" | "RETURN_OF_UNUSED_CAPITAL" | "SALE_OR_LIQUIDATION"; gross: Cents }[]; // finalized, unreversed
  capitalReceived: readonly { on: IsoDate; amount: Cents }[];            // every receipt except kind CREDIT (a BALANCE receipt created by a distribution offset counts: that cash stayed in the LLC as capital)
}
export interface AvailableCashResult {
  asOf: IsoDate;
  inflows: { grossRevenue: Cents; otherIncome: Cents; assetSaleProceeds: Cents; insuranceProceeds: Cents; defaultIncome: Cents };
  outflows: { operatingExpenses: Cents; managementFee: Cents; loanService: Cents };
  reservesFromOperatingCash: Cents;      // net balance
  priorDistributions: Cents;
  raw: Cents;                            // may be negative
  availableCash: Cents;                  // max(0, raw)
}
export function computeAvailableCash(l: CashLedger, asOf: IsoDate): AvailableCashResult;                // R20
export function reserveBalances(reserves: CashLedger["reserves"], asOf: IsoDate):
  { byKind: Map<string, { operating: Cents; capital: Cents; total: Cents }>; operating: Cents; capital: Cents; total: Cents }; // R21; a RELEASE larger than the pool balance → throw OVER_RELEASE
export function computeUnusedCapital(l: CashLedger, asOf: IsoDate):
  { capitalReceived: Cents; loanProceeds: Cents; spentFromCapital: Cents; reservesFromCapital: Cents; returned: Cents; loanServiceFromCapital: Cents; unusedCapital: Cents };
export function orgExpenseCapStatus(i: { counted: Cents; cap: Cents; approvedIncrease: Cents; adding?: Cents }):
  { counted: Cents; limit: Cents; remaining: Cents; wouldExceed: boolean };                             // R23
export function loanAccruedInterest(i: { principalOutstandingSegments: readonly { from: IsoDate; to: IsoDate; principal: Cents }[]; bps: number }): Cents; // simple, /365, rounded once
```
`computeAvailableCash` (normative): a month counts when its **last** day ≤ `asOf`; dated rows count when `on ≤ asOf`. With
- `opReserve = Σ ESTABLISH(fundingSource OPERATING_CASH) − Σ RELEASE(fundingSource OPERATING_CASH)`, `capReserve` likewise for `CAPITAL_CONTRIBUTIONS`,
- `crossToOperating = Σ RELEASE(fundingSource CAPITAL_CONTRIBUTIONS, releaseTo OPERATING_CASH)`, `crossToCapital = Σ RELEASE(fundingSource OPERATING_CASH, releaseTo CAPITAL_CONTRIBUTIONS)` (`releaseTo` null = same as `fundingSource`),
- `priorDistributions = Σ gross of OPERATING and SALE_OR_LIQUIDATION`,

`raw = grossRevenue + otherIncome + assetSaleProceeds + insuranceProceeds + defaultIncome + crossToOperating − operatingExpenses − managementFee − loanService(OPERATING_CASH) − crossToCapital − opReserve − priorDistributions`. Add `crossToOperating` to `inflows` and `crossToCapital` to `outflows` in the result type; `reservesFromOperatingCash = opReserve`.

`computeUnusedCapital`: `unusedCapital = capitalReceived + loanProceeds − spentFromCapital − capReserve − returned − loanServiceFromCapital − crossToOperating + crossToCapital`, where `spentFromCapital` = Σ expenses with `fundingSource = CAPITAL_CONTRIBUTIONS` and `returned` = Σ gross of `RETURN_OF_UNUSED_CAPITAL`. Member-loan proceeds are not Available Cash (§1.15 lists its sources; §6.18 excludes "Member advances") and sit in the capital pool.

```ts
// term.ts
export interface TermInput { operationsCommencementDate: IsoDate | null; extensionsApproved: number /* EFFECTIVE TERM_EXTENSION resolutions */; loiExtensionDays: number }
export interface TermClock {
  operationsCommencementDate: IsoDate | null;
  ocdNoticeDueOn: IsoDate | null;            // addBusinessDays(ocd, 10)
  baseTargetSaleDate: IsoDate | null;        // addYears(ocd, 5)
  extendedTargetSaleDate: IsoDate | null;    // base + 1 year per extension
  effectiveTargetSaleDate: IsoDate | null;   // extended + loiExtensionDays
  extensionRequestDueOn: IsoDate | null;     // addMonths(extendedTargetSaleDate, −9)
  nextExtensionTargetSaleDate: IsoDate | null; // addYears(extendedTargetSaleDate, 1)
  loiExtensionMaxDate: IsoDate | null;       // addDays(extendedTargetSaleDate, 180)
  dissolutionElectionAvailableAfter: IsoDate | null; // addDays(effectiveTargetSaleDate, 180)
  extensionsApproved: number;
}
export function computeTermClock(i: TermInput, cfg): TermClock;                     // R41; loiExtensionDays outside 0..max → throw
export function consentDeemedAgainstOn(requestSentOn: IsoDate, cfg): IsoDate;       // addDays(requestSentOn, 30)
export function isBeforeTargetSaleDate(d: IsoDate, clock: TermClock): boolean | null; // null when no OCD
export function distributionDeadline(quarterEnd: IsoDate, cfg): IsoDate;            // R42: addDays(quarterEnd, 45)
export function quarterlyDeadlines(from: IsoDate, to: IsoDate, cfg): { quarterEnd: IsoDate; deadline: IsoDate; label: string }[]; // every quarter end in [from, to]; label "Q1 2027"
```

**Tests**:

| Id | Input | Expect |
|---|---|---|
| MF-1 | receipts $48,250.00, fees $7,237.50 | gross **$41,012.50**; fee 2,050.625 → **$2,050.63** |
| MF-2 | receipts $51,900.40, fees $7,785.06 | gross $44,115.34; fee 2,205.767 → **$2,205.77** |
| MF-3 | receipts $39,875.25, fees $5,981.29 | gross $33,893.96; fee 1,694.698 → **$1,694.70** |
| MF-4 | receipts $1,000.00, fees $1,200.00 | gross −$200.00; fee **−$10.00** |
| MF-5 | gross $0.10 / $0.29 / $0.30 | $0.01 / $0.01 / $0.02 |
| MF-6 | summary: months Apr–Jun 2027 = MF-1..3; payment $5,951.10 on 2027-07-20; range 2027-04-01..2027-06-30 | accruedInRange **$5,951.10**; paidInRange 0; unpaid **$5,951.10**; range ..2027-09-30 with no new months → paidToDate 5,951.10, unpaid 0 |
| AC-1 | months Apr–Jun 2027 as MF-1..3 with other income $312.45 in June; expenses (operating) $38,400.00 dated in the quarter; expense (capital) $31,000.00; reserves: ESTABLISH MINIMUM_OPERATING $50,000 from CAPITAL 2027-02-01, ESTABLISH EQUIPMENT_REPAIR_AND_REPLACEMENT $15,000 from OPERATING 2027-06-30; asOf 2027-06-30 | grossRevenue **$119,021.80**; otherIncome $312.45; operatingExpenses $38,400.00; managementFee $5,951.10; reservesFromOperatingCash $15,000.00; raw = availableCash = **$59,983.15** |
| AC-2 | AC-1 + distribution OPERATING gross $59,983.15 (periodEnd 2027-06-30) + Q3 months totalling gross revenue $100,000.00, fees accrued $5,000.00, operating expenses $30,000.00, RELEASE EQUIPMENT_REPAIR_AND_REPLACEMENT $5,000 from OPERATING on 2027-09-30; asOf 2027-09-30 | availableCash **$70,000.00** |
| AC-3 | AC-1 with operating expenses $200,000.00 | raw = 119,021.80 + 312.45 − 200,000.00 − 5,951.10 − 15,000.00 = **−$101,616.85**; availableCash **$0.00** |
| AC-4 | AC-1 asOf 2027-05-31 (June not complete; reserve and other income dated in June excluded; expenses of $38,400.00 dated 2027-04-15) | grossRevenue 85,127.84 − expenses 38,400.00 − fee 4,256.40 = **$42,471.44** |
| RB-1 | reserves of AC-1, asOf 2027-06-30 | MINIMUM_OPERATING total $50,000.00 (capital); total **$65,000.00**; operating $15,000.00 |
| RB-2 | RELEASE $20,000 from OPERATING when the operating pool holds $15,000 | throws `OVER_RELEASE` |
| UC-1 | capitalReceived $450,000.00; capital expenses $31,000.00 + equipment $300,000.00; reserve from capital $50,000.00; returned 0 | unusedCapital **$69,000.00** |
| OC-1 | counted $31,000.00, cap $40,000.00, adding $8,000.00 | remaining $9,000.00; `wouldExceed` false |
| OC-2 | adding $9,000.01 | `wouldExceed` true |
| OC-3 | counted $40,000.00, approvedIncrease $10,000.00, adding $5,000.00 | limit $50,000.00; `wouldExceed` false |
| TC-1 | OCD 2027-02-15, no extensions, LOI 0 | ocdNoticeDueOn **2027-03-01**; base = extended = effective **2032-02-15**; extensionRequestDueOn **2031-05-15**; loiExtensionMaxDate **2032-08-13**; dissolutionElectionAvailableAfter **2032-08-13**; next extension 2033-02-15 |
| TC-2 | `extensionsApproved: 1` | extended 2033-02-15; extensionRequestDueOn **2032-05-15** |
| TC-3 | TC-1 + LOI 120 days | effective **2032-06-14**; dissolutionElectionAvailableAfter **2032-12-11**; extensionRequestDueOn still 2031-05-15 |
| TC-4 | OCD 2028-02-29 | base **2033-02-28** |
| TC-5 | OCD null | every date null |
| TC-6 | `consentDeemedAgainstOn("2031-05-01")` | 2031-05-31 |
| DL-1 | `distributionDeadline` for 2027-03-31 / 06-30 / 09-30 / 12-31 | 2027-05-15 / 2027-08-14 / 2027-11-14 / 2028-02-14 |
| DL-2 | `quarterlyDeadlines("2027-01-01","2027-12-31")` | 4 rows, labels "Q1 2027"…"Q4 2027" |

(AC-4 arithmetic: 41,012.50 + 44,115.34 = 85,127.84; fees 2,050.63 + 2,205.77 = 4,256.40. AC-2 arithmetic: 59,983.15 − 59,983.15 + 100,000.00 − 5,000.00 − 30,000.00 + 5,000.00 = 70,000.00.)

**Acceptance**: all rows pass; no module in `src/lib/llc` imports from outside the folder.

---

### E6 — Registry wiring and router stubs (no schema)

**Goal**: every economics edit to a shared registry in one package so later packages never touch shared files. **Prerequisites**: F0 (the economics tables of section C exist), F1 (its registry edits are merged; this package appends after them).

**Modify** (append-only; do not reorder or remove existing entries)
1. `src/server/audit/schema.ts`: append to the `action` enum, exactly:
   `"llcTerm.updated"`, `"llcTerm.ocd-set"`, `"llcTerm.books-reopened"`, `"bankAccount.created"`, `"bankAccount.deleted"`, `"callNotice.created"`, `"callNotice.updated"`, `"callNotice.cancelled"`, `"callNotice.sent"`, `"callNotice.payment-recorded"`, `"memberDefault.declared"`, `"memberDefault.voided"`, `"memberDefault.charge-added"`, `"memberDefault.funding-recorded"`, `"memberDefault.payment-recorded"`, `"memberDefault.forfeiture-confirmed"`, `"memberDefault.credit-confirmed"`, `"memberDefault.cured"`, `"revenuePeriod.saved"`, `"expense.created"`, `"expense.reversed"`, `"managerPayment.created"`, `"managerPayment.reversed"`, `"reserve.established"`, `"reserve.released"`, `"reserve.reversed"`, `"memberLoan.created"`, `"memberLoan.payment-recorded"`, `"memberAdvance.created"`, `"memberAdvance.repaid"`, `"distribution.draft-saved"`, `"distribution.draft-deleted"`, `"distribution.finalized"`, `"distribution.reversed"`, `"distribution.notices-sent"`, `"distribution.exported"`, `"distribution.line-paid"`.
   Append to the `target.type` enum: `"llcTerm"`, `"bankAccount"`, `"callNotice"`, `"memberDefault"`, `"revenuePeriod"`, `"expense"`, `"managerPayment"`, `"reserve"`, `"memberLoan"`, `"memberAdvance"`, `"distribution"`. If another plan already added a value with the same string, keep one copy.
   Audit rows are JSON: summaries contain formatted dollars (`formatCents`), never a `bigint`.
2. `src/lib/rbac/subjects.ts`: append `"capital-calls"`, `"distributions"`, `"llc-financials"`, `"llc-terms"`. Run `tsc`; if `src/components/modals/role-create-update-modal.tsx` or `src/lib/rbac/rbac.test.ts` has an exhaustive label map, add labels "Capital calls", "Distributions", "LLC financials", "LLC terms".
3. `src/trpc/api/root.ts`: register `llcTerm`, `callNotice`, `memberDefault`, `llcFinancials`, `distribution`, `llcEconomics`.

**Create**
- Stub routers, each `export const <name>Router = createTRPCRouter({});` — `src/trpc/routers/llc-term/router.ts` (`llcTermRouter`), `call-notice/router.ts` (`callNoticeRouter`), `member-default/router.ts` (`memberDefaultRouter`), `llc-financials/router.ts` (`llcFinancialsRouter`), `distribution/router.ts` (`distributionRouter`), `llc-economics/router.ts` (`llcEconomicsRouter`).
- `src/trpc/routers/llc-shared/schema.ts` (re-exports FOUNDATION's validators under the names used in this plan):
  ```ts
  import { z } from "zod";
  import { ZCents } from "@/lib/money";
  import { ZDateOnly } from "@/lib/date-only";
  export const zIsoDate = ZDateOnly;                    // "YYYY-MM-DD"
  export const zCents = ZCents;                         // integer cents as a JS number, ≥ 0
  export const zPositiveCents = ZCents.min(1);
  export const zUnits = z.string().regex(/^\d+(\.\d{1,6})?$/);
  export const zId = z.string().min(1).max(64);
  export const zMemo = z.string().trim().max(2000);
  ```

**RBAC mapping used by all later packages** (ADMIN has all automatically):

| Subject | read | create | update | delete |
|---|---|---|---|---|
| `capital-calls` | view notices, defaults | create/send notices, record payments, declare default, record funding/charges | confirm forfeiture, credit, cure | cancel draft, void default |
| `distributions` | view | create draft | finalize, mark paid, send notices | delete draft, reverse |
| `llc-financials` | view | add rows, save revenue month | — | reverse rows |
| `llc-terms` | view | — | edit term, OCD, LOI extension, reopen books | — |

**Acceptance**: the six routers appear in `AppRouter`; `prisma/enums.ts` (generated by F0) contains `DistributionTypeEnum` — if it does not, stop and report that F0 did not include section C; the four verification commands pass; `git diff --stat` shows no file outside this package's list. **Do not touch**: `prisma/**`.

---

### E7 — Server core: term service, ledger loader, positions, LLC term page

**Goal**: one place that turns database rows into library inputs; wire conversion; the term clock page. **Prerequisites**: E2, E3, E4, E5, E6, F2 (settings slot), F6 (`getMemberPositions`), and GOVERNANCE's `Resolution` and `UnitTransfer` models present in the generated Prisma client (F0 creates all three areas' tables, so this should always hold). Check first: if `db.resolution` or `db.unitTransfer` does not exist, **stop and report** — do not stub them.

**Create** (all `import "server-only"` except `*.logic.ts` and `wire.ts`; files listed below plus `clock.logic.ts`, `clock.logic.test.ts`, `wire.test.ts`, `ledger.logic.ts`, `ledger.logic.test.ts`, and the shared display helpers). **Modify**: `src/server/llc/commitments.ts` (the `companyToday` line only, see `clock.ts`), `src/trpc/routers/llc-economics/router.ts` and `src/trpc/routers/llc-term/router.ts` (E6 stubs), `[publicId]/settings/llc/page.tsx` (slot only).

`src/server/llc/economics/wire.ts` (pure, relative imports, tested)
```ts
export type Wire<T> = /* T with every bigint replaced by number, except under keys containing "units" (any case), which become 6-dp strings */;
export function toWire<T>(value: T): Wire<T>;
```
Rules: recursive over plain objects, arrays, `Map` (becomes a plain object keyed by the map keys, which must be strings) and `Set` (becomes an array); a Prisma `Decimal` (any object with `toFixed` and `d`/`e`/`s` fields, or `Prisma.Decimal.isDecimal(v)`; check this before the plain-object case) → `unitsToWire(v)` (6-dp string), whatever its key (`DistributionLine.preferredUnits`/`commonUnits`, `MemberDefault.unitsBefore`/`unitsAfter`, `MemberDefaultCredit.units`); a `bigint` under a key that contains `units` case-insensitively (`/units/i`: `units`, `preferredUnits`, `commonUnits`, `unitsBefore`, `unitsAfter`, `unitsHeld`, `unitsValued`, `totalUnits`) → `microUnitsToDecimalString` (no cents field in this plan has such a name — keep it that way; `perPreferredUnit` is cents and does not match); any other `bigint` → `Number(v)` after checking `|v| ≤ Number.MAX_SAFE_INTEGER` (else throw `RangeError`); `Date` objects, strings, numbers, booleans, `null` pass through. Every tRPC query and mutation in E7–E19 returns `toWire(...)`; every `zCents` input is converted with `numberToCents`, every `zUnits` input with `microUnitsFromDecimal`. Tests (`wire.test.ts`): `toWire({ amount: 123456n, preferredUnits: 40000000n, lines: [{ gross: 5n, units: 10n }] })` → `{ amount: 123456, preferredUnits: "40.000000", lines: [{ gross: 5, units: "0.000010" }] }`; `toWire({ unitsBefore: 40000000n, unitsAfter: 10000000n, perPreferredUnit: 79384n })` → `{ unitsBefore: "40.000000", unitsAfter: "10.000000", perPreferredUnit: 79384 }`; `toWire({ byKind: new Map([["WIND_DOWN", { total: 5n }]]) })` → `{ byKind: { WIND_DOWN: { total: 5 } } }`; `toWire({ preferredUnits: new Prisma.Decimal("40.2") })` → `{ preferredUnits: "40.200000" }` (in the test, use a stand-in object `{ d: [], e: 0, s: 1, toFixed: (n) => "40.200000" }` if importing Prisma breaks the relative-import rule); `2n ** 60n` under `amount` throws.

`src/server/llc/economics/clock.logic.ts` (pure, relative imports only, tested in `clock.logic.test.ts`)
```ts
export function resolveEconomicsToday(i: { nodeEnv: string | undefined; override: string | undefined; timeZone: string; now: Date }): IsoDate;
  // i.nodeEnv !== "production" && isIsoDate(i.override ?? "") → i.override (test clock for local verification only);
  // otherwise todayInTimeZone(i.timeZone, i.now) (import it relatively: "../../../lib/date-only"). The override is ignored in production builds.
```
`src/server/llc/economics/clock.ts` (`server-only`): a one-line wrapper
```ts
export function economicsToday(timeZone: string, now: Date = new Date()): IsoDate;
  // = resolveEconomicsToday({ nodeEnv: process.env.NODE_ENV, override: process.env.LLC_ECONOMICS_TODAY, timeZone, now })
```
(The test targets `clock.logic.ts` because vitest has no config: `@/` imports do not resolve in tests and the `server-only` package is not installed, see `src/server/llc/__integration__/register.mjs`.)
Every "today" in economics server code comes from this function (never `new Date()` directly), so the dated acceptance checks below can be run locally with `LLC_ECONOMICS_TODAY=2027-01-14 pnpm dev`.

**Modify** `src/server/llc/commitments.ts` (FOUNDATION's file), one line only: in `companyToday` (currently `return todayInTimeZone(company.timezone);`) return `economicsToday(company.timezone)` instead (import from `@/server/llc/economics/clock`; drop the `todayInTimeZone` import if it becomes unused). Without this, FOUNDATION's "cannot be in the future" checks (`validateCashReceipt`, `validateAcceptance`, `validateSpecialReceipt`) use the real date and refuse every receipt, acceptance, forfeiture and credit dated under the test clock. Nothing else in that file changes in E7.

`src/server/llc/economics/suspension.ts` — `getSuspendedUnits(tx, companyId, asOf)` (signature in section E.2), delivered here so GOVERNANCE's record snapshots wait only for this package. `suspended`: stakeholders with a `MemberDefault` for which `isSuspended({ status, dueOn, curedOn }, asOf)` is true, with their Preferred units from `getMemberPositions(tx, companyId, { asOf })` (rows with `kind === "PREFERRED"`, `microUnitsFromDecimal(row.units)`) — not from `getPositions`, so GOVERNANCE record snapshots work even before the price per unit is set (FOUNDATION B20). `undeclaredOverdue`: `CallNoticeLine` rows with `status = SENT`, `dueOn < asOf`, no `MemberDefault`, and outstanding > 0, where outstanding = `amountCalledCents` − Σ net `CallNoticeAllocation.amountCents` of the line (computed here with two queries; both tables are empty until E9 is used). GOVERNANCE combines this with FOUNDATION's `getMemberPositions`; a record date is inclusive (a default suspends only when `dueOn < asOf`).

`src/server/llc/economics/scope.ts`
```ts
export async function lockCompanyLedger(tx: PrismaTransactionalClient, companyId: string): Promise<void>;
  // await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`llc-economics:${companyId}`}))`;
  // VERIFY in this package with a throwaway script against the local database that the pg driver adapter accepts the `void` result;
  // if it throws, use tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked`.
export function notFound(what: string): never;        // TRPCError NOT_FOUND
export function conflict(message: string): never;     // TRPCError CONFLICT — a confirmed proposal no longer matches
export function ruleViolation(message: string): never; // TRPCError BAD_REQUEST — message names the OA section where one applies
export function actorFrom(ctx): { userId: string; memberId: string | null; name: string; requestIp: string; userAgent: string }; // the `actor` FOUNDATION's F6 services take
```
Tenant rule for every procedure in E7–E19: `withLlcAccessControl` (non-LLC → FORBIDDEN); rows are read with `findFirst({ where: { id: input.id, companyId } })` (→ `notFound`), lists with `where: { companyId }`; stakeholder, document, commitment, receipt and unit-class ids from the client go through `assertCompanyOwns` (`stakeholderIds`, `documentIds`, `commitmentIds`, `capitalReceiptIds`, `unitClassIds`); bank-account ids are checked with `findFirst({ where: { id, companyId } })`. Every mutation that writes a ledger row calls `lockCompanyLedger` first inside its transaction.

`src/server/llc/economics/term.ts`
```ts
export async function getOrCreateLlcTerm(tx, companyId): Promise<LlcTerm>;       // upsert on companyId with replacementFunderOutsideDate 2027-06-30 and the column defaults
export function buildConfig(term: LlcTerm, preferred: UnitClass): LlcEconomicsConfig;
  // pricePerUnitCents (null → ruleViolation "Set the price per unit on the Preferred unit class"), fractionalUnitsAllowed, prefReturnBps,
  // dayCountBasis 365 for ACTUAL_365, residualPreferredBps = preferred.residualSplitBps, balanceReturnStartRule,
  // finalClosingDate / balanceOutsideDate via toDateOnly (null stays null), everything else from LlcTerm with these conversions:
  //   defaultOffsetOrder: BALANCE_INTEREST_COSTS → ["BALANCE","INTEREST","COSTS"], COSTS_INTEREST_BALANCE → ["COSTS","INTEREST","BALANCE"];
  //   businessDays: { holidays: term.holidayCalendar, saturdayObservedOnFriday: term.saturdayHolidayObservedFriday, extraHolidays: term.extraHolidays.map(toDateOnly) };
  //   replacementFunderOutsideDate: toDateOnly(term.replacementFunderOutsideDate); minimumOperatingReserveCents and orgExpenseCapCents are already bigint
export async function getEconomicsContext(tx, company: { id: string; timezone: string }): Promise<{ term: LlcTerm; config: LlcEconomicsConfig; today: IsoDate; preferredClass: UnitClass; commonClass: UnitClass | null }>;
  // today = economicsToday(company.timezone); no PREFERRED UnitClass → ruleViolation
export function requireOutsideDate(config: LlcEconomicsConfig): IsoDate;        // null → ruleViolation("Enter the Balance outside date (Section 4.9) on the Preferred unit class first.")
export function assertBooksOpen(term: LlcTerm, date: IsoDate): void;           // date ≤ booksClosedThrough → ruleViolation("Books are closed through …")
export async function assertLedgerDateOpen(tx, companyId, date: IsoDate): Promise<void>;
  // ruleViolation if a FINALIZED, non-reversal distribution exists with paymentDate > date (same day is allowed)
export async function closeBooksThrough(tx, companyId, date: IsoDate): Promise<void>;   // booksClosedThrough = max(current, date)
export async function countTermExtensions(tx, companyId): Promise<number>;              // tx.resolution.count({ where: { companyId, type: "TERM_EXTENSION", status: "EFFECTIVE" } })
export async function getTermClock(tx, companyId): Promise<TermClock>;                  // computeTermClock({ operationsCommencementDate, extensionsApproved: countTermExtensions, loiExtensionDays })
```

`src/server/llc/economics/transfers.ts`: `export async function loadCompletedTransfers(tx, companyId): Promise<{ id: string; effectiveOn: IsoDate; fromStakeholderId: string; toStakeholderId: string; units: MicroUnits; createdAt: Date }[]>` — `tx.unitTransfer.findMany({ where: { companyId, status: "COMPLETED", unitClassKind: "PREFERRED", effectiveOn: { not: null }, toStakeholderId: { not: null } }, orderBy: [{ effectiveOn: "asc" }, { createdAt: "asc" }] })` (GOVERNANCE model, `03-governance.md` C2). The same file exports `applyUnitTransfer(tx, input)` with GOVERNANCE's signature (section E.2): it converts `effectiveOn` with `toDateOnly`, calls `assertLedgerDateOpen`, loads `getMemberPositions(tx, companyId, { asOf: effectiveOn, unitClassId: input.unitClassId })` (FOUNDATION B20; works for Preferred and Common transfers alike) and throws `ruleViolation` when the transferor's `units` (`microUnitsFromDecimal`) are fewer than `input.units`; it writes nothing.

`src/server/llc/economics/ledger.ts`
```ts
export interface LoadedLedger {
  events: LedgerEvent[];                       // Preferred class only, seq assigned
  holders: Map<string, { stakeholderId: string; name: string; isInsider: boolean; memberStatus: string; noticeEmail: string | null }>;
  commonUnits: Map<string, MicroUnits>;        // stakeholderId → Common Units as of the requested date; set by getPositions from getMemberPositions (kind COMMON), never summed from receipts here
  cashCapital: { on: IsoDate; amount: Cents }[]; // appliedCents of non-void INITIAL / BALANCE / REPLACEMENT receipts (cash that became capital)
  lastEventOn: IsoDate | null;
}
export async function loadLedger(tx, companyId, config: LlcEconomicsConfig): Promise<LoadedLedger>;
export async function getPositions(tx, companyId: string, asOf: IsoDate, opts?: { untilSeq?: number }):
  // loads Company.timezone itself (company.findFirst({ where: { id: companyId }, select: { id, timezone } })) and calls getEconomicsContext
  Promise<{ ledger: LoadedLedger; positions: PositionsResult; waterfallHolders: WaterfallHolder[]; config: LlcEconomicsConfig }>;
```
Query shapes (each `where: { companyId }`, sequential inside a transaction):
1. `stakeholder.findMany` select `id, name, institutionName, isInsider, memberStatus, noticeEmail, email`.
2. `unitClass.findMany`; `commitment.findMany` select `id, stakeholderId, unitClassId, acceptedCents, status, isReplacement`.
3. `capitalReceipt.findMany({ where: { companyId, voidedAt: null, appliedOn: { not: null } }, orderBy: [{ appliedOn: "asc" }, { createdAt: "asc" }] })`.
4. `callNoticeAllocation.findMany` → net per (receipt, start date) after reversals.
5. `distribution.findMany({ where: { companyId, status: "FINALIZED", isReversal: false }, include: { lines: true } })` → `DISTRIBUTION` events (`on = paymentDate`).
6. `loadCompletedTransfers` → `TRANSFER` events.
7. `memberDefaultPayment.findMany({ where: { companyId, source: "DISTRIBUTION_OFFSET", capitalReceiptId: { not: null } } })` to know which receipts a distribution created.

Mapping of FOUNDATION receipts (Preferred class): kinds `INITIAL`, `BALANCE`, `REPLACEMENT`, `CREDIT` with `appliedCents > 0` → `ReceiptRow { on: appliedOn, receivedOn, amount: appliedCents, units: microUnitsFromDecimal(unitsToWire(unitsIssued)), prefReturnStartOn: prefReturnStartDate ?? appliedOn }` → `buildCapitalLots` → `CONTRIBUTION` events. Kind `FORFEITURE` → `FORFEITURE` event `{ on: receivedOn, amount: −appliedCents, units: −unitsIssued }`. Receipts on the COMMON class are not read here: `commonUnits` is taken from `getMemberPositions(tx, companyId, { asOf })` rows with `kind === "COMMON"` (`microUnitsFromDecimal(row.units)`); `loadLedger` never sums Common receipts (FOUNDATION B20). Rows with `appliedCents = 0` on the Preferred class are skipped.
**Same-day order** (`seq` = index after this sort): by date; within a date: (1) contributions not created by a distribution, forfeitures, transfers — by `createdAt`, then id; (2) distributions by `number`, each immediately followed by the contributions its offsets created. Accrual pauses (R8): when `accrueOnDefaulterCapital` is false, one window per non-voided default `{ holderId, from: dueOn, to: curedOn }`.
**Cross-check** (FOUNDATION B20: holdings must agree everywhere; skipped when `opts.untilSeq` is given, because FOUNDATION's function has no intra-day cut): `getPositions` also calls `getMemberPositions(tx, companyId, { asOf })` and compares, per Preferred holder, `units` with the engine's `preferredUnits` and `capitalCents` with `contributed`. Compare only rows with `kind === "PREFERRED"`; units via `microUnitsFromDecimal(row.units)`; a stakeholder missing on either side counts as 0 units and 0 capital (Replacement commitments are accepted with no receipts and appear in `getMemberPositions` with 0). Until GOVERNANCE G16 folds transfers into `getMemberPositions` the check throws as soon as any `COMPLETED` `UnitTransfer` exists, so G16 must move capital with the same rounding as R39: `roundDiv(contributed × n, N)`. A difference throws `TRPCError INTERNAL_SERVER_ERROR` "Ledger mismatch for <name>" (it means one of the two readers has a bug or GOVERNANCE has not yet folded a transfer into `getMemberPositions`; do not paper over it). `waterfallHolders` = one row per stakeholder with Preferred or Common Units.

Performance (decision: **computed on read, no stored balances**): ≤ 50 members × ≤ 4 receipts, ≤ 4 distributions a year × ≤ 51 lines → under 3,000 rows after 10 years; a handful of indexed queries + an in-memory fold of a few thousand bigint operations: target < 50 ms per request, no cache. Stored snapshots exist only as evidence inside a finalized `Distribution.snapshot`; they are never read back as balances. Reasons: no drift between ledger and balance, back-dated legal events (forfeiture and credit dates) re-derive correctly, and any as-of date is available for statements and record dates.

`src/trpc/routers/llc-term/router.ts`, `schema.ts`; `src/trpc/routers/llc-economics/router.ts` composed as `createTRPCRouter({ ...positionsProcedures, ...statementProcedures, ...overviewProcedures })` from three files this package creates: `llc-economics/procedures/positions.ts` (the `positions` procedure below), `procedures/statement.ts` (`export const statementProcedures = {};` — filled by E18) and `procedures/overview.ts` (`export const overviewProcedures = {};` — filled by E19), so E18 and E19 never edit the same file.

| Procedure | RBAC | Input | Output / effect | Audit |
|---|---|---|---|---|
| `llcTerm.get` (query) | `llc-terms: read` | — | `{ term: LlcTermDto, clock: TermClock, today, unitClassTerms: { finalClosingDate, balanceOutsideDate, prefReturnBps, residualSplitBps, pricePerUnitCents, fractionalUnitsAllowed, balanceReturnStartRule } (read-only here; edited on FOUNDATION's unit-class page), extensionsApproved: number, economicsLocked: boolean }` (`LlcTermDto` = all columns, dates as `IsoDate`, cents as numbers) | — |
| `llcTerm.update` | `llc-terms: update` | partial object of the Parameters, Interpretation switches and Calendar columns (ints 0..100000; cents `zCents`; `extraHolidays: zIsoDate[]` max 50; `replacementFunderOutsideDate: zIsoDate`) | updates. **Lock**: when `economicsLocked` (any `Distribution` FINALIZED, any `MemberDefault`, or any `CallNoticeLine` SENT) the columns `prefAccrualCutoff`, `accrueOnDefaulterCapital`, `capitalReturnLotOrder`, `forfeiture*`, `replacementCreditBps`, `defaultInterest*`, `defaultOffsetOrder`, `callNoticeBusinessDays`, `forfeitureCureBusinessDays`, `creditDateMaxDays`, `holidayCalendar`, `saturdayHolidayObservedFriday` are rejected with `ruleViolation` (they would rewrite history) | `llcTerm.updated`, summary lists `field: old → new` |
| `llcTerm.setOperationsCommencementDate` | `llc-terms: update` | `{ date: zIsoDate, noticeSentOn: zIsoDate.nullable() }`; `date ≤ today`; cannot change once `extensionsApproved > 0` | sets both columns | `llcTerm.ocd-set` |
| `llcTerm.setLoiExtension` | `llc-terms: update` | `{ days: int 0..loiExtensionMaxDays, loiDocumentId: zId.nullable() }`; requires OCD; `days > 0` requires `loiDocumentId` (checked with `assertCompanyOwns`) | sets columns | `llcTerm.updated` |
| `llcTerm.reopenBooks` | `llc-terms: update` | `{ through: zIsoDate.nullable(), reason: string min 10 }` | sets `booksClosedThrough`; rejected if a FINALIZED non-reversed OPERATING/SALE distribution has `periodEnd > through` (or any exists when `through` is null) | `llcTerm.books-reopened` |
| `llcEconomics.positions` (query) | `distributions: read` | `{ asOf: zIsoDate.optional() }` (default today) | `{ asOf, rows: { stakeholderId, name, isInsider, contributed, unreturned, capitalReturned, forfeited, preferredUnits, commonUnits, preferredPct: string /* pctString */, accruedReturn, returnPaid, unpaidReturn, suspended }[], totals }` | — |

Term extensions are not recorded here: an approved one-year extension is a GOVERNANCE `TERM_EXTENSION` resolution that became `EFFECTIVE`; the clock picks it up through `countTermExtensions`.

**Shared display helpers** (created here because every economics page uses them: E7's own forms, E10, E12, E14, E16, E18): `src/components/llc/money.tsx` (`<Money cents />`, `<Units micro />`, `<IsoDateText date />` — wrappers over FOUNDATION's `formatCents`, `trimUnits`, `formatDateOnly`; cents arrive as numbers, units as 6-dp strings) and `src/components/llc/money-input.tsx` (`NumericFormat` wrapper per the conventions; value in integer cents as a number). Later packages import them and do not modify them.

**Page** `src/app/(authenticated)/(dashboard)/[publicId]/settings/llc-term/page.tsx` (server; `requireLlc()`; gate `["llc-terms","read"]`) with client components in `settings/llc-term/components/`: `term-clock-card.tsx` (table of every `TermClock` date with its OA section and a status badge: done / due in N days / overdue; shows "N extensions approved"), `ocd-form.tsx`, `loi-form.tsx`, `parameters-form.tsx` (grouped: Dates, Parameters, Calendar; the unit-class terms are shown read-only with a link to `/unit-classes`), `switches-form.tsx` (each switch shows the ambiguity sentence from section B and the default; disabled with a tooltip when locked). Model the forms on `src/components/modals/share-class/share-class-form.tsx`. **Modify** `[publicId]/settings/llc/page.tsx` at FOUNDATION's marked slot `{/* ECONOMICS: LlcTerm form goes here */}` only: replace the comment with a `Card` "Term clock and agreement parameters" linking to `/settings/llc-term`. States: no OCD → the clock card shows "Operations Commencement Date not set"; `balanceOutsideDate` null → a warning linking to the unit-class page.

**Tests**: `src/server/llc/economics/ledger.logic.ts` holds the pure parts — `assignSeq(rawEvents)` and `receiptsToEvents(...)` — with `ledger.logic.test.ts` (relative imports): (1) a distribution on 2027-05-14 with an offset-created receipt on the same day and an ordinary receipt on the same day orders ordinary receipt < distribution < offset receipt; (2) Scenario S rows produce the S-0 positions; (3) a `FORFEITURE` receipt row (`appliedCents` −3,000,000, `unitsIssued` −30) becomes the F-1 event; (4) a receipt with `appliedOn` 2026-11-13 and `prefReturnStartDate` 2026-11-12 reproduces PR-10.

**Acceptance**: opening the page for an LLC company creates exactly one `LlcTerm` row (second load creates none); with `LLC_ECONOMICS_TODAY=2027-03-02`, setting OCD 2027-02-15 shows the TC-1 dates and the OCD notice as overdue; with `NODE_ENV=production` the override has no effect (unit test `clock.logic.test.ts` of `resolveEconomicsToday` with both settings); with `LLC_ECONOMICS_TODAY` set outside production, FOUNDATION's commitment pages accept a receipt dated on that test date (the `companyToday` change); the final report to the orchestrator states that the ledger integration script `src/server/llc/__integration__/ledger.integration.ts` (command in its header; needs Postgres, which executors do not have) must be re-run after this package because `commitments.ts` changed, expected result 62/62 passing; a non-LLC company gets FORBIDDEN from every procedure; after FOUNDATION's F6 worked example (commitment $250,000, receipts $100,000 and $150,000) `llcEconomics.positions` shows 250 units, contributed 25000000, and the cross-check passes; `grep -rn "findUnique" src/server/llc/economics src/trpc/routers/llc-term src/trpc/routers/llc-economics` shows only lookups by a `companyId`-scoped unique key.

---

### E8 — Bank accounts: create, list, delete

**Goal**: usable wire instructions (`01-foundation.md` E2.7 assigns this to ECONOMICS). **Prerequisites**: E6, E7 (uses `ruleViolation`, `conflict` and `notFound` from `src/server/llc/economics/scope.ts`). Not LLC-gated (existing feature; procedures keep `withAccessControl`).

**Modify**: `src/trpc/routers/bank-accounts/router.ts`, `src/components/modals/bank-account-modal.tsx`, `[publicId]/settings/bank-accounts/components/table.tsx`, `[publicId]/settings/bank-accounts/page.tsx`. **Create**: `src/trpc/routers/bank-accounts/schema.ts`, `src/server/bank-accounts.ts`.

| Procedure | RBAC | Input | Rules | Audit |
|---|---|---|---|---|
| `bankAccounts.getAll` | `bank-accounts: read` | — | add to the select: `beneficiaryName`, `beneficiaryAddress`, `bankAddress`, `routingNumber`, `accountType`, `swiftCode` | — |
| `bankAccounts.create` | `bank-accounts: create` | `{ beneficiaryName, beneficiaryAddress, bankName, bankAddress (each trimmed 1..200), accountNumber /^[A-Za-z0-9]{4,34}$/, routingNumber /^\d{9}$/, accountType: CHECKING \| SAVINGS, swiftCode /^[A-Z0-9]{8}([A-Z0-9]{3})?$/ optional }` | Because of `@@unique([companyId, primary])`: 0 existing → `primary = true`; 1 existing → `primary = !existing.primary`; 2 existing → `ruleViolation("At most two bank accounts are supported.")`. Duplicate account number → `conflict` | `bankAccount.created` (summary shows only the last 4 digits) |
| `bankAccounts.delete` | `bank-accounts: delete` | `{ id }` | `findFirst({ id, companyId })`; rejected if referenced by a `CallNotice` with status `DRAFT` or `SENT` | `bankAccount.deleted` |

`src/server/bank-accounts.ts`: `getWireInstructions(tx, companyId, bankAccountId): Promise<{ beneficiaryName; beneficiaryAddress; bankName; bankAddress; accountNumber; routingNumber; swiftCode: string | null; accountType }>` (`notFound` if not owned). The existing `BankAccountModal` (already registered; do not edit `src/components/modals/index.ts`) becomes a `react-hook-form` form for the create input; the table lists bank name, beneficiary, masked account (`•••• 1234`), routing number, primary badge, delete button (`src/components/common/confirmDialog.tsx`).

**Acceptance**: create two accounts, third is rejected; table shows both; no account number appears unmasked in the audit log.

---

### E9 — Call Notices: backend and email

**Goal**: R26–R29. **Prerequisites**: E7, E8, F6 (receipt services), F10 (logged `sendMail`).

**Create**: `src/server/llc/economics/call-notices.ts`, `call-notices.logic.ts` (+ `.test.ts`), `receipt-guards.ts`, `src/trpc/routers/call-notice/schema.ts`, `src/emails/llc/CallNoticeEmail.tsx`. **Modify**: `src/trpc/routers/call-notice/router.ts`; `src/server/llc/commitments.ts` (FOUNDATION's file — add exactly the two guard calls described under "Receipt guards" and delete F6's marker comment `// ECONOMICS E9 adds its ledger-date guard here (decided commitments).`; nothing else; E7's `companyToday` change is already there).

`call-notices.ts`
```ts
export interface CommitmentState { commitmentId; stakeholderId; name; noticeEmail: string | null;
  acceptedCents: Cents /* Commitment.acceptedCents, already net of replacement funding */; replacementFunded: Cents /* Σ MemberDefaultFunding on this commitment's defaults */;
  initialPaid: Cents /* Σ appliedCents of INITIAL receipts */; balance: Cents /* acceptedCents − initialPaid */; calledTotal: Cents /* Σ amountCalled of lines of SENT/SETTLED notices */;
  uncalled: Cents /* uncalledBalance({ acceptedCommitment: acceptedCents + replacementFunded, initialPaid, calledTotal }) */;
  balancePaid: Cents /* Σ appliedCents of BALANCE receipts */; prepaidUnallocated: Cents /* balancePaid − Σ net allocations */; totalPaid: Cents; remainingCommitment: Cents /* acceptedCents − totalPaid */ }
export async function getCommitmentStates(tx, companyId): Promise<CommitmentState[]>;   // Preferred commitments with status ACCEPTED or REDUCED and isReplacement = false
export interface LineState { lineId; callNoticeId; stakeholderId; commitmentId; amountCalled: Cents; allocated: Cents; replacementFunded: Cents; outstanding: Cents; dueOn: IsoDate | null; status; overdue: boolean; memberDefaultId: string | null }
export async function getLineStates(tx, companyId, today: IsoDate, filter?: { callNoticeId?: string; commitmentId?: string }): Promise<LineState[]>;
  // outstanding = amountCalled − Σ net allocations − Σ fundings of its MemberDefault; overdue = status SENT && dueOn < today && outstanding > 0
```

Procedures (`callNotice.*`; all LLC-gated):

| Procedure | RBAC | Input | Effect | Audit |
|---|---|---|---|---|
| `list` (query) | `capital-calls: read` | — | notices with `number, kind, status, sentAt, lineCount, totalCalled, totalOutstanding, earliestDueOn, overdueCount` | — |
| `get` (query) | read | `{ id }` | notice + `LineState[]` joined with member names + wire instructions (masked account) | — |
| `eligible` (query) | read | — | `{ states: CommitmentState[], outsideDate, today, proposedDueOn: IsoDate \| null (callNoticeDueDate(today), null after the outside date), bankAccounts: { id, bankName, last4, primary }[], sendBlockedReason: string \| null (the mail-catcher message when `send` would refuse) }` | — |
| `saveDraft` | create | `{ id?: zId, purpose: zMemo.optional(), bankAccountId: zId, lines: { commitmentId: zId, amountCalledCents: zPositiveCents }[] (1..200, unique commitmentId) }` | create (`number = max + 1` under the lock, kind `CALL`) or replace the lines of a `DRAFT`. Each `amountCalledCents ≤ uncalled`. Bank account owned | `callNotice.created` / `.updated` |
| `cancelDraft` | delete | `{ id, reason }` | `DRAFT` → `CANCELLED` (number is kept) | `callNotice.cancelled` |
| `preview` (query) | read | `{ id, commitmentId }` | `{ subject, html, dueOn }` for that line as if sent now | — |
| `send` | create | `{ id, expectedDueOn: zIsoDate, lineIds: zId[].optional() }` | see below | `callNotice.sent` |
| `createOutsideDateNotice` | create | `{ confirm: z.literal(true) }` | allowed when `today ≥ requireOutsideDate(config)` and no `OUTSIDE_DATE` notice exists; creates a notice kind `OUTSIDE_DATE`, status `SENT`, one line per commitment with `uncalled > 0` (`amountCalled = uncalled`, `dueOn = balanceOutsideDate`, status `SENT`, no email), then applies prepaid matching as in `send` step 5 | `callNotice.sent` |
| `recordPayment` | create | `{ commitmentId, receivedOn: zIsoDate (≤ today), amountCents: zPositiveCents, reference: string max 120 optional, note: string max 500 optional }` | see below | `callNotice.payment-recorded` |
| `overdue` (query) | read | — | `LineState[]` (with member names) where `overdue` is true, each with `forfeitureDate` and `memberDefaultId` | — |

**`send`** (R26, R28): (1) notice must be `DRAFT`, or `SENT` with `UNSENT`/`SEND_FAILED` lines; when `process.env.NODE_ENV === "production"` and FOUNDATION's `isMailCatcherConfigured()` (`src/server/mailer.ts`) is true → `ruleViolation("Email is not configured for real delivery. A Call Notice is effective only when actually sent (Section 4.9). Set EMAIL_SERVER and EMAIL_FROM first.")` (outside production the catcher is allowed so the flow can be tested); `outside = requireOutsideDate(config)`; `today ≤ outside` else `ruleViolation("The Balance is already due under Section 4.9 (March 31, 2027); use 'Record Balance due' instead.")`; a bank account is set; every target line's member has an email (`noticeEmail ?? email`). (2) `dueOn = callNoticeDueDate(today, config)`; `expectedDueOn ≠ dueOn` → `conflict("The due date changed to …; review and confirm again.")`. (3) For each target line, in order of member name: render `CallNoticeEmail` and call `sendMail({ to, subject, html, headers: { "X-From-Name": company.name } }, { kind: "llc.call-notice", companyId, stakeholderId, relatedType: "callNoticeLine", relatedId: line.id })` (FOUNDATION F10; it resolves after the SMTP server accepted the message and returns `{ emailLogId, sentAt }`; it throws on failure) — on a throw set the line `SEND_FAILED` and continue. (4) On success, in one transaction with `lockCompanyLedger`: re-check `amountCalled ≤ uncalled`; set `status = SENT`, `sentAt`, `sentOn = economicsToday(company.timezone, sentAt)`, `dueOn` (the value printed in the email), `sentToEmail`, `emailLogId`. (5) Prepaid matching: take that commitment's unallocated `BALANCE` receipt amounts oldest first and create `CallNoticeAllocation` rows (`source = PREPAID`, `receivedOn` of the receipt, `prefReturnStartOn = config.balanceReturnStartRule === "RECEIPT_DATE" ? receipt.receivedOn : dueOn`) up to the line amount (via `planPrepaidMatch`); when a receipt becomes fully allocated to this one line and the rule is `LATER_OF_RECEIPT_AND_DUE`, also call FOUNDATION's `setReceiptPrefReturnStart(tx, { companyId, receiptId, startDate: dueOn }, actor)` so the default start shown on FOUNDATION's pages agrees (under `RECEIPT_DATE` the receipt already starts on `receivedOn`; do not call it); if the line is fully covered set `PAID`, `paidInFullOn = sentOn`. (6) After the loop: notice `status = SENT`, `sentAt` = first success; return `{ results: { lineId, ok, error? }[], dueOn }`. A notice whose lines are all `PAID` becomes `SETTLED` (also re-evaluated by `recordPayment` and E11).

**`recordPayment`** (R29): inside one transaction with the lock: reject with `ruleViolation("This member has an open default; record the payment on the default page.")` if any line of the commitment has an `OPEN` `MemberDefault`; `amountCents ≤ remainingCommitment` else `ruleViolation("Exceeds the remaining commitment.")`; `planBalancePayment` (below) → FOUNDATION's `recordCapitalReceipt(tx, { companyId, commitmentId, receivedOn, amountCents, reference, note, dueDate: <dueOn of the first allocated line when the plan allocates the whole amount (unallocated = 0); omitted otherwise, so the unallocated remainder keeps FOUNDATION's prepaid start max(receivedOn, balanceOutsideDate) (R28) and every allocated slice carries its own start in CallNoticeAllocation>, sourceType: "callNotice", sourceId: <first allocated line's callNoticeId> }, actor)` (it derives the kind, issues the units, sets `prefReturnStartDate` and writes its own audit row; its guard call runs `assertLedgerDateOpen`) → create `CallNoticeAllocation` rows (`source = PAYMENT`, `capitalReceiptId`) → mark fully paid lines `PAID` with `paidInFullOn = receivedOn` → settle notices. If FOUNDATION derived kind `INITIAL` for the receipt (dated on or before the acceptance date) no allocation is created and the lines stay open. Returns `{ capitalReceiptId, allocations, prepaid: Cents, late: boolean }` (`late` = some allocation has `receivedOn > dueOn`; the UI then suggests declaring a default if interest is to be charged — nothing automatic, R38).

**Receipt guards** (`receipt-guards.ts`; imports only Prisma types and `./scope` — never `commitments.ts`, to avoid an import cycle):
```ts
export async function assertLedgerDateOpenForReceipt(tx, companyId: string, appliedOn: IsoDate): Promise<void>; // = assertLedgerDateOpen (re-implemented here, same rule)
export async function beforeVoidReceipt(tx, companyId: string, receiptId: string, actorMemberId: string | null): Promise<void>;
```
`beforeVoidReceipt`: `ruleViolation` when (a) a FINALIZED, non-reversal `Distribution` has `paymentDate ≥` the receipt's `appliedOn` ("Reverse distribution No. N first"; skip check (a) when the receipt's `appliedOn` is null, i.e. a held receipt), or (b) the receipt is referenced by a `MemberDefaultFunding`, a `MemberDefaultCredit`, `MemberDefault.forfeitureReceiptId`, or a not-yet-reversed `MemberDefaultPayment` ("This receipt belongs to a default; it cannot be voided here"); otherwise it writes a negating `CallNoticeAllocation` for every net-positive allocation of the receipt and re-opens the affected `PAID` lines (`status = SENT`, `paidInFullOn = null`) and `SETTLED` notices (`status = SENT`). Neither guard calls `lockCompanyLedger`: they run inside FOUNDATION's unit-class row lock (`lockUnitClass`), and taking the advisory lock there would invert the lock order used by economics flows (advisory lock first, then the unit-class lock inside FOUNDATION's services) and can deadlock. The two edits in `src/server/llc/commitments.ts`: (1) in `recordCapitalReceipt`, immediately before `const receipt = await tx.capitalReceipt.create(` (after both the cash and the special branch have computed `appliedOn`): `if (appliedOn !== null) await assertLedgerDateOpenForReceipt(tx, companyId, dateToWire(appliedOn) as string);` — this covers cash receipts on decided commitments and every special receipt (REPLACEMENT, CREDIT, FORFEITURE); held receipts (`appliedOn` null) are not checked; then delete F6's marker comment `// ECONOMICS E9 adds its ledger-date guard here (decided commitments).`, which sits only in the cash branch and above the `appliedOn` line; (2) in `voidCapitalReceipt`, at F6's marker `// ECONOMICS E9 adds its beforeVoidReceipt guard here.` (after `throwIfErrors(plan.errors)`, before setting `voidedAt`): `await beforeVoidReceipt(tx, companyId, input.receiptId, actor.memberId);`. Known gap, not closed here: `decideCommitment` applies held receipts directly (no `recordCapitalReceipt` call); after the Final Closing only Replacement commitments are decided, and those hold no receipts.

`call-notices.logic.ts` (pure, tested): `planBalancePayment({ amount, receivedOn, openLines, rule })` → `{ allocations, unallocated, firstDueOn: IsoDate | null, receiptDueDate: IsoDate | null /* firstDueOn when unallocated = 0, else null: the dueDate passed to recordCapitalReceipt */ }` (wraps `allocatePaymentToLines`, passing `rule = config.balanceReturnStartRule`); `planPrepaidMatch({ lineAmount, dueOn, rule, prepaidReceipts: { receiptId, receivedOn, unallocated }[] })` → allocations (`prefReturnStartOn = rule === "RECEIPT_DATE" ? receivedOn : dueOn`) plus the ids of receipts that became fully allocated. Tests: CN-6, CN-6r, CN-7 through `planBalancePayment` (CN-6 `receiptDueDate` 2027-01-20; CN-7 `receiptDueDate` null because $10,000 is unallocated, so that remainder starts 2027-03-31 under FOUNDATION's prepaid rule, not 2027-01-25); prepaid: line $30,000 due 2027-01-20, prepaid receipts r1 $20,000 (2026-12-01) and r2 $15,000 (2026-12-10) → r1 $20,000 + r2 $10,000, both start 2027-01-20, r2 keeps $5,000 unallocated (start 2027-03-31); same with `rule = RECEIPT_DATE` → r1 starts 2026-12-01, r2 slice starts 2026-12-10, no `setReceiptPrefReturnStart` ids.

**`CallNoticeEmail`** props `{ companyName, memberName, noticeNumber, sentOnLong, dueOnLong, amountCalled, alreadyReceived, amountDue, committed, paidToDate, remainingAfter, purpose, wire: { beneficiaryName, beneficiaryAddress, bankName, bankAddress, routingNumber, accountNumber, swiftCode }, reference, managerName, managerEmail, isOutsideDate }` (all strings preformatted). Model on `src/emails/ShareUpdateEmail.tsx`. Subject: `Call Notice No. {noticeNumber} – {companyName} – {amountDue} due {dueOnLong}`. Body, in this order:
1. "Dear {memberName},"
2. "This is a Call Notice under Section 4.9 of the Operating Agreement of {companyName}. The Manager has determined that the following part of the Balance of your Capital Contribution is needed. {purpose}"
3. Table: Capital Contribution committed / Paid to date / **Amount called by this notice** / Already received toward this call / **Amount due** / Remaining Balance after this call.
4. "**Payment is due by {dueOnLong}** (three business days after this notice, and in any event not later than March 31, 2027)." — the outside date is printed from `balanceOutsideDate`.
5. "Wire instructions" block with every `wire` field and "Reference: {reference}" where `reference = "{companyName} CN{noticeNumber} {memberName}"` truncated to 80 characters.
6. "Wire instructions will not be changed by email. Before sending funds, confirm these details with the Manager by telephone at a number you already have."
7. "Preferred Units are issued at one Unit per $1,000 when your payment is received. The Preferred Return on this amount accrues from the later of the due date and the date of receipt."
8. "If the amount due is not received in full by the due date, Section 4.9 of the Operating Agreement applies, including interest at 12% per annum from the due date, suspension of voting rights and distributions while the default continues, and, if not cured within five business days after the due date, forfeiture of 50% of the unpaid Balance (up to the amount you have paid)."
9. "Questions: {managerName}, {managerEmail}." Footer: company name only (no "Powered by").
Set `PreviewProps`. Do not add an `X-From-Name` other than the company name.

**Acceptance** (run locally with `LLC_ECONOMICS_TODAY=2027-01-14`, then `2027-01-15` for the second send): sending on 2027-01-14 stores `dueOn = 2027-01-20` on each line and the email shows "Wednesday, January 20, 2027"; a line for a member with $20,000 prepaid on a $30,000 call shows "Already received $20,000.00 / Amount due $10,000.00"; a second `send` with the same `expectedDueOn` on the next day returns CONFLICT; payment of $50,000 against two open lines produces the CN-6 allocations; a $70,000 payment against one $60,000 line (CN-7) creates a receipt whose `prefReturnStartDate` is 2027-03-31 (no `dueDate` passed) and one allocation starting 2027-01-25; a back-dated receipt (cash or special) dated before a FINALIZED distribution's payment date is refused by the guard; no procedure updates or deletes a `CallNoticeAllocation`. Because `commitments.ts` changed, the final report to the orchestrator states that the ledger integration script `src/server/llc/__integration__/ledger.integration.ts` must be re-run (needs Postgres; executors have none), expected result 62/62 passing.

---

### E10 — Call Notices: pages

**Prerequisites**: E9, F2. **Create** under `src/app/(authenticated)/(dashboard)/[publicId]/capital-calls/` (`page.tsx` replaces FOUNDATION's placeholder): `page.tsx`, `new/page.tsx`, `[id]/page.tsx`, `components/notice-table.tsx`, `components/notice-form.tsx`, `components/send-dialog.tsx`, `components/line-table.tsx`, `components/record-payment-dialog.tsx`, `components/outside-date-banner.tsx`. Use the shared display helpers `src/components/llc/money.tsx` and `src/components/llc/money-input.tsx` created by E7 (do not modify them).

- `/capital-calls` (`requireLlc()`; gate `["capital-calls","read"]`, pattern A.2.7): header + "New Call Notice" button (hidden after the outside date); a summary strip (committed, paid, uncalled Balance, called and outstanding, overdue lines); table of notices (No., kind, status badge, sent, due, called, outstanding, overdue count) linking to the detail; a second card "Overdue lines" (from `callNotice.overdue`) listing overdue lines with a link "Review default" (target page comes with E12; until then the link points at the notice detail). Empty state: `EmptyState` "No Call Notices yet". From `balanceOutsideDate` on, if any commitment has uncalled Balance and no `OUTSIDE_DATE` notice exists, `outside-date-banner` explains R27 and offers "Record Balance due on March 31, 2027" (confirm dialog → `createOutsideDateNotice`).
- `/capital-calls/new` and edit of a draft: `notice-form` — select bank account; purpose text; table of every commitment from `eligible` (member, committed, paid, uncalled Balance, prepaid) with a checkbox and an amount input per row; helpers "Call 100% of uncalled Balance" and "Call N% of each uncalled Balance" (N typed; amount = `roundDiv(uncalled × N, 100)`); shows "If sent today the due date is {proposedDueOn}". Rows without an email are disabled with a reason. Save → `saveDraft` → redirect to detail.
- `/capital-calls/[id]`: header with status; `line-table` (member, called, received, replacement-funded, outstanding, due date, status badge: Unsent / Sent / Send failed / Paid / **Overdue** / **In default**); actions: "Preview email" (dialog rendering the `preview` HTML in a sandboxed `iframe srcDoc`), "Send" (`send-dialog`: when `eligible.sendBlockedReason` is set, shows it and disables sending; when FOUNDATION's `emailLog.deliveryStatus.mailCatcher` is true outside production, shows a warning "Test mode: emails go to the mail catcher and are not delivered" but allows sending; lists recipients and the computed due date, requires typing the notice number to confirm, passes `expectedDueOn`; shows per-line results; "Retry failed"), "Record payment" per line (`record-payment-dialog`: date, amount, memo → `recordPayment`; shows the resulting allocations and the late warning), "Cancel draft".

Model tables on `[publicId]/share-classes/table.tsx`, dialogs on `src/components/ui/dialog.tsx`, form on the share-class form. All mutations: `toast` + `router.refresh()`. **Acceptance**: a full pass create → preview → send → record payment works locally against Mailpit (`pnpm email:dev`) with the test-mode warning visible; every page shows `UnAuthorizedState` without the permission; no `Date` object is formatted in the browser for a calendar date.

---

### E11 — Default workflow: backend

**Goal**: R30–R38 as a confirmed-step state machine. **Prerequisites**: E9.

**Create**: `src/server/llc/economics/defaults.ts`, `defaults.logic.ts` (+ test), `src/trpc/routers/member-default/schema.ts`. **Modify**: `src/trpc/routers/member-default/router.ts`.

**State machine** (one `MemberDefault` per `CallNoticeLine`; `D` = `dueOn`):

| State (derived) | Entered by | Dates | What the system computes (proposal) | Manager confirmation writes |
|---|---|---|---|---|
| Overdue, undeclared | automatically visible from `D + 1 day` while outstanding > 0 | — | unpaid at due, would-be Forfeiture Date, replacement window | **`declare`** → row with `dueOn`, `unpaidAtDueCents`, `forfeitureDate` |
| Open, pre-forfeiture | `declare` | interest from `D`; Replacement Funders from `nextBusinessDay(D)` to `replacementFunderOutsideDate`; Forfeiture Date `addBusinessDays(D, 5)` | interest to date, outstanding Balance, costs, cure test | `recordPayment`, `recordFunding`, `addCharge`, `void` |
| Forfeiture due | `today > forfeitureDate` and not cured by payment on or before it | effective on `forfeitureDate` | `ForfeitureProposal` | **`confirmForfeiture`** → stage-2 columns; the ledger gains a `FORFEITURE` event |
| In suspense | forfeiture confirmed | Credit Date per R35 (moves earlier if fully replacement-funded) | `CreditProposal` once `today ≥ creditDate` | **`confirmCredit`** → `CREDIT` receipts + `MemberDefaultCredit` rows + stage-3 columns |
| Credited, still open | credit confirmed, Balance not fully funded/paid | — | interest keeps accruing on the outstanding Balance; offsets in distributions | payments, fundings (until the outside date) |
| Cure available | `cureStatus(...).cured` | `curedOn` = date of the last event that satisfied the condition | method | **`confirmCure`** → `status = CURED` |
| Voided | `void` (only before any funding, payment, or forfeiture confirmation) | — | — | `status = VOIDED` |

Suspension (R32) applies from `D + 1` for every non-voided default until `curedOn`, whether or not later stages are confirmed. Finalizing a distribution is blocked while a non-voided default has `forfeitureDate < paymentDate` without confirmed forfeiture, or confirmed forfeiture with computed `creditDate ≤ paymentDate` without confirmed credit, or a met-but-unconfirmed cure (E15).

`defaults.ts`
```ts
export interface DefaultView {
  id; stakeholderId; memberName; commitmentId; callNoticeLineId; status; dueOn; forfeitureDate; replacementWindow: { opensOn; closesOn };
  unpaidAtDue: Cents; reductions: BalanceReduction[]; outstandingBalance: Cents;
  interestAccrued: Cents; interestPaid: Cents; interestOwed: Cents; costsCharged: Cents; costsPaid: Cents; costsOwed: Cents;
  forfeiture: { confirmed: boolean; available: boolean; proposal: ForfeitureProposal | null };
  credit: { confirmed: boolean; creditDate: IsoDate | null; available: boolean; proposal: CreditProposal | null };
  cure: { cured: boolean; method; curedOn: IsoDate | null; confirmed: boolean };
  suspendedToday: boolean;
  fundings: {...}[]; payments: {...}[]; charges: {...}[]; credits: {...}[];
}
export async function getDefaultView(tx, companyId, memberDefaultId, today: IsoDate, asOf?: IsoDate): Promise<DefaultView>;
export async function getDefaultsOwed(tx, companyId, asOf: IsoDate): Promise<Map<string /* stakeholderId */, DefaultOwed[]>>; // for the distribution run; includes CURED defaults that still owe interest or costs (suspended = false)
export async function getOverdueUndeclared(tx, companyId, today): Promise<{ lineId; stakeholderId; name; dueOn; outstanding: Cents; forfeitureDate: IsoDate }[]>;
```
Reductions: member = net `CallNoticeAllocation` rows on the line with `receivedOn > dueOn` (sources `PAYMENT`, `OFFSET`), dated `receivedOn`; Replacement Funder = `MemberDefaultFunding` rows dated `fundedOn`. `unpaidAtDue = amountCalled − Σ net allocations with receivedOn ≤ dueOn`. `interestAccrued = defaultInterest(…, asOf)`; `interestPaid = Σ MemberDefaultPayment.toInterestCents`; costs likewise from `MemberDefaultCharge` and `toCostsCents`.

`getSuspendedUnits` already exists in `suspension.ts` (E7); this package does not change it.

Procedures (`memberDefault.*`; LLC-gated; every mutation takes the lock and recomputes its proposal inside the transaction — a mismatch with the `expected…` input is `conflict`, R38):

| Procedure | RBAC | Input | Preconditions and effect | Audit |
|---|---|---|---|---|
| `overdue` (query) | `capital-calls: read` | — | `getOverdueUndeclared` | — |
| `list` (query) | read | — | all defaults with headline numbers | — |
| `get` (query) | read | `{ id }` | `DefaultView` | — |
| `declare` | create | `{ callNoticeLineId, expectedUnpaidCents: zPositiveCents }` | line `SENT`, `dueOn < today`, outstanding > 0, no existing default | `memberDefault.declared` |
| `void` | delete | `{ id, reason: min 10 }` | `OPEN`, no fundings, no payments, forfeiture not confirmed | `memberDefault.voided` |
| `addCharge` | create | `{ id, incurredOn (≥ dueOn, ≤ today), amountCents: zPositiveCents, description, documentId? }` | status ≠ `VOIDED` | `memberDefault.charge-added` |
| `recordFunding` | create | `{ id, funderStakeholderId: zId, amountCents: zPositiveCents, fundedOn: zIsoDate, reference?: string }` | `OPEN`; `opensOn ≤ fundedOn ≤ min(today, closesOn)` (R31); `assertLedgerDateOpen(fundedOn)`; amount ≤ `outstandingBalance(asOf fundedOn)`; funder is a stakeholder of the company and not the Defaulting Member. Writes, in this order and inside the procedure's single transaction (R31), through FOUNDATION's F6 services (each writes its own audit row): (0) `reduceAcceptedCommitment(tx, { companyId, commitmentId: <defaulter's>, reduceByCents: amount, reason: "Section 4.9(ii): funded by Replacement Funder" }, actor)` — first, so that accepting the replacement commitment cannot trip FOUNDATION's offering-cap rule (`CAP_EXCEEDED` is not waived for `isReplacement`); (1) `createCommitment(tx, { companyId, stakeholderId: funderStakeholderId, unitClassId: preferredClass.id, committedCents: amount, signedOn: fundedOn, isReplacement: true, notes: "Replacement Funder for <member>, Call Notice No. N" }, actor)`; (2) `decideCommitment(tx, { companyId, commitmentId, decision: "ACCEPT", acceptedCents: amount, acceptedOn: fundedOn, skipClosingDateCheck: true }, actor)` — if this is rejected with `INITIAL_INSTALLMENT_SHORT` or a minimum rule, stop and report to FOUNDATION (its rules must exempt `isReplacement` commitments, §4.9(ii)); do not work around it; (3) `recordCapitalReceipt(tx, { companyId, commitmentId, receivedOn: fundedOn, amountCents: amount, reference, sourceType: "memberDefault", sourceId: id, special: { kind: "REPLACEMENT", appliedCents: amount } }, actor)`; (4) `MemberDefaultFunding` (`funderCommitmentId`, `capitalReceiptId`, `funderIsInsider` snapshot); line → `PAID` if outstanding is 0 | `memberDefault.funding-recorded` |
| `recordPayment` | create | `{ id, paidOn (≤ today), amountCents: zPositiveCents, expected: { toBalanceCents, toInterestCents, toCostsCents } }` | status ≠ `VOIDED`; owed computed as of `paidOn`; split = `applyDefaultOffset(amount, owed, config.defaultOffsetOrder)` with `suspended = (status = OPEN)`; `amount >` total owed → `ruleViolation`. Writes `MemberDefaultPayment` (`CASH`); if `toBalance > 0`: FOUNDATION `recordCapitalReceipt` (cash, `amountCents = toBalance`, `receivedOn = paidOn`, `dueDate = dueOn`, `sourceType: "memberDefault"`) + `CallNoticeAllocation` (`PAYMENT`, start `paidOn`) | `memberDefault.payment-recorded` |
| `confirmForfeiture` | update | `{ id, expectedForfeitedCents: zCents, expectedUnitsAfter: zUnits }` | `OPEN`; not confirmed; `today > forfeitureDate`; not paid in full by the member on or before `forfeitureDate`; `assertLedgerDateOpen(forfeitureDate)`; position = `getPositions(asOf = forfeitureDate)` for the member; `computeForfeiture`; for a member with several defaults, `capitalPaid` already reflects earlier confirmed forfeitures. Writes FOUNDATION `recordCapitalReceipt(tx, { companyId, commitmentId, receivedOn: forfeitureDate, amountCents: 0n, sourceType: "memberDefault", sourceId: id, special: { kind: "FORFEITURE", appliedCents: −forfeited } }, actor)` (this is what reduces units and capital in every reader) and the stage-2 columns (`forfeitedOn = forfeitureDate`, `forfeitureReceiptId`) | `memberDefault.forfeiture-confirmed` |
| `confirmCredit` | update | `{ id, expectedPoolACents: zCents, expectedPoolBCents: zCents }` | forfeiture confirmed; credit not confirmed; `creditDate` computed from current reductions; `today ≥ creditDate`; `assertLedgerDateOpen(creditDate)`; fundings with `fundedOn ≤ creditDate`; `holdersOnDueDate` = `getPositions(asOf = dueOn)` holders with `preferredUnits > 0` except the defaulter; proposal not `blocked`; Preferred class has `fractionalUnitsAllowed = true`. For each credit: FOUNDATION `recordCapitalReceipt(tx, { companyId, commitmentId, receivedOn: creditDate, amountCents: 0n, sourceType: "memberDefault", sourceId: id, special: { kind: "CREDIT", appliedCents: amount } }, actor)` on the holder's commitment (the funding's `funderCommitmentId` for clause A; the holder's oldest `ACCEPTED`/`REDUCED` Preferred commitment for clause B; if a credited holder has no `ACCEPTED`/`REDUCED` Preferred commitment — e.g. a transferee who holds Preferred Units only through a GOVERNANCE `UnitTransfer` — throw `ruleViolation("{name} holds Preferred Units only by transfer; record a commitment for them first (Section 4.9(iv)).")` before writing anything, because `CapitalReceipt.commitmentId` is required and FOUNDATION accepts a CREDIT only on an active commitment) + `MemberDefaultCredit` (`units` = the receipt's `unitsIssued`); stage-3 columns | `memberDefault.credit-confirmed` |
| `confirmCure` | update | `{ id, expectedCuredOn: zIsoDate }` | `OPEN`; `cureStatus` cured; writes `status = CURED`, `curedOn`, `cureMethod` | `memberDefault.cured` |

`defaults.logic.ts` (pure): `buildReductions(allocations, fundings, dueOn)`, `curedOnDate(...)`; test with the worked case below.

**Worked case (integration test data for `defaults.logic.test.ts` and the manual acceptance run)** — Scenario S but C never pays its $60,000 call (sent 2027-01-14, due 2027-01-20); A funds $30,000 on 2027-01-25; K (insider, 50 units since 2026-11-20, i.e. $50,000 received then) funds $15,000 on 2027-02-01:
- Declared 2027-01-21: `unpaidAtDue` $60,000.00, Forfeiture Date 2027-01-27, window 2027-01-21..2027-06-30.
- Forfeiture (confirmed on or after 2027-01-28, effective 2027-01-27): FF-1 → forfeited **$30,000.00**, C's units 40 → 10, extinguished $381.37.
- Credit Date: not fully funded → **2027-02-19**; proposal = CR-1 (A $13,125.00 → 13.125 units; B $14,062.50; K $2,812.50); receipts dated 2027-02-19.
- Interest owed by C on 2027-02-19: I-3 **$256.44**; outstanding Balance **$15,000.00**; C's `acceptedCents` 100,000 − 45,000 = **$55,000.00** (reduced through `reduceAcceptedCommitment`); two Replacement Funder commitments exist (A $30,000, K $15,000); not cured (CU-4). `isSuspended` true from 2027-01-21.
- Units after the credit: A 100 + 30 + 13.125 = **143.125**; B 250 + 14.0625 = **264.0625**; K 50 + 15 + 2.8125 = **67.8125**; C **10**; total **485** (= $485,000 of capital: 390,000 initial + 50,000 K + 45,000 replacement; the forfeited $30,000 moved, it was not added).

**Acceptance** (run locally by stepping `LLC_ECONOMICS_TODAY` through 2027-01-14, 01-21, 01-25, 01-28, 02-01, 02-19): the worked case reproduces through the procedures with those numbers; `confirmForfeiture` before 2027-01-28 is rejected; `recordFunding` dated 2027-01-20 or 2027-07-01 is rejected; a changed proposal (e.g. a funding recorded in another tab) makes the confirmation return CONFLICT; no procedure auto-declares or auto-confirms anything.

---

### E12 — Default workflow: pages

**Prerequisites**: E10, E11. **Create** `[publicId]/capital-calls/defaults/page.tsx`, `[publicId]/capital-calls/defaults/[id]/page.tsx`, and `capital-calls/defaults/components/`: `overdue-table.tsx`, `default-table.tsx`, `default-timeline.tsx`, `declare-dialog.tsx`, `funding-dialog.tsx`, `default-payment-dialog.tsx`, `charge-dialog.tsx`, `forfeiture-dialog.tsx`, `credit-dialog.tsx`, `cure-dialog.tsx`. **Modify**: `capital-calls/page.tsx` (link the "Overdue lines" card to `/capital-calls/defaults`), `capital-calls/components/line-table.tsx` (link the "In default" badge).

- `/capital-calls/defaults`: "Overdue, not declared" table with a "Declare default" button per row (dialog shows OA §4.9 consequences and the computed unpaid amount, Forfeiture Date and replacement window; requires typing the member's name); table of defaults (member, due date, outstanding Balance, interest owed, costs owed, stage badge, next action and its date).
- `/capital-calls/defaults/[id]`: header numbers (unpaid at due, outstanding, interest owed, costs owed, suspended yes/no); `default-timeline` — vertical list: Due date → Replacement window opens → Forfeiture Date → Credit Date (computed, marked "may move earlier") → Replacement Funder outside date, each with done / pending state; cards for fundings, payments, charges, credits; action buttons enabled exactly when the corresponding `DefaultView` flag is true. Each confirm dialog prints the proposal with its arithmetic (e.g. "50% × $60,000.00 = $30,000.00; cap $40,000.00 (Capital Contributions paid); Forfeited Amount $30,000.00; Preferred Units 40 → 10; accrued Preferred Return extinguished $381.37") and the OA sentence it applies, and has a required checkbox "I have reviewed this computation" before the confirm button. The credit dialog lists every credit row (holder, clause, amount, units) and shows redirected insider amounts explicitly.

**Acceptance**: the E11 worked case can be executed end to end from the UI; the forfeiture button is disabled with the tooltip "Available after January 27, 2027" before then; blocked credit (CR-5) shows "No eligible holders on the due date — consult counsel" and no confirm button.

---

### E13 — Financials: backend

**Goal**: R20–R25 data entry and the Available Cash summary. **Prerequisites**: E7.

**Create**: `src/server/llc/economics/financials.ts`, `financials.logic.ts` (+ test), `src/trpc/routers/llc-financials/schema.ts`, `src/trpc/routers/llc-financials/procedures/{revenue,expense,manager-payment,reserve,loan,advance,summary}.ts`. **Modify**: `src/trpc/routers/llc-financials/router.ts` (nested routers: `createTRPCRouter({ revenue: createTRPCRouter({...}), expense: …, managerPayment: …, reserve: …, loan: …, advance: …, summary })`).

`financials.ts`
```ts
export async function loadCashLedger(tx, companyId): Promise<CashLedger>;
  // months ← RevenuePeriod; expenses ← ExpenseEntry (reversal rows included, they are negative); reserves ← ReserveEntry (a reversal row is emitted as the opposite type with a positive amount);
  // defaultIncome ← MemberDefaultPayment (toInterest + toCosts, on = paidOn, net of reversals); loanPayments ← MemberLoanPayment; loanProceeds ← MemberLoan (on = madeOn);
  // distributions ← FINALIZED non-reversal rows (on = periodEnd for OPERATING / SALE_OR_LIQUIDATION, paymentDate for RETURN_OF_UNUSED_CAPITAL; gross = amountCents);
  // capitalReceived ← LoadedLedger.cashCapital (appliedCents of non-void INITIAL / BALANCE / REPLACEMENT receipts; receipts created by a distribution offset count: that cash stayed in the LLC as capital)
export async function getFinancialSummary(tx, companyId, asOf: IsoDate): Promise<FinancialSummary>;
export async function getOrgCapStatus(tx, companyId, adding?: Cents): Promise<ReturnType<typeof orgExpenseCapStatus> & { entries: {...}[] }>;
export async function getTaxAdvancesOutstanding(tx, companyId): Promise<Map<string, Cents>>; // Σ MemberAdvance − Σ MemberAdvanceRecovery per stakeholder (net of reversals)
export async function getLoanStates(tx, companyId, asOf): Promise<{ loanId; lenderStakeholderId; principalOutstanding: Cents; accruedInterest: Cents; interestPaid: Cents; maturityOn: IsoDate; pastMaturity: boolean }[]>;
```
`FinancialSummary = { asOf, availableCash: AvailableCashResult, unusedCapital, reserves: ReturnType<typeof reserveBalances>, fee: { quarter: {...}, toDate: {...} }, orgCap, loans, advancesOutstanding: Cents, booksClosedThrough: IsoDate | null }`.

Common rules: every dated write calls `assertBooksOpen(term, date)`; dates ≤ today; reversal = new row, same date fields as today (`today` must pass `assertBooksOpen`), negated amount, `reverses…Id` set, original must not already be reversed; all LLC-gated; RBAC subject `llc-financials` (`read` for queries, `create` for new rows and revenue save, `delete` for reversals).

| Procedure | Input | Rules | Audit |
|---|---|---|---|
| `revenue.list` (q) | `{ year: int 2020..2100 }` | 12 rows (missing months returned with zeros and `saved: false`), each with `grossRevenue`, `managementFeeCents`, `locked` (month end ≤ `booksClosedThrough`) | — |
| `revenue.save` | `{ month: zIsoDate (day must be 01), customerReceiptsCents, passThroughFeesCents, otherIncomeCents, assetSaleProceedsCents, insuranceProceedsCents: zCents each, utilizationBps: int 0..10000 nullable, notes }` | month ≤ current month; last day of month must pass `assertBooksOpen`; upsert on `(companyId, month)`; `managementFeeBps = term.managementFeeBps`; `managementFeeCents = managementFeeForMonth(receipts − fees, bps)` | `revenuePeriod.saved` (summary: month, gross revenue, fee) |
| `expense.list` (q) | `{ from, to }` | rows + totals by category and funding source | — |
| `expense.create` | `{ incurredOn, category, payee (1..200), amountCents: zPositiveCents, fundingSource (default: `CAPITAL_CONTRIBUTIONS` for `ORGANIZATIONAL_OFFERING` and `EQUIPMENT_ACQUISITION`, else `OPERATING_CASH`), countsTowardOrgCap (default: category = `ORGANIZATIONAL_OFFERING`), memo, documentId?, resolutionId? }` | `countsTowardOrgCap` + `EQUIPMENT_ACQUISITION` → reject (R23); if counted and `getOrgCapStatus(adding).wouldExceed` and no `resolutionId` → `ruleViolation("Exceeds the $40,000 cap in Section 6.21; a Preferred Supermajority approval is required.")`; `fundingSource = CAPITAL_CONTRIBUTIONS` requires amount ≤ unused capital | `expense.created` |
| `expense.reverse` | `{ id, reason: min 5 }` | — | `expense.reversed` |
| `managerPayment.list` (q) | `{ from, to }` | rows + totals by category | — |
| `managerPayment.create` | `{ paidOn, payee, payeeStakeholderId?, amountCents: zPositiveCents, category, memo, documentId?, resolutionId?, countsTowardOrgCap: boolean, expense: { category, fundingSource, countsTowardOrgCap } \| null }` | `MANAGEMENT_FEE`: `expense` must be null, `countsTowardOrgCap` false, amount ≤ unpaid fee through the last complete month ("accrued monthly and paid quarterly": never pay ahead of accrual). `EXPENSE_REIMBURSEMENT` / `PURCHASING_AGENT_PASS_THROUGH`: `expense` required (so the cost reaches Available Cash or unused capital exactly once); the linked `ExpenseEntry` is created in the same transaction (`incurredOn = paidOn`, same amount, `managerPaymentId` set, `payee` = payee) under the `expense.create` rules, and the payment's own `countsTowardOrgCap` is stored false. `OTHER`: `expense` optional; without it `countsTowardOrgCap` may be true and then the cap rule applies to the payment | `managerPayment.created` |
| `managerPayment.reverse` | `{ id, reason }` | also reverses the linked `ExpenseEntry` | `managerPayment.reversed` |
| `managerPayment.capStatus` (q) | — | `getOrgCapStatus` | — |
| `reserve.list` / `reserve.balances` (q) | `{ asOf? }` | ledger; balances by kind and pool; `minimumRequired`, `minimumMet` | — |
| `reserve.establish` | `{ effectiveOn, kind, amountCents: zPositiveCents, fundingSource, reason: min 5 }` | `OPERATING_CASH`: amount ≤ `computeAvailableCash(asOf = effectiveOn).raw` (cannot reserve cash that is not there); `CAPITAL_CONTRIBUTIONS`: amount ≤ unused capital | `reserve.established` |
| `reserve.release` | `{ effectiveOn, kind, amountCents, fundingSource (pool released from), releaseTo? (default = fundingSource), reason, allowBelowMinimum: boolean }` | amount ≤ that kind's balance in that pool; `MINIMUM_OPERATING` may not drop below `minimumOperatingReserveCents` unless `allowBelowMinimum` (wind-down) | `reserve.released` |
| `reserve.reverse` | `{ id, reason }` | resulting balances must stay ≥ 0 | `reserve.reversed` |
| `loan.list` (q) | — | loans + `getLoanStates(today)` | — |
| `loan.create` | `{ lenderStakeholderId, principalCents: zPositiveCents, interestBps: int 0..5000, madeOn, maturityOn (> madeOn), noteDocumentId: zId (required, §4.6), resolutionId: zId.nullable(), notes }` | `resolutionId` null requires `notes` min 10 describing the Preferred Supermajority approval; ids checked | `memberLoan.created` |
| `loan.recordPayment` | `{ memberLoanId, paidOn, principalCents: zCents, interestCents: zCents, fundingSource }` | principal ≤ outstanding; principal + interest > 0 | `memberLoan.payment-recorded` |
| `advance.list` (q) | — | advances, recoveries, outstanding per member | — |
| `advance.create` | `{ stakeholderId, paidOn, kind, amountCents: zPositiveCents, jurisdiction?, taxYear?, memo, documentId? }` | — | `memberAdvance.created` |
| `advance.recordRepayment` | `{ stakeholderId, recoveredOn, amountCents: zPositiveCents }` | amount ≤ outstanding; source `CASH_REPAYMENT` | `memberAdvance.repaid` |
| `summary` (q) | `{ asOf? }` | `getFinancialSummary` | — |

Tests (`financials.logic.test.ts`, pure mappers `toCashLedger(rows)`): rows equivalent to AC-1 → `availableCash` $59,983.15; an expense of $500.00 and its reversal → net 0; a reserve ESTABLISH $15,000 and its reversal row → balance 0; MF-6 through `managementFeeSummary`.

**Acceptance**: the AC-1 data entered through the procedures gives `summary.availableCash.availableCash = 5998315n`; a ninth organizational expense that takes the counter from $39,000 to $41,000 is rejected without a `resolutionId` and accepted with one; saving a month on or before `booksClosedThrough` is rejected; a `MANAGEMENT_FEE` payment larger than the unpaid accrual is rejected.

---

### E14 — Financials: pages

**Prerequisites**: E13, F2 (the four sub-pages `revenue`, `manager-payments`, `reserves`, `loans-advances` replace FOUNDATION's placeholders; `page.tsx`, `expenses/page.tsx` and `layout.tsx` are new — the sidebar has no entry for Summary and Expenses, they are reached through the tab bar). **Create** under `[publicId]/financials/`: `layout.tsx` (tab bar: Summary, Revenue, Expenses, Manager payments, Reserves, Loans & advances — model on `[publicId]/settings/layout.tsx`), `page.tsx`, `revenue/page.tsx`, `expenses/page.tsx`, `manager-payments/page.tsx`, `reserves/page.tsx`, `loans-advances/page.tsx`, and `components/` with one table and one dialog per ledger (`revenue-grid.tsx`, `expense-table.tsx`, `expense-dialog.tsx`, `manager-payment-table.tsx`, `manager-payment-dialog.tsx`, `org-cap-card.tsx`, `reserve-table.tsx`, `reserve-dialog.tsx`, `loan-table.tsx`, `loan-dialog.tsx`, `loan-payment-dialog.tsx`, `advance-table.tsx`, `advance-dialog.tsx`, `available-cash-card.tsx`, `reverse-dialog.tsx`). Gate every page with `["llc-financials","read"]`.

- **Summary**: `available-cash-card` prints the R20 formula line by line with the numbers (inflows, outflows, reserves from operating cash, prior distributions, raw, Available Cash), an "Unused capital" card (UC breakdown), reserve balance vs. the $50,000 minimum, Management Fee accrued / paid / unpaid (quarter and to date), §6.21 cap bar, loans outstanding, tax advances outstanding, "Books closed through".
- **Revenue**: year selector; 12-row grid (month, customer receipts, pass-through fees, Gross Revenue, Management Fee 5%, other income, asset-sale proceeds, insurance proceeds, utilization %), edit per row in a dialog; locked rows show a lock icon. Help text above the grid, verbatim: "Enter cash actually received from customers in the month. Enter marketplace commissions, platform fees and payment-processing fees in 'Pass-through fees' — do not also enter them as expenses. If a marketplace pays you net of its fees, enter the net amount as receipts and 0 as fees. Interest, asset-sale and insurance proceeds are not part of Gross Revenue and carry no Management Fee."
- **Expenses**, **Manager payments**, **Reserves**, **Loans & advances**: date-range filter (default: current quarter), table, "Add" dialog, "Reverse" action (reason required); reversal rows and reversed rows are shown struck through with a "reversed" badge. The Manager-payment dialog shows the linked-expense section per the E13 rules and the live cap status; category `PURCHASING_AGENT_PASS_THROUGH` shows the note "Purchase-order approvals (Section 6.16(i)) are recorded under Governance; link the resolution if one exists." The reserves page states the R21 release rule and the pool each balance sits in.

**Acceptance**: every write path of E13 is reachable; amounts are typed as dollars and shown with `<Money>`; a locked month cannot be opened for edit.

---

### E15 — Distributions: draft, compute, finalize, reverse

**Goal**: R7, R9–R21, R25, R40. **Prerequisites**: E11, E13.

**Create**: `src/server/llc/economics/distributions.ts`, `distributions.logic.ts` (+ test), `src/trpc/routers/distribution/schema.ts`, `src/trpc/routers/distribution/procedures/core.ts` (the procedures below) and `procedures/delivery.ts` (`export const deliveryProcedures = {};` — filled by E17). **Modify**: `src/trpc/routers/distribution/router.ts` → `createTRPCRouter({ ...coreProcedures, ...deliveryProcedures })`.

Shapes (cents are `bigint` in server memory; on the wire and inside the `Json` columns `inputs` and `snapshot` they are numbers — store `toWire(...)` output):
```ts
export type DistributionInputs =
  | { type: "OPERATING" }
  | { type: "RETURN_OF_UNUSED_CAPITAL"; amountCents: number }
  | { type: "SALE_OR_LIQUIDATION"; liquidation: null }                                   // sale proceeds already entered as RevenuePeriod.assetSaleProceeds; amount = Available Cash
  | { type: "SALE_OR_LIQUIDATION"; liquidation: { cashAvailableCents: number; windDownReserveCents: number;
      creditors: { payee: string; amountCents: number; memo: string; managerCategory: "MANAGEMENT_FEE" | "EXPENSE_REIMBURSEMENT" | null }[]; isFinal: boolean } };
export interface ComputedLine { stakeholderId: string; name: string; isInsider: boolean; preferredUnits: MicroUnits; commonUnits: MicroUnits;
  unpaidReturnBefore: Cents; unreturnedBefore: Cents; tierC: Cents; tierD: Cents; tierEPreferred: Cents; tierECommon: Cents; gross: Cents;
  offsets: OffsetApplication[]; defaultOffsetBalance: Cents; defaultOffsetInterest: Cents; defaultOffsetCosts: Cents; taxAdvanceOffset: Cents; net: Cents;
  unpaidReturnAfter: Cents; unreturnedAfter: Cents }
export interface DistributionComputation { type; periodEnd: IsoDate; paymentDate: IsoDate; returnMeasuredAsOf: IsoDate;
  availableCash: AvailableCashResult | null; unusedCapital: Cents | null;
  liquidation: { cash: Cents; creditors: Cents; memberLoans: Cents; windDownReserve: Cents; netToMembers: Cents } | null;
  amount: Cents; tierC: Cents; tierD: Cents; tierEPreferred: Cents; tierECommon: Cents; totalDefaultOffset: Cents; totalTaxOffset: Cents; totalNet: Cents;
  reserveBalance: Cents; lines: ComputedLine[]; blockers: { code: string; message: string }[]; warnings: { code: string; message: string }[]; hash: string }
```

`distributions.logic.ts` (pure, relative imports): `buildComputation(i: { inputs; periodEnd; paymentDate; today; config; positionsAtPayment: PositionsResult; positionsAtCutoff: PositionsResult; commonUnits; holderMeta; cashLedger: CashLedger; defaultsOwed: Map<string, DefaultOwed[]>; taxAdvances: Map<string, Cents>; loanStates; pendingDefaultSteps: string[]; overdueUndeclared: number; lastLedgerEventOn: IsoDate | null; booksClosedThrough: IsoDate | null; revenueMonthsSaved: IsoDate[]; requiredFromMonth: IsoDate | null; deadline: IsoDate | null }): Omit<DistributionComputation, "hash">` and `canonicalForHash(c): string` (JSON of `{ type, periodEnd, paymentDate, amount, lines: [{ stakeholderId, tierC, tierD, tierEPreferred, tierECommon, defaultOffsetBalance, defaultOffsetInterest, defaultOffsetCosts, taxAdvanceOffset, net }] }` with every bigint written as a decimal digit string, lines sorted by `stakeholderId`). The server computes `hash = sha256(canonicalForHash)` hex with `node:crypto`.

Computation rules:
1. **Positions**: `positionsAtPayment = computePositions(events, paymentDate)` gives `unreturned`, units; `unpaidReturn` comes from `positionsAtCutoff` = same when `prefAccrualCutoff = PAYMENT_DATE`, else `computePositions(events, periodEnd)` (a holder absent there has 0) (R7). `defaultsOwed` is computed as of `paymentDate`.
2. **Amount**: `OPERATING` and non-liquidation `SALE_OR_LIQUIDATION` → `computeAvailableCash(cashLedger, periodEnd).availableCash`, waterfall mode `FULL`. `RETURN_OF_UNUSED_CAPITAL` → `amountCents`, mode `D_ONLY` (R13). Liquidation → `liquidationWaterfall` with `creditors = Σ creditors`, `memberLoans = Σ (principalOutstanding + accruedInterest)` as of `paymentDate` (R40).
3. **Lines**: `runWaterfall` over all holders with Preferred or Common Units (R11, R19); then `netDistributionLine` per holder (R16–R18); `…After` = before − tier.
4. **Blockers** (finalize refuses while any exists): `TERMS_INCOMPLETE` (`balanceOutsideDate` or `pricePerUnitCents` missing on the Preferred unit class); `DEFAULT_EXCESS_HELD` (a suspended default would be paid in full by this run's offset while its cure still needs a forfeiture or credit confirmation — §4.9(iii) pays the excess only "when the default is cured"; confirm the pending step, or wait for the Credit Date, then recompute); `AMOUNT_ZERO` (amount = 0); `PERIOD_END_NOT_MONTH_END` (OPERATING / non-liquidation SALE); `PAYMENT_BEFORE_PERIOD_END`; `PAYMENT_BEFORE_LEDGER_EVENT` (`paymentDate < lastLedgerEventOn`, which includes earlier distributions); `PAYMENT_TOO_FAR_AHEAD` (`paymentDate > addDays(today, 14)`); `PERIOD_CLOSED` (OPERATING / SALE with `periodEnd < booksClosedThrough`); `MISSING_REVENUE_MONTH` (OPERATING / SALE: every month from `requiredFromMonth` — the month of the Operations Commencement Date, or the earliest saved month if no OCD — through the month of `periodEnd` must be saved); `MIN_RESERVE` (OPERATING / non-liquidation SALE: `MINIMUM_OPERATING` balance at `periodEnd` < minimum, R21); `LOAN_PAST_MATURITY` (non-liquidation: any loan with `maturityOn ≤ paymentDate` and principal outstanding, R25); `PENDING_DEFAULT_STEP` (E11); `EXCEEDS_UNUSED_CAPITAL` / `EXCEEDS_UNRETURNED_CAPITAL` (return of unused capital); `INSUFFICIENT_FOR_CREDITORS`; `NO_UNITS_IN_CLASS`.
5. **Warnings**: `OVERDUE_UNDECLARED` (overdue Call Notice lines without a declared default — their holders are paid normally); `DEADLINE_PASSED` (`paymentDate > deadline`); `NEGATIVE_RAW_CASH`; `OCD_NOT_SET`; `RETURN_NOT_PERIOD_END` (cutoff switch is `PERIOD_END`).

Procedures (`distribution.*`, LLC-gated):

| Procedure | RBAC | Input | Effect | Audit |
|---|---|---|---|---|
| `list` (q) | `distributions: read` | — | all rows (drafts, finalized, reversed, reversals) with totals; plus `nextDeadline` (R42) | — |
| `get` (q) | read | `{ id }` | row + lines (joined names) + parsed snapshot | — |
| `saveDraft` | create | `{ id?, type, periodStart?: zIsoDate, periodEnd, paymentDate, inputs (validated per type with `zCents`; stored as received), notes }` | create or update a `DRAFT` | `distribution.draft-saved` |
| `deleteDraft` | delete | `{ id }` | hard-delete a `DRAFT` (the only delete in economics) | `distribution.draft-deleted` |
| `compute` (q) | read | `{ id }` | `DistributionComputation` for a `DRAFT` (loads ledger, cash ledger, defaults, advances, loans) | — |
| `finalize` | update | `{ id, expectedHash: string, solvencyConfirmed: z.literal(true) }` | below | `distribution.finalized` |
| `reverse` | delete | `{ id, reason: min 10 }` | below | `distribution.reversed` |

**`finalize`** — one transaction, `{ timeout: 30_000, maxWait: 10_000 }`:
1. `lockCompanyLedger`; load the `DRAFT`; recompute; any blocker → `ruleViolation` listing the blocker messages; `hash ≠ expectedHash` → `conflict("Figures changed since review")`.
2. Update the `Distribution`: `status = FINALIZED`, `number = max(number) + 1`, all frozen totals, `reserveBalanceCents`, `solvencyConfirmed`, `finalizedAt/ById`, `snapshot = toWire({ computation, config, positionsBefore })`.
3. `createMany` `DistributionLine` rows (one per holder, including zero lines).
4. For each `OffsetApplication` with any amount: `MemberDefaultPayment` (`source = DISTRIBUTION_OFFSET`, `paidOn = paymentDate`, `distributionLineId`); if `toBalance > 0`: FOUNDATION `recordCapitalReceipt(tx, { companyId, commitmentId, receivedOn: paymentDate, amountCents: toBalance, dueDate: dueOn, note: "Distribution No. N withheld under Section 4.9(iii)", sourceType: "distribution", sourceId: distribution.id }, actor)` (the Distribution row is already `FINALIZED` with `paymentDate` equal to the receipt date, which the ledger-date guard allows) and a `CallNoticeAllocation` (`source = OFFSET`, start `paymentDate`); mark the line `PAID` when outstanding reaches 0.
5. For each `taxAdvanceOffset > 0`: `MemberAdvanceRecovery` (`DISTRIBUTION_OFFSET`).
6. Liquidation only: one `MemberLoanPayment` per loan (principal outstanding + accrued interest, `distributionId`); one `ManagerPayment` per creditor row with a `managerCategory` (`paidOn = paymentDate`); if `windDownReserveCents > 0` and the `WIND_DOWN` balance is lower, a `ReserveEntry` `ESTABLISH` for the difference from `OPERATING_CASH`.
7. `OPERATING` / `SALE_OR_LIQUIDATION`: `LlcTerm.booksClosedThrough = max(current, periodEnd)`.
8. Audit with summary "Distribution No. N finalized: $X gross, $Y net to N members".
Cure of a default paid in full by offset is **not** written here; the default page shows "Cure available" (R38) — the excess was already paid in this run per R17.

**`reverse`**: allowed only for the highest-numbered `FINALIZED` non-reversal distribution; rejected if any `MemberDefault` touched by its offsets has had forfeiture, credit or cure confirmed after `finalizedAt`, or if any `CapitalReceipt` it created has since been allocated or reversed. Writes, in one locked transaction: original `status = REVERSED` + `reversedAt`, `reversedById`, `reversalReason`; a new `Distribution` (`isReversal = true`, `reversesDistributionId`, `status = FINALIZED`, next `number`, same type/dates, all totals negated) with negated lines; reversal rows for every `MemberDefaultPayment`, `MemberAdvanceRecovery`, `MemberLoanPayment`, `ManagerPayment`, `ReserveEntry` created in steps 4–6; then FOUNDATION `voidCapitalReceipt(tx, { companyId, receiptId, reason: "Distribution No. N reversed: " + reason }, actor)` for each receipt created in step 4 (its `beforeVoidReceipt` guard passes because the distribution is already `REVERSED` and the payments are reversed, and it writes the negating `CallNoticeAllocation` rows). `booksClosedThrough` is not changed (use `llcTerm.reopenBooks` if the period's figures must be corrected). The ledger loader ignores `REVERSED` and reversal rows, so balances return to the state before the run.

**Tests** (`distributions.logic.test.ts`):

| Id | Setup | Expect |
|---|---|---|
| DR-1 | Scenario S; OPERATING, periodEnd 2027-03-31, paymentDate 2027-05-14; cash ledger with `availableCash` $12,000.00; B has a tax advance outstanding $2,500.00 | amount $12,000.00; lines = W-1; B `taxAdvanceOffset` $2,500.00, net **$4,441.08**; A net $2,889.43; C net $2,169.49; M $0.00; `unpaidReturnAfter` A **$1,033.86**, B **$2,483.58**, C **$776.26**; totalNet **$9,500.00**; no blockers |
| DR-2 | DR-1 without the advance; C has `DefaultOwed { suspended: true, balance 15,000.00, interest 256.44, costs 0 }` | C: `defaultOffsetBalance` **$2,169.49**, net $0.00; totalNet **$9,830.51**; planned offset receipt $2,169.49 = 2.16949 units |
| DR-3 | RETURN_OF_UNUSED_CAPITAL $45,000.00, positions = W-4 inputs, unused capital $69,000.00 | lines = W-4; `tierC` 0 |
| DR-4 | same with unused capital $40,000.00 | blocker `EXCEEDS_UNUSED_CAPITAL` |
| DR-5 | liquidation: cash $1,050,000.00, creditors [$25,899.48 trade, $4,100.52 `MANAGEMENT_FEE`], loans $20,000.00, reserve 0; positions = W-3 inputs | netToMembers $1,000,000.00; lines = W-3 |
| DR-6 | DR-1 with `MINIMUM_OPERATING` balance $40,000.00 | blocker `MIN_RESERVE` |
| DR-7 | DR-1 with paymentDate 2027-03-30 | blocker `PAYMENT_BEFORE_PERIOD_END` |
| DR-8 | DR-1 with February 2027 revenue month missing and OCD 2027-01-15 | blocker `MISSING_REVENUE_MONTH` |
| DR-9 | `canonicalForHash` of DR-1 computed twice with holders supplied in different order | identical strings |
| DR-10 | DR-1; C has `DefaultOwed { suspended: true, balance 0, interest 100.00, costs 0 }` and `cureNeedsConfirmation: true` (fully replacement-funded, credit not yet confirmed) | blocker `DEFAULT_EXCESS_HELD` |

**Acceptance**: finalize writes exactly one line per holder and Σ `grossCents` = `amountCents`; a second finalize of the same draft fails (`status` no longer `DRAFT`); after `reverse`, `llcEconomics.positions` equals its value before the run; `grep -nE "distributionLine\.(update|delete)" src/server src/trpc -r` matches only the E17 operational-column update.

---

### E16 — Distributions: wizard and detail pages

**Prerequisites**: E15, F2 (`page.tsx` replaces FOUNDATION's placeholder). **Create** `[publicId]/distributions/page.tsx`, `new/page.tsx`, `[id]/page.tsx`, `components/distribution-table.tsx`, `distribution-wizard.tsx`, `step-setup.tsx`, `step-inputs.tsx`, `step-review.tsx`, `step-finalize.tsx`, `lines-table.tsx`, `tier-summary.tsx`, `liquidation-worksheet.tsx`, `reverse-dialog.tsx`, `distribution-actions.tsx` (client component `({ distributionId, status })` returning `null`; rendered on the detail page; E17 fills it). Gate `["distributions","read"]`; actions hidden without the matching permission.

- `/distributions`: next deadline card ("Q1 2027 distribution and report due May 15, 2027" from `list.nextDeadline`), table (No., type, period, payment date, gross, net, status badge), "New distribution".
- `/distributions/new` and a `DRAFT` at `/distributions/[id]`: full-page wizard (not a modal; use the step indicator styles of `src/components/ui/stepper.tsx` as visual model, state in the URL query `?step=`):
  1. **Setup**: type (three cards with one-sentence OA descriptions: "Operating — Available Cash, Section 5.6(c)–(e)"; "Return of unused capital — Section 1.15, straight to 5.6(d)"; "Sale or liquidation — Section 5.6(f) / 11.4"); for OPERATING a quarter picker that fills `periodStart`/`periodEnd`; payment date (default: today); for SALE a toggle "Liquidation under Section 11.4". Saves the draft.
  2. **Inputs**: OPERATING / SALE: read-only Available Cash statement (import E14's `[publicId]/financials/components/available-cash-card.tsx`; do not modify it) with links "Fix revenue", "Add expense", "Adjust reserves" (open in a new tab) and a "Recalculate" button; the text "The amount distributed is the Available Cash shown. To hold cash back, establish a reserve (Section 5.6(a))." RETURN: amount input, shows unused capital and total Unreturned Capital. Liquidation: `liquidation-worksheet` (cash available; creditor rows — prefilled row "Accrued and unpaid Management Fee" with `managerCategory = MANAGEMENT_FEE` and the unpaid amount; member loans prefilled read-only; wind-down reserve; "final distribution" checkbox; net to Members).
  3. **Review**: blockers (red, each with a link to where it is fixed) and warnings (amber); `tier-summary` (tier (c) / (d) / (e) Preferred 70% / (e) Common 30%, each "paid of total owed"); `lines-table` (member, units, % of Preferred, unpaid return before, unreturned before, (c), (d), (e), gross, default offset, tax advance, **net**, unpaid return after, unreturned after), totals row; default-offset rows expand to show the application per default.
  4. **Finalize**: recap (amount, members paid, payment date, reserve balance to be reported), the R15 checkbox, a text box that must contain `FINALIZE`, and the button → `finalize({ expectedHash })`; on CONFLICT return to Review with a banner.
- `/distributions/[id]` for FINALIZED / REVERSED / reversal: header, tier summary, lines table with payment status, snapshot accordion ("How Available Cash was computed", "Positions before"), slot `<DistributionActions />` filled by E17, "Reverse" (`reverse-dialog`, reason + type the number).

**Acceptance**: DR-1 data produces the W-1 table on the Review step; a blocker disables "Continue to finalize"; finalizing redirects to the detail page showing "Finalized".

---

### E17 — Distribution notices, CSV export, payment marking

**Prerequisites**: E15, E16, F10. **Create**: `src/emails/llc/DistributionNoticeEmail.tsx`, `src/server/llc/economics/distribution-export.ts`, `distribution-export.logic.ts` (+ test), `[publicId]/distributions/components/mark-paid-dialog.tsx`. **Modify**: `src/trpc/routers/distribution/procedures/delivery.ts` (the three procedures below) and `[publicId]/distributions/components/distribution-actions.tsx` (E16 created it as a component returning `null` and already renders it on the detail page; E17 replaces its body).

| Procedure | RBAC | Input | Effect | Audit |
|---|---|---|---|---|
| `distribution.sendNotices` | `distributions: update` | `{ id, lineIds?: zId[] }` | FINALIZED non-reversal only; for each selected line with `noticeSentAt = null` and an email: render and `sendMail(options, { kind: "llc.distribution-notice", companyId, stakeholderId, relatedType: "distributionLine", relatedId: line.id })` with header `X-From-Name` = company name, then set `noticeEmailLogId`, `noticeSentAt` from the result; returns per-line results | `distribution.notices-sent` |
| `distribution.exportCsv` | `distributions: read` | `{ id }` | `{ filename: "distribution-{number}-{paymentDate}.csv", csv: string }` | `distribution.exported` |
| `distribution.markPaid` | `distributions: update` | `{ id, lineIds: zId[] (min 1), paidOn: zIsoDate, paymentReference: string max 100 optional }` | sets the two operational columns on lines with `netCents > 0` | `distribution.line-paid` |

CSV (`buildDistributionCsv(rows)` pure; RFC 4180; `\r\n`; amounts as `centsToDecimalString`; any cell beginning with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`), header exactly: `distribution_number,payment_date,stakeholder_id,member_name,email,preferred_units,gross,tier_c_preferred_return,tier_d_return_of_capital,tier_e_residual,default_offset,tax_advance_offset,net_payable,reference` — one row per line including zero-net lines; `reference` = `"{companyName} DIST{number}"`. Member bank details are not stored in this system; the file is a payment list for the bank portal, not a wire file. Test: DR-1 rows → three data rows + Common Member row; B's row ends `…,6941.08,6941.08,0.00,0.00,0.00,2500.00,4441.08,OCTAGON GPU I LLC DIST1` (no quotes: the cell has no comma, quote or line break); a member named `=cmd` is exported as `'=cmd`.

`DistributionNoticeEmail` props (preformatted strings): `companyName, memberName, distributionNumber, typeLabel, periodLabel, paymentDateLong, tierC, tierD, tierE, gross, defaultOffset, taxAdvanceOffset, net, unpaidReturnAfter, unreturnedAfter, preferredUnits, reserveBalance, managerName, managerEmail`. Subject: `{companyName} – Distribution No. {n} – {net} payable {paymentDateLong}`. Body: greeting; "The Manager has made the following distribution under Section 5.6 of the Operating Agreement for {periodLabel}."; table (Preferred Return §5.6(c) / Return of capital §5.6(d) / Residual §5.6(e) / **Total distribution** / less applied to unpaid Balance, interest and costs §4.9(iii) [only if non-zero] / less tax paid on your behalf §9.2 [only if non-zero] / **Net amount paid to you**); "After this distribution: Unreturned Capital Contributions {unreturnedAfter}; accrued and unpaid Preferred Return {unpaidReturnAfter}; Preferred Units {preferredUnits}."; "Reserve balance held by the LLC: {reserveBalance} (Section 5.6(a))."; for `RETURN_OF_UNUSED_CAPITAL` replace the second sentence with "This is a return of Capital Contributions not required by the LLC (Section 1.15). It reduces your Unreturned Capital Contributions and is not a payment of Preferred Return."; "The quarterly report follows separately." ; contact line.

**Acceptance**: notices are sent once per line (second call skips sent lines); CSV opens in a spreadsheet with 14 columns; marking paid does not change any economic column.

---

### E18 — Member statement, economics tab, fair-value page

**Prerequisites**: E15, F7 and F10 merged (FOUNDATION allows adding a member-detail tab only after its own tabs exist), F2 (`fair-value/page.tsx` replaces the placeholder). **Create**: `src/server/llc/economics/statements.ts`, `statements.logic.ts` (+ test), `src/components/llc/economics/member-economics-tab.tsx`, `[publicId]/fair-value/page.tsx`, `[publicId]/fair-value/components/fair-value-form.tsx`, `fair-value-table.tsx`. **Modify**: `src/trpc/routers/llc-economics/procedures/statement.ts` (`memberStatement`, `fairValue`); `[publicId]/stakeholders/[stakeholderId]/page.tsx` (FOUNDATION's member detail page): add one tab "Economics" rendering `<EconomicsTab stakeholderId={…} />`, following the pattern of the existing `CommitmentsTab`; change nothing else in that file.

```ts
export interface MemberStatement {
  stakeholderId: string; name: string; from: IsoDate; to: IsoDate;
  opening: StatementBalances;   // positions as of addDays(from, −1)
  closing: StatementBalances;   // positions as of to
  period: { contributions: Cents; credits: Cents; forfeited: Cents; returnAccrued: Cents; returnPaid: Cents; returnExtinguished: Cents; capitalReturned: Cents; residualPaid: Cents;
            grossDistributions: Cents; defaultOffsets: Cents; taxAdvanceOffsets: Cents; netPaid: Cents };
  activity: { on: IsoDate; kind: "CONTRIBUTION" | "CREDIT" | "REPLACEMENT" | "FORFEITURE" | "DISTRIBUTION" | "TRANSFER_IN" | "TRANSFER_OUT" | "TAX_ADVANCE"; description: string; amount: Cents; units: MicroUnits | null; refId: string }[];
  commitment: { committed: Cents; paid: Cents; uncalled: Cents; calledOutstanding: Cents } | null;
  defaults: { memberDefaultId: string; status: string; outstandingBalance: Cents; interestOwed: Cents; costsOwed: Cents }[];
  taxAdvanceOutstanding: Cents;
}
export interface StatementBalances { contributed: Cents; unreturned: Cents; preferredUnits: MicroUnits; commonUnits: MicroUnits; preferredPct: string /* pctString */; accruedReturn: Cents; unpaidReturn: Cents }
export async function getMemberStatement(tx, companyId, stakeholderId, range: { from: IsoDate; to: IsoDate }): Promise<MemberStatement>;
```
`period.returnAccrued = closing.accruedReturn − opening.accruedReturn` (cumulative accrual difference; carry and extinguishment are listed separately). Identity (asserted in the pure builder): `opening.unpaidReturn + returnAccrued − returnPaid − returnExtinguished ± carry = closing.unpaidReturn`.

| Procedure | RBAC | Input | Output |
|---|---|---|---|
| `llcEconomics.memberStatement` (q) | `distributions: read` | `{ stakeholderId: zId, from: zIsoDate, to: zIsoDate }` (`from ≤ to`; stakeholder via `assertCompanyOwns`) | `MemberStatement` |
| `llcEconomics.fairValue` (q) | `distributions: read` | `{ asOf: zIsoDate, assetFmvCents: zCents, cashOnHandCents: zCents, liabilitiesCents: zCents, includeMemberLoans: boolean, stakeholderId?: zId, unitsValued?: zUnits }` | `{ asOf, netToMembers, tiers, lines: (WaterfallLine & { name, preferredUnits, commonUnits, perPreferredUnit: Cents \| null })[], selected: { stakeholderId, unitsHeld, unitsValued, fairValue } \| null, prefill: { unpaidManagementFee, memberLoans, reserves, availableCashRaw } }` — `hypotheticalLiquidation` on positions as of `asOf`; `memberLoans` = principal + accrued interest when `includeMemberLoans`; `selected.fairValue = fairValueOfUnits(...)` (R43). Nothing is stored. |

- `member-economics-tab.tsx` (`EconomicsTab`): async server component `({ stakeholderId }: { stakeholderId: string })` for FOUNDATION's member detail page (returns `null` when the caller lacks `distributions: read`): cards (Capital Contributions paid, Unreturned Capital, Preferred Units and %, accrued and unpaid Preferred Return as of today, distributions received to date by tier), default banner if any, quarter selector + statement table (opening → activity → closing), link to the fair-value page with the member preselected.
- `/fair-value`: explanation with the OA §7.1(ii) sentence; form (valuation date, fair market value of the LLC's assets, cash on hand, liabilities to creditors — with "Prefill" buttons from `prefill`, include member loans); result table per member (tier (c), (d), (e), total, value per Preferred Unit); optional member + number of units → "Fair value of {n} Units: {amount}" with the arithmetic shown; note "This is a calculation aid. The price under Section 7.1 is the lesser of the Transfer Notice price and fair value as agreed or appraised."

**Tests** (`statements.logic.test.ts`): ST-1 — holder A in Scenario S with the W-1 distribution (tier (c) $2,889.43 on 2027-05-14), range 2027-04-01..2027-06-30: opening accrued (135 days to 2027-03-31) **$2,958.90**, opening unpaid $2,958.90; closing accrued (226 days) **$4,953.42**; `returnAccrued` **$1,994.52**; `returnPaid` $2,889.43; closing unpaid **$2,063.99**; identity holds. ST-2 — fair value = H-1.

**Acceptance**: the tab renders for a member with no activity (all zeros, no errors); `/fair-value` with H-1 inputs shows A $188,200.53 and 25 units = $47,050.13.

---

### E19 — Period data and compliance dates for GOVERNANCE, Overview widgets

**Prerequisites**: E11, E13, E15, E18. **Create**: `src/server/llc/economics/report-data.ts`, `report-data.logic.ts` (+ test), `compliance-dates.ts`, `compliance-dates.logic.ts` (+ test), `src/server/llc/economics/index.ts` (barrel of every function listed in section E.2), `src/components/llc/economics/overview-widgets.tsx`, `src/components/llc/economics/widget-card.tsx`. **Modify**: `src/components/llc/overview/economics-slot.tsx` (FOUNDATION's stub returning `null`): make it `export default async function EconomicsSlot() { return <LlcEconomicsWidgets />; }` (keep the file name, default/named export style and the no-props signature exactly as FOUNDATION's F9 created them). **Modify**: `src/trpc/routers/llc-economics/procedures/overview.ts` (`overview`).

Signatures and shapes: section E.2. `compliance-dates.logic.ts` is pure: `buildComplianceDates({ today, range, config, clock, firstReceiptOn, quarters: { quarterEnd, hasDistribution, availableCash }[], callLines, anyUncalledBalance, defaults, loans, ocdNoticeSentOn })` (the server computes `availableCash` per ended quarter with `computeAvailableCash` and passes it in). Rules for the list:

| `kind` | One item per | `dueOn` | `status` |
|---|---|---|---|
| `DISTRIBUTION_DEADLINE` | quarter end whose deadline falls in the range, starting with the quarter containing the first applied `CapitalReceipt` | `distributionDeadline(quarterEnd)` | quarter not yet ended → `OPEN`; a FINALIZED non-reversed OPERATING or SALE distribution has that `periodEnd` → `DONE`; else `computeAvailableCash(asOf = quarterEnd).availableCash = 0` → `NOT_REQUIRED` (§5.6(a) "if any"; only the report is due); else `OPEN` / `OVERDUE` |
| `QUARTERLY_REPORT_DEADLINE` | same quarter ends | same date (§8.2) | always `OPEN` here — GOVERNANCE overrides with its `MemberReport` state |
| `CALL_NOTICE_DUE` | SENT line with outstanding > 0 | `line.dueOn` | `OPEN` / `OVERDUE` |
| `BALANCE_OUTSIDE_DATE` | once, while any uncalled Balance exists | `balanceOutsideDate` | `OPEN` / `OVERDUE` |
| `FORFEITURE_DATE` | non-voided default without confirmed forfeiture and not cured | `forfeitureDate` | `OPEN` until the date, then `ACTION_REQUIRED` |
| `CREDIT_DATE` | default with confirmed forfeiture, credit not confirmed | computed `creditDate` | same |
| `REPLACEMENT_FUNDER_OUTSIDE_DATE` | once, while any default has outstanding Balance | `replacementFunderOutsideDate` | `OPEN` / `OVERDUE` |
| `OCD_NOTICE_DUE` | OCD set and `ocdNoticeSentOn` null | `clock.ocdNoticeDueOn` | `OPEN` / `OVERDUE` |
| `EXTENSION_REQUEST_DUE` | OCD set | `clock.extensionRequestDueOn` | `OPEN` / `OVERDUE` (GOVERNANCE marks done from its `Resolution`) |
| `TARGET_SALE_DATE` | OCD set | `clock.effectiveTargetSaleDate` | `OPEN` / `OVERDUE` |
| `DISSOLUTION_ELECTION_AVAILABLE` | OCD set | `clock.dissolutionElectionAvailableAfter` | `INFO` |
| `MEMBER_LOAN_MATURITY` | loan with principal outstanding | `maturityOn` | `OPEN` / `OVERDUE` |

`OVERDUE` = `dueOn < today` and not `DONE` / `NOT_REQUIRED`. Tests: with OCD 2027-02-15 and `today = 2027-04-01`, range 2027-01-01..2027-12-31, first receipt 2026-11-16, no revenue rows → distribution deadlines 2027-02-14 (Q4 2026, `NOT_REQUIRED`: no Available Cash), 2027-05-15 (Q1 2027, quarter ended 2027-03-31, no Available Cash → `NOT_REQUIRED`), 2027-08-14 and 2027-11-14 (`OPEN`); with Q1 2027 Available Cash of $12,000.00 and no distribution the 2027-05-15 item is `OPEN` (and `OVERDUE` when `today = 2027-05-16`); `OCD_NOTICE_DUE` 2027-03-01 `OVERDUE`; the E11 worked case yields `FORFEITURE_DATE` 2027-01-27 and, after forfeiture, `CREDIT_DATE` 2027-02-19.

`report-data.logic.test.ts`: AC-1 rows for 2027-04-01..2027-06-30 → revenue.grossRevenue $119,021.80, managementFee.accrued $5,951.10, expenses.operating $38,400.00, reserves.balanceAtEnd $65,000.00; three `ManagerPayment` rows (fee $2,050.63 on 2027-05-10; reimbursement $1,250.00; pass-through $300,000.00) → `managerAndAffiliatePayments.total` **$303,300.63**, `flow` = `THROUGH` only for the pass-through row; a FINALIZED distribution line of $153,097.60 to the Common Member in the period appears in `insiderDistributions` when the switch is on and `grandTotal` = **$456,398.23**.

**Overview widgets**: `overview-widgets.tsx` — async server component `LlcEconomicsWidgets()` (no props; links are built from `(await getSessionEntity()).publicId`) calling `api.llcEconomics.overview()`; returns `null` if the caller lacks `distributions: read`. `llcEconomics.overview` (q, `distributions: read`) → `{ today, capital: { committed, paid, uncalled, calledOutstanding, unusedCapital }, returns: { unreturnedCapital, unpaidPreferredReturn, distributedToDate: { tierC, tierD, tierE } }, cash: { availableCash, raw, reserveBalance, minimumReserve, minimumMet }, fee: { accruedToDate, unpaid }, orgCap: { counted, limit }, calls: { openLines, overdueLines, openDefaults, nextDueOn }, nextDeadlines: ComplianceDate[] (next 5 by date, status ≠ DONE), term: { ocd, effectiveTargetSaleDate, extensionRequestDueOn } }`. Cards (grid `grid-cols-2 lg:grid-cols-4`, built with `src/components/ui/card.tsx`; do not reuse `top-card.tsx`, it formats floats): **Capital** (paid of committed, uncalled Balance; link `/capital-calls`); **Preferred position** (Unreturned Capital, accrued and unpaid Preferred Return as of today; link `/distributions`); **Available Cash** (estimate as of the last complete month, reserve balance with a red badge when below the minimum; link `/financials`); **Next distribution deadline** (quarter label, date, days left / overdue); **Management Fee** (accrued, unpaid); **§6.21 cap** (progress bar counted / limit); **Capital calls** (open, overdue, defaults; red when overdue > 0); **Term** (Target Sale Date, extension request due, or "Set the Operations Commencement Date" link to `/settings/llc-term`).

**Acceptance**: every function of section E.2 is exported from `src/server/llc/economics/index.ts` with the signature shown there; the widget component renders with an empty ledger (all zeros, "No distributions yet"). Note: FOUNDATION's `LlcOverview` renders `<EconomicsSlot />` only after its `stakeholder: read` early return (`src/components/llc/overview/llc-overview.tsx:35, 54, 173`), so the widgets appear only for users with both `stakeholder: read` and `distributions: read`; E19 does not change `llc-overview.tsx`.

---

## E. Interfaces

### E.1 Pure library (callable by anyone, including client components)

Everything in section 0 plus the exports specified in E1–E5, imported by module path (`@/lib/llc/<module>`; inside tests and other files under `src/lib/llc` by relative path). FOUNDATION uses `business-days` and `unitsForAmount` (its F6 waits for **E1**). GOVERNANCE uses `business-days` (string dates — wrap with `fromDateOnly` / `toDateOnly` where it holds `Date` objects), `dates`, `isSuspended`, `computeTermClock`, `consentDeemedAgainstOn`, `fairValueOfUnits`.

### E.2 Server functions exported by ECONOMICS (`@/server/llc/economics`)

Native economics API (cents `bigint`, units `MicroUnits`, dates `IsoDate`):

```ts
// Balances as of any date (E7)
getPositions(tx, companyId: string, asOf: IsoDate, opts?: { untilSeq?: number }): Promise<{ ledger: LoadedLedger; positions: PositionsResult; waterfallHolders: WaterfallHolder[]; config: LlcEconomicsConfig }>;
getTermClock(tx, companyId): Promise<TermClock>;                                              // E7
getOrCreateLlcTerm(tx, companyId): Promise<LlcTerm>;                                          // E7
assertLedgerDateOpen(tx, companyId, date: IsoDate): Promise<void>;                            // E7 — call before completing anything dated in the past that changes holdings
closeBooksThrough(tx, companyId, date: IsoDate): Promise<void>;                               // E7 — GOVERNANCE calls it when a quarterly report is issued

// Suspension (R32) — E7
getSuspendedUnits(tx, companyId, asOf: IsoDate): Promise<{
  suspended: { stakeholderId: string; preferredUnits: MicroUnits; memberDefaultIds: string[] }[];   // declared, non-voided, uncured defaults with dueOn < asOf; preferredUnits from getMemberPositions
  undeclaredOverdue: { stakeholderId: string; callNoticeLineId: string; dueOn: IsoDate; outstanding: Cents }[]; // warning only: not suspended until the Manager declares
}>;

// Period data (§8.2) — E19
getPeriodEconomics(tx, companyId, period: { periodStart: IsoDate; periodEnd: IsoDate }): Promise<{
  period: { periodStart: IsoDate; periodEnd: IsoDate };
  revenue: { customerReceipts: Cents; passThroughFees: Cents; grossRevenue: Cents; otherIncome: Cents; assetSaleProceeds: Cents; insuranceProceeds: Cents;
             byMonth: { month: IsoDate; grossRevenue: Cents; utilizationBps: number | null }[]; averageUtilizationBps: number | null };
  expenses: { total: Cents; operating: Cents; fromCapital: Cents; byCategory: { category: string; amount: Cents }[] };
  managementFee: { accrued: Cents; paid: Cents; unpaidAtEnd: Cents };
  reserves: { balanceAtStart: Cents; established: Cents; released: Cents; balanceAtEnd: Cents; byKind: { kind: string; balanceAtEnd: Cents }[]; minimumRequired: Cents };
  distributions: { items: { id: string; number: number; type: string; paymentDate: IsoDate; gross: Cents; tierC: Cents; tierD: Cents; tierEPreferred: Cents; tierECommon: Cents; net: Cents }[]; totalGross: Cents };
  availableCashAtEnd: AvailableCashResult;
  managerAndAffiliatePayments: {                                   // R24
    payments: { id: string; paidOn: IsoDate; payee: string; category: string; flow: "TO" | "THROUGH"; amount: Cents; memo: string | null; resolutionId: string | null }[];
    total: Cents;
    insiderDistributions: { stakeholderId: string; name: string; distributionNumber: number; paymentDate: IsoDate; gross: Cents; net: Cents }[]; // [] when the LlcTerm switch is off
    insiderLoanPayments: { stakeholderId: string; name: string; paidOn: IsoDate; principal: Cents; interest: Cents }[];
    grandTotal: Cents;                                             // total + Σ insider net distributions + Σ insider loan payments
  };
  orgExpenseCap: { counted: Cents; limit: Cents; remaining: Cents };
  memberLoansOutstandingAtEnd: Cents;
}>;
// A row belongs to the period when its date is in [periodStart, periodEnd]; a revenue month when its first day is; a distribution by paymentDate.

// Computed dates (E19 table)
type ComplianceDate = { key: string /* stable: `${kind}:${sourceId ?? period}` */; kind: string; dueOn: IsoDate; label: string; oaSection: string;
  status: "OPEN" | "OVERDUE" | "ACTION_REQUIRED" | "DONE" | "NOT_REQUIRED" | "INFO"; sourceType: string; sourceId: string | null };
getComplianceDates(tx, companyId, range: { from: IsoDate; to: IsoDate }): Promise<ComplianceDate[]>;

// Statements — E18
getMemberStatement(tx, companyId, stakeholderId, range: { from: IsoDate; to: IsoDate }): Promise<MemberStatement>;
```

One function keeps GOVERNANCE's name and `Date`/string argument types (E7, `src/server/llc/economics/transfers.ts`):

```ts
applyUnitTransfer(tx, input: { companyId: string; unitTransferId: string; fromStakeholderId: string; toStakeholderId: string; unitClassId: string; units: string; effectiveOn: Date }): Promise<void>;
  // Validation only — economics stores nothing for a transfer; positions derive from GOVERNANCE's COMPLETED UnitTransfer rows (R39).
  // Throws BAD_REQUEST when assertLedgerDateOpen(effectiveOn) fails or the transferor holds fewer units than `units` as of effectiveOn.
  // GOVERNANCE calls it inside the transaction that sets status = COMPLETED, before updating the row, and ships the getMemberPositions fold-in
  // in the same package. Unpaid Balance and any MemberDefault stay with the transferor (§7.9.2); the transferee's units are not suspended.
```

GOVERNANCE uses the native functions directly (`getSuspendedUnits` with FOUNDATION's `getMemberPositions` for record snapshots; `getPeriodEconomics` for reports; `getComplianceDates`, treating `DONE` and `NOT_REQUIRED` as done and skipping `QUARTERLY_REPORT_DEADLINE` and `INFO`; `closeBooksThrough` when a quarterly or annual report is sent). No `getUnitPositions`, `getPeriodReportData` or `getEconomicDeadlines` adapters are built.

Until E19 creates the barrel `src/server/llc/economics/index.ts`, import each function from its defining file (`ledger.ts`, `term.ts`, `transfers.ts`, `suspension.ts`, `statements.ts`, `report-data.ts`, `compliance-dates.ts`).

UI: economics fills FOUNDATION's `src/components/llc/overview/economics-slot.tsx` (E19) and adds an "Economics" tab to the member detail page (E18). Shared display helpers (created by E7): `<Money>`, `<Units>`, `<IsoDateText>` from `@/components/llc/money` and the money input from `@/components/llc/money-input`.

Routes (all exist as FOUNDATION placeholders or are created by economics): `/capital-calls` (+ `/capital-calls/new`, `/capital-calls/[id]`, `/capital-calls/defaults`, `/capital-calls/defaults/[id]`), `/distributions` (+ `/new`, `/[id]`), `/financials` (+ `/revenue`, `/expenses`, `/manager-payments`, `/reserves`, `/loans-advances`), `/fair-value`, `/settings/llc-term`. Sidebar entries are FOUNDATION's (F2); `/financials` (summary), `/financials/expenses` and `/capital-calls/defaults` have no sidebar entry and are reached from tabs and links. RBAC subjects added: `capital-calls`, `distributions`, `llc-financials`, `llc-terms`.

### E.3 What ECONOMICS uses from FOUNDATION (names as in `01-foundation.md`)

| Need | Source | Used in |
|---|---|---|
| Conventions, `ZCents`, `numberToCents`, `centsToNumber`, `formatCents`, `parseDollarsToCents` | `src/lib/money.ts` (F1) | every server and UI package |
| `ZDateOnly`, `fromDateOnly`, `toDateOnly`, `todayInTimeZone`, `formatDateOnly` | `src/lib/date-only.ts` (F1) | every server and UI package |
| `withLlcAccessControl` (`ctx.company`), `requireLlc`, `getSessionEntity` | `src/trpc/api/trpc.ts`, `src/server/entity.ts` (F1) | E7–E19 |
| `unitsToWire`, `trimUnits` | `src/server/llc/serialize.ts` (F1) | UI helpers |
| `assertCompanyOwns` with `commitmentIds`, `capitalReceiptIds`, `unitClassIds` | `src/server/tenant-ownership.ts` (F1) | E9, E11 |
| `UnitClass` (`kind`, `pricePerUnitCents`, `fractionalUnitsAllowed`, `prefReturnBps`, `prefReturnDayCount`, `balanceReturnStartRule`, `residualSplitBps`, `finalClosingDate`, `balanceOutsideDate`) | F0 | `term.ts` `buildConfig` |
| `Commitment` (`status`, `acceptedCents`, `isReplacement`, `stakeholderId`, `unitClassId`, `acceptedOn`) | F0 | E9, E11 |
| `CapitalReceipt` (`kind`, `receivedOn`, `appliedOn`, `amountCents`, `appliedCents`, `unitsIssued`, `prefReturnStartDate`, `voidedAt`, `sourceType`, `sourceId`) | F0 | `ledger.ts` |
| `createCommitment`, `decideCommitment`, `recordCapitalReceipt` (incl. `special` kinds and `dueDate`), `voidCapitalReceipt`, `setReceiptPrefReturnStart`, `reduceAcceptedCommitment` | `src/server/llc/commitments.ts` (F6) | E9, E11, E15 |
| `getMemberPositions` (one row per stakeholder × unit class: `kind`, `capitalCents`, `units` as a 6-dp string; no lots, no dates) | `src/server/llc/positions.ts` (F6) | the only source of Common Units and of suspended Preferred Units (E7 `getPositions`, `getSuspendedUnits`, `applyUnitTransfer`); cross-check in `getPositions` |
| `sendMail(options, log)` returning `{ emailLogId, sentAt, messageId }` | `src/server/mailer.ts` (F10) | E9, E17 |
| `Stakeholder.isInsider`, `noticeEmail`, `memberStatus`, `Company.timezone`, `Company.entityType` | F0 | E7, E9, E11, E19 |
| Placeholder pages, sidebar, `settings/llc` slot, `economics-slot.tsx`, member detail page | F1, F2, F4, F7 | E7, E10, E14, E16, E18, E19 |

Agreed with FOUNDATION (confirmed by `plan-foundation` and written into `01-foundation.md`):
1. `validateAcceptance` exempts `isReplacement` commitments from the minimum, the closing date (with `skipClosingDateCheck`) and the initial-installment check; the offering cap still applies, which is why E11 `recordFunding` reduces the defaulter's commitment first.
2. E9's two guard calls inside `src/server/llc/commitments.ts` are named in FOUNDATION's F6.7 (the ledger-date guard goes immediately before the receipt insert, not at F6's marker in the cash branch, see E9); the only other change in that file is E7's one-line `companyToday` switch to `economicsToday` (test clock, ignored in production). A Balance receipt recorded in FOUNDATION's F7 dialog without a due date is prepaid (R28) until a Call Notice line covers it.
3. Every receipt sets `appliedOn = max(receivedOn, commitment.acceptedOn)` (H2, `appliedOnFor` in `commitments.ts`); for every special receipt economics records this equals `receivedOn` because its commitment was accepted on or before that date. `getMemberPositions({ asOf })` filters on `appliedOn`, so the E7 cross-check compares like with like.
4. Offsets under §4.9(iii) are ordinary cash receipts with `sourceType: "distribution"` and a `dueDate`; FOUNDATION rejects one larger than the outstanding Balance (`OVERPAYMENT`), which cannot happen because the offset to Balance is capped at the Balance owed.
5. Receipts are corrected with FOUNDATION's void flag; economics' own ledgers use compensating rows (team lead's ruling).

### E.4 What ECONOMICS uses from GOVERNANCE (names as in `03-governance.md`)

| Need | Source | Used in |
|---|---|---|
| `Resolution` rows: `type = TERM_EXTENSION`, `status = EFFECTIVE` (count = approved one-year extensions) | GOVERNANCE schema (C2) | `countTermExtensions` (E7) |
| `UnitTransfer` rows: `status = COMPLETED`, `unitClassKind`, `fromStakeholderId`, `toStakeholderId`, `units`, `effectiveOn`, `createdAt` | GOVERNANCE schema (C2) | `loadCompletedTransfers` (E7) |
| `Resolution.id` strings stored on `ExpenseEntry.resolutionId`, `ManagerPayment.resolutionId`, `MemberLoan.resolutionId` | — | E13 (presence only; GOVERNANCE may add a `findFirst({ id, companyId })` check) |
| GOVERNANCE folds completed transfers into FOUNDATION's `getMemberPositions` (01-foundation.md E3.1) | G16 | cross-check in `getPositions` |

Agreed with GOVERNANCE: `business-days.ts` works on `YYYY-MM-DD` strings; GOVERNANCE marks `EXTENSION_REQUEST_DUE` done itself when a TERM_EXTENSION resolution is sent; its G19 adds `assertResolutionOfCompany` to `expense.create`, `managerPayment.create` and `loan.create`; it never edits `loadCompletedTransfers`.

---

## F. Risks and open questions (each changes the plan if answered differently)

| # | Question | Assumed default | Where the switch lives |
|---|---|---|---|
| 1 | **Forfeiture base** (§4.9(iv)): is "unpaid Balance on the Forfeiture Date" reduced by amounts Replacement Funders have already funded? | No — measured against what the Defaulting Member itself has not paid (R33) | `LlcTerm.forfeitureBaseNetOfReplacementFunding` |
| 2 | **Order of applying withheld distributions and late payments** (§4.9(iii)): Balance first (more units and less 12% interest for the defaulter) or costs and interest first (creditor-style)? | Text order: Balance, interest, costs (R17) | `LlcTerm.defaultOffsetOrder` |
| 3 | **Tier (c) date and prepaid Balance**: accrued Preferred Return measured at the payment date (R7); prepaid Balance accrues only from the later Call Notice due date or March 31, 2027 even though units are issued on receipt (R5, R28) | as stated | `LlcTerm.prefAccrualCutoff`; FOUNDATION's `UnitClass.balanceReturnStartRule` (`RECEIPT_DATE` would start every Balance payment on receipt) |
| 4 | Is a Defaulting Member's own distribution still computed (and applied to its debt), rather than its units being left out of the waterfall? | Computed and applied — §4.9(iii) "treated for all purposes as distributed … and immediately paid by it to the LLC" (R17). The brief said "excluded"; excluded applies to votes only | none (text) |
| 5 | 12% default interest: day basis and whether it stops on the replacement-funded part when funded | Actual/365, simple; stops on each dollar when paid, offset or replacement-funded (R30) | `LlcTerm.defaultInterestDayBasis`; funding rule in `defaultInterest` |
| 6 | "Accrued and unpaid Preferred Return attributable to the Forfeited Amount" | Pro rata by Unreturned Capital at the Forfeiture Date (R34) | `computeForfeiture` |
| 7 | Reserve releases: back to the pool that funded them, or always Available Cash (§1.15 first sentence)? | Same pool; per-release override (R21) | `ReserveEntry.releaseTo` |
| 8 | §8.2 list: include distributions to the Common Member and insider Preferred holders? | Yes, as a separate sub-list (R24) | `LlcTerm.includeInsiderDistributionsInManagerList` |
| 9 | §6.21 cap: which costs count? | Category `ORGANIZATIONAL_OFFERING` by default, toggle per entry; server purchase price never counts (R23) | `countsTowardOrgCap` |
| 10 | Business days: federal-holiday observed dates (Friday for Saturday holidays) vs. bank (Federal Reserve) days; time zone for "sent" | OPM observed rule; FOUNDATION's `Company.timezone` (R44) | `LlcTerm.saturdayHolidayObservedFriday`, `extraHolidays`; `Company.timezone` |
| 11 | LOI extension and one-year extensions: measured from the date before the LOI days? | Yes (R41) | `computeTermClock` |
| 12 | Unpaid Preferred Return on a transfer: travels with the units | Yes (R39) | `computePositions` `TRANSFER` |
| 13 | Negative Gross Revenue month (refunds exceed receipts) | Negative fee accrual that nets against later months (R22) | `managementFeeForMonth` |
| 14 | Member bank details for outgoing wires are not modelled; the CSV is a payment list | Out of scope | — |
| 15 | No notice-of-default email is sent (the OA requires none). Capital Accounts, tax allocations, K-1s and in-kind distributions are not computed | Out of scope | — |

Risks:
- **Cross-plan contract.** This plan was reconciled against `01-foundation.md` and `03-governance.md` as written on 2026-11-12 (money and date conventions, F6 services, single schema migration F0, GOVERNANCE's adapter names). All cross-plan points are settled (E.3, E.4; one migration in F0; one time zone, `Company.timezone`). If a field name differs at implementation time, only `src/server/llc/economics/ledger.ts`, `term.ts`, `transfers.ts` and the F6 call-sites change; the library is unaffected.
- **Two readers of holdings.** FOUNDATION's `getMemberPositions` is the single source of units (B20): economics takes Common Units and suspended Preferred Units from it and never sums Common receipts. The economics engine still folds Preferred receipts into dated lots because accrual needs lots and dates, which `getMemberPositions` does not have; `getPositions` cross-checks Preferred units and capital against `getMemberPositions` and throws on any difference instead of choosing one. GOVERNANCE ships the `getMemberPositions` fold-in in the same package as transfer completion, so the check should never see a transfer FOUNDATION does not.
- **Back-dated legal events.** Forfeiture and credit are effective on dates earlier than their confirmation. The finalize blocker `PENDING_DEFAULT_STEP` and `assertLedgerDateOpen` keep a finalized distribution from being undermined; if the owner wants to distribute while a forfeiture is pending, the blocker must become a warning and reversal/re-run becomes the correction path.
- **`bigint` leaks.** `JSON.stringify` on a tRPC output outside superjson (logs, Sentry `attachRpcInput`, `Json` columns) throws on `bigint`. Snapshots and draft inputs store digit strings; do not log raw inputs. Sentry's `attachRpcInput: true` (`src/trpc/api/trpc.ts:167-169`) serialises inputs — this is why cents cross tRPC as numbers (`ZCents`) and every output goes through `toWire`.
- **Email is the legal trigger** for the due date. FOUNDATION's `sendMail` resolves only after the SMTP server accepts the message. Production currently uses the mail catcher (01-foundation.md B28): a Call Notice "sent" through it is logged as sent but delivered to nobody — E10's send dialog must show FOUNDATION's mail-catcher warning (`emailLog.deliveryStatus`) and, in production, refuse to send while `mailCatcher` is true (E9 `send` step 1; outside production the catcher is allowed so the flow can be tested). A bounce (§13.6 "unless the sender receives notice that the email was not delivered") is recorded by the Manager in FOUNDATION's email log; the line stays `SENT` and the Manager decides whether to re-notice.
- **Single-company assumptions.** Advisory lock per company serialises all ledger writes; fine for one company and one user.

