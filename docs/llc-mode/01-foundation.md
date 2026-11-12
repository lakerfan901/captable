# LLC mode — 01 Foundation and Admission

Implementation plan for executors. Area owner: FOUNDATION. Sibling plans: ECONOMICS (`E*` packages), GOVERNANCE (`G*` packages).
Source agreement: Operating Agreement of Octagon GPU I LLC, Final v2 (section numbers below refer to it).
Nothing in this document is implemented yet. Work packages are `F0`–`F15`; eight of them are split into an `a` (server) and a `b` (UI) session, giving 24 executor sessions.

How to read a work package: do exactly what it lists, in the files it lists. If a rule or shape is not written here, stop and ask; do not invent product behaviour.

---

## A. Findings (current code, verified by reading)

### A1. Stack facts that constrain the design

| Fact | Where | Consequence |
|---|---|---|
| `relationMode = "prisma"`: no database foreign keys or cascades | `prisma/schema.prisma:9` | Every relation scalar needs its own `@@index`. Referential actions are emulated by the Prisma client only. Tenant integrity is enforced in code. |
| Enums are re-exported by a custom generator into `prisma/enums.ts` (committed) | `prisma/schema.prisma:16-18`, `prisma/enum-generator.cjs` | After a schema change run `node_modules/.bin/prisma generate` and commit `prisma/enums.ts`. Import enums from `@/prisma/enums`, not `@prisma/client`, in client components. |
| Migrations are applied in production by `prisma migrate deploy` in a one-shot `migrate` container | `scripts/migrate.sh`, `deploy/dokploy/compose.yml:53-66` | Only committed SQL migrations reach production. Never `db push`. |
| Latest migration is `20240906132847_add_new_status`; the only later schema edit removed `url`/`binaryTargets` | `prisma/migrations/`, `git diff b63006f7 HEAD -- prisma/schema.prisma` | Schema and migrations should be in sync; F0 confirms before generating. |
| No vitest config file; existing tests use relative imports only | `src/lib/upload-authorization.test.ts:1-7`, `src/lib/rbac/rbac.test.ts:1-3` | `@/` does not resolve under vitest. Every module that has a unit test must use relative imports only, must not import `server-only`, `@/env`, `@/server/db` or `@prisma/client` at runtime (type-only imports are fine). This is why `src/server/tenant-ownership.ts:15-16` is written that way. |
| tRPC procedures: `withoutAuth`, `withAuth`, `withAccessControl` | `src/trpc/api/trpc.ts:201,211,213-221` | `withAccessControl` puts `membership` (`companyId`, `memberId`, `role`, `userId`, `user`) and `permissions` in `ctx`; policies are declared with `.meta({ policies: { subject: { allow: [...] } } })`. |
| RBAC: a policy on a subject that is missing from the caller's permission list is denied; ADMIN gets `*` on every entry of `SUBJECTS` | `src/lib/rbac/index.ts:49-60`, `src/lib/rbac/constants.ts:6-9`, `src/lib/rbac/subjects.ts:1-11` | Adding a subject is enough for ADMIN. Existing custom roles are denied the new subjects until edited (safe default). |
| Audit actions and target types are closed Zod enums; audit rows are JSON | `src/server/audit/schema.ts:5-81,88-110` | New actions/targets must be added to the enum. Never put a `bigint` in an audit row (JSON). |
| The session company is fixed in the JWT; the dashboard layout redirects when the URL `publicId` differs | `src/server/auth.ts:98-143`, `src/app/(authenticated)/(dashboard)/[publicId]/layout.tsx:26-28` | A deep link to another company silently lands on the current company's overview (see F15). |
| Server components call tRPC through `api` from `@/trpc/server` and gate with `serverAccessControl().allow(promise, [subject, action])` | `src/trpc/server.ts:28`, `src/app/(authenticated)/(dashboard)/[publicId]/stakeholders/page.tsx:16-20` | Model new pages on the stakeholders page. `params` is a Promise in Next 16 (`await props.params`). |
| `@db.Date` with `@prisma/adapter-pg` 7.10: a `Date` is written with its UTC year/month/day and read back as UTC midnight | `node_modules/@prisma/adapter-pg/dist/index.js` (`formatDate` uses `getUTC*`; `normalize_date` returns the `YYYY-MM-DD` text) | Convention B3 holds regardless of the server's `TZ`. F0 re-checks it. |
| Biome treats an `async` function without `await` as an error (`suspicious/useAwait`) and the pre-commit hook requires zero errors | `biome.json` | Do not mark a function or component `async` unless it awaits. Service functions that only return a Prisma promise are written without `async`. |
| Existing routers mostly swallow errors and return `{ success, message }` | e.g. `src/trpc/routers/stakeholder-router/procedures/update-stakeholder.ts:58-64` | New LLC procedures do NOT copy this: they throw `TRPCError` (see B). |

### A2. The analogous feature end to end (share classes, the model for unit classes)

- Schema: `ShareClass` (`prisma/schema.prisma:340-372`).
- Router: `src/trpc/routers/share-class/router.ts` (`create`, `update`, `get`), registered in `src/trpc/api/root.ts:38`. Tenant scoping: `checkMembership` then `where: { id, companyId }` (`router.ts:123-126`) plus `assertCompanyOwns(tx, companyId, { shareClassIds })` (`router.ts:102-104`).
- Audit: `Audit.create({ action: "shareClass.updated", companyId, actor, context: { userAgent, requestIp }, target, summary }, tx)` inside the transaction (`router.ts:128-141`).
- Page: `src/app/(authenticated)/(dashboard)/[publicId]/share-classes/page.tsx` (server component, empty state via `EmptyState`, table in a `Card`).
- Form/modal: `src/components/modals/share-class/share-class-form.tsx`, opened through `pushModal` (`src/components/modals/index.ts`).
- RBAC example (better than share classes, which have none): `src/trpc/routers/stakeholder-router/procedures/get-stakeholders.ts:3-9`.

### A3. Traps (each one makes an obvious approach wrong)

1. **`Stakeholder.email` is globally unique** (`prisma/schema.prisma:280`; index `Stakeholder_email_key` created in `prisma/migrations/20240519093430_clean_migration/migration.sql:641`). The same investor (and the Manager entity) cannot exist in two companies.
2. **`addStakeholders` silently drops duplicates and its audits are wrong**: `createMany({ skipDuplicates: true })` (`add-stakeholders.ts:22-25`), audits created in an un-awaited `.map(async …)` with `inp.id` that is undefined (`add-stakeholders.ts:27-42`). Do not copy this pattern; the Exhibit A import must fail loudly on duplicates.
3. **Name collisions**: `MemberStatusEnum` (team user status, `schema.prisma:198`), `StakeholderTypeEnum` (`:256`), `ShareTypeEnum { COMMON PREFERRED }` (`:323`), `SubscriptionStatus`/`BillingSubscription` (`:993,1060`), and `Stakeholder.state` (address state, `:288`). New enums/fields use distinct names (see C).
4. **`Share.quantity` and `Option.quantity` are `Int`; money on old models is `Float`** (`schema.prisma:686-691,776,830`). Do not reuse `Share`, `Investment` or `ShareClass` for LLC units.
5. **`Company.incorporationType` is a free string with an `"llc"` option** (`src/components/onboarding/company-form.tsx:202-207`), and `company.updateCompany` spreads the whole onboarding schema, also on every logo upload (`company-router/router.ts:72-91`, `company-form.tsx:157-167`). `entityType` must not ride on that schema.
6. **`BankAccount @@unique([companyId, primary])`** (`schema.prisma:194`) allows at most one primary and one non-primary account per company. Not fixed here; do not build on multiple bank accounts.
7. **E-sign: a `Template` is a single-use envelope**, not a template. Fields belong to concrete recipients (`TemplateField.recipientId`, `schema.prisma:584`), signer answers are stored on the field itself (`TemplateField.prefilledValue`, written by `EsignService.saveFieldValues`, `src/services/esign-service.ts:146-165`), status goes `DRAFT → PENDING → COMPLETE`.
8. **E-sign: signer input is not restricted to the signer's own fields.** `saveFieldValues` loops over all template fields and writes any key present in the submitted `data` (`esign-service.ts:151-163`, called from `sign-template.ts:113`). `required` and `readOnly` are enforced only in the browser (`src/components/template/signing-fields/field-renderer.tsx:44-57`). An investor could write the Manager's fields.
9. **E-sign: ordered delivery is not deterministic.** The first email goes to the first row of an un-ordered `findMany` (`add-fields.ts:98-110`, `:176-214`), the next signer is an un-ordered `findFirst` of `PENDING` recipients (`esign-service.ts:54-64`); recipients are inserted with `createMany` and share one `createdAt` (`create-template.ts:66-71`).
10. **E-sign: single-recipient templates never persist answers** (they go straight into the PDF job payload, `sign-template.ts:91-110`); multi-recipient decision is taken from the distinct `recipientId`s on fields, not from the recipient list (`sign-template.ts:55-58`).
11. **E-sign: a recipient becomes `SENT` inside the email worker** (`src/jobs/esign-email.ts:62-70`) and `getSigningFields` only serves a `SENT` recipient of a template that is not `DRAFT`/`COMPLETE` (`get-signing-fields.tsx:15-31`).
12. **E-sign: completion is asynchronous.** `sign` only enqueues `esign.generate-pdf` (`esign-service.ts:111-131`); the worker stamps the PDF and uploads it (`src/jobs/esign-pdf.ts:66-91`), then `esign.complete-pdf` sets `Template.status = COMPLETE`, creates a `Bucket` and a `Document` (`src/server/esign.ts:242-276`) and emails every recipient. Neither step is idempotent (a retry creates a second Bucket/Document), the `Document` is not linked to the template or to any stakeholder, and the bucket audit row is written with `companyId: ""` (`create-bucket.ts:31-44`).
13. **E-sign rendering limits**: only `TEXT`, `SIGNATURE`, `DATE`, `SELECT` render for signers although `FieldTypes` has more (`field-renderer.tsx:65-147`); dates are stamped `DD/MM/YYYY` (`src/server/esign.ts:103`); text is 8pt Helvetica, one line, no wrapping (`esign.ts:131-133,176-184`); a signature is drawn as a square of the field height (`esign.ts:160`).
14. **E-sign field editor saves by delete-and-recreate from the client payload** (`add-fields.ts:91-95,134-136`); any new field column that is not in the form schema (`src/providers/template-field-provider.tsx:21-56`), in `ZodAddFieldMutationSchema` (`template-field-router/schema.ts:14-37`) and in the `template.get` select (`get-template.ts:28-50`) is lost on save.
15. **Signing tokens are JWTs with no expiry and no purpose claim** (`src/lib/jwt.ts:9-13`); `DecodeEmailToken` accepts any signed JWT that has `id` and `rec` (`add-fields.ts:13-16,37-40`). A new token type must carry a claim the signing path rejects.
16. **Uploads need a session.** Presigned PUT (`src/server/file-upload-actions.ts:71-106`) and `bucket.create` (`create-bucket.ts:49-67`) require a signed-in member; allowed key prefixes are a closed list (`src/lib/upload-authorization.ts:10-17`); a private presigned PUT binds neither size nor content type (`file-upload-actions.ts:96-105`). Presigned GET requires the key to be recorded in a `Bucket` linked to a `Document` or `Template` of the caller's company and `documents: read` (`file-upload-actions.ts:115-156`). An investor without a login cannot upload a W-9 through any existing path.
17. **The e-sign completion email attaches the PDF by a presigned URL that expires after 10 minutes** (`esign-complete-pdf.ts:69-82`, `esign-confirmation-email.ts:49-54`, `src/server/file-uploads.ts:62`); a pg-boss retry after that fails.
18. **Email**: `sendMail` builds a new nodemailer transport from `env.EMAIL_SERVER` per call and logs nothing (`src/server/mailer.ts:9-32`). `EMAIL_SERVER` is optional in `src/env.js:41`. Production compose defaults it to the bundled Mailpit catcher, which stores mail and delivers nothing (`deploy/dokploy/compose.yml:11-13,39-40`). Seven call sites, all in `src/jobs/*-email.ts`; most have no `companyId` in their payload.
19. **Overview is hardcoded** (`[publicId]/page.tsx:34-40` and `DonutCard`, `SummaryTable`); only `ActivitiesCard` is real (`src/components/dashboard/overview/activities-card.tsx:19`, `api.audit.getAudits({ take: 4 })`).
20. **The sidebar is a client component with a static array**, also rendered inside the mobile drawer (`src/components/dashboard/sidebar/index.tsx:45-197`, `src/components/dashboard/navbar/mobile-drawer.tsx`). Both call sites need the entity type.
21. **`AuditLogTemplate` registers a remote Google font at import** (`src/pdf-templates/audit-log-template.tsx:15-18`). New PDF templates use the built-in Helvetica family only (no network at render time). `@react-pdf/renderer` is already in `serverExternalPackages` (`next.config.js:50-55`).
22. **pg-boss payloads are JSON validated by Zod** (`src/lib/queue.ts:111-126`): no `bigint`, no `Date` objects, no Prisma `Decimal` in a job payload.
23. **Today is 2026-11-12 and the Final Closing Date is 2026-11-30.** Admissions will be entered after the fact. Every date rule is evaluated against the date the Manager enters (`acceptedOn`, `receivedOn`), never against `now()`.

### A4. Agreement terms used in this area (verified against the text)

| Term | Text | Section |
|---|---|---|
| Classes | Common: 100 units to Octagon Compute LLC for $0, issued on the Effective Date; Preferred: 1 unit per $1,000 of Capital Contribution | 1.16, 1.24, 4.1 |
| Units follow money received | Units, Preferred Return, Unreturned Capital and Capital Accounts are based only on amounts actually received (or credited under 4.9(iv)); minimum and cap are measured on committed amounts | 1.5, 4.9 last sentence |
| Fractional units | "including fractional Preferred Units" (stated for credits; applied generally by owner decision) | 4.9(iv) |
| Minimum | $100,000; Manager may waive down to not less than $50,000 | 3.7 |
| Cap | $2,000,000 aggregate committed Capital Contributions by Preferred Members | 4.8 |
| Final Closing Date | November 30, 2026; no admission or issuance after it except (a) Balance of a commitment made on or before it, (b) Replacement Funders until June 30, 2027, (c) 4.9(iv) credits, (d) Substitute Members | 4.8 |
| Accept / reduce / reject | Manager's discretion; reduction subject to 3.7 | 4.8 |
| Refund | If not accepted in full within 10 business days after receiving the signature page and Initial Installment, return the unaccepted portion of the Initial Installment, without interest, within 5 business days thereafter | 4.8 |
| Initial Installment | Not less than 40% of the Capital Contribution at the time the signature page is accepted | 4.9(a) |
| Balance | Due 3 business days after an emailed Call Notice, and in any event by March 31, 2027; may be prepaid, but the Preferred Return on any part of the Balance accrues only from the date that part is due | 4.9(b) |
| Preferred Return start | Date the Capital Contribution for the unit is received (or, for Balance, the due date if later) | 5.6(b) |
| Admission requirements | Accredited investor; at least 21 if a natural person; executes Exhibit B | 3.2 |
| Effective admission | "effective upon acceptance by the Manager, becomes a Preferred Member" | Exhibit B, first paragraph |
| Exhibit A | Common table: Member, Capital Contribution, Common Units, Common Unit Percentage Interest. Preferred table: Preferred Members, Capital Contribution Committed, Paid to Date, Preferred Units, Preferred Unit Percentage Interest, Date Admitted, Notice Address and Email. Percentage = units held / all outstanding units of the class. Footer: Manager notice address and emails | Exhibit A |
| Exhibit B investor fields | Capital Contribution committed; Paid with this signature page; one of six accreditation bases; Legal name; Type (individual / joint / trust / entity); State of residence (or formation); Investment Summary received, dated; Mailing address; Email; Signature; Name and title (if entity); Date | Exhibit B |
| Exhibit B acceptance | "either signatory may sign for the Manager"; By / Date; Capital Contribution received $; Preferred Units issued | Exhibit B |
| W-9 | Delivered with the signature page; carries the TIN (the signature page does not) | Exhibit B §6 |
| Insiders | Manager, Isaac Reid, Karl Schoen, their Affiliates, spouses, descendants, and trusts/entities for or controlled by them hold non-"Disinterested" units | 1.18 |
| Member vs Financial Interest | A holder of only a Financial Interest is not a Member (no vote, no information rights) | 1.8, 1.11, 7.9.2 |
| Notices | Email to the address on Exhibit A is effective when sent unless the sender is told it was not delivered | 13.6 |
| Manager may update Exhibit A alone | For admissions, issuances, transfers, installment payments, 4.9(iv) adjustments | 12.1(a) |

---

## B. Decisions

Conventions (binding for all three areas):

