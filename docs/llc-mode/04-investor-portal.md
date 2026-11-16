# LLC mode — 04 Investor portal (implementation plan)

Scope: a sign-in for investors (holders, `Stakeholder` rows) of an LLC company, where they see an interactive financial dashboard of the periods the Manager's team has published (fund figures and their own investment), the member reports released to them and the documents shared with them, and can export figures to Excel.
Audience: an executor who has not seen the repo. Read sections 1–7 once, then execute one work package from section 8 at a time under the executor protocol of `00-overview.md`.
Status: **built** (packages P0–P17, merged on `feat/investor-portal`; P11 finished 2026-11-16). Section 12 records what was built differently from the text below, the defects the final review found, and what is still open. Revised 2026-11-14 after the owner's decisions (section 9.1), and again the same day for the financial dashboard (rules P32–P39, section 5.9). Section 9.2 lists what is still open; each open item has its default built.

This plan reverses an earlier scope decision. `00-overview.md` says "Members have no login" and "Not planned: … investor portal"; `03-governance.md` section G gives "Emailed, expiring, revocable links per ballot and per report" as the manual route, and its risk F.7 and rule R17 rest on "Members have no login". Those lines stay true for ballots, e-sign and W-9 in phase 1. This plan also changes shipped governance code: `memberReport.send` becomes `memberReport.release` (section 5.5), which overrides parts of rules R22, R22a and package G12 of `03-governance.md`. Package P11 records all of this in the two older documents.

Conventions (as in the sibling plans)

- "Manager user" = a signed-in team user (`Member` model). "Holder" = a `Stakeholder` row. "Member" = a holder with `memberStatus = MEMBER`. "Portal user" = a person who signs in to the portal (new `PortalUser` model). One portal user can act for several holders; one holder can have several portal users.
- "Release" = the one action that freezes a report, fixes who receives it and publishes it to the portal, with or without an email. It replaces "send". The database status value stays `SENT`; screens say "Released".
- Everything is gated on `Company.entityType === "LLC"`.
- Money, units, dates and time zone follow `00-overview.md`.
- Tested modules use relative imports only and import neither `server-only`, `@/env`, `@/server/db` nor `@/server/auth` (vitest has no `@/` alias).
- Verification commands: the four in `00-overview.md` (tsc, biome, vitest, production build).

## 1. Summary and phases

**Phase 1 (this plan, packages P0–P17)**

1. Sign-in with email and password. An account exists only after a Manager user invites a specific email address for a specific holder; the invitation carries a set-password link. Forgotten-password reset by email. Lockout after repeated failures.
2. Reports: releasing a report freezes it, publishes it to the portal for the holders the Manager user selected, and emails it only if the Manager user ticks that. A report can be in the portal without ever being emailed.
3. Documents: a holder sees a `Document` only when a Manager user has put that holder on the document's share list. Presets ("all Preferred Members") fill the list; what is stored is the list of holders the Manager user confirmed.
4. Emailed report links open the report inside the portal, after sign-in or account set-up.
5. A financial dashboard, not a file list: metrics and charts for the fund and for the holder's own investment, by month, quarter, year or since inception, with comparison against earlier periods and drill-down from a quarter into its months. Investors see it only through the latest period published to them, from figures frozen at release. The team has the same dashboard live, with a preview of what a holder sees.
6. Excel export (.xlsx, formatted) of report figures and of any dashboard view, and a print / PDF layout, for investors and for the team.
7. A log of every portal sign-in, report view, export and file open, visible to the team.

**Later phases (not in the packages; outline in section 10)**

- Phase 2: a statement PDF as of a date, a "Tax documents" list of their K-1s, open ballots, Call Notices and distribution notices, the documents they signed, richer utilization metrics once defined. (The holder's own position and distributions moved into phase 1 with the dashboard.)
- Phase 3: an emailed code as second factor, requests from Members to the Manager, retiring the token page.

**Not in any phase:** investors editing their own details, messaging, uploads by investors, access for holders of C-corporation companies.

## 2. Findings from the code

Verified by reading the working tree on 2026-11-14. `03-governance.md` section A is partly out of date; where it differs from the lines below, these are correct.

### 2.1 Auth today

- next-auth 4.24 with a JWT session (`src/server/auth.ts:149-151`). Providers: email + password, passkey (`webauthn`), Google (`:152-288`). The `jwt` callback copies the user's most recently used ACTIVE `Member` into the token: `companyId`, `memberId`, `companyPublicId`, `status` (`:98-142`).
- A JWT outlives deactivation; `checkMembership` re-reads the `Member` row for that reason (`src/server/auth.ts:333-345`). A next-auth session cannot be revoked server-side.
- `src/proxy.ts` protects no routes. It logs (with tokens redacted), rate-limits per IP, sets `x-pathname` and the CSP. Pages protect themselves: `src/app/(authenticated)/layout.tsx` redirects to `/login` when there is no session and accepts any session.
- 37 procedure files use `withAuth` (session, no RBAC). 27 of them call `checkMembership` inside. 10 do not and accept any session: `onboarding-router`, `common`, `passkey-router`, `company-router`, `bucket-router/create-bucket`, `billing-router/get-products`, three `member-router` procedures (`get-profile`, `update-profile`, `accept-member`) and `security-router/update-password`. The upload server action lets any signed-in user upload to the public bucket (`src/server/file-upload-actions.ts:44-106`), and `(authenticated)` pages accept any session. So a next-auth session is by itself a credential for part of the team API.
- The root layout wraps every page, portal pages included, in `NextAuthProvider` with the team session and in `TRPCReactProvider` (`src/app/layout.tsx:32-46`). Its title template is "%s | Captable, Inc.".
- The next-auth Email provider needs the database adapter, creates a `User` row the first time an address verifies, and signs an existing `User` in when the address matches (next-auth 4.24.15 docs, `providers/email`). An investor would therefore become a `User` in the same identity space as the team.
- Rate limiter: `src/lib/rate-limit.ts`, in memory, per client IP, fail-open when the address is missing or private. Buckets `login`, `account`, `token-page`, `token-api`; the limited procedures and path prefixes are closed lists (`:44-84`).
- Token redaction for logs and Sentry: `src/lib/token-redaction.ts`. JWT-shaped segments anywhere, plus every segment after `/ballots/`, `/member-reports/`, `/w9/` (`:11-17`). A random (non-JWT) token in another path is not redacted today.
- Sign-up is open (`auth.signup`), so anyone can already create a team `User` and their own company. The portal does not change that.
- There is also a REST API (`src/app/api/v1`, access tokens). It does not read cookies, so a portal session means nothing to it.

### 2.2 Authorization today

- `withAccessControl` = session + ACTIVE membership + RBAC policy; `withLlcAccessControl` adds the LLC check and `ctx.company` (`src/trpc/api/trpc.ts:225-257`). `companyId` always comes from `ctx.membership`.
- RBAC subjects are a closed list (`src/lib/rbac/subjects.ts`). A new subject is granted to ADMIN automatically and to no custom role. `addPolicyOption` accepts several subjects in one `meta` (`src/lib/rbac/index.ts:8-10`); no procedure does that today.
- The RSC caller sends only the cookie header, so `ctx.requestIp` is `127.0.0.1` and the user agent is empty for calls from Server Components (`src/trpc/server.ts:13-20`). Anything that records an address must be called from the browser.
- `assertKeyReadableByCompany(key, company)` checks the storage key namespace before a presign (`src/server/tenant-ownership.ts`).

### 2.3 Holders and email addresses

- `Stakeholder` is unique on `[companyId, email]` (`prisma/schema.prisma:358`), not globally. Two holders of one company cannot share `email`. They can share `noticeEmail`, which is optional, not unique and editable by the team (`:343`). Reports and notices go to `noticeEmail ?? email` (`src/server/governance/recipients.ts:46`).
- So "one signer for two trusts" exists today only as two holders with the same `noticeEmail`, or with two different `email` values. An email address does not identify a holder. The same address can also belong to holders of other companies and to a team `User`.
- `memberStatus` is `PROSPECT | MEMBER | FINANCIAL_INTEREST_ONLY`. A Member that transfers all its units keeps `MEMBER` (governance risk F.12).

### 2.4 Member reports

- `MemberReport.status` is `DRAFT | SENT` (`prisma/schema.prisma:2434-2437`). `memberReport.send` is irreversible and does much more than email: it derives the audience on the server, creates one `MemberReportRecipient` per holder, freezes `frozenContent` and its hash, marks compliance deadlines done and, for quarterly and annual reports, closes the books (`src/trpc/routers/member-report-router/procedures/send.ts`). The content a reader may see exists only after send.
- Audience (`procedures/audience.ts`): quarterly, annual and notices go to current Members (units > 0); a transfer notice goes to the other Preferred Members only; a `TAX_K1` report goes to exactly the holders that have a K-1 attached, including Financial-Interest-only holders.
- After send, attachments can still be added but never removed, and `resend` adds recipient rows for late K-1s (`procedures/add-attachment.ts:18-22`, `resend.ts:21-24`). So what a recipient may see is live, not a snapshot.
- Attachments with `stakeholderId` set are private to that holder (K-1). `visibleAttachmentWhere(stakeholderId, type)` is the one rule; on a `TAX_K1` report only the holder's own files are visible (`src/trpc/routers/member-report-view-router/access.ts:49-69`).
- Token page: `/member-reports/[token]`. The token is an HS256 JWT `{ p: "mr", r: recipientId, v: tokenVersion, exp }`, 400-day expiry, revocable and replaceable per recipient. `resolveRecipient` takes the report and company from the recipient row, never from the client (`procedures/resolve.ts`). Outputs are built field by field. Every public report procedure is a mutation so the token never appears in a URL.
- `ReportFigures` holds LLC-level totals. The only names in it are payees and insiders in the Manager-payments section (`src/lib/governance/report-figures.ts:13-66`), which every recipient already receives by email.
- `ReportView` (`src/components/governance/report-view.tsx`) and `PublicReportDocuments` (`report-attachments.tsx:426`) render the frozen content and the file list; both can be reused.

### 2.5 Documents and existing sharing

- `Document` belongs to a company and may be tied to one holder (`stakeholderId`, `kind` = `exhibit-b | w9 | wire-confirmation | other`) and to a books category (`prisma/schema.prisma:473-523`). `Bucket` has no company column; ownership is the key namespace.
- Data rooms: recipients are emailed a JWT `{ companyId, dataRoomId, recipientId }` that never expires; the page trusts the token's `companyId` and passes whole `Bucket` rows, storage key included, to the browser (`src/app/(documents)/data-rooms/[publicId]/page.tsx:28-80`). No revocation time, no access log. The router is session-only.
- `DocumentShare` (link, expiry, optional email protection) is written by one procedure and read by nothing: its page is disabled (`documents/share/_page.tsx`) and no public route consumes it.
- Signed-in download is a server action that needs a next-auth session with `documents: read` (`src/server/file-upload-actions.ts:115-156`). `getPresignedGetUrl(key, file?)` always signs for 10 minutes (`src/server/file-uploads.ts:129-150`) and serves PDF and images inline, everything else as a download.
- Generated files are `Document` rows too: filed report PDFs and executed resolution PDFs (`src/server/governance/filing.ts`), Exhibit A exports. Executed resolutions name consenting Members; Exhibit A lists every Member with amounts.
- K-1 files are not `Document` rows. They are `MemberReportAttachment` rows pointing at a `Bucket`.

### 2.6 Mail, jobs, audit

- `sendMail(options, logContext)` writes an `EmailLog` row for every send (`src/server/mailer.ts:114`). `assertMailDeliverable(purpose)` refuses member-facing sends in production while `EMAIL_SERVER` is the bundled mail catcher (`src/server/mail-delivery.ts`). Purposes are a closed union (`src/lib/mail-delivery.ts:14-18`).
- Email jobs are one job per recipient with a database marker claimed before sending (`src/jobs/governance-report-email.ts`). Job names are a closed list (`src/constants/job.ts`). `src/emails/MagicLinkEmail.tsx` exists and is unused.
- `Audit.create` validates `action` and `target[].type` against closed enums; actor types already include `stakeholder` and `system` (`src/server/audit/schema.ts`). The audits page lists every action.
- Integration scripts that need Postgres are run by hand with `tsx` and refuse a non-local `DATABASE_URL` (`src/server/governance/__integration__/guarded.integration.ts`).

### 2.7 Routes and layouts

- Team pages: `src/app/(authenticated)/(dashboard)/[publicId]/**`. Public token pages are top-level static segments (`/ballots`, `/member-reports`, `/updates`) or the `(documents)` group. A static segment `/portal` sits beside `[publicId]` the same way.
- Member page: `stakeholders/[stakeholderId]/page.tsx` with tabs; the profile card is `src/components/llc/member/member-profile-card.tsx`. Report page: `reports/[reportPublicId]/page.tsx` with `report-recipient-table.tsx`. Documents table: `documents/components/table.tsx`; its "Share document" menu item is commented out (`:98-107`). The report send dialog is `ReviewSendDialog` inside `src/components/governance/report-editor.tsx:266`; `send-dialog.tsx` in that folder is the resolution dialog.

### 2.8 Passwords on the team side

- Hashing: `bcryptjs` 3.0.3 (pure JavaScript, already a dependency), cost 10, in `auth/procedure/signup.ts:27`, `new-password.ts:38` and `security-router/procedures/update-password.tsx:41`. The library is sound; cost 10 is low for 2026.
- Rule at sign-up: `ZPasswordSchema`, 8–72 characters with an upper-case letter, a lower-case letter, a digit and a symbol (`src/trpc/routers/auth/schema.ts:7-16`). The 72 is counted in characters; bcrypt's limit is 72 bytes of UTF-8 and longer input is silently cut (`bcrypt.truncates(password)` tests for it).
- The reset procedure does not apply that rule: `ZNewPasswordProcedureSchema` accepts any string (`auth/schema.ts:24-27`), so a reset can set a one-character password.
- Reset tokens are `nanoid(32)`, valid one hour, stored in plain text in `PasswordResetToken` (`src/lib/token.ts:32-56`).
- There is no per-account lockout. The only limit is the proxy's per-IP bucket, which fails open (2.1).
- Consequence: the portal reuses the library and nothing else from the team flow. Fixing the team flow is separate work (section 11).

### 2.9 Report status readers, deadlines and "delivered"

- Readers of a report's `SENT` status or `sentAt`: `member-report-router/procedures/{get,list,resend,replace-link,add-attachment,send}.ts`, `member-report-view-router/access.ts`, `governance-router/procedures/member-activity.ts`, `src/server/governance/k1-coverage.ts`, `src/jobs/governance-report-email.ts`, `src/jobs/governance-report-file.ts` (uses `sentAt` for the filing year and the PDF), `src/jobs/governance-resolution-sweep.ts:119-120` (re-files `SENT` reports without a filed document), and the components `report-table`, `report-recipient-table`, `member-activity-tab`, `k1-coverage-card`.
- Quarterly and annual compliance deadlines are marked done inside the `send` transaction (`send.ts` step 5). K-1 deadlines are marked done only when every holder of the fiscal year has a recipient row with `sentAt` set, that is, the K-1 email was accepted by the mail server (`src/server/governance/k1-coverage.ts:18-23`; owner ruling recorded in `03-governance.md` on 2026-11-14).
- `send` refuses to run in production while mail goes to the mail catcher, because it closes the books and "is effective only when the Members actually receive it" (`src/lib/mail-delivery.ts:24`).
- `resend` adds a recipient row for every holder that has a K-1 attached and no row yet (`resend.ts:21-24`).

### 2.10 Spreadsheets and the browser policy

- No spreadsheet library is installed. Exports today are CSV built by hand (`src/server/llc/economics/distribution-export.logic.ts`); `papaparse` is used for imports.
- The CSP has `default-src 'self'` and allows `blob:` only for images, media, frames and workers (`src/lib/csp.ts:83-117`). No directive governs a download started from a `blob:` link, so a file built in the browser from bytes returned by tRPC should download; this is confirmed in a browser check (B13) and has a named fallback (5.7).

### 2.11 Financial data that exists (for the dashboard)

All dates below are calendar dates (`@db.Date`); none depends on a time zone. The fiscal year is the calendar year and quarters are calendar quarters (`fiscalYearBounds`, `src/lib/governance/k1-coverage.ts:32-38`; `quarterOf`, `src/lib/llc/dates.ts:102`).

| Data | Where | Granularity | Notes |
|---|---|---|---|
| Revenue | `RevenuePeriod` (`prisma/schema.prisma:1837`) | one row per month | customer receipts, pass-through fees, other income, asset-sale proceeds, insurance proceeds; Gross Revenue = receipts − fees (`grossRevenue`, `src/lib/llc/management-fee.ts:17`) |
| Management Fee accrued | `RevenuePeriod.managementFeeCents` | month | stored at save with the rate of that day |
| Utilization | `RevenuePeriod.utilizationBps` | month | one hand-entered percentage, optional; nothing defines what it measures |
| Expenses | `ExpenseEntry` (`:1883`) | dated rows | 13 categories; paid from operating cash or from capital; reversals are negative rows |
| Payments to the Manager | `ManagerPayment` (`:1914`) | dated rows | fee paid, reimbursements, purchasing-agent pass-through; payee names |
| Reserves | `ReserveEntry` (`:1953`) | dated rows | 9 kinds, establish / release; balance by kind as of any date (`reserveBalances`, `src/lib/llc/available-cash.ts:96`) |
| Member loans, tax advances | `MemberLoan`, `MemberLoanPayment`, `MemberAdvance`, `MemberAdvanceRecovery` | dated rows | advances are per holder |
| Distributions | `Distribution` (`:2085`), `DistributionLine` (`:2135`) | one row per distribution, one line per holder | tiers frozen at finalize: C preferred return, D return of capital, E residual (Preferred and Common); offsets and net per line; dated by `paymentDate` |
| Capital | `Commitment`, `CapitalReceipt` (`:1347`, `:1395`), `CallNotice*` | dated rows | committed, called, received, per holder |
| Positions | `computePositions` (`src/lib/llc/positions.ts:131`) through `getPositions` (`src/server/llc/economics/ledger.ts:267`) | any date | per holder: contributed, unreturned, units, preferred return accrued / paid / unpaid; class totals |
| Available Cash | `computeAvailableCash` (`src/lib/llc/available-cash.ts:146`) | any date, cumulative | a month counts once its last day has passed |
| Period summary | `buildPeriodEconomics` (`src/server/llc/economics/report-data.logic.ts:151`) | any date range | the function that prefills report figures; already returns revenue by month |
| Holder statement | `buildMemberStatement` (`src/server/llc/economics/statements.logic.ts:269`) | any date range | opening, closing, period movements, commitment |
| Term clock | `computeTermClock` (`src/lib/llc/term.ts:35`) | dates | operations start, Target Sale Date, extensions |
| Frozen report figures | `MemberReport.frozenContent.figures` | one set of totals per report period | no monthly breakdown; expense lines by category; hand-editable before release (`member-report-router/procedures/update.ts:35-56`, `report-figures-form.tsx`), so a released figure can differ from the ledger |

What follows from it:

- **Derivable today, monthly:** Gross Revenue, other income, operating expenses by category, capital-funded expenses, Management Fee accrued / paid / unpaid, reserve balance by kind, distributions by tier, capital received, paid-in and unreturned capital, preferred return accrued / paid / unpaid, Available Cash at month end, member loans outstanding, the 6.21 expense cap, and every per-holder figure of the statement.
- **Needs new input:** utilization beyond one typed percentage. There are no GPU counts, rented hours, uptime or price per hour anywhere in the schema, and the definition of "utilization" is still open (`00-overview.md`, open items). The dashboard can chart the typed monthly percentage as it is; anything richer needs a definition and new monthly inputs.
- **Does not exist:** a fair-value or NAV history (fair value is a calculator fed with a hypothetical sale price, `getFairValue`, `src/server/llc/economics/statements.ts:333`; nothing is stored), so no NAV, TVPI or IRR; a bank balance (Available Cash is computed, not a bank figure); a balance sheet or income statement as data (they are uploaded files); revenue below month level (no daily or weekly series); budget or forecast figures.
- **History can change.** Ledger rows are immutable, but the books can be reopened (`llcTerm.reopenBooks`, `src/trpc/routers/llc-term/router.ts:358`), after which back-dated rows are allowed; and the interpretation switches on `LlcTerm` change how positions are computed for every past date. Figures shown to investors therefore cannot be recomputed from the ledger on each visit.
- **Charts:** `recharts` 3.10.1 is installed and used once (`src/components/dashboard/overview/donut-chart.tsx`, which replaced Tremor). There are no chart colour tokens in `src/styles/globals.css`, no shared axis, tooltip or legend components, and no other chart library.

## 3. Rules

Each rule is enforced on the server. The portal UI only reflects them.

**Identity and sign-in**

- **P1** A portal user is identified by one lower-cased email address. It gains access to a holder only through a `PortalAccess` row created by a Manager user's action for that holder and that address: "Invite to portal" on the member page, or the invitation line of the release dialog (P14). Access is never derived by matching an email address to `Stakeholder.email` or `noticeEmail`, and never created by the investor.
- **P2** Editing a holder's `email` or `noticeEmail` changes nobody's portal access. To move access to another address the team disables the old access and invites the new address.
- **P3** The Manager user chooses who is invited: any holder of the LLC, whatever its `memberStatus`, and any email address. A holder can have several portal users (for example the investor and their accountant); each is a separate invitation.
- **P4** Sign-in is by email and password. A password is at least 12 characters and at most 72 bytes in UTF-8 (72 plain characters), not on the bundled list of common passwords, and does not contain the account's email name. It is stored only as a bcrypt hash (cost 12).
- **P5** A password is set or replaced only through a link emailed to the portal user's address: the invitation (valid 7 days) or a reset (valid 60 minutes). A link works once. Setting a password ends every existing session of that user and clears a lockout. A signed-in user can also change the password by giving the current one.
- **P6** Five wrong passwords in a row lock the account for 15 minutes. While locked, every sign-in is refused, including one with the right password. The lock ends by itself or by a password reset. Sign-in, lock and reset answer the same way for known and unknown addresses.
- **P7** A portal session lasts 7 days at most and ends after 24 hours without use. Signing out ends it at once. (Lengths not yet confirmed, section 9.2.)
- **P8** A portal session is separate from a team session. Neither grants anything in the other's area. One browser can hold both.
- **P9** Disabling an access takes effect on the holder's next request. A portal user with no ACTIVE access can sign in to nothing and receives no reset email.

**What a holder sees**

- **P10** Every portal request names one access. The server resolves the holder and the company from that access row and from nothing else. The access must belong to the signed-in portal user and be ACTIVE, the holder row must exist, and the company must be an LLC.
- **P11** A report is visible to a holder when all hold: the report is `SENT` (released), `publishedAt` is set, `unpublishedAt` is null, and the holder has a `MemberReportRecipient` row on it.
- **P12** A holder sees the frozen content of the report and the attachments that `visibleAttachmentWhere` allows: shared files plus files private to this holder; on a `TAX_K1` report only this holder's own files. This holds whoever was selected: selecting a holder for a K-1 report never shows it another holder's K-1.
- **P13** A document is visible to a holder when a `PortalDocumentGrant` row names that document and that holder. There are no group rows.
- **P14** A document tied to one holder (`Document.stakeholderId` set, for example an Exhibit B, a W-9 or a wire confirmation) can be shared only with that same holder.
- **P15** A portal user can open and download a shared file, and can export the figures of a visible quarterly or annual report to Excel. The export contains only that report's frozen, LLC-level figures; it never contains another holder's data.
- **P16** Revoking a share, unpublishing a report, disabling an access and removing a recipient each take effect on the next request. A storage URL already issued stays valid for at most 60 seconds.

**Releasing a report (replaces "send")**

- **P17** Release is one transaction on a `DRAFT` report. In order: content checks and freeze (`frozenContent`, hash), the audience the Manager user confirmed becomes recipient rows, `publishedAt` is set, status becomes `SENT`. For quarterly and annual reports the books are closed through the period end, as `send` does today. No recipient row and no `publishedAt` can exist on a report without frozen content.
- **P18** The audience is an explicit list of holders chosen by the Manager user. Presets fill the picker: "All current Members" (ticked by default for quarterly, annual and general notices), "Preferred Members", "Common Members", "Other Preferred Members" (default for transfer notices), "Holders with a K-1 attached" (default and only source for `TAX_K1`). The server stores exactly the confirmed list and checks every id: the holder belongs to the company; on a `TAX_K1` report the holder has a K-1 attached; a `PROSPECT` cannot receive a report.
- **P19** Email is a separate tick in the release dialog. Ticked: every selected holder is emailed the link, as today. Not ticked: nothing is sent and the report is only in the portal. Later the Manager user can email recipients that were not emailed, add holders to the audience, remove a recipient that was never emailed and never opened the report, unpublish, and publish again.
- **P20** Selection is by holder. Every portal user with ACTIVE access to a selected holder sees the report. (Selecting individual portal users is not offered; section 9.2.)
- **P21** `memberReport.resend` no longer adds recipients by itself. A holder that gets a K-1 after release is added through "Add recipients", where it appears pre-ticked under "K-1 attached, not yet a recipient". The stored audience is always what a Manager user confirmed.
- **P22** Compliance deadlines keep today's meaning of delivered, which is email (2.9). A quarterly or annual deadline is marked done at release only when email is ticked and every current Member is in the audience; K-1 deadlines close as today, when every holder of the year has been emailed. A portal-only release leaves the deadline open, the dialog says so, and the Manager user can complete the deadline by hand on the compliance page. (Whether portal publication counts as delivery is open, section 9.2.)
- **P23** A release with email ticked is refused in production while mail goes to the mail catcher. A portal-only release needs no email service.
- **P24** Unpublish hides the report from the portal and from the emailed link at once. Publishing again restores both. Neither changes recipients, frozen content or the books.

**Emailed report links**

- **P25** The emailed link stays `/member-reports/{token}` and stays valid, revocable and replaceable as today. What it opens depends on the report and on the addressee. "The addressee's access" means a `PortalAccess` for this holder whose portal user's email equals the address the report email was sent to (`MemberReportRecipient.email`). Comparing the two addresses only chooses which page to show; it grants nothing (P1).

| Report | The addressee's access to this holder | The link shows |
|---|---|---|
| Unpublished (`unpublishedAt` set) | any | "This report is no longer available." |
| Published | ACTIVE, password set | "This report is in the investor portal" with **Sign in**; after sign-in the report page. A browser already signed in with access to that holder goes straight to the report. |
| Published | ACTIVE, password not yet set | The same page with **Email me my set-up link**. The link goes to the invited address, never to the browser. After the password is set, the report page. |
| Published | DISABLED (the team turned it off) | "Your portal access has been turned off. Please contact the Manager." No report content: a deliberate Disable is not undone by an old email. |
| Published | none (never invited at this address), whether or not other people have access to the holder | The read-only token page as today (the report as it was emailed), with a "Sign in to the portal" link for readers who do have an account. |
| Sent before the portal existed (`publishedAt` never set) | any | The read-only token page as today. |
| any | token invalid, expired, revoked or replaced | As today (not found, or the "link replaced" page). |

- **P26** In the first four rows the token procedures return no report content. The page that follows sign-in is addressed by the report's public id, never by the token.
- **P27** When the release dialog has email ticked and, for some selected holders, the notice address has no access to that holder (even if another person, such as an accountant, has), the line "Invite these {n} addresses to the portal" is shown, ticked by default, with holder and address listed. Confirming it is the Manager user's invitation (P1, P3) and needs the `portal: create` permission as well. Unticked, those addressees get the read-only token page.

**Documents**

- **P28** Sharing is an explicit list of holders per document, edited at any time (add, remove). Presets fill the picker from today's register. A Member admitted later is not on any earlier list; the share dialog shows "{n} current Members are not on this list" with one click to add them. (Frozen lists are the default pending the owner's confirmation, section 9.2.)

