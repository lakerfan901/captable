# LLC mode — 00 Overview and execution order

This folder is the implementation plan for administering Octagon GPU I LLC (a Wyoming manager-managed LLC) in this app. It is written for coding agents that execute one work package per session.

| File | Area | Packages | Sessions |
|---|---|---|---|
| `01-foundation.md` | LLC mode, unit classes, member records, commitments and receipts, Member Schedule (Exhibit A), Overview, email log, Exhibit B via e-sign, CSV import | F0–F15 | 24 |
| `02-economics.md` | Calculation library, Call Notices, default workflow, revenue / fee / reserves / Manager payments, distributions, member statement, fair value, term clock | E1–E19 | 19 |
| `03-governance.md` | Voting math, resolutions and ballots, member reports, compliance calendar, unit transfers, books and records | G1–G19 | 29 |

Source agreement: `Octagon_GPU_I_Operating_Agreement_Final v2.docx`. Where a plan and the agreement disagree, the agreement wins and the executor stops and reports.

## Scope decisions already made

- Purchase orders: no purchase-order module. A purchase-order resolution is one preset resolution type that the Manager signs and the app emails to Members (`03-governance.md`, G5/G7).
- Resolutions use a dedicated emailed ballot page with a typed-name signature. E-sign is used for Exhibit B only.
- Members have no login. Everything reaches them as an emailed, tokenized link, and every send is logged.
- Not planned: meetings module, investor portal, tax-proceeding log, 704(b) capital accounts. `03-governance.md` section G gives the manual route for each.

## Conventions that bind all three plans

- `Company.entityType` (`CORPORATION` | `LLC`) gates every new feature. Existing C-corp features are untouched and hidden for LLC companies.
- The holder record stays `Stakeholder` in code; the UI says "Members". The model named `Member` is a team user.
- Money: `BigInt` cents in the database, `bigint` on the server, `number` on every wire. Units: `Decimal(18,6)`, 6-dp strings on the wire. Rates: basis points. Calendar dates: `@db.Date`, `YYYY-MM-DD` strings. "Today" is evaluated in `Company.timezone` (default `America/Denver`).
- One schema migration for all three areas: package **F0** pastes section C of all three plans. The three sets of blocks were merged into a scratch copy of the current schema and pass `prisma validate` together (checked 2026-11-12). Later schema changes are small additive migrations owned by the package that needs them.
- Holdings are computed in exactly one place: `getMemberPositions` (`src/server/llc/positions.ts`, F6).
- Offering terms (price per unit, minimum, cap, 40% installment, Final Closing Date, Balance outside date, 8% actual/365, 70/30) live on `UnitClass`.
- Pure, unit-tested modules use relative imports only (vitest has no `@/` alias).

## Execution order

Each row is a wave. Sessions in one wave may run in parallel, each in its own git worktree, and are merged before the next wave starts. `a`/`b` are the two sessions of a split package.

| Wave | Foundation | Economics | Governance |
|---|---|---|---|
| 1 | F0 | E1 | G1, G2, G3 |
| 2 | F1 | E2, E3, E5 | G5a, G5b |
| 3 | F2, F3, F4a, F5, F10a | E4, E6 | — |
| 4 | F4b, F6a, F10b, F11a, F15 | E8 | G4 |
| 5 | F6b, F11b | — | — |
| 6 | F7a, F8a, F12a, F14 | E7 | — |
| 7 | F7b, F8b, F9, F12b, F13a | E9, E13 | G6 |
| 8 | F13b | E10, E11, E14 | G9a, G9b |
| 9 | — | E12, E15 | G7a, G7b |
| 10 | — | E16, E18 | G8a, G8b |
| 11 | — | E17, E19 | G10a, G10b |
| 12 | — | — | G11a, G11b, G12a, G12b, G14a, G14b |
| 13 | — | — | G13a, G13b, G15, G16a, G16b |
| 14 | — | — | G17, G18 |
| 15 | — | — | G19 |

Within a wave, the `b` session of a split package starts after its `a` session is merged. The table is derived from each plan's prerequisite list (01 section D, 02 section D.0, 03 section D0); if the two ever disagree, the plan's prerequisite list wins.

Ordering constraints that cross areas:

- E1 delivers `src/lib/llc/business-days.ts` and `units.ts`; F6a cannot start without it.
- E6 and G4 both edit the shared registries after F1 (`src/trpc/api/root.ts`, `src/lib/rbac/subjects.ts`, `src/server/audit/schema.ts`). They are in different waves on purpose; never run them at the same time.
- `src/jobs/register.ts`, `src/constants/job.ts` and `src/server/file-uploads.ts` are appended to by several packages (F12, G4, G8, G9, G12, G13, G14). Each adds its own lines only; resolve merge conflicts by keeping both sides.
- E9 adds two guard calls inside F6's `src/server/llc/commitments.ts`; G16b adds the transfer fold-in inside F6's `src/server/llc/positions.ts`. Nothing else in those files changes.
- G6 needs `getSuspendedUnits` from E7. G12 and G14 need `getPeriodEconomics` and `getComplianceDates` from E19.

### Shortest path to the Final Closing (November 30, 2026)

Build in this order and deploy as soon as it is green: E1, F0, F1, F2, F3, F4, F5, F6, F7, F8, F14, F10, F9. That gives LLC mode, unit classes, member records, the commitments and receipts ledger, the live Exhibit A with export, the Exhibit A CSV import for admissions done on paper, a working email log, and a real Overview. The e-sign subscription flow (F11–F13) follows.

Next deadlines: first quarterly report due February 14, 2027 (E13–E19, G12–G13); Balance outside date March 31, 2027 (E9–E12).

## Executor protocol

1. One package (or one `a`/`b` session) per agent, in its own worktree branched from the current integration branch.
2. Read this file, then the whole package section, then the sections it cites (Findings, Decisions, Rules, Data model, Interfaces) in its plan file. Read every file the package tells you to modify before changing it.
3. Edit only the files the package lists. If the plan is wrong, contradicts another plan, or contradicts the code as it now is, stop and report; do not improvise.
4. Implement the tests listed in the package using its worked examples and expected numbers exactly.
5. All four must pass before committing (library-only packages may skip the build where their plan says so):
   `node_modules/.bin/tsc --noEmit` · `node_modules/.bin/biome check ./src` · `node_modules/.bin/vitest run` · `SKIP_ENV_VALIDATION=1 NODE_ENV=production node_modules/.bin/next build`
6. Commit with the pre-commit hook enabled. Do not push. Do not run Docker. Do not build images locally.
7. Report: files changed, test count, any acceptance criterion not met, any deviation from the plan and why.

Packages that deserve a higher-effort executor or a review pass, because a mistake is expensive: F0 (schema on a live database), F6 (ledger services), F11 (changes to shared e-sign), E3 and E15 (waterfall and distribution finalize), E11 (default and forfeiture), G6 and G8 (tokens, snapshot, public ballot endpoints).

## Decisions waiting on the owner

Each has a default built into the plans as a setting, so work can start; changing one later is a settings change unless noted.

Admission (`01-foundation.md` section F):
1. A reduced subscription refunds wired money pro rata by default; the Manager may keep between 40% of the accepted amount and what was received.
2. Money wired before acceptance earns the Preferred Return from the wire date.
3. The refund deadline is 5 business days after the 10-business-day acceptance window.
4. The admission date is the acceptance date the Manager enters.
5. Exhibit B's six accreditation checkboxes become one select field (the signing UI has no checkbox field); the Exhibit B PDF needs a single line for the chosen basis.

Economics (`02-economics.md` section F):
6. Forfeiture base (4.9(iv)): 50% of what the Defaulting Member itself has not paid, not reduced by Replacement Funder funding.
7. A Defaulting Member's withheld distributions and late payments are applied to Balance first, then interest, then costs (4.9(iii)).
8. Tier (c) accrued Preferred Return is measured through the payment date; Balance money paid before any Call Notice earns nothing until the notice's due date or March 31, 2027.
9. A Defaulting Member's units stay in the distribution waterfall; its line is withheld and applied to its debt. Suspension applies to votes only. (This follows 4.9(iii) and differs from the first reading of the agreement.)

Governance (`03-governance.md` section F):
10. A submitted ballot is final; a resolution is effective the moment the frozen threshold is reached and fails early once it cannot be reached.
11. Ballots, reports and notices go to admitted Members only. Members suspended for default get reports and notices but no ballot. Financial-Interest-only holders receive only their own K-1.
12. The purchase-order resolution is fixed text tracking 6.16(i)(B), signed by the Manager at send time. Counsel should read the wording before first real use.

Still open from the earlier review: whether the Manager's principals or affiliates hold Preferred Units (drives Disinterested counts), what "utilization" means in the quarterly report, and which SMTP provider production email uses (Call Notices refuse to send while production still uses the mail catcher).