| # | Decision | Reason |
|---|---|---|
| B1 | **Money is integer cents.** DB: Prisma `BigInt`, field names end in `Cents`. Server code: `bigint`. Everything that crosses a boundary (tRPC input/output, pg-boss payload, Audit JSON, REST, client props, CSV) carries cents as a JS `number`. | Exact arithmetic; `BigInt` does not survive `JSON.stringify`; the largest value in play (2e8 cents) is far below `Number.MAX_SAFE_INTEGER`. |
| B2 | **Units** are `Decimal @db.Decimal(18, 6)` in the DB and a fixed 6-decimal string on the wire (`"40.000000"`). **Percentages** on the wire are 4-decimal strings (`"33.3333"`). **Rates and splits** are integer basis points (`800` = 8%, `7000` = 70%). | Prisma `Decimal` objects do not serialise to client components or JSON; strings do. |
| B3 | **Calendar dates** are `DateTime @db.Date` in the DB and `YYYY-MM-DD` strings on the wire. A `Date` object for a calendar date is always UTC midnight. "Today" is computed in `Company.timezone` (new column, IANA name, default `America/Denver`) with `Intl.DateTimeFormat`, not dayjs. | A signing at 9pm on Nov 30 in Wyoming is Dec 1 in UTC; the Final Closing Date check must not flip. |
| B4 | New LLC tRPC procedures **throw** `TRPCError` (`BAD_REQUEST` for rule violations with a human message that names the agreement section, `NOT_FOUND` for an id outside the caller's company, `FORBIDDEN` for a non-LLC company). They never return `{ success: false }`. Clients show `error.message` in a toast. | Rule violations must not be swallowed. |
| B5 | Tenant rule for every procedure: read `companyId` from `ctx.membership.companyId` only; any client-supplied id is loaded with `findFirst({ where: { id, companyId } })` and a miss throws `NOT_FOUND`; ids that are stored as links go through `assertCompanyOwns` (extended in F1). | Matches `src/server/tenant-ownership.ts`. |
| B6 | Pure rule code lives in `src/lib/admission/**` (this area) and `src/lib/llc/**` (ECONOMICS). Server-side DB services live in `src/server/llc/**`. | Keeps ownership boundaries clear and rules unit-testable. |
| B7 | Shared hotspots are edited once: `src/trpc/api/root.ts`, `src/lib/rbac/subjects.ts`, `src/server/audit/schema.ts`, `src/server/tenant-ownership.ts` by F1; sidebar and placeholder pages by F2. Later packages only touch their own router/page files. New LLC dialogs use a local `<Dialog>` (`@/components/ui/dialog`) and do not register in `src/components/modals/index.ts`. | Lets packages run in parallel without merge conflicts. |

Product and architecture decisions:

| # | Decision | Reason |
|---|---|---|
| B8 | `Company.entityType EntityTypeEnum { CORPORATION, LLC }`, default `CORPORATION`. Set by (a) onboarding: `incorporationType === "llc"` creates an LLC company; (b) a dedicated mutation `company.setEntityType` on the company settings page. `company.updateCompany` never changes it. | Trap A3.5; the live company must be switchable. |
| B9 | Switching to LLC is allowed only when the company has no `Share`, `Option`, `Safe`, `ConvertibleNote`, `Investment` rows; switching back to CORPORATION only when it has no `Commitment` rows. Both seed/keep `UnitClass` rows; nothing is deleted. | No data is ever hidden silently; live company has no cap-table data. |
| B10 | One gating helper per layer: server components `requireLlc()` / `requireCorporation()` in `src/server/entity.ts`; tRPC `withLlcAccessControl` in `src/trpc/api/trpc.ts`; client `useEntity()` from `src/providers/entity-provider.tsx`. C-corp tRPC routers are left as they are (their pages are hidden and redirected for LLC companies). | Single place to change the rule. |
| B11 | Vocabulary is a lookup, not a fork: `src/lib/vocabulary.ts` maps `entityType` to labels (`holder`, `holders`, `unit`, `units`, `unitClass`, `unitClasses`, `schedule`). Only navigation, page headers and the members list use it. The LLC members list and member form are new components; C-corp components are not edited beyond header strings. | "Members"/"Units" without touching every component. |
| B12 | URL structure (all under `/[publicId]`): `/` overview, `/captable` Member Schedule (same URL as the cap-table stub), `/stakeholders` members list, `/stakeholders/[stakeholderId]` member detail, `/unit-classes`, `/commitments` (commitments and receipts ledger), `/admissions` (Exhibit B packets), `/admissions/[templatePublicId]` (Manager confirmation), `/emails` (email log), `/settings/llc` (entity type, timezone; slot for `LlcTerm`). Public: `/esign/[token]` (existing), `/w9/[token]` (new). Placeholders created by F2 and then owned by the other areas: `/capital-calls`, `/distributions`, `/financials` (sub-pages `revenue`, `manager-payments`, `reserves`, `loans-advances`), `/fair-value` (ECONOMICS; its `LlcTerm` page `/settings/llc-term` is created by ECONOMICS itself); `/resolutions`, `/transfers`, `/compliance`, `/reports`, `/documents/books` (GOVERNANCE; `/reports` already exists as a stub). | Navigation defined once. |
| B13 | New models are per company: `UnitClass` (exactly one `PREFERRED` and one `COMMON` per company, `@@unique([companyId, kind])`), `Commitment`, `CapitalReceipt`, `EmailLog`. Offering terms (price, minimum, floor, cap, initial-installment %, Final Closing Date, Balance outside date, acceptance/refund business days, return rate, day count, residual split, votes) are columns of `UnitClass`. Dates are seeded null and must be entered before the first acceptance. | Each term is a setting; a second LLC gets its own. |
| B14 | **Commitment amounts**: `committedCents` = amount subscribed on Exhibit B (never changes after the decision); `acceptedCents` = amount the Manager accepted (0 until decided; later reduced only by ECONOMICS for Replacement Funders, §4.9(ii)). Exhibit A "Capital Contribution Committed" shows `acceptedCents`. Status: `PENDING` → `ACCEPTED` (accepted = committed) / `REDUCED` (0 < accepted < committed) / `REJECTED` (accepted = 0). `ACCEPTED` and `REDUCED` are "active". A decided commitment cannot be re-decided. | §1.5, §4.8. |
| B15 | **Receipts**: `amountCents` = cash received; `appliedCents` = the part of it that is a Capital Contribution. While the commitment is `PENDING`, receipts are held (`appliedCents = 0`, no units, no return start). On acceptance the held cash is applied in receipt order and units are issued. Units = `appliedCents / pricePerUnitCents`, 6 decimals. Receipts are immutable; corrections are void + re-record. | §1.5: units only on amounts received and accepted; money sent with a subscription that is later reduced is partly returned. |
| B16 | **Receipt kind is derived, not chosen**: `INITIAL` when the commitment is `PENDING` or `receivedOn <= acceptedOn`; `BALANCE` otherwise. `REPLACEMENT`, `CREDIT` and the added fifth kind `FORFEITURE` are created only by ECONOMICS through the service in F6. | §4.9(a): everything paid at acceptance is the Initial Installment ("not less than" 40%). |
| B17 | **Preferred Return start** (`prefReturnStartDate`): `INITIAL` = `receivedOn`; `BALANCE` = the later of `receivedOn` and the due date, where the due date is the one passed by ECONOMICS (Call Notice) or, when none is known, `UnitClass.balanceOutsideDate`; `REPLACEMENT` = `receivedOn`; `CREDIT` = the Credit Date passed by ECONOMICS. ECONOMICS can move a Balance receipt's start with `setReceiptPrefReturnStart` when a Call Notice later fixes an earlier due date. | §4.9, §5.6(b); owner default. |
| B18 | **Reduction refund default is pro rata**: when `acceptedCents < committedCents`, the cash kept is `min(accepted, round(held × accepted / committed))` and the rest is refundable. The Manager may keep more (up to `min(held, accepted)`) or less (not below 40% of accepted) by entering `keepCents`. | "Unaccepted portion of the Initial Installment" (§4.8); see open question F-Q2. |
| B19 | **The Common Member's 100 units** are recorded as a `Commitment` (0 cents, `ACCEPTED`) plus one `CapitalReceipt` (`INITIAL`, 0 cents, `unitsIssued = 100`). Common issuance is capped by `UnitClass.authorizedUnits`. | One source of truth for holdings; §3.2 forbids more Common Units without a Preferred Supermajority. |
| B20 | Holdings are computed in one function, `getMemberPositions` (`src/server/llc/positions.ts`), from non-void receipts. GOVERNANCE extends that function for `UnitTransfer`; nothing else sums units. | Exhibit A, votes, distributions must agree. |
| B21 | Stakeholder extensions: `holderType`, `residenceState`, `accreditationBasis`, `admittedOn`, `signerName`, `signerTitle`, `noticeEmail`, `phone`, `isInsider`, `memberStatus` (`LlcMemberStatusEnum { PROSPECT, MEMBER, FINANCIAL_INTEREST_ONLY }`, default `PROSPECT`). `taxId` is not collected for LLC members (the W-9 carries it). Emails are stored lower-cased and are unique per company. | Exhibit A/B; trap A3.1, A3.3. |
| B22 | **E-sign reuse = master + clone.** A master is a `Template` with `isMaster = true` that stays `DRAFT` forever and has two role recipients (`investor`, `manager`). Sending a subscription clones it: new `Template` (same `bucketId`, `sourceTemplateId` = master, `workflow = SUBSCRIPTION`), new recipients, copied fields. Fields carry a `semanticKey` so answers can be read without knowing positions. | Smallest change to a single-use envelope model (A3.7). |
| B23 | **Signing order for a subscription**: investor signs; investor is asked for a W-9; the Manager reviews on the confirmation screen, records the wire, accepts/reduces/rejects; only then are the Manager's Exhibit B lines ("Capital Contribution received", "Preferred Units issued", date) prefilled from the ledger and the Manager's signing link activated; the Manager countersigns; the stamped PDF is attached to the stakeholder. The automatic "next signer" email is suppressed for this workflow. | The signed page must match the ledger; admission is effective on acceptance (Exhibit B). |
| B24 | Exactly one Manager recipient per packet, chosen at send time from the company's team members. To let either principal sign on their own printed line, the owner keeps one master per signatory. | "Either signatory may sign" vs. the all-recipients-must-sign completion rule. |
| B25 | Accreditation basis and holder type are `SELECT` fields with canonical options written by the server; the address is four single-line fields; dates on subscription packets are stamped `MM/DD/YYYY`. No checkbox field type is added. | Rendering limits A3.13. |
| B26 | W-9 upload without login: a separate JWT with claim `p: "w9"` and a 30-day expiry, two public tRPC procedures (get presigned PUT for prefix `w9-docs`, then register the object after a server-side size/type check), PDF/JPEG/PNG up to 10 MB, at most 5 uploads per packet. The signing path rejects any token that has a `p` claim. | Trap A3.15, A3.16. |
| B27 | `EmailLog` is written inside `sendMail` for every send (success or failure). The log context is an optional second argument. Bodies are not stored (links are credentials); a SHA-256 of the HTML is. A log-write failure never throws. Bounce state is set manually by the Manager ("mark as bounced"); there is no provider webhook. | Trap A3.18; §13.6 makes a known bounce legally relevant; SMTP alone reports no bounces. |
| B28 | Real delivery needs environment only: set `EMAIL_SERVER` (SMTP URL) and `EMAIL_FROM` in Dokploy. Code adds: a "mail catcher in use" banner, a test-send button, and the company name as the sender display name for LLC emails. | The app currently uses the catcher in production. |
| B29 | RBAC subjects added: `unit-classes`, `commitments`, `emails`. Member records keep using `stakeholder`; entity type uses `company`; documents use `documents`. Admission packets use `commitments`. | Fewest new subjects that still separate money from records. |
| B30 | Audit actions added: `company.entity-type-changed`, `unitClass.updated`, `commitment.created`, `commitment.updated`, `commitment.accepted`, `commitment.reduced`, `commitment.rejected`, `commitment.refund-recorded`, `capitalReceipt.recorded`, `capitalReceipt.voided`, `capitalReceipt.start-date-changed`, `stakeholder.admitted`, `stakeholder.imported`, `document.attached`, `admission.master-created`, `admission.sent`, `admission.confirmed`, `admission.countersign-ready`, `admission.cancelled`, `admission.w9-received`, `emailLog.bounce-marked`. Target types added: `unitClass`, `commitment`, `capitalReceipt`, `emailLog`. Actor for job/public actions: `{ type: "company", id: companyId }`. | Closed enums (A1). |
| B31 | Existing e-sign behaviour that stays unchanged: upload → recipients → field editor → send for `STANDARD` templates; un-ordered parallel signing; ordered signing (now deterministic); single-recipient completion; PDF stamping, audit page and `DD/MM/YYYY` for `STANDARD`; completion emails; cancel; the `/documents/esign` pages. Changes that apply to all templates: a signer can only write their own non-read-only fields, required fields are checked on the server, completion is idempotent, and the signed `Document` id is stored on the template. | Security fixes; everything else is additive. |

---
## C. Data model

### C1. Migration policy (all three areas)

- **`F0` is the single schema migration for ALL three areas.** It contains every enum, model and column of section C of this file, of `docs/llc-mode/02-economics.md` and of `docs/llc-mode/03-governance.md`. The F0 executor reads all three section C's at execution time and pastes their Prisma blocks verbatim from those files (do not rely on any summary of them here). A column that more than one plan mentions (for example `Document.recordCategory` / `recordYear`, `Document.kind`, `Document.stakeholderId`) is added exactly once.
- No other package edits `prisma/schema.prisma` as part of this plan. If a later package finds a missing column, it adds a small additive migration of its own (new nullable/defaulted column, new table or new index only), named after the package, and says so in its report.
- There is no time-zone column other than `Company.timezone`; if another plan's section C still shows one (e.g. on `LlcTerm`), leave it out and report it.
- Every statement is additive (new enum types, new tables, new nullable or defaulted columns, new indexes) with one exception: the unique index on `Stakeholder.email` is replaced (C4).
- `relationMode = "prisma"`: the migration contains no `FOREIGN KEY`. If the generated SQL contains one, the schema edit is wrong.

### C2. New enums (paste as is)

```prisma
enum EntityTypeEnum {
  CORPORATION
  LLC
}

enum UnitClassKindEnum {
  PREFERRED
  COMMON
}

enum DayCountEnum {
  ACTUAL_365
}

enum BalanceReturnStartRuleEnum {
  LATER_OF_RECEIPT_AND_DUE
  RECEIPT_DATE
}

enum HolderTypeEnum {
  INDIVIDUAL
  JOINT
  TRUST
  ENTITY
}

enum AccreditationBasisEnum {
  NET_WORTH // natural person, net worth > $1,000,000 excluding primary residence
  INCOME // natural person, income > $200,000 (or $300,000 joint) in each of the two most recent years
  LICENSE // natural person holding a Series 7, 65 or 82 license in good standing
  ENTITY_ASSETS // entity with total assets > $5,000,000 not formed to acquire the Units
  ENTITY_ALL_OWNERS_ACCREDITED // entity in which all equity owners are accredited investors
  TRUST_ASSETS // trust with total assets > $5,000,000, not formed to acquire the Units, directed by a sophisticated person
}

enum LlcMemberStatusEnum {
  PROSPECT
  MEMBER
  FINANCIAL_INTEREST_ONLY
}

enum CommitmentStatusEnum {
  PENDING
  ACCEPTED
  REDUCED
  REJECTED
}

enum CapitalReceiptKindEnum {
  INITIAL
  BALANCE
  REPLACEMENT
  CREDIT
  FORFEITURE
}

enum EmailLogStatusEnum {
  SENT
  FAILED
}

enum EmailBounceStateEnum {
  NONE
  BOUNCED
  COMPLAINED
}

enum TemplateWorkflowEnum {
  STANDARD
  SUBSCRIPTION
}
```

### C3. New models (paste as is)

```prisma
model UnitClass {
  id   String            @id @default(cuid())
  name String
  kind UnitClassKindEnum

  // Issuance
  pricePerUnitCents      BigInt? // PREFERRED: 100000 ($1,000). COMMON: null (not sold).
  authorizedUnits        Decimal? @db.Decimal(18, 6) // COMMON: 100. PREFERRED: null (limited by offeringCapCents).
  fractionalUnitsAllowed Boolean  @default(true)
  votesPerUnit           Decimal  @default(0) @db.Decimal(18, 6)

  // Economics (read by ECONOMICS)
  prefReturnBps          Int                        @default(0) // 800 = 8.00% simple, cumulative, non-compounding
  prefReturnDayCount     DayCountEnum               @default(ACTUAL_365)
  balanceReturnStartRule BalanceReturnStartRuleEnum @default(LATER_OF_RECEIPT_AND_DUE)
  residualSplitBps       Int                        @default(0) // PREFERRED 7000, COMMON 3000

  // Offering terms (PREFERRED only; null on COMMON)
  minCommitmentCents      BigInt? // 10000000 ($100,000)
  minCommitmentFloorCents BigInt? // 5000000 ($50,000) lowest amount the Manager may waive to
  offeringCapCents        BigInt? // 200000000 ($2,000,000) aggregate accepted commitments
  initialInstallmentBps   Int       @default(4000)
  finalClosingDate        DateTime? @db.Date
  balanceOutsideDate      DateTime? @db.Date
  acceptanceBusinessDays  Int       @default(10)
  refundBusinessDays      Int       @default(5)

  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  commitments Commitment[]
  receipts    CapitalReceipt[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([companyId, kind])
  @@unique([companyId, name])
  @@index([companyId])
}

model Commitment {
  id     String               @id @default(cuid())
  status CommitmentStatusEnum @default(PENDING)

  committedCents BigInt // as subscribed on Exhibit B
  acceptedCents  BigInt @default(0) // 0 until decided

  signedOn              DateTime? @db.Date // date the signature page was received
  investmentSummaryDate DateTime? @db.Date
  accreditationBasis    AccreditationBasisEnum?

  acceptedOn        DateTime? @db.Date // decision date entered by the Manager (also used for REJECTED)
  decidedAt         DateTime? // instant the decision was recorded
  decidedByMemberId String? // team Member.id (plain scalar, no relation)
  minimumWaived     Boolean   @default(false)
  minimumWaiverNote String?
  isReplacement     Boolean   @default(false) // Replacement Funder commitment, set only by ECONOMICS
  rejectionReason   String?
  notes             String?

  // Section 4.8 clock
  acceptanceDeadline DateTime? @db.Date
  refundDueCents     BigInt    @default(0)
  refundDueBy        DateTime? @db.Date
  refundPaidCents    BigInt    @default(0)
  refundPaidOn       DateTime? @db.Date

  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  stakeholderId String
  stakeholder   Stakeholder @relation(fields: [stakeholderId], references: [id], onDelete: Restrict)

  unitClassId String
  unitClass   UnitClass @relation(fields: [unitClassId], references: [id], onDelete: Restrict)

  receipts CapitalReceipt[]
  packet   Template?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([companyId])
  @@index([companyId, status])
  @@index([stakeholderId])
  @@index([unitClassId])
}

model CapitalReceipt {
  id   String                 @id @default(cuid())
  kind CapitalReceiptKindEnum

  receivedOn          DateTime  @db.Date
  amountCents         BigInt // cash received; 0 for CREDIT, FORFEITURE and the Common issuance
  appliedCents        BigInt    @default(0) // Capital Contribution; negative only for FORFEITURE
  unitsIssued         Decimal   @default(0) @db.Decimal(18, 6) // negative only for FORFEITURE
  appliedOn           DateTime? @db.Date // date the units were issued
  prefReturnStartDate DateTime? @db.Date // null while held or when the class has no return

  reference String? // wire reference
  note      String?

  // Optional link set by ECONOMICS (e.g. "callNotice", "memberDefault")
  sourceType String?
  sourceId   String?

  recordedByMemberId String?
  voidedAt           DateTime?
  voidedByMemberId   String?
  voidReason         String?

  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  commitmentId String
  commitment   Commitment @relation(fields: [commitmentId], references: [id], onDelete: Restrict)

  // Denormalised from the commitment for cheap per-member and per-class sums
  stakeholderId String
  stakeholder   Stakeholder @relation(fields: [stakeholderId], references: [id], onDelete: Restrict)

  unitClassId String
  unitClass   UnitClass @relation(fields: [unitClassId], references: [id], onDelete: Restrict)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([companyId])
  @@index([commitmentId])
  @@index([stakeholderId])
  @@index([unitClassId])
  @@index([companyId, receivedOn])
  @@index([sourceType, sourceId])
}

model EmailLog {
  id String @id @default(cuid())

  toAddress   String // comma-separated when several
  fromAddress String
  subject     String
  kind        String // template key, e.g. "esign.request" (list in F9)

  status            EmailLogStatusEnum
  sentAt            DateTime?
  providerMessageId String?
  smtpResponse      String?
  errorMessage      String?
  bodySha256        String?

  bounceState EmailBounceStateEnum @default(NONE)
  bouncedAt   DateTime?
  bounceNote  String?

  relatedType String? // e.g. "template", "commitment", "callNotice", "update"
  relatedId   String?

  companyId String?
  company   Company? @relation(fields: [companyId], references: [id], onDelete: SetNull)

  stakeholderId String?
  stakeholder   Stakeholder? @relation(fields: [stakeholderId], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())

  @@index([companyId, createdAt])
  @@index([stakeholderId])
  @@index([relatedType, relatedId])
}
```

### C4. Additions to existing models (add these lines; change nothing else)

`Company` (after `customRoles`):

```prisma
  entityType EntityTypeEnum @default(CORPORATION)
  timezone   String         @default("America/Denver")

  unitClasses     UnitClass[]
  commitments     Commitment[]
  capitalReceipts CapitalReceipt[]
  emailLogs       EmailLog[]
```

`Stakeholder`: remove `@unique` from `email`, then add:

```prisma
  holderType         HolderTypeEnum?
  residenceState     String? // state of residence (or formation); NOT the address state
  accreditationBasis AccreditationBasisEnum?
  admittedOn         DateTime?               @db.Date
  signerName         String?
  signerTitle        String?
  noticeEmail        String? // when null, notices go to `email`
  phone              String?
  isInsider          Boolean                 @default(false)
  memberStatus       LlcMemberStatusEnum     @default(PROSPECT)

  commitments     Commitment[]
  capitalReceipts CapitalReceipt[]
  documents       Document[]
  esignRecipients EsignRecipient[]
  packets         Template[]
  emailLogs       EmailLog[]

  @@unique([companyId, email])
```

`Document`:

```prisma
  kind String? // "exhibit-b" | "w9" | "wire-confirmation" | "other" (other areas may add keys)

  stakeholderId String?
  stakeholder   Stakeholder? @relation(fields: [stakeholderId], references: [id], onDelete: SetNull)

  @@index([stakeholderId])
```

`Template`:

```prisma
  workflow         TemplateWorkflowEnum @default(STANDARD)
  isMaster         Boolean              @default(false)
  sourceTemplateId String? // master this envelope was cloned from (plain scalar)
  signedDocumentId String? // Document created on completion (plain scalar)

  stakeholderId String?
  stakeholder   Stakeholder? @relation(fields: [stakeholderId], references: [id], onDelete: SetNull)

  commitmentId String?     @unique
  commitment   Commitment? @relation(fields: [commitmentId], references: [id], onDelete: SetNull)

  @@index([stakeholderId])
  @@index([companyId, workflow, isMaster])
```

`EsignRecipient`:

```prisma
  role         String? // "investor" | "manager" (null on STANDARD templates)
  signingOrder Int?

  stakeholderId String?
  stakeholder   Stakeholder? @relation(fields: [stakeholderId], references: [id], onDelete: SetNull)

  @@index([stakeholderId])
```

`TemplateField`:

```prisma
  semanticKey String?
```

### C5. The F0 migration: how to write it and why it is safe on the live database

1. Before editing the schema, confirm there is no drift: against a scratch Postgres 15 with all existing migrations applied, `node_modules/.bin/prisma migrate diff` from the migrations directory to the unedited schema must report no difference (check the flag names with `node_modules/.bin/prisma migrate diff --help`; Prisma 7 renamed them). If it reports a difference, stop and report.
2. Apply C2–C4 of this file and section C of `02-economics.md` and `03-governance.md` to `prisma/schema.prisma` (shared columns once), run `node_modules/.bin/prisma format` and `node_modules/.bin/prisma validate`.
3. Generate without applying: `node_modules/.bin/prisma migrate dev --create-only --name llc_mode` (local database from `compose.yml`).
4. Hand-edit the generated `migration.sql` so that the `Stakeholder` email part reads, in this order (the index is dropped first: lower-casing while the global case-sensitive index still exists fails on case variants in different companies), and wrap the whole file in `BEGIN;` … `COMMIT;` (`prisma migrate deploy` does not run a migration in a transaction by itself):

```sql
-- Emails become unique per company and are stored lower-cased.
DROP INDEX "Stakeholder_email_key";
UPDATE "Stakeholder" SET "email" = lower("email") WHERE "email" <> lower("email");
CREATE UNIQUE INDEX "Stakeholder_companyId_email_key" ON "Stakeholder"("companyId", "email");
```

5. Review the SQL: allowed statement kinds are `CREATE TYPE`, `CREATE TABLE`, `ALTER TABLE … ADD COLUMN`, `CREATE INDEX`, `CREATE UNIQUE INDEX`, the one `UPDATE` and the one `DROP INDEX` above. The only further exceptions are statements that another plan's section C names explicitly as non-additive (for example a replaced `BankAccount` unique index); each must be traceable to that text. Anything else (`DROP COLUMN`, `ALTER COLUMN … TYPE`, `DROP TABLE`, `ADD CONSTRAINT … FOREIGN KEY`) means the schema edit touched something it must not.
6. Safety argument, statement by statement:
   - New tables and enum types cannot affect existing rows.
   - New columns are nullable or have a constant default; on Postgres 15 `ADD COLUMN … DEFAULT <constant>` does not rewrite the table. The live tables hold one company, one user and no cap-table rows.
   - `Company.entityType` defaults to `CORPORATION`, so the live company behaves exactly as before until the owner switches it (F2).
   - The email index swap cannot fail on data: values that were globally unique are unique per company. The new index can only fail if two rows of the same company differ by letter case alone; the migration runs in one explicit transaction (`BEGIN;`/`COMMIT;` in the file), so a collision aborts it with nothing changed (the failed row in `_prisma_migrations` then needs `prisma migrate resolve --rolled-back`). Run `SELECT lower(email), count(*) FROM "Stakeholder" GROUP BY 1 HAVING count(*) > 1;` on production first (expected: zero rows).
   - No backfill is needed for any other column.
7. Run `node_modules/.bin/prisma migrate dev` (applies it locally), `node_modules/.bin/prisma generate`, commit `prisma/schema.prisma`, the migration folder and the regenerated `prisma/enums.ts`.
8. Rollback plan: the migration is forward-only. Because it is additive, the previous application image keeps working against the migrated database (the old Prisma client ignores unknown columns and tables), except that a duplicate stakeholder email across companies would no longer be rejected.

---
## D. Work packages

Common to every package:

- **Verification commands** (all must pass before commit; the pre-commit hook runs Biome):
  `node_modules/.bin/tsc --noEmit` · `node_modules/.bin/biome check ./src` · `node_modules/.bin/vitest run` · `SKIP_ENV_VALIDATION=1 NODE_ENV=production node_modules/.bin/next build`
- **Global do-not-touch list**: `prisma/schema.prisma` and `prisma/migrations/**` (F0, or a small additive migration as allowed in C1); `src/components/ui/**`; `src/lib/llc/**` (ECONOMICS); `src/server/auth.ts`; `src/lib/upload-authorization.ts` (the browser allow-list stays closed); every C-corp router and component not named in the package; `src/components/modals/index.ts`.
- **Conventions**: B1–B7. New procedures use `withLlcAccessControl` (F1) unless stated, declare `.meta({ policies })`, take `companyId` from `ctx.membership.companyId`, write their audit row inside the same transaction, and throw `TRPCError`.
- **UI conventions**: server component page → `requireLlc()` → `serverAccessControl().allow(...)` → `UnAuthorizedState` / `EmptyState` / content in `PageLayout` + `Card`, as in `src/app/(authenticated)/(dashboard)/[publicId]/stakeholders/page.tsx`. Tables follow `src/components/stakeholder/stakeholder-table.tsx` (TanStack table + `src/components/ui/data-table/*`). Forms use react-hook-form + `zodResolver` + `src/components/ui/form.tsx`, as in `src/components/modals/share-class/share-class-form.tsx`. Money inputs use `NumericFormat` from `react-number-format` (`thousandSeparator`, `decimalScale={2}`, `prefix="$"`) and submit `Math.round(floatValue * 100)`. After a mutation call `router.refresh()`. Loading state = disabled submit button with the existing spinner; error state = `toast.error(error.message)` (sonner).
- **Wire types** used below: `Cents = number` (integer), `Units = string` (6 dp), `Pct = string` (4 dp), `DateOnly = string` (`YYYY-MM-DD`).

Dependency and parallelism overview (details per package):

| Step | Sessions that can run in parallel |
|---|---|
| 1 | F0 |
| 2 | F1 |
| 3 | F2, F3, F4a, F5, F10a |
| 4 | F4b, F6a (also needs `E-lib`), F10b, F11a, F15 |
| 5 | F6b, F11b |
| 6 | F7a, F8a, F12a, F14 |
| 7 | F7b, F8b, F9, F12b, F13a |
| 8 | F13b |

Split packages: the package text below describes the whole package; its **Split** line says which files belong to session `a` and which to session `b`. Session `b` always depends on session `a` of the same package. Each session must leave the four verification commands green (session `a` may leave UI stubs in place).

`E-lib` = ECONOMICS package `E1` (no prerequisites), which delivers `src/lib/llc/business-days.ts` and `src/lib/llc/units.ts` (signatures in section E2).

File-ownership map (a file appears under exactly one package unless marked "then"; within a split package the **Split** line assigns files to `a` or `b`):

| Files | Owner |
|---|---|
| `prisma/**` | F0 |
| `src/lib/money.ts`, `src/lib/date-only.ts`, `src/lib/vocabulary.ts`, `src/server/entity.ts`, `src/providers/entity-provider.tsx`, `src/trpc/api/trpc.ts`, `src/trpc/api/root.ts`, `src/lib/rbac/subjects.ts`, `src/server/audit/schema.ts`, `src/server/tenant-ownership.ts` (+test), `src/server/llc/serialize.ts`, stub files and FOUNDATION placeholder pages listed in F1, `src/components/llc/coming-soon.tsx` | F1 (placeholder pages then F3, F7, F10, F12) |
| `src/components/dashboard/sidebar/**`, `src/components/dashboard/navbar/**`, `[publicId]/layout.tsx`, `src/components/settings/settings-sidebar.tsx`, `src/trpc/routers/company-router/**`, `src/trpc/routers/onboarding-router/router.ts`, `[publicId]/settings/llc/**`, `src/server/llc/seed-unit-classes.ts`, the five guard layouts, the E/G placeholder pages | F2 (placeholder pages then E/G; `[publicId]/layout.tsx` then F15) |
| `src/trpc/routers/unit-class-router/**`, `[publicId]/unit-classes/**`, `src/components/llc/unit-class/**` | F3 |
| `src/trpc/routers/stakeholder-router/**`, `[publicId]/stakeholders/**`, `src/components/llc/member/**` except the two tab files, `src/trpc/routers/document-router/procedures/create-document.ts`, `src/server/api/routes/stakeholder/create.ts` and `update.ts` | F4 (router and `stakeholders/page.tsx` then F14) |
| `src/lib/admission/commitment-rules.ts` (+test) | F5 |
| `src/server/llc/commitments.ts`, `src/server/llc/positions.ts`, `src/trpc/routers/commitment-router/**` | F6 (`commitments.ts` then two guard calls by ECONOMICS E9; `positions.ts` then GOVERNANCE G16b) |
| `[publicId]/commitments/**`, `src/components/llc/commitment/**`, `src/components/llc/member/commitments-tab.tsx` | F7 |
| `src/lib/admission/member-schedule.ts` (+test), `src/lib/admission/member-schedule-csv.ts` (+test), `src/server/llc/member-schedule.ts`, `src/trpc/routers/member-schedule-router/**`, `[publicId]/captable/**`, `src/pdf-templates/member-schedule-template.tsx`, `src/components/llc/schedule/**` | F8 |
| `[publicId]/page.tsx`, `src/components/llc/overview/**` except `economics-slot.tsx` | F9 |
| `src/server/mailer.ts`, `src/lib/mail-catcher.ts`, `src/lib/email-recipients.ts`, `src/jobs/*-email.ts`, `src/jobs/esign-complete-pdf.ts` (then one line by F11a), job emitters named in F10, `src/trpc/routers/email-log-router/**`, `[publicId]/emails/**`, `src/components/llc/member/emails-tab.tsx`, `src/components/llc/email/**` | F10 |
| `src/trpc/routers/template-router/**`, `src/trpc/routers/template-field-router/**`, `src/services/esign-service.ts`, `src/server/esign.ts`, `src/jobs/esign-pdf.ts`, `src/lib/jwt.ts`, `src/lib/esign/**`, `src/providers/template-field-provider.tsx`, `src/components/template/**`, `[publicId]/documents/esign/**` | F11 (`sign-template.ts`, `signing-field-form/index.tsx` then F12; `src/server/esign.ts` then F13) |
| `src/trpc/routers/admission-router/**`, `[publicId]/admissions/page.tsx`, `src/components/llc/admission/**`, `src/app/(documents)/w9/**`, `src/server/file-uploads.ts`, `src/constants/job.ts`, `src/jobs/admission-notice-email.ts`, `src/jobs/register.ts`, `src/emails/AdmissionNoticeEmail.tsx` | F12 (router then F13) |
| `src/lib/admission/exhibit-b-answers.ts` (+test), `[publicId]/admissions/[templatePublicId]/**`, `src/components/llc/admission/confirm/**` | F13 |
| `src/lib/admission/exhibit-a-csv.ts` (+test), `src/components/llc/member/import-exhibit-a-dialog.tsx`, `src/trpc/routers/stakeholder-router/procedures/import-exhibit-a.ts` | F14 |
| `src/proxy.ts`, `src/app/(authenticated)/switch/**` | F15 |

`[publicId]` abbreviates `src/app/(authenticated)/(dashboard)/[publicId]`.

---

### F0 — Schema (single migration for all three areas)

- **Goal**: land every schema change of all three plans in one migration.
- **Prerequisites**: section C of `01-foundation.md`, `02-economics.md` and `03-governance.md` are final. Read all three before editing the schema.
- **Files**: modify `prisma/schema.prisma`; create `prisma/migrations/<timestamp>_llc_mode/migration.sql`; regenerate `prisma/enums.ts`.
- **Steps**: exactly C5, steps 1–7. After step 2 run `node_modules/.bin/prisma validate`; it must pass before generating the migration. If two plans define the same enum, model or column differently, stop and report instead of choosing.
- **Code fallout to fix in this package** (only what `tsc` reports): none is expected; `Stakeholder` is never looked up by email (`findUnique` is used by id only, `src/server/api/routes/stakeholder/getOne.ts:61`). If `prisma/seeds/**` fails to type-check, fix the seed only.
- **Acceptance**:
  - `migration.sql` contains no `FOREIGN KEY`, no `DROP` other than `DROP INDEX "Stakeholder_email_key"`, and the three email statements in the order of C5.4.
  - On a database that has the old schema plus two stakeholders with the same lower-cased email in different companies, `prisma migrate deploy` succeeds; with the same email twice in one company it fails and leaves the database unchanged.
  - `prisma/enums.ts` exports every enum of C2.
  - Date-only round trip: with a throwaway script (not committed) write `finalClosingDate: new Date("2026-11-30T00:00:00.000Z")` on a `UnitClass` and read it back; `toISOString().slice(0, 10)` must be `"2026-11-30"` when the script runs with `TZ=America/Denver` and with `TZ=Asia/Tokyo`, and `SELECT "finalClosingDate"::text` must show `2026-11-30`. If not, stop and report (convention B3 depends on it).
  - All four verification commands pass.
- **Do not touch**: anything under `src/` except seed fixes.

---

### F1 — Shared conventions, gating, registries

- **Goal**: everything other packages import, and every edit to a shared hotspot file.
- **Prerequisites**: F0.
- **Create**:
  1. `src/lib/money.ts` (pure; imports only `zod`)
     - `CENTS_MAX = 1_000_000_000_000`
     - `parseDollarsToCents(text: string): bigint | null` — trim; strip one leading `$`, all commas and inner spaces; must then match `/^\d+(\.\d{1,2})?$/`; else `null`.
     - `formatCents(cents: bigint | number): string` — `"$1,234,567.89"`, negative as `"-$40,000.00"`. Implement with integer math on `bigint` (no floats).
     - `centsToNumber(b: bigint): number` — throws `RangeError` when `|b| > Number.MAX_SAFE_INTEGER`.
     - `numberToCents(n: number): bigint` — throws `RangeError` unless `Number.isSafeInteger(n)`.
     - `mulBpsCeil(cents: bigint, bps: number): bigint` = `(cents * BigInt(bps) + 9999n) / 10000n`.
     - `mulDivRoundHalfUp(a: bigint, b: bigint, c: bigint): bigint` = `(2n * a * b + c) / (2n * c)` (`c > 0`).
     - `ZCents = z.number().int().min(0).max(CENTS_MAX)`.
  2. `src/lib/date-only.ts` (pure; imports only `zod`)
     - `isValidDateOnly(s: string): boolean` — regex `^\d{4}-\d{2}-\d{2}$` and round-trips through `Date.UTC`.
     - `ZDateOnly = z.string().refine(isValidDateOnly, "Use the format YYYY-MM-DD")`.
     - `toDateOnly(d: Date): string` = `d.toISOString().slice(0, 10)`; `fromDateOnly(s: string): Date` = `new Date(s + "T00:00:00.000Z")`, throws on invalid input.
     - `todayInTimeZone(timeZone: string, now: Date = new Date()): string` — `new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)` reassembled as `YYYY-MM-DD`.
     - `compareDateOnly(a, b): -1 | 0 | 1` (string comparison); `maxDateOnly(a, b)`; `minDateOnly(a, b)`; `diffInDays(from, to): number` (`to − from` in whole days).
     - `formatDateOnly(s: string): string` — `"Nov 30, 2026"` via `Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" })`.
     - `isValidTimeZone(tz: string): boolean` — `try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true } catch { return false }`.
  3. `src/lib/vocabulary.ts` (pure): `getVocabulary(entityType: "CORPORATION" | "LLC")` returning `{ holder, holders, unit, units, unitClass, unitClasses, schedule }` = `Stakeholder/Stakeholders/Share/Shares/Share class/Share classes/Cap table` for CORPORATION and `Member/Members/Unit/Units/Unit class/Unit classes/Member schedule` for LLC.
  4. `src/server/entity.ts` (`import "server-only"`):
     - `getSessionEntity = cache(async () => …)`: `withServerComponentSession()` → `db.company.findUniqueOrThrow({ where: { id: session.user.companyId }, select: { id, publicId, name, entityType, timezone } })` → returns that plus `isLlc: boolean`.
     - `requireLlc()`: returns the entity, or `redirect("/" + publicId)` when not LLC. `requireCorporation()`: the mirror image.
     - `assertLlcCompany(tx, companyId): Promise<void>` — loads `entityType` and throws `TRPCError` `FORBIDDEN` unless it is `LLC` (for jobs and public procedures that have no `withLlcAccessControl` context).
  5. `src/providers/entity-provider.tsx` (`"use client"`): context `{ entityType, isLlc, timezone, companyName }`; `EntityProvider`, `useEntity()`, `useVocabulary()`.
  6. `src/server/llc/serialize.ts`: `unitsToWire(d: { toFixed(n: number): string } | null | undefined): string` (`"0.000000"` for null), `dateToWire(d: Date | null): string | null`, `trimUnits(s: string): string` (`"40.200000"` → `"40.2"`, `"100.000000"` → `"100"`).
  7. Empty routers, each `export const xRouter = createTRPCRouter({});` in `src/trpc/routers/unit-class-router/router.ts` (`unitClassRouter`), `commitment-router/router.ts` (`commitmentRouter`), `member-schedule-router/router.ts` (`memberScheduleRouter`), `admission-router/router.ts` (`admissionRouter`), `email-log-router/router.ts` (`emailLogRouter`).
  8. Stub components (later owners fill them; keep the prop types): `src/components/llc/member/commitments-tab.tsx` and `src/components/llc/member/emails-tab.tsx` (server components, NOT `async` while they await nothing, props `{ stakeholderId: string }`, render an `Alert` "Nothing here yet"); `src/components/llc/overview/economics-slot.tsx` (server component, no props, returns `null`, with a comment "ECONOMICS: render accrued return, next distribution, reserve here").
  9. `src/components/llc/coming-soon.tsx`: `ComingSoon({ title, owner }: { title: string; owner: "FOUNDATION" | "ECONOMICS" | "GOVERNANCE" })` rendering `EmptyState` with the title and "This section is being built."
  10. FOUNDATION placeholder pages that later sessions replace: `[publicId]/unit-classes/page.tsx`, `commitments/page.tsx`, `admissions/page.tsx` (each `await requireLlc(); return <ComingSoon … owner="FOUNDATION" />`) and `[publicId]/emails/page.tsx` (no entity gate: `return <ComingSoon title="Email log" owner="FOUNDATION" />`, not `async`).
- **Modify**:
  - `src/trpc/api/trpc.ts`: export `withLlcAccessControl = withAccessControl.use(async ({ ctx, next }) => { const company = await ctx.db.company.findUnique({ where: { id: ctx.membership.companyId }, select: { id: true, publicId: true, name: true, entityType: true, timezone: true } }); if (!company || company.entityType !== "LLC") throw new TRPCError({ code: "FORBIDDEN", message: "This feature is available for LLC companies only." }); return next({ ctx: { ...ctx, company } }); })`. Nothing else in the file changes.
  - `src/trpc/api/root.ts`: register `unitClass`, `commitment`, `memberSchedule`, `admission`, `emailLog`.
  - `src/lib/rbac/subjects.ts`: append `"unit-classes"`, `"commitments"`, `"emails"`. Confirm the role editor (`src/components/modals/role-create-update-modal.tsx`) lists them without further change; if it has a hard-coded label map, add labels "Unit classes", "Commitments", "Emails".
  - `src/server/audit/schema.ts`: add the actions and target types of B30.
  - `src/server/tenant-ownership.ts`: add `"unitClass" | "commitment" | "capitalReceipt" | "template"` to `CompanyScopedEntity`, `unitClassIds`, `commitmentIds`, `capitalReceiptIds`, `templateIds` to `CompanyOwnedRefs`, the four entries to the `scoped` list and four `case`s to `getOwnedIds`.
- **Registrations for GOVERNANCE** (so its packages do not edit the hotspot files again; G4 checks and skips what exists):
  - Empty router stubs, each `export const <name> = createTRPCRouter({});`, registered in `src/trpc/api/root.ts` under the given key: `resolution` → `resolutionRouter` (`src/trpc/routers/resolution-router/router.ts`), `ballot` → `ballotRouter` (`ballot-router/router.ts`), `memberReport` → `memberReportRouter` (`member-report-router/router.ts`), `memberReportView` → `memberReportViewRouter` (`member-report-view-router/router.ts`), `compliance` → `complianceRouter` (`compliance-router/router.ts`), `unitTransfer` → `unitTransferRouter` (`unit-transfer-router/router.ts`), `books` → `booksRouter` (`books-router/router.ts`), `governance` → `governanceRouter` (`governance-router/router.ts`). These eight files belong to GOVERNANCE from then on.
  - `src/lib/rbac/subjects.ts`: also append `"governance"`.
  - `src/server/audit/schema.ts`: also add actions `resolution.created, resolution.updated, resolution.deleted, resolution.sent, resolution.approved, resolution.withdrawn, resolution.effective, resolution.failed, resolution.expired, resolution.filed, resolution.copy-delivered, ballot.issued, ballot.link-replaced, ballot.link-revoked, ballot.reminded, ballot.submitted, ballot.deemed, memberReport.created, memberReport.updated, memberReport.deleted, memberReport.sent, memberReport.resent, memberReport.filed, compliance.created, compliance.updated, compliance.completed, compliance.reopened, unitTransfer.created, unitTransfer.updated, unitTransfer.completed, unitTransfer.cancelled, unitTransfer.admitted, document.categorized`; actor types `stakeholder`, `system`; target types `resolution, ballot, memberReport, complianceDeadline, unitTransfer`.
  - ECONOMICS' routers, subjects (`capital-calls`, `distributions`, `llc-financials`, `llc-terms`) and audit actions are added here in the same way once `02-economics.md` lists them; if its list is not in that file when F1 runs, ECONOMICS appends them in its first package. Resolved 2026-11-12: F1 registers nothing for ECONOMICS; package E6 of `02-economics.md` owns its router stubs, subjects and audit values.
- **Unit tests**:
  - `src/lib/money.test.ts`: `"100,000"` → `10000000n`; `"$100,000.00"` → `10000000n`; `" 250000 "` → `25000000n`; `"1000.5"` → `100050n`; `"100.005"`, `"-5"`, `"abc"`, `""` → `null`; `formatCents(0)` = `"$0.00"`; `formatCents(123456789n)` = `"$1,234,567.89"`; `formatCents(-4000000n)` = `"-$40,000.00"`; `mulBpsCeil(25000000n, 4000)` = `10000000n`; `mulBpsCeil(10000001n, 4000)` = `4000001n`; `mulDivRoundHalfUp(8000000n, 10000000n, 20000000n)` = `4000000n`; `mulDivRoundHalfUp(1n, 1n, 2n)` = `1n`; `centsToNumber(2n ** 60n)` throws.
  - `src/lib/date-only.test.ts`: `todayInTimeZone("America/Denver", new Date("2026-12-01T02:30:00Z"))` = `"2026-11-30"`; same instant with `"UTC"` = `"2026-12-01"`; `diffInDays("2026-11-12", "2026-11-30")` = `18`; `isValidDateOnly("2026-02-30")` = `false`; `toDateOnly(fromDateOnly("2027-03-31"))` = `"2027-03-31"`; `formatDateOnly("2026-11-30")` = `"Nov 30, 2026"`; `isValidTimeZone("Mars/Olympus")` = `false`.
  - `src/server/tenant-ownership.test.ts`: add one case per new entity (owned id passes, foreign id returns that entity name), following the existing in-memory loader pattern.
- **Acceptance**: the five routers appear in `AppRouter`; a custom role without the new subjects is denied by a procedure with `{ commitments: { allow: ["read"] } }` (covered by the existing RBAC semantics; add one case to `src/lib/rbac/rbac.test.ts`); no behaviour change for CORPORATION companies.
- **Do not touch**: procedure definitions other than adding `withLlcAccessControl`.

---

### F2 — LLC mode switch, navigation, placeholders

- **Goal**: a company can be LLC; LLC companies see LLC navigation and never see C-corp pages.
- **Prerequisites**: F1.
- **Create**:
  - `src/server/llc/seed-unit-classes.ts`: `ensureDefaultUnitClasses(tx, companyId): Promise<void>` — loads existing classes of the company and creates only the missing kind(s):
    - PREFERRED: `name "Preferred Units"`, `pricePerUnitCents 100000n`, `authorizedUnits null`, `fractionalUnitsAllowed true`, `votesPerUnit 1`, `prefReturnBps 800`, `prefReturnDayCount ACTUAL_365`, `balanceReturnStartRule LATER_OF_RECEIPT_AND_DUE`, `residualSplitBps 7000`, `minCommitmentCents 10000000n`, `minCommitmentFloorCents 5000000n`, `offeringCapCents 200000000n`, `initialInstallmentBps 4000`, `acceptanceBusinessDays 10`, `refundBusinessDays 5`, `finalClosingDate null`, `balanceOutsideDate null`.
    - COMMON: `name "Common Units"`, `pricePerUnitCents null`, `authorizedUnits 100`, `fractionalUnitsAllowed false`, `votesPerUnit 0`, `prefReturnBps 0`, `residualSplitBps 3000`, all offering fields null, `initialInstallmentBps 4000` (unused).
  - `src/components/dashboard/sidebar/nav-config.ts`: `getNavSections(entityType)` and `getCompanyNav(entityType)`.
    - CORPORATION: one untitled section with exactly today's `navigation` array (`sidebar/index.tsx:45-164`); company nav = today's `company` array (`:166-197`).
    - LLC sections (name → href):
      - untitled: Overview `/`, Member schedule `/captable`, Members `/stakeholders`, Unit classes `/unit-classes`
      - "Capital": Admissions `/admissions`, Commitments `/commitments`, Capital calls `/capital-calls`
      - "Operations": Distributions `/distributions`, Financials `/financials` with `subNav` Revenue `/revenue`, Manager payments `/manager-payments`, Reserves `/reserves`, Loans and advances `/loans-advances`; Fair value `/fair-value`
      - "Governance": Resolutions `/resolutions`, Transfers `/transfers`, Compliance `/compliance`, Reports `/reports`
      - "Communication": Documents (today's `subNav` plus Books and records `/books`), Updates `/updates`, Email log `/emails`, Audits `/audits`
      - company nav: Team, Settings only (no Form 3921, no 409A Valuation).
    - Reuse the Remix icons already imported in `sidebar/index.tsx`; pick any existing pair for new items.
  - Placeholder pages, each `await requireLlc(); return <ComingSoon … />`: `[publicId]/capital-calls/page.tsx`, `distributions/page.tsx`, `fair-value/page.tsx`, `financials/revenue/page.tsx`, `financials/manager-payments/page.tsx`, `financials/reserves/page.tsx`, `financials/loans-advances/page.tsx` (owner ECONOMICS); `resolutions/page.tsx`, `transfers/page.tsx`, `compliance/page.tsx`, `documents/books/page.tsx` (owner GOVERNANCE). The FOUNDATION placeholders and `ComingSoon` already exist from F1; do not touch them.
  - Guard layouts (new files, each `export default async function Layout({ children }) { await requireCorporation(); return children; }`): `[publicId]/share-classes/layout.tsx`, `equity-plans/layout.tsx`, `securities/layout.tsx`, `fundraise/layout.tsx`, `(legal)/layout.tsx`.
  - `[publicId]/settings/llc/page.tsx` (+ client component `src/components/llc/settings/entity-settings.tsx`): shows the current entity type; a "Switch to LLC" / "Switch to corporation" button behind an `AlertDialog` that explains B9; a time-zone select (`Intl.supportedValuesOf("timeZone")`); and, for LLC companies, a marked comment slot `{/* ECONOMICS: LlcTerm form goes here */}`. Gate with `allow(…, ["company", "update"])`.
- **Modify**:
  - `src/components/dashboard/sidebar/index.tsx`: add prop `entityType`; render `getNavSections(entityType)` (a section title uses the same style as the existing "Company" label at `:308-310`); keep the item/accordion rendering and active-state logic as is.
  - `src/components/dashboard/navbar/index.tsx` and `mobile-drawer.tsx`: pass `entityType` through.
  - `[publicId]/layout.tsx`: `const entity = await getSessionEntity()`; wrap children in `<EntityProvider value={{ entityType, isLlc, timezone, companyName }}>`; pass `entityType` to `SideBar` and `NavBar`.
  - `src/components/settings/settings-sidebar.tsx`: add item "Entity and LLC terms" → `/settings/llc` to `companyNav`.
  - `[publicId]/reports/page.tsx`: when `(await getSessionEntity()).isLlc` return `<ComingSoon title="Member reports" owner="GOVERNANCE" />`, else the existing stub.
  - `src/trpc/routers/company-router/router.ts`:
    - `getCompany`: add `entityType`, `timezone` to the company select.
    - new `setEntityType`: `withAccessControl`, policy `company: update`, input `z.object({ entityType: z.enum(["CORPORATION", "LLC"]) })`, output `{ entityType }`. In one transaction: load the company by `ctx.membership.companyId`; no-op if unchanged; to LLC → `BAD_REQUEST` "Remove existing shares, options, SAFEs, convertible notes and investments before switching to LLC." if any of `share`, `option`, `safe`, `convertibleNote`, `investment` has a row for the company; to CORPORATION → `BAD_REQUEST` "This company has LLC commitments and cannot be switched back." if any `commitment` row exists; update; when LLC call `ensureDefaultUnitClasses`; audit `company.entity-type-changed`, target `{ type: "company", id }`, summary `"<user> changed the entity type of <company> to LLC"`.
    - new `setTimezone`: same auth, input `{ timezone: z.string().refine(isValidTimeZone) }`, audit `company.updated`.
  - `src/trpc/routers/onboarding-router/router.ts`: in `onboard`, add `entityType: input.company.incorporationType === "llc" ? "LLC" : "CORPORATION"` to the `company.create` data and call `ensureDefaultUnitClasses(tx, company.id)` when LLC. `company.updateCompany` is NOT changed (editing `incorporationType` later does not change `entityType`).
- **States**: settings page — unauthorised (`UnAuthorizedState`), mutation pending (button disabled), rule error (toast with the message above). After a switch: `await update()` is not needed (entity type is not in the JWT); call `router.refresh()`.
- **Unit tests**: `src/components/dashboard/sidebar/nav-config.test.ts` (pure, relative imports; keep icon imports out of the tested function by returning icon keys, or test only names/hrefs): LLC sections contain none of `/share-classes`, `/equity-plans`, `/securities`, `/fundraise`; LLC company nav has no `/3921` or `/409a`; every LLC href is unique; CORPORATION navigation names equal the current list `["Overview","Cap table","Stakeholders","Share classes","Equity plans","Securities","Fundraise","Documents","Updates","Reports","Audits"]`.
- **Acceptance**:
  - The live company (CORPORATION, no securities) can be switched to LLC in Settings → Entity and LLC terms; afterwards exactly two `UnitClass` rows exist; switching twice does not duplicate them.
  - As LLC: the sidebar shows the sections above; `/[publicId]/share-classes`, `/equity-plans`, `/securities/shares`, `/securities/options`, `/securities/transactions`, `/fundraise/safes`, `/fundraise/convertible-notes`, `/fundraise/investments`, `/3921`, `/409a` redirect to the overview; every LLC nav link renders a page (no 404).
  - As CORPORATION: the sidebar is unchanged and every LLC route redirects to the overview, except `/emails` (the email log works for both entity types and is simply not linked for corporations) and `/settings/llc`.
  - Onboarding with "LLC - Limited Liability Company" creates an LLC company with two unit classes.
- **Do not touch**: `company.updateCompany`, `ZodOnboardingMutationSchema`, `src/components/onboarding/company-form.tsx`, any C-corp page file.

---

### F3 — Unit classes: router and settings page

- **Goal**: view and edit the two unit classes and their offering terms.
- **Prerequisites**: F1. (F2 provides the seed and nav; code does not depend on it.)
- **Create**: `src/trpc/routers/unit-class-router/schema.ts`, `router.ts` (replace the stub), `src/components/llc/unit-class/unit-class-card.tsx`, `unit-class-form-dialog.tsx`; replace `[publicId]/unit-classes/page.tsx`.
- **DTO** `UnitClassDTO`:
  `{ id, name, kind: "PREFERRED" | "COMMON", pricePerUnitCents: Cents | null, authorizedUnits: Units | null, issuedUnits: Units, fractionalUnitsAllowed: boolean, votesPerUnit: Units, prefReturnBps: number, prefReturnDayCount: "ACTUAL_365", balanceReturnStartRule, residualSplitBps: number, minCommitmentCents: Cents | null, minCommitmentFloorCents: Cents | null, offeringCapCents: Cents | null, initialInstallmentBps: number, finalClosingDate: DateOnly | null, balanceOutsideDate: DateOnly | null, acceptanceBusinessDays: number, refundBusinessDays: number, termsLocked: boolean }`
  - `issuedUnits` = sum of `unitsIssued` over non-void receipts of the class. `termsLocked` = the class has a commitment with status `ACCEPTED`/`REDUCED` or a non-void receipt with `unitsIssued <> 0`.
- **Procedures**:
  - `unitClass.list` — policy `unit-classes: read`; no input; output `{ classes: UnitClassDTO[]; residualSplitTotalBps: number }`, ordered PREFERRED first. Scope: `where: { companyId }`.
  - `unitClass.update` — policy `unit-classes: update`; input: `{ id: string, name: string (1–60), pricePerUnitCents: ZCents.nullable(), authorizedUnits: string | null (regex ^\d+(\.\d{1,6})?$), fractionalUnitsAllowed: boolean, votesPerUnit: string (same regex), prefReturnBps: int 0–10000, balanceReturnStartRule, residualSplitBps: int 0–10000, minCommitmentCents: ZCents.nullable(), minCommitmentFloorCents: ZCents.nullable(), offeringCapCents: ZCents.nullable(), initialInstallmentBps: int 1–10000, finalClosingDate: ZDateOnly.nullable(), balanceOutsideDate: ZDateOnly.nullable(), acceptanceBusinessDays: int 1–60, refundBusinessDays: int 1–60, confirmAmendment: boolean (default false), amendmentReason: string optional }`; output `UnitClassDTO`.
    Rules (each a `BAD_REQUEST`):
    1. The class row is locked first with F6's `lockUnitClass` (the lock every ledger write takes), then loaded by `{ id, companyId }`, else `NOT_FOUND`; `termsLocked`, `issuedUnits` and the accepted total are read after the lock, so an update cannot race the first acceptance. `kind` is never editable.
    2. PREFERRED: `pricePerUnitCents` required and `> 0`; `minCommitmentCents`, `minCommitmentFloorCents`, `offeringCapCents` required; `0 < floor ≤ min ≤ cap`; `offeringCapCents ≥` Σ `acceptedCents` of the class's `ACCEPTED`/`REDUCED` commitments ("The offering cap cannot be set below the <total> already accepted (Section 4.8)."), even as an amendment. COMMON: `pricePerUnitCents`, the three amounts and both dates must be null; `authorizedUnits` required and `> 0`.
    3. `authorizedUnits`, when set, `≥ issuedUnits` ("Cannot authorize fewer units than are issued"), even as an amendment.
    4. When both dates are set: `finalClosingDate ≤ balanceOutsideDate`.
    5. Locked terms: when `termsLocked`, a change to any of `pricePerUnitCents, fractionalUnitsAllowed, votesPerUnit, prefReturnBps, balanceReturnStartRule, residualSplitBps, minCommitmentCents, minCommitmentFloorCents, offeringCapCents, initialInstallmentBps, authorizedUnits, finalClosingDate, balanceOutsideDate` requires `confirmAmendment === true` and `amendmentReason` of at least 10 characters; otherwise "These terms are fixed by the Operating Agreement once units are issued. Changing them requires an amendment under Section 12.1 (and, for Sections 4.8, 4.9 and 5.6, approval of 70% of the Disinterested Preferred Units). Confirm the amendment and give a reason." `name`, `acceptanceBusinessDays`, `refundBusinessDays` are never locked.
    Audit `unitClass.updated`, target `{ type: "unitClass", id }`, summary lists each changed field as `field: old → new` (money through `formatCents`) and the amendment reason when given.
- **Page** `/[publicId]/unit-classes`: `requireLlc()`; `allow(api.unitClass.list(), ["unit-classes", "read"])`; one card per class with a definition list of all terms (bps shown as percent, cents as dollars, dates via `formatDateOnly`) and an "Edit" button (`Allow subject="unit-classes" action="update"`). Banners (use `Alert`): "Final Closing Date is not set. Commitments cannot be accepted until it is." (PREFERRED, date null); "Balance outside date is not set. Balance payments cannot be recorded until it is."; "Residual splits add up to X%, expected 100%." when `residualSplitTotalBps !== 10000`. Empty state (no classes, should not happen): "No unit classes. Switch the company to LLC in Settings." Edit dialog: fields per kind; when `termsLocked`, locked fields are disabled until a checkbox "This change implements an approved amendment" is ticked, which reveals the reason textarea.
- **Worked examples (tests)** — put the pure validation in `src/trpc/routers/unit-class-router/rules.ts` (relative imports) and test in `rules.test.ts`:
  - floor 5,000,000 / min 10,000,000 / cap 200,000,000 → valid; floor 10,000,001 with min 10,000,000 → error.
  - closing `2026-11-30`, outside `2027-03-31` → valid; closing `2027-04-01`, outside `2027-03-31` → error.
  - locked, `prefReturnBps` 800 → 900 without confirmation → error; with `confirmAmendment` and a 10-character reason → valid; locked, `name` change only → valid.
  - COMMON with `pricePerUnitCents 100000` → error; COMMON `authorizedUnits "50"` with issued `"100.000000"` → error.
- **Acceptance**: the owner can set `finalClosingDate = 2026-11-30` and `balanceOutsideDate = 2027-03-31`; a second company's class id returns `NOT_FOUND`; an audit row is written per update.
- **Do not touch**: `src/server/llc/seed-unit-classes.ts`.

---

### F4 — Member records (Stakeholder extensions), member pages, documents

- **Goal**: LLC member list, add/edit, detail page with documents; per-company email handling everywhere.
- **Prerequisites**: F1.
- **Split**: **F4a** = everything under `src/trpc/routers/stakeholder-router/**`, `create-document.ts`, the two REST route files, and the schema test. **F4b** = `src/components/llc/member/**` (except the two tab stubs), `[publicId]/stakeholders/page.tsx` and `[publicId]/stakeholders/[stakeholderId]/page.tsx`.
- **Create**:
  - `src/trpc/routers/stakeholder-router/procedures/get-member.ts`, `create-member.ts`, `update-member.ts`, `set-member-status.ts`, `member-documents.ts`, `attach-document.ts`; `src/trpc/routers/stakeholder-router/member-schema.ts`.
  - `src/components/llc/member/member-table.tsx`, `member-form-dialog.tsx`, `member-profile-card.tsx`, `member-documents-tab.tsx`, `attach-document-dialog.tsx`.
  - `[publicId]/stakeholders/[stakeholderId]/page.tsx`.
- **Modify**:
  - `src/trpc/routers/stakeholder-router/router.ts`: register `getMember`, `createMember`, `updateMember`, `setMemberStatus`, `memberDocuments`, `attachDocument`.
  - `add-stakeholders.ts` (keep its `{ success, message }` envelope and policy): lower-case and trim every email; if two input rows share an email, or an email already exists for the company, return `{ success: false, message: "These emails already exist: a@x.com, b@y.com" }`; replace `createMany({ skipDuplicates })` with `createManyAndReturn({ data, select: { id: true, name: true } })`; write one awaited audit per returned row with its real id.
  - `update-stakeholder.ts`: lower-case/trim `email` when present; on Prisma error code `P2002` return `{ success: false, message: "Another stakeholder of this company already uses this email." }`.
  - `src/server/api/routes/stakeholder/create.ts` and `update.ts`: lower-case/trim `email` before writing (no other change).
  - `src/trpc/routers/document-router/procedures/create-document.ts`: `createDocumentHandler` accepts two new optional options `stakeholderId?: string` and `kind?: string`; when `stakeholderId` is given it is included in `assertCompanyOwns` (`stakeholderIds`) and both are written on the row. Existing callers are unaffected.
  - `[publicId]/stakeholders/page.tsx`: at the top `const entity = await getSessionEntity();` when `entity.isLlc` render the LLC branch below; otherwise the existing code unchanged.
- **Schema** (`member-schema.ts`): `ZMemberInput = z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(200), email: z.string().trim().toLowerCase().email(), holderType: z.enum(HolderTypeEnum values), residenceState: z.string().length(2).optional() (a code from `src/lib/states.ts`), accreditationBasis: z.enum(AccreditationBasisEnum values).optional(), signerName: z.string().trim().max(120).optional(), signerTitle: z.string().trim().max(120).optional(), noticeEmail: z.string().trim().toLowerCase().email().optional(), phone: z.string().trim().max(40).optional(), streetAddress, city, state (2-letter), zipcode: optional strings, isInsider: z.boolean() })` with refinement: `signerName` required when `holderType` is `TRUST` or `ENTITY`.
- **DTO** `MemberDTO`: `{ id, name, email, noticeEmail: string | null, effectiveNoticeEmail: string, holderType | null, residenceState | null, accreditationBasis | null, admittedOn: DateOnly | null, signerName | null, signerTitle | null, phone | null, streetAddress | null, city | null, state | null, zipcode | null, isInsider: boolean, memberStatus: "PROSPECT" | "MEMBER" | "FINANCIAL_INTEREST_ONLY", createdAt: string (ISO) }`. Never includes `taxId`.
- **Procedures** (all `withLlcAccessControl`):
  - `stakeholder.getMember` — policy `stakeholder: read`; input `{ id }`; output `MemberDTO`; `findFirst({ where: { id, companyId } })` else `NOT_FOUND`.
  - `stakeholder.createMember` — policy `stakeholder: create`; input `ZMemberInput` without `id`. `stakeholder.updateMember` — policy `stakeholder: update`; input `ZMemberInput` with `id` required. Both output `MemberDTO`. Create: `currentRelationship: "INVESTOR"`, `stakeholderType: holderType === "ENTITY" || holderType === "TRUST" ? "INSTITUTION" : "INDIVIDUAL"`, `institutionName: null`, `memberStatus: "PROSPECT"`. Update: `where: { id, companyId }`; never changes `memberStatus` or `admittedOn`. Duplicate email in the company (`P2002`) → `BAD_REQUEST` "Another member of this company already uses this email." Audit `stakeholder.added` / `stakeholder.updated`, target `{ type: "stakeholder", id }`.
  - `stakeholder.setMemberStatus` — policy `stakeholder: update`; input `{ id, memberStatus: "MEMBER" | "FINANCIAL_INTEREST_ONLY", reason: string (min 5) }`; allowed only between those two values (a `PROSPECT` becomes a member only through acceptance, F6) → otherwise `BAD_REQUEST`; audit `stakeholder.updated` with the reason. (Sections 1.8, 1.11, 7.9.2.)
  - `stakeholder.memberDocuments` — policies `stakeholder: read` and `documents: read`; input `{ stakeholderId }`; output `{ id, publicId, name, kind: string | null, createdAt, bucket: { id, key, mimeType, size } }[]`, `where: { companyId, stakeholderId }`, newest first.
  - `stakeholder.attachDocument` — policies `stakeholder: update` and `documents: create`; input `{ stakeholderId, bucketId, name: string (1–200), kind: z.enum(["exhibit-b", "w9", "wire-confirmation", "other"]) }`; calls `createDocumentHandler` (which verifies bucket and stakeholder ownership) inside a transaction with `uploaderId: membership.memberId`; audit `document.attached`, targets `[{ type: "document", id }, { type: "stakeholder", id }]`.
- **Pages**:
  - `/[publicId]/stakeholders` (LLC branch): title "Members", description "Members, prospects and holders of a financial interest"; data from the existing `api.stakeholder.getStakeholders()`; `MemberTable` columns: Name (link to detail), Type (`holderType`), Status badge (`Prospect` / `Member` / `Financial interest only`), Admitted (`formatDateOnly` or "—"), Notice email, Insider badge. Header action "Add member" (opens `MemberFormDialog`, `Allow subject="stakeholder" action="create"`). Empty state: "No members yet. Add a member or send a subscription from Admissions."
  - `/[publicId]/stakeholders/[stakeholderId]`: `requireLlc()`; `allow(api.stakeholder.getMember({ id }), ["stakeholder", "read"])`; `notFound()` on `NOT_FOUND`. Layout: header (name, status badge, insider badge, "Edit" button); `Tabs` (`src/components/ui/tabs.tsx`): **Profile** (`MemberProfileCard`: every `MemberDTO` field, with "Set as financial interest only" / "Restore member rights" behind a confirm dialog with a reason), **Commitments** (`<CommitmentsTab stakeholderId />` stub from F1), **Documents** (`MemberDocumentsTab`: table Name, Kind, Uploaded, Size, "Open" using `getPresignedGetUrl` from `@/server/file-upload-actions` as `[publicId]/documents/components/table.tsx` does; "Attach document" dialog: file picker → `uploadFile(file, { identifier: companyPublicId, keyPrefix: "generic-documents" })` → `api.bucket.create` with `tags: [TAG.GENERIC]` → `stakeholder.attachDocument`), **Emails** (`<EmailsTab stakeholderId />` stub from F1).
- **Validation notes shown in the form** (non-blocking helper text): "Net worth / income / license bases apply to individuals; entity bases to entities; the trust basis to trusts." (Section 3.2, Exhibit B §1.)
- **Unit tests**: `src/trpc/routers/stakeholder-router/member-schema.test.ts` (relative imports; build the enum value lists as literal arrays in the schema file so no `@/prisma/enums` runtime import is needed): email `"  Jane@Example.COM "` → `"jane@example.com"`; `holderType: "ENTITY"` without `signerName` → error; with → ok; `residenceState: "Kentucky"` → error; `"KY"` → ok.
- **Acceptance**: the same email can be added in two companies; adding it twice in one company is refused with a message (tRPC and REST); a member of company A cannot open `/stakeholders/<id of company B>` (404); an attached PDF opens through a presigned URL; the C-corp stakeholders page renders exactly as before.
- **Do not touch**: `src/components/stakeholder/**`, `src/components/modals/stakeholder/**`, `src/lib/stakeholders-csv-parser.ts`.

---

### F5 — Commitment and receipt rules (pure library)

- **Goal**: every admission rule as a pure, tested function.
- **Prerequisites**: F1 (`money.ts`, `date-only.ts`). No database, no `E-lib` (business-day and unit functions are injected).
- **Create**: `src/lib/admission/commitment-rules.ts`, `src/lib/admission/commitment-rules.test.ts`. Relative imports only.
- **Types**:

```ts
export type RuleCode =
  | "TERMS_INCOMPLETE" | "AMOUNT_INVALID" | "DATE_ORDER" | "AFTER_FINAL_CLOSING"
  | "BELOW_FLOOR" | "MINIMUM_WAIVER_REQUIRED" | "CAP_EXCEEDED"
  | "INITIAL_INSTALLMENT_SHORT" | "KEEP_OUT_OF_RANGE" | "OVERPAYMENT" | "NOT_OPEN";
export type RuleError = { code: RuleCode; message: string };
export type OfferingTerms = {
  minCommitmentCents: bigint | null; minCommitmentFloorCents: bigint | null;
  offeringCapCents: bigint | null; initialInstallmentBps: number;
  finalClosingDate: string | null; balanceOutsideDate: string | null;
  acceptanceBusinessDays: number; refundBusinessDays: number;
  prefReturnBps: number; balanceReturnStartRule: "LATER_OF_RECEIPT_AND_DUE" | "RECEIPT_DATE";
};
export type HeldReceipt = { id: string; receivedOn: string; amountCents: bigint };
export type AddBusinessDays = (date: string, n: number) => string;
```

- **Functions and rules**:
  1. `requiredInitialInstallmentCents(acceptedCents, bps)` = `mulBpsCeil(acceptedCents, bps)`. (Section 4.9(a).)
  2. `defaultKeepCents({ heldCents, acceptedCents, committedCents })` = `min(acceptedCents, mulDivRoundHalfUp(heldCents, acceptedCents, committedCents))`. (B18.)
  3. `validateAcceptance(input): RuleError[]` with `input = { terms, committedCents, acceptedCents, acceptedOn, signedOn: string | null, today, heldCents, keepCents, otherAcceptedCents, minimumWaived, isReplacement, skipClosingDateCheck }`. Returns all violations, checked in this order:
     - `TERMS_INCOMPLETE` "Set the minimum, cap and Final Closing Date of the unit class first." when `minCommitmentCents`, `minCommitmentFloorCents`, `offeringCapCents` or `finalClosingDate` is null (return immediately).
     - `AMOUNT_INVALID` "The accepted amount must be more than zero and not more than the amount committed." unless `0 < accepted ≤ committed`.
     - `DATE_ORDER` "The acceptance date cannot be in the future." when `acceptedOn > today`; "The acceptance date cannot be before the signature date." when `signedOn` is set and `acceptedOn < signedOn`.
     - `AFTER_FINAL_CLOSING` "No Preferred Member may be admitted after the Final Closing Date (<date>) (Section 4.8)." when `acceptedOn > finalClosingDate` and neither `isReplacement` nor `skipClosingDateCheck`.
     - Minimum (skipped when `isReplacement`): `accepted < floor` → `BELOW_FLOOR` "The minimum Capital Contribution cannot be waived below <floor> (Section 3.7)."; `floor ≤ accepted < min` and not `minimumWaived` → `MINIMUM_WAIVER_REQUIRED` "<accepted> is below the <min> minimum. Tick the waiver to admit at not less than <floor> (Section 3.7)."
     - `CAP_EXCEEDED` "Accepting <accepted> would exceed the <cap> cap; <remaining> remains (Section 4.8)." when `otherAccepted + accepted > cap`.
     - `INITIAL_INSTALLMENT_SHORT` "Received <held>; at least <required> (<pct>% of the accepted amount) must be received before acceptance (Section 4.9)." when `held < required` (skipped when `isReplacement`: a Replacement Funder's commitment is accepted with no held cash and funded immediately afterwards by a `REPLACEMENT` receipt).
     - `KEEP_OUT_OF_RANGE` "The amount kept must be between <required> and <max>." unless `required ≤ keep ≤ min(held, accepted)` (only checked when not `INITIAL_INSTALLMENT_SHORT`; when `isReplacement` the lower bound is 0, so `keep = 0` with `held = 0` is valid).
  4. `allocateHeldReceipts(receipts: HeldReceipt[], keepCents): { id: string; appliedCents: bigint }[]` — sort by `receivedOn` then `id`; apply `min(amount, remaining)` in order; every receipt appears in the result (possibly with `0n`).
  5. `refundDueCents(heldCents, keepCents)` = `held − keep`.
  6. `decisionStatus(acceptedCents, committedCents)`: `"ACCEPTED"` when equal, `"REDUCED"` when `0 < accepted < committed`.
  7. `computeSubscriptionClock({ signedOn, committedCents, initialInstallmentBps, receipts, acceptanceBusinessDays, refundBusinessDays, finalClosingDate }, addBusinessDays)` → `{ clockStart, acceptanceDeadline, effectiveDecisionDeadline, refundDueBy }` (each `string | null`): `threshold = mulBpsCeil(committed, bps)`; walk receipts in (`receivedOn`, `id`) order; `installmentOn` = `receivedOn` of the receipt at which the running total first reaches `threshold`; if `signedOn` or `installmentOn` is missing → all null; `clockStart = max(signedOn, installmentOn)`; `acceptanceDeadline = addBusinessDays(clockStart, acceptanceBusinessDays)`; `effectiveDecisionDeadline = min(acceptanceDeadline, finalClosingDate)` (just `acceptanceDeadline` when the closing date is null); `refundDueBy = addBusinessDays(acceptanceDeadline, refundBusinessDays)`. (Section 4.8.)
  8. `deriveReceiptKind({ status, acceptedOn, receivedOn })`: `PENDING` → `"INITIAL"`; `ACCEPTED`/`REDUCED` → `receivedOn <= acceptedOn ? "INITIAL" : "BALANCE"`; `REJECTED` → throws (`NOT_OPEN`). (B16.)
  9. `prefReturnStartDate({ kind, receivedOn, dueDate, terms })`: returns `null` when `terms.prefReturnBps === 0`; `INITIAL`, `REPLACEMENT`, `CREDIT` → `receivedOn`; `BALANCE` with rule `RECEIPT_DATE` → `receivedOn`; `BALANCE` with rule `LATER_OF_RECEIPT_AND_DUE` → `max(receivedOn, dueDate ?? terms.balanceOutsideDate)`, and `undefined` (caller raises `TERMS_INCOMPLETE` "Set the Balance outside date of the unit class first.") when both are null; `FORFEITURE` → `null`. (Sections 4.9, 5.6(b); B17.)
  10. `validateCashReceipt({ status, acceptedCents, cashAppliedCents, amountCents, receivedOn, today })`: `NOT_OPEN` for `REJECTED`; `AMOUNT_INVALID` when `amount ≤ 0`; `DATE_ORDER` when `receivedOn > today`; for decided commitments `OVERPAYMENT` "Only <balance> of the Balance is outstanding." when `cashApplied + amount > accepted`. For `PENDING` commitments there is no upper limit (excess is refunded at the decision).
  11. `outstandingBalanceCents(acceptedCents, cashAppliedCents)` = `max(0, accepted − cashApplied)`, where "cash applied" sums `appliedCents` of non-void `INITIAL`, `BALANCE` and `REPLACEMENT` receipts (never `CREDIT` or `FORFEITURE`).
- **Worked examples = test cases** (terms unless stated: min $100,000, floor $50,000, cap $2,000,000, 40%, closing `2026-11-30`, `today = 2026-11-20`, `acceptedOn = 2026-11-20`, `otherAccepted = 0`, keep = default):

| # | Input | Expected |
|---|---|---|
| A1 | committed 250,000; accepted 250,000; held 100,000 | valid; keep 100,000; refund 0; status `ACCEPTED`; Balance 150,000 |
| A2 | as A1, held 99,999.99 | `INITIAL_INSTALLMENT_SHORT` (required 100,000.00) |
| A3 | committed = accepted = held = 100,000 | valid; keep 100,000; Balance 0 |
| A4 | committed = accepted = 75,000; held 30,000; not waived | `MINIMUM_WAIVER_REQUIRED` |
| A5 | as A4, waived | valid; keep 30,000 |
| A6 | committed = accepted = 49,999.99; waived | `BELOW_FLOOR` |
| A7 | otherAccepted 1,950,000; committed = accepted = 100,000; held 40,000 | `CAP_EXCEEDED` (remaining 50,000.00) |
| A8 | otherAccepted 1,950,000; committed 100,000; accepted 50,000; waived; held 40,000 | valid; default keep 20,000; refund 20,000; status `REDUCED` |
| A9 | committed 200,000; accepted 100,000; held 80,000 | valid; default keep 40,000; refund 40,000 |
| A10 | as A9 with `keepCents` 80,000 | valid; refund 0 |
| A11 | as A9 with `keepCents` 39,999.99 | `KEEP_OUT_OF_RANGE` (40,000.00 to 80,000.00) |
| A12 | A1 with `acceptedOn 2026-12-01`, `today 2026-12-01` | `AFTER_FINAL_CLOSING` |
| A13 | A1 with `acceptedOn 2026-11-30`, `today 2026-12-15` | valid (entered after the fact) |
| A14 | A12 with `isReplacement` | valid as to the closing date and minimum |
| A14b | `isReplacement`, committed = accepted = 30,000, held 0, keep 0, `acceptedOn 2027-04-10`, `today 2027-04-10` | valid (no minimum, no closing-date, no initial-installment check); cap still applies |
| A15 | committed = accepted = 100,000; held 120,000 | valid; default keep 100,000; refund 20,000 |
| A16 | accepted 100,000.01 | `requiredInitialInstallmentCents` = 40,000.01 |
| A17 | otherAccepted 1,900,000; accepted 100,000; held 40,000 | valid (cap reached exactly) |
| A18 | `finalClosingDate` null | `TERMS_INCOMPLETE` only |
| A19 | A1 with `signedOn 2026-11-21` | `DATE_ORDER` |

  - Allocation: receipts `[r1: 2026-11-02, 30,000]`, `[r2: 2026-11-05, 50,000]`, keep 40,000 → `r1: 30,000`, `r2: 10,000`.
  - Clock (test double for `addBusinessDays`: Monday–Friday, holidays `2026-11-11` and `2026-11-26`; the day after the start date is day 1):
    - K1: `signedOn 2026-11-02`, committed 250,000, receipt 100,000 on `2026-11-02`, closing `2026-11-30` → `clockStart 2026-11-02`, `acceptanceDeadline 2026-11-17`, `effectiveDecisionDeadline 2026-11-17`, `refundDueBy 2026-11-24`.
    - K2: `signedOn 2026-11-18`, committed 250,000, receipts 20,000 on `2026-11-17` and 80,000 on `2026-11-20` → `clockStart 2026-11-20`, `acceptanceDeadline 2026-12-07`, `effectiveDecisionDeadline 2026-11-30`, `refundDueBy 2026-12-14`.
    - K3: `signedOn` null → all null. K4: receipts total 99,999.99 of a 100,000 threshold → all null.
  - Kind: `PENDING` → `INITIAL`; accepted `2026-11-14`, received `2026-11-14` → `INITIAL`; received `2026-11-15` → `BALANCE`; `REJECTED` → throws.
  - Return start (outside date `2027-03-31`, 800 bps): `INITIAL` received `2026-11-10` → `2026-11-10`; `BALANCE` received `2026-12-15`, no due date → `2027-03-31`; `BALANCE` received `2027-01-18`, due `2027-01-20` → `2027-01-20`; `BALANCE` received `2027-02-02`, due `2027-01-20` → `2027-02-02`; rule `RECEIPT_DATE`, received `2026-12-15` → `2026-12-15`; `prefReturnBps 0` → `null`; `BALANCE`, no due date, outside date null → `undefined`.
  - Cash receipt: accepted 250,000, cash applied 100,000, amount 150,000 → valid; amount 150,000.01 → `OVERPAYMENT` (150,000.00 outstanding); `PENDING` with amount 500,000 → valid.
- **Acceptance**: every row above is a passing test; the module has no imports outside `../money`, `../date-only`.
- **Do not touch**: `src/lib/llc/**`.

---

### F6 — Commitments and receipts ledger: services, positions, router

- **Goal**: the ledger API used by the UI, by the Exhibit B flow, by the import, and by ECONOMICS.
- **Prerequisites**: F0, F1, F5, `E-lib`. If `src/lib/llc/business-days.ts` or `src/lib/llc/units.ts` does not exist with the signatures of E2, stop and report.
- **Split**: **F6a** = `src/server/llc/commitments.ts`, `src/server/llc/positions.ts`, `src/lib/admission/positions-merge.ts` (+ test). **F6b** = `src/trpc/routers/commitment-router/**` (schema, DTOs, procedures).
- **Create**: `src/server/llc/commitments.ts`, `src/server/llc/positions.ts`, `src/trpc/routers/commitment-router/schema.ts`, `dto.ts`, `router.ts` (replace the stub).
- **Service functions** (`src/server/llc/commitments.ts`; every function takes a transaction client first and an `actor: { userId: string; memberId: string | null; name: string; requestIp: string; userAgent: string }` last; every function scopes by `companyId` and writes its audit row; all amounts are `bigint`, all dates `DateOnly` strings):
  1. `lockUnitClass(tx, companyId, unitClassId)` — `` await tx.$queryRaw`SELECT id FROM "UnitClass" WHERE id = ${unitClassId} AND "companyId" = ${companyId} FOR UPDATE` ``; throws `NOT_FOUND` when no row. Called first by every function that checks the cap or issues units.
  2. `createCommitment(tx, { companyId, stakeholderId, unitClassId, committedCents, signedOn?, investmentSummaryDate?, accreditationBasis?, notes?, isReplacement? }, actor)` → `Commitment`. Rules: stakeholder and class belong to the company; class kind `PREFERRED`; `committedCents > 0`; the stakeholder has no other `PENDING` commitment in the class (`BAD_REQUEST` "This member already has a pending commitment."). Calls `refreshSubscriptionClock`. Audit `commitment.created`.
  3. `updatePendingCommitment(tx, { companyId, commitmentId, committedCents?, signedOn?: DateOnly | null, investmentSummaryDate?: DateOnly | null, accreditationBasis?, notes? }, actor)` — only while `PENDING`; `null` clears a date, omitted leaves it unchanged; refreshes the clock. Audit `commitment.updated`.
  4. `refreshSubscriptionClock(tx, companyId, commitmentId)` — internal to `commitments.ts` (not exported); scoped by `companyId`; only while `PENDING`: `computeSubscriptionClock` with non-void receipts and the real `addBusinessDays`; stores `acceptanceDeadline` (nothing else).
  - **Ledger invariant** (asserted by `ledgerInvariantErrors` in `src/server/llc/receipt-rules.ts`, in the unit tests and in `src/server/llc/__integration__/ledger.integration.ts`): for every commitment after every mutation, over its non-void receipts, cash received (`amountCents` of `INITIAL`/`BALANCE`/`REPLACEMENT`) = cash applied (`appliedCents` of those kinds) + `refundDueCents` (= refunds paid + refund still due) once decided, and all of it held unapplied while `PENDING`; cash applied ≤ `acceptedCents`; `0 ≤ refundPaidCents ≤ refundDueCents`; the commitment's capital and units are not negative. A receipt's capital and units exist from `appliedOnDate(receivedOn, acceptedOn)` (the later of the two) on every path.
  5. `decideCommitment(tx, { companyId, commitmentId, decision: "ACCEPT" | "REJECT", acceptedCents?, keepCents?, acceptedOn, minimumWaived?, minimumWaiverNote?, rejectionReason?, skipClosingDateCheck? }, actor)`:
     - Load the commitment (`PENDING`, else `BAD_REQUEST` "This commitment has already been decided."), its class (locked), its non-void receipts.
     - `today = todayInTimeZone(company.timezone)`; `held = Σ amountCents` (REJECT); for ACCEPT `held = heldOnOrBefore(receipts, acceptedOn)`: only receipts with `receivedOn ≤ acceptedOn` are the Initial Installment and count for the 40% check and the keep/refund split.
     - ACCEPT: `accepted = acceptedCents ?? committedCents`; `keep = keepCents ?? defaultKeepCents(...)` (from that `held`); `otherAccepted = Σ acceptedCents` of the class's other `ACCEPTED`/`REDUCED` commitments; run `validateAcceptance`; on errors throw `BAD_REQUEST` with the messages joined by a space. Then, per `planAcceptance` (F5 rules module): receipts with `receivedOn ≤ acceptedOn` get `keep` applied in (`receivedOn`, `id`) order, `kind = "INITIAL"`, `appliedOn = acceptedOn` when applied > 0, `prefReturnStartDate = receivedOn` (decision Q3; for money wired before acceptance the return starts on the wire date although the capital exists only from `appliedOn`); receipts with `receivedOn > acceptedOn` are ordinary Balance payments: `kind = "BALANCE"`, applied in full up to `accepted − keep` in (`receivedOn`, `id`) order, `appliedOn = receivedOn`, `prefReturnStartDate = prefReturnStartDate({ kind: "BALANCE", dueDate: null, … })` (`TERMS_INCOMPLETE` when the Balance outside date is not set); any excess is refunded. `unitsIssued = unitsForAmount(applied, pricePerUnitCents, fractionalUnitsAllowed)`. Update the commitment: `status = decisionStatus(...)`, `acceptedCents`, `acceptedOn`, `decidedAt = now`, `decidedByMemberId`, `minimumWaived = accepted < minCommitmentCents` and not `isReplacement` (false otherwise, whatever was sent: under Section 4.9(ii) the minimum does not apply to a Replacement Funder, so that is not a waiver and is audited as "the minimum does not apply to a Replacement Funder (Section 4.9(ii))"), `minimumWaiverNote` (null unless waived), `refundDueCents` = `planAcceptance(...).refundCents` (= Σ amount − Σ applied), `refundDueBy` = `computeSubscriptionClock(...).refundDueBy` when a refund is due (fall back to `addBusinessDays(acceptedOn, refundBusinessDays)` when the clock is null). Update the stakeholder, after locking its row (`SELECT … FOR UPDATE`) and re-reading it: `memberStatus = "MEMBER"` when it was `PROSPECT`; `admittedOn = acceptedOn` when null or later than `acceptedOn`; `currentRelationship = "INVESTOR"`; copy `accreditationBasis` from the commitment when the stakeholder's is null. A `PROSPECT` is admitted through `admitStakeholder`; anyone else only has `admittedOn` moved earlier when needed (audited only when it was null), so a `FINANCIAL_INTEREST_ONLY` holder is never upgraded to `MEMBER` implicitly (the Manager does that deliberately with the member status change). Audits: `commitment.accepted` or `commitment.reduced` (summary e.g. "Karl accepted $250,000.00 of $250,000.00 from Jane Doe; $100,000.00 applied, 100 units issued", plus any Balance received after the acceptance date and "member record: relationship EMPLOYEE → INVESTOR, accreditation basis set to NET_WORTH from the commitment" when the stakeholder changed), plus `stakeholder.admitted` the first time `admittedOn` is set.
     - REJECT: requires `rejectionReason` (min 3 chars) and `acceptedOn` (decision date, `≤ today`); `status = "REJECTED"`, `acceptedCents = 0`, `refundDueCents = held`, `refundDueBy` as above; receipts stay unapplied; when a `Template` with this `commitmentId` exists and is `PENDING`, set it to `CANCELLED` in the same transaction (so rejecting from the Commitments page also closes the Exhibit B packet). Audit `commitment.rejected`.
  6. `recordCapitalReceipt(tx, input, actor)` → `CapitalReceipt`, with `input = { companyId, commitmentId, receivedOn, amountCents, reference?, note?, dueDate?, sourceType?, sourceId?, special?: { kind: "REPLACEMENT" | "CREDIT" | "FORFEITURE"; appliedCents: bigint } }`:
     - Cash receipt (no `special`): `validateCashReceipt`; `kind = deriveReceiptKind(...)`. `PENDING` commitment → stored held (`appliedCents 0`, `unitsIssued 0`, no start date), then `refreshSubscriptionClock`. Decided commitment → `appliedCents = amountCents` (within the outstanding Balance, else `OVERPAYMENT`), units via `unitsForAmount`, `appliedOn = appliedOnDate(receivedOn, acceptedOn)` (a receipt entered late with `receivedOn ≤ acceptedOn` is `INITIAL` and applied from `acceptedOn`), `prefReturnStartDate = prefReturnStartDate({ kind, receivedOn, dueDate, terms })` (`undefined` → `BAD_REQUEST` `TERMS_INCOMPLETE`).
     - `special.kind = "REPLACEMENT"`: commitment must have `isReplacement = true` and be `ACCEPTED` or `REDUCED`; `amountCents > 0`; `receivedOn ≤ today`; `appliedCents = amountCents`; start date = `receivedOn`.
     - `special.kind = "CREDIT"`: `amountCents` must be `0n`, `special.appliedCents > 0`, `receivedOn ≤ today`; units via `unitsForAmount`; start date = `receivedOn` (the Credit Date, Section 4.9(iv)); may exceed the commitment.
     - `special.kind = "FORFEITURE"`: `amountCents` must be `0n`, `special.appliedCents < 0`, `receivedOn ≤ today`; `unitsIssued` = minus `unitsForAmount(−applied, …)`; the member's resulting capital (sum of `appliedCents`) must stay `≥ 0`; no start date.
     - Every special kind sets `appliedOn = appliedOnDate(receivedOn, acceptedOn)` (ECONOMICS reads `appliedOn` as the date the capital and units exist). A cash receipt may carry `sourceType`/`sourceId` (e.g. `"distribution"` for a Section 4.9(iii) offset recorded by ECONOMICS as an ordinary cash receipt).
     - Always: lock the class; set `stakeholderId`, `unitClassId` from the commitment; `recordedByMemberId`. Audit `capitalReceipt.recorded` (summary e.g. "Karl recorded $150,000.00 received from Jane Doe on 2026-12-15 (Balance); 150 units; return starts 2027-03-31").
  7. `voidCapitalReceipt(tx, { companyId, receiptId, reason }, actor)` — `reason` min 5 chars; checked by `planVoid` (`receipt-rules.ts`), which refuses: (a) on an `ACCEPTED`/`REDUCED` commitment, a cash receipt the decision split (`0 < appliedCents < amountCents`), because voiding it would undo part of the acceptance and a re-recorded receipt could not reproduce the keep the Manager chose (receipts applied in full or not at all can be voided); (b) a void after which the refund due would be less than `refundPaidCents`; (c) a void that would leave the member's capital or units negative on the commitment or in the class (a later `FORFEITURE`; void the forfeiture first). Sets `voidedAt`, `voidedByMemberId`, `voidReason`; refreshes the clock when the commitment is `PENDING`; on a decided commitment sets `refundDueCents = Σ (amountCents − appliedCents)` of the remaining non-void cash receipts (so a voided duplicate on a `REJECTED` commitment no longer has to be refunded; `refundDueBy` cleared at 0). Audit `capitalReceipt.voided` (with the refund change). ECONOMICS package E9 adds two guard calls to this file and nothing else: `assertLedgerDateOpenForReceipt(tx, companyId, receivedOn)` in `recordCapitalReceipt` for decided commitments, and `beforeVoidReceipt(tx, companyId, receiptId, actor.memberId)` here; both are defined in `src/server/llc/economics/receipt-guards.ts`, which must not import `commitments.ts`.
  8. `setReceiptPrefReturnStart(tx, { companyId, receiptId, startDate }, actor)` — receipt must be non-void, kind `BALANCE`, applied; `startDate ≥ receivedOn`; Audit `capitalReceipt.start-date-changed`.
  9. `reduceAcceptedCommitment(tx, { companyId, commitmentId, reduceByCents, reason }, actor)` — for Section 4.9(ii); commitment `ACCEPTED`/`REDUCED`; `0 < reduceBy ≤ accepted − cashApplied`; `acceptedCents −= reduceBy`; status unchanged. Audit `commitment.reduced`.
  10. `recordRefund(tx, { companyId, commitmentId, paidCents, paidOn }, actor)` — `paidOn ≤ today`; `0 < paid ≤ refundDueCents − refundPaidCents`; adds to `refundPaidCents`, sets `refundPaidOn`. Audit `commitment.refund-recorded`.
  11. `issueCommonUnits(tx, { companyId, stakeholderId, units: string, issuedOn }, actor)` — class kind `COMMON` (locked); `issuedOn ≤ today`; `units > 0`, whole number unless the class allows fractions; `issued + units ≤ authorizedUnits` else `BAD_REQUEST` "Only <n> Common Units remain authorized. Additional Common Units require a Preferred Supermajority (Section 3.2)."; creates `Commitment { committedCents 0, acceptedCents 0, status ACCEPTED, acceptedOn: issuedOn }` and `CapitalReceipt { kind INITIAL, amountCents 0, appliedCents 0, unitsIssued: units, receivedOn: issuedOn, appliedOn: issuedOn }`; stakeholder becomes `MEMBER` with `admittedOn` as in 5. Audit `capitalReceipt.recorded`.
  12. `admitStakeholder(tx, { companyId, stakeholderId, admittedOn }, actor)` — locks the Stakeholder row (`SELECT … FOR UPDATE`) and re-reads it, then sets `memberStatus = "MEMBER"` and `admittedOn` (kept when an earlier date is already stored), audit `stakeholder.admitted`. Every admission step takes this lock after the class lock (order: unit class, then stakeholder), because a Preferred acceptance and a Common issuance for the same stakeholder hold different class locks; the second waits, sees the first admission and only moves `admittedOn` earlier. Used by `decideCommitment` and `issueCommonUnits` only for a stakeholder who is still `PROSPECT` (see 5: a `FINANCIAL_INTEREST_ONLY` holder is never upgraded implicitly), and by GOVERNANCE for Substitute Members.
- **Positions** (`src/server/llc/positions.ts`): `getMemberPositions(db, companyId, opts?: { asOf?: DateOnly; unitClassId?: string }): Promise<MemberPosition[]>` with
  `MemberPosition = { stakeholderId: string; unitClassId: string; kind: "PREFERRED" | "COMMON"; committedCents: bigint; pendingCommittedCents: bigint; heldCents: bigint; cashAppliedCents: bigint; capitalCents: bigint; units: string; outstandingBalanceCents: bigint; firstAcceptedOn: string | null }`.
  - `committedCents` = Σ `acceptedCents` of `ACCEPTED`/`REDUCED` commitments; `pendingCommittedCents` = Σ `committedCents` of `PENDING`; `heldCents` = Σ `amountCents` of non-void receipts on `PENDING` commitments; `cashAppliedCents` = Σ `appliedCents` of non-void `INITIAL`/`BALANCE`/`REPLACEMENT`; `capitalCents` = Σ `appliedCents` of all non-void receipts; `units` = Σ `unitsIssued` (`toFixed(6)`); `outstandingBalanceCents` = `max(0, committed − cashApplied)`.
  - With `asOf`: only commitments with `acceptedOn ≤ asOf` and receipts with `appliedOn ≤ asOf`.
  - One row per (stakeholder, class) that has any commitment. Two queries (`commitment.groupBy`, `capitalReceipt.groupBy`) merged in memory.
  - Also export `getClassTotals(db, companyId, unitClassId, opts?)` → `{ committedCents, pendingCommittedCents, cashAppliedCents, capitalCents, units, outstandingBalanceCents }` (sums of the above).
- **DTOs** (`dto.ts`, with `toCommitmentDTO`, `toReceiptDTO`):
  - `ReceiptDTO = { id, commitmentId, stakeholderId, kind, receivedOn: DateOnly, amountCents: Cents, appliedCents: Cents, unitsIssued: Units, appliedOn: DateOnly | null, prefReturnStartDate: DateOnly | null, reference: string | null, note: string | null, voided: boolean, voidReason: string | null, createdAt: string }`
  - `CommitmentDTO = { id, stakeholderId, stakeholderName, unitClassId, status, committedCents: Cents, acceptedCents: Cents, heldCents: Cents, cashAppliedCents: Cents, capitalCents: Cents, units: Units, outstandingBalanceCents: Cents, signedOn: DateOnly | null, acceptedOn: DateOnly | null, investmentSummaryDate: DateOnly | null, accreditationBasis | null, minimumWaived: boolean, minimumWaiverNote: string | null, isReplacement: boolean, acceptanceDeadline: DateOnly | null, effectiveDecisionDeadline: DateOnly | null, decisionOverdue: boolean, refundDueCents: Cents, refundDueBy: DateOnly | null, refundPaidCents: Cents, refundOutstandingCents: Cents, rejectionReason: string | null, notes: string | null, packetPublicId: string | null, requiredInitialCents: Cents, defaultKeepCents: Cents, receipts: ReceiptDTO[] }`
  - `effectiveDecisionDeadline = min(acceptanceDeadline, finalClosingDate)`; `decisionOverdue` = `PENDING` and today (company time zone) is after it; `requiredInitialCents` and `defaultKeepCents` are computed for a full acceptance (the dialog recomputes for a reduction with the same pure functions).
- **Procedures** (all `withLlcAccessControl`; each mutation runs one `ctx.db.$transaction` and builds `actor` from `ctx`):

| Procedure | Policy | Input | Output |
|---|---|---|---|
| `commitment.list` | `commitments: read` | `{ stakeholderId?: string, status?: CommitmentStatus }` | `CommitmentDTO[]` (newest first) |
| `commitment.get` | `commitments: read` | `{ id }` | `CommitmentDTO` |
| `commitment.receipts` | `commitments: read` | `{ stakeholderId?: string, includeVoided?: boolean }` | `(ReceiptDTO & { stakeholderName: string })[]` |
| `commitment.create` | `commitments: create` | `{ stakeholderId, committedCents: ZCents (>0), signedOn?: ZDateOnly, investmentSummaryDate?: ZDateOnly, accreditationBasis?, notes?: string (max 2000) }` (class = the company's PREFERRED class) | `CommitmentDTO` |
| `commitment.update` | `commitments: update` | `{ id, committedCents?, signedOn?, investmentSummaryDate?, accreditationBasis?, notes? }` | `CommitmentDTO` |
| `commitment.accept` | `commitments: update` | `{ id, acceptedOn: ZDateOnly, acceptedCents?: ZCents, keepCents?: ZCents, minimumWaived?: boolean, minimumWaiverNote?: string }` (omitting `acceptedCents` accepts in full; a smaller amount is a reduction) | `CommitmentDTO` |
| `commitment.reject` | `commitments: update` | `{ id, decidedOn: ZDateOnly, reason: string (min 3) }` | `CommitmentDTO` |
| `commitment.recordRefund` | `commitments: update` | `{ id, paidCents: ZCents (>0), paidOn: ZDateOnly }` | `CommitmentDTO` |
| `commitment.recordReceipt` | `commitments: create` | `{ commitmentId, receivedOn: ZDateOnly, amountCents: ZCents (>0), reference?: string (max 120), note?: string (max 500) }` | `ReceiptDTO` |
| `commitment.voidReceipt` | `commitments: delete` | `{ receiptId, reason: string (min 5) }` | `{ id }` |
| `commitment.issueCommonUnits` | `commitments: create` | `{ stakeholderId, units: string (regex ^\d+(\.\d{1,6})?$), issuedOn: ZDateOnly }` | `ReceiptDTO` |

  The tRPC layer never passes `skipClosingDateCheck`, `isReplacement`, `special`, `dueDate`, `sourceType` or `sourceId`; those exist for ECONOMICS' server-side callers only.
- **Worked example for an integration-style check** (do it by hand in the UI after F7 or with a script against a local database): class with closing `2026-11-30`, outside `2027-03-31`. Create commitment $250,000 signed `2026-11-12`; record $100,000 received `2026-11-12` → held, `acceptanceDeadline 2026-11-27` (business days after Nov 12: 13, 16, 17, 18, 19, 20, 23, 24, 25, then Nov 27 because Nov 26 is Thanksgiving); accept in full on `2026-11-13` → receipt applied $100,000, 100.000000 units, return starts `2026-11-12`, Balance $150,000.00, member admitted `2026-11-13`; record $150,000 received `2026-12-15` → `BALANCE`, 150.000000 units, return starts `2027-03-31`, Balance $0.00; recording another $0.01 → `OVERPAYMENT`.
- **Unit tests**: `src/server/llc/positions.test.ts` is not possible without a database; instead extract the in-memory merge into a pure function `mergePositions(commitmentGroups, receiptGroups)` in `src/lib/admission/positions-merge.ts` (relative imports) and test: one stakeholder with accepted 250,000, receipts applied 100,000 + 150,000 → committed 250,000, cashApplied 250,000, Balance 0, units `"250.000000"`; a `CREDIT` of 5,000 → capital 255,000, cashApplied 250,000, Balance 0, units `"255.000000"`; a `FORFEITURE` of −20,000 on a member with accepted 100,000 and cash applied 40,000 → capital 20,000, units `"20.000000"`, Balance 60,000; a voided receipt is ignored (voided rows are excluded by the query, so the test passes none).
- **Acceptance**: the worked example reproduces exactly; every mutation writes an audit row whose summary contains formatted dollars (no raw cents, no `bigint` in JSON); ids of another company return `NOT_FOUND`; two concurrent `accept` calls that together exceed the cap cannot both succeed (the class row lock serialises them).
- **Do not touch**: `src/lib/llc/**`; the rules module (report a rule bug instead of patching around it).

---

### F7 — Commitments UI

- **Goal**: operate the ledger from the browser.
- **Prerequisites**: F4, F6.
- **Split**: **F7a** = the page, `commitment-table.tsx`, `receipt-table.tsx`, `commitment-status-badge.tsx`, `new-commitment-dialog.tsx`, `record-receipt-dialog.tsx` (row menus show only the actions whose dialog exists). **F7b** = `decide-commitment-dialog.tsx`, `reject-commitment-dialog.tsx`, `record-refund-dialog.tsx`, `void-receipt-dialog.tsx`, `issue-common-units-dialog.tsx`, wiring them into the tables and header, and `src/components/llc/member/commitments-tab.tsx`.
- **Create**: replace `[publicId]/commitments/page.tsx`; `src/components/llc/commitment/commitment-table.tsx`, `receipt-table.tsx`, `new-commitment-dialog.tsx`, `record-receipt-dialog.tsx`, `decide-commitment-dialog.tsx`, `reject-commitment-dialog.tsx`, `record-refund-dialog.tsx`, `void-receipt-dialog.tsx`, `issue-common-units-dialog.tsx`, `commitment-status-badge.tsx`; replace `src/components/llc/member/commitments-tab.tsx`.
- **Page** `/[publicId]/commitments`: `requireLlc()`; data `allow(Promise.all([api.commitment.list({}), api.commitment.receipts({}), api.unitClass.list(), api.stakeholder.getStakeholders()]), ["commitments", "read"])`.
  - Header actions (each behind `Allow subject="commitments" action="create"`): "New commitment", "Issue common units".
  - Tabs: **Commitments** — columns Member (link to member page), Committed, Accepted, Status badge, Received, Applied, Balance, Decide by (`effectiveDecisionDeadline`, red when `decisionOverdue`, amber within 3 days), Refund due (`refundOutstandingCents` and `refundDueBy`, red when past). Row menu: Record receipt (not for `REJECTED`); Accept or reduce / Reject (only `PENDING`); Record refund (only when `refundOutstandingCents > 0`); Open packet (when `packetPublicId`). **Receipts** — columns Received, Member, Kind, Amount, Applied, Units (`trimUnits`), Return starts, Reference, status (Held / Applied / Voided); row menu: Void (`Allow action="delete"`).
  - Empty state: "No commitments yet. Create one here or send a subscription from Admissions."
- **Dialogs** (each a local `Dialog`; submit → mutation → toast → `router.refresh()`):
  - New commitment: member select (stakeholders of the company), amount, signature date (optional), Investment Summary date (optional), accreditation basis (optional), notes. Inline hints from the PREFERRED class: "Minimum $100,000.00 (waivable to $50,000.00)", "Remaining under the cap: $X".
  - Record receipt: date received (default today in the company time zone, from `useEntity().timezone` + `todayInTimeZone`), amount (default: required initial installment minus held for `PENDING`; outstanding Balance otherwise), wire reference, note. Shows what will happen: "Held until the commitment is decided" (`PENDING`) or "Balance payment: N units; Preferred Return starts <date>" (computed with the F5 functions; the server result is authoritative).
  - Accept or reduce: acceptance date (default today); radio "Accept in full ($X)" / "Reduce to" + amount; live panel computed with F5 functions: required initial installment, received, amount kept (editable within the allowed range, default pro rata), refund due, units to be issued; waiver checkbox + note shown only when the accepted amount is below the minimum; all rule errors of `validateAcceptance` listed in red and the submit button disabled while any exists (the client passes `today` from the company time zone and `otherAcceptedCents` from the class totals returned by `unitClass.list` + `commitment.list`).
  - Reject: decision date, reason; warns "The $X received must be returned by <refundDueBy>."
  - Record refund: amount (default outstanding), date.
  - Void receipt: reason.
  - Issue common units: member select, units (default = authorized − issued), date.
- **Member tab** (`commitments-tab.tsx`): server component; `api.commitment.list({ stakeholderId })`; summary line (Committed, Paid, Units, Balance) and the same two tables filtered to the member, with the same row actions.
- **States**: unauthorised → `UnAuthorizedState`; loading handled by the server component (no skeleton needed); mutation error → toast with the server message (which names the section).
- **Tests**: none beyond F5/F6 (UI only); `tsc`, Biome and build must pass.
- **Acceptance**: the F6 worked example can be performed end to end in the UI; the accept dialog blocks A2, A4, A6, A7, A11, A12 from F5 with the listed messages before submit, and the server blocks them too if the client check is bypassed.
- **Do not touch**: `[publicId]/unit-classes/**`, `src/components/llc/unit-class/**`.

---

### F8 — Member Schedule (live Exhibit A) with PDF and CSV export

- **Goal**: `/captable` for LLC companies shows Exhibit A as of today or a chosen date and exports it.
- **Prerequisites**: F6.
- **Split**: **F8a** = the two pure modules with tests, `src/server/llc/member-schedule.ts`, the router (`memberSchedule.get` and `memberSchedule.overview`). **F8b** = `[publicId]/captable/page.tsx`, `src/components/llc/schedule/**`, `src/pdf-templates/member-schedule-template.tsx`, `[publicId]/captable/export/route.ts`.
- **Create**: `src/lib/admission/member-schedule.ts` (+ `.test.ts`), `src/lib/admission/member-schedule-csv.ts` (+ `.test.ts`), `src/server/llc/member-schedule.ts`, `src/trpc/routers/member-schedule-router/router.ts` (replace stub), `src/pdf-templates/member-schedule-template.tsx`, `[publicId]/captable/export/route.ts`, `src/components/llc/schedule/member-schedule-view.tsx`, `schedule-indicators.tsx`.
- **Modify**: `[publicId]/captable/page.tsx` — make it `async`; when `(await getSessionEntity()).isLlc` render the LLC view, otherwise the existing stub unchanged; set the page title from the vocabulary.
- **Pure builder** `buildMemberSchedule(input): MemberScheduleDTO` (`member-schedule.ts`, relative imports; input uses wire types so it is testable):
  - Input: `{ asOf: DateOnly, today: DateOnly, companyName: string, classes: { id, kind, name, offeringCapCents: Cents | null, finalClosingDate: DateOnly | null, initialInstallmentBps: number }[], members: { id, name, memberStatus, isInsider, admittedOn: DateOnly | null, noticeAddress: string, noticeEmail: string }[], positions: { stakeholderId, unitClassId, committedCents: Cents, pendingCommittedCents: Cents, capitalCents: Cents, units: Units }[], pending: { count: number, committedCents: Cents, overdueDecisions: number }, refunds: { count: number, outstandingCents: Cents } }`.
  - Output `MemberScheduleDTO = { asOf, companyName, common: { className, rows: { stakeholderId, name, capitalContributionCents: Cents, units: Units, percent: Pct }[], totalUnits: Units }, preferred: { className, rows: { stakeholderId, name, committedCents: Cents, paidCents: Cents, units: Units, percent: Pct, admittedOn: DateOnly | null, noticeAddress: string, noticeEmail: string, memberStatus, isInsider: boolean }[], totals: { committedCents: Cents, paidCents: Cents, units: Units, percent: Pct } }, indicators: { capCents: Cents | null, committedCents: Cents, remainingCents: Cents | null, capUsedBps: number | null, finalClosingDate: DateOnly | null, daysToFinalClosing: number | null, initialInstallmentBps: number, pendingCount: number, pendingCommittedCents: Cents, overdueDecisions: number, refundsOutstandingCount: number, refundsOutstandingCents: Cents }, managerNotice: { name, address, email }[] }`.
  - Rules: a Preferred row exists for each member with `committedCents > 0` or `units ≠ 0` in the PREFERRED class; `paidCents` = `capitalCents` ("Paid to Date" follows amounts actually received or credited, Section 4.9 last sentence); rows ordered by `admittedOn` (nulls last), then name, then id. Common rows likewise for the COMMON class with `capitalContributionCents = capitalCents` (0). `managerNotice` = the Common rows' members (name, notice address, notice email).
  - Percentages: `units / total units of the class`, 4 decimals, by largest remainder so the column sums to exactly `100.0000` (work in integers: units as micro-units, percent in 1/10,000 of a percent, total 1,000,000; floor each share, then give the missing steps one at a time to the rows with the largest fractional remainder; ties → more units first, then smaller `stakeholderId`). Total units 0 → every percent `"0.0000"` and total `"0.0000"`.
  - `remainingCents = cap − committed` (min 0); `capUsedBps = floor(committed × 10000 / cap)`; `daysToFinalClosing = diffInDays(today, finalClosingDate)` (negative after it).
- **Worked examples (tests)**:
  - Units `100`, `100`, `100` (ids `a`, `b`, `c`) → `33.3334`, `33.3333`, `33.3333`; total `100.0000`.
  - Units `40`, `100`, `60.5` → `19.9501`, `49.8753`, `30.1746`.
  - One member with `250` units → `100.0000`. No units → `0.0000`.
  - Committed total 1,250,000 of cap 2,000,000 → `remainingCents` 75,000,000, `capUsedBps` 6250. `today 2026-11-12`, closing `2026-11-30` → 18; `today 2026-12-02` → −2.
  - Common: one member with `100` units and capital 0 → row `{ capitalContributionCents: 0, units: "100.000000", percent: "100.0000" }`.
  - A member with committed 100,000, paid 40,000, a `CREDIT` of 5,000 (so capital 45,000, units 45) → `paidCents` 4,500,000, units `"45.000000"`.
- **Server** `src/server/llc/member-schedule.ts`: `loadMemberSchedule(db, company: { id, name, timezone }, opts?: { asOf?: DateOnly }): Promise<MemberScheduleDTO>` — loads classes, stakeholders, `getMemberPositions(db, companyId, { asOf })`, pending commitments (count, Σ committed, count with `effectiveDecisionDeadline < today`), refunds outstanding; notice address = `[streetAddress, city, [state, zipcode].join(" ")]` non-empty parts joined with `", "`; notice email = `noticeEmail ?? email`; calls the builder. Exported for GOVERNANCE (`RecordSnapshot`).
- **Procedure** `memberSchedule.get` — `withLlcAccessControl`, policy `stakeholder: read`; input `{ asOf?: ZDateOnly }` (must be `≤ today`, else `BAD_REQUEST`); output `MemberScheduleDTO`.
- **Procedure** `memberSchedule.overview` (used by F9) — `withLlcAccessControl`, policy `stakeholder: read`, no input, output `{ indicators: MemberScheduleDTO["indicators"], paidCents: Cents, outstandingBalanceCents: Cents, memberCount: number, prospectCount: number, preferredUnits: Units }`. `paidCents` = Preferred `capitalCents` total; `outstandingBalanceCents` from `getClassTotals`; `memberCount` = stakeholders with `memberStatus = "MEMBER"`; `prospectCount` = `PROSPECT` stakeholders.
- **Page (LLC view)**: title "Member schedule", description "Exhibit A to the Operating Agreement, kept current under Section 12.1(a)". Controls: as-of date input (query param `asOf`), "Export PDF", "Export CSV" (plain links to the export route). Indicator strip (`schedule-indicators.tsx`): committed vs cap with a progress bar and "Remaining $X"; Final Closing ("18 days left" / "Closes today" / "Closed on Nov 30, 2026" / "Not set" with a link to Unit classes); "N pending subscriptions ($X)" with a red "M past the decision deadline" when > 0; "Refunds outstanding $X" when > 0. Then the Common table (Common Member, Capital Contribution, Common Units, Common Unit Percentage Interest) and the Preferred table with exactly the seven Exhibit A columns (Preferred Members, Capital Contribution Committed, Paid to Date, Preferred Units, Preferred Unit Percentage Interest, Date Admitted, Notice Address and Email) and a totals row; members with `FINANCIAL_INTEREST_ONLY` get a footnote marker "holds a Financial Interest only (Section 7.9.2)"; names link to the member page. Footer: "Manager (for notices): …" from `managerNotice`, and "One Preferred Unit for each $1,000 of Capital Contribution actually paid. Initial Installment under Section 4.9: 40%." (price and percent taken from the class). Empty state (no rows in either table): "No members yet."
- **Export route** `GET /[publicId]/captable/export?format=pdf|csv&asOf=YYYY-MM-DD` (`route.ts`, Node runtime): session via `getServerAuthSession()`; 401 without a session; company from the session must have this `publicId` and be LLC (404 otherwise); permission check with `getPermissions({ db, session })` + `new RBAC().addPolicies({ stakeholder: { allow: ["read"] } }).enforce(...)` as in `src/server/file-upload-actions.ts:123-138` (403 otherwise); `loadMemberSchedule`; respond with `Content-Disposition: attachment; filename="exhibit-a-<publicId>-<asOf>.pdf|csv"`, `Cache-Control: no-store`.
  - PDF: `renderToBuffer(MemberScheduleTemplate({ schedule }))` from `@react-pdf/renderer` (pattern: `src/server/esign.ts:187-189`). Template: Letter landscape, built-in Helvetica only (no `Font.register`), title "EXHIBIT A", company name, "As of <date>", the two tables, totals, the two footer lines, page numbers. Money as `$100,000.00`, units through `trimUnits`, percent with `%`, dates `formatDateOnly`.
  - CSV (`member-schedule-csv.ts`, pure, `toMemberScheduleCsv(schedule): string`): line 1 `Common Member,Capital Contribution,Common Units,Common Unit Percentage Interest`; Common rows; blank line; `Preferred Members,Capital Contribution Committed,Paid to Date,Preferred Units,Preferred Unit Percentage Interest,Date Admitted,Notice Address and Email`; Preferred rows; `Total,…` row. Money `100000.00`, units trimmed, percent `33.3334%`, date `YYYY-MM-DD`, last column `"<address>; <email>"`. RFC 4180 quoting; a cell starting with `=`, `+`, `-` or `@` is prefixed with `'`. Test: a member named `=cmd` is written as `'=cmd`; a name containing a comma and a quote is quoted and escaped; the header lines are exact.
- **Acceptance**: after the F6 worked example the Preferred row reads Committed $250,000.00, Paid $250,000.00, Units 250, 100.0000%, Date Admitted Nov 13, 2026; `asOf=2026-11-30` shows Paid $100,000.00 and Units 100; both exports download and match the page; a CORPORATION company still sees the old stub at `/captable`.
- **Do not touch**: `src/pdf-templates/audit-log-template.tsx`.

---

### F9 — Overview for LLC companies

- **Goal**: real numbers on the overview for LLC companies.
- **Prerequisites**: F8a.
- **Create**: `src/components/llc/overview/llc-overview.tsx` (server component), `stat-card.tsx`.
- **Modify**: `[publicId]/page.tsx` — when `(await getSessionEntity()).isLlc` return `<LlcOverview publicId={publicId} />`; otherwise the existing JSX unchanged.
- **Data**: `api.memberSchedule.overview()` (delivered by F8a; F9 does not edit the router).
- **What it shows**: header "Overview"; cards: "Committed" (`$1.25M of $2.00M`, progress bar, "Remaining $750,000.00", sub-line "N pending ($X)"), "Paid to date", "Outstanding Balance", "Members" (count, sub-line "K prospects"), "Final Closing" ("18 days" / "Today" / "Closed" / "Not set", sub-line the date); then `<EconomicsOverviewSlot />` (F1 stub) in its own full-width section titled by ECONOMICS later; right column: the existing `ActivitiesCard` (`src/components/dashboard/overview/activities-card.tsx`) unchanged. Attention list above the cards when applicable, each linking to `/commitments`: "M subscriptions are past their decision deadline", "Refunds of $X are outstanding", "Final Closing Date is not set".
- **States**: no permission for `stakeholder: read` → show only the activities card; no commitments → cards show $0.00 and "No commitments yet" with a link to Admissions.
- **Acceptance**: numbers equal the Member Schedule indicators; `ActivitiesCard` still requires `audits: read` (unchanged); CORPORATION overview unchanged.
- **Do not touch**: `src/components/dashboard/overview/**`, `src/components/llc/overview/economics-slot.tsx`.

---

### F10 — Email delivery and email log

- **Goal**: every outbound email is logged; the owner can see the log per company and per member, knows whether mail is really delivered, and can mark bounces.
- **Prerequisites**: F1.
- **Split**: **F10a** = `src/server/mailer.ts`, `src/lib/mail-catcher.ts`, `src/lib/email-recipients.ts` (+ tests), the job files and emitters, the attachment fix. **F10b** = `src/trpc/routers/email-log-router/**`, `[publicId]/emails/page.tsx`, `src/components/llc/email/**`, `src/components/llc/member/emails-tab.tsx`.
- **Operator steps (environment only, no code)**: in Dokploy set `EMAIL_SERVER=smtp://USER:PASS@HOST:587` (or `smtps://…:465`) and `EMAIL_FROM=<address on a domain with SPF and DKIM for that SMTP service>`; redeploy; send a test from the Email log page. Until then the stack uses the bundled Mailpit catcher (`deploy/dokploy/compose.yml:39`), which delivers nothing.
- **Modify** `src/server/mailer.ts`:
  - New type `EmailLogContext = { kind: string; companyId?: string | null; stakeholderId?: string | null; relatedType?: string; relatedId?: string }`.
  - `sendMail(options: Omit<SendMailOptions, "from">, log?: EmailLogContext): Promise<{ emailLogId: string | null; sentAt: Date; messageId: string | null }>` (existing callers ignore the result; `emailLogId` is null only when the log write failed; `sentAt` is the value stored on the row). The call is synchronous: it resolves after the SMTP server accepted the message. Attachments pass through unchanged (`options.attachments`, nodemailer format, `content: Buffer` allowed). Behaviour: build `from` as today; `toAddress` = recipients of `options.to` (string, address object or array) lower-cased and joined with `", "`; call the transport; on success write `EmailLog { status: "SENT", sentAt: new Date(), providerMessageId: info.messageId, smtpResponse: info.response?.slice(0, 500), toAddress, fromAddress: env.EMAIL_FROM, subject, kind: log?.kind ?? "uncategorized", companyId, stakeholderId, relatedType, relatedId, bodySha256 }`; when the transport throws, or `info.accepted` is empty and `info.rejected` is not, write the row with `status: "FAILED"` and `errorMessage` (first 1,000 characters) and rethrow the transport error (or throw `new Error("All recipients were rejected")`). The log write is wrapped in its own `try/catch` that only logs with `logger.error`: **a failed log write never throws** (a throw after a successful send would make pg-boss send the email again). `bodySha256` = SHA-256 hex of `options.html` when it is a string (`node:crypto`). The body itself is never stored.
  - Member resolution: when `companyId` is set and `stakeholderId` is not, look up one stakeholder of that company whose `email` or `noticeEmail` equals the (single) recipient and store its id (inside the same `try/catch`).
  - Export `isMailCatcherConfigured(): boolean` — true when `env.EMAIL_SERVER` is unset, cannot be parsed as a URL, has hostname `smtp`, `mailpit`, `localhost` or `127.0.0.1`, or port `1025`.
- **Modify the seven job files** to pass a context: `auth-verification-email.ts` (`auth.verify-email`), `password-reset-email.ts` (`auth.password-reset`), `member-inivite-email.ts` (`team.invite`), `esign-email.ts` (`esign.request`, `companyId` from the payload, `relatedType: "template"`, `relatedId` = the recipient's `templateId`), `esign-confirmation-email.ts` (`esign.completed`), `share-update-email.ts` (`update.share`), `share-data-room-email.ts` (`dataroom.share`). Add an optional `companyId: z.string().optional()` to the Zod schema of the jobs that lack it and pass it from their emitters where the emitter already has the company id (find emitters with `grep -rn "EmailJob\.\(emit\|bulkEmit\)" src`); do not add database lookups to emitters.
- **Fix trap A3.17** in `esign-complete-pdf.ts` / `esign-confirmation-email.ts`: add `fileKey: z.string().optional()`, `companyId`, `templateId` to the confirmation job schema; `esign-complete-pdf.ts` passes `fileKey: bucketData.key`, `companyId`, `templateId` (and still `fileUrl` for jobs already queued); the worker uses `fileKey ? (await getPresignedGetUrl(fileKey)).url : fileUrl` (import from `@/server/file-uploads`) for the attachment, so a retry gets a fresh URL.
- **Create** `src/trpc/routers/email-log-router/router.ts` (replace stub), `schema.ts`; replace `[publicId]/emails/page.tsx`; `src/components/llc/email/email-log-table.tsx`, `mark-bounce-dialog.tsx`, `test-email-button.tsx`, `mail-catcher-banner.tsx`; replace `src/components/llc/member/emails-tab.tsx`.
- **DTO** `EmailLogDTO = { id, toAddress, subject, kind, status: "SENT" | "FAILED", sentAt: string | null, createdAt: string, providerMessageId: string | null, errorMessage: string | null, bounceState: "NONE" | "BOUNCED" | "COMPLAINED", bouncedAt: string | null, bounceNote: string | null, stakeholderId: string | null, stakeholderName: string | null, relatedType: string | null, relatedId: string | null }`.
- **Procedures** (`withAccessControl`, not LLC-only, so the log also works for corporations):
  - `emailLog.list` — policy `emails: read`; input `{ stakeholderId?: string, status?: "SENT" | "FAILED", cursor?: string, take: number (1–100, default 50) }`; output `{ items: EmailLogDTO[], nextCursor: string | null }`; `where: { companyId, … }`, `orderBy: [{ createdAt: "desc" }, { id: "desc" }]`, cursor on `id`. Rows with `companyId = null` (sign-up, password reset) are never returned.
  - `emailLog.markBounce` — policy `emails: update`; input `{ id, bounceState: "NONE" | "BOUNCED" | "COMPLAINED", note?: string (max 500) }`; row by `{ id, companyId }` else `NOT_FOUND`; sets `bounceState`, `bouncedAt` (null for `NONE`), `bounceNote`; audit `emailLog.bounce-marked`, target `{ type: "emailLog", id }`, summary "… marked the email "<subject>" to <address> as bounced: <note>".
  - `emailLog.deliveryStatus` — policy `emails: read`; output `{ mailCatcher: boolean, fromAddress: string }`.
  - `emailLog.sendTest` — policy `emails: create`; input `{ to: z.string().email() }`; sends subject "Test email from <company name>", a two-line HTML body, header `X-From-Name: <company name>`, context `{ kind: "test", companyId }`; output `{ ok: true }`; transport errors become `BAD_REQUEST` with the SMTP message.
- **Page** `/[publicId]/emails`: `allow(api.emailLog.list({ take: 50 }), ["emails", "read"])`; `MailCatcherBanner` (destructive `Alert`: "Emails are captured by the built-in mail catcher and are not delivered. Set EMAIL_SERVER and EMAIL_FROM.") when `deliveryStatus.mailCatcher`; "Send test email" button with an address input; table: Sent (local time), To, Member (link), Subject, Type (`kind`), Status badge (Sent / Failed, error in a tooltip), Bounce badge, row action "Mark as bounced / Clear bounce"; "Load more" using `nextCursor` (client component with `api.emailLog.list.useQuery`). Empty state: "No emails have been sent yet." Explanatory line under the title: "Notice by email is effective when sent unless you learn it was not delivered (Section 13.6). Record bounces here."
- **Member tab**: the same table filtered by `stakeholderId`, without the banner and test button.
- **Unit tests**: `src/server/mail-catcher.test.ts` — move the URL check into a pure `src/lib/mail-catcher.ts` (`isMailCatcherUrl(url: string | undefined): boolean`, relative imports) used by `isMailCatcherConfigured`: `undefined` → true; `smtp://captable:password@smtp:1025` → true; `smtp://u:p@localhost:2525` → true; `smtps://u:p@smtp.example.com:465` → false; `not a url` → true. Also `src/lib/email-recipients.ts` + test (`normalizeRecipients`): `"A@x.com"` → `"a@x.com"`; `["A@x.com", { name: "B", address: "b@Y.com" }]` → `"a@x.com, b@y.com"`; `'"Jane" <Jane@x.com>'` → `"jane@x.com"`.
- **Acceptance**: sending an e-sign request creates one `EmailLog` row with `kind = "esign.request"`, the company id and (when the recipient is a stakeholder's address) the stakeholder id; with the SMTP server stopped the job fails, a `FAILED` row exists per attempt, and a later successful retry adds a `SENT` row; with the `EmailLog` table temporarily unavailable the email is still sent and the job does not fail; no row contains a signing link; the banner shows on the current production configuration.
- **Do not touch**: `src/emails/**` (templates), nodemailer transport options.

---

### F11 — E-sign core: ordering, signer isolation, semantic keys, masters, idempotent completion

- **Goal**: make the e-sign engine safe and reusable, without changing how `STANDARD` templates behave (B31).
- **Prerequisites**: F1, F10a (shares `src/jobs/esign-complete-pdf.ts`).
- **Split**: **F11a** = `filter-signer-values.ts` (+ test) and Modify items 1, 2, 6, 7, 8, 9. **F11b** = `subscription-fields.ts` (+ test) and Modify items 3, 4, 5.
- **Create**:
  - `src/lib/esign/filter-signer-values.ts` (+ `.test.ts`, pure): `filterSignerValues(fields: { id: string; name: string; recipientId: string; readOnly: boolean; required: boolean; type: string; defaultValue: string; prefilledValue: string | null }[], recipientId: string, data: Record<string, string>): { values: Record<string, string>; missingRequired: string[] }` — for each field of this recipient: read-only → value = `prefilledValue ?? defaultValue` (submitted value ignored); otherwise value = submitted value (trimmed for `TEXT`) or, when absent/empty, `prefilledValue ?? defaultValue`; empty values are omitted from `values`; a required, non-read-only field with an empty value adds the field's `name` to `missingRequired`. Keys for other recipients' fields or unknown ids are dropped.
  - `src/lib/esign/subscription-fields.ts` (+ `.test.ts`, pure): the semantic keys of an Exhibit B packet.

    | Key | Role | Type | Required | Notes |
    |---|---|---|---|---|
    | `commitment_amount` | investor | TEXT | yes | "Capital Contribution committed" |
    | `amount_paid` | investor | TEXT | yes | "Paid with this signature page" |
    | `accreditation_basis` | investor | SELECT | yes | canonical options, ids = `AccreditationBasisEnum` names, labels: "Individual: net worth over $1,000,000", "Individual: income over $200,000 ($300,000 joint)", "Individual: Series 7, 65 or 82 license", "Entity: total assets over $5,000,000", "Entity: all equity owners accredited", "Trust: total assets over $5,000,000" |
    | `legal_name` | investor | TEXT | yes | |
    | `holder_type` | investor | SELECT | yes | canonical options, ids `INDIVIDUAL`, `JOINT`, `TRUST`, `ENTITY`, labels "Individual", "Joint", "Trust", "Entity" |
    | `residence_state` | investor | TEXT | yes | "State of residence (or formation)" |
    | `investment_summary_date` | investor | DATE | yes | |
    | `address_street`, `address_city`, `address_state`, `address_zip` | investor | TEXT | yes | one line each (no wrapping, A3.13) |
    | `email` | investor | TEXT | yes | |
    | `investor_signature` | investor | SIGNATURE | yes | |
    | `signer_name_title` | investor | TEXT | no | "Name and title (if entity)" |
    | `investor_sign_date` | investor | DATE | yes | |
    | `manager_signature` | manager | SIGNATURE | yes | |
    | `manager_sign_date` | manager | DATE | yes | |
    | `contribution_received` | manager | TEXT | no | filled from the ledger, read-only |
    | `units_issued` | manager | TEXT | no | filled from the ledger, read-only |

    Exports: `SUBSCRIPTION_FIELD_KEYS` (array of `{ key, role, type, required, label, options? }`), `REQUIRED_SUBSCRIPTION_KEYS` (all keys in the table except `signer_name_title`; the two ledger fields are required to exist on the master although not required for the signer), `canonicalOptionsFor(key)`, `missingSubscriptionKeys(fields: { semanticKey: string | null; role: string | null }[]): string[]` (a key counts only when placed on a field of the right role; duplicates of a key are allowed).
- **Modify**:
  1. Deterministic order (A3.9). Define once in `src/services/esign-service.ts`: `export const RECIPIENT_ORDER = [{ signingOrder: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }] as const`. Use it in `handleOrderedDelivery` (`esign-service.ts:54`), `getAllRecipients` (`:133`), and the `recipientList` query in `add-fields.ts:98`. In `create-template.ts:66-71` write `signingOrder: index + 1` for each recipient.
  2. Signer isolation (A3.8) in `sign-template.ts`: after loading the template and recipient, `const { values, missingRequired } = filterSignerValues(template.fields, recipient.id, input.data)`; when `missingRequired.length` → `BAD_REQUEST` "Please complete: <names>". Multi-recipient path: `saveFieldValues(template.fields, values, tx)` (so only the signer's own fields are written, including their read-only defaults). Single-recipient path: pass `data: values` to `completeDocument`. Nothing else in the control flow changes.
  3. Semantic keys (A3.14): add `semanticKey: z.string().max(64).nullish()` to `ZodAddFieldMutationSchema` and to the form schema in `src/providers/template-field-provider.tsx`; add `semanticKey: true` to the field select in `get-template.ts`; `template.get` also returns `isMaster` and `workflow`. In `add-fields.ts`, when the template has `workflow = "SUBSCRIPTION"` and a field's `semanticKey` has canonical options, overwrite that field's `type` with `SELECT` and `meta.options` with the canonical options before `createMany`; reject an unknown `semanticKey` with the procedure's failure envelope (`title: "Validation failed"`).
  4. Field editor UI (`src/components/template/field-canvas/template-field.tsx` and the editor page `[publicId]/documents/esign/[templatePublicId]/page.tsx`): when `template.get` reports `isMaster`, each field shows a "Meaning" select (`fields.${index}.semanticKey`) listing `SUBSCRIPTION_FIELD_KEYS` filtered to the role of the field's recipient plus "None"; choosing a key sets the field's type and name from the key definition; the "send" control of `src/components/template/canavs-toolbar/index.tsx` is replaced by "Save master" (status stays `DRAFT`) and a line shows `missingSubscriptionKeys`. `template.get` must therefore also return each recipient's `role`. For non-master templates the UI is unchanged.
  5. Masters are never sent (B22): in `add-fields.ts`, before the transaction, load the template by `{ publicId, companyId }`; when `isMaster` and `input.status === "PENDING"` return `{ success: false, title: "Not allowed", message: "A master cannot be sent. Use Admissions → Send subscription." }`. `get-all-template.ts`: add `isMaster`, `workflow` to the select; `[publicId]/documents/esign/components/table.tsx`: show a "Master" badge instead of the status for masters and hide the cancel button for them.
  6. Idempotent completion (A3.12) in `src/server/esign.ts` `completeEsignDocuments`: first load the template (`id`, `companyId`, `signedDocumentId`, `workflow`, `stakeholderId`); when `signedDocumentId` is set return without creating anything; otherwise create the bucket (pass `user: { id: "", name: uploaderName, companyId }` so the bucket audit row has the company id), create the document, and store `signedDocumentId` together with `status: "COMPLETE"`, `completedOn`. Return `{ documentId, created: boolean }` (`created` is false on the early return). In `src/jobs/esign-complete-pdf.ts` (one-line change in an F10a file): emit the confirmation emails only when `created` is true, so a retried job does not email the parties twice. In `src/jobs/esign-pdf.ts`: at the start, when the template already has `status = "COMPLETE"`, return without doing anything.
  7. Date format (A3.13): `generateEsignPdf` gets an optional `dateFormat` (default `"DD/MM/YYYY"`), passed down to `getFieldValue`; `src/jobs/esign-pdf.ts` loads the template's `workflow` and passes `"MM/DD/YYYY"` for `SUBSCRIPTION`.
  8. Tokens (A3.15): `src/lib/jwt.ts` add `encodeWithExpiry(data: JWTPayload, expiresIn: string)` (`new SignJWT(data).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(expiresIn).sign(JWT_SECRET)`); `DecodeEmailToken` (`add-fields.ts:37-40`) throws when the verified payload has a `p` property.
  9. `getEsignTemplate` (`src/server/esign.ts:47-82`): add `workflow`, `isMaster`, `stakeholderId`, `commitmentId` to the select.
- **Unit tests** (`filter-signer-values.test.ts`): recipient R1 submits values for its field F1 and for R2's field F2 → only F1 is kept; a read-only field of R1 with `defaultValue "X"` and a submitted `"Y"` → `"X"`; required F1 submitted as `"  "` → `missingRequired = ["<name of F1>"]`; unknown key dropped; `TEXT` value `" Jane "` → `"Jane"`; `SIGNATURE` value not trimmed. (`subscription-fields.test.ts`): keys are unique; `missingSubscriptionKeys([])` returns all 18 required keys; a master with every key on the right role returns `[]`; `manager_signature` placed on an investor field still counts as missing.
- **Acceptance**:
  - A `STANDARD` two-recipient ordered template: the first email goes to the first recipient entered, the second only after the first signs; both signatures appear in the PDF as before.
  - Posting `template.sign` with a value for another recipient's field does not change that field.
  - Re-running the `esign.complete-pdf` job for a completed template creates no second `Document`.
  - A master cannot be sent from the editor; its fields keep their `semanticKey` after save and reload.
  - A signing token that carries `p` is rejected by `template.sign` and `template.getSigningFields`.
- **Do not touch**: `src/jobs/esign-email.ts`, `src/jobs/esign-confirmation-email.ts`, `src/jobs/esign-complete-pdf.ts` beyond the one line in item 6, the public page `src/app/(documents)/esign/[token]/page.tsx`.

---

### F12 — Admission packets: masters, send, investor signing, W-9 upload

- **Goal**: upload Exhibit B once, send it to many investors, collect the signature page and a W-9 without an investor login.
- **Prerequisites**: F4a, F10a, F11.
- **Split**: **F12a** = `src/trpc/routers/admission-router/**`, `src/server/llc/admission.ts`, `src/lib/admission/packet-stage.ts` (+ test), `src/server/file-uploads.ts`, `src/constants/job.ts`, `src/jobs/admission-notice-email.ts`, `src/jobs/register.ts`, `src/emails/AdmissionNoticeEmail.tsx`, `sign-template.ts`. **F12b** = `[publicId]/admissions/page.tsx`, `src/components/llc/admission/*.tsx`, `src/app/(documents)/w9/**`, `src/components/template/signing-field-form/index.tsx`.
- **Create**: `src/trpc/routers/admission-router/router.ts` (replace stub), `schema.ts`, `procedures/*.ts` (one file per procedure below), `src/server/llc/admission.ts` (helpers `cloneMasterToPacket`, `packetStage`, `encodeW9Token`, `decodeW9Token`), `src/jobs/admission-notice-email.ts`, `src/emails/AdmissionNoticeEmail.tsx`, `src/components/llc/admission/master-list.tsx`, `upload-master-dialog.tsx`, `send-subscription-dialog.tsx`, `packet-table.tsx`, `packet-stage-badge.tsx`, `src/app/(documents)/w9/[token]/page.tsx`, `src/components/llc/admission/w9-upload.tsx`; replace `[publicId]/admissions/page.tsx`.
- **Modify**:
  - `src/server/file-uploads.ts`: add `"w9-docs"` to `TypeKeyPrefixes`; add `headObject(key): Promise<{ size: number; contentType: string | undefined } | null>` (`HeadObjectCommand`, private bucket, `null` on 404) and `deleteObject(key): Promise<void>` (`DeleteObjectCommand`). `src/lib/upload-authorization.ts` is NOT changed (`w9-docs` must stay out of the browser allow-list).
  - `src/constants/job.ts`: add `"admission-notice"` to `email`. `src/jobs/register.ts`: register the new worker.
  - `sign-template.ts`: after the recipient is marked `SIGNED` and values are saved, when `template.workflow === "SUBSCRIPTION"`: skip `handleOrderedDelivery` (B23); when the signer's `role` is `"investor"`: emit two `admission-notice` jobs after the transaction (see emails below) and return `{ w9Token }`; when the role is `"manager"` behave as today (all signed → `completeDocument`). `STANDARD` templates still return `{}`.
  - `src/components/template/signing-field-form/index.tsx`: in `onSuccess(data)`, when `data.w9Token` is present `router.push("/w9/" + data.w9Token)`; otherwise the existing redirects.
- **Packet stage** (`packetStage`, pure helper with a test in `src/lib/admission/packet-stage.ts`): from `{ templateStatus, investorStatus, managerStatus, commitmentStatus | null }` → `CANCELLED` (template `CANCELLED` and commitment not `REJECTED`); `REJECTED` (commitment `REJECTED`); `COMPLETE` (template `COMPLETE`); `AWAITING_INVESTOR` (investor not `SIGNED`); `AWAITING_REVIEW` (investor `SIGNED`, no commitment or commitment `PENDING`); `AWAITING_COUNTERSIGN` (commitment `ACCEPTED`/`REDUCED`, manager not `SIGNED`); `FINALISING` (manager `SIGNED`, template still `PENDING`: PDF job running).
- **Procedures** (`withLlcAccessControl` unless marked public):

| Procedure | Policy | Input | Output / effect |
|---|---|---|---|
| `admission.masters` | `commitments: read` | — | `{ id, publicId, name, createdAt, fieldCount, missingKeys: string[], ready: boolean }[]` for templates `{ companyId, isMaster: true, workflow: "SUBSCRIPTION", status: "DRAFT" }` |
| `admission.createMaster` | `commitments: create` | `{ name: string (1–120), bucketId }` | `assertCompanyOwns` bucket; create `Template { isMaster: true, workflow: "SUBSCRIPTION", status: "DRAFT", orderedDelivery: true, uploaderId: membership.memberId }` and two recipients `{ role: "investor", signingOrder: 1, name: "Investor", email: "investor@placeholder.invalid" }`, `{ role: "manager", signingOrder: 2, name: "Manager", email: "manager@placeholder.invalid" }`; audit `admission.master-created`; returns `{ publicId }` (client opens the existing editor at `/documents/esign/<publicId>`) |
| `admission.archiveMaster` | `commitments: delete` | `{ publicId }` | sets the master's status to `CANCELLED` (it disappears from `masters`; packets cloned from it are unaffected) |
| `admission.send` | `commitments: create` | `{ masterPublicId, stakeholderId?: string, prospect?: { name: string, email: string }, managerMemberId: string, message?: string (max 2000) }` (exactly one of `stakeholderId` / `prospect`) | see rules below; returns `{ publicId }` |
| `admission.list` | `commitments: read` | — | `{ publicId, name, createdAt, stakeholderId, stakeholderName, investorEmail, managerName, stage, w9Count, commitmentId: string | null }[]` for `{ companyId, workflow: "SUBSCRIPTION", isMaster: false }` |
| `admission.cancel` | `commitments: update` | `{ publicId }` | only in stage `AWAITING_INVESTOR`, or `AWAITING_REVIEW` without a commitment; template → `CANCELLED`; audit `admission.cancelled` |
| `admission.resend` | `commitments: update` | `{ publicId }` | only `AWAITING_INVESTOR`; re-emits the investor's e-sign request (`singletonKey` suffixed with the current minute) |
| `admission.w9Info` (public, `withoutAuth`) | — | `{ token }` | `{ companyName, investorName, uploaded: number, remaining: number }`; `FORBIDDEN` for an invalid token |
| `admission.w9UploadUrl` (public) | — | `{ token, fileName: string (1–200), contentType: "application/pdf" | "image/jpeg" | "image/png", size: number (1–10485760) }` | `{ url, key }` |
| `admission.w9Complete` (public) | — | `{ token, key: string }` | `{ ok: true }` |

  - **`send` rules** (one transaction): master belongs to the company, is a ready master (`missingSubscriptionKeys` empty, else `BAD_REQUEST` listing the keys); the company has a PREFERRED class; stakeholder: load by `{ id, companyId }`, or for `prospect` find by `{ companyId, email: lower(email) }` and otherwise create it (`memberStatus: "PROSPECT"`, `currentRelationship: "INVESTOR"`, `stakeholderType: "INDIVIDUAL"`); no other packet of this stakeholder in stage `AWAITING_INVESTOR`, `AWAITING_REVIEW` or `AWAITING_COUNTERSIGN` (`BAD_REQUEST` "This person already has an open subscription."); `managerMemberId` is an `ACTIVE` member of the company whose user has a name and an email. `cloneMasterToPacket`: new `Template { name: "<master name> — <stakeholder name>", publicId: generatePublicId(), status: "PENDING", bucketId: master.bucketId, uploaderId: membership.memberId, companyId, workflow: "SUBSCRIPTION", isMaster: false, sourceTemplateId: master.id, stakeholderId, orderedDelivery: true, message }`; recipients: investor `{ email: stakeholder.noticeEmail ?? stakeholder.email, name: stakeholder.name, role: "investor", signingOrder: 1, stakeholderId, status: "PENDING" }`, manager `{ email: user.email, name: user.name, memberId: managerMemberId, role: "manager", signingOrder: 2, status: "PENDING" }`; fields: every master field copied with a new id, `templateId` = the packet, `recipientId` = the packet recipient with the same role, `prefilledValue: null`, all other columns (including `semanticKey`, `meta`, geometry, `required`, `readOnly`, `defaultValue`) unchanged. After commit: `eSignNotificationEmailJob.emit` for the investor with the same payload shape as `add-fields.ts:188-209` (the worker marks the recipient `SENT`). Audit `admission.sent`, targets template and stakeholder. No Final Closing Date check here (the UI shows a warning when today is after it; acceptance enforces it).
  - **W-9 token**: `encodeW9Token({ templateId, recipientId })` = `encodeWithExpiry({ p: "w9", id: templateId, rec: recipientId }, "30d")`; `decodeW9Token` verifies and requires `p === "w9"`. A W-9 token is valid when the template has `workflow = "SUBSCRIPTION"`, status `PENDING` or `COMPLETE`, and the recipient has role `investor` and status `SIGNED`.
  - **`w9UploadUrl`**: valid token; fewer than 5 documents with `{ stakeholderId, kind: "w9", createdAt ≥ template.createdAt }`; returns `getPresignedPutUrl({ contentType, fileName, keyPrefix: "w9-docs", identifier: company.publicId, bucketMode: "privateBucket", signContentType: true })` from `@/server/file-uploads` (the unchecked server helper; never the server action).
  - **`w9Complete`**: valid token; `key` must start with `<company.publicId>/w9-docs-`; no `Bucket` row may already have this key; `headObject(key)` must exist, `size ≤ 10485760` and `contentType` one of the three types, otherwise `deleteObject(key)` and `BAD_REQUEST` "The file must be a PDF, JPEG or PNG of at most 10 MB."; then in a transaction `createBucketHandler` (`tags: [TAG.GENERIC]`, `user: { id: "", name: stakeholder.name, companyId }`) and `createDocumentHandler` (`name: "W-9 — <stakeholder name>"`, `stakeholderId`, `kind: "w9"`, `companyId`, `uploaderName: stakeholder.name`); audit `admission.w9-received`, actor `{ type: "company", id: companyId }`.
- **Emails** (`admission-notice-email.ts`: job `email.admission-notice`, schema `{ to: string, companyId: string, companyName: string, kind: "admission.w9-request" | "admission.signed-notice", heading: string, lines: string[], cta: { label: string, url: string } | null, stakeholderId?: string, templateId: string }`; worker renders `AdmissionNoticeEmail` (model on `src/emails/EsignConfirmationEmail.tsx`) and calls `sendMail(…, { kind, companyId, stakeholderId, relatedType: "template", relatedId: templateId })` with `X-From-Name: companyName`):
  - To the investor after signing: subject "Your signature page was received — please upload your Form W-9", line "Thank you. <Company> has received your signed signature page. Please upload a completed IRS Form W-9 using the secure link below. Your subscription is subject to acceptance by the Manager.", CTA "Upload Form W-9" → `<base>/w9/<w9Token>`.
  - To the Manager recipient: subject "<Investor> signed the subscription — review required", line "Review the answers, confirm the wire and accept, reduce or reject within 10 business days (Section 4.8).", CTA "Review subscription" → `<base>/<companyPublicId>/admissions/<templatePublicId>`.
- **Pages**:
  - `/[publicId]/admissions`: `requireLlc()`; `allow(Promise.all([api.admission.masters(), api.admission.list()]), ["commitments", "read"])`. Section "Subscription masters": list (name, fields, "Ready" or "Missing: key, key…", buttons "Edit fields" → `/documents/esign/<publicId>`, "Archive"); "Upload master" dialog: PDF picker → `uploadFile(file, { identifier: companyPublicId, keyPrefix: "unsigned-esign-doc" })` → `api.bucket.create` (`tags: [TAG.ESIGN]`) → `admission.createMaster` → navigate to the editor (same sequence as `src/components/modals/esign-doc/steps/add-recepients-step.tsx:66-93`). Helper text: "Place one field per Exhibit B blank and choose its meaning. To let a different Manager signatory sign on their own line, keep one master per signatory." Section "Subscriptions": `PacketTable` columns Investor (link to member), Email, Stage badge, W-9 (count), Sent, actions: Review (→ `/admissions/<publicId>`, all stages after `AWAITING_INVESTOR`), Resend, Cancel. Header action "Send subscription" (dialog: master select (only ready masters), existing member/prospect select or "New person" name + email, Manager signer select from `api.member.getMembers`, optional message; warning line when today is after the Final Closing Date: "The Final Closing Date has passed. Only Replacement Funders and Substitute Members may be admitted (Section 4.8)."). Empty states: no masters → "Upload the Exhibit B signature page to start."; no packets → "No subscriptions have been sent."
  - `/w9/[token]` (public, in the `(documents)` group): server component calls `api.admission.w9Info({ token })`; on error render `EmptyState` (error) "This link is invalid or has expired."; otherwise `W9Upload` (client): explains "Upload your completed IRS Form W-9 (PDF, JPEG or PNG, up to 10 MB). It is stored privately and is visible only to the Manager."; file input validated client-side (type and size); flow `w9UploadUrl` → `fetch(url, { method: "PUT", headers: { "Content-Type": file.type }, body: file })` → `w9Complete`; states: uploading (disabled button), success ("Thank you, your Form W-9 was received. You can close this page."), limit reached (`remaining === 0`: "The maximum number of uploads was reached. Email the Manager."), error (message from the server).
- **Unit tests**: `src/lib/admission/packet-stage.test.ts` — one case per stage (7 cases) plus: investor signed + commitment `REDUCED` + manager `SENT` → `AWAITING_COUNTERSIGN`; template `CANCELLED` + commitment `REJECTED` → `REJECTED`.
- **Acceptance**:
  - One master is used to send two packets to two investors without re-uploading or re-placing fields; each packet has its own recipients and fields.
  - After the investor signs: no signing email is sent to the Manager recipient; the Manager gets the review notice; the investor gets the W-9 email; the browser lands on `/w9/<token>`.
  - A W-9 token cannot be used at `/esign/<token>` and a signing token cannot be used at `/w9/<token>`.
  - Uploading a 12 MB file or a `.html` file is refused and leaves no `Bucket`/`Document` row and no object.
  - The uploaded W-9 appears under the member's Documents tab (kind `w9`) and opens only for team members with `documents: read`.
  - `EmailLog` has rows of kind `esign.request`, `admission.w9-request`, `admission.signed-notice`.
- **Do not touch**: `src/lib/upload-authorization.ts`, `src/server/file-upload-actions.ts`, `STANDARD` branches of `sign-template.ts`.

---

### F13 — Manager confirmation screen and countersignature

- **Goal**: turn a signed Exhibit B into a Stakeholder, a Commitment and receipts, then countersign with ledger-accurate figures and file the PDF on the member.
- **Prerequisites**: F7, F12.
- **Split**: **F13a** (needs F6b, F12a) = `exhibit-b-answers.ts` (+ test), the five procedures, the router registration, the completion hook in `src/server/esign.ts`. **F13b** (needs F13a, F7b, F12b) = the page and `src/components/llc/admission/confirm/**`.
- **Create**: `src/lib/admission/exhibit-b-answers.ts` (+ `.test.ts`), `src/trpc/routers/admission-router/procedures/get-packet.ts`, `confirm-details.ts`, `reject-packet.ts`, `reassign-manager.ts`, `prepare-countersign.ts`, `[publicId]/admissions/[templatePublicId]/page.tsx`, `src/components/llc/admission/confirm/answers-panel.tsx`, `details-form.tsx`, `receipts-section.tsx`, `decision-section.tsx`, `countersign-section.tsx`.
- **Modify**: `src/trpc/routers/admission-router/router.ts` (register the five procedures); `src/server/esign.ts` `completeEsignDocuments`: after the document is created, when the template has `workflow = "SUBSCRIPTION"` and a `stakeholderId`, update the document with `{ stakeholderId, kind: "exhibit-b" }` and write audit `document.attached` (actor `{ type: "company", id: companyId }`, targets document and stakeholder) in the same transaction.
- **Pure mapper** `mapExhibitBAnswers(fields: { semanticKey: string | null; prefilledValue: string | null }[]): { raw: Record<string, string>; parsed: ExhibitBParsed; issues: string[] }` with `ExhibitBParsed = { committedCents: number | null; paidCents: number | null; accreditationBasis: AccreditationBasis | null; legalName: string; holderType: HolderType | null; residenceState: string | null; investmentSummaryDate: DateOnly | null; streetAddress: string; city: string; state: string | null; zipcode: string; email: string | null; signerName: string; signerTitle: string; investorSignDate: DateOnly | null }`:
  - money via `parseDollarsToCents` (`null` + issue "Could not read the committed amount: "<raw>"" when unparseable);
  - `accreditation_basis` / `holder_type`: the stored value is the option id (enum name); anything else → `null` + issue;
  - `residence_state` / `address_state`: accept a 2-letter code (any case) or a full state name from a table passed in as a second argument `states: { code: string; name: string }[]` (the caller passes `src/lib/states.ts`); otherwise `null` + issue;
  - dates: `DATE` fields store `YYYY-MM-DD`; invalid → `null` + issue;
  - `email`: trimmed, lower-cased; invalid → `null` + issue;
  - `signer_name_title`: split at the first comma: `"Jane Doe, Managing Member"` → name `"Jane Doe"`, title `"Managing Member"`; no comma → name only;
  - cross-checks adding issues (never blocking): paid < 40% of committed ("Paid with the signature page is below the 40% Initial Installment (Section 4.9)"); committed below $100,000 ("Below the minimum; a waiver is needed (Section 3.7)" — the caller passes the class terms as a third argument); holder type `ENTITY`/`TRUST` without a signer name.
- **Procedures** (`withLlcAccessControl`):
  - `admission.get` — policy `commitments: read`; input `{ publicId }`; output `{ packet: { publicId, name, stage, createdAt, sourceMasterName: string | null }, stakeholder: MemberDTO, answers: { raw, parsed, issues } | null (null before the investor signs), commitment: CommitmentDTO | null, w9Documents: { id, name, createdAt, bucketKey }[], manager: { memberId: string | null, name: string | null, status, isCurrentUser: boolean }, signedDocument: { id, name, bucketKey } | null, classTerms: UnitClassDTO, otherAcceptedCents: Cents, today: DateOnly }`. Template by `{ publicId, companyId, workflow: "SUBSCRIPTION", isMaster: false }` else `NOT_FOUND`.
  - `admission.confirmDetails` — policy `commitments: update`; input `{ publicId, stakeholder: { name, holderType, residenceState, accreditationBasis, streetAddress, city, state, zipcode (all required), noticeEmail?, signerName?, signerTitle?, phone?, isInsider: boolean }, commitment: { committedCents: ZCents (>0), signedOn: ZDateOnly, investmentSummaryDate: ZDateOnly } }`; preconditions: stage `AWAITING_REVIEW`. In one transaction: update the packet's stakeholder (`where: { id, companyId }`; `signerName` required for `TRUST`/`ENTITY`; `email` is not changed here — a different email typed by the investor goes to `noticeEmail`); when the packet has no commitment → `createCommitment` (class = PREFERRED, `accreditationBasis` from the input) and set `Template.commitmentId`; otherwise `updatePendingCommitment`. Audit `admission.confirmed`. Output: same as `admission.get`.
  - Receipts and the decision use the F6 procedures (`commitment.recordReceipt`, `commitment.accept`) with the packet's `commitmentId`.
  - `admission.reject` — policy `commitments: update`; input `{ publicId, decidedOn: ZDateOnly, reason: string (min 3) }`; stage `AWAITING_REVIEW` with a commitment; one transaction: `decideCommitment(REJECT)`, which also cancels the packet (F6); audit `commitment.rejected` (from the service) and `admission.cancelled`.
  - `admission.reassignManager` — policy `commitments: update`; input `{ publicId, managerMemberId }`; allowed while the manager recipient is not `SIGNED`; updates the manager recipient's `memberId`, `name`, `email` and resets its status to `PENDING`.
  - `admission.prepareCountersign` — policy `commitments: update`; input `{ publicId }`; preconditions: stage `AWAITING_COUNTERSIGN`; `ctx.membership.memberId` equals the manager recipient's `memberId` (else `BAD_REQUEST` "Only <name> can countersign this packet. Reassign the signer first."). In one transaction: compute from the ledger `received = Σ appliedCents` of the commitment's non-void receipts and `units = Σ unitsIssued`; set on the packet's fields (by `semanticKey`, manager role): `contribution_received` → `prefilledValue = formatCents(received)`, `readOnly = true`; `units_issued` → `prefilledValue = trimUnits(units)`, `readOnly = true`; `manager_sign_date` → `prefilledValue = commitment.acceptedOn` (stays editable); set the manager recipient `status = "SENT"`; audit `admission.countersign-ready`. Return `{ token: await EncodeEmailToken({ templateId, recipientId }) }`; the client navigates to `/esign/<token>` (the existing signing page; after signing, `sign-template` completes the document because all recipients are signed).
- **Page** `/[publicId]/admissions/[templatePublicId]`: `requireLlc()`; `allow(api.admission.get({ publicId }), ["commitments", "read"])`; `notFound()` on `NOT_FOUND`. Layout: header (investor name, stage badge, link to the member page, "Cancel" / "Reject" where allowed). Sections, each enabled by stage:
  1. **Investor's answers** (`answers-panel.tsx`): two columns "As signed" (`raw`, read-only) and the `issues` list as amber notes. Before the investor signs: "Waiting for the investor to sign (sent to <email>)." with "Resend".
  2. **Member and commitment details** (`details-form.tsx`): form prefilled from `parsed` (falling back to the stakeholder's current values); fields of `confirmDetails`; insider checkbox with helper "Tick for the Manager, Isaac Reid, Karl Schoen, their affiliates, spouses, descendants and their trusts or entities (Section 1.18)."; W-9 status line ("W-9 received on <date>" with an Open link via `getPresignedGetUrl`, or "No W-9 yet — the investor has an upload link"; the Manager can also attach one from the member page). Button "Save details" → `confirmDetails`.
  3. **Wire receipts** (`receipts-section.tsx`, enabled once a commitment exists): the commitment's receipts and the F7 `RecordReceiptDialog` (default amount = `parsed.paidCents`); shows "Decide by <effectiveDecisionDeadline>".
  4. **Decision** (`decision-section.tsx`): the F7 `DecideCommitmentDialog` and `admission.reject`. After acceptance shows status, accepted amount, units issued, refund due if any.
  5. **Countersign** (`countersign-section.tsx`, stage `AWAITING_COUNTERSIGN`): shows the figures that will be printed ("Capital Contribution received: $100,000.00 — Preferred Units issued: 100"), the designated signer, "Reassign signer", and "Countersign now" (→ `prepareCountersign` → navigate). Stage `FINALISING`: "The signed document is being generated." Stage `COMPLETE`: link to the signed PDF (`signedDocument`) and to the member's Documents tab.
- **Worked examples (tests for the mapper)**:
  - Raw `{ commitment_amount: "$250,000", amount_paid: "100,000.00", accreditation_basis: "NET_WORTH", legal_name: "Jane Doe", holder_type: "INDIVIDUAL", residence_state: "kentucky", investment_summary_date: "2026-11-05", address_street: "1 Main St", address_city: "Frankfort", address_state: "KY", address_zip: "40601", email: " Jane@Example.com ", investor_sign_date: "2026-11-12" }` → `committedCents 25000000`, `paidCents 10000000`, `residenceState "KY"`, `email "jane@example.com"`, no issues.
  - `amount_paid: "99,999"` with committed 250,000 → issue about the 40% Initial Installment.
  - `commitment_amount: "two hundred thousand"` → `committedCents null` + issue.
  - `commitment_amount: "75000"` → issue about the minimum.
  - `holder_type: "ENTITY"`, `signer_name_title: "Jane Doe, Managing Member"` → name/title split; without `signer_name_title` → issue.
  - `accreditation_basis: "something"` → `null` + issue.
- **Acceptance** (end to end, with the F6 example figures): send → investor signs (commitment $250,000, paid $100,000) → W-9 uploaded → Manager saves details → records the $100,000 wire → accepts in full on `2026-11-13` → countersigns. Result: stakeholder `MEMBER`, `admittedOn 2026-11-13`; commitment `ACCEPTED`; one applied receipt with 100 units; the stamped PDF shows "$100,000.00" and "100" on the Manager's lines and dates as `MM/DD/YYYY`; the PDF is a `Document` of kind `exhibit-b` on the member; the W-9 is a `Document` of kind `w9`; the Member Schedule lists the member. Countersigning is impossible before acceptance (the Manager's token is not `SENT`, so `/esign/<token>` fails). Rejecting cancels the packet and shows the refund due date.
- **Do not touch**: the F5 rules, the F6 services (call them; do not re-implement), `src/jobs/**`.

---

### F14 — Exhibit A CSV import

- **Goal**: load members who were admitted on paper, with the same rules as manual entry.
- **Prerequisites**: F4 (a and b), F6 (a and b).
- **Create**: `src/lib/admission/exhibit-a-csv.ts` (+ `.test.ts`), `src/trpc/routers/stakeholder-router/procedures/import-exhibit-a.ts`, `src/components/llc/member/import-exhibit-a-dialog.tsx`.
- **Modify**: `src/trpc/routers/stakeholder-router/router.ts` (register `importExhibitA`); `[publicId]/stakeholders/page.tsx` LLC branch: add the "Import Exhibit A" button next to "Add member".
- **CSV format** (header row required; names matched case-insensitively after trimming):

| Column | Required | Meaning |
|---|---|---|
| `Member` | yes | legal name; rows whose value starts with "Total" are skipped |
| `Capital Contribution Committed` | yes | dollars |
| `Paid to Date` | yes | dollars, `≤` committed |
| `Preferred Units` | no | when present must equal Paid ÷ price per unit to 6 decimals |
| `Preferred Unit Percentage Interest` | no | ignored (recomputed) |
| `Date Admitted` | yes | `YYYY-MM-DD` or `M/D/YYYY` |
| `Notice Address and Email` | yes unless `Email` is present | the first email-shaped token is the email; the rest (trimmed of separators `;`, `,`) is stored as `streetAddress` |
| `Email`, `Street Address`, `City`, `State`, `Zip` | no | override the combined column |
| `Holder Type` | no | `individual` / `joint` / `trust` / `entity` (default `individual`) |
| `State of Residence` | no | 2-letter code |
| `Accreditation Basis` | no | an `AccreditationBasisEnum` name |
| `Signer Name`, `Signer Title` | no | required by rule for trust/entity |
| `Insider` | no | `yes` / `no` (default `no`) |
| `Minimum Waived` | no | `yes` / `no` (default `no`) |
| `Receipt Date` | no | default = `Date Admitted` |
| `Wire Reference` | no | |

- **Pure parser** `parseExhibitACsv(text: string, opts: { pricePerUnitCents: bigint }): { rows: ExhibitARow[]; errors: { line: number; message: string }[] }` using `Papa.parse(text, { header: true, skipEmptyLines: true })` (papaparse is already a dependency, `src/lib/stakeholders-csv-parser.ts:1`). `ExhibitARow = { line, name, email, committedCents: bigint, paidCents: bigint, admittedOn, receiptDate, streetAddress?, city?, state?, zipcode?, holderType, residenceState?, accreditationBasis?, signerName?, signerTitle?, isInsider, minimumWaived, wireReference? }`. Errors: missing required column (line 1); unparseable money/date; paid > committed; units mismatch ("Preferred Units 41 does not match Paid to Date $40,000.00 at $1,000.00 per unit (expected 40)"); duplicate email within the file; more than 100 data rows.
- **Procedure** `stakeholder.importExhibitA` — `withLlcAccessControl`, policies `stakeholder: create` and `commitments: create`; input `{ csvText: string (max 200,000 chars), dryRun: boolean }`; output `{ rows: { line, name, email, committedCents: Cents, paidCents: Cents, units: Units, admittedOn: DateOnly, action: "create" | "use-existing", errors: string[] }[], fileErrors: { line, message }[], totals: { committedCents: Cents, paidCents: Cents, units: Units }, canImport: boolean }`.
  - The server parses the text itself. Then, in file order with a running `otherAcceptedCents` (existing accepted total of the class + previous rows), it runs `validateAcceptance` per row with `acceptedCents = committedCents`, `keepCents = paidCents`, `heldCents = paidCents`, `acceptedOn = admittedOn`, `signedOn = null`, `today` in the company time zone; plus: an existing stakeholder with the row's email is reused only when it has no `ACCEPTED`/`REDUCED`/`PENDING` commitment in the PREFERRED class (else error "already has a commitment").
  - `dryRun: true` → return the preview, write nothing. `dryRun: false` → when `canImport` is false throw `BAD_REQUEST` "Fix the listed errors first."; otherwise one transaction (`{ timeout: 60000 }`): per row create/update the stakeholder (same field mapping as `createMember`/`updateMember`), `createCommitment` (`signedOn = admittedOn`), `recordCapitalReceipt` (`receivedOn = receiptDate`, `amountCents = paidCents`, `reference`; skipped when paid is 0, which the 40% rule already rejects), `decideCommitment(ACCEPT, acceptedOn = admittedOn, keepCents = paidCents, minimumWaived)`. One summary audit `stakeholder.imported` ("… imported N members from Exhibit A: $X committed, $Y paid") in addition to the per-entity audits written by the services.
- **Dialog**: file input (`.csv`) or paste area; "Download template" (a client-side generated file with the header row and one example line); step 1 "Check" (`dryRun: true`) → preview table with per-row errors in red and totals; step 2 "Import N members" enabled only when `canImport`; success toast and `router.refresh()`. Note under the preview: "Receipt date defaults to the admission date; the Preferred Return starts on the receipt date. Correct individual receipts afterwards if the wire arrived on a different day."
- **Worked examples (parser tests)**:
  - Text:
    ```
    Member,Capital Contribution Committed,Paid to Date,Preferred Units,Preferred Unit Percentage Interest,Date Admitted,Notice Address and Email
    Jane Doe,"$250,000.00","$100,000.00",100,71.4286%,11/13/2026,"1 Main St, Frankfort, KY 40601; jane@example.com"
    Acme Holdings LLC,100000,40000,40,28.5714%,2026-11-16,"2 Oak Ave, Cheyenne, WY 82001; ops@acme.test"
    Total,350000,140000,140,100%,,
    ```
    → 2 rows; row 1 `committedCents 25000000n`, `paidCents 10000000n`, `admittedOn "2026-11-13"`, `email "jane@example.com"`, `streetAddress "1 Main St, Frankfort, KY 40601"`; the Total line is skipped; no errors.
  - Same with `Preferred Units` 41 on row 2 → one error on line 3 with the units message.
  - A row with `Paid to Date` 300000 and committed 250000 → error; two rows with the same email → error on the second; a file without `Date Admitted` → one error on line 1 and no rows; date `13/45/2026` → error.
  - Server-side examples (verify by hand against a local database): the two-row file with closing `2026-11-30` imports 2 members, 140 units, Balance $210,000.00; adding a third row of $60,000 without `Minimum Waived` → row error `MINIMUM_WAIVER_REQUIRED` and nothing is imported; a row dated `2026-12-05` → `AFTER_FINAL_CLOSING`.
- **Acceptance**: a failing row imports nothing (all-or-nothing); importing the same file twice fails on the second run with "already has a commitment"; imported members appear on the Member Schedule with the file's figures; no silent duplicate skipping anywhere.
- **Do not touch**: `src/lib/stakeholders-csv-parser.ts` and the C-corp import modal.

---

### F15 — Multi-entity readiness

- **Goal**: a second LLC can be created and operated next to the first.
- **Prerequisites**: F2.
- **What breaks today with a second company, and where it is fixed**:

| Problem | Evidence | Fix |
|---|---|---|
| The same investor or Manager entity cannot be a stakeholder of both companies | `Stakeholder.email @unique` | F0 (`@@unique([companyId, email])`), F4 (duplicate handling) |
| Duplicate emails are skipped silently on import | `add-stakeholders.ts:22-25` | F4, F14 |
| A link to company B opened while the session is on company A lands on A's overview (review links in emails, bookmarks) | `[publicId]/layout.tsx:26-28` | this package |
| A new LLC has no unit classes | — | F2 (seed in `onboard` and `setEntityType`) |
| Offering terms and dates are per deal | — | F3 (per-class settings) |
| Emails from both companies say "Captable" | `mailer.ts:18` | F10/F12 (`X-From-Name` = company name) |

- **Not fixed (documented limits)**: one `EMAIL_FROM` address per deployment; subscription masters are per company (upload again for the second LLC); `BankAccount @@unique([companyId, primary])` (A3.6); company logos are keyed by the uploading user.
- **Create**: `src/app/(authenticated)/switch/[publicId]/page.tsx` (server component) and `src/components/llc/switch-company.tsx` (client).
  - Page: `withServerComponentSession()`; find `db.member.findFirst({ where: { userId: session.user.id, status: "ACTIVE", isOnboarded: true, company: { publicId } }, select: { id: true } })`; none → `redirect("/" + session.user.companyPublicId)`; read `searchParams.next`; it is used only when it starts with `"/" + publicId + "/"` or equals `"/" + publicId` (otherwise `"/" + publicId`); render `<SwitchCompany memberId next />`.
  - Client: on mount `await switchCompany.mutateAsync({ id: memberId }); await update(); router.replace(next);` (same calls as `src/components/dashboard/sidebar/company-switcher.tsx:50-56`); shows "Switching company…".
- **Modify**:
  - `src/proxy.ts`: forward the path to server components: `const headers = new Headers(request.headers); headers.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search); return NextResponse.next({ request: { headers } });` (logging unchanged).
  - `[publicId]/layout.tsx`: replace the redirect at `:26-28` with: when `user.companyPublicId !== publicId`, `const next = (await headers()).get("x-pathname") ?? "/" + publicId; redirect("/switch/" + publicId + "?next=" + encodeURIComponent(next));` (the switch page falls back to the current company when the user is not a member of the target).
- **Unit test**: extract the `next` validation into `src/lib/safe-next-path.ts` (`safeNextPath(publicId: string, next: string | undefined): string`) + test: `("abc", "/abc/admissions/x")` → same; `("abc", "/abc")` → same; `("abc", "/other/x")` → `"/abc"`; `("abc", "https://evil.test")` → `"/abc"`; `("abc", "//evil.test")` → `"/abc"`; `("abc", undefined)` → `"/abc"`; `("abc", "/abcd/x")` → `"/abc"`.
- **Acceptance**: with memberships in two companies, opening `/<B>/admissions/<id>` while on A switches to B and shows the page; opening `/<unknown>/…` returns to A; no open redirect through `next`; a user with one company sees no change.
- **Do not touch**: `src/server/auth.ts`, `company.switchCompany`.

---
## E. Interfaces

### E1. What FOUNDATION exports to ECONOMICS and GOVERNANCE

**Conventions**: B1–B7 (money as `BigInt` cents / `number` on the wire, units `Decimal(18,6)` / 6-dp string, date-only `@db.Date` / `YYYY-MM-DD`, company time zone, throwing procedures, tenant rule, hotspot files).

**Helpers** (import paths are final):

| Symbol | File | Package |
|---|---|---|
| `parseDollarsToCents`, `formatCents`, `centsToNumber`, `numberToCents`, `mulBpsCeil`, `mulDivRoundHalfUp`, `ZCents` | `src/lib/money.ts` | F1 |
| `ZDateOnly`, `toDateOnly`, `fromDateOnly`, `todayInTimeZone`, `compareDateOnly`, `maxDateOnly`, `minDateOnly`, `diffInDays`, `formatDateOnly`, `isValidTimeZone` | `src/lib/date-only.ts` | F1 |
| `getVocabulary` | `src/lib/vocabulary.ts` | F1 |
| `getSessionEntity`, `requireLlc`, `requireCorporation` | `src/server/entity.ts` | F1 |
| `useEntity`, `useVocabulary` | `src/providers/entity-provider.tsx` | F1 |
| `withLlcAccessControl` (adds `ctx.company = { id, publicId, name, entityType, timezone }`) | `src/trpc/api/trpc.ts` | F1 |
| `unitsToWire`, `dateToWire`, `trimUnits` | `src/server/llc/serialize.ts` | F1 |
| `assertCompanyOwns` with `unitClassIds`, `commitmentIds`, `capitalReceiptIds`, `templateIds` | `src/server/tenant-ownership.ts` | F1 |
| `ComingSoon` | `src/components/llc/coming-soon.tsx` | F2 |
| `getMemberPositions`, `getClassTotals`, type `MemberPosition` | `src/server/llc/positions.ts` | F6 |
| `createCommitment`, `decideCommitment`, `recordCapitalReceipt`, `voidCapitalReceipt`, `setReceiptPrefReturnStart`, `reduceAcceptedCommitment`, `recordRefund`, `admitStakeholder`, `lockUnitClass` (`refreshSubscriptionClock` is internal) | `src/server/llc/commitments.ts` | F6 |
| `ledgerInvariantErrors` (the F6 ledger invariant, for tests and checks) | `src/server/llc/receipt-rules.ts` | F6 |
| `loadMemberSchedule`, type `MemberScheduleDTO` | `src/server/llc/member-schedule.ts`, `src/lib/admission/member-schedule.ts` | F8 |
| `sendMail(options, log?: EmailLogContext)` | `src/server/mailer.ts` | F10 |
| `filterSignerValues`, `RECIPIENT_ORDER`, `encodeWithExpiry` | `src/lib/esign/filter-signer-values.ts`, `src/services/esign-service.ts`, `src/lib/jwt.ts` | F11 |
| `cloneMasterToPacket` (master + role recipients → single-use envelope) | `src/server/llc/admission.ts` | F12 |

**Model fields other areas read** (never write except through the services above):

- `UnitClass`: `kind`, `pricePerUnitCents`, `fractionalUnitsAllowed`, `votesPerUnit`, `prefReturnBps`, `prefReturnDayCount`, `balanceReturnStartRule`, `residualSplitBps`, `initialInstallmentBps`, `finalClosingDate`, `balanceOutsideDate`.
- `Commitment`: `status`, `committedCents`, `acceptedCents`, `acceptedOn`, `isReplacement`, `stakeholderId`, `unitClassId`.
- `CapitalReceipt`: `kind`, `receivedOn`, `amountCents`, `appliedCents`, `unitsIssued`, `appliedOn`, `prefReturnStartDate`, `voidedAt`, `sourceType`, `sourceId`. Unreturned-capital basis per receipt = `appliedCents` of non-void rows; accrual on a positive row starts at `prefReturnStartDate` (null = that row accrues nothing). A `FORFEITURE` row has `prefReturnStartDate = null` but is not "no accrual": its negative `appliedCents` reduces the holder's accrual base from the Forfeiture Date (its `receivedOn`, equal to its `appliedOn`), so the return on the Forfeited Amount stops (Section 4.9(iv)); ECONOMICS' `loadLedger` maps it to a `FORFEITURE` event and `computePositions` (step 6) reduces the lots (02-economics R5, R34). `appliedOn` is never earlier than `receivedOn` or the commitment's `acceptedOn`.
- `Stakeholder`: `memberStatus` (`MEMBER` votes; `FINANCIAL_INTEREST_ONLY` does not, Sections 1.8, 1.23), `isInsider` (not "Disinterested", Section 1.18), `admittedOn`, `noticeEmail ?? email` (notice address, Sections 4.9, 13.6), `phone`.
- `EmailLog`: write through `sendMail`; set `relatedType`/`relatedId` to your own entity (e.g. `"callNotice"`), and read `sentAt` / `bounceState` as delivery evidence.
- `Document.kind` is a free string; add your own keys (e.g. `"k1"`, `"quarterly-report"`) and set `stakeholderId` to file a document on a member.

**Routes and slots**: placeholder pages listed in B12 (replace the page content; do not rename the route); `src/components/llc/overview/economics-slot.tsx` (ECONOMICS overview widgets); the comment slot in `[publicId]/settings/llc/page.tsx` (ECONOMICS `LlcTerm` form); member detail page tabs (add a tab by editing `[publicId]/stakeholders/[stakeholderId]/page.tsx` only after F7 and F10 are merged).

**RBAC subjects** added by F1: `unit-classes`, `commitments`, `emails`. Other areas append their own subjects to `src/lib/rbac/subjects.ts` in their first package, after F1 is merged. **Audit**: append actions/targets to `src/server/audit/schema.ts` the same way.

### E2. What FOUNDATION needs from ECONOMICS

1. `src/lib/llc/business-days.ts` (pure, relative imports), before F6:
   - `addBusinessDays(date: DateOnly, n: number): DateOnly` — `n ≥ 0`; the day after `date` is day 1; business day = Monday–Friday that is not a US federal holiday (including observed dates when a holiday falls on a weekend). Reference values: `("2026-11-02", 10)` → `"2026-11-17"`; `("2026-11-17", 5)` → `"2026-11-24"`; `("2026-11-20", 10)` → `"2026-12-07"`; `("2026-12-07", 5)` → `"2026-12-14"`; `("2026-11-12", 10)` → `"2026-11-27"`.
   - `isBusinessDay(date: DateOnly): boolean`.
2. `src/lib/llc/units.ts` (pure), before F6:
   - `unitsForAmount(amountCents: bigint, pricePerUnitCents: bigint, fractionalAllowed: boolean): string` — 6-dp string, truncated toward zero; whole units only (floor) when `fractionalAllowed` is false; throws when `pricePerUnitCents ≤ 0` or `amountCents < 0`. Reference values at $1,000: `10000000n` → `"100.000000"`; `4020000n` → `"40.200000"`; `1234567n` → `"12.345670"`; `1n` → `"0.000010"`; `4020000n` with `fractionalAllowed = false` → `"40.000000"`.
3. `LlcTerm` must not duplicate `finalClosingDate`, `balanceOutsideDate`, the minimum, the cap, the initial-installment percentage, the return rate or the residual split; those are read from `UnitClass`.
4. All `REPLACEMENT`, `CREDIT` and `FORFEITURE` receipts, every reduction of an accepted commitment (Section 4.9(ii)) and every change of a receipt's accrual start go through the F6 services. A Replacement Funder gets a `Commitment` created with `isReplacement: true` and accepted with `skipClosingDateCheck: true` (ECONOMICS checks the June 30, 2027 limit itself); it may be accepted at a reduced amount and is then funded with a `REPLACEMENT` receipt on the `REDUCED` commitment. In one transaction, reduce the Defaulting Member's commitment (`reduceAcceptedCommitment`) first, then create and accept the Replacement commitment, because the offering cap counts the defaulter's `acceptedCents` until it is reduced. `CREDIT`, `FORFEITURE` and `REPLACEMENT` receipts cannot be dated after today (company time zone).
5. `CapitalReceipt.prefReturnStartDate` is the default accrual start of the whole receipt. ECONOMICS may refine it per slice in its own `CallNoticeAllocation` rows and compute accrual from its `buildCapitalLots()`; in that case it is the only code that computes accrual, and FOUNDATION only displays `prefReturnStartDate` as "Return starts (default)". ECONOMICS passes `dueDate` to `recordCapitalReceipt` for Balance money it records itself; `setReceiptPrefReturnStart` remains available when a whole receipt moves. (The F7 "Record receipt" dialog records Balance money without a due date; if ECONOMICS wants receipts matched to Call Notices in that dialog, it adds an optional Call Notice select there in its own package.)
6. Section 4.9(ii) reductions are written to the ledger with `reduceAcceptedCommitment` (ECONOMICS keeps its own funding rows as the trail). `Commitment.acceptedCents` is the single figure used for the cap, Exhibit A and the outstanding Balance; it must not be derived differently elsewhere.
7. `BankAccount` (create/list, the `@@unique([companyId, primary])` defect, wire instructions) is not in the FOUNDATION plan; ECONOMICS owns it. A change to that unique index is not additive and must be listed explicitly in F0.
8. `src/lib/llc/money.ts` and `dates.ts` must not redefine `parseDollarsToCents` / `formatCents` / date-only conversion with different behaviour: import them from `../money` and `../date-only` (F1) or keep byte-identical semantics (`isoToUtcDate` ≡ `fromDateOnly`).
9. Default suspension (Section 4.9(iii)) and votes are computed by ECONOMICS/GOVERNANCE from `MemberDefault`; FOUNDATION does not change `memberStatus` for a default.

### E3. What FOUNDATION needs from GOVERNANCE

0. GOVERNANCE calls `sendMail(options, { kind, companyId, stakeholderId, relatedType, relatedId })` (there is no separate `sendLoggedMail`); "undelivered" is `EmailLog.bounceState = BOUNCED`, set through `emailLog.markBounce`. Its member-detail tab (`governance.memberActivity`) is added to `[publicId]/stakeholders/[stakeholderId]/page.tsx` after F4b, F7b and F10b are merged. Its `Document.recordCategory` / `recordYear` columns go into F0.
1. `UnitTransfer` is folded into `getMemberPositions` (edit `src/server/llc/positions.ts` in a GOVERNANCE package after F6): units and capital move from transferor to transferee as of the effective date; nothing else computes holdings. The Member Schedule then reflects transfers without changes to F8.
2. A transferee who is not admitted is set to `FINANCIAL_INTEREST_ONLY` in the transfer service; a Substitute Member is admitted with `admitStakeholder` (F6a).
3. `RecordSnapshot` stores GOVERNANCE's own entry rows built from `getMemberPositions` (and ECONOMICS' suspended-units function); `loadMemberSchedule` stays available but is not required. A snapshot and the Member Schedule for the same `asOf` must show the same units, because both read `getMemberPositions`.
4. Resolutions and ballots do not use the e-sign engine (GOVERNANCE has its own tokenized ballot page). Nothing in F11–F13 is sized for GOVERNANCE, and GOVERNANCE never edits `sign-template.ts`.
5. The transfer fold-in (GOVERNANCE package G16b): COMPLETED `UnitTransfer` rows move units exactly and `capitalCents` / `cashAppliedCents` pro rata (`mulDivRoundHalfUp`); committed amount and outstanding Balance stay with the transferor (Section 7.9.2). No receipts are written for a transfer.

---

## F. Risks and open questions

Only items that would change the plan. Each has the default this plan assumes.

| # | Question / risk | Default assumed | Changes if answered differently |
|---|---|---|---|
| Q1 | The contract lists four receipt kinds; Section 4.9(iv) forfeiture reduces a Defaulting Member's capital and units, which they cannot express. | A fifth kind `FORFEITURE` (negative `appliedCents` and `unitsIssued`, no cash) is added; `CREDIT` is its positive counterpart. | If forfeiture must live only in `MemberDefault`, `getMemberPositions` has to subtract it and C2/F6 lose the kind. |
| Q2 | When a subscription is reduced, how much of the money already wired is returned? ("unaccepted portion of the Initial Installment", Section 4.8.) | Pro rata (`held × accepted / committed` is kept), editable by the Manager between 40% of the accepted amount and `min(held, accepted)`. | Only `defaultKeepCents` (F5) and its examples A8, A9. |
| Q3 | Does the Preferred Return on money wired before acceptance start on the wire date or on the acceptance date? | Wire date (`receivedOn`), per Section 5.6(b) "received by the LLC" and the owner default. | One line in `decideCommitment` (F6) and the F6 example. |
| Q4 | Refund deadline when the Manager decides early. | Always 5 business days after the end of the 10-business-day window (the latest date Section 4.8 allows), not 5 days after the decision. | `computeSubscriptionClock` and K1/K2. |
| Q5 | Admission date. | The acceptance date the Manager enters; the countersignature date field is prefilled with it. The countersigned PDF follows acceptance, so ledger and page agree. | F6 (`admittedOn`), F13 (ordering of accept and countersign). |
| Q6 | Accreditation is "check one of six boxes" on Exhibit B, but the signing UI has no checkbox field. | A `SELECT` whose chosen label is printed on one line; the owner's Exhibit B PDF needs a line such as "Basis selected: ____" and single-line blanks (8pt, no wrapping) for name and address parts. | Adding a checkbox field type is a new package touching the editor, the signing form and the PDF stamper (not planned). |
| Q7 | "Either signatory may sign for the Manager." | One Manager signer per packet, chosen at send time, reassignable; one master per signatory so the signature lands on the right printed line. | Supporting two alternative signature fields in one master needs "any one of" completion logic in `sign-template.ts`. |
| Q8 | Joint holders. | One stakeholder record (`holderType = JOINT`), one email, one signature. | A second investor recipient per packet (extra role in F11/F12). |
| Q9 | Offering terms live on `UnitClass`, not on ECONOMICS' `LlcTerm`. | As in C3. | If ECONOMICS already modelled them on `LlcTerm`, one of the two plans must drop the duplicates before F0. |
| Q10 | Time zone for "today". | Decided: `Company.timezone` is the single source, default `America/Denver`, editable in Settings; no time-zone field on `LlcTerm`. | — |
| Q11 | The Final Closing Date (2026-11-30) is 18 days away; the e-sign flow (F11–F13) will probably not be live for most admissions. | Rules are evaluated on entered dates, so paper admissions can be recorded afterwards by hand (F7) or by import (F14). Suggested priority if time is short: F0–F8, F14, F10, F9, then F11–F13, F15. | Scheduling only. |
| Q12 | E-sign evidence: drawn signature image, audit page with IP and browser, signing links that never expire, no certificate-based signature. Section 13.9 allows electronic signature. | Accepted as is. | Token expiry or stronger identity checks would be a separate package. |
| Q13 | Form W-9 contains a TIN. It is stored in the private bucket without application-level encryption and is readable by any team member with `documents: read`. | Accepted; no retention rule. | A dedicated RBAC subject or encryption would change F12 and F4. |
| Q14 | The public W-9 endpoints have no rate limiting (the app has none anywhere). | Token + type/size check + 5 uploads per packet. | Adding a limiter is infrastructure work outside this plan. |
| Q15 | Hiding C-corp pages for LLC companies uses guard layouts (redirect), and C-corp tRPC routers stay callable. | Acceptable: same company, same permissions, no data crosses tenants. | Server-side blocking would add an entity check to every C-corp procedure. |
| Q16 | `onDelete: Restrict` on ledger relations is emulated by the Prisma client (`relationMode = "prisma"`): the REST endpoint `DELETE /v1/{companyId}/stakeholders/{id}` will fail for a stakeholder with commitments. | Intended. | — |
| Q17 | F6 cannot start before ECONOMICS delivers `business-days.ts` and `units.ts`. | ECONOMICS schedules that library as its first package. | If not, FOUNDATION would need a temporary copy, which the contract forbids. |
| Q18 | Bounces cannot be detected over plain SMTP. | Manual "mark as bounced" in the email log. | A provider webhook (provider-specific) could set `bounceState` later without schema change. |

**Known limitations** (accepted as is; each would be its own change):

- **L1 — per-receipt flooring.** With `fractionalUnitsAllowed = false`, `unitsForAmount` floors each receipt separately, so a member who pays in several receipts can hold fewer whole units than one unit per $1,000 of the total (e.g. $40,500 + $59,500 → 40 + 59 = 99 units for $100,000). The Preferred class is seeded with fractions allowed (Section 4.9(iv)), so this arises only if that term is turned off.
- **M3 — `asOf` uses today's accepted amount.** `getMemberPositions(…, { asOf })` filters commitments by `acceptedOn` and receipts by `appliedOn`, but `committedCents` and `outstandingBalanceCents` use the current `acceptedCents`; after a later Section 4.9(ii) reduction a historical view shows the reduced commitment. No history of `acceptedCents` is kept (ECONOMICS' `MemberDefaultFunding` rows are the trail).
- **L3 — acceptance does not require `signedOn` or an accreditation basis.** `validateAcceptance` checks dates against `signedOn` only when it is set, and nothing requires an accreditation basis (Section 3.2); the Manager confirms both (the Exhibit B flow records them). Without `signedOn` the subscription clock (and so `refundDueBy` from it) is null and the fallback refund date is used.
- **L5 — `mergePositions` may return extra rows.** It returns one row per (stakeholder, class) that has any commitment, including rejected-only and pending-only ones with zero units; callers that show holders filter by units or status.
- **Split receipts cannot be voided.** A receipt the acceptance applied only in part (`0 < appliedCents < amountCents`) cannot be voided (F6.7), because nothing stores the `keepCents` the Manager chose and a re-recorded receipt could not reproduce it. A wrong split receipt needs a database correction by an administrator. A receipt that was applied in full or not at all can be voided; voiding an unapplied one on a `REDUCED` commitment and recording it again applies it in full within the outstanding Balance.