**Team side**

- **P29** New RBAC subject `portal`. Invite, disable, share, revoke and the access log need `portal`. Release, add or remove recipients, publish and unpublish need `governance: update`, as `send` does today. ADMIN has `portal` automatically; custom roles get it only when edited.
- **P30** Invitations and notification emails are refused in production while mail goes to the mail catcher. Sharing, disabling and portal-only release never depend on email.
- **P31** Every team action writes an `Audit` row. Every portal sign-in, failed sign-in that causes a lock, password set, report view, export and file open writes a `PortalAccessLog` row.

**Financial dashboard**

- **P32** The portal's main area is an interactive dashboard, not a file list. It has a fund view ("Financials") and the holder's own view ("My investment"). Reports (text and attachments) are reached from the period they belong to; documents stay a separate, simple list.
- **P33** A holder's **published-through date** is the latest period end among the quarterly and annual reports visible to that holder (P11). The dashboard shows months up to and including that date and nothing after it. Without such a report the dashboard shows "No financial periods have been published yet." Notices and K-1 reports do not move the date. The date is recomputed on every request from the reports visible at that moment, so unpublishing a report or removing the holder from it moves the date back at once, and adding the holder to a released report moves it forward.
- **P34** Investors never see figures computed from the live ledger. At release of a quarterly or annual report, in the same transaction, the server stores one fund snapshot per month and one snapshot per holder per month, for every month after the last snapshot through the period end. The dashboard reads only these snapshots, so a figure an investor has seen does not change. Snapshots are written for every holder with a position or a movement in the month, whether or not the holder is in the report's audience; the audience decides only who may read them (P33).
- **P35** A snapshot changes only by **Restate**, a deliberate team action with a reason. The old rows are kept and marked superseded; the investor's dashboard shows "Restated on {date}" on the affected months. A released report is never rewritten: its frozen figures stay as issued, and its page in the portal and on the team side shows "Figures for this period were restated on {date}; the dashboard shows the restated figures."
- **P36** Fund-level totals are shown to every holder with a published-through date. Per-holder figures are shown only to that holder: the holder snapshot is read by `ctx.holder.stakeholderId` and by nothing else. No holder's name, units or amounts appear in the fund view. Payee names of payments to the Manager are not in the dashboard; they remain in the report, as today.
- **P37** One set of formulas (section 5.9) produces the monthly series, the report figures and the Excel export. Quarter, year and since-inception values are sums or end-of-period values of the monthly series, by the rule stated for each metric.
- **P38** A quarterly or annual report cannot be released while one of its ledger-derived figures differs from the ledger for that period. The dialog lists the differences; the Manager user corrects the ledger or presses "Refresh from ledger". Notes and commentary stay free text. (Default; section 9.2.)
- **P39** The team sees the same dashboard computed live from the ledger through today, and can switch to "Published view" (the snapshots) and "Preview as {holder}" (exactly what that holder sees). The team page and its sidebar entry need `llc-financials: read`, an existing subject; "Preview as" also needs `portal: read`; Restate needs `llc-financials: update` and `governance: update`.

## 4. Data model

Append to `prisma/schema.prisma`. `relationMode = "prisma"`: there are no database foreign keys. Relations are declared only among the new portal models; references to `Stakeholder`, `Company`, `Document`, `Member` and `MemberReport` are plain indexed scalars, as the governance models do, so no existing model gains a back-relation.

```prisma
enum PortalAccessStatusEnum {
  ACTIVE
  DISABLED
}

enum PortalTokenPurposeEnum {
  SET_PASSWORD // invitation, 7 days
  RESET_PASSWORD // 60 minutes
}

enum PortalEventEnum {
  SIGNED_IN
  SIGNED_OUT
  ACCOUNT_LOCKED
  PASSWORD_SET
  REPORT_VIEWED
  REPORT_FILE_OPENED
  REPORT_EXPORTED
  FINANCIALS_EXPORTED
  DOCUMENT_OPENED
}

model PortalUser {
  id    String  @id @default(cuid())
  email String  @unique // lower-cased, trimmed
  name  String?

  passwordHash     String? // bcrypt, cost 12; null until the invitation is completed
  passwordSetAt    DateTime?
  failedSignIns    Int       @default(0) // consecutive
  lockedUntil      DateTime?
  lockNoticeSentAt DateTime?
  lastSignInAt     DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  accesses PortalAccess[]
  sessions PortalSession[]
  tokens   PortalAccountToken[]
}

model PortalAccess {
  id       String @id @default(cuid())
  publicId String @unique // the only access identifier that reaches a browser

  portalUserId String
  portalUser   PortalUser @relation(fields: [portalUserId], references: [id], onDelete: Cascade)

  companyId     String
  stakeholderId String

  status       PortalAccessStatusEnum @default(ACTIVE)
  invitedById  String // Member.id
  invitedAt    DateTime               @default(now())
  inviteSentAt DateTime?
  disabledAt   DateTime?
  disabledById String? // Member.id
  lastSeenAt   DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([portalUserId, stakeholderId])
  @@index([portalUserId])
  @@index([companyId, stakeholderId])
}

model PortalAccountToken {
  id           String                 @id @default(cuid())
  portalUserId String
  portalUser   PortalUser             @relation(fields: [portalUserId], references: [id], onDelete: Cascade)
  tokenHash    String                 @unique // SHA-256 hex of the random token; the token is never stored
  purpose      PortalTokenPurposeEnum
  nextPath     String? // validated path under /portal to open after the password is set
  expiresAt    DateTime
  usedAt       DateTime?
  requestIp    String?
  createdAt    DateTime               @default(now())

  @@index([portalUserId, createdAt])
}

model PortalSession {
  id           String     @id @default(cuid())
  portalUserId String
  portalUser   PortalUser @relation(fields: [portalUserId], references: [id], onDelete: Cascade)
  tokenHash    String     @unique // SHA-256 hex of the cookie value
  expiresAt    DateTime // absolute end
  lastSeenAt   DateTime   @default(now())
  revokedAt    DateTime?
  ip           String?
  userAgent    String?
  createdAt    DateTime   @default(now())

  @@index([portalUserId])
}

model PortalDocumentGrant {
  id            String   @id @default(cuid())
  companyId     String
  documentId    String
  stakeholderId String
  grantedById   String // Member.id
  createdAt     DateTime @default(now())

  @@unique([documentId, stakeholderId])
  @@index([companyId, stakeholderId])
  @@index([documentId])
}

model PortalAccessLog {
  id             String          @id @default(cuid())
  companyId      String? // null for sign-in, sign-out, lock and password events, which belong to no single company
  portalUserId   String
  portalAccessId String?
  stakeholderId  String?
  event          PortalEventEnum
  targetType     String? // "memberReport" | "memberReportAttachment" | "document"
  targetId       String?
  targetName     String? // name at the time, so the log still reads after a delete
  ip             String
  userAgent      String
  createdAt      DateTime        @default(now())

  @@index([companyId, createdAt])
  @@index([companyId, stakeholderId, createdAt])
  @@index([targetType, targetId])
  @@index([portalUserId, createdAt])
}

model PortalNotification {
  id           String    @id @default(cuid())
  companyId    String
  portalUserId String
  kind         String // "portal.documents-shared"
  batchKey     String // a new cuid per share action
  subjectLine  String
  claimedAt    DateTime?
  sentAt       DateTime?
  emailLogId   String?
  createdAt    DateTime  @default(now())

  @@unique([portalUserId, kind, batchKey])
  @@index([companyId, createdAt])
}
```

**Financial snapshots** (written at release, read by the dashboard):

```prisma
model FinancialSnapshot {
  id             String    @id @default(cuid())
  companyId      String
  month          DateTime  @db.Date // first day of the month
  version        Int       @default(1)
  supersededAt   DateTime? // set by Restate; the current row has null
  sourceReportId String? // the MemberReport whose release wrote it; null for a restatement
  restateReason  String?
  data           Json // FundMonth, schemaVersion 1 (section 5.9); cents as JSON numbers
  dataHash       String // SHA-256 of the canonical JSON
  frozenAt       DateTime  @default(now())
  frozenById     String // Member.id

  @@unique([companyId, month, version])
  @@index([companyId, supersededAt, month])
}

model HolderFinancialSnapshot {
  id            String    @id @default(cuid())
  companyId     String
  stakeholderId String
  month         DateTime  @db.Date
  version       Int       @default(1)
  supersededAt  DateTime?
  data          Json // HolderMonth, schemaVersion 1
  frozenAt      DateTime  @default(now())

  @@unique([companyId, stakeholderId, month, version])
  @@index([companyId, stakeholderId, supersededAt, month])
}
```

Both tables are new and start empty. Month rows are small JSON documents validated by a strict Zod schema on write and on read. Five years of monthly data for 50 holders is about 3,000 rows. Rows are written for every holder that has a position or a movement in the month, not only for the report's audience, so a holder added to the audience later finds its own history.

Additions to `MemberReport`:

```prisma
  publishedAt     DateTime?
  publishedById   String? // Member.id
  unpublishedAt   DateTime?
  unpublishedById String? // Member.id
```

plus `@@index([companyId, publishedAt])`. No enum value is added: `MemberReportStatusEnum` stays `DRAFT | SENT`.

Addition to `MemberReportRecipient`:

```prisma
  addedById String? // Member.id that confirmed this holder; null on rows created before this plan
```

Meaning of the existing recipient columns after this plan: a row means "this holder is in the confirmed audience". `sentAt` null and `sendCount` 0 mean "never emailed". `email` is still the holder's notice address at the time the row was created, and `tokenExpiresAt` is still set, so the row can be emailed later.

Notes

