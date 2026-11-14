# LLC mode — 03 Governance and reporting (implementation plan)

Scope: Resolutions (unit-weighted written consents and Manager resolutions), member reports and notices, compliance calendar, unit transfers, books and records.
Specification: the Operating Agreement of OCTAGON GPU I LLC, "Final v2" (`oa-final-v2-full.txt`). Section numbers below refer to it. Where this plan and the Agreement differ, the Agreement wins and the executor stops and reports.
Audience: an executor who has not seen the repo. Read section A once, then execute one work package from section D at a time.

Conventions used in this plan

- "Manager user" = a signed-in team user (`Member` model) of the company. "Member" (capital M, unqualified) = an LLC Member = a `Stakeholder` with `memberStatus = MEMBER`. The Prisma model `Member` is always written `Member` (team user) in code font.
- All new features are gated on `Company.entityType === "LLC"` (FOUNDATION).
- Units are decimal strings with 6 decimal places in TypeScript and `Decimal @db.Decimal(18, 6)` in Prisma. Vote math never uses floats.
- "BD" = business day (Monday–Friday excluding US federal holidays), from ECONOMICS `src/lib/llc/business-days.ts`.
- Calendar-day deadlines are NOT rolled to the next business day (the Agreement has no roll rule).
- Time zone: every "today" and every end-of-day deadline is computed in `Company.timezone` (FOUNDATION column, IANA name). The pure functions take the zone as an argument; the constant `GOVERNANCE_TIME_ZONE = "America/Denver"` is only their default and equals the column's default (used in tests and when the column is empty). Wherever a package below writes `todayInZone(now)`, `endOfDayInZone(x)`, `responseDeadline(...)` or "in `GOVERNANCE_TIME_ZONE`", server code passes `company.timezone`. A deadline "within N days" ends at 23:59:59.999 of day N in that zone.
- Money follows FOUNDATION: integer cents (`BigInt` columns named `...Cents`, `bigint` on the server, JS `number` in JSON, tRPC and job payloads). Units on the wire are 6-decimal strings.
- Sibling plans: `01-foundation.md` (packages `F*`) and `02-economics.md` (packages `E*`). Section E of this plan maps every name used here to theirs; where a sibling name changes, only the adapter files named in E change.
- Verification commands (run from the repo root, all must pass before a package is done):
  - `node_modules/.bin/tsc --noEmit`
  - `node_modules/.bin/biome check ./src`
  - `node_modules/.bin/vitest run`
  - `SKIP_ENV_VALIDATION=1 NODE_ENV=production node_modules/.bin/next build`

---

## A. Findings (current code; verified by reading)

### A1. tRPC, auth, RBAC

- Procedure builders: `withoutAuth` (public), `withAuth` (session), `withAccessControl` (session + ACTIVE membership + RBAC policy from `.meta({ policies })`) — `src/trpc/api/trpc.ts:201`, `:211`, `:213`. `withAccessControl` puts `ctx.membership = { companyId, memberId, role, customRoleId, ... }` and `ctx.permissions` on the context (`src/trpc/api/trpc.ts:110-114`). Context always has `ctx.db`, `ctx.requestIp`, `ctx.userAgent` (`src/trpc/api/trpc.ts:39-49`).
- TRAP: the RSC server caller (`src/trpc/server.ts:13-20`) builds headers with only the cookie, so `ctx.requestIp` is `127.0.0.1` and `ctx.userAgent` is `""` for calls made from Server Components. Anything that must record the real IP/UA must be a client-side mutation (HTTP) or must read `headers()` from `next/headers` in the page.
- Routers live in `src/trpc/routers/<name>/{router.ts,schema.ts,procedures/*.ts}` and are registered by hand in `src/trpc/api/root.ts:32-57`.
- RBAC subjects are a closed list: `src/lib/rbac/subjects.ts:1-11`. `ADMIN_PERMISSION` is derived from it (`src/lib/rbac/constants.ts:6-9`), so adding a subject grants it to ADMIN automatically. `RBAC.enforce` rejects when the role has no entry for a policy subject (`src/lib/rbac/index.ts:52-60`), so existing custom roles get no access to a new subject until edited. Actions: `create | read | update | delete | *` (`src/lib/rbac/actions.ts:1`).
- TRAP: the Updates router uses `withAuth` + `checkMembership`, not `withAccessControl` (`src/trpc/routers/update/procedures/save-update.ts:9`, `:27`). Do NOT copy that. New governance procedures use `withAccessControl` like `src/trpc/routers/document-router/procedures/create-document.ts:64-74`.
- `checkMembership({ session, tx })` returns the ACTIVE membership for the session company (`src/server/auth.ts:333-345`).
- Server Component permission check: `serverAccessControl()` → `allow(value, [subject, action])` (`src/lib/rbac/access-control.ts:168-208`); page pattern in `src/app/(authenticated)/(dashboard)/[publicId]/documents/page.tsx:17-27`.
- The dashboard layout redirects to the session company (`src/app/(authenticated)/(dashboard)/[publicId]/layout.tsx:26-28`), so the URL `publicId` is cosmetic; the company always comes from the session.

### A2. Tenant isolation

- `assertCompanyOwns(db, companyId, { stakeholderIds, documentIds, bucketIds, memberIds, ... })` throws FORBIDDEN when a client-supplied id is foreign (`src/server/tenant-ownership.ts:194-211`). Entity kinds are a closed union (`:32-39`); new governance tables are NOT in it, so governance rows are always loaded with `where: { <id or publicId>, companyId }` directly.
- Bucket ownership is by key namespace: key must start with `${company.publicId}/` or `${company.id}/` (`src/lib/upload-authorization.ts:118-133`). `assertKeyReadableByCompany(key, company)` before every presign (`src/server/tenant-ownership.ts:216-223`).
- The file is deliberately free of `server-only` and `@/` runtime imports so it can be unit-tested (`src/server/tenant-ownership.ts:14-15`). There is no `vitest.config.*` and no `vite.config.*`; no existing test imports through `@/`. RULE for this plan: every module that has a test uses relative imports only and never imports `server-only`, `@/env`, `@/server/db` or `@/server/auth` (directly or transitively). DB-facing logic is tested through injected loader objects, as `src/server/tenant-ownership.test.ts` does.

### A3. Tokens (JWT)

- `encode(payload)` signs HS256 with `NEXTAUTH_SECRET`; `decode(token)` is `jwtVerify` (`src/lib/jwt.ts:9-17`). `encode` sets no expiry and no purpose claim, and every token kind (update, data room, e-sign) shares the one secret. `jwtVerify` does enforce `exp` when the payload contains it, so new tokens get expiry by putting `exp` (seconds) in the payload; `src/lib/jwt.ts` is not modified.
- Update token: payload `{ companyId, updateId, publicId, recipientId }`, never expires (`src/trpc/routers/update/procedures/share-update.ts:91-98`). The public page trusts `payload.companyId` and then checks the recipient row (`src/app/updates/[publicId]/page.tsx:36-102`).
- Data-room token: `{ companyId, dataRoomId, recipientId }` checked against the recipient row and the data room (`src/app/(documents)/data-rooms/[publicId]/page.tsx:28-76`).
- E-sign token: `{ id: templateId, rec: recipientId }` (`src/trpc/routers/template-field-router/procedures/add-fields.ts:13-40`); the sign mutation requires the token and compares it to the input ids (`src/trpc/routers/template-router/procedures/sign-template.ts:15-23`).
- Consequence: a new token kind MUST carry a purpose claim that no existing kind has and MUST be validated with a strict Zod schema, so an update/data-room/e-sign token can never be accepted as a ballot token and vice versa (existing decoders require `id`+`rec`, `publicId`+`recipientId`, or `dataRoomId`, which the new payloads do not contain).
- TRAP: `src/proxy.ts:19` logs every request URL in production, including tokens in paths and query strings. Treat server logs as sensitive; ballot tokens are additionally bound to a DB row and can be revoked.
- There is no rate limiting anywhere in the app.

### A4. E-sign pipeline (why resolutions do not reuse it)

- Recipient is a `Member` (team user) or free email (`prisma/schema.prisma:646-666`); fields are positioned on an uploaded PDF (`TemplateField`, `:572-600`).
- A multi-recipient template completes only when EVERY recipient is `SIGNED` (`src/trpc/routers/template-router/procedures/sign-template.ts:119-145`); there is no weight, no choice (For/Against), no threshold, no deadline.
- The signature widget is mouse-only (`onMouseDown/Move/Up`, `src/components/ui/signature-pad.tsx:108-160`): it does not work on touch screens.
- Signed PDF = original PDF with field values drawn by `pdf-lib` plus an audit page rendered with `@react-pdf/renderer` (`src/server/esign.ts:118-204`, `src/pdf-templates/audit-log-template.tsx`). Job chain: `esign.generate-pdf` → `esign.complete-pdf` (`src/jobs/esign-pdf.ts`, `src/jobs/esign-complete-pdf.ts`), which creates a `Bucket` + `Document` (`src/server/esign.ts:242-276`).
- TRAPS in that code to avoid copying: `uploadEsignDocuments` records `size: 0` (`src/server/esign.ts:218-223`); `createBucketHandler` without a `user` writes an `Audit` row with `companyId: ""` (`src/trpc/routers/bucket-router/procedures/create-bucket.ts:31-44`); `audit-log-template.tsx:15-18` downloads a font from Google at render time.
- DECISION (see D, G8): resolutions use a dedicated ballot page and do not touch any e-sign file.

### A5. Updates and BlockNote

- `Update` stores `content Json` (BlockNote blocks) and `html String` (`prisma/schema.prisma:932-955`). HTML is produced in the browser by `editor.blocksToHTMLLossy` (`src/components/update/editor.tsx:384-388`) and sanitized on save and on render (`src/lib/sanitize-update-html.ts:134-140`, `src/components/update/renderer.tsx:12`).
- `src/components/update/editor.tsx` is hard-wired to `api.update.*`, the Update title bar and the share modal; it is not reusable as a component. The minimal reusable recipe is `useCreateBlockNote({ initialContent })` + `<BlockNoteView editor={editor} theme="light" onChange={...} />` with the three CSS imports (`src/components/update/editor.tsx:18-22`, `:177-179`, `:380-389`), loaded through `next/dynamic` with `ssr: false` from a Client Component (`src/components/update/editor-lazy.tsx`).
- The public update page refuses to render unless `status === PUBLIC && public` even with a valid recipient token (`src/app/updates/[publicId]/page.tsx:77-91`); `Update` has no period, no checklist data, no attachments and no per-recipient delivery state.
- Default BlockNote block types in the installed version (`@blocknote/core` 0.57): `paragraph, heading, quote, bulletListItem, numberedListItem, checkListItem, toggleListItem, codeBlock, table, divider, image, video, audio, file` (`node_modules/@blocknote/core/types/src/blocks/defaultBlocks.d.ts`). Inline content: `{ type: "text", text, styles }` and `{ type: "link", href, content: [...] }`; styles `bold, italic, underline, strike, code, textColor, backgroundColor`.
- `@react-pdf/renderer` renders React-PDF primitives, not HTML. BlockNote's PDF exporter is an `xl-` package (AGPL/commercial dual licence) and is not installed. DECISION: resolutions and reports store BlockNote block JSON only (no HTML); one pure normalizer turns the blocks into a small validated document model that is rendered twice (React DOM for pages, React-PDF for the filed PDF). The existing HTML sanitizer is therefore not on this path (nothing is ever injected as HTML), and the page, the PDF and the signed hash are guaranteed to show the same text.

### A6. Documents, buckets, uploads

- `Document` = `{ publicId, name, bucketId, uploaderId?, companyId, ... }` (`prisma/schema.prisma:420-460`); `Bucket` = `{ name, key, mimeType, size, tags[] }` with no company column (`:405-418`).
- Server-side upload: `uploadFile(file, { identifier, keyPrefix })` from `src/server/file-uploads.ts:117-162` (private bucket). `TypeKeyPrefixes` is a closed union (`:34-44`). `getFileFromS3(key)` returns bytes (`:166-184`). `getPresignedGetUrl(key)` gives a 10-minute inline URL (`:97-110`).
- Browser upload: `uploadFile` from `src/common/uploads.ts` → server action `getPresignedPutUrl` which only allows prefixes in `CLIENT_PRIVATE_KEY_PREFIXES` (`src/lib/upload-authorization.ts:10-17`; `generic-documents` is allowed) under the company `publicId`. Then `api.bucket.create` records the bucket (`src/trpc/routers/bucket-router/procedures/create-bucket.ts:49-68`).
- Signed-in download: server action `getPresignedGetUrl(key)` requires `documents: read`, key namespace and a `Bucket` linked to a `Document`/`Template` of the company (`src/server/file-upload-actions.ts:115-156`). Token holders (members without login) cannot use it; token downloads need their own procedure (G8, G12).
- `createDocumentHandler({ db, input: { bucketId, name }, companyId, uploaderName, uploaderId?, requestIp, userAgent })` creates the `Document` and audits it (`src/trpc/routers/document-router/procedures/create-document.ts:23-62`).
- Tags: `enum TAG` in `src/lib/tags.ts:3-9`.

### A7. Jobs (pg-boss 12.38.2)

- `src/lib/queue.ts`: `defineWorkerConfig({ name, schema })`, `defineJob(config)` → `.emit(data, sendOptions)` / `.bulkEmit([{ data, singletonKey }])`, `defineWorker(config, handler)`; `queueManager.register(worker)`; `queueManager.start()` creates each queue then calls `work` (`src/lib/queue.ts:66-84`). Queue names are typed from `JOB_TYPES` (`src/constants/job.ts:1-12`) as `"<group>.<name>"`.
- Workers are registered in `src/jobs/register.ts:12-25`, called once per Node process from `src/instrumentation.ts:5-8`.
- Scheduling exists in pg-boss 12: `boss.schedule(name, cron, data?, { tz?, key?, missed?: "skip" | "once" })` (`node_modules/pg-boss/dist/index.d.ts:113`, `types.d.ts:972-984`). The constructor option `schedule` defaults to `true` (`node_modules/pg-boss/dist/attorney.js:412`). The queue MUST exist first (foreign key; error "Queue <name> not found", `node_modules/pg-boss/dist/timekeeper.js:897-900`). Calling `schedule` again for the same `(name, key)` updates it (idempotent). Schedules are evaluated every 30 s with minute precision; `missed: "once"` sends one catch-up job after downtime.
- `queue.ts` has no hook for schedules today; G4 adds one.
- TRAPS: a job that throws is retried up to 4 times with backoff (`src/lib/queue.ts:27-36`), so an email job that fails after sending re-sends: every email job must be one job per recipient with a DB marker checked before sending. Jobs have no request, so there is no IP or user agent for audit context. `fly.toml` has `auto_stop_machines = true` / `min_machines_running = 0`; if production runs with machines that stop, cron jobs fire only while a process is up (hence `missed: "once"` and evaluate-on-read in G8).

### A8. Audit log

- `Audit.create(data, tx)` (`src/server/audit/index.ts:26-34`), validated by `AuditSchema` whose `action`, `actor.type` and `target[].type` are closed enums (`src/server/audit/schema.ts:5-81`, `:84`, `:90-107`). There is no stakeholder or system actor. `context` requires `requestIp` and `userAgent` strings (`:112-115`). `src/server/audit/actions.ts` and `types.ts` are a stale partial list and are not used for validation.
- The audits page reads `getActions()` from the schema (`src/server/audit/schema.ts:122-128`), so new actions appear in its filter automatically.

### A9. Mail

- `sendMail(options)` from `src/server/mailer.ts:17-32` (nodemailer, `X-From-Name` header sets the display name). Emails are React Email components in `src/emails/*.tsx` rendered with `render()` from `react-email` inside a job (`src/jobs/share-update-email.ts:24-52`). FOUNDATION replaces direct use with a logged wrapper; governance uses only the wrapper (interface in E).

### A10. Schema facts

- `relationMode = "prisma"` (`prisma/schema.prisma:7-10`): there are no database foreign keys; Prisma emulates them and warns unless every relation scalar has an `@@index`. Every relation needs the back-relation field on the other model.
- Enums are re-exported as const objects from `@/prisma/enums` by `prisma/enum-generator.cjs` on `prisma generate`.
- `Stakeholder.email` is `@unique` globally, across companies (`prisma/schema.prisma:280`). A transferee may therefore already exist as a Stakeholder (possibly of another company — then creation fails; G16 handles it).
- `Document.uploaderId` is nullable (`:427`), so system-generated documents need no uploader.
- Dashboard pages: `src/app/(authenticated)/(dashboard)/[publicId]/**`. `/reports` is a stub (`.../reports/page.tsx`). Sidebar entries are a static array (`src/components/dashboard/sidebar/index.tsx:45-163`); FOUNDATION owns it.
- Public share layout component: `SharePageLayout` (`src/components/share/page-layout.tsx`).
- Lint: Biome 2 (`biome.json`): `suspicious/useAwait` is an error (no `async` without `await`), `style/useImportType` is an error, unused variables warn. Pre-commit runs lint-staged (`.husky/pre-commit`).

---

## B. Agreement rules as implemented

Each rule: section — rule — default for ambiguity — enforced by.

### B1. Voting

- **R1** (6.9; 1.24; 4.9(iv)) Only Preferred Units vote on matters reserved to the Members: one vote per Preferred Unit; fractional Preferred Units carry a proportional fractional vote. Common Units never vote (their holder only gives the separate approval in R18(d)). — Enforced by `voting.ts` (`preferredUnits` only).
- **R2** (1.23; 4.9(iii); 1.11; 7.9.2) Not outstanding for any vote or consent: (i) Preferred Units held by a Person who is not a Member (holder of a Financial Interest only), (ii) Preferred Units of a Defaulting Member while its default continues. They are excluded from numerator AND denominator. — `isEligible` in `voting.ts`; snapshot fields `isMember`, `isSuspended`.
- **R3** (1.18; 1.14; 6.9 last sentence) "Disinterested Preferred Units" = outstanding Preferred Units held by Persons other than the Manager, Isaac Reid, Karl Schoen, their Affiliates, and their spouses, descendants and trusts/entities for the benefit of or controlled by any of them. Insider units vote on every matter EXCEPT a requirement measured on Disinterested units, where they are in neither numerator nor denominator. — Default: insider status is the manual `Stakeholder.isInsider` flag as it stands when the resolution is sent. — `voting.ts`; snapshot `isInsider`.
- **R4** (1.23) Preferred Majority = holders of MORE THAN 50% of outstanding Preferred Units. Test: `for × 2 > denominator`. Exactly 50% fails.
- **R5** (1.23) Preferred Supermajority = holders of AT LEAST 70%. Test: `for × 10 ≥ denominator × 7`. Exactly 70% passes.
- **R6** (6.16(i); 6.20; 10.3(b)(ii); 10.5) "A majority of the Disinterested Preferred Units" = MORE THAN 50% of outstanding Disinterested units (1.23 second sentence). Test as R4 on the disinterested denominator.
- **R7** (6.20) Removal of the Manager: AT LEAST 67% of the Disinterested units. Test: `for × 100 ≥ denominator × 67`. Note 67%, not two-thirds: 66.67% fails.
- **R8** (12.1(c)) Protected amendments: AT LEAST 70% of the Disinterested units, in addition to R18. Test as R5 on the disinterested denominator.
- **R9** (6.12) Written consent needs signatures of Members holding at least the minimum votes that would be needed at a meeting at which ALL units entitled to vote were present and voted. So the denominator is always all outstanding eligible units; Against, Abstain and no response all count the same (not For). A zero denominator can never pass. — `voting.ts`.
- **R10** (6.9) Default vote for any matter reserved to the Members is a Preferred SUPERMAJORITY. Preferred Majority is required and sufficient only for (1) a term extension under 2.5, (2) a review or audit under 8.3, (3) matters the Agreement expressly assigns to a Preferred Majority (none other exist in the text). — The General preset defaults to `PREFERRED_SUPERMAJORITY`; the UI never offers a lower basis for a catalogued matter (R11).
- **R11** Matter catalogue (requirement sets; "Mgr" = Manager approval recorded on the resolution, "Common" = Common Member approval):

| key | Matter | Section | Requirements |
|---|---|---|---|
| `EARLY_ASSET_SALE` | Sale of all or substantially all server assets closing before the Target Sale Date | 2.4, 6.16(d) | Supermajority |
| `ADDITIONAL_COMMON_UNITS` | Issue additional Common Units | 3.2 | Supermajority |
| `MEMBER_LOAN` | Advance (loan) by a Member | 4.6, 6.16(d) | Supermajority; plus Disinterested majority if the lender is the Manager, Reid, Schoen or an Affiliate (6.16(i)) |
| `OBLIGATE_MEMBERS` | Commit Members to fund capital, guarantee or increase personal liability | 6.16(a) | Supermajority (and binds only Members who consent in writing) |
| `CHANGE_BUSINESS` | Materially change the business | 6.16(b) | Supermajority |
| `ACT_CONTRARY` | Action contrary to the Agreement | 6.16(c) | Supermajority |
| `BORROW_OR_PLEDGE` | Indebtedness for borrowed money or pledge/security interest (other than trade payables and 6.16(i)(2) reimbursements) | 6.16(d) | Supermajority |
| `ADDITIONAL_SERVERS` | Acquire servers beyond those bought with accepted Capital Contributions | 6.16(d) | Supermajority |
| `EARLY_DISSOLUTION` | Dissolve before the sale of substantially all assets | 6.16(d), 11.1(b) | Mgr + Supermajority |
| `COMMINGLE` | Co-mingle LLC funds (outside the 6.16(e) exception) | 6.16(e) | Supermajority |
| `CONFESS_JUDGMENT` | Confess a judgment against the LLC | 6.16(f) | Supermajority |
| `ADMIT_MEMBER_OTHER` | Admit a Member other than under 3.2, 4.9, 7 | 6.16(g) | Supermajority |
| `RELATED_PARTY` | Transaction with Octagon Compute LLC, the Manager, Schoen, Reid or an Affiliate (not pre-approved) | 6.16(i) | Disinterested majority, obtained FIRST |
| `ORG_EXPENSE_CAP` | Organizational/offering expense reimbursement above $40,000 aggregate | 6.21 | Supermajority |
| `COMMON_TRANSFER_OR_CONTROL` | Transfer of Common Units or change of control of the Manager (except to Reid, Schoen or an Affiliate controlled by them) | 7.1 last sentences | Supermajority |
| `TAX_PROCEEDING_ACTION` | Settle, extend limitations or file a petition in a tax proceeding; direct not to make the push-out election | 9.2 | Supermajority |
| `INDEMNITY_SETTLEMENT` | Indemnify amounts paid in settling an action by or in the right of the LLC where the Manager or its Affiliate is the Agent | 10.3(b)(ii) | Mgr + Disinterested majority |
| `INDEMNITY_DETERMINATION` | Determine that the Manager/Affiliate met the standard of conduct in a Proceeding brought by Members (alternative: independent counsel) | 10.5 | Disinterested majority |
| `POST_TARGET_DISSOLUTION` | Elect dissolution more than 180 days after the Target Sale Date if assets unsold | 11.1(d) | Supermajority (no Manager approval) |
| `IN_KIND_DISTRIBUTION` | In-kind distribution of servers or other non-cash assets | 11.4 | Supermajority |
| `TERM_EXTENSION` | One-year extension of the operating term | 2.5 | Preferred Majority (R14) |
| `AUDIT_CALL` | Review or audit at the LLC's expense | 8.3 | Preferred Majority (R19) |
| `MANAGER_REMOVAL` | Remove the Manager | 6.20 | Disinterested ≥ 67% |
| `SUCCESSOR_MANAGER` | Appoint a successor Manager (after removal or resignation) | 6.20 | Disinterested majority |
| `AMENDMENT` | Amend the Agreement | 12.1 | R18 |
| `OTHER` | Any other matter reserved to the Members | 6.9 | Supermajority (R10); the Manager user may ADD requirements but not lower them |

- **R12** (6.12; 13.9; 8.1(e)) A written consent is effective when signed (electronic signature or email confirmation is sufficient) by Members holding the required votes; no meeting and no prior notice needed; consents are filed with the books and records. — Default: the resolution becomes EFFECTIVE at the instant the last requirement is satisfied; voting then closes; all Members are notified of the result; the executed PDF is filed under books category `CONSENTS_AND_MINUTES`. Enforced by G8/G9.
- **R13** (silent) Record date. — Default (shared contract): chosen by the Manager user per resolution, default today, not in the future; on send the app freezes a `RecordSnapshot` of every holder's units as of the record date (ECONOMICS), plus `memberStatus` and `isInsider` as they stand at send time. Suspension has ONE date: it is judged as of the record date (a declared, uncured default with `dueOn` before the record date suspends; owner ruling M5). A Balance that is overdue as of the record date but whose default has NOT been declared must not vote: `send` refuses a resolution with ballots while ECONOMICS reports any `undeclaredOverdue` line for the record date, with "{name} has an overdue Balance with no declared default. Declare the default (Section 4.9) or record the payment before sending." (`preview` returns it in `blockers`; the send dialog shows it and disables Send). Denominators never change afterwards.
- **R13a** (silent) Finality. — Default: a submitted ballot cannot be changed or withdrawn. To re-run a vote the Manager user withdraws (or lets it fail) and clones the resolution. This is what makes "cannot pass" (early FAILED) well-defined.

### B2. Specific resolution types

- **R14** (2.5) Term extension: the Manager asks the Preferred Members by written consent whether to extend the operating term one additional year, not later than 9 months before the Target Sale Date (and before the end of each extension period). Approval: Preferred Majority. No consent of the Common Members or the Manager. A Preferred Member who does not respond within 30 days after the request is deemed to have voted Against. Unlimited number of extensions. If approved the Target Sale Date moves to the end of the extension period. If the Manager fails to ask when due, holders of 25% of outstanding Preferred Units may initiate the consent. — Defaults: response window is fixed at 30 days (not editable): closes 23:59:59.999 `GOVERNANCE_TIME_ZONE` on (send date + 30 days); effective earlier if the majority is reached (R12); at close every eligible non-responder gets a ballot record `AGAINST, deemed = true`; member-initiated consents are not supported in-app (section G).
- **R15** (6.16(i)) Related-party transaction: must be "first approved" by a majority of the Disinterested units. Pre-approved, no resolution needed: (1) management arrangement and Management Fee (6.18); (2) purchasing-agent acquisition of servers at vendor cost without markup, subject to (A)–(D); (3) Capital Contributions by and Preferred Units issued to insiders on the same terms; (4) reimbursement of documented expenses (3.6, 6.21); (5) activities permitted by 6.19; (6) Manager/designee exercising Section 7 ROFR/purchase option or a 7.3 purchase at an agreed price. — The Related-party preset shows this list as a "you do not need a resolution if…" note; recipients are disinterested Members only; insiders are told the result.
- **R16** (6.16(i)(B)) For any purchase order, or series of related purchase orders, exceeding $25,000, placed by the Manager or its Affiliate as purchasing agent: BEFORE any LLC funds are paid, the Manager signs a written resolution (a) identifying the vendor, the equipment and the price and (b) confirming that the Manager or its Affiliate acts solely as agent and nominee for the LLC, has no beneficial interest in the purchase order, any deposit, or the equipment, holds each of them in trust for the LLC, and assigns to the LLC its rights under the purchase order to the extent assignable; and delivers a copy to the Members within 10 business days. — Owner scope: no purchase-order module, no payment blocking. Implemented as resolution type `PURCHASE_ORDER`: only requirement `MANAGER_APPROVAL`; locked clauses carry (a) and (b); on signing, status EFFECTIVE; a copy (PDF attachment) is emailed to every Member through the logged mailer; a `ComplianceDeadline` "Deliver PO resolution copy" is created for signing date + 10 BD and completed when the emails are logged. The form warns (text only) that the resolution must be signed before LLC funds are paid and is required above $25,000 for an order or series of related orders.
> **Owner decision 2026-11-13:** Manager removal is not part of this app. The `MANAGER_REMOVAL` resolution type and the "removal" reason on `SUCCESSOR_MANAGER` were taken out (migration `20261114010000_drop_manager_removal`); mentions of them below are historical.

- **R17** (6.20) Removal: ≥ 67% of Disinterested units, no cause needed. On removal a majority of Disinterested units appoints a successor. On resignation (90 days' written notice) a successor is appointed the same way; dissolution if no successor accepts within 180 days of the notice (11.1(e)). — Two types: `MANAGER_REMOVAL` (Disinterested 67) and `SUCCESSOR_MANAGER` (Disinterested majority). Recipients: disinterested Members only. Both are drafted in-app by a Manager user at the Members' written request (members have no login; section G).
- **R18** (12.1; 6.9; 13.1) Amendment requires approval of the Manager AND a Preferred Supermajority, except: (a) the Manager alone may amend Exhibit A for admissions, issuances/transfers, installment payments and 4.9(iv) adjustments, correct manifest clerical errors, and make changes required by law or tax regulations that do not materially and adversely affect the Preferred Members — no resolution; (b) an amendment that disproportionately and adversely affects a Member relative to others of its class also needs THAT Member's consent; (c) an amendment to Sections 2.4, 2.5, 4.8, 4.9, 5.6, 6.16(d), 6.16(i), 6.18, 6.20, 6.21, 11.4, the last sentence of 6.9, the Common-Unit transfer/change-of-control restriction in 7.1, 12.1 itself, or the definitions of Available Cash, Common Units, Disinterested Preferred Units, Preferred Majority, Preferred Supermajority, Preferred Units also needs ≥ 70% of the Disinterested units; (d) an amendment that adversely affects the rights of the Common Units also needs the Common Member's approval. An adopted amendment binds every Member (13.1). — `AMENDMENT` preset: base requirements `MANAGER_APPROVAL` + `UNIT_VOTE(PREFERRED_SUPERMAJORITY)`; three form switches add `UNIT_VOTE(DISINTERESTED_70)` (c), `COMMON_MEMBER_APPROVAL` (d), and one `AFFECTED_MEMBER_CONSENT(stakeholderId)` per selected Member (b). The form lists the (c) sections verbatim next to the switch. The executed amendment PDF is filed under `ARTICLES_AND_AGREEMENT` as well.
- **R19** (8.3) A Preferred Majority may require a review or audit of the books at the LLC's expense not more than once in any fiscal year. — `AUDIT_CALL`: Preferred Majority; sending is blocked when another `AUDIT_CALL` of the company became EFFECTIVE in the same fiscal year (calendar year, 8.5) as the send date. (A single Member's audit at its own expense needs no vote and is not modelled.)
- **R20** (4.6) See `MEMBER_LOAN` in R11; the note itself (rate, maturity) is an uploaded document.

### B3. Notices, recipients, reports

- **R21** (13.6; 6.6; 4.9) Notices are in writing and are duly given by email to the Member's address on Exhibit A (or another address the Member designates). Email notice is effective when sent UNLESS the sender receives notice that it was not delivered. — Every notice goes to `Stakeholder.noticeEmail ?? Stakeholder.email` through FOUNDATION's logged mailer; the `EmailLog` row is the proof of sending; each recipient list in the UI shows the log state and offers "Resend"; if FOUNDATION marks a log UNDELIVERED the item shows "Not delivered — notice not effective".
- **R22** (1.11; 1.8; 7.9.2; 3.5) A holder of only a Financial Interest is not a Member: no vote, no consent, no meetings, no information. — Ballots, reports (8.2), notices and resolution copies go only to Stakeholders with `memberStatus = MEMBER`. A Defaulting (suspended) Member remains a Member: no ballot (R2) but still receives reports, notices and results. `PROSPECT` receives nothing.
- **R22a** (1.8; 9.2; 8.2) Financial-Interest-only holders still receive allocations, so they need a Schedule K-1. — Default: K-1s are delivered by a report of type `TAX_K1` whose recipients are exactly the holders with a K-1 attachment (Members and Financial-Interest-only holders); that page shows the cover note and the holder's own K-1 only.
- **R23** (8.2; 5.6(a)) With each quarterly distribution, or if none is made within 45 days after quarter end, the Manager delivers to the Members a short report of revenue, utilization, expenses, the Management Fee, reserves (reserve balance, 5.6(a)) and distributions for the quarter. — `MemberReport` type `QUARTERLY`; due date = quarter end + 45 calendar days; send is blocked until all six items are filled or explicitly marked "none".
- **R24** (8.2; 6.3; 8.5; 8.6) Within 90 days after fiscal year end (December 31): balance sheet and income statement for the year (or portion), income-tax basis, to each Member; this replaces an annual meeting. — `ANNUAL`; due = Dec 31 + 90 days (March 31, or March 30 when the following year is a leap year); send blocked until one attachment of kind `BALANCE_SHEET` and one of kind `INCOME_STATEMENT` exist.
- **R25** (8.2) Schedule K-1 to each Member by March 31 (commercially reasonable efforts) and in any event by the LLC's extended federal filing deadline. — Two deadlines per fiscal year: `K1_TARGET` March 31 and `K1_FINAL` September 15 of the following year (Form 1065 extended due date for a calendar-year partnership; assumption, editable on the deadline).
- **R26** (8.2 last sentence) Each quarterly report and annual statement also lists all amounts paid by the LLC to or through the Manager and its Affiliates during the period. — Report section "Payments to or through the Manager and Affiliates" prefilled from ECONOMICS `managerPayments`; an empty list must be confirmed ("None in this period") before sending.
- **R27** (8.3) Members must keep non-public LLC information confidential. — Every report/notice page and PDF carries the footer: "Confidential. Provided to Members of {company} under Section 8.3 of the Operating Agreement."
- **R28** (8.1) Records kept: (a) current list of each Member's name, address, Capital Contribution and Units; (b) Articles of Organization and the Agreement with amendments; (c) tax returns for the past six fiscal years; (d) financial statements for the past six fiscal years; (e) minutes, actions by written consent, consents, waivers of notice, Member votes; (f) anything else the Wyoming statute requires. — Six fixed document categories (C, G18).
- **R29** (1.21) The Manager notifies the Members in writing of the Operations Commencement Date within 10 business days after it occurs. — Compliance deadline + `NOTICE` report.
- **R30** (9.2) The partnership representative notifies the Members of any audit or tax proceeding within 10 days after receiving notice of it. — Manual deadline template (10 calendar days) + `NOTICE` report; no tax-proceeding log (section G).

### B4. Transfers