- The three report states are told apart without ambiguity: never published (`publishedAt` null: every report sent before this plan), published (`publishedAt` set, `unpublishedAt` null), unpublished (`unpublishedAt` set). Publishing again clears `unpublishedAt`.
- Revoking a share deletes the row. The history is the `Audit` row and the access log.
- Because there are no foreign keys, a deleted holder leaves share and access rows behind. Every read re-loads the holder (`{ id, companyId }`) and the document (`{ id, companyId }`); a missing row means no access. The only delete of a holder today is the REST route `src/server/api/routes/stakeholder/delete.ts`; P3 adds one statement there that deletes the holder's `PortalAccess` and `PortalDocumentGrant` rows. No code deletes a `Document` today; whoever adds that must delete its shares.
- `PortalAccess.companyId` is copied from the holder at invite. A holder never changes company.

**Migration** `prisma/migrations/20261115000000_investor_portal/migration.sql`, written by hand in the style of `20261114090000_distribution_notice_resend`:

- Creates the three enums and nine tables (seven portal tables, two snapshot tables) with their indexes.
- Adds four nullable columns and one index to `MemberReport` and one nullable column to `MemberReportRecipient`. Nullable columns without a default are a metadata-only change: no table rewrite.
- No backfill and no enum change. No snapshot exists after the migration, so no financial figure is visible to any investor until the first quarterly or annual report is released under this plan. Reports sent before it create no snapshots; the first release fills every month from inception (5.9). Every existing sent report stays "never published", so its emailed links keep opening the token page exactly as today, and nothing becomes visible in the portal to anyone.
- Roll back by dropping the new tables, enums and columns; no existing data depends on them.

## 5. Server design

### 5.1 Why a separate session, not next-auth

Decided: email and password. Still recommended and assumed: the portal has its own account table, its own cookie and its own session table, and never creates a next-auth session or a `User` row.

| Requirement | Investors as next-auth `User`s | Separate portal account and session |
|---|---|---|
| "Disable portal access" works at once (P9) | No. The JWT stays valid until it expires (2.1). | Yes. Every request re-reads the session and access rows. |
| An investor can never reach team procedures | No. 10 procedure files, the upload action and the `(authenticated)` layout accept any session (2.1); each would need a new check, and so would every one added later. | Yes by construction. Team code sees `session = null`. |
| One person is both a team user and an investor | One identity, one password, roles merged in the JWT callback; open sign-up could pre-register an investor's address. | Two accounts, two passwords, two cookies, no interaction. |
| Password rules, lockout, hashed reset tokens | The team flow has none of these (2.8) and would have to be rebuilt for everyone at once. | Built for the portal only; the team flow is untouched. |

### 5.2 Accounts, passwords and sign-in

**Password policy** (`src/lib/portal/password-core.ts`, pure, tested): at least 12 characters; `Buffer.byteLength(password, "utf8") <= 72` (bcrypt cuts longer input, 2.8); not in `COMMON_PASSWORDS` (a bundled list of the 1,000 most common, lower-cased comparison); does not contain the part of the email before `@` when that part has 4 or more characters. No composition rule (upper/lower/digit/symbol): length and the block list do more, and the team's rule is not copied. Hash: `bcrypt.hash(password, 12)` from `bcryptjs` (asynchronous). Verify: `bcrypt.compare`.

**Tokens.** 32 random bytes, base64url (43 characters); only the SHA-256 is stored (`PortalAccountToken`). Not a JWT, so it cannot be confused with any existing token kind and does not depend on `NEXTAUTH_SECRET`. One use, claimed by a guarded statement (`UPDATE … SET "usedAt" = now WHERE "tokenHash" = … AND "usedAt" IS NULL AND "expiresAt" > now RETURNING …`). Issuing a new token of a purpose marks the user's older unused tokens of that purpose used.

**Invitation.** `portalAdmin.invite` (5.6), or the invitation line of the release dialog (P27), creates or finds the `PortalUser` and creates the `PortalAccess`.

- The user has no password: a `SET_PASSWORD` token (7 days) is issued and the invitation email carries `{NEXT_PUBLIC_BASE_URL}/portal/set-password/{token}`.
- The user already has a password (the address was invited before, for another holder or company): no token. The email says "You now also have access to {holder} at {company}. Sign in with your existing password." and links to `/portal/sign-in`.

**Set or reset a password.** Page `/portal/set-password/[token]`: a Server Component looks the token up read-only and shows the form (new password, repeat) for the named address, or "This link has expired or was already used" with a link to "Forgot password". The form posts JSON with `fetch` to the route handler `POST /portal/auth/set-password`:

1. `Origin` must equal the app origin (a missing header or `null` is refused).
2. Validate the password (policy above). A failure returns the reason; the token is not consumed.
3. Compute the bcrypt hash first, outside any transaction. Then in one transaction: claim the token (the guarded statement above; no row means the expired answer and nothing is written), store the hash and `passwordSetAt`, zero `failedSignIns`, clear `lockedUntil`, revoke every session of the user, create a new session, write `PASSWORD_SET` and `SIGNED_IN` log rows. A failure rolls the claim back, so an invitation is never burnt by an error.
4. Set the cookie and answer `{ ok: true, next }`, where `next` is the token's `nextPath` or `/portal`. The token proves control of the mailbox, so signing in directly is safe. A "Your portal password was changed" email goes to the address (no link).

**Sign in.** Page `/portal/sign-in` (email, password, "Forgot password?"). The form posts JSON to `POST /portal/auth/sign-in`:

1. `Origin` check.
2. Load the user by normalized email. Always run one `bcrypt.compare`: against the user's hash, or against a fixed dummy hash when there is no user or no password, so timing does not reveal whether the address exists.
3. Refuse with the one message "Email or password is incorrect, or the account is temporarily locked." when: no user, no password, `lockedUntil > now`, wrong password, or no ACTIVE access.
4. Wrong password on an existing account: `failedSignIns + 1` by a single guarded `UPDATE`; at 5, set `lockedUntil = now + 15 minutes`, zero the counter, write `ACCOUNT_LOCKED`, and queue one "sign-in is locked for 15 minutes; reset your password if this was not you" email, at most one per 24 hours (`lockNoticeSentAt`).
5. Success: zero the counter, create a `PortalSession` with a new 32-byte random value, set the cookie, `lastSignInAt`, write `SIGNED_IN`, answer `{ ok: true, next }` with the validated `next` from the request or `/portal`.

**Lockout bound.** Anyone who knows an address can lock it, 15 minutes at a time. The bound: the owner of the address can always get in by "Forgot password", which works during a lock and clears it; the lock notice is limited to one a day; nothing is disclosed. Guessing is limited to 5 tries per 15 minutes per account (480 a day) against a 12-character minimum and a common-password block list.

**Forgot password.** Page `/portal/forgot-password` calls `portalAuth.requestReset({ email })`. It always answers "If this address has portal access, a reset link is on its way." A `RESET_PASSWORD` token (60 minutes) is emailed only when the address is a portal user with at least one ACTIVE access; a user who never set a password gets the same link (it completes the invitation). No email when the user already has 3 reset tokens created in the last 15 minutes or 10 in the last 24 hours. The email is sent from a job, so the response time does not differ.

**Change password** while signed in: `portal.changePassword({ currentPassword, newPassword })` verifies the current password (a failure counts toward the lock), applies the policy, stores the hash, revokes every other session of the user, and sends the "password was changed" email.

**Sign out.** `POST /portal/auth/sign-out` (Origin check) sets `revokedAt`, clears the cookie, logs `SIGNED_OUT`.

**Cookie.** Name `__Host-portal_session` when the base URL is https, `portal_session` otherwise; `HttpOnly`, `Secure` (https), `SameSite=Lax`, `Path=/`, no `Domain`, `Max-Age` 7 days. `Lax`, not `Strict`: an investor who follows a link from an email must arrive signed in.

**Session check** (`loadPortalSession(db, cookieHeader, now)` in `src/server/portal/session.ts`): hash the cookie value, find the row, require `revokedAt = null`, `expiresAt > now` and `lastSeenAt > now − 24h`; return the portal user. `lastSeenAt` is updated only when it is more than 5 minutes old.

**The `next` target.** `safeNextPath(value)` (pure, tested) accepts only a path that starts with `/portal/`, contains no `//`, no backslash, no `@`, no control character, is at most 200 characters, and is not under `/portal/auth/`, `/portal/set-password/` or `/portal/sign-in`. Anything else becomes `/portal`. It is applied when a token is issued, when the sign-in page reads `?next=`, and again in both route handlers.

**Limits and redaction** (edits to closed lists, all in P0):

- `src/lib/rate-limit.ts`: new bucket `portal-login` (30 per minute per IP) for `POST /portal/auth/sign-in` and `POST /portal/auth/set-password`. It is not added to `LOGIN_PATHS`: the proxy answers the `login` bucket with next-auth JSON that points at the team `/login`. A new bucket falls through to the proxy's plain-text 429, which the portal forms show as "Too many attempts, try again in a minute"; `src/proxy.ts` is not edited. `portalAuth.requestReset` and `memberReportView.requestSetup` join `ACCOUNT_PROCEDURES`; `memberReportView.route` joins `TOKEN_PROCEDURES`; `/portal/set-password/` joins `TOKEN_PAGE_PREFIXES`.
- `src/lib/token-redaction.ts`: add `portal/set-password` to `TOKEN_ROUTES`, so the token is absent from the access log and Sentry.
- The set-password page uses `referrer: "same-origin"` and `robots: noindex`, and loads nothing from another origin.
- Passwords travel only in the JSON body of the two route handlers and of `portal.changePassword`. The Sentry middleware that attaches procedure inputs is part of `withAuth` only (`src/trpc/api/trpc.ts:171-201`); procedures built on `withoutAuth`, as all portal procedures are, attach no input. The fields are still named `currentPassword` and `newPassword`, which `redactSensitive` would filter if that ever changes. Route handlers never log a body.

**Second factor later.** An emailed 6-digit code after the password is cheap to add because everything it needs exists after this plan: the token table (a third purpose, 10 minutes, 5 tries), the email job, the per-address throttle, and one place where a session is created. It needs one nullable column on `PortalSession` (`verifiedAt`; a session without it reaches only the code page), one page and one route handler: about one session of work, no rework of anything here. It can be per company (on for everyone) or per portal user.

### 5.3 The investor procedure base

New file `src/trpc/api/portal-procedure.ts`. It builds on `withoutAuth` and does not change `src/trpc/api/trpc.ts`.

```ts
// Signed-in portal user; no holder chosen yet.
export const portalSessionProcedure = withoutAuth.use(/* A */);

// One holder, resolved from the access named in the input.
export const investorProcedure = portalSessionProcedure
  .input(z.object({ access: z.string().min(8).max(64) }))
  .use(/* B */);
```

Middleware A

1. For a mutation that did not come from the RSC caller (`x-trpc-source` is not `rsc`): the `Origin` header must equal the app origin, else `FORBIDDEN`.
2. `loadPortalSession(ctx.db, ctx.headers.get("cookie"), now)`; none: `UNAUTHORIZED`.
3. `next({ ctx: { db, headers, requestIp, userAgent, session: null, portalUser: { id, email, name }, portalSessionId } })`. `session` is overwritten with `null` so no code below this point can read a team session even when the browser also holds one.

Middleware B (the same function, `resolveInvestor`, is exported for server pages)

1. `PortalAccess` by `{ publicId: input.access, portalUserId: ctx.portalUser.id, status: "ACTIVE" }`.
2. `Stakeholder` by `{ id: access.stakeholderId, companyId: access.companyId }`.
3. `loadLlcCompany(ctx.db, access.companyId)` (throws `NOT_FOUND` unless LLC).
4. Any miss is the same message-less `NOT_FOUND`.
5. `next({ ctx: { ...ctx, holder: { accessId, stakeholderId, companyId, name, memberStatus }, company } })`.

What the base guarantees, and what a reviewer checks in every portal procedure:

- G1. Authentication comes only from the portal cookie. `createTRPCContext` still resolves the next-auth session for every tRPC request (`src/trpc/api/trpc.ts:41-42`, not changed here); middleware A replaces it with `null` before any portal code runs, so it is never read. Portal code itself never calls `getServerAuthSession`.
- G2. `companyId` and `stakeholderId` come only from `ctx.holder`. No portal input schema contains `companyId` or `stakeholderId`.
- G3. Every query filters by `ctx.holder.companyId`, and by `ctx.holder.stakeholderId` wherever the data is per holder.
- G4. Outputs are built field by field. Never a Prisma row, a storage key, a bucket id, another holder's id, name or email, view counts or internal notes.
- G5. Portal procedures live only in `src/trpc/routers/portal-router/**` and are built only on these two bases (the public `requestReset` is in `portal-auth-router`). No other router imports `portal-procedure.ts`. P11 adds a test that enforces both by reading the source files.
- G6. A team session grants nothing here, and a portal session grants nothing to `withAuth`, `withAccessControl`, server actions or `(authenticated)` pages, because those read only the next-auth session.

### 5.4 Portal procedures

Router keys: `portalAuth` and `portal` in `src/trpc/api/root.ts`. All `portal.*` procedures except `me`, `changePassword` and `findReport` are `investorProcedure`, so each input also carries `access`.

| Procedure | Type | Input | Output | Checks and effects |
|---|---|---|---|---|
| `portalAuth.requestReset` | public mutation | `{ email }` (trimmed, lower-cased, max 254) | `{ ok: true }`, or `{ ok: false, reason: "UNAVAILABLE" }` in production with the mail catcher | 5.2. Never says whether the address is known. |
| `portal.me` | `portalSessionProcedure` query | — | `{ email, holders: { access, holderName, companyName, companyLogo }[] }` | ACTIVE accesses of LLC companies whose holder row exists, sorted by company then holder. |
| `portal.changePassword` | `portalSessionProcedure` mutation | `{ currentPassword, newPassword }` | `{ ok: true }` | 5.2. |
| `portal.findReport` | `portalSessionProcedure` query | `{ reportId }` | `{ matches: { access, holderName }[] }` | The user's accesses whose holder may see that report (P11). Used by the page that follows an emailed link. |
| `portal.home` | query | — | `{ holderName, company: { name, logo }, timeZone, latestReport: ReportListItem \| null, documents: DocumentListItem[] (latest 3) }` | Same rules as the two lists. The Overview's figures come from `portal.financials.get` (5.9). |
| `portal.reports.list` | query | — | `ReportListItem[]` = `{ id (report publicId), title, type, noticeKind, periodStart, periodEnd, releasedAt, hasOwnFiles, exportable }` | P11. Title from `frozenContent`. Newest first. |
| `portal.reports.get` | query | `{ reportId }` | The `OK` shape of `memberReportView.view`: `{ company, timeZone, holderName, report: { title, type, noticeKind, periodStart, periodEnd, releasedAt, figures, doc }, attachments: { id, name, kind, private, inline }[], exportable }` | P11, P12. Reuses `readFrozenContent` and `visibleAttachmentWhere`. Not found, not published and not a recipient are the same `NOT_FOUND`. |
| `portal.reports.markViewed` | mutation | `{ reportId }` | `{ ok: true }` | P11. Writes `REPORT_VIEWED`. Called from the browser so the address is real (2.2). |
| `portal.reports.fileUrl` | mutation | `{ reportId, attachmentId }` | `{ url }` | P11, P12; the attachment must belong to that report and company; `assertKeyReadableByCompany`; 60-second presigned GET; writes `REPORT_FILE_OPENED`. |
| `portal.reports.exportXlsx` | mutation | `{ reportId }` | `{ fileName, base64 }` | P11, P15; quarterly and annual only; built from `frozenContent` only (5.7); writes `REPORT_EXPORTED`. |
| `portal.documents.list` | query | — | `DocumentListItem[]` = `{ id (document publicId), name, sharedAt, inline, sizeBytes, category }` | P13, P14. |
| `portal.documents.fileUrl` | mutation | `{ documentId }` | `{ url }` | Re-evaluates P13 and P14 for this one document; document by `{ publicId, companyId }`; `assertKeyReadableByCompany`; 60-second presigned GET; writes `DOCUMENT_OPENED`. |

Shared server modules, the only places the rules are written: `src/server/portal/visibility-reports.ts` (P5) with `visibleReportWhere(holder)` = `{ companyId, status: "SENT", publishedAt: { not: null }, unpublishedAt: null, recipients: { some: { stakeholderId } } }` and `listVisibleReports`; `src/server/portal/visibility-documents.ts` (P6) with `listVisibleDocuments` and `canOpenDocument` (grant rows by `{ companyId, stakeholderId }`, then documents by `{ id in …, companyId }`, then drop any document whose `stakeholderId` is set and differs from the holder: P14, second line of defence). The pure part (`documentShareability`) is in `src/lib/portal/visibility-core.ts`.

`getPresignedGetUrl` in `src/server/file-uploads.ts` gains an optional third argument `{ expiresIn?: number }`; existing callers are unchanged.

### 5.5 Release: the split of `memberReport.send`

`send.ts` is replaced by `release.ts`. The transaction keeps today's order of locks and steps (ledger and unit-class locks, report row lock, re-read, must be `DRAFT`) and changes three things: the audience comes from the client and is verified, email is optional, and `publishedAt` is set.

| Procedure | RBAC | Input | Behaviour | Audit action |
|---|---|---|---|---|
| `memberReport.audienceOptions` (query) | `governance: read` | `{ publicId }` | Every holder of the company that may receive this report (P18), each with `{ stakeholderId, name, memberStatus, preferredUnits, commonUnits, noticeEmail, hasK1, isRecipient, emailedAt, portal: "NONE" | "INVITED" | "ACTIVE" }`, plus `presets: { key, label, stakeholderIds }[]` and `defaultPreset`. For a transfer notice the transferring Member is listed and marked "transferor". | — |
| `memberReport.release` | `governance: update` | `{ publicId, stakeholderIds (1–500), email: boolean, inviteMissing: boolean }` | With `email`: `assertMailDeliverable("REPORT")`. Steps of today's `send` 0–1 unchanged (locks, content, checklist, period ended). Step 2: verify every id (P18); none without a notice address when `email`. Step 3: recipient rows with `addedById`. Step 4: freeze, hash, `DRAFT → SENT`, `sentAt = now`, `publishedAt = now`, `publishedById`. Step 5: deadlines per P22. Step 6: close the books (quarterly, annual). With `inviteMissing`: the caller must also hold `portal: create` (checked inside the procedure against `ctx.permissions`, because the flag is optional; `FORBIDDEN` otherwise) and `assertMailDeliverable("MEMBER_EMAIL")`; then for each selected holder whose notice address has no access to that holder, create the portal user and access at that address (same code as `portalAdmin.invite`). A DISABLED access at that address is left disabled and listed in the result. After commit: the filing job as today; report emails only when `email`; invitation emails. | `memberReport.released` (summary names the count, whether emailed, whether deadlines closed or stayed open) |
| `memberReport.addRecipients` | `governance: update` | `{ publicId, stakeholderIds, email, inviteMissing }` | `SENT` only, under the report lock. Same id checks. Creates the missing rows; queues emails for the new rows when `email`. K-1 coverage is re-evaluated when emails go out, as today. | `memberReport.recipients-added` |
| `memberReport.removeRecipient` | `governance: update` | `{ publicId, recipientId }` | Allowed only when the row has `sendCount = 0`, `firstViewedAt = null` and no portal log row for that holder and report. Single-row guarded delete. | `memberReport.recipient-removed` |
| `memberReport.resend` | unchanged | `{ publicId, recipientId? }` | As today, minus the automatic adding of K-1 holders (P21). It is also the way to email a recipient that was never emailed ("Email this recipient", "Email all not yet emailed"): `seq = sendCount = 0` is claimable by the existing job. | unchanged |
| `memberReport.unpublish` | `governance: update` | `{ publicId }` | `SENT` and published: sets `unpublishedAt`, `unpublishedById`. | `memberReport.unpublished` |
| `memberReport.publish` | `governance: update` | `{ publicId }` | `SENT` only. Clears `unpublishedAt`; sets `publishedAt` when it was never set (a report sent before this plan). Its recipients are the existing rows. | `memberReport.published` |