- **R31** (7.1) Voluntary transfer to a non-Permitted Transferee: (1) prior written consent of the Manager (not unreasonably withheld for an accredited investor who signs Exhibit B and satisfies 7.8); (2) the Member gives the LLC a Transfer Notice stating number of Units, proposed transferee (if any), price and payment terms, other material terms; (3) the Manager delivers a copy of the Transfer Notice to the other Preferred Members within 5 business days after receiving it; (4) right of first refusal: the Manager (or designee) for 45 days after receiving the Transfer Notice, then the other Preferred Members pro rata for a further 45 days; (5) if not exercised in full within the 90 days, the Member may transfer to the named transferee (or, if none, any accredited investor) on terms no more favourable than the notice within 180 days thereafter, subject to Manager consent and 7.8. — Dates: `managerRofrEndsOn = noticeReceivedOn + 45d`, `memberRofrEndsOn = noticeReceivedOn + 90d`, `closeByOn = noticeReceivedOn + 270d`, `noticeCopyDueOn = noticeReceivedOn + 5 BD`. Pricing, appraisal and installment terms are recorded as free text and documents only.
- **R32** (7.1) Permitted Transferee (spouse, descendants, trust/entity for or controlled by them; for an entity Member, its owners): notice to the Manager only — no consent, no ROFR; becomes a Substitute Member only on satisfying 7.8(a)–(c).
- **R33** (7.2) Involuntary transfer (operation of law): transferee holds a Financial Interest only unless admitted; the Manager forwards the notice of the Involuntary Transfer to the other Preferred Members within 5 business days; purchase OPTION for the Manager (45 days after it receives notice) then the other Preferred Members pro rata (further 45 days), at fair value.
- **R34** (7.3) Death or adjudicated incapacity: the estate/representative/heirs succeed to the Financial Interest and may be admitted under 7.8 on signing Exhibit B; no ROFR; optional negotiated purchase by the Manager. The accredited-investor requirement does not apply (7.8(c)).
- **R35** (7.9.1) A permitted transfer takes effect on the first day of the month following receipt by the Manager of written notice of transfer. — `effectiveOn = first day of the month after transferNoticeOn` (a notice received on the 1st takes effect on the 1st of the NEXT month).
- **R36** (7.8; 6.16(g); 12.1(a)) Admission as Substitute Member requires (a) executed Exhibit B signature page and adoption instrument, (b) payment of reasonable admission expenses, (c) legal/regulatory qualification incl. accredited investor (not for death, incapacity or operation of law), (d) Manager consent (not unreasonably withheld when (a)–(c) are met; not needed for a Permitted Transferee per 7.1). It is a Manager action, not a Member vote (6.16(g) carves out Section 7); Exhibit A is updated by the Manager alone (12.1(a)). — Admission checklist on the transfer; "Admit" sets `memberStatus = MEMBER`, `admittedOn`.
- **R37** (7.9.2; 1.23) Until admitted the transferee holds only a Financial Interest: distributions and allocations only; its units are not outstanding for votes (R2); the transferor stays liable for any unpaid Balance. — Transferee Stakeholder is created/kept with `memberStatus = FINANCIAL_INTEREST_ONLY`.
- **R38** (7.1 last sentences) The Common Member may not transfer Common Units, and no change of control of the Manager may occur, without Supermajority approval, except to Reid, Schoen or an Affiliate that remains controlled by them. — A transfer whose unit class is COMMON cannot be completed unless linked to an EFFECTIVE resolution with matter `COMMON_TRANSFER_OR_CONTROL`, or the Manager user ticks "Exempt under 7.1 (to Reid, Schoen or a controlled Affiliate)" with a note.
- **R39** (7.6) No transfer without securities registration unless counsel's opinion is delivered or the Manager waives it. — Checklist field `securitiesOpinion: RECEIVED | WAIVED`; required to complete any transfer kind except `DEATH_INCAPACITY` and `INVOLUNTARY`.
- **R40** (7.7) Closing of a Section 7 purchase within 45 days after the price is finally established; the LLC itself never purchases or redeems Units. — Optional `priceEstablishedOn` → `purchaseCloseByOn = +45d`; the transferee can never be the company.

### B5. Calendar and misc

- **R41** Business days: Monday–Friday excluding US federal holidays (shared default; ECONOMICS implements).
- **R42** (8.5; 9.1) Fiscal and tax year end December 31; quarters end Mar 31, Jun 30, Sep 30, Dec 31.
- **R43** (6.2–6.11, 6.13, 6.14) Meetings, quorum, proxies, voting trusts: not implemented (section G). All Member action in-app is by written consent under 6.12.

---

## C. Data model

### C1. Design rules

- New models relate by Prisma relation ONLY to `Company` (cascade) and to their own parent model. `Stakeholder`, `Member` (team user), `Document`, `Bucket`, FOUNDATION and ECONOMICS rows are referenced by plain `String` ids with an `@@index`, and names/emails/units needed for the permanent record are copied onto the governance row. Reasons: (1) with `relationMode = "prisma"` there are no database foreign keys anyway; (2) only five back-relation lines are added to a shared model (`Company`), so the three planners' schema edits do not collide; (3) deleting a Stakeholder can never cascade into ballots or snapshots.
- Every query on these plain ids is tenant-scoped by `companyId` on the governance row, and every client-supplied `stakeholderId` / `bucketId` / `documentId` goes through `assertCompanyOwns` before it is stored.
- Calendar dates are `DateTime @db.Date`. Write them as `new Date(Date.UTC(y, m - 1, d))`; read them as `value.toISOString().slice(0, 10)`. Helpers `ymdToUtcDate(ymd: string): Date` and `utcDateToYmd(d: Date): string` live in `src/lib/governance/dates.ts` (G3); they are the same conversions as ECONOMICS `isoToUtcDate` / `utcDateToIso` (`src/lib/llc/dates.ts`).
- Money in governance tables: only `UnitTransfer.proposedPriceCents` (`BigInt?`, integer cents, FOUNDATION decision B1). Report figures are JSON and carry cents as integer numbers.

### C2. Prisma blocks (append to `prisma/schema.prisma`; paste verbatim)

```prisma
// ───────────────────────── LLC governance (03-governance) ─────────────────────────

enum ResolutionTypeEnum {
  GENERAL_CONSENT
  RELATED_PARTY
  PURCHASE_ORDER
  TERM_EXTENSION
  MANAGER_REMOVAL
  SUCCESSOR_MANAGER
  AMENDMENT
  AUDIT_CALL
  MEMBER_LOAN
}

enum ResolutionStatusEnum {
  DRAFT
  SENT
  EFFECTIVE
  FAILED
  WITHDRAWN
  EXPIRED
}

enum VoteBasisEnum {
  PREFERRED_MAJORITY
  PREFERRED_SUPERMAJORITY
  DISINTERESTED_MAJORITY
  DISINTERESTED_67
  DISINTERESTED_70
}

enum ResolutionRequirementKindEnum {
  UNIT_VOTE
  MANAGER_APPROVAL
  COMMON_MEMBER_APPROVAL
  AFFECTED_MEMBER_CONSENT
}

enum BallotChoiceEnum {
  FOR
  AGAINST
  ABSTAIN
}

enum RecordSnapshotPurposeEnum {
  RESOLUTION
  MEMBER_REPORT
}

model RecordSnapshot {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  purpose    RecordSnapshotPurposeEnum
  recordDate DateTime                  @db.Date
  takenAt    DateTime                  @default(now())
  takenById  String? // Member.id (team user); null when taken by a job

  // Totals in Preferred Units, frozen. "Outstanding" follows OA 1.23 (R2).
  preferredIssued          Decimal @db.Decimal(18, 6)
  preferredOutstanding     Decimal @db.Decimal(18, 6)
  disinterestedOutstanding Decimal @db.Decimal(18, 6)

  entries    RecordSnapshotEntry[]
  resolution Resolution?

  @@index([companyId])
}

model RecordSnapshotEntry {
  id         String         @id @default(cuid())
  snapshotId String
  snapshot   RecordSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)
  companyId  String

  stakeholderId String
  name          String
  email         String // noticeEmail ?? email at snapshot time
  memberStatus  String // FOUNDATION enum value copied as text
  isMember      Boolean
  isInsider     Boolean
  isSuspended   Boolean

  preferredUnits Decimal @db.Decimal(18, 6)
  commonUnits    Decimal @db.Decimal(18, 6)

  @@unique([snapshotId, stakeholderId])
  @@index([snapshotId])
  @@index([companyId, stakeholderId])
}

model Resolution {
  id        String  @id @default(cuid())
  publicId  String
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  type          ResolutionTypeEnum
  status        ResolutionStatusEnum @default(DRAFT)
  referenceCode String? // "R-2026-001", assigned on send
  title         String
  matterKey     String? // key of MATTERS (src/lib/governance/presets.ts)
  params        Json    @default("{}") // preset parameters, validated per type
  body          Json    @default("[]") // BlockNote blocks; editable only while DRAFT

  // Frozen on send; never updated afterwards.
  frozenContent Json? // { title, doc, lockedClauses, requirements }
  frozenHash    String? // sha256 hex of canonicalJson(frozenContent)
  recordDate    DateTime? @db.Date
  snapshotId    String?   @unique
  snapshot      RecordSnapshot? @relation(fields: [snapshotId], references: [id])

  sentAt          DateTime?
  closesAt        DateTime? // null for resolutions without ballots
  effectiveAt     DateTime?
  closedAt        DateTime? // FAILED / EXPIRED / WITHDRAWN instant
  withdrawnReason String?
  autoReminders   Boolean   @default(true)

  // Delivery of a copy to the Members (PURCHASE_ORDER, R16)
  copyDueOn       DateTime? @db.Date
  copyDeliveredAt DateTime?

  resultNotifiedAt   DateTime?
  executedDocumentId String? // Document.id of the filed executed PDF
  clonedFromId       String?
  authorId           String // Member.id (team user)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  requirements ResolutionRequirement[]
  ballots      ResolutionBallot[]
  events       ResolutionEvent[]

  @@unique([publicId])
  @@unique([companyId, referenceCode])
  @@index([companyId, status])
  @@index([companyId, type])
  @@index([authorId])
  @@index([executedDocumentId])
}

model ResolutionRequirement {
  id           String     @id @default(cuid())
  resolutionId String
  resolution   Resolution @relation(fields: [resolutionId], references: [id], onDelete: Cascade)
  companyId    String
  position     Int

  kind          ResolutionRequirementKindEnum
  basis         VoteBasisEnum? // UNIT_VOTE only
  stakeholderId String? // AFFECTED_MEMBER_CONSENT only
  section       String // OA citation shown in the UI and PDF, e.g. "12.1(c)"

  // UNIT_VOTE, frozen on send
  denominatorUnits Decimal? @db.Decimal(18, 6)
  minimumForUnits  Decimal? @db.Decimal(18, 6)

  // Set once, when first satisfied
  satisfiedAt     DateTime?
  forUnitsAtClose Decimal?  @db.Decimal(18, 6) // UNIT_VOTE: For-weight when satisfied or when the resolution closed

  // MANAGER_APPROVAL / COMMON_MEMBER_APPROVAL signature (write-once)
  approvedByMemberId String? // Member.id (team user) who signed
  approverName       String?
  approverCapacity   String?
  approvedAt         DateTime?
  approvalIp         String?
  approvalUserAgent  String?

  @@unique([resolutionId, position])
  @@index([resolutionId])
  @@index([companyId])
}

model ResolutionBallot {
  id           String     @id @default(cuid())
  resolutionId String
  resolution   Resolution @relation(fields: [resolutionId], references: [id], onDelete: Cascade)
  companyId    String

  // Frozen copy of the snapshot entry this ballot belongs to
  stakeholderId       String
  name                String
  email               String
  preferredUnits      Decimal @db.Decimal(18, 6)
  countsPreferred     Boolean // eligible for PREFERRED_* requirements (R2)
  countsDisinterested Boolean // eligible for DISINTERESTED_* requirements (R2 + R3)

  // Link state (mutable delivery metadata)
  tokenVersion     Int       @default(1)
  tokenExpiresAt   DateTime
  tokenRevokedAt   DateTime?
  invitedAt        DateTime?
  inviteEmailLogId String?
  lastReminderAt   DateTime?
  reminderCount    Int       @default(0)
  firstViewedAt    DateTime?
  viewCount        Int       @default(0)

  // The vote: WRITE-ONCE (all set together, only while submittedAt IS NULL)
  choice          BallotChoiceEnum?
  deemed          Boolean           @default(false) // true = deemed Against under OA 2.5
  signedName      String?
  signerCapacity  String?
  submittedAt     DateTime?
  submitIp        String?
  submitUserAgent String?
  bodyHash        String? // must equal Resolution.frozenHash

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([resolutionId, stakeholderId])
  @@index([resolutionId])
  @@index([companyId, stakeholderId])
}

model ResolutionEvent {
  id           String     @id @default(cuid())
  resolutionId String
  resolution   Resolution @relation(fields: [resolutionId], references: [id], onDelete: Cascade)
  companyId    String
  ballotId     String?

  type      String // one of RESOLUTION_EVENT_TYPES (src/server/governance/events.ts)
  dedupeKey String? // set for events that must happen at most once (email sends)
  actorType String // "user" | "stakeholder" | "system"
  actorId   String?
  summary   String
  ip        String?
  userAgent String?

  occurredAt DateTime @default(now())

  @@unique([resolutionId, dedupeKey])
  @@index([resolutionId])
  @@index([companyId])
  @@index([ballotId])
}

enum MemberReportTypeEnum {
  QUARTERLY
  ANNUAL
  TAX_K1
  NOTICE
}

enum MemberReportStatusEnum {
  DRAFT
  SENT
}

enum MemberReportAttachmentKindEnum {
  GENERAL
  BALANCE_SHEET
  INCOME_STATEMENT
  K1
}

model MemberReport {
  id        String  @id @default(cuid())
  publicId  String
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  type   MemberReportTypeEnum
  status MemberReportStatusEnum @default(DRAFT)
  title  String

  fiscalYear    Int?
  fiscalQuarter Int? // 1-4, QUARTERLY only
  periodStart   DateTime? @db.Date
  periodEnd     DateTime? @db.Date
  noticeKind    String? // NOTICE only: key of NOTICE_KINDS (src/lib/governance/report-figures.ts)
  relatedType   String? // e.g. "UNIT_TRANSFER", "COMPLIANCE_DEADLINE"
  relatedId     String?

  figures    Json @default("{}") // ReportFigures (QUARTERLY / ANNUAL)
  commentary Json @default("[]") // BlockNote blocks; editable only while DRAFT

  frozenContent Json? // { title, type, period, figures, doc } at send
  frozenHash    String?
  dueOn         DateTime? @db.Date
  sentAt        DateTime?
  sentById      String? // Member.id
  authorId      String // Member.id

  filedDocumentId String? // Document.id of the filed PDF

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  recipients  MemberReportRecipient[]
  attachments MemberReportAttachment[]

  @@unique([publicId])
  @@index([companyId, type])
  @@index([companyId, status])
  @@index([authorId])
}

model MemberReportRecipient {
  id        String       @id @default(cuid())
  reportId  String
  report    MemberReport @relation(fields: [reportId], references: [id], onDelete: Cascade)
  companyId String

  stakeholderId String
  name          String
  email         String

  tokenVersion   Int       @default(1)
  tokenExpiresAt DateTime
  tokenRevokedAt DateTime?

  sentAt        DateTime?
  emailLogId    String?
  sendCount     Int       @default(0)
  firstViewedAt DateTime?
  viewCount     Int       @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([reportId, stakeholderId])
  @@index([reportId])
  @@index([companyId, stakeholderId])
}

model MemberReportAttachment {
  id        String       @id @default(cuid())
  reportId  String
  report    MemberReport @relation(fields: [reportId], references: [id], onDelete: Cascade)
  companyId String

  kind          MemberReportAttachmentKindEnum @default(GENERAL)
  name          String
  bucketId      String // Bucket.id; key is checked against the company namespace on every read
  stakeholderId String? // null = visible to every recipient; set = private to that holder (K-1)

  createdAt DateTime @default(now())

  @@index([reportId])
  @@index([bucketId])
  @@index([companyId, stakeholderId])
}

enum ComplianceDeadlineStatusEnum {
  OPEN
  DONE
  NOT_APPLICABLE
}

model ComplianceDeadline {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  ruleKey     String // key of COMPLIANCE_RULES, or "CUSTOM"
  dedupeKey   String // `${ruleKey}:${periodKey}`; unique per company, makes generation idempotent
  title       String
  section     String? // OA citation
  description String?
  dueOn       DateTime @db.Date

  status     ComplianceDeadlineStatusEnum @default(OPEN)
  source     String // "RULE" | "ECONOMICS" | "RESOLUTION" | "TRANSFER" | "MANUAL"
  sourceType String? // "RESOLUTION" | "UNIT_TRANSFER" | null
  sourceId   String?

  completedAt     DateTime?
  completedById   String? // Member.id; null when completed by the system
  satisfiedByType String? // "RESOLUTION" | "MEMBER_REPORT" | "DOCUMENT" | "MANUAL"
  satisfiedById   String?
  note            String?

  remindedBuckets Int[]     @default([])
  lastReminderAt  DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([companyId, dedupeKey])
  @@index([companyId, status, dueOn])
}

enum UnitTransferKindEnum {
  VOLUNTARY
  PERMITTED_TRANSFEREE
  INVOLUNTARY
  DEATH_INCAPACITY
}

enum UnitTransferStatusEnum {
  OPEN
  COMPLETED
  CANCELLED
}

enum UnitTransferRofrOutcomeEnum {
  NOT_APPLICABLE
  PENDING
  NOT_EXERCISED
  EXERCISED_BY_MANAGER
  EXERCISED_BY_MEMBERS
}

enum UnitTransferConsentEnum {
  NOT_REQUIRED
  PENDING
  GRANTED
  DENIED
}

model UnitTransfer {
  id        String  @id @default(cuid())
  publicId  String
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  kind   UnitTransferKindEnum
  status UnitTransferStatusEnum @default(OPEN)

  fromStakeholderId String
  toStakeholderId   String? // may be unknown while the ROFR runs
  unitClassId       String // FOUNDATION UnitClass.id
  unitClassKind     String // "PREFERRED" | "COMMON", copied
  units             Decimal @db.Decimal(18, 6)

  // 7.1 Transfer Notice / 7.2 notice of Involuntary Transfer / notice of death or permitted transfer
  noticeReceivedOn DateTime @db.Date
  proposedPriceCents BigInt? // integer cents
  terms            String?
  bonaFideOffer    Boolean  @default(false)

  // Copy to the other Preferred Members (5 business days)
  noticeCopyDueOn    DateTime? @db.Date
  noticeCopyReportId String? // MemberReport.id (type NOTICE); its sentAt is the delivery time

  // Right of first refusal (7.1) / purchase option (7.2)
  managerRofrEndsOn DateTime?                   @db.Date
  memberRofrEndsOn  DateTime?                   @db.Date
  closeByOn         DateTime?                   @db.Date
  rofrOutcome       UnitTransferRofrOutcomeEnum @default(NOT_APPLICABLE)
  rofrDecidedOn     DateTime?                   @db.Date
  rofrNote          String?

  managerConsent     UnitTransferConsentEnum @default(NOT_REQUIRED)
  managerConsentOn   DateTime?               @db.Date
  managerConsentNote String?
  securitiesOpinion  String? // "RECEIVED" | "WAIVED" (7.6)

  priceEstablishedOn DateTime? @db.Date
  purchaseCloseByOn  DateTime? @db.Date // 7.7

  transferNoticeOn DateTime? @db.Date // 7.9.1 written notice of transfer received by the Manager
  effectiveOn      DateTime? @db.Date // first day of the following month

  // 7.1 last sentences (Common Units)
  requiredResolutionId String?
  exemptUnder71        Boolean @default(false)
  exemptNote           String?

  // 7.8 admission of the transferee as Substitute Member
  admissionSignaturePage  Boolean   @default(false)
  admissionExpensesPaid   Boolean   @default(false)
  admissionQualified      Boolean   @default(false)
  admissionManagerConsent Boolean   @default(false)
  admittedOn              DateTime? @db.Date

  completedAt   DateTime?
  completedById String?
  cancelledAt   DateTime?
  cancelReason  String?
  notes         String?
  authorId      String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([publicId])
  @@index([companyId, status])
  @@index([companyId, fromStakeholderId])
  @@index([companyId, toStakeholderId])
}

enum BooksRecordCategoryEnum {
  MEMBER_LIST
  ARTICLES_AND_AGREEMENT
  TAX_RETURNS
  FINANCIAL_STATEMENTS
  CONSENTS_AND_MINUTES
  OTHER_STATUTORY
}
```

Additions to EXISTING models (additive; nothing renamed or removed):

```prisma
// model Company — add these five lines to the relation list (after `customRoles CustomRole[]`)
  resolutions         Resolution[]
  recordSnapshots     RecordSnapshot[]
  memberReports       MemberReport[]
  complianceDeadlines ComplianceDeadline[]
  unitTransfers       UnitTransfer[]

// model Document — add two nullable columns (after `name String`) and one index (with the other @@index lines)
  recordCategory BooksRecordCategoryEnum? // OA 8.1 books-and-records category
  recordYear     Int? // fiscal year the record relates to
  @@index([companyId, recordCategory])
```

### C3. Immutability rules (enforced in code; there is no procedure that violates them)

1. `RecordSnapshot` and `RecordSnapshotEntry`: insert only. No update, no delete procedure. (They disappear only if the whole company is deleted.)
2. `ResolutionBallot` vote columns (`choice, deemed, signedName, signerCapacity, submittedAt, submitIp, submitUserAgent, bodyHash`): written exactly once, through ONE single-row guarded write `guardedWrite(() => tx.resolutionBallot.update({ where: { id, submittedAt: null, … }, data }))` (`src/server/governance/guarded.ts`), which returns false when the guard no longer holds. Never a guarded `updateMany` / `deleteMany` with "count must be 1": Prisma 7 selects the ids first and then writes by id WITHOUT the guard, so a concurrent writer is silently overwritten (and `deleteMany` on a parent with emulated cascades deletes the children by stale ids first). A single-row `update` / `delete` (or raw `UPDATE … WHERE <guard>`) is one statement whose WHERE Postgres re-checks at write time; `src/server/governance/__integration__/guarded.integration.ts` races two writers to prove it. This rule applies to every write-once column of C3. Identity columns (`stakeholderId, name, preferredUnits, countsPreferred, countsDisinterested`) are never updated. Only link/delivery columns are mutable; `email` may be changed only by `resolution.replaceBallotLink` and only while `submittedAt` is null.
3. `ResolutionBallot` rows are never deleted. Ballots may be ADDED to a SENT resolution (additional recipients) but never removed.
4. `Resolution`: `title, type, matterKey, params, body` are mutable only while `status = DRAFT`; `resolution.update` and `resolution.delete` take `lockResolution`, re-read and require DRAFT after the lock (so an edit or delete racing `send` is refused), and after send everything shown or sent (ballot page, emails, PO copy, PDF, `resolution.get`) reads `title` and `params` from `frozenContent`, which carries `{ title, type, params, doc, lockedClauses, requirements, recordDate }`. `frozenContent, frozenHash, recordDate, snapshotId, referenceCode, sentAt` are set once by `send`. Status transitions allowed: `DRAFT→SENT`, `SENT→EFFECTIVE|FAILED|EXPIRED|WITHDRAWN`. Nothing leaves a terminal status. Only DRAFT resolutions can be deleted.
5. `ResolutionRequirement`: rows are replaced freely while DRAFT; after send only `satisfiedAt`, `forUnitsAtClose` and the approval columns are written, each once.
6. `ResolutionEvent`: insert only, except that an email job deletes its OWN claim row when the send it claimed failed (G9, M1).
7. `MemberReport`: content mutable only while DRAFT; `SENT` is terminal (corrections are a new report). `MemberReportRecipient` rows may be added after send (late recipients, resends) but not deleted. Attachments may be added after send (e.g. a late K-1) but not deleted or replaced once the report is SENT.
8. `UnitTransfer`: `COMPLETED` and `CANCELLED` are terminal, except that the admission fields may be set after `COMPLETED`.

### C4. Migration plan (governance part)

- Wave (lead's ruling, 2026-11-12): FOUNDATION's **F0 is the single schema migration for all three areas**. The F0 executor copies section C2 of this plan verbatim (models, enums, the five `Company` lines, the two `Document` columns, the `Document` index and `BooksRecordCategoryEnum`). No governance package creates the initial migration. Any LATER governance schema change is a small additive migration owned by the package that needs it (`node_modules/.bin/prisma migrate dev --create-only --name <what>`), under the allow-list below.
- `Document.recordCategory`, `Document.recordYear`, the index and `BooksRecordCategoryEnum` are governance's and are added exactly once, in F0.
- Contents: all enums and models in C2, the two nullable `Document` columns, one new index on `Document`. The SQL must contain only `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX` and `ALTER TABLE "Document" ADD COLUMN ... NULL`. If the generated SQL contains any `DROP`, `ALTER COLUMN`, `RENAME` or a `NOT NULL` column added to an existing table, stop: the schema file has drifted from the migration history and that must be resolved with the owner first.
- Schema-level dependencies on other areas' models: NONE (FOUNDATION/ECONOMICS rows are referenced by plain ids), so C2 can be pasted in any position of the F0 schema edit.
- Runtime dependencies (code will not work without them): FOUNDATION `Company.entityType` and `Company.timezone`, `Stakeholder.isInsider/memberStatus/noticeEmail/admittedOn`, `UnitClass`, `getMemberPositions`, `withLlcAccessControl`, the logging `sendMail`; ECONOMICS `getSuspendedUnits`, `getPeriodEconomics`, `getComplianceDates`, `assertLedgerDateOpen`, `closeBooksThrough`, `business-days.ts` (see E).
- ECONOMICS stores `resolutionId` as a plain `String?` on `ManagerPayment`, `ExpenseEntry`, `MemberLoan` (no relation), so the two areas' models have no schema dependency on each other.
- After F0: `node_modules/.bin/prisma generate` regenerates `prisma/enums.ts` (do not edit that file by hand; it is excluded from Biome). G4 verifies that the governance tables, enums and `Document` columns exist exactly as in C2 and stops if they differ.
- No data backfill. Existing `Document` rows keep `recordCategory = NULL` ("uncategorised").

---

## D. Work packages

### D0. Overview, order, parallelism

| id | Package | Needs (governance) | Needs (other areas) | Can run in parallel with |
|---|---|---|---|---|
| G1 | Voting math `voting.ts` (pure) | — | — | G2, G3 |
| G2 | Rich document model + DOM renderer (pure) | — | — | G1, G3, G5 |
| G3 | Date and deadline math (pure) | — | — (business-day function injected) | G1, G2, G5 |
| G5 | Resolution presets and matter catalogue (pure) | G1 | — | G2, G3 |
| G4 | Schema check, shared-file edits, router stubs, queue scheduling | — | F0 merged and applied (it contains this plan's C2) and F1 merged (`withLlcAccessControl`, shared-file edits of F1) | G1, G2, G3, G5 (no common files) |
| G6 | Server core: tokens, snapshot, tally/transition, events, recipients | G1, G3, G4, G5 | F6 `getMemberPositions`; E7 `getSuspendedUnits`; E1 `business-days` | — |
| G9 | Executed PDF, filing, emails, finalize/notice jobs | G2, G5, G6 | F10 logging `sendMail` | G12a, G14a |
| G7 | Resolution router: drafts, preview, send, approve, withdraw | G2, G5, G6, G9 | — | G12, G14 |
| G8 | Ballot router (public), ballot management, sweep job | G6, G7, G9 | — | G10, G12, G14 |
| G10 | Manager UI: list, new, draft editor, send dialog | G7 | F2 placeholder pages | G8, G12, G14 |
| G11 | Manager UI: sent detail/tally; public ballot page | G8, G9, G10 | F10 `EmailLog` | G13, G15 |
| G12 | Member reports backend | G2, G3, G4, G6 | E19 `getPeriodEconomics`, `closeBooksThrough`; F10 `sendMail` | G7, G8, G10, G14 |
| G13 | Member reports UI, PDF, filing, public page | G9, G10, G12 | — | G11, G15 |
| G14 | Compliance calendar backend + daily sweep | G3, G4, G6 | E19 `getComplianceDates`; F10 `sendMail` | G7–G13 |
| G15 | Compliance calendar UI | G14 | — | G11, G13, G17 |
| G16 | Unit transfers backend | G3, G4, G6, G12, G14 | F6 `positions.ts`, `admitStakeholder`; E7 `applyUnitTransfer` (validation) | G15, G18 |
| G17 | Unit transfers UI | G16, G13 | — | G18 |
| G18 | Books and records | G4, G9, G13 | F0 (`Document` columns) | G17 |
| G19 | Member activity query, cross-area hooks, seed, end-to-end check | all | F7 member detail page; E13 procedures | — |

**Execution order** (one valid sequence; items in brackets may run at the same time): [G1, G2, G3] → G5 → G4 → G6 → G9 → G7 → G8 → [G10, G12, G14] → [G11, G13, G15] → G16 → [G17, G18] → G19. The package sections below are printed in this order, so G9 appears before G7.

**Split points.** Packages estimated above ~600 changed lines are executed as two sessions; do not renumber:

| Package | Session a | Session b |
|---|---|---|
| G5 | types, parameter schemas, `MATTERS`, `PROTECTED_PROVISIONS`, `buildRequirements`, `behaviour`, tests 1–4, 7, 8 | titles, starter bodies, locked clauses, `describeRequirements`, tests 5, 6 |
| G7 | `schema.ts`, `list`, `get`, `options`, `preview`, `create`, `update`, `delete`, `clone` | `send`, `approve`, `withdraw` and the acceptance checks |
| G8 | `ballot-router/**` (`resolve`, `view`, `mark-viewed`, `submit`, `executed-pdf`) | `add-recipients`, `remind`, `replace-link`, `revoke-link`, `evidence`, the sweep job and its registration |
| G9 | `rich-doc-pdf`, `resolution-pdf` (+test), `resolution-pdf-data`, `filing.ts` | the two email components, the three jobs, `resend-notice`, registration |
| G10 | `rich-text-editor(-lazy)`, `status-badge`, `resolution-table`, `resolution-preset-form`, the list page and the new page | `resolution-draft-editor`, `send-dialog`, the detail page shell |
| G11 | `tally-panel`, `ballot-table`, `resolution-detail`, the `get.ts` field | `ballot-form` and `src/app/ballots/[token]/page.tsx` |
| G12 | `report-figures.ts` (+test), `schema.ts`, `list`, `get`, `create`, `refresh-figures`, `update`, attachments procedures, `delete` | `send`, `resend`, `replace-link`, the email job and component, `member-report-view-router/**` |
| G13 | `report-view`, `report-pdf`, the filing job, the public page | `report-table`, `report-editor`, `report-figures-form`, `report-attachments`, `report-recipient-table`, the two dashboard pages |
| G14 | `compliance-core.ts` (+test), `compliance.ts`, the router | the daily sweep job, the digest email, registration |
| G16 | `transfer-core.ts` (+test), `list`, `get`, `create`, `update`, `create-notice-copy`, `cancel` | `complete`, `admit`, the edits to `src/server/llc/positions.ts` and `src/server/llc/economics/transfers.ts` with their tests |

File-ownership map (a package edits ONLY the files listed for it; shared files are edited only by G4):

- G1: `src/lib/llc/voting.ts`, `src/lib/llc/voting.test.ts`
- G2: `src/lib/governance/rich-doc.ts`, `rich-doc.test.ts`, `src/components/governance/rich-doc-view.tsx`, `rich-doc-view.test.tsx`
- G3: `src/lib/governance/dates.ts`, `dates.test.ts`
- G4: (no schema files — F0 owns the migration) `src/lib/rbac/subjects.ts`, `src/server/audit/schema.ts`, `src/constants/job.ts`, `src/lib/queue.ts`, `src/lib/tags.ts`, `src/server/file-uploads.ts`, `src/trpc/api/root.ts`, `src/jobs/register.ts`, `src/server/governance/guards.ts`, the eight router stub files
- G5: `src/lib/governance/presets.ts`, `presets.test.ts`
- G6: `src/lib/governance/token-payload.ts` (+test), `src/lib/governance/resolution-core.ts` (+test), `src/server/governance/{tokens,hash,positions,snapshot,tally,events,recipients,resolutions}.ts`
- G7: `src/trpc/routers/resolution-router/{router.ts,schema.ts,procedures/{list,get,preview,create,update,delete,clone,send,approve,withdraw}.ts}`
- G8: `src/trpc/routers/ballot-router/**`, `src/trpc/routers/resolution-router/procedures/{add-recipients,remind,replace-link,revoke-link,evidence}.ts` (+ their lines in `resolution-router/router.ts`), `src/jobs/governance-resolution-sweep.ts`, its two lines in `src/jobs/register.ts`
- G9: `src/pdf-templates/governance/{rich-doc-pdf,resolution-pdf}.tsx` (+test), `src/server/governance/{filing,resolution-pdf-data}.ts`, its three lines in `src/jobs/register.ts`, `src/emails/{BallotInviteEmail,ResolutionNoticeEmail}.tsx`, `src/jobs/governance-{ballot-email,resolution-notice,resolution-finalize}.ts`, `src/trpc/routers/resolution-router/procedures/resend-notice.ts`
- G10: `src/components/governance/{rich-text-editor,rich-text-editor-lazy,resolution-preset-form,resolution-draft-editor,resolution-table,status-badge,send-dialog}.tsx`, `src/app/(authenticated)/(dashboard)/[publicId]/resolutions/{page.tsx,new/page.tsx,[resolutionPublicId]/page.tsx}`
- G11: `src/components/governance/{resolution-detail,tally-panel,ballot-table,ballot-form}.tsx`, `src/app/ballots/[token]/page.tsx`, one output field in `resolution-router/procedures/get.ts`
- G12: `src/lib/governance/report-figures.ts` (+test), `src/trpc/routers/member-report-router/**` (including the adapter `procedures/period-data.ts`), `src/trpc/routers/member-report-view-router/**`, `src/jobs/governance-report-email.ts`, `src/emails/MemberReportEmail.tsx`, its line in `src/jobs/register.ts`
- G13: `src/components/governance/{report-table,report-editor,report-figures-form,report-attachments,report-recipient-table,report-view}.tsx`, two lines in `member-report-router/procedures/send.ts`, its line in `src/jobs/register.ts`, `src/pdf-templates/governance/report-pdf.tsx`, `src/jobs/governance-report-file.ts`, `src/app/(authenticated)/(dashboard)/[publicId]/reports/**`, `src/app/member-reports/[token]/page.tsx`
- G14: `src/lib/governance/compliance-core.ts` (+test), `src/server/governance/compliance.ts`, `src/trpc/routers/compliance-router/**`, its two lines in `src/jobs/register.ts`, `src/jobs/governance-daily-sweep.ts`, `src/emails/ComplianceDigestEmail.tsx`
- G15: `src/components/governance/{compliance-table,compliance-dialogs}.tsx`, `src/app/(authenticated)/(dashboard)/[publicId]/compliance/page.tsx`
- G16: `src/lib/governance/transfer-core.ts` (+test), `src/trpc/routers/unit-transfer-router/**`, and (at FOUNDATION's request) the transfer fold-in in `src/server/llc/positions.ts`
- G17: `src/components/governance/transfer-*.tsx`, `src/app/(authenticated)/(dashboard)/[publicId]/transfers/**`
- G18: `src/lib/governance/books-core.ts` (+test), `src/trpc/routers/books-router/**`, `src/components/governance/books-*.tsx`, `src/app/(authenticated)/(dashboard)/[publicId]/documents/books/page.tsx`
- G19: `src/trpc/routers/governance-router/**`, `src/components/governance/member-activity-tab.tsx`, the cross-area hook lines listed in G19, `prisma/seeds/**` additions

Global "do not touch" list (every package): everything under `src/trpc/routers/template-router`, `template-field-router`, `src/services/esign-service.ts`, `src/server/esign.ts`, `src/jobs/esign-*.ts`, `src/app/(documents)/**`, `src/components/template/**`, `src/components/update/**`, `src/trpc/routers/update/**`, `src/app/updates/**`, `src/lib/jwt.ts`, `src/lib/sanitize-update-html.ts`, `src/server/tenant-ownership.ts`, `src/lib/upload-authorization.ts`, `src/server/file-upload-actions.ts`, `src/proxy.ts`, `prisma/enums.ts` (generated), FOUNDATION's sidebar/navigation and Stakeholder pages and ECONOMICS's code, except the specific lines named in G16b and G19; ECONOMICS's `src/lib/llc/**` other than `voting.ts`. No package modifies git config, CI, Docker or env files.

Rules for every package

- Server procedures for Manager users: FOUNDATION's `withLlcAccessControl.meta({ policies: { governance: { allow: [<action>] } } })` (`src/trpc/api/trpc.ts`, F1). It rejects non-LLC companies and provides `ctx.company = { id, publicId, name, entityType, timezone }`. `companyId` ALWAYS from `ctx.membership.companyId`. Wherever a package below says "`withAccessControl`, `loadLlcCompany`", this is what is meant; do not call `loadLlcCompany` again in those procedures. Public (token) procedures and jobs have no such context: they call `loadLlcCompany(tx, companyId)` (G4) with the company id taken from the governance row.
- Dashboard pages start with `await requireLlc()` from `@/server/entity` (FOUNDATION F1; redirects non-LLC companies), then the RBAC check. FOUNDATION's F2 already created placeholder pages at `/resolutions`, `/transfers`, `/compliance`, `/documents/books` and an LLC placeholder at `/reports`: "create page" below means replace that placeholder's content; never rename the route.
- New rule violations are thrown as `TRPCError` (`BAD_REQUEST` with a message naming the Agreement section); procedures never return `{ success: false }` (FOUNDATION decision B4).
- Email: every send is `sendMail(options, logContext)` from `@/server/mailer` (FOUNDATION F10) with `logContext = { kind, companyId, stakeholderId?, relatedType, relatedId }`; the company display name goes in `options.headers["X-From-Name"]` (a pseudo-header: `sendMail` removes it and passes `from: { name, address }` to nodemailer, with the address always EMAIL_FROM's and the name stripped of control characters, so a company name cannot change the sender; M6); attachments go in `options.attachments` (nodemailer format). `relatedType` values used by governance: `"resolution"`, `"memberReport"`, `"complianceDeadline"`. A message is "not delivered" when its `EmailLog.bounceState === "BOUNCED"` (set by the Manager user through FOUNDATION's `emailLog.markBounce`).
- Any id that came from the client is resolved with `where: { <publicId|id>, companyId }` and a missing row is `TRPCError NOT_FOUND`.
- Mutations run inside `ctx.db.$transaction(async (tx) => { ... })`; jobs are emitted AFTER the transaction resolves, never inside it.
- Every mutation writes an `Audit` row (action named in the package) with `actor: { type: "user", id: ctx.session.user.id }`, `context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent }`. Jobs use `actor: { type: "system", id: null }`, `context: { requestIp: "system", userAgent: "job:<queue name>" }`. Token-holder actions use `actor: { type: "stakeholder", id: stakeholderId }`.
- Tested modules: relative imports only, no `server-only`, no `@/env` (A2).
- Biome: no `async` function without `await`; `import type` for type-only imports.

---

### G1 — Voting math (`src/lib/llc/voting.ts`)

**Goal.** A pure, dependency-free module that decides whether a set of ballots satisfies a set of requirements against a frozen register. No Prisma, no Date, no floats.

**Prerequisites.** None. No schema dependency.

**Files.** Create `src/lib/llc/voting.ts`, `src/lib/llc/voting.test.ts`. Nothing else.

**API (exact).**

```ts
export const UNIT_SCALE = 1_000_000n; // 6 decimal places

/** Accepts /^\d{1,14}(\.\d{1,6})?$/ only. Throws RangeError otherwise (negative, exponent, >6 dp, empty). */
export function toMicro(units: string): bigint;
/** Always 6 decimals: 525000001n -> "525.000001"; 0n -> "0.000000". Throws RangeError on negative. */
export function fromMicro(micro: bigint): string;

export type VoteBasis =
  | "PREFERRED_MAJORITY"
  | "PREFERRED_SUPERMAJORITY"
  | "DISINTERESTED_MAJORITY"
  | "DISINTERESTED_67"
  | "DISINTERESTED_70";
export type Choice = "FOR" | "AGAINST" | "ABSTAIN";

export interface HolderSnapshot {
  stakeholderId: string;
  preferredUnits: string; // decimal string
  isMember: boolean;      // memberStatus === MEMBER at snapshot
  isSuspended: boolean;   // OA 4.9(iii)
  isInsider: boolean;     // not disinterested (OA 1.18)
}
export interface CastVote { stakeholderId: string; choice: Choice }

export type Requirement =
  | { kind: "UNIT_VOTE"; basis: VoteBasis }
  | { kind: "MANAGER_APPROVAL" }
  | { kind: "COMMON_MEMBER_APPROVAL" }
  | { kind: "AFFECTED_MEMBER_CONSENT"; stakeholderId: string };

/** A resolution that only the Manager signs (purchase-order resolution, R16). */
export const MANAGER_ONLY: readonly Requirement[];

export function isDisinterestedBasis(basis: VoteBasis): boolean;
/** R2/R3: isMember && !isSuspended && units > 0 && (!isDisinterestedBasis(basis) || !isInsider). */
export function isEligible(holder: HolderSnapshot, basis: VoteBasis): boolean;
export function denominator(holders: readonly HolderSnapshot[], basis: VoteBasis): bigint;
/** Smallest For-weight that passes, or null when the denominator is 0. */
export function minimumFor(denominatorMicro: bigint, basis: VoteBasis): bigint | null;
export function meetsThreshold(forMicro: bigint, denominatorMicro: bigint, basis: VoteBasis): boolean;

export interface BasisTally {
  basis: VoteBasis;
  denominator: string; minimumFor: string | null;
  for: string; against: string; abstain: string; notVoted: string;
  eligibleCount: number; forCount: number; againstCount: number; abstainCount: number;
  forBps: number;      // floor(for * 10000 / denominator); 0 when denominator is 0. DISPLAY ONLY.
  passed: boolean;
  cannotPass: boolean; // for + notVoted < minimumFor, or denominator is 0
}
export function tallyBasis(holders: readonly HolderSnapshot[], votes: readonly CastVote[], basis: VoteBasis): BasisTally;

export interface ApprovalState { managerApproved: boolean; commonMemberApproved: boolean }
export type RequirementState = "PASSED" | "PENDING" | "CANNOT_PASS";
export interface RequirementResult { requirement: Requirement; state: RequirementState; tally: BasisTally | null }
export interface Evaluation { outcome: RequirementState; results: RequirementResult[] }
export function evaluate(
  requirements: readonly Requirement[],
  holders: readonly HolderSnapshot[],
  votes: readonly CastVote[],
  approvals: ApprovalState,
): Evaluation;

/** OA 2.5: returns votes plus an AGAINST for every holder eligible for at least one of `bases` that has no vote. */
export function applyDeemedAgainst(
  holders: readonly HolderSnapshot[], votes: readonly CastVote[], bases: readonly VoteBasis[],
): { votes: CastVote[]; deemedStakeholderIds: string[] };
```

**Rules.**

- Thresholds by cross-multiplication on micro-units (R4–R8): MAJORITY bases `for * 2n > den`; SUPERMAJORITY and DISINTERESTED_70 `for * 10n >= den * 7n`; DISINTERESTED_67 `for * 100n >= den * 67n`. `den === 0n` → false (R9).
- `minimumFor`: MAJORITY `den / 2n + 1n`; 70% `(den * 7n + 9n) / 10n`; 67% `(den * 67n + 99n) / 100n`; null when `den === 0n`.
- A vote from a holder not eligible for the basis is ignored for that basis (not an error). Two votes for the same `stakeholderId` → throw `Error("duplicate vote")`. A vote whose `stakeholderId` is not in `holders` → ignored.
- Abstain and no response are both "not For" (R9). `notVoted` = denominator − for − against − abstain.
- `evaluate`: `UNIT_VOTE` → PASSED if `passed`, CANNOT_PASS if `cannotPass`, else PENDING. `MANAGER_APPROVAL` / `COMMON_MEMBER_APPROVAL` → PASSED if the flag is true, else PENDING (never CANNOT_PASS). `AFFECTED_MEMBER_CONSENT` → PASSED if that stakeholder's vote is FOR (regardless of units, suspension or insider status), CANNOT_PASS if AGAINST or ABSTAIN, else PENDING. `outcome`: CANNOT_PASS if any result is CANNOT_PASS; else PASSED if every result is PASSED; else PENDING. Empty `requirements` → throw.
- `MANAGER_ONLY = [{ kind: "MANAGER_APPROVAL" }]`.

**Worked examples = tests** (`voting.test.ts`). Register `REG` used below:

| id | preferredUnits | isMember | isSuspended | isInsider | note |
|---|---|---|---|---|---|
| alice | 400.000000 | true | false | false | |
| bob | 300.000000 | true | false | false | |
| carol | 150.000000 | true | false | false | |
| dan | 50.500000 | true | false | false | fractional |
| schoen | 100.000000 | true | false | true | insider |
| reidTrust | 49.500000 | true | false | true | insider |
| sam | 200.000000 | true | true | false | suspended for default |
| fay | 75.000000 | false | false | false | Financial Interest only |
| octagon | 0.000000 | true | false | true | Common Member, no Preferred Units |

Denominators: preferred bases = 400 + 300 + 150 + 50.5 + 100 + 49.5 = **1050.000000**; disinterested bases = 400 + 300 + 150 + 50.5 = **900.500000**. (sam's 200 and fay's 75 are in neither; issued total is 1325.)

| # | Case | Expected |
|---|---|---|
| 1 | `toMicro("50.5")`, `toMicro("0.000001")`, `fromMicro(525000001n)` | `50500000n`, `1n`, `"525.000001"` |
| 2 | `toMicro("1.0000001")`, `toMicro("-1")`, `toMicro("1e3")`, `toMicro("")` | each throws RangeError |
| 3 | `denominator(REG, "PREFERRED_MAJORITY")`, `denominator(REG, "DISINTERESTED_67")` | `1050000000n`, `900500000n` |
| 4 | `minimumFor(1050000000n, …)` for MAJORITY / SUPERMAJORITY | `525000001n` / `735000000n` |
| 5 | `minimumFor(900500000n, …)` for DIS_MAJORITY / DIS_67 / DIS_70 | `450250001n` / `603335000n` / `630350000n` |
| 6 | PREFERRED_MAJORITY, FOR alice + schoen | for `"500.000000"`, passed false, cannotPass false, forBps 4761 |
| 7 | PREFERRED_MAJORITY, FOR alice + carol | for `"550.000000"`, passed true |
| 8 | PREFERRED_MAJORITY, FOR alice + schoen + reidTrust (insiders count) | for `"549.500000"`, passed true |
| 9 | PREFERRED_MAJORITY, FOR alice + sam + fay (suspended and non-Member ignored) | for `"400.000000"`, passed false, eligibleCount 6 |
| 10 | Boundary, holders x 500 / y 500, PREFERRED_MAJORITY, FOR x | passed false (exactly 50%); minimumFor `"500.000001"` |
| 11 | Boundary, x 500.000001 / y 499.999999, FOR x | passed true |
| 12 | PREFERRED_SUPERMAJORITY, FOR alice + bob | for 700, passed false, forBps 6666 |
| 13 | PREFERRED_SUPERMAJORITY, FOR alice + bob + dan | for `"750.500000"`, passed true |
| 14 | Boundary, x 700 / y 300, SUPERMAJORITY, FOR x | passed true (exactly 70%) |
| 15 | Boundary, x 699.999999 / y 300.000001, FOR x | passed false |
| 16 | DISINTERESTED_MAJORITY, FOR alice | for 400, passed false |
| 17 | DISINTERESTED_MAJORITY, FOR alice + dan | for `"450.500000"`, passed true |
| 18 | DISINTERESTED_MAJORITY, FOR alice + schoen + reidTrust (insider votes ignored) | for `"400.000000"`, passed false |
| 19 | Boundary, disinterested x 450.25 / y 450.25, FOR x | passed false |
| 20 | DISINTERESTED_67, FOR alice + bob | for 700, passed true |
| 21 | DISINTERESTED_67, FOR alice + carol + dan | for `"600.500000"`, passed false (needs 603.335000) |
| 22 | Boundary, disinterested x 67 / y 33, DIS_67, FOR x | passed true |
| 23 | Two-thirds is not enough: disinterested x 200 / y 100, DIS_67, FOR x | passed false; minimumFor `"201.000000"` |
| 24 | DISINTERESTED_70, FOR alice + bob | passed true |
| 25 | DISINTERESTED_70, FOR alice + carol + dan | passed false (600.5 < 630.35) |
| 26 | Boundary, disinterested x 630.35 / y 270.15, DIS_70, FOR x | passed true |
| 27 | cannotPass: SUPERMAJORITY, bob AGAINST, carol ABSTAIN | for 0, against 300, abstain 150, notVoted `"600.000000"`, cannotPass true |
| 28 | SUPERMAJORITY, bob AGAINST only | notVoted `"750.000000"`, cannotPass false |
| 29 | `evaluate([MANAGER_APPROVAL, UNIT_VOTE SUPER, UNIT_VOTE DIS_70])`, FOR alice + bob + schoen, managerApproved true | outcome PASSED (preferred For 800 ≥ 735; disinterested For 700 ≥ 630.35) |
| 30 | same votes, managerApproved false | outcome PENDING |
| 31 | same requirements, FOR alice + carol + dan + schoen + reidTrust, bob not voted, manager approved | SUPER passed (750 ≥ 735), DIS_70 pending (600.5 < 630.35) → PENDING |
| 32 | as 31 plus bob AGAINST | DIS_70 CANNOT_PASS → outcome CANNOT_PASS (insiders cannot carry a protected amendment) |
| 33 | `evaluate([SUPER, DIS_MAJORITY])` (insider loan, 4.6), FOR alice + bob + dan | PASSED (750.5 ≥ 735; 750.5 > 450.25) |
| 34 | `AFFECTED_MEMBER_CONSENT(sam)`, sam FOR | that result PASSED although sam is suspended; sam ABSTAIN → CANNOT_PASS; no vote → PENDING |
| 35 | `evaluate(MANAGER_ONLY, REG, [], { managerApproved: true, … })` | PASSED |
| 36 | `applyDeemedAgainst(REG, [alice FOR], ["PREFERRED_MAJORITY"])` | deemedStakeholderIds = bob, carol, dan, schoen, reidTrust (not sam, fay, octagon) |
| 37 | All holders insiders, DISINTERESTED_MAJORITY | denominator `"0.000000"`, minimumFor null, passed false, cannotPass true |
| 38 | Duplicate vote for alice | throws |

**Acceptance.** All 38 cases are individual `test(...)` blocks and pass; the file contains no `number` arithmetic on units (only `bigint`), no `parseFloat`/`Number(` applied to units, no imports.

**Do not touch.** Anything else in `src/lib/llc/**` (ECONOMICS).

---

### G2 — Rich document model

**Goal.** One validated, renderer-independent representation of a BlockNote document, used for resolution bodies and report commentary, so the web page, the PDF and the signed hash always agree (A5).

**Prerequisites.** None.

**Files.** Create `src/lib/governance/rich-doc.ts`, `src/lib/governance/rich-doc.test.ts`, `src/components/governance/rich-doc-view.tsx`.

**API.**

```ts
export interface Inline {
  text: string;
  bold?: true; italic?: true; underline?: true; strike?: true; code?: true;
  href?: string; // only http:, https:, mailto:
}
export type DocNode =
  | { t: "p"; indent: 0 | 1 | 2; inlines: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; inlines: Inline[] }
  | { t: "li"; indent: 0 | 1 | 2; marker: "bullet" | "number" | "check"; number?: number; checked?: boolean; inlines: Inline[] }
  | { t: "quote"; inlines: Inline[] }
  | { t: "hr" };
export type RichDoc = DocNode[];

export const MAX_DOC_NODES = 2000;
export const MAX_DOC_CHARS = 200_000;

export function normalizeBlocks(blocks: unknown):
  | { ok: true; doc: RichDoc }
  | { ok: false; errors: string[] };
export function isDocEmpty(doc: RichDoc): boolean;      // no node has non-whitespace text
export function docToPlainText(doc: RichDoc): string;    // one line per node
/** Deterministic JSON: object keys sorted recursively, arrays in order, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string;
/** Strict Zod schema of a RichDoc (no unknown keys or node types); used before rendering stored documents. */
export const RichDocSchema: z.ZodType<RichDoc>;
```

**Rules for `normalizeBlocks`.**

- Input must be an array of BlockNote blocks `{ type, props?, content?, children? }` (shape in `src/components/update/editor.tsx:47-66`). Anything else → `{ ok: false }`.
- Block mapping: `paragraph`→`p`; `heading`→`h` (`props.level` 1–3, 4–6 clamp to 3, missing → 1); `bulletListItem` and `toggleListItem`→`li bullet`; `numberedListItem`→`li number`; `checkListItem`→`li check` with `checked = props.checked === true`; `quote`→`quote`; `divider`→`hr`.
- Unsupported block types (`table, image, video, audio, file, codeBlock`, and any unknown type) → error string `Unsupported block: <type>`; all errors are collected and returned together.
- `children` are emitted after their parent with `indent + 1`, clamped to 2. `h`, `quote` and `hr` ignore indent.
- Numbered items: `number` counts consecutive `li number` nodes at the same indent, starting at `props.start` if it is a positive integer, else 1; any other node at that indent or a shallower one resets the count.
- Inline mapping: `{ type: "text", text, styles }` → one `Inline` with the five boolean styles (colours are dropped); `{ type: "link", href, content }` → one `Inline` per content item carrying `href` if its scheme is `http:`, `https:` or `mailto:` (parse with `new URL`, lower-case the scheme; otherwise drop `href` and keep the text). Unknown inline type → error `Unsupported inline content: <type>`. Empty-text inlines are dropped.
- Text cleaning: remove characters matching `/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g`.
- Limits: more than `MAX_DOC_NODES` nodes or more than `MAX_DOC_CHARS` characters in total → error.
- The result contains no `undefined` properties (omit absent optional keys), so `canonicalJson` is stable.

**`rich-doc-view.tsx`.** A Server-Component-safe React component (no `"use client"`, no hooks): `export function RichDocView({ doc }: { doc: RichDoc })`. Renders `p`→`<p>`, `h`→`<h2>/<h3>/<h4>` for levels 1/2/3, consecutive `li` nodes → flat `<div>` rows with a marker span (`•`, `{number}.`, `☐`/`☑`) and left padding `indent × 1.5rem` (no nested `<ul>` needed), `quote`→`<blockquote>`, `hr`→`<hr>`. Inline styles map to `<strong>/<em>/<u>/<s>/<code>`; `href` → `<a href target="_blank" rel="noopener noreferrer nofollow">`. Wrap in `<div className="prose max-w-none">`.

**Renderer safety rule (condition of the lead's acceptance of this design).** No renderer of a `RichDoc` — `RichDocView`, `RichDocPdf` (G9), `ReportView` (G13) or any later one — may emit raw HTML or markup taken from the JSON. Concretely: (1) text reaches the output only as a React text child (React escapes it) or a React-PDF `<Text>` child; `dangerouslySetInnerHTML`, `innerHTML`, string-built HTML and `render()`-to-string-then-inject are forbidden in every governance file; (2) element types, attributes and class names come only from the fixed mapping above, never from a value in the document; (3) the only attribute whose value comes from the document is `href`, and only when `normalizeBlocks` kept it, i.e. its scheme is `http:`, `https:` or `mailto:`; `RichDocView` re-checks the scheme with `new URL` before rendering the `<a>` and renders plain text otherwise (defence in depth for documents frozen before a rule change); (4) renderers accept only a `RichDoc` produced by `normalizeBlocks`; server code re-runs `normalizeBlocks` on stored BlockNote JSON, and for frozen content validates the stored `doc` with a strict Zod schema of `DocNode` (`RichDocSchema`, exported from `rich-doc.ts`) before rendering, so unknown keys or node types are rejected, not rendered.

**Tests** (`rich-doc.test.ts`).

1. Paragraph with bold text + link `https://example.com` → `[{ t: "p", indent: 0, inlines: [{ text: "Hello ", bold: true }, { text: "site", href: "https://example.com/" }] }]` (note `new URL` normalises to a trailing slash; assert with the normalised value, and store `url.href`).
2. `javascript:alert(1)` link → inline without `href`, text kept.
3. Image block → `{ ok: false, errors: ["Unsupported block: image"] }`; image + table → two errors.
4. Numbered list of three items then a paragraph then two numbered items → numbers 1, 2, 3 then 1, 2.
5. Nested bullet at depth 4 → `indent: 2`.
6. Heading level 5 → `level: 3`.
7. `canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })` → `{"a":[{"c":2,"d":1}],"b":1}`.
8. `isDocEmpty` true for `[{ t: "p", indent: 0, inlines: [] }]`, false when any text exists.
9. A string containing `\u0007` is cleaned.
10. Non-array input → `{ ok: false }`.
11. Text `<script>alert(1)</script><img src=x onerror=alert(1)>` in a paragraph → the inline text is kept byte-for-byte as text; `renderToStaticMarkup(<RichDocView doc={doc} />)` (from `react-dom/server`; test file `src/components/governance/rich-doc-view.test.tsx`, relative imports) contains `&lt;script&gt;` and `&lt;img` and contains neither `<script` nor `<img`.
12. Links with `javascript:alert(1)`, `JaVaScRiPt:alert(1)`, `data:text/html,<b>x</b>`, `vbscript:x`, `//evil.example` (no scheme) and ` https://ok.example` with a leading tab → only the last may keep an `href` (normalised to `https://ok.example/`); the rendered markup of the others contains no `href`.
13. `https://example.com/?q="><svg onload=alert(1)>` as href → rendered `href` attribute is escaped (markup contains no `<svg`).
14. A hand-built `RichDoc` (bypassing `normalizeBlocks`) with `href: "javascript:alert(1)"` passed straight to `RichDocView` → rendered without `href` (rule 3 re-check).
15. `RichDocSchema` rejects a node with an extra key (`{ t: "p", indent: 0, inlines: [], html: "<b>x</b>" }`) and an unknown node type (`{ t: "html" }`).
16. A block with `props` containing `{ style: "background:url(x)", className: "x", onClick: "y" }` → none of these strings appears in the rendered markup.
17. Source check (in the same test file): reading `rich-doc-view.tsx` as text, it does not contain `dangerouslySetInnerHTML` or `innerHTML`.

**Acceptance.** Tests 1–17 pass; `rich-doc.ts` imports nothing except `zod`; no HTML string is produced anywhere in the package; `grep -rn "dangerouslySetInnerHTML\|innerHTML" src/components/governance src/app/ballots src/app/member-reports src/pdf-templates/governance` returns nothing (re-run in G9, G11 and G13 acceptance).

---

### G3 — Date and deadline math (`src/lib/governance/dates.ts`)

**Goal.** Every date rule of the Agreement used by governance as a pure function with its worked example as a test.

**Prerequisites.** None. Business days are injected: `type AddBusinessDays = (ymd: Ymd, n: number) => Ymd` — exactly the shape of ECONOMICS `addBusinessDays(d, n)` in `src/lib/llc/business-days.ts` (day 1 is the first business day strictly after `d`). Tests use the fake described below.

**Reuse.** If `src/lib/llc/dates.ts` (ECONOMICS E1) exists when this package starts, import `addDays`, `addMonths`, `daysBetween`, `quarterOf`, `isoToUtcDate`, `utcDateToIso`, `toIsoDate` from `../llc/dates` and re-export them under the names below (`ymdToUtcDate = isoToUtcDate`, `utcDateToYmd = utcDateToIso`, `todayInZone = (now, tz) => toIsoDate(now, tz)`; `quarterOf` there returns `year`, map it to `fiscalYear`). If it does not exist yet, implement them locally with the semantics stated here; the tests are the same either way.

**Files.** Create `src/lib/governance/dates.ts`, `src/lib/governance/dates.test.ts`. Use `dayjs` with its `utc` and `timezone` plugins imported and extended INSIDE this module (`import dayjs from "dayjs"; import utc from "dayjs/plugin/utc"; import timezone from "dayjs/plugin/timezone"`); do not edit `src/common/dayjs.ts`.

**API and rules.** A `Ymd` is a `"YYYY-MM-DD"` string.

```ts
export const GOVERNANCE_TIME_ZONE = "America/Denver";
export type Ymd = string;
export function ymdToUtcDate(ymd: Ymd): Date;              // UTC midnight
export function utcDateToYmd(date: Date): Ymd;           // date.toISOString().slice(0, 10)
export function addDays(ymd: Ymd, n: number): Ymd;       // calendar days, UTC arithmetic
export function addMonths(ymd: Ymd, n: number): Ymd;     // clamps the day to the month length (Jan 31 + 1 month = Feb 28/29)
export function daysBetween(from: Ymd, to: Ymd): number; // to - from in days
export function todayInZone(now: Date, tz?: string): Ymd;
export function endOfDayInZone(ymd: Ymd, tz?: string): Date; // 23:59:59.999 local
/** R14: last instant on which a response counts. */
export function responseDeadline(sentAt: Date, days: number, tz?: string): Date;

export interface FiscalQuarter { fiscalYear: number; quarter: 1 | 2 | 3 | 4; start: Ymd; end: Ymd }
export function quarterOf(ymd: Ymd): FiscalQuarter;                   // R42
export function quarterBounds(fiscalYear: number, quarter: 1 | 2 | 3 | 4): FiscalQuarter;
export function quarterlyReportDueOn(fiscalYear: number, quarter: 1 | 2 | 3 | 4): Ymd; // R23: quarter end + 45 days
export function annualFinancialsDueOn(fiscalYear: number): Ymd;      // R24: Dec 31 + 90 days
export function k1TargetDueOn(fiscalYear: number): Ymd;              // R25: March 31 of fiscalYear + 1
export function k1FinalDueOn(fiscalYear: number): Ymd;               // R25: September 15 of fiscalYear + 1
export function firstOfFollowingMonth(ymd: Ymd): Ymd;                // R35

export interface TransferDatesInput {
  kind: "VOLUNTARY" | "PERMITTED_TRANSFEREE" | "INVOLUNTARY" | "DEATH_INCAPACITY";
  noticeReceivedOn: Ymd;
  transferNoticeOn: Ymd | null;
  priceEstablishedOn: Ymd | null;
}
export interface TransferDates {
  noticeCopyDueOn: Ymd | null;   // +5 BD (R31, R33)
  managerRofrEndsOn: Ymd | null; // +45 days
  memberRofrEndsOn: Ymd | null;  // +90 days
  closeByOn: Ymd | null;         // +270 days, VOLUNTARY only (R31)
  purchaseCloseByOn: Ymd | null; // priceEstablishedOn + 45 days (R40)
  effectiveOn: Ymd | null;       // firstOfFollowingMonth(transferNoticeOn) (R35)
}
export function computeTransferDates(input: TransferDatesInput, add: AddBusinessDays): TransferDates;

export interface DeadlineSpec { ruleKey: string; dedupeKey: string; title: string; section: string; dueOn: Ymd }
/** Rule-based deadlines C1–C4 (see G14). Pure: no database. */
export function generateRuleDeadlines(input: { firstAdmittedOn: Ymd | null; today: Ymd; horizonDays: number }): DeadlineSpec[];

/** Reminder bucket for a deadline today, or null when no reminder is due (G14). */
export function reminderBucket(dueOn: Ymd, today: Ymd): number | null;
```

- `computeTransferDates`: VOLUNTARY → all of `noticeCopyDueOn, managerRofrEndsOn, memberRofrEndsOn, closeByOn`; INVOLUNTARY → `noticeCopyDueOn, managerRofrEndsOn, memberRofrEndsOn`, `closeByOn = null`; PERMITTED_TRANSFEREE and DEATH_INCAPACITY → those four are null. `purchaseCloseByOn` and `effectiveOn` are computed for every kind when their input is present.
- `generateRuleDeadlines`: returns `[]` when `firstAdmittedOn` is null. For every fiscal quarter whose `end >= firstAdmittedOn` and whose due date `<= today + horizonDays`: `{ ruleKey: "QUARTERLY_REPORT", dedupeKey: "QUARTERLY_REPORT:2026Q4", title: "Q4 2026 quarterly report to Members", section: "8.2; 5.6(a)", dueOn }`. For every fiscal year whose Dec 31 `>= firstAdmittedOn`: `ANNUAL_FINANCIALS:<fy>` ("FY2026 balance sheet and income statement to Members", "8.2"), `K1_TARGET:<fy>` ("FY2026 Schedules K-1 to Members (target)", "8.2"), `K1_FINAL:<fy>` ("FY2026 Schedules K-1 (extended filing deadline)", "8.2"), each only if its due date `<= today + horizonDays`. Sorted by `dueOn`, then `dedupeKey`.
- `reminderBucket`: let `left = daysBetween(today, dueOn)`. If `left > 30` → null. If `left >= 0` → the smallest value in `[0, 1, 3, 7, 14, 30]` that is `>= left`. If `left < 0` → `-(Math.floor((-left - 1) / 7) + 1)` (−1 for 1–7 days overdue, −2 for 8–14, …). The caller sends a reminder only when the bucket is not yet in `ComplianceDeadline.remindedBuckets`, which also catches up after downtime.

**Tests** (`dates.test.ts`). Fake business-day adder for tests: skips Saturdays, Sundays and the dates `2026-11-26`, `2026-12-25`, `2027-01-01`.

| # | Call | Expected |
|---|---|---|
| 1 | `quarterlyReportDueOn(2026, 4)` | `2027-02-14` (not rolled although it is a Sunday) |
| 2 | `quarterlyReportDueOn(2027, 1)`, `(2027, 2)`, `(2027, 3)` | `2027-05-15`, `2027-08-14`, `2027-11-14` |
| 3 | `annualFinancialsDueOn(2026)` | `2027-03-31` |
| 4 | `annualFinancialsDueOn(2027)` | `2028-03-30` (2028 is a leap year) |
| 5 | `k1TargetDueOn(2026)`, `k1FinalDueOn(2026)` | `2027-03-31`, `2027-09-15` |
| 6 | `firstOfFollowingMonth("2027-01-15")`, `("2027-01-31")`, `("2027-02-01")`, `("2027-12-10")` | `2027-02-01`, `2027-02-01`, `2027-03-01`, `2028-01-01` |
| 7 | `responseDeadline(new Date("2031-01-10T21:00:00Z"), 30)` | `2031-02-10T06:59:59.999Z` (end of Feb 9 in Denver, UTC−7) |
| 8 | `responseDeadline(new Date("2031-01-11T03:30:00Z"), 30)` (still Jan 10 in Denver) | `2031-02-10T06:59:59.999Z` |
| 9 | `responseDeadline(new Date("2027-02-20T18:00:00Z"), 30)` (crosses the start of daylight time) | `2027-03-23T05:59:59.999Z` (end of Mar 22, UTC−6) |
| 10 | the fake adder itself: `fake("2026-11-17", 10)` (PO copy, R16; Thanksgiving skipped) | `2026-12-02` (the real ECONOMICS function gives the same) |
| 11 | `computeTransferDates({ kind: "VOLUNTARY", noticeReceivedOn: "2027-03-01", transferNoticeOn: "2027-06-10", priceEstablishedOn: null }, fake)` | `noticeCopyDueOn 2027-03-08`, `managerRofrEndsOn 2027-04-15`, `memberRofrEndsOn 2027-05-30`, `closeByOn 2027-11-26`, `purchaseCloseByOn null`, `effectiveOn 2027-07-01` |
| 12 | same with `kind: "INVOLUNTARY"`, `priceEstablishedOn: "2027-06-01"` | `closeByOn null`, `purchaseCloseByOn 2027-07-16`, other dates as 11 |
| 13 | `kind: "PERMITTED_TRANSFEREE"`, `transferNoticeOn: "2027-03-01"` | four ROFR/copy dates null, `effectiveOn 2027-04-01` |
| 14 | `generateRuleDeadlines({ firstAdmittedOn: "2026-11-20", today: "2026-11-25", horizonDays: 400 })` | exactly 7 specs: `QUARTERLY_REPORT:2026Q4` 2027-02-14; `ANNUAL_FINANCIALS:2026` 2027-03-31; `K1_TARGET:2026` 2027-03-31; `QUARTERLY_REPORT:2027Q1` 2027-05-15; `QUARTERLY_REPORT:2027Q2` 2027-08-14; `K1_FINAL:2026` 2027-09-15; `QUARTERLY_REPORT:2027Q3` 2027-11-14 (the horizon ends 2027-12-30) |
| 15 | `generateRuleDeadlines({ firstAdmittedOn: null, … })` | `[]` |
| 16 | `reminderBucket("2027-02-14", today)` for today = `2027-01-10`, `2027-01-15`, `2027-01-20`, `2027-01-31`, `2027-02-09`, `2027-02-14`, `2027-02-15`, `2027-02-22` | `null`, `30`, `30`, `14`, `7`, `0`, `-1`, `-2` |
| 17 | `addMonths("2031-11-30", -9)` (extension request, R14, for display only) | `2031-02-28` |

**Acceptance.** Tests pass; no function reads the system clock (callers pass `now`/`today`).

---

### G4 — Schema check, shared-file edits, router stubs, queue scheduling

**Goal.** Land every change to a shared file in one reviewed package so later packages touch only their own files.

**Prerequisites.** FOUNDATION F0 (schema: `Company.entityType`, `Company.timezone`, Stakeholder fields) and F1 (its own edits to `subjects.ts`, `audit/schema.ts`, `root.ts`, `trpc.ts`) merged. G4 APPENDS to those files after F1; it never reorders or removes F1's entries. If ECONOMICS E6 has also appended audit values, keep one copy of any identical string.

**Steps and exact edits.**

The full list of routers, the RBAC subject, the audit values and the navigation routes was sent to FOUNDATION on 2026-11-12. FOUNDATION confirmed that its F1 creates the eight router stubs, registers them in `root.ts`, appends the RBAC subject `governance` and adds the governance audit actions, actor types and target types; so steps 2, 3, 8 and 9 below are normally verification only. Steps 4–7, 10 and 11 remain G4's work. For steps 2, 3, 8 and 9: if F1/F2 already added an entry, leave it and add only what is missing; never add a duplicate string or key. All new dialogs in governance UI packages are local `<Dialog>` components (`@/components/ui/dialog`); `src/components/modals/index.ts` is never edited.

1. Schema: do NOT edit `prisma/schema.prisma` and do NOT create a migration. Confirm that F0 landed C2 verbatim: every model and enum of C2 is present in the schema with identical fields, `Company` has the five relation lines, `Document` has `recordCategory`, `recordYear` and the index. Run `node_modules/.bin/prisma validate` and `node_modules/.bin/prisma generate`. Any difference → stop and report to the lead; do not patch it locally. (C2 was validated with `prisma validate` against the pre-F0 schema on 2026-11-12.)
2. `src/lib/rbac/subjects.ts`: add `"governance"` as the last element of `SUBJECTS`. Then run `tsc`; fix any exhaustive `Record<TSubjects, …>` in `src/components/rbac/**` or `src/lib/rbac/rbac.test.ts` by adding a `governance` entry labelled "Governance (resolutions, reports, compliance, transfers)".
3. `src/server/audit/schema.ts`:
   - append to the `action` enum: `"resolution.created", "resolution.updated", "resolution.deleted", "resolution.sent", "resolution.approved", "resolution.withdrawn", "resolution.effective", "resolution.failed", "resolution.expired", "resolution.filed", "resolution.copy-delivered", "ballot.issued", "ballot.link-replaced", "ballot.link-revoked", "ballot.reminded", "ballot.submitted", "ballot.deemed", "memberReport.created", "memberReport.updated", "memberReport.deleted", "memberReport.sent", "memberReport.resent", "memberReport.filed", "compliance.created", "compliance.updated", "compliance.completed", "compliance.reopened", "unitTransfer.created", "unitTransfer.updated", "unitTransfer.completed", "unitTransfer.cancelled", "unitTransfer.admitted", "document.categorized"`;
   - `actor.type` enum: add `"stakeholder", "system"`;
   - `target[].type` enum: add `"resolution", "ballot", "memberReport", "complianceDeadline", "unitTransfer"`.
   - If `tsc` then reports a non-exhaustive map in the audits UI (`src/components/audit/**`), add the missing keys with plain labels.
4. `src/constants/job.ts`: add the group `governance: ["ballot-email", "resolution-notice", "resolution-finalize", "resolution-sweep", "report-email", "report-file", "daily-sweep"]`.
5. `src/lib/queue.ts`: add schedule support, keeping everything else unchanged:

```ts
interface ScheduleFactory {
  name: JobType;
  cron: string;
  tz?: string;
}
// inside createQueue():
const schedules: ScheduleFactory[] = [];
function schedule(factory: ScheduleFactory) {
  schedules.push(factory);
}
// at the end of start(), after the loop that creates queues and workers:
for (const item of schedules) {
  if (!jobs.has(item.name)) {
    throw new Error(`Cannot schedule unregistered job ${item.name}`);
  }
  log.info(logPrefix(`Scheduling job:${item.name} (${item.cron})`));
  await queue.schedule(item.name, item.cron, {}, { tz: item.tz ?? "UTC", missed: "once" });
}
// return { start, register, schedule };
```

   The queue must be created before `queue.schedule` (A7) — the loop order above guarantees it. `missed: "once"` sends one catch-up job after downtime.
6. `src/lib/tags.ts`: add `RESOLUTION = "resolution"` and `MEMBER_REPORT = "member-report"` to `enum TAG`.
7. `src/server/file-uploads.ts`: extend `TypeKeyPrefixes` with `| "resolutions" | "member-reports"`. Do NOT add them to `CLIENT_PRIVATE_KEY_PREFIXES` (they are server-written only).
8. Router stubs, each file exactly `import { createTRPCRouter } from "@/trpc/api/trpc"; export const <name> = createTRPCRouter({});`:
   `src/trpc/routers/resolution-router/router.ts` (`resolutionRouter`), `ballot-router/router.ts` (`ballotRouter`), `member-report-router/router.ts` (`memberReportRouter`), `member-report-view-router/router.ts` (`memberReportViewRouter`), `compliance-router/router.ts` (`complianceRouter`), `unit-transfer-router/router.ts` (`unitTransferRouter`), `books-router/router.ts` (`booksRouter`), `governance-router/router.ts` (`governanceRouter`).
9. `src/trpc/api/root.ts`: import the eight routers and add keys `resolution, ballot, memberReport, memberReportView, compliance, unitTransfer, books, governance`.
10. `src/jobs/register.ts`: no worker yet; add the comment line `// governance workers and schedules are registered below by G8, G9, G12, G13, G14` above `//start`. Later packages each add their own `queueManager.register(...)` / `queueManager.schedule(...)` lines there (the only shared file they may touch, one line each).
11. `src/server/governance/guards.ts`:

```ts
import "server-only";
import { TRPCError } from "@trpc/server";
import type { TPrismaOrTransaction } from "@/server/db";

/**
 * For jobs and public token procedures (no session). Manager procedures use
 * FOUNDATION's `withLlcAccessControl` instead. Throws NOT_FOUND for a company
 * that is not an LLC, so a token reveals nothing.
 */
export async function loadLlcCompany(tx: TPrismaOrTransaction, companyId: string) {
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { id: true, publicId: true, name: true, logo: true, entityType: true, timezone: true },
  });
  if (!company || company.entityType !== "LLC") {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return company;
}
```

**Acceptance.**
- `prisma validate` passes and the schema contains C2 unchanged; this package adds no migration and changes no schema line.
- `tsc`, `biome check ./src`, `vitest run`, `next build` pass.
- Starting the app logs no "Queue … not found" error (no schedules are registered yet).
- An ADMIN session passes a `governance` policy check; the existing `rbac.test.ts` passes.

**Do not touch.** Any existing model field, any existing enum value, any existing audit action.

---

### G5 — Resolution presets and matter catalogue (`src/lib/governance/presets.ts`)

**Goal.** One pure module that turns a resolution type + parameters into: title, starter body, locked clauses, requirements and delivery behaviour. The server never trusts requirements sent by the browser; it always rebuilds them here.

**Prerequisites.** G1 (imports `VoteBasis` and `Requirement` types with a relative import: `../llc/voting`).

**Files.** Create `src/lib/governance/presets.ts`, `src/lib/governance/presets.test.ts`. `zod` may be imported.

**Types.**

```ts
export type ResolutionType =
  | "GENERAL_CONSENT" | "RELATED_PARTY" | "PURCHASE_ORDER" | "TERM_EXTENSION"
  | "MANAGER_REMOVAL" | "SUCCESSOR_MANAGER" | "AMENDMENT" | "AUDIT_CALL" | "MEMBER_LOAN";

export interface RequirementSpec { requirement: Requirement; section: string }
export interface PresetContext { companyName: string }
export interface StarterBlock { type: "paragraph" | "heading"; text: string } // converted to BlockNote blocks by the UI (G10)

export interface PresetBehaviour {
  hasBallots: boolean;            // false only for PURCHASE_ORDER
  fixedWindowDays: number | null; // 30 for TERM_EXTENSION, else null (Manager chooses 1–180, default 30)
  deemedAgainstAtClose: boolean;  // true only for TERM_EXTENSION (R14)
  allRecipientsRequired: boolean; // true for TERM_EXTENSION: every eligible Member must be asked
  copyToMembersBusinessDays: number | null; // 10 for PURCHASE_ORDER (R16), else null
  alsoFileUnder: "ARTICLES_AND_AGREEMENT" | null; // AMENDMENT
  kindLabel: string;              // PDF heading
}

export const MATTERS: Record<string, { label: string; section: string; requirements: RequirementSpec[]; presetType: ResolutionType | null }>;
export const PROTECTED_PROVISIONS: readonly string[]; // R18(c), verbatim list below
export const PRE_APPROVED_RELATED_PARTY: readonly string[]; // R15 (1)–(6), short labels

export function paramsSchema(type: ResolutionType): z.ZodType; // strict object per type
export function buildRequirements(type: ResolutionType, params: unknown): RequirementSpec[];
export function buildTitle(type: ResolutionType, params: unknown, ctx: PresetContext): string;
export function buildStarterBody(type: ResolutionType, params: unknown, ctx: PresetContext): StarterBlock[];
export function buildLockedClauses(type: ResolutionType, params: unknown, ctx: PresetContext): string[];
export function behaviour(type: ResolutionType): PresetBehaviour;
export function describeRequirements(specs: RequirementSpec[]): string; // sentence used as the last locked clause
```

**Parameters per type** (all strings trimmed; "money" = `/^\d{1,12}(\.\d{1,2})?$/`; "ymd" = `/^\d{4}-\d{2}-\d{2}$/`):

| Type | Params |
|---|---|
| GENERAL_CONSENT | `matterKey` (a key of `MATTERS` whose `presetType` is null), `requireManagerApproval: boolean`, `additionalBases: VoteBasis[]` (default `[]`) |
| RELATED_PARTY | `counterparty` (1–200), `relationship` (1–200), `description` (1–2000), `amount` (money, optional) |
| PURCHASE_ORDER | `vendor` (1–200), `equipment` (1–2000), `price` (money, > 0), `currency` (default `"USD"`, 3 letters), `poReference` (0–100), `managerName` (1–200), `purchasingAgentName` (1–200) |
| TERM_EXTENSION | `currentTargetSaleDate` (ymd), `extensionNumber` (int ≥ 1) |
| MANAGER_REMOVAL | `managerName` (1–200), `requestedBy` (0–500) |
| SUCCESSOR_MANAGER | `successorName` (1–200), `reason: "REMOVAL" | "RESIGNATION"` |
| AMENDMENT | `summary` (1–2000), `touchesProtectedProvision: boolean`, `protectedSections: string[]` (subset of `PROTECTED_PROVISIONS`; must be non-empty iff the boolean is true), `adverseToCommon: boolean`, `affectedMemberIds: string[]` (max 50, unique) |
| AUDIT_CALL | `fiscalYear` (int 2026–2100), `scope: "REVIEW" | "AUDIT"`, `periodDescription` (1–500) |
| MEMBER_LOAN | `lenderName` (1–200), `lenderIsInsider: boolean`, `principal` (money > 0), `interestRate` (1–100 chars), `maturity` (1–100 chars) |

**Requirements per type** (`section` in brackets):

- GENERAL_CONSENT: `MATTERS[matterKey].requirements`, plus `MANAGER_APPROVAL` [matter section] if `requireManagerApproval` and not already present, plus one `UNIT_VOTE` per `additionalBases` entry not already present [6.9]. The Manager user can only ADD (R11 `OTHER`).
- RELATED_PARTY: `UNIT_VOTE DISINTERESTED_MAJORITY` [6.16(i)].
- PURCHASE_ORDER: `MANAGER_APPROVAL` [6.16(i)(B)].
- TERM_EXTENSION: `UNIT_VOTE PREFERRED_MAJORITY` [2.5].
- MANAGER_REMOVAL: `UNIT_VOTE DISINTERESTED_67` [6.20].
- SUCCESSOR_MANAGER: `UNIT_VOTE DISINTERESTED_MAJORITY` [6.20].
- AMENDMENT, in this order: `MANAGER_APPROVAL` [12.1]; `UNIT_VOTE PREFERRED_SUPERMAJORITY` [12.1]; if `touchesProtectedProvision`: `UNIT_VOTE DISINTERESTED_70` [12.1(c)]; if `adverseToCommon`: `COMMON_MEMBER_APPROVAL` [12.1(d)]; one `AFFECTED_MEMBER_CONSENT` per `affectedMemberIds` entry [12.1(b)].
- AUDIT_CALL: `UNIT_VOTE PREFERRED_MAJORITY` [8.3].
- MEMBER_LOAN: `UNIT_VOTE PREFERRED_SUPERMAJORITY` [4.6; 6.16(d)]; if `lenderIsInsider`: `UNIT_VOTE DISINTERESTED_MAJORITY` [6.16(i)].

`MATTERS`: exactly the table in R11. `presetType` is null for the rows handled by GENERAL_CONSENT and set for `RELATED_PARTY, TERM_EXTENSION, AUDIT_CALL, MANAGER_REMOVAL, SUCCESSOR_MANAGER, AMENDMENT, MEMBER_LOAN`. `EARLY_DISSOLUTION` requirements are `[MANAGER_APPROVAL, UNIT_VOTE PREFERRED_SUPERMAJORITY]`; `INDEMNITY_SETTLEMENT` is `[MANAGER_APPROVAL, UNIT_VOTE DISINTERESTED_MAJORITY]`; `INDEMNITY_DETERMINATION` is `[UNIT_VOTE DISINTERESTED_MAJORITY]`; `OTHER` is `[UNIT_VOTE PREFERRED_SUPERMAJORITY]`.

`PROTECTED_PROVISIONS` (verbatim, R18(c)): `"Section 2.4", "Section 2.5", "Section 4.8", "Section 4.9", "Section 5.6", "Section 6.16(d)", "Section 6.16(i)", "Section 6.18", "Section 6.20", "Section 6.21", "Section 11.4", "Last sentence of Section 6.9", "Section 7.1 (restriction on transfer of Common Units and change of control of the Manager)", "Section 12.1", "Definition of Available Cash", "Definition of Common Units", "Definition of Disinterested Preferred Units", "Definition of Preferred Majority", "Definition of Preferred Supermajority", "Definition of Preferred Units"`.

**Titles.**

- GENERAL_CONSENT: `Written consent: {MATTERS[matterKey].label}`
- RELATED_PARTY: `Approval of related-party transaction with {counterparty}`
- PURCHASE_ORDER: `Manager resolution: purchase order — {vendor}`
- TERM_EXTENSION: `Extension of the operating term to {proposedDate long form}` where `proposedDate = addMonths(currentTargetSaleDate, 12)` (inline the month arithmetic; do not import G3)
- MANAGER_REMOVAL: `Removal of {managerName} as Manager`
- SUCCESSOR_MANAGER: `Appointment of {successorName} as successor Manager`
- AMENDMENT: `Amendment to the Operating Agreement`
- AUDIT_CALL: `{Review | Audit} of the books and records for fiscal year {fiscalYear}`
- MEMBER_LOAN: `Approval of a loan from {lenderName}`

**Locked clauses** (plain strings, rendered after the editable body, never editable; `{company}` = `ctx.companyName`). Before a parameter value is inserted into a sentence, trim it and strip ONE trailing full stop, so `Acme Servers Inc.` followed by the template's own full stop does not produce `Inc..`. The LAST locked clause of every type is `describeRequirements(buildRequirements(...))`.

- PURCHASE_ORDER (R16), in order:
  1. `This written resolution is made by {managerName}, the Manager of {company} (the "LLC"), under Section 6.16(i) of the LLC's Operating Agreement, before any LLC funds are paid for the purchase order described below.`
  2. `Purchase order. Vendor: {vendor}. Equipment: {equipment}. Price: {currency} {price formatted with thousands separators}.` + (if `poReference`) ` Reference: {poReference}.`
  3. `Agent and nominee. {purchasingAgentName} (the "Purchasing Agent"), being the Manager or an Affiliate of the Manager, acts solely as agent and nominee for the LLC in connection with this purchase order.`
  4. `No beneficial interest; trust. The Purchasing Agent has no beneficial interest in the purchase order, any deposit, or the equipment, and holds each of them in trust for the LLC.`
  5. `Assignment. The Purchasing Agent assigns to the LLC its rights under the purchase order to the extent assignable.`
  6. `Delivery. A copy of this resolution will be delivered to the Members within ten (10) business days after it is signed.`
- TERM_EXTENSION (R14):
  1. `Under Section 2.5 of the Operating Agreement, the Manager asks the Preferred Members whether to extend the operating term of {company} for one (1) additional year.`
  2. `If the extension is approved, the Target Sale Date will be extended from {currentTargetSaleDate long form} to {proposedDate long form}, and the Management Fee will continue to accrue during the extension.`
  3. `A Preferred Member who does not respond within thirty (30) days after this request is deemed to have voted against the extension.`
- RELATED_PARTY: `Counterparty: {counterparty} ({relationship}). Transaction: {description}.` + (if amount) ` Amount: USD {amount}.`; then `Under Section 6.16(i) of the Operating Agreement this transaction may not be entered into unless first approved by the holders of a majority of the Disinterested Preferred Units. Preferred Units held by the Manager, Isaac Reid, Karl Schoen, their Affiliates and related persons are not counted.`
- MANAGER_REMOVAL: `Under Section 6.20 of the Operating Agreement the Manager may be removed by the vote of the holders of at least sixty-seven percent (67%) of the Disinterested Preferred Units. Removal does not affect the Common Units, any accrued and unpaid Management Fee, or the removed Manager's rights to indemnification, and the removed Manager shall be released from any guarantee of LLC obligations as a condition of removal.`
- SUCCESSOR_MANAGER: `Under Section 6.20 of the Operating Agreement the holders of a majority of the Disinterested Preferred Units appoint {successorName} as successor Manager, effective when {successorName} accepts the appointment in writing.`
- AMENDMENT: `Summary of the amendment: {summary}`; if protected: `This amendment changes the following provisions listed in Section 12.1(c): {protectedSections joined with "; "}.`; `Under Section 13.1 an amendment adopted in accordance with Section 12.1 binds every Member whether or not that Member signed or consented to it.`
- AUDIT_CALL: `Under Section 8.3 of the Operating Agreement a Preferred Majority requires a {review | audit} of the books, records and reports of {company} for {periodDescription}, at the LLC's expense. This right may be exercised not more than once in any fiscal year.`
- MEMBER_LOAN: `Lender: {lenderName}. Principal: USD {principal}. Interest rate: {interestRate}. Maturity: {maturity}. Under Section 4.6 the advance is not a Capital Contribution, shall be documented by a promissory note, and shall be repaid in accordance with that note before distributions are made under Section 5.6.`
- GENERAL_CONSENT: `Matter: {label} (Section {section} of the Operating Agreement).`

`describeRequirements` wording, joined with "; " inside `Approval required: … .`: `MANAGER_APPROVAL` → `the approval of the Manager`; `COMMON_MEMBER_APPROVAL` → `the approval of the Common Member`; `AFFECTED_MEMBER_CONSENT` → `the consent of each Member disproportionately and adversely affected`(once, however many); `PREFERRED_MAJORITY` → `the holders of more than 50% of the outstanding Preferred Units`; `PREFERRED_SUPERMAJORITY` → `the holders of at least 70% of the outstanding Preferred Units`; `DISINTERESTED_MAJORITY` → `the holders of more than 50% of the outstanding Disinterested Preferred Units`; `DISINTERESTED_67` → `the holders of at least 67% of the outstanding Disinterested Preferred Units`; `DISINTERESTED_70` → `the holders of at least 70% of the outstanding Disinterested Preferred Units`. For types with ballots append the sentence ` This consent is effective under Section 6.12 when signed by Members holding the required Preferred Units.`

**Starter bodies** (editable): one heading `Resolved` and one paragraph: GENERAL_CONSENT `RESOLVED, that the Members approve the following: [describe the action].`; RELATED_PARTY `RESOLVED, that the transaction described below is approved.`; PURCHASE_ORDER `The Manager adopts the resolution set out below.`; TERM_EXTENSION `Do you approve extending the operating term for one additional year?`; MANAGER_REMOVAL `RESOLVED, that {managerName} is removed as Manager of {company}.`; SUCCESSOR_MANAGER `RESOLVED, that {successorName} is appointed successor Manager of {company}.`; AMENDMENT `RESOLVED, that the Operating Agreement is amended as follows: [insert the full text of the amendment].`; AUDIT_CALL `RESOLVED, that a {review | audit} is required as described below.`; MEMBER_LOAN `RESOLVED, that the loan described below is approved.`

**Behaviour.** `hasBallots` false only for PURCHASE_ORDER; `fixedWindowDays` 30, `deemedAgainstAtClose` true, `allRecipientsRequired` true only for TERM_EXTENSION; `copyToMembersBusinessDays` 10 only for PURCHASE_ORDER; `alsoFileUnder` `ARTICLES_AND_AGREEMENT` only for AMENDMENT; `kindLabel` = `Written Resolution of the Manager` for PURCHASE_ORDER, else `Action by Written Consent of the Members`.

**Tests** (`presets.test.ts`).

1. AMENDMENT with `touchesProtectedProvision: true, protectedSections: ["Section 5.6"], adverseToCommon: true, affectedMemberIds: ["s1", "s2"]` → 6 requirement specs in the order above with sections `12.1, 12.1, 12.1(c), 12.1(d), 12.1(b), 12.1(b)`.
2. AMENDMENT with `touchesProtectedProvision: true, protectedSections: []` → `paramsSchema` rejects; with `false` and a non-empty list → rejects.
3. MEMBER_LOAN insider → `[SUPERMAJORITY, DISINTERESTED_MAJORITY]`; non-insider → `[SUPERMAJORITY]`.
4. GENERAL_CONSENT `matterKey: "EARLY_DISSOLUTION"` → `[MANAGER_APPROVAL, SUPERMAJORITY]`; `matterKey: "POST_TARGET_DISSOLUTION"` → `[SUPERMAJORITY]`; `matterKey: "OTHER", additionalBases: ["DISINTERESTED_MAJORITY"]` → `[SUPERMAJORITY, DISINTERESTED_MAJORITY]`; `matterKey: "TERM_EXTENSION"` → rejected (has its own preset).
5. PURCHASE_ORDER `{ vendor: "Acme Servers Inc.", equipment: "8 x GPU server, model X", price: "412500.00", currency: "USD", poReference: "PO-17", managerName: "Octagon Compute LLC", purchasingAgentName: "Octagon Compute LLC" }` with `companyName: "OCTAGON GPU I LLC"` → 7 locked clauses; clause 2 equals `Purchase order. Vendor: Acme Servers Inc. Equipment: 8 x GPU server, model X. Price: USD 412,500.00. Reference: PO-17.` (one trailing full stop is stripped from each inserted value, see the rule above); clauses 3–5 contain the phrases `solely as agent and nominee`, `no beneficial interest`, `in trust for the LLC`, `assigns to the LLC its rights under the purchase order to the extent assignable`; the last clause is `Approval required: the approval of the Manager.`
6. TERM_EXTENSION `{ currentTargetSaleDate: "2031-11-30", extensionNumber: 1 }` → title `Extension of the operating term to November 30, 2032`; clause 2 mentions `November 30, 2031` and `November 30, 2032`; `currentTargetSaleDate: "2032-02-29"` → proposed `February 28, 2033`.
7. `behaviour("TERM_EXTENSION")` → `{ hasBallots: true, fixedWindowDays: 30, deemedAgainstAtClose: true, allRecipientsRequired: true, copyToMembersBusinessDays: null, … }`; `behaviour("PURCHASE_ORDER").hasBallots === false`.
8. Every key of `MATTERS` has at least one requirement and a non-empty section; every `ResolutionType` returns a non-empty locked-clause list for valid params.

**Acceptance.** Tests pass; no database, no `@/` import.

---

### G6 — Server core: tokens, snapshot, tally and transition, events, recipients

**Goal.** The small server library every resolution procedure and job uses. All decision logic is pure and tested; database wrappers are thin.

**Prerequisites.** G1, G3, G4, G5; FOUNDATION F6 (`getMemberPositions`); ECONOMICS E7 (`getSuspendedUnits`) and E1 (`business-days.ts`). If a sibling function is not merged yet, write the adapter `positions.ts` below against the signatures in E1/E2 and mark the package "integration pending"; nothing else in governance imports sibling code for units.

**Files.**

- Create (pure, tested): `src/lib/governance/token-payload.ts`, `token-payload.test.ts`, `src/lib/governance/resolution-core.ts`, `resolution-core.test.ts`.
- Create (server): `src/server/governance/hash.ts`, `tokens.ts`, `positions.ts`, `snapshot.ts`, `tally.ts`, `events.ts`, `recipients.ts`, `resolutions.ts`. Each starts with `import "server-only";`.

**`token-payload.ts`.**

```ts
import { z } from "zod";
export const BallotTokenPayload = z.strictObject({
  p: z.literal("rb"), b: z.string().min(1).max(64), v: z.number().int().min(1), exp: z.number().int(),
});
export const ReportTokenPayload = z.strictObject({
  p: z.literal("mr"), r: z.string().min(1).max(64), v: z.number().int().min(1), exp: z.number().int(),
});
export function parseBallotPayload(payload: unknown): { ballotId: string; version: number } | null;
export function parseReportPayload(payload: unknown): { recipientId: string; version: number } | null;
/** min(closesAt + 60 days, sentAt + 400 days); sentAt + 400 days when closesAt is null. */
export function ballotTokenExpiry(sentAt: Date, closesAt: Date | null): Date;
/** sentAt + 400 days. */
export function reportTokenExpiry(sentAt: Date): Date;
```

Tests: (1) `{ companyId, updateId, publicId, recipientId }` (update token) → null; (2) `{ id, rec }` (e-sign token) → null; (3) `{ companyId, dataRoomId, recipientId }` → null; (4) a report payload passed to `parseBallotPayload` → null and vice versa; (5) valid payload plus an extra key → null; (6) `v: 0` → null; (7) valid → parsed; (8) `ballotTokenExpiry(new Date("2027-01-01T00:00:00Z"), new Date("2027-01-31T06:59:59.999Z"))` → `2027-04-01T06:59:59.999Z`; (9) `ballotTokenExpiry(sentAt, null)` → `2028-02-05T00:00:00.000Z` for `sentAt = 2027-01-01T00:00:00Z`.

**`tokens.ts`.**

```ts
export async function signBallotToken(b: { id: string; tokenVersion: number; tokenExpiresAt: Date }): Promise<string>;
// = encode({ p: "rb", b: b.id, v: b.tokenVersion, exp: Math.floor(b.tokenExpiresAt.getTime() / 1000) })  (encode from "@/lib/jwt")
export async function verifyBallotToken(token: string): Promise<{ ballotId: string; version: number } | null>;
// try { parseBallotPayload((await decode(token)).payload) } catch { return null }   (decode verifies signature AND exp)
export async function signReportToken(r: { id: string; tokenVersion: number; tokenExpiresAt: Date }): Promise<string>;
export async function verifyReportToken(token: string): Promise<{ recipientId: string; version: number } | null>;
export function ballotUrl(token: string): string;  // `${env.NEXT_PUBLIC_BASE_URL}/ballots/${token}`
export function reportUrl(token: string): string;  // `${env.NEXT_PUBLIC_BASE_URL}/member-reports/${token}`
```

Because the token is derived from `(id, tokenVersion, tokenExpiresAt)`, a reminder re-signs the SAME link (older emails keep working) and "replace link" is `tokenVersion + 1` (every older link dies at once).

**`hash.ts`.** `export function sha256Hex(input: string): string` using `createHash("sha256")` from `node:crypto`.

**`resolution-core.ts` (pure).**

```ts
export interface StakeholderRow { id: string; name: string; email: string; noticeEmail: string | null; memberStatus: string; isInsider: boolean }
export interface UnitPosition { stakeholderId: string; unitClassId: string; unitClassKind: "PREFERRED" | "COMMON"; units: string; suspended: boolean }
export interface SnapshotEntryDraft {
  stakeholderId: string; name: string; email: string; memberStatus: string;
  isMember: boolean; isInsider: boolean; isSuspended: boolean; preferredUnits: string; commonUnits: string;
}
export function buildSnapshotEntries(stakeholders: StakeholderRow[], positions: UnitPosition[]): {
  entries: SnapshotEntryDraft[]; preferredIssued: string; preferredOutstanding: string; disinterestedOutstanding: string;
};
/** Stakeholder ids that must/may receive a ballot for these requirements. */
export function eligibleRecipients(entries: SnapshotEntryDraft[], requirements: Requirement[]): {
  stakeholderId: string; countsPreferred: boolean; countsDisinterested: boolean; consentOnly: boolean;
}[];
export type Transition = "EFFECTIVE" | "FAILED" | "EXPIRED" | null;
export function decideTransition(input: {
  status: string; closesAt: Date | null; now: Date; outcome: "PASSED" | "PENDING" | "CANNOT_PASS"; deemedAgainstAtClose: boolean;
}): Transition;
/** "R-2026-003" given the codes already used by the company. */
export function nextReferenceCode(existing: string[], year: number): string;
```

Rules:
- `buildSnapshotEntries`: one entry per stakeholder that has `memberStatus` `MEMBER` or `FINANCIAL_INTEREST_ONLY`, or any position with units > 0. `preferredUnits`/`commonUnits` = sum of that stakeholder's positions by kind (sum in micro-units with `toMicro`/`fromMicro` from `../llc/voting`). `isMember = memberStatus === "MEMBER"`. `isSuspended` = any PREFERRED position has `suspended: true`. `email = noticeEmail ?? email`. Positions for an unknown stakeholder → throw (data integrity). Totals: `preferredIssued` = sum of all `preferredUnits`; `preferredOutstanding = denominator(entries, "PREFERRED_MAJORITY")`; `disinterestedOutstanding = denominator(entries, "DISINTERESTED_MAJORITY")`.
- `eligibleRecipients`: a stakeholder is included when `isEligible` (G1) for at least one `UNIT_VOTE` basis in the requirements, or it is named by an `AFFECTED_MEMBER_CONSENT`. `countsPreferred` = eligible for a preferred basis AND the requirements contain a preferred basis; `countsDisinterested` likewise; `consentOnly` = named consent and both flags false. Sorted by name.
- `decideTransition`: `status !== "SENT"` → null; `PASSED` → `EFFECTIVE`; `CANNOT_PASS` → `FAILED`; `PENDING` with `closesAt && now > closesAt` → `deemedAgainstAtClose ? "FAILED" : "EXPIRED"`; else null.
- `nextReferenceCode`: highest existing sequence for `R-<year>-NNN` plus one, zero-padded to 3 digits; `R-2026-001` when none.

Tests (`resolution-core.test.ts`): (1) the G1 `REG` built from stakeholders + positions (dan as two positions 50.000000 + 0.500000; sam with `suspended: true`; fay `FINANCIAL_INTEREST_ONLY`; octagon with a COMMON position 100.000000; a PROSPECT without units is omitted) → totals `1325.000000`, `1050.000000`, `900.500000`; (2) `eligibleRecipients` for `[UNIT_VOTE DISINTERESTED_MAJORITY]` → alice, bob, carol, dan only; for `[SUPERMAJORITY, DISINTERESTED_70]` → six stakeholders, schoen/reidTrust have `countsDisinterested: false`; with `AFFECTED_MEMBER_CONSENT(sam)` → sam added with `consentOnly: true`; (3) `decideTransition` table: PASSED→EFFECTIVE; CANNOT_PASS→FAILED; PENDING before close→null; PENDING after close→EXPIRED, or FAILED when `deemedAgainstAtClose`; status DRAFT/EFFECTIVE→null; (4) `nextReferenceCode(["R-2026-001", "R-2026-009", "R-2025-030"], 2026)` → `R-2026-010`; `([], 2027)` → `R-2027-001`.

**`positions.ts` (the only place governance reads units).** `loadUnitPositions(tx, companyId, asOf: Ymd): Promise<UnitPosition[]>`: (1) `rows = await getMemberPositions(tx, companyId, { asOf })` (FOUNDATION `src/server/llc/positions.ts`; `asOf` is INCLUSIVE: receipts applied on that calendar day count; completed transfers are folded in by G16); (2) `{ suspended } = await getSuspendedUnits(tx, companyId, asOf)` (ECONOMICS `src/server/llc/economics`; a Member is suspended when it has a declared, uncured default with `dueOn < asOf`); (3) return one `UnitPosition` per row with `units` from the row (already a 6-decimal string), `unitClassKind = row.kind`, and `suspended = row.kind === "PREFERRED" && suspendedIds.has(row.stakeholderId)`. Rows with zero units are kept (they are harmless). `undeclaredOverdue` from ECONOMICS is returned alongside as `warnings`; for a resolution with ballots `resolution.preview` returns each as a blocker and `send` refuses: "{name} has an overdue Balance with no declared default. Declare the default (Section 4.9) or record the payment before sending." (R13, M5).

**`snapshot.ts`.** `takeRecordSnapshot(tx, { companyId, recordDate: Ymd, purpose, takenById })`: takes `lockCompanyLedgerAndUnitClasses` (a no-op when the caller already holds it, as `resolution.send` does from its first statement), then loads `tx.stakeholder.findMany({ where: { companyId }, select: { id, name, email, noticeEmail, memberStatus, isInsider } })`, calls `loadUnitPositions(tx, companyId, recordDate)`, runs `buildSnapshotEntries`, inserts `RecordSnapshot` + `createMany` entries, returns both. Insert only (C3.1).

**`resolutions.ts`** (exported for ECONOMICS, E3): `assertResolutionOfCompany(tx, companyId, resolutionId): Promise<{ id: string; type: string; status: string; referenceCode: string | null }>` — `findFirst({ where: { id: resolutionId, companyId } })`, `NOT_FOUND` when missing.

**`events.ts`.** `RESOLUTION_EVENT_TYPES = ["SENT", "MANAGER_SIGNED", "COMMON_MEMBER_SIGNED", "BALLOT_ISSUED", "INVITE_EMAILED", "REMINDER_EMAILED", "LINK_REPLACED", "LINK_REVOKED", "BALLOT_VIEWED", "BALLOT_SUBMITTED", "BALLOT_DEEMED", "REQUIREMENT_SATISFIED", "EFFECTIVE", "FAILED", "EXPIRED", "WITHDRAWN", "PDF_FILED", "RESULT_EMAILED", "COPY_EMAILED", "COPY_DELIVERED", "MANAGER_NOTIFIED"] as const`. `recordEvent(tx, { resolutionId, companyId, ballotId?, type, actorType, actorId?, summary, ip?, userAgent? })`. `recordEventOnce(tx, { …, dedupeKey })` → inserts and returns `true`; on Prisma error code `P2002` returns `false`. `hasEvent(tx, resolutionId, dedupeKey)`.

**`recipients.ts`.**
- `listCurrentMembers(tx, companyId, today: Ymd)`: stakeholders with `memberStatus = "MEMBER"` whose total units (Preferred + Common, from `loadUnitPositions(tx, companyId, today)`) are > 0 → `{ stakeholderId, name, email: noticeEmail ?? email, preferredUnits, commonUnits }[]` sorted by name (R22; a Member who transferred all its Units stops receiving reports).
- `listManagerUsers(tx, companyId)`: `tx.member.findMany({ where: { companyId, status: "ACTIVE", role: "ADMIN" }, select: { id: true, user: { select: { name: true, email: true } } } })` filtered to rows with an email.

**`tally.ts`.**

```ts
export async function lockResolution(tx: PrismaTransactionalClient, resolutionId: string): Promise<void>;
// await tx.$queryRaw`SELECT "id" FROM "Resolution" WHERE "id" = ${resolutionId} FOR UPDATE`;
export async function loadEvaluation(tx, resolutionId: string): Promise<{
  resolution; requirements; ballots; holders: HolderSnapshot[]; votes: CastVote[]; approvals: ApprovalState; evaluation: Evaluation;
}>;
export interface TransitionResult { resolutionId: string; companyId: string; to: "EFFECTIVE" | "FAILED" | "EXPIRED" }
export async function evaluateAndTransition(
  tx, resolutionId: string, now: Date, actor: { type: "user" | "stakeholder" | "system"; id: string | null; ip: string; userAgent: string },
): Promise<TransitionResult | null>;
```

`evaluateAndTransition` algorithm (must be called inside a transaction):
1. `lockResolution`. Reload the resolution with requirements, ballots and snapshot entries. If `status !== "SENT"` return null.
2. `holders` = snapshot entries mapped to `HolderSnapshot`; `votes` = ballots with `submittedAt != null` → `{ stakeholderId, choice }`; `approvals` = `{ managerApproved: some MANAGER_APPROVAL requirement has approvedAt, commonMemberApproved: likewise }`; requirements mapped to G1 `Requirement`. `ev = evaluate(...)`.
3. If `ev.outcome === "PENDING"` and `closesAt` and `now > closesAt` and `behaviour(type).deemedAgainstAtClose` (R14): for every ballot with `submittedAt === null` and (`countsPreferred` or `countsDisinterested`): write-once update `{ choice: "AGAINST", deemed: true, submittedAt: closesAt, bodyHash: frozenHash }`; `recordEvent BALLOT_DEEMED` (system) and `Audit "ballot.deemed"`. Recompute `ev`.
4. For each requirement whose result is PASSED and `satisfiedAt` is null: set `satisfiedAt = now` (and `forUnitsAtClose` = tally `for` for UNIT_VOTE); `recordEvent REQUIREMENT_SATISFIED`.
5. `t = decideTransition({ status, closesAt, now, outcome: ev.outcome, deemedAgainstAtClose })`. If null return null.
6. Update the resolution: `EFFECTIVE` → `{ status, effectiveAt: now }`; `FAILED`/`EXPIRED` → `{ status, closedAt: now }`. Set `forUnitsAtClose` on every UNIT_VOTE requirement still null. `recordEvent` of the same name; `Audit` `resolution.effective|failed|expired` with the given actor.
7. If `t === "EFFECTIVE"` and `behaviour(type).copyToMembersBusinessDays` is `n`: `copyDueOn = addBusinessDays(todayInZone(now), n)` (ECONOMICS `business-days.ts`); store it; upsert `ComplianceDeadline` by `(companyId, dedupeKey = "PO_RESOLUTION_COPY:" + resolutionId)` with `ruleKey "PO_RESOLUTION_COPY"`, title `Deliver a copy of {referenceCode} to the Members`, section `6.16(i)(B)`, `source "RESOLUTION"`, `sourceType "RESOLUTION"`, `sourceId`.
8. Return `{ resolutionId, companyId, to: t }`. The CALLER, after the transaction commits, calls `emitResolutionFinalize(resolutionId)` (G9).

The row lock in step 1 guarantees that two ballots submitted at the same moment cannot both cross the threshold or both miss it: the second transaction waits, reloads, and sees the first vote.

**Acceptance.** Pure tests pass. `tsc` passes. No file in `src/lib/governance` imports from `@/`.

---

### G9 — Executed PDF, filing, emails, finalize and notice jobs

(Executed before G7 because G7 and G8 import its job emitters.)

**Goal.** Produce the executed resolution PDF with signature and tally pages, file it in Documents, and send every resolution email through FOUNDATION's logging `sendMail`, idempotently.

**Prerequisites.** G2, G5, G6; FOUNDATION F10 (`sendMail` with `EmailLog`, E1). Model files to read first: `src/jobs/share-update-email.ts` (job shape), `src/emails/ShareUpdateEmail.tsx` (email markup), `src/pdf-templates/audit-log-template.tsx` (React-PDF usage; do not copy its `Font.register`).

**Files.** Create `src/pdf-templates/governance/rich-doc-pdf.tsx`, `src/pdf-templates/governance/resolution-pdf.tsx`, `src/server/governance/filing.ts`, `src/server/governance/resolution-pdf-data.ts`, `src/emails/BallotInviteEmail.tsx`, `src/emails/ResolutionNoticeEmail.tsx`, `src/jobs/governance-ballot-email.ts`, `src/jobs/governance-resolution-notice.ts`, `src/jobs/governance-resolution-finalize.ts`, `src/trpc/routers/resolution-router/procedures/resend-notice.ts`. Edit `src/jobs/register.ts` (three `queueManager.register` lines) and `src/trpc/routers/resolution-router/router.ts` (key `resendNotice`).

**PDF.**

- Fonts: only the built-in families `Helvetica`, `Helvetica-Bold`, `Helvetica-Oblique`. No `Font.register`, no network access at render time. Page size LETTER, margins 54 pt, body 10.5 pt.
- `rich-doc-pdf.tsx`: `export function RichDocPdf({ doc }: { doc: RichDoc })` mapping `p`/`h`/`li`/`quote`/`hr` to `<Text>`/`<View>`; bold → `Helvetica-Bold`, italic → `Helvetica-Oblique`, underline/strike → `textDecoration`, code → `Courier`; a link renders its text followed by ` (<href>)`; list markers `•`, `{n}.`, `[ ]`/`[x]`; indent 14 pt per level.
- `resolution-pdf.tsx`: `export function ResolutionPdf({ data }: { data: ResolutionPdfData })` and `export async function renderResolutionPdf(data: ResolutionPdfData): Promise<Buffer>` (`renderToBuffer`). Sections in order:
  1. Header: company name (bold, upper case as stored), `kindLabel`, title, then a two-column facts table: Reference, Record date, Sent, Effective (date-times formatted `MMMM D, YYYY h:mm A z` in `GOVERNANCE_TIME_ZONE`, and "—" when null).
  2. Body: `RichDocPdf`, then the locked clauses as a numbered list.
  3. "Signatures": (a) one line per `MANAGER_APPROVAL`/`COMMON_MEMBER_APPROVAL` requirement with `approvedAt`: role, `approverName`, `approverCapacity`, signed-at, the words "Signed electronically"; (b) for resolutions with ballots, a table of ballots with `choice = FOR` and `deemed = false`, sorted by name: Member | Signed by (typed name, capacity) | Preferred Units | Signed at.
  4. "Tally": per UNIT_VOTE requirement one block: basis label and section; `Outstanding units entitled to vote`; `Required` (minimum units and the percentage wording of G5); `For` (units and percentage with two decimals, truncated not rounded); `Against`; `Abstain`; `No response`; `Deemed against (Section 2.5)` when > 0; `Result: Approved | Not approved`. Against/Abstain/No-response are AGGREGATES only — individual non-consenting Members are not named in the PDF (they remain visible to Manager users in the app).
  5. Footer on every page: `{referenceCode} · document hash {first 16 hex of frozenHash} · page {n} of {N}` and, on the last page, `Executed electronically under Sections 6.12 and 13.9 of the Operating Agreement. Filed with the books and records of the LLC under Section 8.1(e).`
  - IP addresses and user agents are NOT printed (they are in the app and in the evidence export, G8).
- `resolution-pdf-data.ts`: `buildResolutionPdfData(tx, resolutionId): Promise<ResolutionPdfData>` loads the resolution, requirements, ballots, snapshot, company and computes tallies with `tallyBasis`. `ResolutionPdfData` is a plain serialisable object (strings and arrays only).

**`filing.ts`.**

```ts
export async function fileGeneratedPdf(input: {
  company: { id: string; publicId: string };
  buffer: Buffer;
  fileName: string;                 // sanitised: remove / \ : * ? " < > | and control chars, max 120 chars, ends ".pdf"
  keyPrefix: "resolutions" | "member-reports";
  tag: TAG;
  categories: { recordCategory: BooksRecordCategoryEnum; recordYear: number | null }[]; // one Document per entry, same Bucket
  jobName: string;
}): Promise<{ documentIds: string[]; bucketId: string; key: string }>;
```

Steps: `const file = new File([input.buffer], input.fileName, { type: "application/pdf" })`; `uploadFile(file, { identifier: input.company.id, keyPrefix })` from `@/server/file-uploads`; then in one transaction: `bucket.create({ data: { name, key, mimeType: "application/pdf", size: buffer.byteLength, tags: [tag] } })` (do NOT call `createBucketHandler`, A4), one `document.create({ data: { companyId, publicId: generatePublicId(), name, bucketId, recordCategory, recordYear } })` per category, and one `Audit "document.created"` per document with the system actor.

**Jobs** (all three follow `src/jobs/share-update-email.ts`; each exports `<name>Job` and `<name>Worker`; register the workers in `src/jobs/register.ts`).

Queue policy: the three email/finalize queues are created with pg-boss policy `stately` (one job per `singletonKey` in each of created / retry / active), so a duplicate emit while the first is waiting is dropped; the other queues of the app keep the default policy. pg-boss applies a policy only at creation: an existing queue with another policy is logged at start-up and must be deleted while empty to take it. No policy de-duplicates after completion, so every email is ALSO claimed (below).

Delivery semantics (state in a code comment): AT MOST ONCE per dedupe key. Each email job first CLAIMS its key — inserts its event (`INVITE_EMAILED`, `REMINDER_EMAILED`, `RESULT_EMAILED`, `COPY_EMAILED`, `MANAGER_NOTIFIED`, `ADDRESS_CHANGE_NOTICE_EMAILED`) with the unique `dedupeKey` in its own committed statement — and only the claimant sends (`sendOnce` in `events.ts`). A failed send deletes the claim and rethrows, so the pg-boss retry can send. Ballot invites and reminders carry the loaded link version in their key and, after claiming, re-read the ballot (`sendOnce`'s `stillCurrent`): if the link was replaced or revoked, or the ballot submitted, since the job loaded it, the claim is deleted and nothing is sent (the newer link's job has its own key). A crash between claim and send leaves no email; recovery is manual and always uses a fresh key: `resolution.remind` (an invite claimed more than 10 minutes ago with `invitedAt` still null is re-queued as `seq "r<n>"`) and `resolution.resendNotice`.

1. `governance.ballot-email` — data `{ ballotId: string, kind: "INVITE" | "REMINDER" | "ADDRESS_CHANGED", seq: number | string, previousEmail?: string }` (schema `z.union([z.number().int(), z.string().max(20)])`; manual sends use numbers, automatic reminders use `"auto-7"` / `"auto-2"`, invites re-queued by `remind` use `"r<n>"`). INVITE / REMINDER: load ballot + resolution + company. Return without sending when: resolution `status !== "SENT"`; ballot `submittedAt` set; `tokenRevokedAt` set. `dedupeKey = "ballot-email:" + ballotId + ":" + kind + ":" + seq + ":v" + tokenVersion`; claim it (above). Sign the token, render `BallotInviteEmail` (frozen title), `sendMail({ to: ballot.email, subject, html, headers: { "X-From-Name": company.name } }, { kind: "resolution.ballot", companyId, stakeholderId, relatedType: "resolution", relatedId: resolutionId })` and keep the returned `emailLogId`. Then in a transaction: INVITE → `invitedAt = now` (if null), `inviteEmailLogId`; REMINDER → `lastReminderAt = now`, `reminderCount + 1`; `Audit "ballot.issued" | "ballot.reminded"` (system actor). Export `emitBallotEmails(items: { ballotId; kind; seq }[])` using `bulkEmit` with `singletonKey = "ballot-email-" + ballotId + "-" + kind + "-" + seq`. ADDRESS_CHANGED (H1, emitted by `replaceBallotLink` when the email changes): sends `BallotAddressChangedEmail` ("the ballot link for "{title}" was re-issued to a different address; contact the Manager if you did not ask for this", NO link) to `previousEmail` and to the stakeholder's `noticeEmail ?? email` on file, each once, never to the new ballot address; one claim per address (`"ballot-email:" + ballotId + ":ADDRESS_CHANGED:" + seq + ":" + address`), `kind: "resolution.ballot-address-changed"`; sent whatever the resolution's status is now.
2. `governance.resolution-notice` — data `{ resolutionId, stakeholderId, kind: "RESULT" | "PO_COPY", seq: number }`. Handler: `dedupeKey = "notice:" + kind + ":" + stakeholderId + ":" + seq`. Load the resolution, the snapshot entry (name, email) and the stakeholder's ballot if any; the recipient address is the ballot's CURRENT `email` when there is a ballot (it may have been replaced after send), else the entry's (M2). Title and (for PO_COPY) vendor, equipment, price come from `frozenContent`. If `executedDocumentId` is set: load the document's bucket key, check `isKeyInCompanyNamespace`, `getFileFromS3(key)`, attach as `{ filename: bucket.name, content: Buffer.from(bytes), contentType: "application/pdf" }`. The notice never carries a ballot link (it is only sent for a closed resolution; M2). Claim `RESULT_EMAILED | COPY_EMAILED` with `dedupeKey`, then send with `kind` `"resolution.result"` or `"resolution.copy"` (same `relatedType`/`relatedId` as above; the PDF goes in `options.attachments`). For `PO_COPY`: afterwards, in a transaction with `lockResolution`, if `copyDeliveredAt` is null and every snapshot entry with `isMember` has a `COPY_EMAILED` event AND a `SENT` `resolution.copy` EmailLog (the event alone is only the claim) → set `copyDeliveredAt = now`, `recordEvent COPY_DELIVERED`, `Audit "resolution.copy-delivered"`, and set the `PO_RESOLUTION_COPY:<id>` deadline to `DONE` with `satisfiedByType "RESOLUTION"`, `satisfiedById`, `completedAt = now`.
3. `governance.resolution-finalize` — data `{ resolutionId }`. Export `emitResolutionFinalize(resolutionId)` = `emit({ resolutionId }, { singletonKey: "resolution-finalize-" + resolutionId })` (do not add a timestamp to the key: that would defeat de-duplication). The handler is idempotent:
   - Load the resolution. If `status` is `DRAFT` or `SENT` → return.
   - If `status === "EFFECTIVE"` and `executedDocumentId` is null, in ONE transaction (timeout 120 s): `lockResolution`, re-read and return if `executedDocumentId` is now set; `buildResolutionPdfData` → `renderResolutionPdf` → `fileGeneratedPdf(input, tx)` (uploads, then creates the Bucket/Document rows in `tx`) with `fileName = "{referenceCode} {title}.pdf"`, `keyPrefix "resolutions"`, `tag TAG.RESOLUTION`, categories `[{ CONSENTS_AND_MINUTES, year of effectiveAt in GOVERNANCE_TIME_ZONE }]` plus `{ ARTICLES_AND_AGREEMENT, year }` when `behaviour(type).alsoFileUnder` is set. Then set `executedDocumentId = documentIds[0]` (guarded single-row write); `recordEvent PDF_FILED`; `Audit "resolution.filed"`; commit. Two runs serialize on the lock and file one Document; a crash before commit leaves at most an orphaned object with no rows (acceptable), never a second Document. The PDF's Member signature table is followed by one line per ballot whose email was changed after send (names only, no addresses: the PDF goes to every Member; H1).
   - Notices: recipients = (EFFECTIVE) every snapshot entry with `isMember`; (FAILED / EXPIRED / WITHDRAWN) every stakeholder that has a ballot, invited or not (L2). Kind = `PO_COPY` when `type === "PURCHASE_ORDER"`, else `RESULT`. `bulkEmit` one `resolution-notice` job per recipient with `seq: 0` and `singletonKey = "resolution-notice-" + resolutionId + "-" + stakeholderId + "-" + kind + "-0"`.
   - Manager users: for each `listManagerUsers` row, claim `MANAGER_NOTIFIED` with `dedupeKey "manager-notified:" + memberId` and send the manager email below (`kind: "resolution.manager"`). A failed send releases its claim; the others are still sent; then the job fails, and its retry (or the sweep) notifies only the Managers left (L3).
   - `resultNotifiedAt = now` if null, only once every step above succeeded. Until then the sweep re-emits this job (H2).
- Emits after commit (H2): every procedure that commits a transition or a send (`ballot.submit`, `resolution.send`, `approve`, `withdraw`, the lazy close of reads, `replaceBallotLink`) catches and logs a failed emit and still returns success (`emitAfterCommit`); the committed state is the truth and is recovered by the sweep (finalize) or `remind` (invites).

**`resendNotice` procedure.** `resolution.resendNotice` — `withAccessControl`, `governance: update`; input `{ publicId: string, stakeholderId: string }`; resolution loaded by `{ publicId, companyId }` with status in `EFFECTIVE, FAILED, EXPIRED, WITHDRAWN`; the stakeholder must be a snapshot entry of this resolution; `seq` = 1 + the highest seq among that stakeholder's notice events (claims included, so it is always a fresh key); emits one `resolution-notice` job; returns `{ success: true }`. Inputs bounded (64 characters each, strict object). Audit: none beyond the job's event.

**Email copy.** All emails: React Email components styled like `ShareUpdateEmail.tsx`; first name = first word of the recipient name or "there"; footer line `This message is a notice from {company} sent to the email address on file for you under Section 13.6 of the Operating Agreement.` Dates in `GOVERNANCE_TIME_ZONE`, long form.

- Ballot invite — subject `Action requested: {title} — {company}`. Body: `Hello {firstName},` / `{company} asks for your written consent on the following matter:` / **`{title}`** `({referenceCode})` / `Your Preferred Units of record on {recordDate}: {units}` / `Please respond by {closesAt}.` / (TERM_EXTENSION only) `Under Section 2.5 of the Operating Agreement, a Preferred Member who does not respond within 30 days is deemed to have voted against the extension.` / button `Review and respond` → ballot URL / `This link is personal to you. Please do not forward it.`
- Ballot reminder — subject `Reminder: response due {closesAt date} — {title}`. Body as the invite with the first line `This is a reminder that your response has not yet been received.`
- Result — subject `Result: {title} — {Approved and effective | Not approved | Closed without approval | Withdrawn}` (EFFECTIVE / FAILED / EXPIRED / WITHDRAWN). Body: `Hello {firstName},` / one sentence by status: `The matter below was approved and became effective on {effectiveAt}.` | `The matter below did not receive the required approval.` | `The response period for the matter below ended on {closedAt} without the required approval.` | `The Manager withdrew the matter below on {closedAt}.` + (WITHDRAWN) `Reason: {withdrawnReason}` / **`{title}`** `({referenceCode})` / for each UNIT_VOTE requirement one line `{basis label}: {for} of {denominator} units in favour ({percent}%); required: {percentage wording}.` / (EFFECTIVE) `The executed written consent is attached and has been filed with the books and records of the LLC.` / (if the recipient has a ballot) link `View the resolution and your response`.
- PO copy — subject `Manager resolution {referenceCode}: purchase order — {vendor}`. Body: `Hello {firstName},` / `Under Section 6.16(i) of the Operating Agreement, a copy of the Manager's written resolution for the following purchase order is attached.` / `Vendor: {vendor}` / `Equipment: {equipment}` / `Price: {currency} {price}` / `Signed on {effectiveAt} by {approverName}, {approverCapacity}.` / `No action is required.`
- Manager notification — subject `Resolution {status label}: {title}`. Body: the result sentence, the tally lines, and a link to `/{companyPublicId}/resolutions/{publicId}`.

**Acceptance.**
- A unit test (`src/pdf-templates/governance/resolution-pdf.test.ts`, relative imports only) renders `ResolutionPdfData` fixtures for (a) a PO resolution and (b) the G1 case-29 amendment and asserts the result is a Buffer starting with `%PDF-` and larger than 1 kB. If `@react-pdf/renderer` cannot run under vitest, replace this with a script check described in the package report and keep the fixture.
- Running the finalize job twice for the same EFFECTIVE resolution creates exactly one `Document` per category and sends each recipient exactly one notice.
- The filed `Bucket.size` equals the PDF byte length; its key starts with `{company.id}/resolutions-`.
- No request to `fonts.gstatic.com` is made during rendering.

**Do not touch.** `src/server/esign.ts`, `src/jobs/esign-*.ts`, `src/pdf-templates/audit-log-template.tsx`, `src/server/mailer.ts`.

---

### G7 — Resolution router: drafts, preview, send, approve, withdraw

**Goal.** Everything a Manager user does to a resolution up to and including sending it.

**Prerequisites.** G2, G5, G6, G9.

**Files.** `src/trpc/routers/resolution-router/schema.ts`, `router.ts`, `procedures/{list,get,preview,create,update,delete,clone,send,approve,withdraw}.ts`.

All procedures: `withAccessControl`; `companyId = ctx.membership.companyId`; `loadLlcCompany` first. Zod inputs use `.strict()` objects.

| Procedure | RBAC | Input | Behaviour and output | Audit |
|---|---|---|---|---|
| `resolution.list` (query) | `governance: read` | `{ statuses?: ResolutionStatusEnum[] }` | Rows of the company ordered by `createdAt desc`: `{ publicId, referenceCode, title, type, status, sentAt, closesAt, effectiveAt, closedAt, requirementSummaries: { label, forBps, passed }[] }`. Before returning, for each SENT row with `closesAt < now` run `evaluateAndTransition` in its own transaction (lazy close) and emit finalize for transitions. | — |
| `resolution.get` (query) | `governance: read` | `{ publicId }` | Lazy close first. Returns `{ resolution (all scalar fields), preset: behaviour(type), requirements: (row + tally: BasisTally | null + state)[], ballots: (all columns incl. submitIp, submitUserAgent; plus linkState: "ACTIVE" | "REVOKED" | "EXPIRED")[], snapshot: { recordDate, totals, entries }, events (desc), executedDocument: { publicId, name } | null, starter: { doc, lockedClauses } }`. For DRAFT: `lockedClauses` and requirements are computed live from `params` (not stored rows). | — |
| `resolution.preview` (query) | `governance: read` | `{ type, params: unknown, recordDate: Ymd }` | Validates params; builds requirements; builds (does NOT store) snapshot entries as of `recordDate`; returns `{ requirements: { label, section, denominator, minimumFor }[], recipients: { stakeholderId, name, email, preferredUnits, countsPreferred, countsDisinterested, consentOnly }[], excluded: { stakeholderId, name, preferredUnits, reason: "SUSPENDED" | "FINANCIAL_INTEREST_ONLY" | "INSIDER" | "NO_PREFERRED_UNITS" }[], warnings: string[] }`. Warnings: zero denominator; recipient without email; AUDIT_CALL already effective this fiscal year (R19); recordDate in the future. | — |
| `resolution.create` (mutation) | `governance: create` | `{ type, params: unknown }` | Validate params with `paramsSchema(type)`; for AMENDMENT `assertCompanyOwns({ stakeholderIds: affectedMemberIds })`; `title = buildTitle`, `body` = BlockNote blocks made from `buildStarterBody` (paragraph/heading blocks with one text inline each); insert DRAFT with `publicId = generatePublicId()`, `authorId = ctx.membership.memberId`, `matterKey`. Returns `{ publicId }`. | `resolution.created` |
| `resolution.update` (mutation) | `governance: update` | `{ publicId, title: string (1–200), params: unknown, body: unknown }` | DRAFT only (else `BAD_REQUEST "Only a draft can be edited."`). Re-validate params; `normalizeBlocks(body)` must be ok (else `BAD_REQUEST` with the joined errors); store `title, params, body, matterKey`. Returns `{ success: true }`. | `resolution.updated` |
| `resolution.delete` (mutation) | `governance: delete` | `{ publicId }` | DRAFT only; hard delete. | `resolution.deleted` |
| `resolution.options` (query) | `governance: read` | `{ types?: ResolutionTypeEnum[], statuses?: ResolutionStatusEnum[] (default `["EFFECTIVE"]`) }` | For pickers in other areas (ECONOMICS links payments, loans and term extensions to a resolution): `{ id, publicId, referenceCode, title, type, matterKey, status, effectiveAt }[]`, newest first, max 200. | — |
| `resolution.clone` (mutation) | `governance: create` | `{ publicId }` | Any status. New DRAFT with the same `type, params, body, title` (prefix `Copy of ` only when the source is DRAFT), `clonedFromId`. Returns `{ publicId }`. | `resolution.created` |
| `resolution.send` (mutation) | `governance: update` | see below | see below | `resolution.sent`, `resolution.approved` (per signature), `ballot.issued` is written by the email job |
| `resolution.approve` (mutation) | `governance: update` | `{ publicId, role: "COMMON_MEMBER", signerName (2–200), signerCapacity (2–200), bodyHash }` | SENT only; the resolution must have an unsigned `COMMON_MEMBER_APPROVAL` requirement; `bodyHash === frozenHash` else `CONFLICT`; write the approval columns once (guarded single-row write `where approvedAt: null`); `recordEvent COMMON_MEMBER_SIGNED` with ip/ua (IP bounded to 100 characters, user agent to 1000, as in `send` and the ballot router; M3); `evaluateAndTransition`; emit finalize after commit. | `resolution.approved` |
| `resolution.withdraw` (mutation) | `governance: update` | `{ publicId, reason: string (1–500) }` | In a transaction with `lockResolution`: SENT only (else `BAD_REQUEST "Only a sent resolution that is not yet effective can be withdrawn."`); set `WITHDRAWN, closedAt, withdrawnReason`; `recordEvent WITHDRAWN`; emit finalize after commit (notifies ballot recipients). | `resolution.withdrawn` |

**`resolution.send` in full.**

Input:

```ts
z.object({
  publicId: z.string(),
  recordDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  closesOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // ignored for fixed-window and no-ballot types
  recipientStakeholderIds: z.array(z.string()).max(500).optional(), // default: all eligible
  autoReminders: z.boolean().default(true),
  managerSignature: z.object({ signerName: z.string().trim().min(2).max(200), signerCapacity: z.string().trim().min(2).max(200) }).optional(),
  commonMemberSignature: z.object({ signerName: z.string().trim().min(2).max(200), signerCapacity: z.string().trim().min(2).max(200) }).optional(),
}).strict()
```

Steps, all in one transaction (`now = new Date()` taken once):
0. ECONOMICS' `lockCompanyLedgerAndUnitClasses(tx, companyId)` FIRST (company ledger lock, then the Preferred and Common unit-class row locks), before any other lock: the snapshot in step 6 reads member status and units in two statements, and admissions (FOUNDATION `decideCommitment`, `issueCommonUnits`) change both under the unit-class lock, so one committing in between would freeze a holder with units but its pre-admission status (Codex finding 5). No path takes a resolution lock and then a ledger or unit-class lock.
1. Load `{ publicId, companyId }`, `lockResolution`, require `status === "DRAFT"`.
2. `params = paramsSchema(type).parse(resolution.params)`; `normalizeBlocks(resolution.body)` ok and `!isDocEmpty`; `title` non-empty. AMENDMENT: `assertCompanyOwns` on `affectedMemberIds`.
3. `specs = buildRequirements(type, params)`; `b = behaviour(type)`.
4. `recordDate <= todayInZone(now)` else `BAD_REQUEST "The record date cannot be in the future."`.
5. R19: if `type === "AUDIT_CALL"` and another AUDIT_CALL of the company has `status = EFFECTIVE` and `effectiveAt` in the same calendar year (in `GOVERNANCE_TIME_ZONE`) as `now` → `BAD_REQUEST "A review or audit has already been required in this fiscal year (Section 8.3)."`.
6. `takeRecordSnapshot(tx, { companyId, recordDate, purpose: "RESOLUTION", takenById: memberId })`.
7. Delete existing `ResolutionRequirement` rows; insert one per spec with `position`, `section`, and for UNIT_VOTE `denominatorUnits = fromMicro(denominator(entries, basis))`, `minimumForUnits = fromMicro(minimumFor(...))`. A UNIT_VOTE with denominator 0 → `BAD_REQUEST "No outstanding units are entitled to vote on: {basis label}."`. An AFFECTED_MEMBER_CONSENT whose stakeholder is not a snapshot entry with `isMember` → `BAD_REQUEST`.
8. Ballots (only when `b.hasBallots`): `eligible = eligibleRecipients(entries, requirements)`. If `b.allRecipientsRequired` → recipients = all eligible (ignore the input list). Else recipients = eligible ∩ input list (default all); every AFFECTED_MEMBER_CONSENT stakeholder is always included; an input id that is not eligible → `BAD_REQUEST`; zero recipients → `BAD_REQUEST`. A recipient whose entry email is empty → `BAD_REQUEST "{name} has no notice email."`.
9. `closesAt`: no ballots → null; `b.fixedWindowDays` → `responseDeadline(now, b.fixedWindowDays)`; else `closesOn` must be between tomorrow and today + 180 days (default today + 30) → `endOfDayInZone(closesOn)`.
10. `referenceCode = nextReferenceCode(codes of the company, year of now in GOVERNANCE_TIME_ZONE)`.
11. `frozenContent = { title, type, doc, lockedClauses: buildLockedClauses(type, params, { companyName }), requirements: specs.map(label + section), recordDate }`; `frozenHash = sha256Hex(canonicalJson(frozenContent))`.
12. Update the resolution: `status SENT, sentAt now, recordDate, snapshotId, closesAt, referenceCode, frozenContent, frozenHash, autoReminders`.
13. Create ballots with `name, email, preferredUnits` from the entry, the two `counts*` flags, `tokenExpiresAt = ballotTokenExpiry(now, closesAt)`.
14. Signatures: if specs contain MANAGER_APPROVAL, `managerSignature` is REQUIRED (`BAD_REQUEST "The Manager's signature is required to send this resolution."`); write `approvedByMemberId, approverName, approverCapacity, approvedAt = now, approvalIp = ctx.requestIp, approvalUserAgent = ctx.userAgent`; `recordEvent MANAGER_SIGNED`; `Audit "resolution.approved"`. If specs contain COMMON_MEMBER_APPROVAL and `commonMemberSignature` is given, same for that requirement (`COMMON_MEMBER_SIGNED`); if not given it stays pending (signed later with `resolution.approve`).
15. `recordEvent SENT`; `Audit "resolution.sent"` with summary `{user} sent {referenceCode} "{title}" to {n} Members (record date {recordDate})`. If `type === "TERM_EXTENSION"`: set every OPEN `ComplianceDeadline` of the company with `ruleKey = "EXTENSION_REQUEST_DUE"` to `DONE` (`satisfiedByType "RESOLUTION"`, `satisfiedById`, `completedAt`, `completedById`) — the request under Section 2.5 has been made.
16. `transition = await evaluateAndTransition(tx, id, now, userActor)` — a PURCHASE_ORDER becomes EFFECTIVE here.
After commit: `emitBallotEmails` (INVITE, seq 0) for every ballot unless the transition closed the resolution; `emitResolutionFinalize` when `transition` is not null. Output `{ publicId, referenceCode, status }`.

**Tenant and safety rules.** `recipientStakeholderIds` are only ever matched against snapshot entries of this company (no direct stakeholder lookup by client id), so no `assertCompanyOwns` is needed for them. Requirements are always rebuilt from `type + params` on the server.

**Acceptance.**
- Sending the PO example from G5 with a manager signature returns `status: "EFFECTIVE"`, creates no ballots, sets `copyDueOn` to signing date + 10 BD and creates one OPEN `ComplianceDeadline`.
- Sending a GENERAL_CONSENT on the REG register creates 6 ballots (alice, bob, carol, dan, schoen, reidTrust), none for sam, fay, octagon; `denominatorUnits = 1050.000000`, `minimumForUnits = 735.000000`.
- Sending a RELATED_PARTY creates 4 ballots; `denominatorUnits = 900.500000`, `minimumForUnits = 450.250001`.
- `update`, `delete` on a SENT resolution fail with `BAD_REQUEST`; a second `send` fails.
- A user of another company gets `NOT_FOUND` for every procedure given this resolution's `publicId`.
- A non-LLC company gets `NOT_FOUND` from every procedure.

**Do not touch.** Files of G8 in the same router directory.

---

### G8 — Ballot router (public), ballot management, resolution sweep

**Goal.** The member-facing token procedures, the Manager's ballot tools, and the scheduled close.

**Prerequisites.** G6, G7, G9.

**Decision recorded (signature step).** A dedicated ballot page, not the e-sign pipeline. Reasons: e-sign completes only when every recipient signs and has no choice, weight, threshold or deadline (A4); it needs an uploaded PDF with positioned fields per recipient, which a generated consent with a variable number of signers cannot provide; its signature pad does not work on phones; and bending `sign-template.ts` for thresholds would put the security-reviewed e-sign path at risk. The Agreement accepts "electronic signature or … email confirmation" (6.12) and gives every electronic signature the effect of an original (13.9); a typed legal name with an explicit assent statement, bound to a document hash, timestamp, IP and user agent, satisfies that. The e-sign feature stays available for documents that need a drawn signature on a PDF (Exhibit B pages, promissory notes).

**Files.** `src/trpc/routers/ballot-router/{router.ts,schema.ts,procedures/{view,mark-viewed,submit,executed-pdf}.ts}`; `src/trpc/routers/resolution-router/procedures/{add-recipients,remind,replace-link,revoke-link,evidence}.ts` and their keys in `resolution-router/router.ts`; `src/jobs/governance-resolution-sweep.ts`; one `register` and one `schedule` line in `src/jobs/register.ts`.

**Token validation — exact order, shared helper `resolveBallot(db, token)` in `ballot-router/procedures/resolve.ts`.**

1. Input schema: `z.object({ token: z.string().min(20).max(2048) })`.
2. `verifyBallotToken(token)` (signature, `exp`, strict payload with `p: "rb"`). Null → `TRPCError NOT_FOUND`.
3. `ballot = db.resolutionBallot.findUnique({ where: { id: ballotId }, include: { resolution: { include: { company: { select: { id, publicId, name, logo, entityType } } } } } })`. Null → `NOT_FOUND`.
4. `company.entityType !== "LLC"` or `resolution.status === "DRAFT"` → `NOT_FOUND`.
5. `ballot.tokenRevokedAt` set, or `version !== ballot.tokenVersion` → return `{ kind: "REPLACED", company }` (no resolution content).
6. `ballot.tokenExpiresAt <= now` → `NOT_FOUND`.
7. Return `{ kind: "OK", ballot, resolution, company }`.

The company, the resolution and the stakeholder are ALWAYS taken from the ballot row; no procedure accepts a company, resolution, ballot or stakeholder id from the client. One token gives access to exactly one ballot of one resolution of one company. `NOT_FOUND` carries no detail, so an invalid token reveals nothing.

**Public procedures (`withoutAuth`).**

| Procedure | Input | Behaviour | Output |
|---|---|---|---|
| `ballot.view` (mutation: every public ballot procedure is a POST so the token never travels in a URL; M4) | `{ token }` | `resolveBallot`. If the resolution is SENT and `closesAt < now`: run `evaluateAndTransition` (system actor) in a transaction, emit finalize, reload. | `{ state: "REPLACED", company: { name, logo } }` or `{ state: "OPEN" | "VOTED" | "CLOSED", company: { name, logo }, timeZone, resolution: { title, referenceCode, type, kindLabel, status, recordDate, sentAt, closesAt, effectiveAt, closedAt, withdrawnReason, doc, lockedClauses, frozenHash, deemedAgainstAtClose, hasDisinterestedRequirement, hasExecutedPdf }, ballot: { name, preferredUnits, countsPreferred, countsDisinterested, choice, deemed, signedName, signerCapacity, submittedAt } }`. `state` = CLOSED when status is not SENT; else VOTED when `submittedAt` is set; else OPEN. `title`/`doc`/`lockedClauses` come from `frozenContent` (never `params`). `timeZone` = `Company.timezone` (default `America/Denver`); the page formats every date in it. `hasDisinterestedRequirement` = the resolution has a `DISINTERESTED_*` unit vote (never a tally). Never includes other Members, emails, tallies, IPs. |
| `ballot.markViewed` (mutation) | `{ token }` | `resolveBallot` (kind OK only). `firstViewedAt = now` if null, `viewCount + 1`; `recordEvent BALLOT_VIEWED` (stakeholder actor, `ctx.requestIp`, `ctx.userAgent`) only on the first view. | `{ ok: true }` |
| `ballot.submit` (mutation) | `{ token, choice: "FOR" | "AGAINST" | "ABSTAIN", signedName: string trimmed 2–200, signerCapacity: string trimmed 0–200 optional, bodyHash: string, assent: z.literal(true) }` | See "`ballot.submit` in full" below. | `{ state: "VOTED" | "CLOSED", status }` |
| `ballot.executedPdf` (mutation) | `{ token }` | `resolveBallot` (OK only); resolution must be EFFECTIVE with `executedDocumentId`; load the document `{ id, companyId: ballot.companyId }` + bucket; `assertKeyReadableByCompany(key, company)`; `getPresignedGetUrl(key)`. | `{ url }` (10-minute URL) |

**`ballot.submit` in full.** The transaction must COMMIT in every branch, because it may have closed an overdue resolution (deemed-against ballots, status change); a rejection is therefore returned from the transaction and thrown only afterwards.

Inside ONE transaction, returning `{ result, transition }`:
1. `resolveBallot` (kind REPLACED → return `{ result: "REPLACED", transition: null }`); `lockResolution`; reload the resolution and the ballot.
2. `transition = null`. If `resolution.status === "SENT"` and `closesAt < now`: `transition = await evaluateAndTransition(tx, …, system actor)`; reload.
3. If `resolution.status !== "SENT"` → return `{ result: "CLOSED", transition }`.
4. If `ballot.submittedAt !== null` → return `{ result: "ALREADY", transition }`.
5. If `input.bodyHash !== resolution.frozenHash` → return `{ result: "HASH_MISMATCH", transition }`.
6. Write-once update (C3.2) with `choice, deemed: false, signedName, signerCapacity, submittedAt: now, submitIp: ctx.requestIp, submitUserAgent: ctx.userAgent, bodyHash`; `count !== 1` → return `{ result: "ALREADY", transition }`.
7. `recordEvent BALLOT_SUBMITTED` (summary `{name} responded {choice} with {units} Preferred Units`); `Audit "ballot.submitted"` (stakeholder actor, target `{ type: "ballot", id }`).
8. `transition = await evaluateAndTransition(tx, …, stakeholder actor)`; return `{ result: "RECORDED", transition }`.

After the transaction: if `transition` → `emitResolutionFinalize(resolutionId)`. Then by `result`: `RECORDED` → return `{ state, status }`; `REPLACED` → throw `FORBIDDEN "This link has been replaced."`; `CLOSED` → throw `CONFLICT "This resolution is closed."`; `ALREADY` → throw `CONFLICT "Your response has already been recorded."`; `HASH_MISMATCH` → throw `CONFLICT "The document changed. Reload the page."`. Never `throw` inside the transaction for these cases.

**Manager procedures (in `resolution-router`, `withAccessControl`, `governance: update` unless stated).**

| Procedure | Input | Behaviour | Audit |
|---|---|---|---|
| `resolution.addRecipients` | `{ publicId, stakeholderIds: string[] (1–500) }` | SENT only; each id must be a snapshot entry returned by `eligibleRecipients` for this resolution and have no ballot yet (else `BAD_REQUEST`); create ballots as in send step 13; emit INVITE emails. | — (job writes `ballot.issued`) |
| `resolution.remind` | `{ publicId, ballotIds?: string[] }` | SENT only; targets = given ballots (must belong to the resolution) or all; skip ballots that are submitted, revoked, or reminded less than 24 hours ago; emit REMINDER with `seq = reminderCount + 1`. Returns `{ sent: number, skipped: number }`. | — (job writes `ballot.reminded`) |
| `resolution.replaceBallotLink` | `{ publicId, ballotId, email?: string email }` | SENT only; ballot of this resolution; not submitted. `tokenVersion + 1`, `tokenRevokedAt = null`, `tokenExpiresAt` recomputed, optional new `email`; `recordEvent LINK_REPLACED` and the audit row (summary names old and new email when changed); emit INVITE with `seq = tokenVersion` (new version) and, when the email changed, ADDRESS_CHANGED with the previous address (H1). When the resolution has a Disinterested requirement, a new email must equal the stakeholder's `noticeEmail` or `email` on file (case-insensitive), else `BAD_REQUEST "… Update the Member's record first."`. | `ballot.link-replaced` |
| `resolution.revokeBallotLink` | `{ publicId, ballotId }` | SENT only; not submitted; `tokenRevokedAt = now`; `recordEvent LINK_REVOKED`. The ballot stays in the denominator (the snapshot decides that, not the link). | `ballot.link-revoked` |
| `resolution.evidence` (query, `governance: read`) | `{ publicId }` | Returns `{ fileName, csv }`: one row per ballot — name, email, units, countsPreferred, countsDisinterested, choice, deemed, signedName, signerCapacity, submittedAt (ISO), submitIp, submitUserAgent, bodyHash, invitedAt, firstViewedAt, reminderCount, "Ballot email changed after send" (yes/no), "Original ballot email" (the frozen register entry's); values CSV-escaped and any cell starting with `=`, `+`, `-`, `@`, TAB or CR prefixed with `'`. | — |

**Sweep job.** `src/jobs/governance-resolution-sweep.ts`: queue `governance.resolution-sweep`, schema `z.object({})`. Handler: (1) for each resolution with `status = SENT` and `closesAt < now`: transaction → `evaluateAndTransition` (system actor) → emit finalize; (2) automatic reminders: for each SENT resolution with `autoReminders` and `closesAt` in the future, let `left = daysBetween(todayInZone(now), todayInZone(closesAt))`; if `left` is 7 or 2: for each unsubmitted, non-revoked ballot with `invitedAt` set and no event with `dedupeKey` containing `:REMINDER:auto-{left}:` emit a REMINDER with `seq = "auto-" + left` (the job accepts string sequence keys, G9); (3) H2: emit finalize for every resolution with status EFFECTIVE (by `effectiveAt`) or FAILED / EXPIRED / WITHDRAWN (by `closedAt`) that closed more than 3 minutes ago and whose `resultNotifiedAt` is null (a lost emit or a failed finalize). Register: `queueManager.register(resolutionSweepWorker); queueManager.schedule({ name: "governance.resolution-sweep", cron: "*/15 * * * *" });`. Closing does not depend on the sweep alone: `ballot.view`, `ballot.submit`, `resolution.get` and `resolution.list` all close overdue resolutions on read (A7 trap).

**Worked example = integration test script** (`G19` runs it; here write it as a comment block at the top of `submit.ts` and verify by hand against a dev database): REG register, GENERAL_CONSENT (Supermajority, minimum 735.000000). alice FOR (400) → SENT. bob FOR (700) → SENT. dan FOR (750.5) → EFFECTIVE at dan's submission instant; carol's later submit → `CONFLICT "This resolution is closed."`; carol, schoen, reidTrust, sam and octagon each receive one result email with the PDF; fay receives nothing.

**Acceptance.**
- A ballot token for resolution A cannot view or submit anything for resolution B (there is no input to name B).
- An update-share token, a data-room token and an e-sign token are each rejected with `NOT_FOUND` by all four public procedures; a ballot token is rejected by `template.getSigningFields` (it has no `id`/`rec`).
- After `replaceBallotLink`, the old URL returns `state: "REPLACED"` and the new one works; after `revokeBallotLink` both the page and `submit` refuse.
- Submitting twice returns `CONFLICT` and leaves the first vote unchanged.
- Two concurrent submits that together cross the threshold produce exactly one EFFECTIVE transition and one finalize job.
- TERM_EXTENSION: with only alice FOR at `closesAt + 1 minute`, the next `ballot.view` marks bob, carol, dan, schoen, reidTrust `AGAINST, deemed = true, submittedAt = closesAt` and the resolution FAILED.
- A member opening the link after close sees the CLOSED state with their own recorded (or deemed) response.

**Do not touch.** `src/trpc/routers/template-router/**`, `src/app/(documents)/esign/**`.

---

### G10 — Manager UI: resolution list, new, draft editor, send dialog

**Goal.** A Manager user can create a resolution from a preset, edit it, preview who will be asked and against which threshold, and send (or, for a purchase order, sign) it.

**Prerequisites.** G7 (and G8 for nothing; G10 does not call ballot procedures).

**Read first (models to copy).** `src/app/(authenticated)/(dashboard)/[publicId]/updates/page.tsx` (list page + empty state), `src/app/(authenticated)/(dashboard)/[publicId]/documents/page.tsx` (RBAC in a Server Component), `src/components/update/update-table.tsx` (table), `src/components/update/editor.tsx:18-22,177-179,380-389` (BlockNote wiring), `src/components/update/editor-lazy.tsx`, `src/app/(authenticated)/(dashboard)/[publicId]/equity-plans/form.tsx` (react-hook-form + zod + `src/components/ui/form.tsx`), `src/components/dashboard/page-layout/index.tsx`.

**Files.** Create `src/components/governance/rich-text-editor.tsx`, `rich-text-editor-lazy.tsx`, `status-badge.tsx`, `resolution-table.tsx`, `resolution-preset-form.tsx`, `resolution-draft-editor.tsx`, `send-dialog.tsx`; pages `src/app/(authenticated)/(dashboard)/[publicId]/resolutions/page.tsx`, `resolutions/new/page.tsx`, `resolutions/[resolutionPublicId]/page.tsx`.

**Components.**

- `rich-text-editor.tsx` (`"use client"`): props `{ initialBlocks: unknown[]; onChange: (blocks: unknown[]) => void }`. `useCreateBlockNote({ initialContent: initialBlocks.length > 0 ? initialBlocks : undefined })`, `<BlockNoteView editor={editor} theme="light" onChange={() => onChange(editor.document)} />`, the three CSS imports from `src/components/update/editor.tsx:18-22`. `rich-text-editor-lazy.tsx`: `dynamic(() => import("./rich-text-editor"), { ssr: false })` exactly like `editor-lazy.tsx`. This component is reused by G13.
- `status-badge.tsx`: `Badge` variants — DRAFT `warning` "Draft"; SENT `secondary` "Open for responses"; EFFECTIVE `success` "Effective"; FAILED `destructive` "Not approved"; EXPIRED `destructive` "Expired"; WITHDRAWN `outline` "Withdrawn" (use the variants that exist in `src/components/ui/badge.tsx`; fall back to `secondary`).
- `resolution-preset-form.tsx` (`"use client"`): renders the parameter form for one `ResolutionType` from the G5 parameter table (text inputs, textarea for long fields, money inputs as text with pattern, date input, switches, multi-select of Members for `affectedMemberIds`, checkbox list of `PROTECTED_PROVISIONS` shown only when `touchesProtectedProvision`, select of `MATTERS` rows with `presetType === null` for GENERAL_CONSENT with the matter's requirement sentence shown under it). Validation with `paramsSchema(type)` through `zodResolver`. For RELATED_PARTY show an info box listing `PRE_APPROVED_RELATED_PARTY` under the heading "No resolution is needed for:". For PURCHASE_ORDER show the info box "Sign this resolution before any LLC funds are paid. It is required for a purchase order, or a series of related purchase orders, over $25,000 (Section 6.16(i)(B)). A copy is emailed to all Members when you sign."

**Pages.**

1. `/[publicId]/resolutions` (Server Component). `serverAccessControl()`; if `governance: read` is not allowed render `UnAuthorizedState`. Data: `api.resolution.list({})`. Empty: `EmptyState` titled "No resolutions yet" with the button "New resolution" → `/[publicId]/resolutions/new`. Otherwise `PageLayout` (title "Resolutions", description "Written consents of the Members and resolutions of the Manager") with the action button and `ResolutionTable`: columns Reference, Title (link), Type, Status (`StatusBadge`), Progress (first requirement: `{forBps/100}% of {threshold}%`, or "Manager only"), Respond by, Effective.
2. `/[publicId]/resolutions/new` (Server Component shell + client form). Step 1: nine cards (label, one-line description, OA section): General member consent (6.9, 6.16), Related-party transaction (6.16(i)), Purchase-order resolution (6.16(i)(B)), Term extension election (2.5), Removal of the Manager (6.20), Successor Manager (6.20), Amendment (12.1), Call for review or audit (8.3), Member loan (4.6). Step 2: `ResolutionPresetForm`; submit → `api.resolution.create` → `router.push` to the draft. Defaults: `managerName`/`purchasingAgentName` prefilled from the most recent PURCHASE_ORDER resolution's params if one exists (pass from the server via `resolution.list` + `get`), else empty.
3. `/[publicId]/resolutions/[resolutionPublicId]` (Server Component). `api.resolution.get({ publicId })` (catch `NOT_FOUND` → `notFound()`). `status === "DRAFT"` → `ResolutionDraftEditor`; otherwise render `ResolutionDetail` from G11 (until G11 is merged render the title, status badge and `RichDocView` of the frozen document only).

**`ResolutionDraftEditor`** (`"use client"`). Layout: header (back link, title input, `StatusBadge`), left column editor card (`RichTextEditorLazy`), right column: "Details" (the preset form, collapsed by default), "Locked text" (read-only numbered list from `buildLockedClauses(type, params, { companyName })`, recomputed on every params change, with the caption "This text is added automatically and cannot be edited"), "Approval required" (from `buildRequirements` + `describeRequirements`). Buttons: "Save draft" (`resolution.update`; on Zod/`BAD_REQUEST` error show the server message in a toast, e.g. "Unsupported block: image"), "Delete draft" (confirm), "Review and send" (saves first, then opens `SendDialog`). Unsaved-changes guard: disable "Review and send" while a save is in flight.

**`SendDialog`** (`"use client"`). Fields and behaviour:
- Record date (date input, default today in the browser, max today). On change call `api.resolution.preview.useQuery({ type, params, recordDate })`.
- "Approval required" table from the preview: label, section, outstanding units entitled to vote, minimum For.
- Recipients table from the preview with checkboxes (all checked; disabled when `behaviour(type).allRecipientsRequired`, with the caption "Section 2.5: every Preferred Member is asked"). Columns: name, email, Preferred Units, chips "Counts for Preferred vote" / "Counts for Disinterested vote" / "Consent only". Unchecking shows the hint "Units of Members you do not ask still count in the denominator."
- "Not entitled to vote" list from `excluded` with the reason text: SUSPENDED "Units suspended for default (Section 4.9(iii))"; FINANCIAL_INTEREST_ONLY "Holds a Financial Interest only (Sections 1.23, 7.9.2)"; INSIDER "Not a Disinterested holder (Section 1.18)"; NO_PREFERRED_UNITS "Holds no Preferred Units".
- Respond by (date input, default today + 30 days, min tomorrow, max today + 180). Hidden for PURCHASE_ORDER; replaced by the text "Responses close 30 days after sending (Section 2.5); non-responders are deemed to vote against." for TERM_EXTENSION.
- "Send automatic reminders 7 and 2 days before the deadline" switch (default on; hidden for PURCHASE_ORDER).
- Manager signature block when the requirements include MANAGER_APPROVAL: "Signer name" (default `session.user.name`), "Title / capacity" (default "Authorized signatory of the Manager"), and the sentence "By sending, I sign this resolution electronically on behalf of the Manager (Sections 6.12 and 13.9)." For AMENDMENT with `adverseToCommon`: checkbox "Also sign for the Common Member" revealing the same two fields.
- Warnings from the preview in an `Alert`.
- Primary button: "Send to {n} Members", or "Sign and deliver to Members" for PURCHASE_ORDER. On success: toast and `router.refresh()`.

**States to handle.** Loading preview (skeleton rows), preview error (inline message, primary button disabled), zero recipients (button disabled), mutation error (toast with server message).

**Acceptance.**
- Creating each of the nine types reaches the draft editor with a title, a starter body and locked text.
- Saving a body that contains an image block shows the server error and does not save.
- The send dialog for the REG register and GENERAL_CONSENT shows "1,050.000000" outstanding and "735.000000" minimum, six recipients, and sam, fay, octagon under "Not entitled to vote" with the right reasons.
- For PURCHASE_ORDER the dialog has no recipients table and the button reads "Sign and deliver to Members"; after confirming, the page shows status "Effective".
- `next build` passes (the editor is only ever loaded through the lazy wrapper).

**Do not touch.** `src/components/update/**`, the sidebar (FOUNDATION adds the menu entry `/resolutions`).

---

### G11 — Manager UI: sent-resolution detail and tally; public ballot page

**Goal.** Live tally against the threshold for the Manager user; the page a Member opens from the email.

**Prerequisites.** G8, G9, G10.

**Files.** Create `src/components/governance/resolution-detail.tsx`, `tally-panel.tsx`, `ballot-table.tsx`, `ballot-form.tsx`; page `src/app/ballots/[token]/page.tsx`. Edit `src/trpc/routers/resolution-router/procedures/get.ts` to add the output field `emails` (below) and `src/app/(authenticated)/(dashboard)/[publicId]/resolutions/[resolutionPublicId]/page.tsx` to render `ResolutionDetail`.

**`resolution.get` addition.** `emails`: rows of FOUNDATION's `EmailLog` for this resolution (`where: { companyId, relatedType: "resolution", relatedId: resolution.id }`, newest first) reduced to `{ id, stakeholderId, toAddress, kind, status, sentAt, bounceState }`. "Not delivered" in the UI means `status === "FAILED"` or `bounceState === "BOUNCED"`.

**`ResolutionDetail`** (`"use client"`, data passed from the Server Component; mutations call `router.refresh()`; while status is SENT also refetch every 30 s with `api.resolution.get.useQuery(..., { initialData, refetchInterval: 30_000 })`).

Sections, top to bottom:
1. Header: reference, title, `StatusBadge`, type label, record date, sent, respond by, effective/closed date, withdrawn reason. Actions by status — SENT: "Remind all pending" (`resolution.remind`), "Add recipients" (dialog listing eligible snapshot entries without a ballot), "Withdraw" (dialog with required reason); every non-draft status: "Duplicate as new draft" (`resolution.clone`), "Evidence export (CSV)" (`resolution.evidence`, download through a Blob); EFFECTIVE: "Executed PDF" (open the filed document the same way `documents/components/table.tsx` opens a document).
2. `TallyPanel`: one card per requirement. UNIT_VOTE: title = basis label + section; a horizontal bar of width `forBps / 100`% with a vertical marker at the threshold (50, 67 or 70); text lines `For {for} of {denominator} units ({pct}%)`, `Needs {minimumFor} ({wording})`, `Against {against} · Abstain {abstain} · No response {notVoted}`; chip `Approved` / `Pending` / `Cannot be reached`. Percentages: two decimals, truncated (`Math.floor(forBps) / 100`); never round up to a threshold. MANAGER/COMMON approval: signer name, capacity, time, or "Pending" with a "Sign for the Common Member" button (`resolution.approve`). AFFECTED_MEMBER_CONSENT: member name and state.
3. `BallotTable`: Name, Email, Preferred Units, Counts for (chips), Link (Active / Replaced v{n} / Revoked / Expired), Sent, Viewed, Response (For / Against / Abstain / Deemed against / —), Signed by (name, capacity), Responded at, IP address. Row menu: Remind, Replace link (dialog: optional new email; warning "The previous link stops working immediately"), Revoke link. Email delivery state per row from `emails` (latest `resolution.ballot` log for that stakeholder): Sent / Not delivered (red, with the tooltip "An email notice is not effective if a non-delivery notice is received (Section 13.6)").
4. "Not asked" (eligible entries without ballots) and "Not entitled to vote" (suspended, Financial-Interest-only, insiders for disinterested votes) with reasons as in the send dialog.
5. PURCHASE_ORDER only — "Copy to Members": due date (`copyDueOn`), delivered at, per-Member row (name, email, sent time, delivery state) with "Resend" (`resolution.resendNotice`).
6. "Result notices" (closed resolutions): per-Member rows as in 5.
7. "Document": `RichDocView` of `frozenContent.doc`, locked clauses, document hash.
8. "History": `events` as a timeline (time, summary).
9. EFFECTIVE `TERM_EXTENSION` only — an information line: "The Target Sale Date is extended by one year (Section 2.5)." Nothing else is needed: ECONOMICS counts the company's EFFECTIVE `TERM_EXTENSION` resolutions (its `countTermExtensions`) and moves the date itself; governance writes nothing into ECONOMICS tables. Consequence to respect: a TERM_EXTENSION resolution must be sent only when an extension is actually being asked (each EFFECTIVE one adds a year); the new-resolution form shows "Each approved extension moves the Target Sale Date by one year."
10. "Linked payments" (when ECONOMICS is merged): rows of `managerPayment` with `resolutionId = resolution.id` (date, payee, amount) — read-only, omitted when the model does not exist.

**Public page `src/app/ballots/[token]/page.tsx`** (Server Component; model `src/app/updates/[publicId]/page.tsx` for layout only).

- `export const metadata = { title: "Member consent", robots: { index: false, follow: false }, referrer: "no-referrer" }`.
- The token never travels in a URL other than the page's own path: every public ballot procedure is a mutation (POST body). The proxy access log and Sentry share one redaction rule (`src/lib/token-redaction.ts`): token-shaped path segments, `/ballots/<x>` and `/member-reports/<x>` segments and `input` / `token` query values are replaced in URLs, transaction and span names (`beforeSendSpan`; SDK v11 streams spans and ignores `beforeSendTransaction`), breadcrumbs, error events (`beforeSend`) and replay recordings (M4).
- `const data = await api.ballot.view({ token }).catch(() => null); if (!data) return notFound();`
- Wrap in `SharePageLayout` (`medium="ballot"`, company name/logo, title = resolution title with the reference below it).
- States:
  - `REPLACED`: card "This link has been replaced. Please use the most recent email from {company}, or contact the Manager."
  - `OPEN`: facts box ("Member: {name}", "Preferred Units of record on {recordDate}: {units}", "Respond by {closesAt}" in the company time zone returned by `view` with the zone abbreviation), then `RichDocView`, then the locked clauses as a numbered list, then `BallotForm`. If `!countsPreferred && !countsDisinterested` show "Your consent is requested as an affected Member (Section 12.1(b))." If the resolution has a Disinterested requirement and `!countsDisinterested` show "Your units are not counted toward the Disinterested vote (Section 1.18)."
  - `VOTED`: "Your response was recorded on {submittedAt}: {For | Against | Abstain}. Signed: {signedName}{, capacity}." and "The result will be emailed to all Members."
  - `CLOSED`: banner by status — EFFECTIVE "Approved. Effective {effectiveAt}." with the button "Download the executed consent" (client component calling the `ballot.executedPdf` mutation then `window.open(url)`), shown only when `hasExecutedPdf`; FAILED "Not approved."; EXPIRED "Closed on {closedAt} without the required approval."; WITHDRAWN "Withdrawn by the Manager on {closedAt}." Then the Member's own response, or "You did not respond.", or for a deemed vote "No response was received within 30 days. Under Section 2.5 you are deemed to have voted against the extension." Then the document (read-only).
- `BallotForm` (`"use client"`): on mount call `api.ballot.markViewed` once. Radio group: "I consent (For)", "I do not consent (Against)", "Abstain". Input "Type your full legal name" (required). Input "Title or capacity (if signing for an entity or trust)" (optional). Required checkbox: "I am the Member named above, or I am authorised to sign for it. I agree that typing my name is my electronic signature (Operating Agreement Sections 6.12 and 13.9)." TERM_EXTENSION note above the button: "If you do not respond by the deadline you are deemed to have voted against the extension (Section 2.5)." Button "Sign and submit" → confirmation dialog "Your response is final and cannot be changed." → `api.ballot.submit({ token, choice, signedName, signerCapacity, bodyHash: resolution.frozenHash, assent: true })` → `router.refresh()`. On `CONFLICT` show the server message and refresh.
- The page works on a phone: single column, no hover-only controls, no signature canvas.

**Acceptance.**
- The tally for G1 case 12 shows "66.66%" (not 66.67%) and "Pending"; case 14 shows "70.00%" and "Approved".
- Opening a ballot link signed out (private window) works; the dashboard is never reachable from that page.
- The response is recorded with the browser's real IP and user agent (`ballot.submit` is an HTTP mutation; A1 trap).
- After the deadline the same link shows the CLOSED state.
- `/ballots/abc` returns the app's 404 page.

**Do not touch.** `src/app/(documents)/**`, `src/app/updates/**`.

---

### G12 — Member reports backend

**Goal.** Quarterly reports, annual packs, K-1 deliveries and notices as `MemberReport`: prefilled 8.2 content, attachments (including private per-holder files), delivery to Members with proof of sending, tokenised per-holder view.

**Decision recorded.** `MemberReport` is a separate feature beside Updates, not built on `Update`. Reasons (A5): `Update` has no period, due date, structured figures, attachments or per-recipient delivery/view state; its public page refuses any update that is not PUBLIC; its tokens never expire and trust the company id in the token; its editor component is bound to `api.update.*`; and 8.2 reports must be restricted to Members while Updates can go to any contact. Reused from Updates: the BlockNote editor recipe (through `RichTextEditorLazy`, G10) and the share-page layout. Investor Updates remain available for informal communication.

**Prerequisites.** G2, G3, G4, G6 (`tokens.ts`, `hash.ts`, `recipients.ts`); ECONOMICS E19 (`getPeriodEconomics`, `closeBooksThrough`, E2); FOUNDATION F10 (`sendMail`, E1).

**Files.** `src/lib/governance/report-figures.ts`, `report-figures.test.ts`; `src/trpc/routers/member-report-router/{router.ts,schema.ts,procedures/*.ts}`; `src/trpc/routers/member-report-view-router/{router.ts,schema.ts,procedures/{resolve,view,mark-viewed,attachment-url}.ts}`; `src/jobs/governance-report-email.ts`; `src/emails/MemberReportEmail.tsx`; one line in `src/jobs/register.ts`.

**`report-figures.ts` (pure).**

```ts
export type CentsNumber = number; // integer cents (FOUNDATION B1: cents cross JSON as a JS number)
export interface ReportFigures {
  source: { fetchedAt: string; periodStart: string; periodEnd: string } | null;
  revenue: { amountCents: CentsNumber | null; note: string };            // Gross Revenue (OA 6.18 definition)
  utilization: { bps: number | null; note: string };                      // 0–10000; prefilled from the ledger average, editable
  expenses: { totalCents: CentsNumber | null; lines: { category: string; amountCents: CentsNumber }[]; note: string };
  managementFee: { accruedCents: CentsNumber | null; paidCents: CentsNumber | null; unpaidAtEndCents: CentsNumber | null; note: string };
  reserves: { balanceCents: CentsNumber | null; minimumRequiredCents: CentsNumber | null; note: string };
  distributions: { totalCents: CentsNumber | null; preferredReturnCents: CentsNumber | null; returnOfCapitalCents: CentsNumber | null; residualCents: CentsNumber | null; none: boolean; note: string };
  managerPayments: {
    lines: { paidOn: string; payee: string; category: string; flow: "TO" | "THROUGH"; amountCents: CentsNumber; memo: string | null; resolutionId: string | null }[];
    insiderDistributions: { name: string; paymentDate: string; netCents: CentsNumber }[];
    insiderLoanPayments: { name: string; paidOn: string; principalCents: CentsNumber; interestCents: CentsNumber }[];
    grandTotalCents: CentsNumber | null;
    confirmedNone: boolean;
  };
}
export const EMPTY_FIGURES: ReportFigures;
export const ReportFiguresSchema: z.ZodType<ReportFigures>; // strict; integers only for cents; notes max 2000 chars; max 500 lines per list
/** The fields of ECONOMICS getPeriodEconomics that are used, with bigint cents already converted to numbers by the caller. */
export interface PeriodReportInput {
  revenue: { grossRevenueCents: number; averageUtilizationBps: number | null };
  expenses: { totalCents: number; byCategory: { category: string; amountCents: number }[] };
  managementFee: { accruedCents: number; paidCents: number; unpaidAtEndCents: number };
  reserves: { balanceAtEndCents: number; minimumRequiredCents: number };
  distributions: { totalGrossCents: number; tierCCents: number; tierDCents: number; tierECents: number };
  managerAndAffiliatePayments: {
    payments: { paidOn: string; payee: string; category: string; flow: "TO" | "THROUGH"; amountCents: number; memo: string | null; resolutionId: string | null }[];
    insiderDistributions: { name: string; paymentDate: string; netCents: number }[];
    insiderLoanPayments: { name: string; paidOn: string; principalCents: number; interestCents: number }[];
    grandTotalCents: number;
  };
}
export function figuresFromPeriodData(data: PeriodReportInput, period: { start: string; end: string }, fetchedAt: string, previous?: ReportFigures): ReportFigures;
export const NOTICE_KINDS: Record<string, { label: string; section: string }>;
export interface ChecklistItem { key: string; label: string; section: string; ok: boolean }
export function reportChecklist(type: "QUARTERLY" | "ANNUAL" | "TAX_K1" | "NOTICE", figures: ReportFigures, attachments: { kind: string; stakeholderId: string | null }[], commentaryEmpty: boolean): ChecklistItem[];
export function defaultReportTitle(input: { type: string; fiscalYear?: number; fiscalQuarter?: number; noticeKind?: string }): string;
```

- Adapter (server side, in `member-report-router/procedures/period-data.ts`): `loadPeriodReportInput(tx, companyId, period)` calls ECONOMICS `getPeriodEconomics(tx, companyId, { periodStart, periodEnd })` (`@/server/llc/economics`) and maps it to `PeriodReportInput`: every `Cents` bigint → `Number(value)`; `distributions.tierCCents/tierDCents` = sums of `items[].tierC` / `tierD`; `tierECents` = sum of `tierEPreferred + tierECommon`; `totalGrossCents = totalGross`; `expenses.totalCents = expenses.total`; `reserves.balanceAtEndCents`, `minimumRequiredCents`; payments, insider distributions (`net`) and insider loan payments copied field by field; `grandTotalCents = grandTotal`. This is the only file that knows the ECONOMICS shape.
- `figuresFromPeriodData`: `revenue.amountCents = grossRevenueCents`; `utilization.bps = averageUtilizationBps` unless `previous.utilization.bps` was edited to a non-null value (keep the previous value then); `expenses` total and lines; `managementFee` three amounts; `reserves`; `distributions` (`preferredReturnCents = tierCCents`, `returnOfCapitalCents = tierDCents`, `residualCents = tierECents`, `none = totalGrossCents === 0`); `managerPayments` lists and `grandTotalCents`; keeps every `note` and `managerPayments.confirmedNone` from `previous` when given.
- `NOTICE_KINDS`: `GENERAL` ("Notice to Members", "13.6"), `OPERATIONS_COMMENCEMENT` ("Notice of Operations Commencement Date", "1.21"), `TRANSFER_NOTICE_COPY` ("Copy of Transfer Notice", "7.1"), `INVOLUNTARY_TRANSFER` ("Notice of Involuntary Transfer", "7.2"), `TAX_PROCEEDING` ("Notice of audit or tax proceeding", "9.2"), `MANAGER_RESIGNATION` ("Notice of Manager resignation", "6.20").
- `reportChecklist` (R23–R26):
  - QUARTERLY (7 items, section "8.2" unless stated): `REVENUE` ok when `revenue.amountCents !== null`; `UTILIZATION` ok when `bps !== null`; `EXPENSES` ok when `totalCents !== null`; `MANAGEMENT_FEE` ok when `accruedCents !== null`; `RESERVES` ("8.2; 5.6(a)") ok when `balanceCents !== null`; `DISTRIBUTIONS` ok when `totalCents !== null || none`; `MANAGER_PAYMENTS` ok when `lines.length + insiderDistributions.length + insiderLoanPayments.length > 0 || confirmedNone`.
  - ANNUAL (3 items): `BALANCE_SHEET` ok when an attachment of that kind with `stakeholderId === null` exists; `INCOME_STATEMENT` likewise; `MANAGER_PAYMENTS` as above.
  - TAX_K1 (1 item): `K1_FILES` ok when at least one attachment has kind `K1` and every `K1` attachment has a `stakeholderId`.
  - NOTICE (1 item): `BODY` ("13.6") ok when `!commentaryEmpty`.
- `defaultReportTitle`: `Q{q} {fy} report to Members`; `FY{fy} annual financial statements`; `FY{fy} Schedule K-1`; `NOTICE_KINDS[kind].label`.

Tests (`report-figures.test.ts`): (1) `EMPTY_FIGURES` → QUARTERLY checklist has 7 items, all `ok: false`; (2) figures with revenue `12500000`, utilization `8250` bps, expenses total `4100000`, fee accrued `625000`, reserve `5000000`, distributions `none: true`, payments `confirmedNone: true` → all 7 ok; a non-integer cents value is rejected by `ReportFiguresSchema`; (3) ANNUAL with only a balance sheet → `INCOME_STATEMENT` not ok; a balance sheet attached privately (`stakeholderId` set) does not count; (4) TAX_K1 with one K1 lacking `stakeholderId` → not ok; (5) `figuresFromPeriodData` keeps the previous utilization and notes; (6) management fee sanity is NOT checked here (ECONOMICS owns the 5% computation).

**Manager procedures** (`withAccessControl`; `loadLlcCompany`; company-scoped lookups by `{ publicId, companyId }`).

| Procedure | RBAC | Input | Behaviour | Audit |
|---|---|---|---|---|
| `memberReport.list` | read | `{ type?: MemberReportTypeEnum }` | Rows desc by `createdAt`: `{ publicId, type, title, status, fiscalYear, fiscalQuarter, dueOn, sentAt, recipientCount, viewedCount }`. | — |
| `memberReport.get` | read | `{ publicId }` | `{ report, checklist, attachments (+ holder name), recipients (+ linkState, email log state), candidates }`. `candidates` for a DRAFT: QUARTERLY/ANNUAL/NOTICE → `listCurrentMembers`; TAX_K1 → every stakeholder with `memberStatus` MEMBER or FINANCIAL_INTEREST_ONLY (R22a) with a flag whether a K1 attachment exists. | — |
| `memberReport.create` | create | `{ type, fiscalYear?: int, fiscalQuarter?: 1–4, noticeKind?: key of NOTICE_KINDS, title?: string, relatedType?: "COMPLIANCE_DEADLINE", relatedId?: string }` | QUARTERLY requires year+quarter: period = `quarterBounds`, `dueOn = quarterlyReportDueOn`. ANNUAL and TAX_K1 require year: period = Jan 1–Dec 31; `dueOn = annualFinancialsDueOn` / `k1TargetDueOn`. NOTICE requires `noticeKind`. `relatedId` must be a `ComplianceDeadline` of the company. QUARTERLY/ANNUAL: `figures = figuresFromPeriodData(await loadPeriodReportInput(tx, companyId, period), period, now.toISOString())`. Title default from `defaultReportTitle`. Returns `{ publicId }`. | `memberReport.created` |
| `memberReport.refreshFigures` | update | `{ publicId }` | DRAFT, QUARTERLY/ANNUAL only; re-pull and merge with `previous`. | `memberReport.updated` |
| `memberReport.update` | update | `{ publicId, title (1–200), figures: unknown, commentary: unknown }` | DRAFT only; `ReportFiguresSchema.parse`; `normalizeBlocks` ok. | `memberReport.updated` |
| `memberReport.addAttachment` | update | `{ publicId, bucketId, name (1–200), kind, stakeholderId?: string }` | `assertCompanyOwns(tx, companyId, { bucketIds: [bucketId], stakeholderIds: [stakeholderId] })`. Kind rules: `K1` requires `stakeholderId` and report type TAX_K1; `BALANCE_SHEET`/`INCOME_STATEMENT` require type ANNUAL and no `stakeholderId`. Allowed while DRAFT; while SENT only ADDING is allowed (late K-1). | `memberReport.updated` |
| `memberReport.removeAttachment` | update | `{ publicId, attachmentId }` | DRAFT only. | `memberReport.updated` |
| `memberReport.attachmentUrl` (query) | read | `{ publicId, attachmentId }` | Attachment of this report; load bucket; `assertKeyReadableByCompany`; `getPresignedGetUrl`. | — |
| `memberReport.delete` | delete | `{ publicId }` | DRAFT only. | `memberReport.deleted` |
| `memberReport.send` | update | `{ publicId }` | see below (the audience is derived on the server, never chosen by the client) | `memberReport.sent` |
| `memberReport.resend` | update | `{ publicId, recipientId?: string }` | SENT only. For TAX_K1 first create recipient rows for holders that now have a K1 attachment but no row. Then emit `report-email` for the one recipient or all, with `seq = recipient.sendCount`. | `memberReport.resent` |
| `memberReport.replaceLink` | update | `{ publicId, recipientId, email?: string email }` | SENT only; `tokenVersion + 1`, `tokenRevokedAt null`, new expiry, optional email; emit `report-email`. | `memberReport.resent` |

`memberReport.send` (one transaction, `now` taken once):
0. Locks, in this order: ECONOMICS' `lockCompanyLedgerAndUnitClasses` (the company ledger lock, then the Preferred and Common unit-class row locks: step 2 reads member status and units in two statements and an admission holds only the unit-class lock, so none can commit between them), then the report's row lock; re-read the report.
1. DRAFT only. `doc = normalizeBlocks(commentary)` must be ok. `reportChecklist(...)` must be all ok, else `BAD_REQUEST "Incomplete: {labels joined}"`.
2. Recipients (R22, R22a), derived on the server: QUARTERLY / ANNUAL / NOTICE → `listCurrentMembers(tx, companyId, todayInZone(now))`. If `noticeKind` is `TRANSFER_NOTICE_COPY` or `INVOLUNTARY_TRANSFER`: load the `UnitTransfer` with `{ companyId, noticeCopyReportId: report.id }` (missing → `BAD_REQUEST "This notice is not linked to a transfer."`) and keep only Members with `preferredUnits > 0` other than `transfer.fromStakeholderId` (Sections 7.1, 7.2: "the other Preferred Members"). TAX_K1 → the distinct `stakeholderId`s of K1 attachments, loaded with `where: { id: { in }, companyId }`, excluding `memberStatus = PROSPECT`. A Financial-Interest-only holder is NEVER a recipient of QUARTERLY, ANNUAL or NOTICE. Zero recipients → `BAD_REQUEST`. Missing email → `BAD_REQUEST`.
3. Create `MemberReportRecipient` rows (`tokenExpiresAt = reportTokenExpiry(now)`).
4. `frozenContent = { title, type, noticeKind, period: { start, end }, figures (TAX_K1 and NOTICE: omitted), doc }`; `frozenHash`; `status SENT`, `sentAt`, `sentById`.
5. Deadlines: set to `DONE` (`satisfiedByType "MEMBER_REPORT"`, `satisfiedById = report.id`, `completedAt`, `completedById`) the OPEN rows of the company with `dedupeKey` = `QUARTERLY_REPORT:{fy}Q{q}` (QUARTERLY), `ANNUAL_FINANCIALS:{fy}` (ANNUAL), `K1_TARGET:{fy}` and `K1_FINAL:{fy}` (TAX_K1), and the row `relatedId` when `relatedType === "COMPLIANCE_DEADLINE"`.
6. QUARTERLY and ANNUAL: `await closeBooksThrough(tx, companyId, periodEnd)` (ECONOMICS: ledger entries dated on or before the period end can no longer be changed once the report is issued).
7. Audit `memberReport.sent`.
After commit: `bulkEmit` one `governance.report-email` job per recipient `{ recipientId, seq: 0 }` with `singletonKey = "report-email-" + recipientId + "-0"`.

**Email job `governance.report-email`** — data `{ recipientId: string, seq: number }`. Load recipient + report + company. Return when report is not SENT, `tokenRevokedAt` set, or `recipient.sendCount > seq` (already sent, or superseded: this is the idempotency marker). Sign the token from the loaded row. CLAIM in its own committed statement: `sendCount = seq + 1` guarded by `sendCount <= seq AND tokenVersion = <loaded> AND tokenRevokedAt IS NULL` (no row → return); `<=` keeps a request queued by `resend` or `replaceLink` at seq S claimable after an older in-flight job's failed send released the counter below S. Send `MemberReportEmail` with `sendMail(…, { kind: "memberReport.delivery", companyId, stakeholderId, relatedType: "memberReport", relatedId: report.id })`; then `sentAt = now` (first time), `emailLogId`. A failed send RELEASES the claim (`sendCount → seq`) only while `sendCount = seq + 1 AND tokenVersion = <loaded>`, and rethrows (pg-boss retries). A stale job (the link was replaced by `replaceLink` after its claim) never releases: `replaceLink` read `sendCount = seq + 1` after its version bump and queued the new link under that seq, so the new-link job claims and sends it whatever the stale job did; the stale job's retry finds `sendCount ≠ seq` and sends nothing (Codex finding 7).

Email copy — subject `{company}: {title}`. Body: `Hello {firstName},` / by type: QUARTERLY `The quarterly report of {company} for {period} is available.` | ANNUAL `The annual financial statements of {company} for fiscal year {fy} are available.` | TAX_K1 `Your Schedule K-1 from {company} for tax year {fy} is available.` | NOTICE `{company} has sent you a notice: {title}.` / button `View` → report URL / `This link is personal to you and is valid until {tokenExpiresAt date}. Please do not forward it.` / `Confidential. Provided under Section 8.3 of the Operating Agreement.` / the 13.6 footer of G9.

**Public procedures (`memberReportView`, `withoutAuth`).** `resolveRecipient(db, token)` mirrors G8 exactly: (1) input `token` 20–2048 chars; (2) `verifyReportToken` (purpose `"mr"`) else `NOT_FOUND`; (3) `memberReportRecipient.findUnique({ where: { id }, include: { report: { include: { company } } } })` else `NOT_FOUND`; (4) company is LLC and report `status === "SENT"` else `NOT_FOUND`; (5) revoked or version mismatch → `REPLACED`; (6) expired → `NOT_FOUND`. Company, report and holder always come from the recipient row.

| Procedure | Input | Output |
|---|---|---|
| `memberReportView.view` (query) | `{ token }` | `{ state: "REPLACED", company }` or `{ state: "OK", company: { name, logo }, recipient: { name }, report: { title, type, noticeKind, periodStart, periodEnd, sentAt, figures | null, doc }, attachments: { id, name, kind, private: boolean }[] }` where attachments are ONLY those with `stakeholderId === null` or `=== recipient.stakeholderId`. |
| `memberReportView.markViewed` (mutation) | `{ token }` | sets `firstViewedAt` if null, `viewCount + 1`; `{ ok: true }` |
| `memberReportView.attachmentUrl` (query) | `{ token, attachmentId: string }` | Loads the attachment with `where: { id: attachmentId, reportId: recipient.reportId, OR: [{ stakeholderId: null }, { stakeholderId: recipient.stakeholderId }] }` else `NOT_FOUND`; loads the bucket; `assertKeyReadableByCompany(bucket.key, company)`; returns `{ url }` from `getPresignedGetUrl`. |

**Acceptance.**
- A Financial-Interest-only holder is never a recipient of a QUARTERLY, ANNUAL or NOTICE report (test with fay) and is a recipient of TAX_K1 when a K-1 is attached for fay.
- A suspended Member (sam) IS a recipient of QUARTERLY/ANNUAL/NOTICE.
- Holder A's token cannot obtain a URL for holder B's K-1 (`NOT_FOUND`), nor for an attachment of another report.
- A ballot token is rejected by every `memberReportView` procedure and a report token by every `ballot` procedure.
- Sending a QUARTERLY report for 2026 Q4 marks `QUARTERLY_REPORT:2026Q4` DONE with a link to the report.
- Re-running the email job with the same `seq` sends nothing.

**Do not touch.** `src/trpc/routers/update/**`, `src/jobs/share-update-email.ts`.

---

### G13 — Member reports UI, PDF, filing, public page

**Prerequisites.** G12, G10 (`RichTextEditorLazy`), G9 (`fileGeneratedPdf`, `RichDocPdf`).

**Files.** Create `src/components/governance/report-table.tsx`, `report-editor.tsx`, `report-figures-form.tsx`, `report-attachments.tsx`, `report-recipient-table.tsx`, `report-view.tsx`; `src/pdf-templates/governance/report-pdf.tsx`; `src/jobs/governance-report-file.ts`; pages `src/app/(authenticated)/(dashboard)/[publicId]/reports/page.tsx` (replace the stub), `reports/[reportPublicId]/page.tsx`, `src/app/member-reports/[token]/page.tsx`. Edit `src/trpc/routers/member-report-router/procedures/send.ts` (emit the filing job after commit) and `src/jobs/register.ts` (one line).

**`report-view.tsx`** (Server-Component-safe, used by the public page, the SENT view and as the layout reference for the PDF): title, period line, then for QUARTERLY/ANNUAL a two-column table in this fixed order — Revenue; Utilization; Expenses (total, then category lines indented); Management Fee (accrued; paid); Reserve balance; Distributions (total, then Preferred Return / Return of capital / Residual; or "No distribution this quarter"); then the table "Amounts paid to or through the Manager and its Affiliates" (date, payee, purpose, amount; or "None in this period"); each item's note under it; then `RichDocView` of the commentary; then the footer "Confidential. Provided to Members of {company} under Section 8.3 of the Operating Agreement." Money formatted with `formatCents` (`$1,234.56`); utilization `82.50%` from basis points. The manager-payments table has a Flow column ("To" / "Through") and, when present, the sub-lists "Distributions to the Manager, its Affiliates and related holders" and "Loan repayments to them", then the grand total.

**`report-pdf.tsx`**: `renderReportPdf(data): Promise<Buffer>`; same content and order as `report-view.tsx`, built-in Helvetica only, plus the list of attachment names that are visible to all recipients (private K-1 files are never listed), footer `{company} · {title} · document hash {first 16 of frozenHash} · page n of N`.

**Job `governance.report-file`** — data `{ reportId }`, `singletonKey "report-file-" + reportId`. If `status === "SENT"` and `filedDocumentId` is null: render; `fileGeneratedPdf` with `keyPrefix "member-reports"`, `tag TAG.MEMBER_REPORT`, category by type — QUARTERLY and ANNUAL → `FINANCIAL_STATEMENTS` with `recordYear = fiscalYear`; TAX_K1 → `TAX_RETURNS` with `recordYear = fiscalYear`; NOTICE → `OTHER_STATUTORY` with the year of `sentAt`; conditional update of `filedDocumentId`; Audit `memberReport.filed`. For ANNUAL also create one `Document` (same company, `recordCategory FINANCIAL_STATEMENTS`, `recordYear`) for each `BALANCE_SHEET` / `INCOME_STATEMENT` attachment's bucket, skipping buckets that already have a Document of the company. K-1 files are never turned into Documents.

**Pages.**

1. `/[publicId]/reports`: `PageLayout` "Reports" / "Quarterly and annual reports, Schedules K-1 and notices to Members (Section 8.2)". Action: dropdown "New" → Quarterly report (dialog: fiscal year + quarter, default the most recently ended quarter), Annual financial statements (fiscal year), Schedule K-1 delivery (fiscal year), Notice (kind select). `ReportTable`: Title, Type, Period, Due (red when overdue and not sent), Status, Sent, Viewed `{viewedCount}/{recipientCount}`. Empty state: "No reports yet."
2. `/[publicId]/reports/[reportPublicId]`: DRAFT → `ReportEditor`; SENT → header + `ReportView` (frozen content) + `ReportRecipientTable` + attachments + filed document link.
   - `ReportEditor` (`"use client"`): title input; `ReportFiguresForm` (QUARTERLY/ANNUAL): one fieldset per figure with the prefilled amount, a note field, the line "From the ledger as of {fetchedAt}" and a "Refresh from ledger" button (`memberReport.refreshFigures`); utilization is a percent input (stored as basis points) prefilled with the ledger's average for the period and editable; money inputs follow FOUNDATION's convention (`NumericFormat`, submit integer cents); distributions has a "No distribution this quarter" checkbox; manager payments: read-only prefilled rows, "Add line", and the checkbox "None in this period" (enabled only when there are no lines). Commentary: `RichTextEditorLazy`. `ReportAttachments`: upload with the browser `uploadFile(file, { identifier: companyPublicId, keyPrefix: "generic-documents" })` from `@/common/uploads`, then `api.bucket.create`, then `memberReport.addAttachment` (model: `documents/document-upload-button.tsx` and `src/components/modals/document-upload-modal.tsx`); kind select (ANNUAL: General / Balance sheet / Income statement; others: General). TAX_K1: instead of the generic uploader, a table of `candidates` (name, status chip "Member" or "Financial Interest only", K-1 file or an upload button) — each upload is an attachment of kind `K1` private to that holder. Checklist panel (`get.checklist`) with green/red items and their OA section. Buttons: Save, Delete, "Review and send" → dialog listing recipients (from `candidates`), the sentence "Reports go to admitted Members only. Holders of a Financial Interest only are not sent this report (Sections 1.8, 7.9.2)." (or for TAX_K1: "Each holder receives only its own Schedule K-1."), and "Send to {n}". For QUARTERLY and ANNUAL the dialog also says: "Sending closes the books through {periodEnd}: ledger entries dated on or before that day can no longer be changed." For a transfer-notice copy it says: "Sent to the other Preferred Members only (Section 7.1 / 7.2)."
   - `ReportRecipientTable`: Name, Email, Sent, Delivery state (from `EmailLog`, "Not delivered" in red), First viewed, Views, actions Resend / Replace link.
3. `src/app/member-reports/[token]/page.tsx`: metadata as the ballot page (title "Member report"); `api.memberReportView.view` or `notFound()`; `SharePageLayout`; `REPLACED` card as in G11; otherwise `ReportView` + "Documents" list (each a button calling `memberReportView.attachmentUrl` then `window.open`), private files marked "Only visible to you". A small client component calls `markViewed` on mount.

**Acceptance.**
- A QUARTERLY report cannot be sent until all seven checklist items are green; an ANNUAL report cannot be sent without a balance sheet and an income statement.
- The public page for holder A lists A's K-1 and not B's.
- After sending, one PDF Document exists with the category above, and the calendar deadline is DONE.
- The `/reports` stub text "Coming soon..." is gone.

**Do not touch.** `src/components/update/**`.

---

### G14 — Compliance calendar backend and daily sweep

**Goal.** `ComplianceDeadline` rows generated from rules, kept in sync idempotently, reminded by email, and completed by the report, resolution or document that satisfied them.

**Prerequisites.** G3, G4, G6 (`listManagerUsers`); ECONOMICS E19 `getComplianceDates` (E2; if absent, sync only the rule-based deadlines and leave a clearly marked integration point); FOUNDATION F10 `sendMail`.

**Files.** Create `src/lib/governance/compliance-core.ts`, `compliance-core.test.ts`, `src/server/governance/compliance.ts`, `src/trpc/routers/compliance-router/{router.ts,schema.ts,procedures/{list,create-custom,update,complete,reopen,not-applicable}.ts}`, `src/jobs/governance-daily-sweep.ts`, `src/emails/ComplianceDigestEmail.tsx`; two lines in `src/jobs/register.ts`.

**Rules** (every rule: key, trigger, date computation, section, what completes it).

| ruleKey | Trigger | `dueOn` | Section | Completed by | Created by |
|---|---|---|---|---|---|
| `QUARTERLY_REPORT` | each fiscal quarter ending on or after the first Member's `admittedOn` | quarter end + 45 calendar days | 8.2; 5.6(a) | sending the QUARTERLY report for that quarter (G12) | `generateRuleDeadlines` (G3) |
| `ANNUAL_FINANCIALS` | each fiscal year ending on or after the first admission | December 31 + 90 calendar days | 8.2 | sending the ANNUAL report | G3 |
| `K1_TARGET` | each such fiscal year | March 31 of the next year | 8.2 | sending the TAX_K1 report | G3 |
| `K1_FINAL` | each such fiscal year | September 15 of the next year (assumed extended Form 1065 date; editable) | 8.2 | sending the TAX_K1 report | G3 |
| `PO_RESOLUTION_COPY` | a PURCHASE_ORDER resolution becomes EFFECTIVE (signed) | signing date + 10 business days | 6.16(i)(B) | all copy emails logged (G9) | G6 `evaluateAndTransition` |
| `TRANSFER_NOTICE_COPY` | a VOLUNTARY or INVOLUNTARY transfer is recorded | notice received + 5 business days | 7.1; 7.2 | sending the NOTICE report created from the transfer (G16) | G16 |
| `TRANSFER_ROFR_MANAGER` | same | notice received + 45 days | 7.1; 7.2 | recording the ROFR outcome, or completing/cancelling the transfer | G16 |
| `TRANSFER_ROFR_MEMBERS` | same | notice received + 90 days | 7.1; 7.2 | same | G16 |
| `TRANSFER_CLOSE_BY` | VOLUNTARY transfer | notice received + 270 days | 7.1 | completing/cancelling the transfer | G16 |
| `TRANSFER_PURCHASE_CLOSE` | a purchase price is recorded as finally established | that date + 45 days | 7.7 | completing/cancelling the transfer | G16 |
| ECONOMICS kinds (dedupe key `E:` + its `key`) | every item of `getComplianceDates` except kind `QUARTERLY_REPORT_DEADLINE` (governance's own `QUARTERLY_REPORT` rule is authoritative) and status `INFO`: `DISTRIBUTION_DEADLINE` (5.6(a)), `CALL_NOTICE_DUE` and `BALANCE_OUTSIDE_DATE` (4.9), `FORFEITURE_DATE`, `CREDIT_DATE`, `REPLACEMENT_FUNDER_OUTSIDE_DATE` (4.9), `OCD_NOTICE_DUE` (1.21, OCD + 10 business days), `EXTENSION_REQUEST_DUE` (2.5, Target Sale Date − 9 months), `TARGET_SALE_DATE` (2.4), `MEMBER_LOAN_MATURITY` (4.6) | `dueOn` as returned | `oaSection` as returned | ECONOMICS status `DONE`; `EXTENSION_REQUEST_DUE` also by sending a TERM_EXTENSION resolution (G7 step 15); or manual | sync |
| `CUSTOM` | Manager user | entered, or trigger date + template offset | optional | manual | `compliance.createCustom` |

Custom templates (`CUSTOM_DEADLINE_TEMPLATES` in `compliance-core.ts`; the user enters the trigger date; "BD" offsets use `addBusinessDays`):

| key | Title | Offset from trigger | Section |
|---|---|---|---|
| `TAX_PROCEEDING_NOTICE` | Notify Members of audit or tax proceeding | +10 days from receipt of notice | 9.2 |
| `SPECIAL_MEETING_NOTICE` | Give notice of the requested special meeting | +10 days from a valid request | 6.4 |
| `SPECIAL_MEETING_HELD` | Hold the requested special meeting | +60 days from the request | 6.4 |
| `MANAGER_RESIGNATION_EFFECTIVE` | Manager resignation notice period ends | +90 days from the notice | 6.20 |
| `SUCCESSOR_ACCEPTANCE` | Successor Manager must accept or the LLC dissolves | +180 days from the resignation notice | 6.20; 11.1(e) |
| `PO_TITLE_DOCUMENTS` | Deliver vendor invoice, proof of payment and bill of sale to the LLC | +10 BD from the vendor payment | 6.16(i)(2) |
| `PO_FUNDS_REMIT` | Remit LLC funds held as purchasing agent to the vendor | +5 BD from receipt of the funds | 6.16(e) |
| `SUBSCRIPTION_ACCEPTANCE` | Accept the subscription or return the unaccepted part | +10 BD from receipt of signature page and Initial Installment | 4.8 |
| `STATE_ANNUAL_REPORT` | Wyoming annual report (statutory; not in the Operating Agreement) | date entered | — |
| `FORM_1065` | File Form 1065 or an extension (statutory) | date entered | — |

**`compliance-core.ts` (pure).**

```ts
export interface ExistingDeadline { id: string; dedupeKey: string; dueOn: Ymd; title: string; status: "OPEN" | "DONE" | "NOT_APPLICABLE"; source: string }
export interface IncomingDeadline { ruleKey: string; dedupeKey: string; title: string; section: string | null; dueOn: Ymd; source: "RULE" | "ECONOMICS"; done: boolean }
export function planDeadlineSync(existing: ExistingDeadline[], incoming: IncomingDeadline[]): {
  create: IncomingDeadline[];
  update: { id: string; dueOn: Ymd; title: string; resetReminders: boolean }[];
  complete: string[]; // ids
};
export const CUSTOM_DEADLINE_TEMPLATES: Record<string, { title: string; section: string | null; offset: { days?: number; businessDays?: number } | null }>;
```

Rules: an incoming key not in `existing` → create (if `done` → created and listed in `complete` afterwards by the caller, i.e. create it then complete it). Existing `OPEN` with a different `dueOn` or title → update with `resetReminders = dueOn changed`. Existing `OPEN` and incoming `done` → complete. Existing `DONE` or `NOT_APPLICABLE` → never touched. Existing rows whose key is no longer incoming → never deleted. `CUSTOM`, `RESOLUTION` and `TRANSFER` rows are ignored by the sync.

Tests: (1) empty existing + the 7 specs of G3 test 14 → 7 creates; second run with those as existing → nothing; (2) existing `E:TARGET_SALE_DATE` OPEN `2031-11-30`, incoming `2032-11-30` → one update with `resetReminders: true`; (3) existing DONE with a different incoming date → nothing; (4) existing OPEN, incoming `done: true` → in `complete`; (5) an existing key missing from incoming → nothing.

**`compliance.ts` (server).** `syncComplianceDeadlines(tx, companyId, now)`: `firstAdmittedOn` = earliest non-null `Stakeholder.admittedOn` of the company among `memberStatus = MEMBER`; `today = todayInZone(now)`; incoming = `generateRuleDeadlines({ firstAdmittedOn, today, horizonDays: 400 })` (source RULE) + ECONOMICS `getComplianceDates(tx, companyId, { from: addDays(today, -30), to: addDays(today, 400) })` filtered (drop `kind === "QUARTERLY_REPORT_DEADLINE"` and `status === "INFO"`) and mapped to `{ ruleKey: kind, dedupeKey: "E:" + key, title: label, section: oaSection, dueOn, source: "ECONOMICS", done: status === "DONE" || status === "NOT_REQUIRED" }`; apply `planDeadlineSync` (creates through `createMany({ skipDuplicates: true })`; `resetReminders` sets `remindedBuckets = []`; completes set `DONE`, `completedAt`, `satisfiedByType "MANUAL"`, `note "Completed according to the ledger"`). Also exported: `upsertSourceDeadline(tx, { companyId, ruleKey, dedupeKey, title, section, dueOn, source, sourceType, sourceId })` and `closeSourceDeadlines(tx, { companyId, sourceType, sourceId, status, note, exceptRuleKeys? })` used by G6 and G16.

**Procedures** (`withAccessControl`, `loadLlcCompany`, rows always `where: { id, companyId }`).

| Procedure | RBAC | Input | Behaviour | Audit |
|---|---|---|---|---|
| `compliance.list` (query) | read | `{ includeClosed?: boolean }` | Runs `syncComplianceDeadlines` in a transaction, then returns rows ordered by `dueOn`: all OPEN, plus DONE/NOT_APPLICABLE of the last 400 days when `includeClosed`. Each row adds `daysLeft` and `satisfiedBy: { type, label, href } | null` (resolved: RESOLUTION → reference + title → `/resolutions/{publicId}`; MEMBER_REPORT → title → `/reports/{publicId}`; DOCUMENT → name). | — |
| `compliance.createCustom` | create | `{ title (1–200), dueOn?: Ymd, templateKey?: string, triggerOn?: Ymd, section?: string (0–50), description?: string (0–2000) }` | Either `dueOn`, or `templateKey` + `triggerOn` (due computed from the template offset; business-day offsets through `addBusinessDays`). `dedupeKey = "CUSTOM:" + cuid`. | `compliance.created` |
| `compliance.update` | update | `{ id, title?, dueOn?: Ymd, description? }` | OPEN only. Title editable only for `CUSTOM`; `dueOn` editable for `CUSTOM` and `K1_FINAL`. Changing `dueOn` resets `remindedBuckets`. | `compliance.updated` |
| `compliance.complete` | update | `{ id, satisfiedByType: "RESOLUTION" | "MEMBER_REPORT" | "DOCUMENT" | "MANUAL", satisfiedByPublicId?: string, note?: string (0–1000) }` | OPEN only. For the three linked types resolve the row by `{ publicId, companyId }` (else `NOT_FOUND`) and store its id; MANUAL requires a non-empty note. | `compliance.completed` |
| `compliance.reopen` | update | `{ id }` | DONE or NOT_APPLICABLE → OPEN; clears the completion fields. | `compliance.reopened` |
| `compliance.markNotApplicable` | update | `{ id, note (1–1000) }` | OPEN only. | `compliance.updated` |

**Daily sweep job.** `governance.daily-sweep`, schema `z.object({})`, registered with `queueManager.schedule({ name: "governance.daily-sweep", cron: "0 7 * * *", tz: "America/Denver" })`. (The cron's zone is fixed for the whole installation; inside the handler each company's `today` is computed in its own `Company.timezone`.) Handler, for each company with `entityType = LLC`:
1. `syncComplianceDeadlines` in a transaction.
2. Load OPEN deadlines; for each compute `bucket = reminderBucket(dueOn, today)`; keep those with `bucket !== null && !remindedBuckets.includes(bucket)`.
3. If any: send ONE digest email per Manager user (`listManagerUsers`) with `sendMail(…, { kind: "compliance.digest", companyId, relatedType: "complianceDeadline", relatedId: <first deadline id> })`, then for each included deadline `update({ remindedBuckets: { push: bucket }, lastReminderAt: now })`.
4. A failure for one company is logged and does not stop the others; rethrow at the end if any failed so pg-boss retries (already-recorded buckets are skipped on retry).

Digest email — subject `{company}: {n} compliance deadline(s) need attention`. Body: `Hello {firstName},` / a table with columns Due, Item, Section, Status where Status is `Overdue by {k} day(s)` | `Due today` | `Due in {k} day(s)`, overdue rows first / button `Open the compliance calendar` → `/{companyPublicId}/compliance` / `You receive this because you administer {company}. Reminders are sent 30, 14, 7, 3 and 1 day(s) before a deadline, on the day, and weekly while overdue.`

**Acceptance.**
- With the first admission on 2026-11-20 and today 2026-11-25, `compliance.list` shows exactly the seven rule deadlines of G3 test 14 (plus any ECONOMICS rows); calling it again creates nothing.
- Running the sweep twice on the same day sends one digest, not two.
- Completing with a `satisfiedByPublicId` of another company's resolution fails with `NOT_FOUND`.
- On app start the log shows `Scheduling job:governance.daily-sweep (0 7 * * *)` and no queue error.

---

### G15 — Compliance calendar UI

**Prerequisites.** G14.

**Files.** `src/components/governance/compliance-table.tsx`, `compliance-dialogs.tsx`; page `src/app/(authenticated)/(dashboard)/[publicId]/compliance/page.tsx`.

**Page `/[publicId]/compliance`** (Server Component + client table; model: the documents page). `PageLayout` "Compliance calendar" / "Deadlines under the Operating Agreement, with reminders to the Manager". Action "Add deadline". Body: four groups, each a table — "Overdue" (red), "Next 30 days", "Later", "Completed and not applicable" (collapsed; loaded with `includeClosed`). Within a group rows are ordered by date under month sub-headings ("February 2027"). Columns: Due (long date + "in 12 days" / "3 days overdue"), Item, Section (`Section 8.2`), Source (Rule / Ledger / Resolution / Transfer / Manual), Satisfied by (link) or note, Actions.

Actions per row: "Mark done" → dialog with a radio: "A report" (select of SENT reports, newest first), "A resolution" (select of non-draft resolutions), "A document" (select of documents), "Other" (required note); primary action for known rules is a shortcut: QUARTERLY_REPORT / ANNUAL_FINANCIALS / K1_* → "Create report" (`memberReport.create` with the period, then navigate); `E:` extension-request row → "Create term-extension resolution" (`/resolutions/new` with the type preselected); TRANSFER_NOTICE_COPY → link to the transfer. "Not applicable" (required note). "Reopen" on closed rows. "Edit" for CUSTOM rows and the K1_FINAL date.

"Add deadline" dialog: template select (the table in G14, plus "Custom"), trigger date or due date, title (prefilled from the template), description; shows the computed due date before saving.

Empty state: "No deadlines yet. Deadlines appear once the first Member is admitted."

**Acceptance.** The four groups render with the G14 acceptance data; marking a quarterly deadline done by selecting a sent report shows the report title as a link; an overdue item is in the red group.

---

### G16 — Unit transfers backend

**Goal.** Record a transfer under Section 7 with its dates, consents and checklist; move the units through ECONOMICS; keep the transferee a Financial-Interest-only holder until admitted. Lean: no pricing engine, no pro-rata allocation.

**Prerequisites.** G3, G4, G6 (`loadUnitPositions`), G12 (NOTICE report), G14 (`upsertSourceDeadline`); FOUNDATION F6 (`src/server/llc/positions.ts`, `admitStakeholder`); ECONOMICS E7 (`applyUnitTransfer` and `loadCompletedTransfers` in `src/server/llc/economics/transfers.ts`).

**How units move (agreed with both sibling plans).** Nobody writes ledger rows for a transfer. A `UnitTransfer` with `status = COMPLETED` IS the ledger entry; both sibling position functions read it:
- FOUNDATION asked (its E3.1) that `getMemberPositions` fold transfers in. Edit `src/server/llc/positions.ts`: after the existing in-memory merge, load `tx.unitTransfer.findMany({ where: { companyId, status: "COMPLETED", effectiveOn: { lte: <asOf, or today in the company time zone when no asOf is given> } }, orderBy: [{ effectiveOn: "asc" }, { completedAt: "asc" }] })` and apply each in order to the rows of its `unitClassId`: with `N` = the transferor's units immediately before this transfer and `n` = the transferred units (both in micro-units), move `units` by exactly `n`; move `capitalCents` and `cashAppliedCents` by `mulDivRoundHalfUp(x, n, N)` (FOUNDATION `src/lib/money.ts`); leave `committedCents`, `pendingCommittedCents`, `heldCents` and `outstandingBalanceCents` with the transferor (Section 7.9.2: a transfer does not release the unpaid Balance); create the transferee's row for that class with zeros when it has none (`firstAcceptedOn: null`). `N = 0` or `n > N` → throw (data integrity). Add tests beside the file: carol 150.000000 units / $150,000.00 capital transfers 50 effective 2027-07-01 → as of 2027-06-30 carol 150 / transferee 0; as of 2027-07-01 carol 100.000000 / $100,000.00 and transferee 50.000000 / $50,000.00; a second transfer of 25.5 of carol's remaining 100 → carol 74.500000 / $74,500.00.
- ECONOMICS reads the same rows itself: its `loadCompletedTransfers` selects `UnitTransfer` rows with `status = "COMPLETED"`, `unitClassKind = "PREFERRED"`, `effectiveOn` and `toStakeholderId` set, ordered by `effectiveOn`, `createdAt`, and moves capital lots, Unreturned Capital and accrued Preferred Return pro rata (its R39). Governance does not edit that file; it must keep those six columns meaning exactly this. ECONOMICS `getPositions` cross-checks its units against `getMemberPositions` and throws on a mismatch, so the FOUNDATION fold-in above must be merged and deployed BEFORE the first transfer is completed (G16b ships the fold-in and `complete` together).
- The fold-in is in session G16b and is the only change governance makes to a sibling file in this package.

**Files.** `src/lib/governance/transfer-core.ts`, `transfer-core.test.ts`, `src/trpc/routers/unit-transfer-router/{router.ts,schema.ts,procedures/{list,get,create,update,create-notice-copy,complete,admit,cancel}.ts}`.

**`transfer-core.ts` (pure).**

```ts
export interface TransferState { /* the UnitTransfer scalar fields as plain values (dates as Ymd | null, units as string) */ }
export interface CompletionContext {
  today: Ymd;
  fromUnits: string;                 // transferor's units of that class as of today (ECONOMICS)
  toMemberStatus: string | null;     // null when no transferee selected
  linkedResolution: { status: string; matterKey: string | null } | null;
}
export function completionErrors(t: TransferState, ctx: CompletionContext): string[];
export function admissionErrors(t: TransferState): string[];
export function initialFlags(kind: TransferState["kind"]): { rofrOutcome: string; managerConsent: string };
```

`initialFlags`: VOLUNTARY → `{ PENDING, PENDING }`; INVOLUNTARY → `{ PENDING, NOT_REQUIRED }`; PERMITTED_TRANSFEREE and DEATH_INCAPACITY → `{ NOT_APPLICABLE, NOT_REQUIRED }`.

`completionErrors` (each failed rule adds its message; empty array = may complete):
1. `status !== "OPEN"` → "This transfer is closed."
2. `toStakeholderId` null → "Select the transferee." ; `toStakeholderId === fromStakeholderId` → "Transferor and transferee must differ."
3. `units` ≤ 0 or > `fromUnits` → "The transferor holds only {fromUnits} units."
4. `transferNoticeOn` null → "Enter the date the Manager received written notice of the transfer (Section 7.9.1)." ; `transferNoticeOn > today` → "The notice date cannot be in the future."
5. VOLUNTARY (R31): `managerConsent !== "GRANTED"` → "The Manager's written consent is required (Section 7.1)."; `rofrOutcome` in `PENDING`/`NOT_APPLICABLE` → "Record the outcome of the right of first refusal (Section 7.1)."; `rofrOutcome === "NOT_EXERCISED"` and `rofrDecidedOn < memberRofrEndsOn` and `rofrNote` empty → "The 90-day refusal period has not ended. Add a note that every holder of the right waived it in writing."; `rofrOutcome === "NOT_EXERCISED"` and `transferNoticeOn > closeByOn` → "The 180-day period to complete the transfer has ended (Section 7.1). A new Transfer Notice is required."
6. VOLUNTARY and PERMITTED_TRANSFEREE (R39): `securitiesOpinion` null → "Record the opinion of counsel or the Manager's waiver (Section 7.6)."
7. `unitClassKind === "COMMON"` (R38): not (`exemptUnder71` with non-empty `exemptNote`) and not (`linkedResolution` with `status === "EFFECTIVE"` and `matterKey === "COMMON_TRANSFER_OR_CONTROL"`) → "A transfer of Common Units requires the approval of a Preferred Supermajority (Section 7.1)."
8. `toMemberStatus === "MEMBER"` (transferee is already a Member) and `admissionErrors(t).length > 0` → "The transferee is already a Member: complete the admission checklist for these Units (Section 7.8) before completing." (A stakeholder cannot be a Member for some Units and a Financial-Interest holder for others in this data model.)

`admissionErrors` (R36): `admissionSignaturePage` false → "Exhibit B signature page not received (7.8(a))."; `admissionExpensesPaid` false → "Admission expenses not paid or waived (7.8(b))."; `admissionQualified` false → "Qualification not confirmed (7.8(c))."; `kind !== "PERMITTED_TRANSFEREE"` and `admissionManagerConsent` false → "Manager consent to admission not recorded (7.8(d))."

Tests (`transfer-core.test.ts`): (1) VOLUNTARY fully in order (consent GRANTED, ROFR NOT_EXERCISED decided 2027-05-31 with `memberRofrEndsOn 2027-05-30`, `transferNoticeOn 2027-06-10`, `closeByOn 2027-11-26`, opinion WAIVED, 50 of 150 units) → `[]`; (2) same with consent PENDING → 1 error; (3) ROFR decided 2027-04-01 without note → error; with note → none; (4) `transferNoticeOn 2027-12-01` → the 180-day error; (5) units 200 of 150 → error; (6) PERMITTED_TRANSFEREE with no consent and ROFR NOT_APPLICABLE and opinion RECEIVED → `[]`; (7) DEATH_INCAPACITY with nothing but transferee, units and notice date → `[]`; (8) COMMON without resolution or exemption → error; with an EFFECTIVE linked resolution of matter `COMMON_TRANSFER_OR_CONTROL` → none; (9) transferee already MEMBER with incomplete checklist → error; (10) `admissionErrors` for PERMITTED_TRANSFEREE ignores Manager consent.

**Procedures** (`withAccessControl`, `loadLlcCompany`; transfers loaded by `{ publicId, companyId }`; every stakeholder id through `assertCompanyOwns`).

| Procedure | RBAC | Input | Behaviour | Audit |
|---|---|---|---|---|
| `unitTransfer.list` | read | `{ status? }` | Rows + transferor/transferee names. | — |
| `unitTransfer.get` | read | `{ publicId }` | Transfer, names, computed `completionErrors`, `admissionErrors`, its deadlines, the notice-copy report (`{ publicId, status, sentAt }`), transferor's current units. | — |
| `unitTransfer.create` | create | `{ kind, fromStakeholderId, toStakeholderId?, unitClassId, units (decimal string, 6 dp, > 0), noticeReceivedOn: Ymd (≤ today), proposedPriceCents?: number (integer ≥ 0), terms?: string (0–4000), bonaFideOffer?: boolean, notes? }` | `assertCompanyOwns`; load the unit class by `{ id: unitClassId, companyId }` (FOUNDATION `UnitClass`) and copy its kind; units ≤ transferor's current units of that class; `computeTransferDates`; `initialFlags`; insert. Deadlines via `upsertSourceDeadline` (source `TRANSFER`, sourceType `UNIT_TRANSFER`): `TRANSFER_NOTICE_COPY:{id}`, `TRANSFER_ROFR_MANAGER:{id}`, `TRANSFER_ROFR_MEMBERS:{id}` for VOLUNTARY and INVOLUNTARY; `TRANSFER_CLOSE_BY:{id}` for VOLUNTARY. Returns `{ publicId }`. | `unitTransfer.created` |
| `unitTransfer.update` | update | `{ publicId, toStakeholderId?, proposedPriceCents?, terms?, bonaFideOffer?, rofrOutcome?, rofrDecidedOn?, rofrNote?, managerConsent?, managerConsentOn?, managerConsentNote?, securitiesOpinion?, priceEstablishedOn?, transferNoticeOn?, requiredResolutionPublicId?, exemptUnder71?, exemptNote?, admissionSignaturePage?, admissionExpensesPaid?, admissionQualified?, admissionManagerConsent?, notes? }` | OPEN only (the four admission flags also while COMPLETED and not yet admitted). `kind`, transferor, class, units and `noticeReceivedOn` are immutable (cancel and re-create instead). Recompute `purchaseCloseByOn`/`effectiveOn` with `computeTransferDates`; `priceEstablishedOn` set → upsert `TRANSFER_PURCHASE_CLOSE:{id}`; `rofrOutcome` leaving PENDING → mark the two ROFR deadlines DONE (note = outcome). `requiredResolutionPublicId` resolved by `{ publicId, companyId }`. `managerConsent` values allowed only for VOLUNTARY. | `unitTransfer.updated` |
| `unitTransfer.createNoticeCopy` | create | `{ publicId }` | VOLUNTARY/INVOLUNTARY, OPEN, no `noticeCopyReportId` yet. Creates a DRAFT `MemberReport` of type NOTICE, `noticeKind` `TRANSFER_NOTICE_COPY` or `INVOLUNTARY_TRANSFER`, `relatedType "COMPLIANCE_DEADLINE"`, `relatedId` = the `TRANSFER_NOTICE_COPY:{id}` deadline id, commentary prefilled with paragraphs: "Under Section {7.1 | 7.2} of the Operating Agreement the Manager delivers this copy of a {Transfer Notice | notice of an Involuntary Transfer} received on {noticeReceivedOn}.", "Transferring Member: {name}. Units: {units} {Preferred | Common} Units. Proposed transferee: {name or 'not named'}. Proposed price and terms: {formatCents(proposedPriceCents) and terms, or 'see attached'}.", "The Manager (or its designee) may {exercise a right of first refusal | exercise a purchase option} until {managerRofrEndsOn}; if it does not, the other Preferred Members may do so, in proportion to their Preferred Units, until {memberRofrEndsOn}." Stores `noticeCopyReportId`. Returns `{ reportPublicId }`. The Manager user attaches the notice itself and sends the report from the report page; `memberReport.send` restricts the recipients to the other Preferred Members by itself (G12 step 2). Sending completes the deadline through G12 step 5. | `unitTransfer.updated` |
| `unitTransfer.complete` | update | `{ publicId }` | Transaction: reload; `effectiveOn = firstOfFollowingMonth(transferNoticeOn)`; build `CompletionContext` (`fromUnits` = the transferor's units of that class from `loadUnitPositions(tx, companyId, effectiveOn)`, so earlier completed transfers are already deducted); `completionErrors` non-empty → `BAD_REQUEST` with the messages joined by a line break. `await applyUnitTransfer(tx, { companyId, unitTransferId, fromStakeholderId, toStakeholderId, unitClassId, units, effectiveOn: ymdToUtcDate(effectiveOn) })` (ECONOMICS `transfers.ts`; validation only, writes nothing: it refuses a date inside closed books and a transferor holding too few units as of `effectiveOn`) — call it BEFORE the status update, in the same transaction. Transferee `memberStatus`: PROSPECT → set `FINANCIAL_INTEREST_ONLY` (R37; direct update of that one field with Audit `stakeholder.updated`, as FOUNDATION E3.2 specifies); FINANCIAL_INTEREST_ONLY → unchanged; MEMBER → unchanged and set `admittedOn` on the transfer to today (rule 8 guaranteed the checklist). Status `COMPLETED`, `effectiveOn`, `completedAt`, `completedById` — from this commit both position functions include the transfer for dates on or after `effectiveOn`. `closeSourceDeadlines` for this transfer → `NOT_APPLICABLE` with note "Transfer completed", except `TRANSFER_NOTICE_COPY`. | `unitTransfer.completed` |
| `unitTransfer.admit` | update | `{ publicId, admittedOn: Ymd }` | COMPLETED only; `admittedOn` (transfer) null; `admissionErrors` empty else `BAD_REQUEST`; `admittedOn >= effectiveOn` and ≤ today; call FOUNDATION `admitStakeholder(tx, { companyId, stakeholderId: toStakeholderId, admittedOn }, actor)` (`src/server/llc/commitments.ts`, F6a); store `admittedOn`. From this moment the transferee's units are outstanding for new record dates (R2). | `unitTransfer.admitted` |
| `unitTransfer.cancel` | update | `{ publicId, reason (1–500) }` | OPEN only → `CANCELLED`; close its deadlines as NOT_APPLICABLE ("Transfer cancelled"), except `TRANSFER_NOTICE_COPY`. | `unitTransfer.cancelled` |

Notes for the executor:
- `proposedPriceCents` is a `BigInt` column: convert with `BigInt(input)` on write and `Number(row.proposedPriceCents)` in every procedure output (FOUNDATION B1: cents cross the wire as numbers).
- The transferee must already exist as a Stakeholder of the company (created on FOUNDATION's Members page as a prospect). This package never creates Stakeholders (A10: `Stakeholder.email` is globally unique; FOUNDATION's form already handles that error).
- The company can never be a transferee (R40): there is no input that could name it.
- Snapshots already taken are not affected by a transfer (R13).

**Acceptance.**
- The G3 test-11 dates appear on a VOLUNTARY transfer created with notice date 2027-03-01, and four OPEN deadlines exist.
- `complete` on a fresh VOLUNTARY transfer returns the consent, ROFR, notice-date and opinion messages together.
- After `complete`, a PROSPECT transferee is `FINANCIAL_INTEREST_ONLY`. A resolution with a record date before `effectiveOn` still counts the units with the transferor; one with a record date on or after `effectiveOn` gives the transferee no ballot and leaves the transferred units out of the denominator (R2); after `admit`, a new resolution includes them.
- `effectiveOn` for `transferNoticeOn = 2027-01-31` is `2027-02-01`.

**Do not touch.** Anything in sibling areas except the two functions named above; FOUNDATION's stakeholder router; ECONOMICS ledger tables.

---

### G17 — Unit transfers UI

**Prerequisites.** G16.

**Files.** `src/components/governance/transfer-table.tsx`, `transfer-form.tsx`, `transfer-detail.tsx`; pages `src/app/(authenticated)/(dashboard)/[publicId]/transfers/page.tsx`, `transfers/new/page.tsx`, `transfers/[transferPublicId]/page.tsx`.

- `/[publicId]/transfers`: `PageLayout` "Transfers" / "Transfers of Units under Section 7 of the Operating Agreement"; action "Record a transfer"; table: Date of notice, Type, From, To, Units, Status (Open / Completed / Cancelled, plus "Financial Interest only — not admitted" when completed without admission), Effective. Empty state "No transfers recorded."
- `/transfers/new`: `TransferForm` — Type (four radio cards with one-line explanations: "Sale or other voluntary transfer — Manager consent and right of first refusal (7.1)"; "Transfer to a Permitted Transferee — spouse, descendants, their trust or entity, or an entity Member's owners; notice only (7.1)"; "Involuntary transfer — bankruptcy, divorce, foreclosure, legal process (7.2)"; "Death or incapacity (7.3)"), transferor (select of Members with units), unit class, units (max shown), transferee (select of company Stakeholders, optional, with the hint "Add the transferee as a prospect on the Members page first"), date the notice was received, price, terms, bona fide third-party offer checkbox. Below the form a live preview of the dates from `computeTransferDates` (the 5-business-day date is shown after saving, because the business-day calendar is server-side).
- `/transfers/[transferPublicId]`: `TransferDetail` with sections:
  1. Summary and key dates as a vertical timeline: notice received; copy to Preferred Members due / sent; Manager ROFR (or purchase option) ends; Preferred Members' ROFR ends; last day to complete (voluntary); price established / purchase closing due; written notice of transfer received; effective date.
  2. "Copy to Preferred Members" (voluntary, involuntary): button "Prepare the copy" (`unitTransfer.createNoticeCopy` → navigate to the report draft, where the Manager user attaches the notice and sends it; the server limits the recipients to the other Preferred Members), or, once prepared, the report's status and sent time with a link.
  3. "Right of first refusal" (voluntary) / "Purchase option" (involuntary): outcome select, decided-on date, note.
  4. "Manager consent" (voluntary): Granted / Denied, date, note, with the reminder "Consent may not be unreasonably withheld for a transfer to an accredited investor who signs Exhibit B and satisfies Section 7.8."
  5. "Securities law" (voluntary, permitted): Opinion received / Waived by the Manager.
  6. "Common Units" (class COMMON only): link a resolution (select of resolutions with matter `COMMON_TRANSFER_OR_CONTROL`) or the exemption checkbox + note.
  7. "Complete": date the Manager received written notice of the transfer; computed effective date; the list of `completionErrors` (button disabled while non-empty); button "Record the transfer" with the confirmation "Units move on {effectiveOn}. The transferee will hold a Financial Interest only until admitted as a Substitute Member."
  8. "Admission as Substitute Member (Section 7.8)": four checkboxes (the fourth hidden for Permitted Transferees; for involuntary and death transfers the third is labelled "Legal and regulatory requirements satisfied (accredited-investor status not required)"), admission date, button "Admit as Member".
  9. "Cancel transfer" with reason.

**Acceptance.** Walking a voluntary transfer from creation to admission is possible using only this page and the report page; the status column shows "Financial Interest only — not admitted" between steps 7 and 8.

---

### G18 — Books and records (Section 8.1)

**Goal.** Fixed 8.1 categories on top of Documents, a completeness view, and automatic filing of executed resolutions and reports (the filing itself is already done by G9 and G13).

**Prerequisites.** G4, G9, G13.

**Files.** `src/trpc/routers/books-router/{router.ts,schema.ts,procedures/{overview,uncategorized,categorize}.ts}`, `src/lib/governance/books-core.ts`, `books-core.test.ts`, `src/components/governance/books-overview.tsx`, `books-file-dialog.tsx`, page `src/app/(authenticated)/(dashboard)/[publicId]/documents/books/page.tsx`.

**Categories** (`BOOKS_CATEGORIES` in `books-core.ts`):

| Category | Label | Section | Filled by | Completeness rule |
|---|---|---|---|---|
| `MEMBER_LIST` | Member list (names, addresses, Capital Contributions, Units) | 8.1(a) | the live Members register (FOUNDATION); dated copies may be filed manually | always "Live register" with a link to the Members page; shows the number of filed copies |
| `ARTICLES_AND_AGREEMENT` | Articles of Organization, Operating Agreement and amendments | 8.1(b) | manual upload; effective AMENDMENT resolutions automatically (G9) | complete when at least one document exists |
| `TAX_RETURNS` | Federal, state and local tax or information returns (six fiscal years) | 8.1(c) | manual upload with year; K-1 delivery cover automatically (G13) | one row per required fiscal year: present / missing |
| `FINANCIAL_STATEMENTS` | Financial statements (six fiscal years) | 8.1(d) | annual and quarterly report PDFs and the uploaded balance sheet / income statement automatically (G13); manual upload | per required fiscal year: present / missing |
| `CONSENTS_AND_MINUTES` | Minutes, written consents, waivers of notice, Member votes | 8.1(e) | every executed resolution automatically (G9); manual upload (minutes, externally signed consents, proxies) | count only |
| `OTHER_STATUTORY` | Other records required by the Wyoming LLC Act | 8.1(f) | notices automatically (G13); manual | count only |

`requiredFiscalYears(formationYear: number, currentYear: number): number[]` = the completed fiscal years from `max(formationYear, currentYear − 6)` to `currentYear − 1`. Tests: `(2026, 2026)` → `[]`; `(2026, 2027)` → `[2026]`; `(2026, 2035)` → `[2029, 2030, 2031, 2032, 2033, 2034]`. `formationYear` = year of `Company.incorporationDate`.

**Procedures** (`withAccessControl`, `loadLlcCompany`).

| Procedure | RBAC | Input | Output / behaviour | Audit |
|---|---|---|---|---|
| `books.overview` (query) | `documents: read` | — | `{ categories: { category, label, section, documents: { publicId, bucketId, name, recordYear, createdAt, generated: boolean }[], years: { year, present }[] | null, complete: boolean | null }[] }` (documents `where: { companyId, recordCategory }`; `generated` = bucket tags include `resolution` or `member-report`). | — |
| `books.uncategorized` (query) | `documents: read` | `{ search?: string (0–100) }` | Up to 50 documents of the company with `recordCategory: null`, newest first, name contains `search` (case-insensitive). | — |
| `books.categorize` (mutation) | `documents: update` | `{ documentPublicId, recordCategory: BooksRecordCategoryEnum | null, recordYear: int 2000–2100 | null }` | Document by `{ publicId, companyId }`; `recordYear` required for TAX_RETURNS and FINANCIAL_STATEMENTS; generated documents (see above) cannot be un-categorised or moved (`BAD_REQUEST`). | `document.categorized` |

**Page `/[publicId]/documents/books`.** `PageLayout` "Books and records" / "Records the LLC keeps under Section 8.1 of the Operating Agreement". One card per category in the table order: label, section, completeness chip (Complete / Missing {years} / Live register / {n} documents), the document list (name opens the document as the documents table does; year; "Generated" chip), and "File a document" → `BooksFileDialog` (search uncategorised documents, pick one, pick year when required; hint "Upload new files on the Documents page first"). Manual documents have "Remove from category".

**Acceptance.** After G9/G13 acceptance runs, the executed resolution appears under "Minutes, written consents…" and the annual pack under "Financial statements" for its year without any manual step; filing a manually uploaded Operating Agreement PDF makes `ARTICLES_AND_AGREEMENT` complete; a document of another company cannot be categorised (`NOT_FOUND`).

**Do not touch.** The existing Documents page and table (FOUNDATION adds the sub-navigation entry `/documents/books`).

---

### G19 — Member activity query, cross-area hooks, seed data, end-to-end check

**Prerequisites.** All previous packages.

**Files.** `src/trpc/routers/governance-router/{router.ts,procedures/member-activity.ts}`; `src/components/governance/member-activity-tab.tsx`; the sibling-file lines listed under "Cross-area hooks"; additions under `prisma/seeds/**` (a new file `prisma/seeds/llc-governance.ts` called from the seed index only when `NODE_ENV === "test"`, following the existing seed style).

**`governance.memberActivity`** (query, `withAccessControl`, `governance: read`, `loadLlcCompany`): input `{ stakeholderId: string }`; `assertCompanyOwns(db, companyId, { stakeholderIds: [stakeholderId] })`. Output:

```ts
{
  ballots: { resolutionPublicId: string; referenceCode: string | null; title: string; type: string; status: string;
             preferredUnits: string; choice: "FOR" | "AGAINST" | "ABSTAIN" | null; deemed: boolean; submittedAt: Date | null }[];
  reports: { reportPublicId: string; title: string; type: string; sentAt: Date | null; firstViewedAt: Date | null }[];
  transfers: { transferPublicId: string; direction: "IN" | "OUT"; units: string; unitClassKind: string; status: string;
               effectiveOn: string | null; admittedOn: string | null }[];
}
```

All three lists are filtered by `companyId` AND `stakeholderId`, newest first, max 100 each.

**Cross-area hooks** (each is a few lines in a sibling file, requested by that sibling's plan; do them only after the sibling package is merged):
1. Member detail page (FOUNDATION E3.0): add a tab "Governance" to `src/app/(authenticated)/(dashboard)/[publicId]/stakeholders/[stakeholderId]/page.tsx` rendering `src/components/governance/member-activity-tab.tsx` (new, three small tables from `governance.memberActivity`; ballots link to the resolution, reports to the report, transfers to the transfer). Only after F4b, F7b and F10b are merged.
2. Resolution ownership checks (ECONOMICS E.4): in every ECONOMICS procedure that stores a `resolutionId` (`expense.create`, `managerPayment.create`, `loan.create`; find them with a search for `resolutionId` under `src/trpc/routers`), add `if (input.resolutionId) await assertResolutionOfCompany(tx, companyId, input.resolutionId);` before the write. Do not add any rule about the resolution's type or status (ECONOMICS decided it only needs the id to exist in the company).
3. Resolution pickers: where ECONOMICS forms take a resolution id as text, replace the text input by a select fed by `api.resolution.options` — only if ECONOMICS left a marked slot for it; otherwise report it and leave the form unchanged.

**Seed.** The REG register of G1 as Stakeholders of a test LLC (names and flags as in the table; units through whatever seeding ECONOMICS provides), one DRAFT general consent, one SENT related-party resolution with alice FOR, one EFFECTIVE purchase-order resolution.

**End-to-end checklist** (run by hand against a local database and Mailpit; record the result in the package report):
1. PO resolution: create → sign → status Effective → PDF in Documents and under Books "Minutes, written consents…" → every Member (not fay) has an email with the PDF → the PO deadline is Done.
2. General consent on REG: alice, bob, dan vote For from three private windows → Effective on dan's vote → result emails to all Members → carol's link shows "Approved".
3. Related-party: schoen and reidTrust receive no ballot; alice + dan make it Effective (450.5 > 450.25).
4. Manager removal: alice + carol + dan For (600.5) stays open ("Needs 603.335000"); bob For → Effective.
5. Term extension: only alice responds; move `closesAt` into the past in the database; open any ballot link → Failed, five deemed-against ballots.
6. Amendment touching Section 5.6: Manager signature at send; alice, carol, dan, schoen, reidTrust For → Supermajority met, Disinterested 70% pending; bob Against → Not approved (cannot be reached).
7. Replace alice's link: old link shows "replaced", new link works.
8. Quarterly report for the last quarter: checklist blocks sending until complete; send; fay gets nothing; sam gets it; the deadline is Done; PDF under Books "Financial statements".
9. K-1 delivery with files for alice and fay: each sees only their own.
10. Transfer of 50 units from carol to a prospect: dates as G3 test 11 for the chosen notice date; complete; the prospect is "Financial Interest only"; a new resolution excludes those 50 units; admit; a newer resolution includes them.
11. A second company's admin cannot open any of the above by URL or id.

**Acceptance.** All eleven steps behave as described; the four verification commands pass on the final tree.

---

## E. Interfaces

Names below were reconciled with `01-foundation.md` and `02-economics.md` as written on 2026-11-12. Each sibling symbol is used in exactly the governance file named in the last column, so a later rename is a one-file change.

### E1. Needed from FOUNDATION

| Item | Exact shape (from `01-foundation.md`) | Used in |
|---|---|---|
| Entity type and time zone | `Company.entityType: EntityTypeEnum` (`CORPORATION` / `LLC`); `Company.timezone` (IANA) | `guards.ts` (G4) |
| LLC procedure builder | `withLlcAccessControl` in `src/trpc/api/trpc.ts` (adds `ctx.company = { id, publicId, name, entityType, timezone }`) | every Manager procedure |
| Page gate | `requireLlc()` in `src/server/entity.ts` | every dashboard page |
| Stakeholder fields | `isInsider: Boolean`, `memberStatus: LlcMemberStatusEnum` (`PROSPECT` / `MEMBER` / `FINANCIAL_INTEREST_ONLY`), `noticeEmail: String?`, `admittedOn: DateTime? @db.Date` | `snapshot.ts`, `recipients.ts` (G6), `compliance.ts` (G14), transfers (G16) |
| Holdings | `getMemberPositions(db, companyId, opts?: { asOf?: string; unitClassId?: string }): Promise<MemberPosition[]>` in `src/server/llc/positions.ts`; `MemberPosition` has `stakeholderId, unitClassId, kind ("PREFERRED" | "COMMON"), units (6-decimal string), capitalCents, cashAppliedCents, …`; `asOf` is inclusive (receipts with `appliedOn ≤ asOf`). G16 extends it for completed transfers at FOUNDATION's request | `positions.ts` (G6); edited in G16b |
| Unit class | `UnitClass { id, companyId, kind }`, one PREFERRED and one COMMON per company | `unit-transfer-router/procedures/create.ts` |
| Mail with log | `sendMail(options: Omit<SendMailOptions, "from">, log?: { kind: string; companyId?: string; stakeholderId?: string; relatedType?: string; relatedId?: string }): Promise<{ emailLogId: string | null; sentAt: Date; messageId: string | null }>` in `src/server/mailer.ts`; resolves after the SMTP server accepted the message; throws on failure after writing a `FAILED` log row; `options.attachments` passes through | the email jobs (G9, G12, G14) |
| Email log | `EmailLog { toAddress, kind, status, sentAt, bounceState (NONE / BOUNCED …), relatedType, relatedId, companyId, stakeholderId }`; the Manager user marks a bounce with `emailLog.markBounce` (Section 13.6) | `resolution.get` (G11), `memberReport.get` (G12) |
| Admission | `admitStakeholder(tx, { companyId, stakeholderId, admittedOn }, actor)` in `src/server/llc/commitments.ts` | `unit-transfer-router/procedures/admit.ts` |
| Money and dates | `formatCents`, `mulDivRoundHalfUp`, `ZCents` (`src/lib/money.ts`); money inputs as in FOUNDATION's UI conventions | report UI (G13), `positions.ts` edit (G16b) |
| Placeholders and navigation | F2 placeholder pages at `/resolutions`, `/transfers`, `/compliance`, `/documents/books`, `/reports`; sidebar entries for them. Governance asks FOUNDATION to label them "Resolutions", "Reports", "Compliance", "Transfers", and "Books and records" under Documents | page packages |
| Shared-file order | F1 edits `root.ts`, `subjects.ts`, `audit/schema.ts` first; G4 appends afterwards | G4 |
| `Document` columns | `recordCategory`, `recordYear`, `BooksRecordCategoryEnum` — defined in this plan's C2, landed by F0 | G18, `filing.ts` |

Points where this plan deliberately differs from what `01-foundation.md` expects of GOVERNANCE (its E3):
- E3.3 says a `RecordSnapshot` stores the output of `loadMemberSchedule`. This plan stores its own entry rows built from `getMemberPositions` (the function underneath `loadMemberSchedule`) plus the suspension flags from ECONOMICS, because vote math needs suspension and does not need commitments or addresses. Same source of units, so Exhibit A and votes agree.
- Resolutions do not reuse the e-sign engine (lead's ruling; FOUNDATION informed): no `TemplateWorkflowEnum` value is needed for governance, and `sign-template.ts` is not touched.
- FOUNDATION's audit actor for jobs and public actions is `{ type: "company", id: companyId }`. Governance adds the actor types `"system"` and `"stakeholder"` (G4) so that a Member's own act (a ballot) is distinguishable from a job in the audit log.

### E2. Needed from ECONOMICS

| Item | Exact shape (from `02-economics.md`, sections 0 and E.2) | Used in |
|---|---|---|
| Business days | `addBusinessDays(d: IsoDate, n: number, opts?): IsoDate` in `src/lib/llc/business-days.ts` (`n ≥ 1`: the n-th business day strictly after `d`) | `tally.ts` (G6), `compliance-router/procedures/create-custom.ts` (G14), `unit-transfer-router` (G16). Default options are used; if `LlcTerm` carries `extraHolidays` / `saturdayHolidayObservedFriday`, pass them through from `getOrCreateLlcTerm` |
| Date helpers | `src/lib/llc/dates.ts` (`addDays`, `addMonths`, `daysBetween`, `quarterOf`, `toIsoDate`, `isoToUtcDate`, `utcDateToIso`) | re-exported by `src/lib/governance/dates.ts` (G3) |
| Suspension | native `getSuspendedUnits(tx, companyId, asOf: IsoDate): Promise<{ suspended: { stakeholderId; preferredUnits; memberDefaultIds }[]; undeclaredOverdue: {…}[] }>` from `@/server/llc/economics` — suspended = declared, non-voided, uncured default with `dueOn < asOf`; ALL of that Member's Preferred Units | `positions.ts` (G6) |
| Period report data | native `getPeriodEconomics(tx, companyId, { periodStart, periodEnd })` → `revenue`, `expenses`, `managementFee`, `reserves`, `distributions`, `managerAndAffiliatePayments`, … with `Cents` as `bigint` | `member-report-router/procedures/period-data.ts` (G12) |
| Close the books | `closeBooksThrough(tx, companyId, date)` — called when a QUARTERLY or ANNUAL report is sent | `member-report-router/procedures/send.ts` (G12) |
| Calendar items | `getComplianceDates(tx, companyId, { from, to }): Promise<{ key; kind; dueOn; label; oaSection; status: "OPEN" | "OVERDUE" | "ACTION_REQUIRED" | "DONE" | "NOT_REQUIRED" | "INFO"; sourceType; sourceId }[]>` (native function; ECONOMICS never marks `QUARTERLY_REPORT_DEADLINE` or `EXTENSION_REQUEST_DUE` done from governance data — governance does, G12 and G7) | `compliance.ts` (G14) |
| Transfer validation | `applyUnitTransfer(tx, { companyId, unitTransferId, fromStakeholderId, toStakeholderId, unitClassId, units: string, effectiveOn: Date })` — validation only (open ledger date, enough units); called before the status update | `unit-transfer-router/procedures/complete.ts` (G16) |
| Transfers reader | ECONOMICS's own `loadCompletedTransfers` reads `UnitTransfer` (`status`, `unitClassKind`, parties, `units`, `effectiveOn`, `createdAt`); governance keeps those columns stable | C2 |
| Term extension | ECONOMICS counts `Resolution { type: "TERM_EXTENSION", status: "EFFECTIVE" }` (one year each); there is no extension table or procedure | C2 (`Resolution.type`, `status`) |
| `resolutionId` columns | plain `String?` on `ExpenseEntry`, `ManagerPayment`, `MemberLoan`; the stored value is `Resolution.id` | G19 adds the ownership check |

Semantics governance relies on:
- **Record date is inclusive.** A snapshot for record date `D` contains receipts applied on `D` (`appliedOn ≤ D`) and transfers effective on `D`, and a default suspends units only when its due date is strictly before `D`. A resolution sent with the default record date (today) therefore counts units issued earlier the same day.
- Suspension is judged as of the record date and frozen in the snapshot with Member status and insider flag (taken at send time); a default cured or declared later does not change an open resolution's denominators (R13). An undeclared overdue Balance as of the record date blocks `send` of a resolution with ballots (R13, M5).
- Time zone (lead's ruling): the single source is `Company.timezone`, default `America/Denver`. Governance never reads `LlcTerm.timeZone`.

### E3. Exported by GOVERNANCE

| Export | For | Notes |
|---|---|---|
| `src/lib/llc/voting.ts` (all exports of G1) | anyone | pure |
| `assertResolutionOfCompany(tx, companyId, resolutionId)` (`src/server/governance/resolutions.ts`, G6) and the query `resolution.options` (G7) | ECONOMICS procedures and forms that take a `resolutionId` | G19 wires the check into ECONOMICS's procedures as its E.4 asks |
| `UnitTransfer` rows with `status = COMPLETED` (`effectiveOn`, parties, class, units) | FOUNDATION `getMemberPositions`, ECONOMICS `loadCompletedTransfers` | the transfer row is the ledger entry (G16) |
| `Resolution` rows (`id`, `type`, `matterKey`, `status`, `effectiveAt`, `sentAt`, `referenceCode`, `publicId`) | ECONOMICS (term extension, §6.21 cap, loans, payments) | read-only for others; ECONOMICS does not check the vote itself |
| `governance.memberActivity({ stakeholderId })` (G19) | FOUNDATION member detail page | shape in G19 |
| `takeRecordSnapshot` / `RecordSnapshot` (+entries) | anyone needing a frozen register | insert-only |
| `fileGeneratedPdf` (`src/server/governance/filing.ts`) | FOUNDATION/ECONOMICS for generated PDFs that belong in the books | pass the 8.1 category |
| `upsertSourceDeadline` (`src/server/governance/compliance.ts`) | any area that prefers pushing a deadline | idempotent by `dedupeKey` |
| `Document.recordCategory` / `recordYear` | FOUNDATION (e.g. to file signed Exhibit B pages under `ARTICLES_AND_AGREEMENT`) | additive columns |
| RBAC subject `governance` | role editor | granted to ADMIN automatically |
| Public routes `/ballots/[token]`, `/member-reports/[token]` | — | must stay outside any authenticated layout |

---

## F. Risks and open questions (each with the default this plan assumes)

1. **Final ballots, no drawn signature.** A typed legal name with assent on a dedicated page is the signature (6.12, 13.9); a submitted response cannot be changed; a resolution fails early once the threshold can no longer be reached. *Default: as stated.* If the owner wants changeable votes until the deadline, G1 `cannotPass`, G6 `decideTransition` and the write-once rule change (roughly one extra package).
2. **Wording of the purchase-order resolution and other locked clauses** (G5) tracks 6.16(i)(B) and the cited sections but is new legal text. *Default: ship as written, flagged for counsel review before first real use; the text lives in one file.*
3. **Who receives what.** Reports, notices and resolution copies go to admitted Members only, including Members whose units are suspended; Financial-Interest-only holders receive nothing except their own K-1 (R22, R22a). The executed PDF names only consenting Members; Against/Abstain/No response appear as totals. *Default: as stated.*
4. **Manager signs when sending.** For matters needing the Manager's approval (amendments, early dissolution) the Manager's electronic signature is collected in the send dialog; the Common Member's approval may be given by the same signer. *Default: as stated.*
5. **Record date and frozen register.** Units as of the record date; Member status, insider flag and suspension as they stand when the resolution is sent; nothing changes afterwards, including a default cured mid-vote. *Default: as stated (shared contract).*
6. **Term-extension window.** 30 days ends at 23:59:59.999 in the company time zone on the 30th day after the send date; approval before that is effective immediately; deemed-Against applies to this type only. *Default: as stated.*
7. **Member-initiated actions run through the Manager's account** (25% consent initiation under 2.5, special meetings under 6.4, removal under 6.20). Members have no login, so a Manager user must draft them. This is a conflict for a removal vote. *Default: accept; Members can always act outside the app and the signed consent is uploaded to Books (section G).*
8. **Email notice validity (13.6)** depends on a bounce being recorded. *Default: FOUNDATION's manual `emailLog.markBounce`; no automatic bounce processing.* Until `EMAIL_SERVER` points at a real SMTP service (FOUNDATION B28: production currently uses the mail catcher), no governance email reaches anyone.
9. **Scheduled jobs need a running process.** With the `fly.toml` autostop settings (or any host that stops idle machines) the 07:00 reminder and the 15-minute sweep run only while the app is up. *Default: `missed: "once"` catch-up plus close-on-read; recommend one always-on machine in production.*
10. **Tokens in URLs** are written to the request log by `src/proxy.ts`. *Default: accept (links are revocable, expire, and are bound to one ballot/recipient); do not change the proxy in this plan.*
11. **`K1_FINAL` = September 15** is an assumption about the extended filing date. *Default: generated, editable per year.*
12. **Existing Member as transferee** must be admitted for the new units at completion, because Member status is per Stakeholder, not per unit lot. A Member that transfers all its units stops receiving reports (recipients require units > 0) but keeps `memberStatus = MEMBER` unless FOUNDATION adds a former-member status. *Default: as stated.*
13. **React-PDF under vitest** may not run; the PDF test may have to be a script. *Default: G9 decides and reports.*
14. **Cross-plan items, now ruled by the lead:** governance models land in wave 1 through FOUNDATION's F0 (C4); one time zone, `Company.timezone`, default `America/Denver`; resolutions do not use e-sign; K-1s to Financial-Interest-only holders and the JSON document model (items 17, 18) are accepted.
15. **PDF fonts.** The executed PDF uses React-PDF's built-in Helvetica, which covers Windows-1252 only. A typed name with other characters (for example Cyrillic or CJK) would print incorrectly although it is stored correctly. *Default: accept for the first release (the Members are US persons); the upgrade is a Unicode TTF bundled in the repo and registered by file path, never fetched at run time.*
16. **Sending a quarterly or annual report closes the ECONOMICS books through the period end** (`closeBooksThrough`). *Default: as ECONOMICS specifies; the send dialog says so.*
17. **K-1 delivery differs from the brief's "never to Financial-Interest-only holders"**: those holders receive their own Schedule K-1 (and nothing else) because Section 1.8 gives them allocations. *Default: as stated; switch off by excluding non-Members in G12 step 2.*
18. **No HTML on the resolution/report path**: the brief suggested reusing the Updates HTML sanitizer; this plan stores BlockNote JSON, validates it into a small document model and renders that to both the page and the PDF, so no HTML is stored or injected (A5). The sanitizer stays in use for Updates only.
19. **New RBAC subject** `governance`: existing custom roles get no access until edited. *Default: acceptable (production has one ADMIN user).*
20. **At-least-once email delivery**: a crash between sending and recording can duplicate one email. *Default: accept; never lose an email.*

---

## G. Explicitly not planned (with the manual route)

| Not built | Manual route with what is built |
|---|---|
| Meetings module: notices of meeting, quorum, adjournment, minutes, waivers (6.2–6.11) | Act by written consent (Resolutions). If a meeting is held: send the notice as a Report of type Notice (10–60 days before, 6.5), add the custom deadlines `SPECIAL_MEETING_NOTICE` / `SPECIAL_MEETING_HELD`, upload minutes and waivers to Documents and file them under Books "Minutes, written consents…". |
| Proxies and voting trusts (6.13, 6.14) | The proxy holder signs the ballot with the Member's link, typing their own name and the capacity "by proxy for {Member}"; upload the proxy under Books "Minutes, written consents…". |
| Purchase-order workflow: vendor/PO records, payment blocking, 5-business-day remit timer, title-document tracking, security-interest filings (6.16(e), 6.16(i)(2)(A), (C), (D)) | One Purchase-order resolution per order (or series) over $25,000, signed before paying; custom deadlines `PO_FUNDS_REMIT` and `PO_TITLE_DOCUMENTS`; upload invoice, proof of payment and bill of sale to Documents; ECONOMICS `ManagerPayment.resolutionId` links payments to the resolution. |
| Member portal or Member login | Emailed, expiring, revocable links per ballot and per report. |
| Member-initiated consents and requests (2.5 25% initiation, 6.4 special-meeting request, 6.20 removal, 8.3 single-Member audit, 8.3 inspection) | Members write to the Manager; a Manager user drafts the corresponding resolution (presets exist for extension, removal, successor, audit). Consents signed outside the app are uploaded and filed under Books; record the outcome with a custom deadline note. |
| Changing or revoking a submitted response | Withdraw (or let it fail), duplicate as a new draft, send again. |
| Tax-proceeding log (9.2) | Custom deadline `TAX_PROCEEDING_NOTICE` (10 days), a Notice report "Notice of audit or tax proceeding", a General consent with matter "Settle, extend limitations or file a petition…" when Supermajority approval is needed, documents under Books "Tax returns". |
| Transfer pricing, appraisal, instalment notes, pro-rata ROFR allocation (7.1(ii), 7.2, 7.7) | Free-text terms and uploaded documents on the transfer; pro-rata shares are computed by hand from the Members register. |
| Indemnification determinations (Section 10) | General consent with matter `INDEMNITY_SETTLEMENT` (Manager + Disinterested majority) or `INDEMNITY_DETERMINATION` (Disinterested majority). |
| Automatic bounce detection (13.6) | The Manager user marks the email log as bounced (FOUNDATION `/emails`) and uses Resend / Replace link with a corrected address. |
| Drawn signatures on a PDF | The existing e-sign feature (Documents → eSign) for Exhibit B pages, promissory notes and similar. |
| State filings and winding-up steps (11.2, 11.5; Wyoming annual report) | Custom deadlines (`STATE_ANNUAL_REPORT`), documents under Books "Other records". |
| Exhibit A generation and Member address book | FOUNDATION (Members page). |
| Capital calls, defaults, distributions, Management Fee, reserves | ECONOMICS; governance only reads their results for snapshots, reports and the calendar. |