Other edits in shipped governance code (P4, except the two `member-report-view-router` items, which are P5b):

- `member-report-view-router/access.ts`: `classifyReportAccess` gains the input `{ publishedAt, unpublishedAt, addresseeAccess: "NONE" | "INVITED" | "ACTIVE" | "DISABLED" }` and the results `WITHDRAWN`, `PORTAL` and `ACCESS_OFF` (P25). `view`, `markViewed` and `attachmentUrl` return content only for the result `OK`; `WITHDRAWN`, `PORTAL` and `ACCESS_OFF` are `NOT_FOUND` for them.
- `member-report-view-router`: new `route` (public mutation, `{ token }`) → `{ state: "LEGACY" | "WITHDRAWN" | "PORTAL" | "ACCESS_OFF" | "REPLACED", company, reportId?, setupNeeded? }`, with `reportId` only for `PORTAL`; and `requestSetup` (public mutation, `{ token }`, always `{ ok: true }`): for a `PORTAL` link whose addressee has an ACTIVE access without a password, issues a `SET_PASSWORD` token with `nextPath = /portal/go/report/{reportId}` to that portal user's address, under the same per-address throttle as reset.
- `src/jobs/governance-report-email.ts` and `src/emails/MemberReportEmail.tsx`: the link is unchanged; the button reads "View in the investor portal" and one sentence explains that a password is needed (or will be set up) when the holder has portal access.
- `src/server/governance/k1-coverage.ts`: no change in meaning (emailed = delivered). Its comment is updated: a recipient row no longer implies an email.
- `member-report-router/procedures/{get,list}.ts`: add `publishedAt`, `unpublishedAt`, per recipient `emailedAt`, `portal` state, `portalFirstViewedAt`, `canRemove`.
- `MemberReport.sentAt` now means "released"; "emailed" is per recipient (`MemberReportRecipient.sentAt`). Readers that showed the report's `sentAt` as an email date are corrected: `governance-router/procedures/member-activity.ts:149` stops falling back to `report.sentAt` and returns `releasedAt` and `emailedAt` separately (with `member-activity-tab.tsx`); the filed PDF prints "Released {date}" instead of "Sent" (the label in `src/pdf-templates/governance/report-pdf.tsx`; the job passes the same value); `unit-transfer-router/procedures/get.ts:77-164` and `transfer-detail.tsx` show the notice copy as "Released {date}; emailed to {n} of {m}". The transfer flow only displays that status and date; it derives no deadline from them.
- `src/jobs/governance-report-file.ts` (apart from that label) and the sweep: unchanged; they key on `SENT` and `sentAt`, which release still sets.

For quarterly and annual reports the release transaction also runs the reconciliation check (P38) before the audience step and writes the month snapshots after the books are closed, inside the same ledger lock (5.9, package P13a). A refused reconciliation changes nothing.

Recorded alternative, not chosen: a stored "finalized" status between draft and released (freeze now, choose the audience later). It would let the Manager user read the frozen PDF before anyone receives it. Cost: a new enum value, an edit to every reader in 2.9, and a period in which the books are closed and no Member has the report. The release dialog's preview of the checklist and audience covers the need; about two more sessions if wanted.

### 5.6 Team procedures for access and documents

Router key `portalAdmin` (`src/trpc/routers/portal-admin-router/**`), all `withLlcAccessControl`. Every id from the client is resolved with `{ id | publicId, companyId }`.

| Procedure | RBAC | Input | Behaviour | Audit action |
|---|---|---|---|---|
| `portalAdmin.accessForHolder` (query) | `portal: read` | `{ stakeholderId }` | Accesses of that holder: `{ accessId, email, status, passwordSet, invitedAt, inviteSentAt, lastSeenAt, disabledAt, locked }[]`. | — |
| `portalAdmin.invite` | `portal: create` | `{ stakeholderId, email, name? }` | `assertMailDeliverable("MEMBER_EMAIL")`. `inviteHolder(tx, …)` (shared with release): upsert `PortalUser` by email; create the access, or re-activate a DISABLED one; token and email per 5.2. The UI offers `noticeEmail ?? email`; the Manager user confirms the address. | `portal.access-invited` |
| `portalAdmin.resendInvite` | `portal: update` | `{ accessId }` | ACTIVE access only; a new `SET_PASSWORD` token when no password is set, else the "you have access" email. | `portal.invite-resent` |
| `portalAdmin.setAccessStatus` | `portal: update` | `{ accessId, status }` | Guarded single-row update. Needs no email. | `portal.access-disabled` / `portal.access-enabled` |
| `portalAdmin.unlock` | `portal: update` | `{ accessId }` | Clears `lockedUntil` and the failure counter of that access's user. | `portal.account-unlocked` |
| `portalAdmin.overview` (query) | `portal: read` | — | Every access of the company with holder name, email, status, password set, last seen, and counts of visible documents and reports. | — |
| `portalAdmin.holderView` (query) | `portal: read` | `{ stakeholderId }` | Exactly what that holder would see, computed with the modules of 5.4. | — |
| `portalAdmin.shareOptions` (query) | `portal: read` | `{ documentPublicIds (1–50) }` | Every holder of the company with status, units and portal state; the presets (all current Members, Preferred, Common); per document the current share list and `shareability` (`ANY`, or `HOLDER_ONLY` with the holder); a warning text for generated files that name other Members. | — |
| `portalAdmin.shareDocuments` | `portal: create` | `{ documentPublicIds (1–50), stakeholderIds (1–500), notify: boolean }` | P14 checked per document and holder, all-or-nothing. `createMany` with `skipDuplicates`. With `notify`: `assertMailDeliverable` first, one `PortalNotification` per affected portal user, queued after commit. | `portal.documents-shared` |
| `portalAdmin.unshareDocument` | `portal: delete` | `{ documentPublicId, stakeholderIds }` | Deletes those rows. | `portal.document-unshared` |
| `portalAdmin.accessLog` (query) | `portal: read` | `{ stakeholderId?, targetType?, targetId?, cursor? }` | 50 rows per page, newest first, with holder name and portal user email. | — |
| `memberReport.exportXlsx` | `governance: read` | `{ publicId }` | The same workbook as the portal's, for the team. A draft is exported from its stored figures with "DRAFT" in the title block. | — |

The team never sets or sees a portal password. There is no "set password for the investor" action.

New audit target types: `portalAccess`, `portalDocumentGrant`. New job names under a new `portal` group in `src/constants/job.ts`: `account-email`, `notification-email`. New mail kinds: `portal.invite`, `portal.access-added`, `portal.password-reset`, `portal.password-changed`, `portal.account-locked`, `portal.documents-shared`.

### 5.7 Excel export

**Library.** `exceljs` 4.4.0 (MIT; last release October 2023, so mature and slow-moving). It writes styles, number formats, frozen panes, column widths, formulas with a supplied result and page setup, and returns the file as a buffer (`workbook.xlsx.writeBuffer()`); checked against its README through ctx7. The free SheetJS build does not write cell styles, which rules it out; `write-excel-file` is the fallback candidate if ExcelJS ever has to be replaced, and was not evaluated in depth. P0 adds the dependency (`package.json`, `pnpm-lock.yaml`), pinned to 4.4.0. It is imported only on the server, with `await import("exceljs")` inside the renderer, so it never enters a browser bundle.

**Two layers.**

- `src/lib/xlsx/workbook-model.ts` (pure, tested): a small description of a workbook. `{ fileName, title, sheets: { name, heading: string[], columns: { header, width, kind: "text" | "money" | "percent" | "date" | "integer" }[], rows: Cell[][], totals?: { label, columns: number[] } }[] }`. Money cells hold integer cents; date cells hold `YYYY-MM-DD` strings; percent cells hold basis points. `sheetName(raw)` cuts to 31 characters and removes `[ ] : * ? / \`.
- `src/lib/xlsx/report-workbook.ts` (pure, tested): `reportWorkbook({ companyName, title, periodStart, periodEnd, releasedAt, figures, draft })` → the model. Sheets: **Summary** (one row per figure: Gross Revenue, utilization, total expenses, Management Fee accrued, paid and unpaid, reserve balance and minimum, distributions by tier, with the notes), **Expenses** (category, amount, total row), **Manager payments** (date, payee, category, paid to or through, amount, memo; then insider distributions and insider loan payments; grand total). Empty sections produce a sheet with the line "None in this period".
- `src/server/xlsx/render.ts`: turns a model into bytes with ExcelJS. The only file that imports the library.

**Format, the same for every export.**

- A title block on each sheet: company name, report title, period, "Released {date}" or "DRAFT", in bold; then one empty row; then the header row.
- Header row: bold, white text on a dark fill, bottom border, wrapped, frozen (`views: [{ state: "frozen", ySplit: headerRowNumber }]`), with an auto-filter on tables of more than five rows.
- Money: numeric cells (cents ÷ 100) with `"$"#,##0.00;[Red]("$"#,##0.00)`, right-aligned. Percent: bps ÷ 10,000 with `0.00%`. Dates: real date cells built with `new Date(Date.UTC(y, m − 1, d))` and `mmm d, yyyy`, so a date never shifts by a day. Integers: `#,##0`.
- Totals: a bold row with a top border. Each total is a formula (`SUM(C6:C14)`) with the result supplied, because ExcelJS does not calculate. The result is computed from the integer cents, never from the divided numbers.
- Column widths from the model. Text columns wrap.
- Print setup: landscape, fit to one page wide (`fitToPage: true, fitToWidth: 1, fitToHeight: 0`), header row repeated (`printTitlesRow`), margins 0.5 inch, footer with company name left and "Page N of M" right.
- Workbook properties: creator = company name, created = the release time (not "now"), so two exports of one report have the same content.
- Text is always written as a string value. ExcelJS writes a formula only for a `{ formula }` object, so a payee or memo that starts with `=` stays text; a round-trip test asserts it.

**Delivery.** The procedure returns `{ fileName, base64 }` (a report workbook is tens of kilobytes). A small client helper (`src/components/common/download-bytes.ts`) builds a `Blob` and clicks a temporary `<a download>`. Fallback if browser check B13 shows the policy blocks it: two GET route handlers that return the bytes with `Content-Disposition: attachment`, the portal one calling `resolveInvestor`, the team one the RSC caller. The file name is `{company}-{report title}-{period end}.xlsx`, reduced to letters, digits, dashes and dots.

**What is exportable.**

- Phase 1: the figures of a quarterly or annual report. Investors: only a report visible to them, only the frozen figures. Team: any report of the company, draft included. `TAX_K1` and notices have no figures and no export.
- Phase 1, dashboard: any view of the fund figures or of the holder's own figures (5.9, P17).
- Phase 2: the statement as of a date. Team exports of the member register and distributions can move from CSV to the same renderer.
- Never: another holder's rows. The report workbook contains no per-holder data except the insider names already in the report (2.4).

### 5.8 Emails

| Email | To | Carries | Guard |
|---|---|---|---|
| Invitation (no password yet) | the portal user's address | company name, holder name, set-password link (7 days) | `assertMailDeliverable` in `invite` / `release` |
| Access added (password exists) | the portal user's address | company name, holder name, link to `/portal/sign-in`, no token | same |
| Password reset | the portal user's address | reset link (60 minutes); "ignore this if you did not ask" | sent only under 5.2 |
| Password changed | the portal user's address | no link | — |
| Sign-in locked | the portal user's address | no link; says how to reset | at most one a day |
| Report (existing email, reworded) | the recipient's notice address, as today | the existing tokenized link, which now leads into the portal (P25) | only when "email" is ticked |
| New documents shared | the portal user's address | company name, holder name, the number of documents, a plain link to `/portal`. No token, no file. | ticked by the Manager user; `assertMailDeliverable` |

All go through `sendMail` with a log context, so they appear in the email log and on the member's Emails tab. Account emails are sent by one job (`portal.account-email`, one job per token id or per event id) that never logs a link. Notification jobs claim `PortalNotification.claimedAt` with a guarded update before sending (at most once).

For reports there is no separate "new item" email: the report email is that notice. The optional notice exists for documents only.

### 5.9 Financial dashboard

#### Month records and where each number comes from

Pure module `src/lib/llc/financial-series.ts` (relative imports, tested). It does no arithmetic of its own on ledger rows: it calls the existing pure functions once per month and copies their results.

`buildFundMonth(input, month)` → `FundMonth`. `pe` = `buildPeriodEconomics` with `periodStart` = first day and `periodEnd` = last day of the month; `pos` = `computePositions` as of the last day; `ac` = `pe.availableCashAtEnd`.

| Field of `FundMonth` | Source | Over several months |
|---|---|---|
| `grossRevenue` | `pe.revenue.grossRevenue` | sum |
| `otherIncome`, `assetSaleProceeds`, `insuranceProceeds` | `pe.revenue.*` | sum |
| `operatingExpenses` | `pe.expenses.operating` | sum |
| `capitalFundedExpenses` | `pe.expenses.fromCapital` | sum |
| `expensesByCategory[]` | `pe.expenses.byCategory` | sum per category |
| `managementFeeAccrued`, `managementFeePaid` | `pe.managementFee.accrued`, `.paid` | sum |
| `managementFeeUnpaid` | `pe.managementFee.unpaidAtEnd` | last month |
| `netOperatingIncome` | `grossRevenue + otherIncome − operatingExpenses − managementFeeAccrued` | sum |
| `reserveBalance`, `reservesByKind[]`, `minimumReserve` | `pe.reserves.balanceAtEnd`, `.byKind`, `.minimumRequired` | last month |
| `reservesEstablished`, `reservesReleased` | `pe.reserves.*` | sum |
| `availableCash` | `ac.availableCash` | last month |
| `distributions { preferredReturn, returnOfCapital, residualPreferred, residualCommon, gross }` | sums of `pe.distributions.items[].tierC / tierD / tierEPreferred / tierECommon / gross` | sum |
| `capitalReceived` | sum of `ledger.capitalReceived` rows dated in the month | sum |
| `paidInCapital`, `unreturnedCapital` | `pos.totals.contributed`, `pos.totals.unreturned` | last month |
| `preferredReturnAccruedToDate`, `preferredReturnPaidToDate`, `preferredReturnUnpaid` | sums over `pos.holders` of `accruedReturn`, `returnPaid`; `pos.totals.unpaidReturn` | last month |
| `committed`, `uncalled` | sums of the statement commitment fields over holders | last month |
| `utilizationBps` | `pe.revenue.byMonth[0].utilizationBps` (may be null) | mean of the months that have a value, as `averageUtilizationBps` does |
| `memberLoansOutstanding`, `orgExpenseCap { counted, limit }` | `pe.memberLoansOutstandingAtEnd`, `pe.orgExpenseCap` | last month |

Derived at display time by `aggregate()` from the fields above, never stored:

- Cumulative distributions = running sum of `distributions.gross`.
- Distributions to Preferred = `preferredReturn + returnOfCapital + residualPreferred`.
- **DPI (Preferred class)** = cumulative distributions to Preferred ÷ `paidInCapital` at the end of the period, shown as "0.12x". Computed with `roundDiv(cumulative × 10000, paidIn)`; null when paid-in is zero.
- "Net operating income" is not a defined term of the Agreement. It is labelled "Net operating income (before reserves and distributions)" and excludes asset-sale and insurance proceeds, which are shown on their own line.

`buildHolderMonth(input, holderId, month)` → `HolderMonth`, from `buildMemberStatement` with `from` = first day and `to` = last day of the month:

| Field of `HolderMonth` | Source | Over several months |
|---|---|---|
| `contributions`, `credits`, `forfeited` | `period.*` | sum |
| `preferredReturnAccrued`, `preferredReturnPaid`, `capitalReturned`, `residualPaid`, `grossDistributions`, `defaultOffsets`, `taxAdvanceOffsets`, `netPaid` | `period.returnAccrued`, `.returnPaid`, `.capitalReturned`, `.residualPaid`, `.grossDistributions`, `.defaultOffsets`, `.taxAdvanceOffsets`, `.netPaid` | sum |
| `paidIn`, `unreturnedCapital`, `preferredUnits`, `commonUnits`, `preferredPct`, `preferredReturnUnpaid` | `closing.contributed`, `.unreturned`, `.preferredUnits`, `.commonUnits`, `.preferredPct`, `.unpaidReturn` | last month |
| `committed`, `uncalled`, `calledOutstanding` | `commitment.*` | last month |

Holder DPI = cumulative `grossDistributions` ÷ `paidIn`. The statement's default detail (interest and costs owed) is not copied; only the offsets actually taken from the holder's own distributions are.

Agreement between the dashboard and the reports is enforced by tests, not by convention: for every fixture period, `aggregate(months)` equals `buildPeriodEconomics(period)` field by field for the summed fields and equals its end-of-period fields for the "last month" fields; the same against `buildMemberStatement` for a holder; and `figuresFromPeriodData` (the report prefill) fed with either gives identical figures.

#### Periods

- Grains: month, quarter, year, since inception. The fiscal year is the calendar year (2.11). A month is identified by its first day.
- Range: a from-month and a to-month. Revenue exists only per month, so a range is always whole months; there is no day-level picker.
- Since inception starts at the month of the first capital receipt or first ledger row.
- Comparison: the previous period of the same grain, and the same period one year earlier; shown as amount and percentage change, "—" when the earlier period is zero or not available.
- Time zone: none of the figures depends on it. `Company.timezone` is used only to decide "today" in the team's live view (`economicsToday`) and to print timestamps. In the live view the current month is marked "in progress": its revenue is not entered yet and it is excluded from Available Cash by the existing rule.
- Pure helpers in `src/lib/llc/financial-periods.ts`: `monthsBetween`, `periodKey`, `periodLabel`, `groupByGrain`, `comparePeriods`.

#### Writing snapshots

`src/server/portal/financial-snapshots.ts`: `writeSnapshotsThrough(tx, companyId, periodEnd, { reportId, memberId })`, called from `memberReport.release` for quarterly and annual reports, after the books are closed and inside the same transaction and locks.

1. Find the last current snapshot month. Months to write: the next month through the month of `periodEnd`. This fills gaps (a quarter that was never released) so the series is continuous from inception.
2. Load the ledgers once (`loadCashLedger`, `loadLedger`), then build every `FundMonth` and `HolderMonth` in memory with the pure functions.
3. Insert the rows. A month that already has a current row is skipped: release never overwrites.
4. P38 check before step 2: `figuresFromPeriodData(getPeriodEconomics(period))` compared with the report's stored figures; any difference in a ledger-derived field refuses the release with the list.

`restateSnapshots(tx, companyId, fromMonth, toMonth, reason)` marks the current rows superseded and writes version + 1 from the ledger. It refuses months after the company's latest snapshot.

Aggregation approach: the team's live view is computed at request time (two ledger loads, then pure functions over at most a few hundred rows and a few dozen months; no stored aggregates). The investor view reads stored month rows and aggregates in the browser with the same `aggregate()` function, so switching grain or range needs no request.

#### Procedures

| Procedure | Base / RBAC | Input | Output | Checks |
|---|---|---|---|---|
| `portal.financials.get` | `investorProcedure` query | — | `{ publishedThrough, inceptionMonth, timeZone, fundMonths: FundMonth[], holderMonths: HolderMonth[], periods: { key, grain, start, end, reportId \| null }[], restatements: { month, at }[], termClock: { operationsStart, targetSaleDate } }` | P33: months ≤ the holder's published-through date only; current (not superseded) rows; holder rows by `ctx.holder.stakeholderId`; `reportId` only for reports visible to the holder. No published period: empty arrays. |
| `portal.financials.exportXlsx` | `investorProcedure` mutation | `{ grain, from, to, view: "fund" \| "mine" }` | `{ fileName, base64 }` | Same rule; `to` is clamped to the published-through date; writes `FINANCIALS_EXPORTED`. |
| `financialDashboard.live` | `llc-financials: read` | `{ through? }` | The same shape, computed from the ledger through today or `through`; `holderMonths` empty. | — |
| `financialDashboard.published` | `llc-financials: read`; with `asHolder` also `portal: read` | `{ asHolder?: stakeholderId }` | The same shape from snapshots; with `asHolder`, exactly the output of `portal.financials.get` for that holder. | Holder by `{ id, companyId }`. |
| `financialDashboard.status` | `llc-financials: read` | — | `{ snapshotThrough, booksClosedThrough, drift: { month, fields[] }[] }` where drift = months whose snapshot differs from the ledger today. | — |
| `financialDashboard.restate` | `llc-financials: update` and `governance: update` | `{ fromMonth, toMonth, reason (10–500) }` | `{ months }` | Audit `financials.restated`. |
| `financialDashboard.exportXlsx` | `llc-financials: read` | `{ grain, from, to, source: "live" \| "published" }` | `{ fileName, base64 }` | — |
| `memberReport.reconcile` | `governance: read` | `{ publicId }` | `{ differences: { field, reportCents, ledgerCents }[] }` | Feeds the release dialog (P38). |

Router key `financialDashboard` (new, `src/trpc/routers/financial-dashboard-router/**`); `portal.financials.*` in the portal router. New audit action `financials.restated`; new access-log event `FINANCIALS_EXPORTED`.

#### Charts

Library: Recharts 3.10.1, already installed (2.11). API checked through ctx7 against the Recharts storybook: `ComposedChart` with `Bar` and `Line`, bars stacked by a shared `stackId`, `ResponsiveContainer`, a custom `Tooltip` component, `Legend`. Recharts draws SVG in the browser, so every chart is a Client Component and the page shows a fixed-height placeholder until it mounts.

Shared kit `src/components/charts/` (new; the existing `donut-chart.tsx` is reused, not moved): `chart-frame` (title, grain switch slot, "Chart / Table" toggle, export menu), `money-axis` (compact dollars, "$1.2M"), `period-axis`, `chart-tooltip` (full amounts, change against the previous period), `chart-legend` (click toggles a series, keyboard reachable), `series-table` (the same data as an accessible table with a totals row), and eight colour tokens `--chart-1` … `--chart-8` added to `src/styles/globals.css` with text contrast checked.

Common interactions: hover or focus shows the tooltip; the grain switch (Month / Quarter / Year) and the range apply to the whole page and live in the URL query, so a view can be bookmarked; clicking a quarter or year bar drills into its months, with a breadcrumb back; legend items toggle series; every chart has a table view of exactly the plotted numbers; periods with no data show a gap, never a zero.

| # | Chart | Type | Series | Axes | Notes |
|---|---|---|---|---|---|
| F1 | Revenue and net operating income | bars + line | Gross Revenue, operating expenses, Management Fee (bars); net operating income (line) | period × dollars | the headline chart |
| F2 | Expenses by category | stacked bars; donut for the selected period | one series per expense category | period × dollars | categories humanised as in the report |
| F3 | Cash flow of the period | waterfall (stacked bars with an invisible base) | revenue → other income → expenses → Management Fee → reserves set aside / released → distributions → change in Available Cash | steps × dollars | one period at a time; shows where the money went |
| F4 | Distributions | stacked bars + line | preferred return, return of capital, residual (bars); cumulative distributions (line, right axis) | period × dollars | Common residual shown as its own series |
| F5 | Capital | lines | paid-in capital, unreturned capital (left); DPI (right, "x") | month end × dollars | end-of-period values |
| F6 | Preferred return | area + line | accrued to date, paid to date (areas); unpaid balance (line) | month end × dollars | |
| F7 | Reserves | stacked area + reference line | balance by kind; minimum required (line) | month end × dollars | |
| F8 | Utilization | line | monthly percentage | month × 0–100% | shown only when at least one month has a value; labelled "as reported by the Manager" |
| M1 | My distributions | stacked bars + line | my preferred return, return of capital, residual (bars); my cumulative distributions (line) | period × dollars | |
| M2 | My capital | lines | my paid-in, my unreturned capital, my unpaid preferred return | month end × dollars | |

KPI tiles above the charts, each with the value for the selected period and the change against the comparison period. Fund: Gross Revenue, net operating income, distributions paid, Available Cash, reserve balance, paid-in capital, DPI, utilization (when available), months to the Target Sale Date. Mine: commitment and paid in, units and percentage of the Preferred class, distributions received (period and to date), capital returned, unpaid preferred return, my DPI.

#### Export of the current view

- **Excel:** the P7 workbook model and renderer. `financialsWorkbook({ companyName, grain, from, to, publishedThrough, fund, mine? })` → sheets "Summary" (the KPI tiles), "Income" (one row per metric, one column per period, a total column), "Expenses" (category × period), "Distributions", "Capital", and "My investment" in the portal's own view. Same formatting rules as 5.7: frozen header and first column, currency and percent formats, totals as formulas, print setup.
- **PDF:** a print layout of the page. Route `…/financials/print` renders the tiles, the charts at a fixed width and the tables under them with print CSS (page breaks between sections, header with company, period and "published through" date); the button opens it and calls the browser's print dialog, where "Save as PDF" gives a vector PDF of exactly what is on screen. A server-built PDF is the alternative (section 9.2): `@react-pdf/renderer` is installed but cannot render Recharts, so every chart would be drawn a second time with its own code, about two sessions.

## 6. Screens

### 6.1 Portal (new route group `src/app/(portal)/portal/**`)

The group has its own layout: company-neutral header "Investor portal", the signed-in address, "Change password", "Sign out". Under `/portal/[access]` a tab row: Overview, Financials, My investment, Reports, Documents (6.3). No dashboard sidebar, no link to the team app. Light theme, the same UI kit. Portal pages inherit the root layout's providers (2.1): portal components use the tRPC React client but never `useSession` or anything from `@/providers/next-auth`, and each portal page sets its own `metadata.title` (`{ absolute: "Investor portal" }`) so the tab does not read "Captable, Inc.".

| Route | Content |
|---|---|
| `/portal/sign-in` | Email, password, **Sign in**, "Forgot password?". One error line for every failure (5.2). Reads `?next=`. |
| `/portal/forgot-password` | Email field; afterwards the neutral sentence. |
| `/portal/set-password/[token]` | "Set a password for {email}": new password, repeat, the rule in one sentence, live check against the policy. Or the expired message. |
| `/portal` | Signed-in layout check (redirect to `/portal/sign-in?next=…` without a session). One holder: redirect to it. Several: cards "{holder name} — {company name}". None: "Your access has been turned off. Please contact the Manager." |
| `/portal/go/report/[reportId]` | The landing after an emailed link. Calls `portal.findReport`: one match redirects to that holder's report page; several show a chooser; none shows "This report is not available to this account." |
| `/portal/account` | Change password. |
| `/portal/[access]` | Overview for one holder: see 6.3. |
| `/portal/[access]/reports` | Table: title, type, period, date released. Empty state: "No reports have been published yet." |
| `/portal/[access]/reports/[reportId]` | `ReportView` with the frozen content; **Download Excel** for quarterly and annual reports; the file list ("Your documents" for private files, "Attachments" for shared). A client component calls `markViewed` once. |
| `/portal/[access]/documents` | Table: name, category, date shared, size, "Open". Empty state: "No documents have been shared with you yet." |

Every page under `/portal/[access]` loads through the RSC caller and renders `notFound()` on `NOT_FOUND`. File buttons call the `fileUrl` mutation from the browser and open the returned URL in a new tab.

`/member-reports/[token]` (existing page, edited in P5): calls `memberReportView.route` first and renders one of the rows of P25. For `PORTAL` it first checks the browser's portal session with `portal.findReport` and redirects when there is a match; otherwise it shows the interstitial with **Sign in** (to `/portal/sign-in?next=/portal/go/report/{reportId}`) and, when set-up is needed, **Email me my set-up link**. `LEGACY` renders today's page unchanged.

### 6.2 Team side

| Screen | Change |
|---|---|
| Member page, Profile tab (`member-profile-card.tsx` plus a new `portal-access-card.tsx`) | Card "Portal access": one row per portal user (email, status, "password set" or "invited, not yet set up", "locked", last seen) with Resend invitation / Disable / Enable / Unlock; "Invite to portal" opens a dialog with the email prefilled from the notice email and the sentence "This person will be able to see the documents shared with {holder} and the reports released to them." Link "See what this member sees" opens a dialog fed by `portalAdmin.holderView`. |
| Report editor (`ReviewSendDialog` in `report-editor.tsx` becomes the release dialog) | Button "Release…". The dialog shows, top to bottom: the checklist as today; **Audience**: preset buttons and a searchable table of holders with tick boxes (name, class and units, notice email, portal state, K-1 attached for `TAX_K1`), the count selected, and warnings ("{n} current Members are not selected", "The transferring Member is selected", "{n} selected holders are not Members"); **Delivery**: "Publish to the investor portal" (always on, shown as a fixed line), a tick box "Also send by email", and under it, when it applies, "Invite these {n} holders to the portal at their notice email" (ticked) with the addresses; **Consequences**: books closed through {date}; which deadlines will be marked done or stay open and why (P22); "{n} selected holders have no portal access and will not be emailed: they will receive nothing" when that is the case. Confirm: "Release to {n} holders". |
| Report page (`reports/[reportPublicId]/page.tsx`) | Status "Released". Panel "Investor portal": "Published {date}" with **Unpublish**, or "Unpublished {date}" / "Not published (sent before the portal)" with **Publish to portal**. Recipient table: columns "Emailed" (date or "Not emailed" with **Email**), "Portal" (no access / invited / active; first viewed), row actions Resend, Replace link, Remove (when allowed). Buttons **Add recipients…** (the audience picker for holders not yet on the list, with the two delivery ticks) and **Email all not yet emailed**. **Download Excel** for quarterly and annual. |
| Reports list (`report-table.tsx`) | Status chips "Draft", "Released", "Unpublished"; a mail icon when emailed. |
| Documents table (`documents/components/table.tsx`) | The commented-out "Share document" item is replaced by **Share with investors**: a dialog with the current list (holder, date, Remove), the preset buttons and holder table as in the release dialog, "{n} current Members are not on this list", the unticked box "Email them that new documents are available", and the P14 notice or the generated-file warning when it applies. A "Shared with" column shows "{n} holders" or "—". Row selection plus a bulk "Share with investors". |
| New page `/[publicId]/investor-portal` | Two tabs. "People": the `overview` table with filters and the same row actions. "Activity": the access log with filters by member and by item. One entry "Investor portal" in the LLC navigation (`src/components/dashboard/sidebar/nav-config.ts`), shown with `portal: read`. |
| Roles settings | The new subject `portal` appears in the role editor automatically (it maps over `SUBJECTS`). |

### 6.3 Dashboard screens

Portal navigation for one holder becomes: **Overview**, **Financials**, **My investment**, **Reports**, **Documents**.

| Route | Content |
|---|---|
| `/portal/[access]` (Overview, replaces the earlier home) | Header "Figures published through {date}". The fund and "my" KPI tiles for the latest published quarter with the change against the quarter before, charts F1 and M1, "Latest report" card linking to the report of that period, the three newest documents. |
| `/portal/[access]/financials` | Controls: grain (Month / Quarter / Year), range (presets "Latest quarter", "Year to date", "Last 4 quarters", "Since inception", or two month pickers bounded by the published-through date), comparison (previous period / same period last year / none). Fund tiles, then F1–F8. A "Periods" strip lists each published quarter and year with **Read the report** where one is visible. Export menu: Excel, Print / PDF. |
| `/portal/[access]/investment` | "My" tiles, M1 and M2, a table of my distributions (date, type, preferred return, return of capital, residual, offsets, net), a table of my contributions. Export menu. |
| `/portal/[access]/financials/print`, `/investment/print` | The print layouts (5.9). |
| `/portal/[access]/reports`, `/reports/[reportId]` | As 6.1; the report page gains "See this period in Financials". |
| `/portal/[access]/documents` | As 6.1. |

Empty state for a holder with no published period: the navigation shows Reports and Documents, and Overview says "No financial periods have been published yet."

Team side:

| Screen | Change |
|---|---|
| New page `/[publicId]/financials/dashboard` (first tab of the existing Financials area) | The same components. A source switch: **Live** (ledger through today, current month marked "in progress"), **Published** (snapshots), **Preview as…** (holder picker; shows that holder's Overview, Financials and My investment exactly, with a banner naming the holder). A status line: "Published to investors through {date} · books closed through {date}", and "{n} published months differ from the ledger" with **Review and restate** when `status.drift` is not empty. |
| Restate dialog | Month range, the old and new value of each changed figure, a required reason, the sentence "Investors will see the new figures and a 'Restated' note." |
| Release dialog (quarterly, annual) | Two additions to 6.2: a **Reconciliation** block (P38: "Figures match the ledger", or the list of differences with **Refresh from ledger**; Release is disabled while it is not empty) and, under Consequences, "The financial dashboard will show figures through {period end} to the selected holders." |
| Report page | "Financials published through {date}" beside the publish panel. |

How the owner publishes a period: enter the months' revenue and costs as today, create the quarterly report, press Release, choose the audience. That one action closes the books, freezes the report, stores the month snapshots and moves the published-through date for the selected holders. There is no second publish step for financials (alternative in section 9.2).

## 7. Security

| # | Threat | Control |
|---|---|---|
| S1 | An investor session reaches team data | Separate account table, cookie and session table; team procedures, server actions and pages read only the next-auth session (5.1, G6). Test T-ISO-1. |
| S2 | A team session or no session reaches portal data | `portalSessionProcedure` reads only the portal cookie and nulls `ctx.session` (G1). Test T-ISO-2. |
| S3 | Holder A reads holder B's data by changing an id | The holder comes only from the access row, which must belong to the signed-in portal user (P10, G2). Report and document ids are looked up together with the visibility rule; a miss is the same `NOT_FOUND` as "does not exist". |
| S4 | Another holder's K-1 | `visibleAttachmentWhere` with the holder from the context, in the list and again in `fileUrl`; on `TAX_K1` only own files (P12), whatever audience was selected. Release refuses a `TAX_K1` recipient without a K-1 attached. K-1 files are not `Document` rows and cannot be shared through documents. |
| S5 | The Manager user selects the wrong audience | The audience is now a human choice. Controls: presets default to today's rule-based audience; the dialog warns on every departure from it; the server refuses foreign ids, prospects and K-1-less holders; the audit row lists the holders; a recipient that has not been emailed or opened the report can be removed; unpublish hides the report for everyone at once. |
| S6 | Other Members' names and amounts through a shared file (Exhibit A, executed resolution, filed report PDF) | Not preventable by code: the team decides. The share dialog warns on generated files and on the Member-list books category. Holder-bound documents are refused for anyone else (P14), at share and again at read. |
| S7 | Other Members' data through a report or its Excel export | The portal returns what the emailed link returned: frozen content plus permitted attachments. The workbook is built from the frozen figures only (5.7); a test asserts that no recipient name, email or id appears in it. |
| S8 | Password guessing | bcrypt cost 12; 12-character minimum with a common-password block list; lock after 5 failures per account (P6); per-IP bucket in the proxy; one generic error. |
| S9 | Locking an investor out on purpose | 15-minute bound; reset by email works during a lock and clears it; the team can unlock; the lock notice is limited to one a day (5.2). |
| S10 | Finding out which addresses are investors | Sign-in, reset and set-up requests answer identically; a dummy hash comparison equalises timing; emails are sent from jobs. |
| S11 | A reset or invitation link stolen from a mailbox or a log | One use, 60 minutes or 7 days, hash at rest, redacted from logs, `same-origin` referrer. A used link sets the password and so announces itself: the real owner's old password stops working and a "password changed" email is sent. Whoever controls the mailbox controls the account; that is the trust level of every emailed link today. |
| S12 | A stolen database | Passwords are bcrypt hashes; session, reset and invitation secrets are stored only as SHA-256; nothing in the portal tables can be replayed. |
| S13 | A password longer than bcrypt reads | The policy limits the UTF-8 length to 72 bytes, so no password is silently cut (2.8). |
| S14 | Sessions that outlive a password change or a team decision | Setting a password revokes all sessions; access, share, publication and recipient rows are re-read on every request (P16). |
| S15 | A forwarded report email | In the first four rows of P25 the link gives no content: the reader must sign in with an account that has access to that holder. Set-up links go only to the address a Manager user invited, never to the browser that opened the report link. In the two token-page rows the link behaves as today (a forwarded link shows the report), which is the existing accepted risk; those rows shrink as holders are invited. |
| S16 | Open redirect after sign-in | `safeNextPath` accepts only paths under `/portal/` (5.2); applied at issue, on the page and in the handlers; the token is never part of a `next` value. |
| S17 | Cross-site request with the portal cookie | `SameSite=Lax`; `Origin` check on every portal mutation and on the three route handlers; state changes are POST only. |
| S18 | Cookie theft through script injection | `HttpOnly`; the nonce CSP from the proxy applies to `/portal`; report text is rendered from the validated document model, never as HTML. |
| S19 | A presigned storage URL is forwarded or logged | 60-second lifetime; returned by a mutation, never placed in a page URL; Sentry and the proxy already redact signed URLs. The storage key and bucket id are never returned. |
| S20 | Spreadsheet formula injection | Text is written as string cells; only the renderer creates formulas, from cell addresses it computed (5.7). |
| S21 | Passwords in logs or error reports | Sent only in JSON bodies to route handlers that log nothing, and to one tRPC mutation whose input is not attached to error reports (5.2). |
| S22 | A new portal procedure added later forgets a filter | Two visibility modules (5.4); the source-reading test of G5; portal packages get a review pass. |
| S23 | The team invites the wrong address | The dialog shows the address and the holder before sending, and the release dialog lists every address it will invite; the Audit row records both; Disable takes effect at once; the access log shows whether anything was opened. |
| S24 | Shared computers | 24-hour idle limit, 7-day absolute limit, visible "Sign out" (P7). |
| S25 | Ids in URLs | Only `PortalAccess.publicId`, report `publicId` and document `publicId` appear. They identify, they do not authorize. |

| S26 | An investor sees figures for a period that was not published | The dashboard reads only snapshot rows, and only months up to the holder's published-through date, which is derived from the reports visible to that holder (P33). The live ledger is not reachable from any portal procedure; the G5 source test also forbids portal files from importing `@/server/llc/economics`. |
| S27 | Figures change under the investor | Snapshots are written once at release and change only by Restate, which keeps the old rows, needs a reason, is audited and is shown to the investor (P34, P35). |
| S28 | Another holder's position through the dashboard | Holder snapshots are read by the holder id from the context only (P36); the fund view has no per-holder rows and no names. Test T-FIN asserts it by id. |
| S29 | The dashboard and a report show different numbers | One set of pure functions feeds both, proved by tests (5.9); release refuses a report whose ledger-derived figures differ from the ledger (P38). They are equal at release. After a Restate they differ by design and both screens say so (P35). |
| S30 | A client asks for a range past the published date | The server never returns later months, whatever the input; exports clamp `to` (5.9). Range and grain are applied in the browser to data the holder is already allowed to have. |

Residual risks, stated plainly: with very few Members, fund totals together with a holder's own figures let that holder work out the others' combined amounts (unavoidable when fund totals are shown at all); password and mailbox are the only factors until the emailed code of phase 3; a file or workbook once downloaded cannot be recalled; the in-memory IP limiter multiplies with replicas (already noted in `rate-limit.ts`); the audience of a report is now a human choice (S5).

## 8. Work packages

### 8.1 Overview

| id | Package | Size | Needs | Can run in parallel with |
|---|---|---|---|---|
| P0 | Schema, migration, registries, dependency, router stubs | 1 session | — | P1 |
| P1 | Pure cores and their tests | 1–2 sessions | — | P0 |
| P2 | Accounts, passwords, sessions, procedure base (review pass) | 2 sessions (a, b) | P0, P1 | — |
| P3 | Portal access admin: backend and member page | 1 session | P2a | P4, P6, P7 |
| P4 | Release: split of `send`, audience, publish state (review pass) | 3 sessions (a, b, c) | P0, P1; P3 for `inviteHolder` in 4b | P6, P7 |
| P5 | Portal report procedures and emailed-link routing (review pass) | 2 sessions (a, b) | P2b, P4a | P6, P7 |
| P6 | Document sharing and portal document procedures | 1 session | P2b | P3, P4, P5, P7 |
| P7 | Excel export | 1–2 sessions | P0 | P3–P6 |
| P8 | Portal UI | 2 sessions (a, b) | P2b; P5, P6, P7 for b | P9, P10 |
| P9 | Team UI: share dialog, portal page | 2 sessions (a, b) | P3, P4c, P5, P6 | P8, P10 |
| P10 | "New documents" notification email | 1 session | P6 | P8, P9 |
| P12 | Financial series cores (pure) | 2 sessions | — | P0–P7 |
| P13 | Snapshots, restatement, dashboard procedures (review pass) | 2 sessions (a, b) | P0, P12, P4a, P5a | P14 |
| P14 | Chart kit and dashboard components | 2 sessions (a, b) | P12 | P13 |
| P15 | Portal dashboard pages | 1–2 sessions | P8a, P13b, P14 | P16 |
| P16 | Team dashboard, preview, restate, release reconciliation | 2 sessions (a, b) | P4c, P13, P14 | P15 |
| P17 | Dashboard exports: Excel and print / PDF | 1–2 sessions | P7, P12, P13b, P15, P16a | — |
| P11 | Isolation tests, integration script, seed, browser pass, doc edits (runs last) | 2 sessions | all | — |

Order: [P0, P1, P12] → P2a → P2b → [P3, P4a, P6, P7, P14a] → [P4b, P5a, P14b] → [P4c, P5b] → [P13a, P8, P9, P10] → P13b → [P15, P16] → P17 → P11. P13a runs only after every P4 session is merged, because it inserts into `release.ts`. About 29 to 33 sessions: 13 in the first version, 19 to 21 after the owner's first decisions, 10 to 12 more for the dashboard, and P11 grows to two.

Shared files are edited only by P0, except the lines named below. P0 lands every registry entry the later packages need, so they do not collide.

### P0 — Schema, migration, registries, dependency, stubs

**Goal.** The data model of section 4 and every shared-list entry, with empty routers, so later packages touch only their own files.

**Files.** `prisma/schema.prisma` (append section 4; the columns and index on `MemberReport` and `MemberReportRecipient`), `prisma/migrations/20261115000000_investor_portal/migration.sql`, `package.json` and `pnpm-lock.yaml` (`exceljs` 4.4.0), `src/lib/rbac/subjects.ts` (`"portal"`; the role editor, `src/components/modals/role-create-update-modal.tsx`, lists `SUBJECTS` and needs no edit), `src/server/audit/schema.ts` (the actions of 5.5, 5.6 and 5.9; targets `portalAccess`, `portalDocumentGrant`), `src/constants/job.ts` (group `portal`), `src/lib/rate-limit.ts` and its test (5.2), `src/lib/token-redaction.ts` and its test (5.2), `src/trpc/api/root.ts` (keys `portalAuth`, `portal`, `portalAdmin`, `financialDashboard`), the four routers complete in shape: each `router.ts` lists every procedure key of 5.4, 5.6 and 5.9 (including the new `financialDashboard` router), each key imported from its own file under `procedures/`, each file a stub that throws `NOT_IMPLEMENTED` on the right base (`withLlcAccessControl` for `portalAdmin`; `withoutAuth` for the `portal` stubs until P2 swaps the base). Later packages replace procedure files and never edit these `router.ts` files. Also `src/server/file-uploads.ts` (optional `expiresIn`).

**Interfaces delivered.** Prisma models and enums of section 4 (`@/prisma/enums`); RBAC subject `portal`; the audit actions and targets; job names `portal.account-email`, `portal.notification-email`; rate-limit bucket `portal-login`; `getPresignedGetUrl(key, file?, { expiresIn? })`; router keys `portalAuth`, `portal`, `portalAdmin`, `financialDashboard`; the models `FinancialSnapshot` and `HolderFinancialSnapshot`; the audit action `financials.restated`; the `exceljs` package.

**Acceptance.** `prisma validate` and `prisma generate` pass; the migration applies to a copy of the current schema and to an empty database, and after it every existing `MemberReport` row has `publishedAt` and `unpublishedAt` null; a path `/portal/set-password/abc…` is logged as `/portal/set-password/[token]`; `classifyRequest("POST", "/portal/auth/sign-in")` is `portal-login` and `classifyRequest("POST", "/api/trpc/portalAuth.requestReset")` is `account`; the four verification commands pass.

**Do not touch.** `src/trpc/api/trpc.ts`, `src/server/auth.ts`, `src/proxy.ts`.

### P1 — Pure cores

**Goal.** Every decision that needs no database, with tests.

**Files** (each with its test).

- `src/lib/portal/token-core.ts`: `newToken()` → `{ token, hash }`, `hashToken`, `isTokenShape`, expiry constants.
- `src/lib/portal/session-core.ts`: `classifySession(row, now)` → `OK | EXPIRED | IDLE | REVOKED`, `shouldTouch`, `cookieName(baseUrl)`, `parseCookie(header, name)`, `sameOrigin(originHeader, baseUrl)`.
- `src/lib/portal/password-core.ts`: `checkPassword(password, email)` → `{ ok } | { ok: false, reason }`, `COMMON_PASSWORDS`, `signInOutcome({ lockedUntil, failedSignIns }, matched, now)` → `{ result: "OK" | "REFUSED", failedSignIns, lockedUntil, lockedNow }`, `lockNoticeDue(lockNoticeSentAt, now)`.
- `src/lib/portal/throttle-core.ts`: `resetRequestAllowed(createdAtList, now)`.
- `src/lib/portal/next-path.ts`: `safeNextPath(value)`.
- `src/lib/portal/visibility-core.ts`: `documentShareability(doc)` → `ANY | HOLDER_ONLY`, `normalizePortalEmail`.
- `src/lib/portal/audience-core.ts`: `audiencePresets(reportType, noticeKind, holders, transferorId)` → presets and the default; `audienceProblems(reportType, selectedIds, holders)` → refusals (prospect, K-1 missing, unknown id) and warnings (current Member not selected, transferor selected, non-Member selected); `deadlineOutcome(reportType, emailTicked, selectedIds, currentMemberIds)` → `DONE | STAYS_OPEN` with the sentence shown in the dialog.
- `src/lib/portal/report-link-core.ts`: `reportLinkState({ publishedAt, unpublishedAt, addresseeAccess })` → `LEGACY | WITHDRAWN | PORTAL | ACCESS_OFF` and `setupNeeded` (the table of P25).

**Interfaces delivered.** The functions named above, imported by P2 (tokens, sessions, passwords, throttle, next path), P4 (audience, link state) and P6 (visibility). No dependency on any other package.

**Tests (examples).** A session last seen 24 h 1 s ago is `IDLE`; created 7 days 1 s ago is `EXPIRED`. `checkPassword("password1234", …)` is refused (common); an 11-character password is refused; a 30-character password of 3-byte characters (90 bytes) is refused for length in bytes; a password containing `jsmith` for `jsmith@x.test` is refused. Four wrong passwords: not locked; the fifth: `lockedNow`, `lockedUntil = now + 15 min`; a correct password during the lock is `REFUSED`; one second after the lock ends it is `OK` and the counter is 0. `safeNextPath("/portal/go/report/abc")` is kept; `"//evil.example"`, `"/portal/../x"`, `"/login"`, `"/portal/auth/sign-out"` and `"https://evil.example/portal/"` become `/portal`. `reportLinkState` reproduces every row of the P25 table. `audienceProblems` refuses a prospect and a K-1-less holder on a `TAX_K1` report; `deadlineOutcome("QUARTERLY", true, all current Members)` is `DONE`, with one Member missing or with email unticked it is `STAYS_OPEN`. `sameOrigin` is false for a foreign origin, a missing header and the string `"null"`.

### P2 — Accounts, passwords, sessions, procedure base

**Goal.** Sections 5.2 and 5.3 working end to end with minimal pages, so later packages can call `investorProcedure`.

**Session a.** `src/server/portal/session.ts` (`loadPortalSession`, `createPortalSession`, `revokeSessions`), `src/server/portal/account.ts` (`issueToken`, `peekToken`, `setPasswordWithToken`, `verifySignIn`, `changePassword`), `src/server/portal/log.ts` (`writePortalLog`), `src/trpc/api/portal-procedure.ts` (with `resolveInvestor`), `src/trpc/routers/portal-auth-router/**` (`requestReset`), `src/trpc/routers/portal-router/procedures/{me,change-password}.ts`; swaps the base of the `portal.*` stubs to `investorProcedure`.

**Session b.** Route handlers `src/app/(portal)/portal/auth/{sign-in,set-password,sign-out}/route.ts`; `src/jobs/portal-account-email.ts` (invitation, access added, reset, password changed, locked; one job per token or event id; skips a used or expired token), `src/emails/{PortalInviteEmail,PortalAccessAddedEmail,PortalPasswordResetEmail,PortalPasswordChangedEmail,PortalLockedEmail}.tsx` (delete the unused `MagicLinkEmail.tsx`), its lines in `src/jobs/register.ts`; functional, unstyled pages `sign-in`, `forgot-password`, `set-password/[token]` (P8 finishes them).

**Interfaces delivered.** `portalSessionProcedure`, `investorProcedure`, `resolveInvestor(db, cookieHeader, accessPublicId)` and the context types from `src/trpc/api/portal-procedure.ts`; `issueToken(tx, { portalUserId, purpose, nextPath?, requestIp })` → `{ tokenId }` and `emitPortalAccountEmail({ kind, tokenId?, accessId? })` for P3 and P4; `writePortalLog(db, ctx, { event, targetType?, targetId?, targetName? })` for P5–P7; `loadPortalSession` for the portal layouts (P8).

**Acceptance.** With a hand-inserted `PortalUser` (no password) and `PortalAccess`: a hand-issued set-password link shows the form; a weak password is refused and the link still works; a good one signs in and `portal.me` returns the holder; the same link again shows the expired message; signing out and in with the password works; five wrong passwords lock the account, the sixth attempt with the right password is refused with the same message, one lock email is in the catcher, and a reset link sets a new password, signs in and clears the lock; after the reset the old session cookie is refused; an unknown address gets the same reset sentence and no email; a fourth reset request inside 15 minutes sends nothing; after `status = DISABLED` the next `portal.me` returns no holder; a request with only a next-auth cookie gets `UNAUTHORIZED`; a POST to `sign-in` with a foreign `Origin` is refused; the stored hash starts with `$2` and has cost 12; no log line or Sentry event contains the password or the token.

**Do not touch.** `src/server/auth.ts`, `src/trpc/api/trpc.ts`, anything under `(authenticated)`, the team password flow.

### P3 — Portal access admin

**Goal.** A Manager user can invite, re-invite, disable, re-enable and unlock portal access for a holder from the member page (rules P1–P3, P9, P29, P30).

**Needs.** P2a (`issueToken`, `emitPortalAccountEmail`). The emails arrive with P2b.

**Files.** `src/server/portal/invite.ts` (`inviteHolder(tx, { companyId, stakeholderId, email, name?, invitedById })` → `{ accessId, emailKind, tokenId? }`), `src/trpc/routers/portal-admin-router/{schema.ts,procedures/{access-for-holder,invite,resend-invite,set-access-status,unlock,overview}.ts}`, `src/components/llc/portal/{portal-access-card,invite-dialog}.tsx`, one insertion in the member page Profile tab, one statement in `src/server/api/routes/stakeholder/delete.ts`.

**Interfaces delivered.** `inviteHolder` for P4b.

**Acceptance.** Inviting `a@x.test` for a holder creates one user, one access, one email-log row of kind `portal.invite` on that member's Emails tab and one audit row; inviting the same address for a second holder (the two-trusts case) after the password was set creates a second access, sends the "access added" email with no token, and `portal.me` lists both; Disable removes it from `portal.me` at once; inviting is refused with the mail message when production uses the mail catcher; a custom role without `portal` cannot invite; a `stakeholderId` of another company is `NOT_FOUND`; no procedure returns or accepts a password.

### P4 — Release: split of `send`, audience, publish state

**Goal.** Rules P17–P24 and P27 in the report router, the email job and the report screens. This package edits shipped governance code and overrides `03-governance.md` G12 ("send"), R22 and R22a (server-derived audience) and C3.7 (recipients added by `resend`).

**Session a (backend core).** `member-report-router/procedures/release.ts` (replaces `send.ts`; keep its lock order and steps), `audience-options.ts`, `publish.ts`, `unpublish.ts`, the edit of `audience.ts` (it now builds the candidates and presets, using `audience-core`), `schema.ts`, `router.ts`, the new fields in `get.ts` and `list.ts`.

**Session b (after release).** `add-recipients.ts`, `remove-recipient.ts`, the edit of `resend.ts` (P21), `inviteMissing` in `release.ts` and `add-recipients.ts` (uses P3's `inviteHolder`), the wording of `src/emails/MemberReportEmail.tsx`, the comment in `src/server/governance/k1-coverage.ts`, the `sentAt` readers of 5.5 (`member-activity.ts`, `member-activity-tab.tsx`, the label in `report-pdf.tsx`, `unit-transfer-router/procedures/get.ts`, `transfer-detail.tsx`).

**Session c (UI).** The release dialog in `src/components/governance/report-editor.tsx` (replaces `ReviewSendDialog`), `src/components/governance/{audience-picker,report-publish-panel,report-recipient-table,report-table}.tsx`, the report page.

**Interfaces delivered.** The report columns and states that P5 reads; `AudiencePicker` (also used by P9 for documents: props `{ holders, presets, selected, onChange, warnings }`).

**Acceptance.** Release with all current Members and email ticked behaves as `send` did: same recipients, frozen content and hash, books closed, quarterly deadline done, emails queued, and `publishedAt` set. Release without email: no email-log row, deadline stays open and the audit summary says so, the report is `SENT` and published. Release with a subset: only those holders have rows. A foreign id, a prospect, and a K-1-less holder on a `TAX_K1` report are each refused and nothing is written. Release in production with the mail catcher: refused with email ticked, accepted without. `addRecipients` on a `TAX_K1` report for a holder with a late K-1 creates the row; `resend` alone no longer does. `removeRecipient` works for a never-emailed, never-viewed row and is refused after an email or a view. `unpublish` then `publish` restore the same state. `inviteMissing` creates one access per selected holder whose notice address has none, and one invitation email each; a caller without `portal: create` is refused when the flag is set and accepted without it. On the member page a never-emailed recipient shows a release date and no email date. The existing governance tests pass; `send` no longer exists in the router and no screen calls it.

**Do not touch.** The freeze, hash and books-closing code inside the transaction (moved, not rewritten); `src/jobs/governance-report-file.ts`; the sweep.

### P5 — Portal report procedures and emailed-link routing

**Goal.** Rules P11, P12, P25, P26: the report procedures of the portal and the new behaviour of `/member-reports/{token}`.

**Session a.** `src/server/portal/visibility-reports.ts`, `src/trpc/routers/portal-router/procedures/{reports-list,reports-get,reports-mark-viewed,reports-file-url,find-report}.ts`.

**Session b.** `src/trpc/routers/member-report-view-router/{access.ts,access.test.ts,schema.ts,router.ts,procedures/{resolve,view,mark-viewed,attachment-url,route,request-setup}.ts}`, `src/app/member-reports/[token]/page.tsx`, `src/components/governance/report-link-interstitial.tsx`, `src/app/(portal)/portal/go/report/[reportId]/page.tsx`.

**Interfaces delivered.** `visibleReportWhere(holder)` and `listVisibleReports(tx, holder)` (used by P9's `holderView` and by P7's export check).

**Acceptance.** A released report is listed for a selected holder and absent for an unselected holder of the same company; on a published `TAX_K1` report holder A's `get` lists only A's K-1 and `fileUrl` with B's attachment id is `NOT_FOUND`; after `unpublish` the portal list drops it and the emailed link shows "no longer available", and `memberReportView.view` with that token is `NOT_FOUND`; a report sent before this plan still opens on the token page exactly as before; for a published report whose holder has a password-set access, the link shows the interstitial, `view` returns `NOT_FOUND`, and after sign-in the browser lands on that report; with access but no password, "Email me my set-up link" sends one email to the invited address (not shown on the page), and completing it lands on the report; when the addressee was never invited the token page renders, also when another person has access to the same holder; when the addressee's access is DISABLED the link shows "access turned off" and `view` is `NOT_FOUND`; a portal user with access to two recipient holders gets the chooser; `fileUrl` writes one log row with the real client address.

### P6 — Document sharing and portal document procedures

**Goal.** Rules P13, P14, P28: explicit share lists on the team side and the two document procedures of the portal.

**Files.** `src/trpc/routers/portal-admin-router/procedures/{share-options,share-documents,unshare-document,access-log}.ts`, `src/server/portal/visibility-documents.ts`, `src/trpc/routers/portal-router/procedures/{documents-list,documents-file-url}.ts`.

**Interfaces delivered.** `listVisibleDocuments(tx, holder)` and `canOpenDocument(tx, holder, documentPublicId)`; `shareDocuments` leaves a marked `notify` branch for P10.

**Acceptance.** No shares: the list is empty for every holder. Sharing with holders A and C: A and C see it, B does not, and B's `fileUrl` with that id is `NOT_FOUND`. Sharing with the preset "Preferred Members" stores one row per Preferred Member of that day; a Member admitted afterwards does not see the document until added, and `shareOptions` reports "1 current Member is not on this list". A W-9 tied to holder A cannot be shared with B (`BAD_REQUEST` naming the rule), and a hand-inserted row for B is ignored at read. Removing a holder hides the document on the next call. A document of another company is `NOT_FOUND`. The returned URL expires after 60 seconds and no response contains a storage key.

### P7 — Excel export

**Goal.** Section 5.7 for report figures, on both sides.

**Files.** `src/lib/xlsx/{workbook-model,report-workbook}.ts` (+tests), `src/server/xlsx/render.ts`, `src/server/xlsx/render.integration.ts` (a `tsx` script: render, read back with ExcelJS, assert), `src/trpc/routers/member-report-router/procedures/export-xlsx.ts` and its one line in that `router.ts` (P4a edits the same file at the same time; on merge keep both sides), `src/trpc/routers/portal-router/procedures/reports-export-xlsx.ts`, `src/components/common/download-bytes.ts`, `src/components/governance/report-export-button.tsx`.

**Interfaces delivered.** `WorkbookModel`, `renderWorkbook(model): Promise<Buffer>`, `<ReportExportButton mode="team" | "portal" …/>` for P4c and P8b. The model and renderer are what phase 2 exports reuse.

**Acceptance.** For the seeded quarterly report: three sheets named Summary, Expenses, Manager payments; the header row is frozen and bold on every sheet; money cells are numbers with the currency format and negative values show in red parentheses; the Expenses total cell is a formula whose stored result equals the sum of the integer cents ÷ 100; period dates are date cells that read back as the same calendar day; a payee named `=1+1` reads back as text; print setup is landscape, one page wide, header row repeated; two renders of the same report read back to identical sheets, cells, formats and properties (the zip bytes may differ); the file opens in Excel, Numbers and LibreOffice without a repair prompt (browser check B13). The portal procedure is `NOT_FOUND` for a report not visible to the holder and for `TAX_K1` and notices; the workbook contains no recipient name, email or id.

### P8 — Portal UI

**Goal.** The pages of 6.1.

**Needs.** P2b for session a; P5, P6 and P7 for session b. Consumes only `portal.*` procedures, `loadPortalSession` and `resolveInvestor`.

**Session a.** `src/app/(portal)/portal/layout.tsx`, the signed-in layout and chooser (`/portal`), the finished `sign-in`, `forgot-password`, `set-password/[token]` and `account` pages, `src/components/portal/{portal-shell,holder-switcher,sign-in-form,password-form}.tsx`.

**Session b.** `src/trpc/routers/portal-router/procedures/home.ts` (it needs the list functions of both P5 and P6), reports list and detail, documents list (the Overview page itself is P15); `src/components/portal/{report-list,document-list,file-button,mark-viewed}.tsx`. Reuses `ReportView`; does not modify it.

**Acceptance.** Browser checks B1–B7 of section 8.2. No portal page imports from `(authenticated)` or uses `useSession`.

### P9 — Team UI: share dialog and portal page

**Goal.** The team screens of 6.2 other than the member-page card (P3) and the report screens (P4c).

**Needs.** P3, P4c (`AudiencePicker`), P5, P6.

**Session a.** `src/components/llc/portal/share-with-investors-dialog.tsx`, the "Shared with" column, row selection and bulk action in `documents/components/table.tsx` and the documents page.

**Session b.** `src/trpc/routers/portal-admin-router/procedures/holder-view.ts` (calls `listVisibleReports` and `listVisibleDocuments`) with the "See what this member sees" dialog, the page `/[publicId]/investor-portal` with its two tabs, one entry in `src/components/dashboard/sidebar/nav-config.ts`.

**Acceptance.** Browser checks B8–B11; `holderView` for a holder returns exactly the ids that `portal.reports.list` and `portal.documents.list` return for that holder (asserted in the P11 script).

### P10 — "New documents" notification email

**Goal.** The optional email of 5.8 for documents, at most one per portal user per share action.

**Needs.** P6 (fills its `notify` branch). **Interface.** `queuePortalNotifications(tx, { companyId, kind, batchKey, subjectLine, stakeholderIds })` → notification ids, and `emitPortalNotifications(ids)` called after commit.

**Files.** `src/jobs/portal-notification-email.ts`, `src/emails/PortalNotificationEmail.tsx`, one line in `src/jobs/register.ts`, the `notify` branch in `share-documents.ts`.

**Acceptance.** Sharing 20 documents in one action with the box ticked sends one email per affected portal user and none to holders without portal access; a user with access to two affected holders gets one email; running the job twice sends once; the email contains no token and no file.

### P11 — Isolation tests, integration script, seed, browser pass, documents

**Goal.** Prove the isolation guarantees G1–G6 and rules P10–P28 and P32–P39 against a real database, leave seed data for demos, and correct the two older plan documents.

**Needs.** All other packages.

**Files.** `src/trpc/routers/portal-router/isolation.test.ts` (source-reading test of G5), `src/server/portal/__integration__/portal.integration.ts`, seed additions, `docs/llc-mode/00-overview.md` (scope decisions, table row for this plan), `docs/llc-mode/03-governance.md` (a dated "Later changes" note covering: section G and risk F.7; G12 `send` replaced by `release`; R22 and R22a audiences are now defaults of a picker; C3.7 `resend` no longer adds recipients; A8 and A10 corrections).

**Seed.** For the seeded LLC: one portal user with a known password and access to two holders, one invited user without a password, one disabled access, one released quarterly report (emailed), one released portal-only annual report, one released `TAX_K1` report, one report "sent before the portal" (never published), one document shared with two holders; twelve months of revenue, expenses, reserves and two distributions, so that four quarters are published and the charts have shape; one restated month.

**Acceptance.** The source test and every assertion of the integration script (8.2) pass; browser checks B1–B21 pass against the seed; `00-overview.md` no longer says an investor portal is not planned and lists this file in its table; the four verification commands pass.

### P12 — Financial series cores

**Goal.** The month records, the aggregation and the period model of 5.9, pure and tested, so the dashboard and the reports cannot disagree.

**Needs.** Nothing from the portal packages. Can run from the start, in parallel with P0–P2.

**Files.** `src/lib/llc/financial-series.ts` (+test): `FundMonth`, `HolderMonth`, their Zod schemas (`schemaVersion: 1`), `buildFundMonth`, `buildHolderMonth`, `aggregate(months, grain, range)`, `dpiBps`, `compareFundMonths(a, b)` (for drift). `src/lib/llc/financial-periods.ts` (+test). `src/lib/governance/report-reconcile.ts` (+test): `reconcileFigures(figures, periodEconomics)`.

**Interfaces delivered.** Everything above, to P13 (server), P14 (charts take `aggregate` output) and P17 (workbook).

**Acceptance.** With the existing economics fixtures (`src/lib/llc/fixtures`): for each quarter, the summed fields of `aggregate` over its three months equal `buildPeriodEconomics` for the quarter, and the end-of-period fields equal its end values; the same for a holder against `buildMemberStatement`; `figuresFromPeriodData` gives identical report figures from either; DPI of 12,000.00 distributed on 100,000.00 paid in is 1200 bps of x ("0.12x") and null on zero paid-in; a month without utilization is null and a quarter with one of three months filled reports that month's value; `reconcileFigures` reports a one-cent difference and ignores notes.

**Do not touch.** `report-data.logic.ts`, `statements.logic.ts`, `positions.ts`, `available-cash.ts` (called, never edited).

### P13 — Snapshots, restatement, dashboard procedures (review pass)

**Goal.** Rules P33–P35, P38, P39 on the server.

**Needs.** P0 (tables), P12, P4a (`release.ts`), P5a (`visibleReportWhere`).

**Session a.** `src/server/portal/financial-snapshots.ts` (`writeSnapshotsThrough`, `restateSnapshots`, `readFundMonths`, `readHolderMonths`, `publishedThroughFor(tx, holder)`), the call and the P38 check inside `release.ts` (two marked insertions; the file is owned by P4a and is edited here only after P4 is complete), `memberReport.reconcile`.

**Session b.** `src/trpc/routers/financial-dashboard-router/**` (`live`, `published`, `status`, `restate`), `src/trpc/routers/portal-router/procedures/financials-get.ts`.

**Acceptance.** Releasing Q1 writes three fund rows and three rows per holder with a position; releasing Q3 without Q2 writes six months; releasing the annual report after Q4 writes nothing new; a release with a hand-edited revenue figure is refused with that field named and succeeds after "Refresh from ledger"; after the books are reopened and a back-dated expense is added, `portal.financials.get` returns the old figures, `status.drift` names the month and field, and after `restate` the portal returns the new figures and the restatement note while the old rows still exist; a holder selected for Q1 only gets months through March although Q2 snapshots exist; unpublishing Q1 empties that holder's dashboard; holder A never receives a `HolderMonth` of holder B (asserted by id in the integration script); `published({ asHolder })` equals `portal.financials.get` for that holder.

### P14 — Chart kit and dashboard components

**Goal.** The chart kit and the ten charts and tiles of 5.9, as components that take `aggregate` output and know nothing about where it came from.

**Needs.** P12. Can run in parallel with P13.

**Session a.** `src/components/charts/{chart-frame,money-axis,period-axis,chart-tooltip,chart-legend,series-table}.tsx`, the colour tokens in `src/styles/globals.css`, `src/components/financials/{kpi-tile,period-controls,use-period-state}.tsx` (URL-backed grain, range, comparison, drill).

**Session b.** `src/components/financials/{revenue-chart,expenses-chart,cash-flow-chart,distributions-chart,capital-chart,preferred-return-chart,reserves-chart,utilization-chart,my-distributions-chart,my-capital-chart,fund-dashboard,investment-dashboard}.tsx`.

**Acceptance.** Each chart renders from fixture months in a story-like dev page; the table view of each shows the same numbers as the tooltip; drill from a quarter to its months and back keeps the range; toggling a series updates chart and legend; the utilization chart is absent when no month has a value; every control is reachable by keyboard; no component imports from `portal-router`, `(authenticated)` or `@/server`.

### P15 — Portal dashboard pages

**Goal.** The portal screens of 6.3.

**Needs.** P8a, P13b, P14.

**Files.** `src/app/(portal)/portal/[access]/{page,financials/page,investment/page}.tsx`, the navigation in `portal-shell.tsx`, the "See this period in Financials" link on the report page. P8b does not build the Overview page; this package does, using `portal.home` and `portal.financials.get`.

**Acceptance.** Browser checks B14–B17.

### P16 — Team dashboard, preview, restate, release reconciliation

**Goal.** The team screens of 6.3.

**Needs.** P4c, P13, P14.

**Session a.** `src/app/(authenticated)/(dashboard)/[publicId]/financials/dashboard/page.tsx`, the tab in the financials `layout.tsx`, the source switch and "Preview as…", the status line.

**Session b.** The restate dialog, the Reconciliation block and consequence line in the release dialog (the dialog is owned by P4c, finished before this session; this is an added block, no change to the audience picker), the line on the report page.

**Acceptance.** Browser checks B18–B20.

### P17 — Dashboard exports

**Goal.** Excel and print/PDF of the current view, both sides.

**Needs.** P7, P12, P13b, P15, P16a.

**Files.** `src/lib/xlsx/financials-workbook.ts` (+test), `portal-router/procedures/financials-export-xlsx.ts`, `financial-dashboard-router/procedures/export-xlsx.ts`, the four print routes and `src/components/financials/print-layout.tsx`, the export menu.

**Acceptance.** The workbook for "Last 4 quarters" has one column per quarter and a total column whose formula result equals `aggregate` for the range; a portal export never contains a month after the published-through date even when `to` is later; the "My investment" sheet is absent from a team export without `asHolder`; the print route gives a PDF with each chart on the page with its table and no cut-off chart (B21).

### 8.2 Test plan

**Unit (vitest).** The P1 cores; the P12 series, period and reconciliation cores with the agreement tests of 5.9; the workbook model, report builder and financials builder; `classifyReportAccess` with the new states; rate-limit and redaction additions; the G5 source test: every file under `portal-router/procedures` imports its base from `portal-procedure` and none imports `withAuth`, `withAccessControl`, `withLlcAccessControl`, `getServerAuthSession` or `@/server/auth`; no file outside `portal-router` and `portal-auth-router` imports `portal-procedure`; no portal `schema.ts` contains the words `companyId` or `stakeholderId`; no file under `portal-router` imports `@/server/llc/economics`.

**Integration script** (local Postgres only, run with `tsx` as the existing scripts). Builds two LLC companies; in company 1 holders A (Preferred Member), B (Preferred Member), C (Common Member), D (Prospect), E (Financial-Interest-only); in company 2 holder F. One portal user has access to A and F; a second to B. Then asserts, through a server-side caller with a forged portal cookie:

- T-ISO-1: with only a portal session, a sample of at least one procedure from every non-portal router is refused.
- T-ISO-2: with only a team session, every `portal.*` procedure is `UNAUTHORIZED`.
- T-ACC: user 1 with B's access id gets `NOT_FOUND`; after A's access is disabled, A's id gets `NOT_FOUND` while F's still works.
- T-PWD: the lock sequence of P6 under two concurrent wrong attempts at the fifth try (exactly one lock, one notice); a set-password token used by two concurrent requests creates exactly one session; a password set revokes every earlier session.
- T-REL: the P4 acceptance list, including the comparison of an "all Members, emailed" release with a recorded `send` result.
- T-REP: the P5 acceptance list, including every row of the P25 table.
- T-DOC: the P6 acceptance list, including the W-9 rule and the later-admitted Member.
- T-XLS: the portal export for A's visible report succeeds and for B's unselected report is `NOT_FOUND`.
- T-FIN: the P13 acceptance list, including the published-through date per holder, stability after a reopened period, restatement, and the absence of any other holder's `HolderMonth`.
- T-LOG: one log row per open or export, none on a refused one.
- Cleans up everything it created.

**Browser checks** (dev server, mail catcher).

- B1 Invite from the member page, open the email, set a password, land on the holder's home.
- B2 Open the invitation link a second time: expired message, with a working "Forgot password".
- B3 Wrong password five times: the generic message throughout; the lock email arrives; reset by email gets in.
- B4 "Forgot password" for an address without access: same sentence, no email in the catcher.
- B5 Two holders on one address: chooser, switcher, each shows only its own items.
- B6 Report detail shows the same content as the old token page for that recipient; a K-1 report shows one file.
- B7 Sign out, press Back: the sign-in page, not cached content.
- B8 Release a report to three of five Members without email: no email in the catcher; the three see it in the portal; the deadline stays open with the explanation. Then "Email all not yet emailed".
- B9 Release with email and "invite the holders without access" ticked: each such holder gets an invitation and a report email; the report link leads through set-up to the report.
- B10 Share one document with two members through the preset and one manual tick; a third member's portal does not show it. Try to share a member's W-9 with another member: refused with the reason.
- B11 Disable access while the investor has the portal open: the next click shows the "turned off" page. The Activity tab shows the sign-in and each open with time and address.
- B12 In one browser, sign in to the team app and to the portal with the same email and different passwords: both work; signing out of one leaves the other.
- B13 Download Excel on the team report page and in the portal: the file downloads under the CSP, opens without a repair prompt in Excel, Numbers and LibreOffice, prints on one page width with the header repeated.
- B14 Portal Overview shows "published through" the latest released quarter; a quarter released to other holders only is absent for this one.
- B15 Financials: switch Month / Quarter / Year, pick "Since inception", compare with the previous period; click a quarter bar to see its months and return; toggle a series; switch a chart to its table.
- B16 My investment shows only this holder's figures; with the two-holder account, switching holder changes them.
- B17 A holder with no published period sees the empty state and no figures.
- B18 Team dashboard Live shows the current month "in progress"; Published matches the portal; "Preview as" a holder matches that holder's portal screen for screen.
- B19 Edit a figure of a draft quarterly report by hand: the release dialog lists the difference and Release is disabled until "Refresh from ledger".
- B20 Reopen the books, add a back-dated expense: the portal is unchanged, the team status line reports the drift, Restate updates the portal and shows the note.
- B21 Export the current view to Excel and print to PDF on both sides; totals match the screen.

## 9. Decisions

### 9.1 Decided by the owner on 2026-11-14

1. **Sign-in is by email and password.** Built as section 5.2. The portal keeps its own accounts, cookie and sessions and never creates a next-auth session.
2. **Publishing is decoupled from emailing.** Releasing a report publishes it to the portal; emailing is a tick in the same dialog. A report can be in the portal without ever being emailed (P17, P19).
3. **The owner selects the audience of every report and every document.** Presets fill the picker; the stored result is the confirmed list of holders (P18, P28). K-1 privacy holds whatever is selected (P12).
5. **Download is allowed, and investors and the team can export to Excel** (P15, section 5.7).
6. **The admin chooses who is invited**: any holder, any address, several people per holder (P3).
9. **Emailed report links bring the investor into the portal** to that report's page (P25–P27).

(The numbers are those of the first version of this list.)

### 9.2 Still open — each has a default in the plan

4. **Shared lists are frozen at the moment of sharing; the owner edits them later.** *Default, pending the owner's confirmation.* What it means: sharing a document with the preset "Preferred Members" stores the Preferred Members of that day, one by one. A Member admitted next month does not see it until someone adds them (the dialog shows who is missing and adds them in one click). A Member that leaves keeps seeing it until removed. The alternative is a live group: the share says "Preferred Members" and follows the register by itself, with nothing to maintain but also no moment where the owner confirms each new viewer. It conflicts with decision 3 as worded, and costs about half a session if wanted.
7. **Session length.** *Default: 7 days, ending after 24 hours without use (unconfirmed).* What it means: after signing in, an investor stays signed in on that browser for up to a week, provided they come back at least once a day; otherwise they type the password again. Shorter is safer on shared computers and more typing; longer is the reverse.
8. **"New documents" emails.** *Default: off unless the Manager user ticks the box in the share dialog (unconfirmed).* What it means: when documents are shared, the investors on the list can get a short email saying new documents are in the portal (no file attached, no special link). Always-on would email every affected investor on every share, including bulk shares. For reports the question no longer exists: the report email is the notice, and it is the "also send by email" tick.
10. **What counts as delivering a report (new; revisits the ruling of 2026-11-14 on K-1 deadlines).** *Default: email, as today.* A portal-only release publishes the report but leaves its deadline open (P22). A quarterly or annual deadline (or a deadline a notice carries) then stays open until the Manager user completes it by hand on the compliance page: emailing the recipients later, or adding recipients, does not close it, because release is the only step that closes it by itself. The year's K-1 deadlines keep today's coverage rule: they close by themselves once every holder of the year has been emailed its K-1, whenever that email goes out, or by hand. The alternative: a report published to a holder that has a working portal account counts as delivered. That is a legal question under the Agreement's notice clause (13.6, governance risk F.8) and deserves counsel's view; in code it is a change to one function plus the K-1 coverage rule, about one session.
11. **Selection is by holder, not by individual portal user (new).** *Default: every portal user with access to a selected holder sees the item.* The alternative lets the owner give a report to the investor but not to their accountant: a second level in every picker and in both visibility rules, about two sessions.
12. **Holders without a portal account who receive a report email (new).** *Default: the release dialog offers to invite them (ticked); if the owner unticks it, their link opens the read-only page as today.* The alternative removes that read-only page for new reports, so a holder without an account sees "ask the Manager for access" and nothing else.
13. **A separate "finalize" step before release (new).** *Default: none; release freezes and publishes in one action after a review dialog.* The alternative adds a frozen-but-not-released state so the final PDF can be read before anyone receives it: about two sessions, and a period with the books closed and no Member holding the report (5.5).

14. **What investors see of live figures, and when (new).** *Default: figures only through the end of the latest quarterly or annual report published to that holder, taken from month snapshots frozen at release; nothing later; changes only by an announced restatement (P33–P35).* A consequence to confirm: a holder left out of a quarter's report audience sees no figures for that quarter, fund-level ones included, until added to it. The alternative is one company-wide date (the latest released quarterly or annual report, whoever received it) for fund figures, with only the report itself limited to its audience. Other alternatives:
    - *Live to today.* Investors see the ledger as it stands, including months not yet reviewed, entries that will be corrected, and the gap before monthly revenue is entered. Numbers can change between two visits without notice. It contradicts the standing rule that investors see only what was published. Less work (no snapshots), more exposure.
    - *A separate "financials published through" date,* set by the owner independently of reports, for example monthly. Investors get fresher figures than the quarterly cycle; the cost is a second publish action to remember, a freeze step of its own (it must close the books for those months or snapshots would drift at once), and periods in the dashboard with no report to explain them. About two more sessions.
15. **Hand-edited report figures (new).** *Default: a quarterly or annual report cannot be released while a ledger-derived figure differs from the ledger (P38).* Today those figures can be typed over. The alternative keeps that freedom and shows both numbers in the dashboard with a "differs from the report" mark: the dashboard and the report can then disagree by design.
16. **Which fund metrics investors see (new).** *Default: the catalogue of 5.9, including Available Cash, reserves by kind, the Management Fee and the Common Member's residual share; no payee names.* The owner may want to hide some of them from investors while keeping them on the team side; each metric can be switched off for the portal in one list.
17. **Utilization (new; the definition is already an open item in `00-overview.md`).** *Default: chart the monthly percentage as typed, labelled "as reported by the Manager", and hide the chart when no month has a value.* Anything richer (GPU count, rented hours, uptime, price per hour) needs a definition and new monthly inputs: a schema and entry-form change, about two sessions once defined.
18. **PDF of the dashboard (new).** *Default: a print layout saved through the browser's "Save as PDF".* The alternative is a server-built PDF with its own drawing of every chart, about two sessions, useful mainly if PDFs must be generated without a person at a browser (for example attached to emails).
19. **Fair value, NAV, TVPI and IRR are not shown (new, for information).** No valuation history is stored; DPI is the only return multiple the data supports. Showing a value per unit would need the owner to record a valuation each period.

## 10. Later phases (outline, not packaged)

**Phase 2 — more of the holder's own data.** All read-only, all through `investorProcedure`, each output built field by field from existing services.

- Statement as of a date: the existing statement PDF, generated for the holder. Decide whether the team must release each statement or the holder may generate it at will (it exposes ledger state that has not been through a report).
- Tax documents: a filtered view of released `TAX_K1` reports (already delivered by phase 1; this is a menu entry and a per-year list).
- Open ballots: the portal lists the holder's open `ResolutionBallot` rows and opens the existing ballot page by signing that ballot's token on the server for this session. Voting rules, the typed-name signature and the evidence record are unchanged.
- Call Notices and distribution notices: lists of the holder's own `CallNoticeLine` and `DistributionLine` rows with the notice PDF, with the same release-and-audience question answered for notices.
- Documents they signed: documents with `Document.stakeholderId = holder` and `kind` in `exhibit-b`, `w9`. Default off per company.

**Phase 3.** The emailed code as second factor (5.2, about one session); Member requests to the Manager (inspection under 8.3 of the Agreement, the 25% initiation under 2.5), which would also remove governance risk F.7; retiring the read-only token page once every holder has an account.

## 11. Points where the existing code makes this harder than it looks

- Report figures are hand-editable and frozen only as period totals, with no monthly breakdown (2.11). A dashboard built on them could not break a quarter into months, and one built on the ledger could contradict them; hence the snapshots and the release check (P34, P38), which changes how the report editor behaves today.
- History is not stable: books can be reopened and back-dated rows added, and the `LlcTerm` interpretation switches recompute every past position (2.11). Anything shown to investors must be stored, and a stored figure needs a controlled way to be corrected (Restate).
- Revenue is monthly, costs are dated, distributions are events and positions are daily. Only the month is a common grain, so the dashboard has no day-level range.
- "Utilization" is one optional typed number with no definition, and there is no operating data (GPUs, hours, uptime) at all.
- Only one chart exists in the app. The chart kit, colour tokens, table views and print layout are all new.

- A next-auth session is not a safe base for investors: it cannot be revoked, and 10 procedure files accept any session (2.1). The plan avoids the problem; it does not fix those procedures.
- The team password flow is weaker than what investors now get: a reset accepts any string, reset tokens are stored in plain text, bcrypt cost is 10, the 72 limit is counted in characters, and there is no lockout (2.8). The portal reuses only the library. Bringing the team flow up to the same standard is separate work worth doing, and until then the weaker door is the team's.
- `send` was built as one irreversible, rule-driven act: audience derived by the server, delivery equal to email, deadlines closed in the same transaction (2.4, 2.9). Decisions 2 and 3 take all three apart. P4 therefore edits shipped, reviewed governance code and overrides rules of `03-governance.md`; it is the riskiest package and gets a review pass.
- "Delivered" means "emailed" in the K-1 coverage code and in a ruling made today (2.9). Publishing without email leaves compliance deadlines open by default; whether portal publication is valid notice is a legal question (9.2, item 10).
- The audience of a report is now chosen by a person. The code can refuse impossible choices and warn about unusual ones; it cannot stop a wrong but valid one (S5).
- An email address does not identify a holder, and the notice address is free text (2.3). Any shortcut that "finds the investor by email" would give one person another holder's K-1.
- Recipients and attachments can still grow after release (2.4), so visibility must be evaluated live.
- Old and new emailed links share one URL. Three report states (never published, published, unpublished) and three holder states decide what a link shows (P25); the "never published" state must be kept distinguishable forever, or links sent before the portal break.
- Storage objects have no owner column; the only checks are the key namespace and the rows that point at a bucket (2.5). Every new download path must repeat both. The data-room pages show what happens otherwise: they hand storage keys to the browser and trust a token that never expires. Do not model the portal on them, and consider retiring or fixing them.
- There are no database foreign keys (`relationMode = "prisma"`), so deletes do not cascade to the new tables (section 4).
- The RSC caller reports `127.0.0.1` (2.2), so the access log is only correct when opens, views and exports are browser mutations.
- The rate limiter is per process and per IP and fails open (2.1); the per-account lock and the per-address throttle in the database are what protect an account and a mailbox.
- Generated documents (Exhibit A, executed resolutions, filed reports) name other Members (2.5). The system cannot tell the team which of them are safe to share; the dialog can only warn.
- No spreadsheet library exists in the repo, and ExcelJS, the only free library that covers the formatting asked for, has had no release since 2023 (5.7). It is confined to one server file so it can be replaced.
- No test can import the tRPC root (vitest has no `@/` alias), so the isolation guarantees are proved by a source-reading test plus a hand-run integration script, not by the normal test run.
- Member-facing email is refused in production until a real SMTP server is configured (2.6). Until then nobody can be invited, and nobody can set a password.

## 12. As built (2026-11-16)

Every package of section 8 is merged. This section records where the code differs from the text above, what the final package (P11) found and fixed, and what is left open. Where this section and the text above disagree, this section describes the code.

### 12.1 Built differently from the plan

- **Route groups.** Portal pages live in `src/app/(portal)/portal/(public)/…` (sign-in, forgot password, set password) and `(signed-in)/…` (chooser, account, go-page, `[access]/…`); the three route handlers are under `src/app/(portal)/portal/auth/`. An unknown path under `/portal/[access]` is a 404 (`[...missing]`).
- **How pages resolve the holder.** Pages do not import `portal-procedure.ts` (G5 allows only the portal routers to). The gate for `/portal/[access]` is `requirePortalHolder` (`src/components/portal/portal-me.ts`): the access must be one of the holders `portal.me` returns for the signed-in user, the same rule as `resolveHolder`. `resolveHolder` (the middleware-B function) is exported beside `resolveInvestor`.
- **`lastSeenAt`.** Every `investorProcedure` call refreshes `PortalAccess.lastSeenAt` (at most every 5 minutes) and the session's `lastSeenAt`. Every page under `/portal/[access]` calls `portal.financials.get` from its layout, so a page view counts as "last seen". Proved in `portal-isolation.integration.ts` section 7.
- **No `schema.ts` in `portal-router`.** Each portal procedure declares its input inline (or imports a browser-safe schema from `src/lib`). The G5 source test reads the `.input(…)` argument of every procedure, and the declarations it names, instead of a `schema.ts`.
- **Sign-in and reset answer at a floor.** The sign-in handler answers no sooner than 600 ms and `portalAuth.requestReset` no sooner than 250 ms, so known and unknown addresses take the same time (S10).
- **RBAC refusals.** `withAccessControl` refuses a role without the subject with `UNAUTHORIZED` and the policy message (not `FORBIDDEN`). Pages that leave out a section the role may not read treat both codes alike (`src/lib/trpc-forbidden.ts`).
- **Sender address.** Account and portal emails (invitation, access added, reset, password changed, locked, new documents) go out under `EMAIL_FROM_TRANSACTIONAL` when it is set; reports, notices and everything else addressed to a Member about the company under `EMAIL_FROM` (`src/lib/mail-sender.ts`).
- **Integration scripts.** One script per package instead of one `portal.integration.ts`: `portal-auth`, `portal-admin`, `portal-reports`, `portal-documents`, `portal-report-links`, `financial-snapshots`, `financial-dashboard`, and from P11 `portal-isolation` (every procedure and route handler, every refusal compared with an unknown id, the answer scan) and `portal-mail-from`.
- **Seed.** `prisma/seeds/llc-portal.ts` builds its own LLC ("Octagon Portal Demo LLC") with twelve months from October 2025, because the governance seed's LLC starts in October 2026 and has no ended quarter to release. Every release is portal-only (no email is sent by a seed), so "one released quarterly report (emailed)" is not seeded. Sign in as `portal.demo@example.com`, password `Portal-Demo-Pass-2026`.
- **P17 history.** The first P17 commit is titled "WIP" (`ff098947`); history was left as it is.

### 12.2 Defects found by the P11 review and fixed

| Severity | Area | Defect | Fix and test |
|---|---|---|---|
| Medium | P13, P38 | A quarterly report ticked "No distribution this quarter" passed the release check while the ledger had distributions; the released report would say there were none. | The check reports field `distributions.none` (`report-reconcile.ts`); unit test. |
| Medium | P2, S10 | Many `portalAuth.requestReset` calls for one known address in one batched HTTP request (one count of the IP limiter) queued on the user's row lock and answered in seconds, or with an error, while an unknown address answered at once. | A per-address `pg_try_advisory_xact_lock`; a request that finds another in progress does nothing; any failure is answered like success. Burst check in `portal-isolation`. |
| Medium | UI | A custom team role without `audits: read` got a 500 on the company home page. | Each Overview section is left out when its read is refused; unit test, and the browser pass with such a role. |
| Low | P5, G4 | `portal.reports.get` and the token page returned each Manager-payment line's internal `resolutionId`. | `portalFigures` returns those lines with `resolutionId: null`; unit test. |
| Low | P5, P16 | The token page's file URLs lived 10 minutes. | 60 seconds, as in the portal. |
| Low | P2 | `readJsonFields` trusted `Content-Length`; a chunked body was read whole before the 4 kB check. | The body is read chunk by chunk and dropped at the first byte over the cap; checked in `portal-isolation`. |
| Low | P2, S21 | The set-password body's repeated password (`confirm`) was not a sensitive key for log and Sentry redaction. | Added; unit test. |
| Low | P13 UI | A release refused by the P38 check was logged as a console error by the tRPC logger link although the dialog explains it. | Not logged (`src/lib/trpc-client-log.ts`); unit test and browser pass. |

### 12.3 Known and not fixed

- **A notification with no job.** If queueing the "new documents" job fails after the share has committed, the `PortalNotification` row stays unclaimed and that email is lost (the documents are in the portal regardless; the failure is logged). A sweep cannot rebuild the job: the row does not store which documents each holder gained, and grant rows cannot be tied to one share action (their `createdAt` is set by Prisma, not by the transaction). Recovery would need a nullable JSON column on `PortalNotification` (an additive migration) holding the payload, read by the existing 15-minute sweep. Not done.
- **A period released after its months were frozen.** Release compares a report with the ledger, not with existing snapshots. After the books are reopened and back-dated entries are added, releasing a report for months that already have snapshots (the annual report after Q4, or a skipped quarter) can freeze figures that differ from the dashboard's for those months; `financialDashboard.status` shows the drift, and Restate fixes the dashboard. Suggested rule: refuse such a release until the months are restated.
- **Partial restatement.** Restating one month leaves the running totals of the later months (paid-in, unreturned capital, reserve balance, Available Cash) as they were; `status.drift` lists those months. Suggested rule: a Restate always runs through the latest snapshot.

### 12.4 Questions for the owner (behaviour as designed, may be unwanted)

1. **Lockout and reset can be combined against an investor.** The reset throttle counts every link sent, whoever asked. Someone who knows an address can spend its 10 resets a day and re-lock the account every 15 minutes, keeping the owner out for up to a day. Options: count only resets that were used, or let the team's Unlock also reset the throttle.
2. **Lock emails to people without active access.** A portal user whose every access is disabled can still be locked and gets the "sign-in is locked" email, though a reset does nothing for them.
3. **Forwarded report links.** Anyone holding a forwarded report email can press "Email me my set-up link" repeatedly; each press cancels the invitee's earlier link and uses their reset allowance (no access is granted).
4. **A disabled access at another address.** If a holder's access at address B is disabled, a report emailed to address A (never invited) still opens as the read-only token page (P25 row 5 as written).
5. **Insider names in reports.** Insider distributions and insider loan payments (names and amounts) are in the report figures shown in the portal and the workbook, as they are in the emailed report (S7). Confirm this agrees with P15 ("never contains another holder's data").
6. **Live term clock.** The dashboard's term clock (Target Sale Date, extensions) is read live, not frozen at release.
7. **Utilization outside the check.** A typed utilization is released as typed; the dashboard shows the monthly values. They can differ, and nothing says so.
8. **Reports released before the portal.** Publishing one moves the holder's published-through date although it passed no P38 check and wrote no snapshots.
9. **Back-filled months.** A Restate that fills months before the first snapshot writes them as version 1, so investors see no "Restated" note for them.
10. **Drift lists holder names** to anyone with `llc-financials: read` (the plan's output was months and fields only).

### 12.5 What production needs

- **Migration** `20261115000000_investor_portal` (the only one of the portal; additive). No other migration.
- **Environment.** `EMAIL_SERVER` must be a real SMTP server: while it is the bundled catcher, invitations, resets, "new documents" emails and releases with email are refused in production (P23, P30), so nobody can be invited or set a password. `EMAIL_FROM` for investor mail; optionally `EMAIL_FROM_TRANSACTIONAL` for account mail. `NEXT_PUBLIC_BASE_URL` must be the public https origin: it decides the cookie name (`__Host-portal_session` on https), the Origin check of every portal mutation and route handler, and the links in emails. `NEXTAUTH_SECRET` as today (report link tokens).
- **Storage CORS.** The portal's file viewer fetches the file from storage in the browser (a simple `GET`, no credentials, no preflight), so storage must answer with `Access-Control-Allow-Origin` for the app origin. MinIO does so by default for every origin (checked on the local MinIO, release 2025-09-07: a presigned GET with an `Origin` header answers `Access-Control-Allow-Origin` with that origin and `Vary: Origin`, with no bucket CORS configuration; MinIO keeps no per-bucket CORS rules). The Dokploy stack therefore needs nothing more, unless `MINIO_API_CORS_ALLOW_ORIGIN` is set, in which case it must include `APP_URL`. When `UPLOAD_PUBLIC_URL` equals `APP_URL` (the proxy routes the bucket paths), the fetch is same-origin and no CORS is involved. On S3 or R2 the private bucket needs a CORS rule allowing `GET` from `APP_URL`. The CSP already allows the storage origin in `connect-src`.
- **Rate limiting** is per process and trusts the leftmost `X-Forwarded-For`; the reverse proxy must overwrite that header.
