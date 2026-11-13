/**
 * Integration checks for the Exhibit B confirmation flow (01-foundation.md
 * F13a) against the local database, the local mail catcher and the local
 * object store. Not part of `vitest run`. Run from the repository root with
 * the upload settings of `.env` exported:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXTAUTH_SECRET=… NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   UPLOAD_…=… \
 *   node_modules/.bin/tsx \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/llc/__integration__/admissions.integration.ts
 *
 * Every step goes through the real procedures (tRPC callers) and the real
 * job handlers, called in-process: queue emits are captured instead of sent
 * to pg-boss, then the captured job is handed to its worker. The signed PDF
 * is really stamped and stored. Companies are `zz-f13a-…`, addresses
 * `@example.com`; every row, bucket and stored object is removed at the end.
 */
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { PDFDocument, PDFRawStream, StandardFonts } from "pdf-lib";
import type { Job } from "pg-boss";
import { admissionNoticeEmailJob } from "@/jobs/admission-notice-email";
import {
  eSignCompletePDFJob,
  eSignCompletePDFWorker,
} from "@/jobs/esign-complete-pdf";
import { eSignConfirmationEmailJob } from "@/jobs/esign-confirmation-email";
import {
  eSignNotificationEmailJob,
  eSignNotificationEmailWorker,
} from "@/jobs/esign-email";
import { eSignPdfJob, eSignPdfWorker } from "@/jobs/esign-pdf";
import {
  canonicalOptionsFor,
  SUBSCRIPTION_FIELD_KEYS,
} from "@/lib/esign/subscription-fields";
import { completeEsignDocuments } from "@/server/esign";
import { deleteObject, getFileFromS3, uploadFile } from "@/server/file-uploads";
import { lockTemplate } from "@/server/llc/admission";
import { loadMemberSchedule } from "@/server/llc/member-schedule";
import { ledgerInvariantErrors } from "@/server/llc/receipt-rules";
import { createCallerFactory } from "@/trpc/api/trpc";
import {
  type ConfirmDetailsInput,
  confirmPacketDetails,
  STALE_PACKET,
} from "@/trpc/routers/admission-router/procedures/confirm-details";
import { admissionRouter } from "@/trpc/routers/admission-router/router";
import { commitmentRouter } from "@/trpc/routers/commitment-router/router";
import { EncodeEmailToken } from "@/trpc/routers/template-field-router/procedures/add-fields";
import { templateRouter } from "@/trpc/routers/template-router/router";
import {
  actor,
  check,
  createAdmin,
  createCompany,
  db,
  eq,
  errorOf,
  expectRefused,
  race,
  runScenarios,
  section,
  setCompanyPrefix,
  setToday,
  type TestCompany,
} from "./harness";

setCompanyPrefix("zz-f13a-");

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// Captured queue emits

type Captured = { name: string; data: unknown };
const emitted: Captured[] = [];
function capture(name: string) {
  return (data: unknown) => {
    emitted.push({ name, data });
    return Promise.resolve(null);
  };
}
// The objects are the modules' own job handles: every emit in the code under
// test lands here instead of pg-boss.
Object.assign(eSignNotificationEmailJob, { emit: capture("esign-notify") });
Object.assign(admissionNoticeEmailJob, { emit: capture("admission-notice") });
Object.assign(eSignPdfJob, { emit: capture("esign-pdf") });
Object.assign(eSignCompletePDFJob, { emit: capture("esign-complete") });
Object.assign(eSignConfirmationEmailJob, {
  bulkEmit: capture("esign-confirmation"),
});

function take(name: string): unknown[] {
  const out: unknown[] = [];
  for (let i = emitted.length - 1; i >= 0; i--) {
    const item = emitted[i];
    if (item && item.name === name) {
      out.unshift(item.data);
      emitted.splice(i, 1);
    }
  }
  return out;
}

const asJob = <T>(data: unknown) => ({ data }) as unknown as Job<T>;

// ---------------------------------------------------------------------------
// Fixtures

const objectKeys: string[] = [];
const companies: TestCompany[] = [];

type Admin = Awaited<ReturnType<typeof createAdmin>>;

function callers(admin: Admin) {
  return {
    admission: createCallerFactory(admissionRouter)(admin.context),
    commitment: createCallerFactory(commitmentRouter)(admin.context),
    template: createCallerFactory(templateRouter)(admin.context),
  };
}

async function blankPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("EXHIBIT B — signature page (integration test)", {
    x: 50,
    y: 740,
    size: 12,
    font,
  });
  return pdf.save();
}

/** A ready master: the uploaded PDF plus one field per subscription key. */
async function createMaster(c: TestCompany, admin: Admin): Promise<string> {
  const bytes = await blankPdf();
  const file = {
    name: "exhibit-b.pdf",
    type: "application/pdf",
    size: bytes.length,
    arrayBuffer: () => Promise.resolve(bytes),
  } as unknown as File;
  const uploaded = await uploadFile(file, {
    identifier: c.name,
    keyPrefix: "unsigned-esign-doc",
  });
  objectKeys.push(uploaded.key);
  const bucket = await db.bucket.create({
    data: {
      name: uploaded.name,
      key: uploaded.key,
      mimeType: uploaded.mimeType,
      size: uploaded.size,
      tags: ["esign"],
    },
  });
  const { publicId } = await callers(admin).admission.createMaster({
    name: "Exhibit B",
    bucketId: bucket.id,
  });
  const master = await db.template.findFirstOrThrow({
    where: { publicId, companyId: c.id },
    select: { id: true, eSignRecipient: { select: { id: true, role: true } } },
  });
  const recipientOf = (role: string) =>
    master.eSignRecipient.find((r) => r.role === role)?.id ?? "";
  await db.templateField.createMany({
    data: SUBSCRIPTION_FIELD_KEYS.map((k, i) => ({
      name: k.label,
      type: k.type,
      required: k.required,
      // The master's ledger lines are NOT read-only: prepareCountersign must
      // set the flag itself.
      readOnly: false,
      top: 40 + i * 36,
      left: 60,
      width: 200,
      height: 20,
      viewportWidth: 612,
      viewportHeight: 792,
      page: 1,
      meta: canonicalOptionsFor(k.key)
        ? { options: canonicalOptionsFor(k.key) }
        : {},
      semanticKey: k.key,
      templateId: master.id,
      recipientId: recipientOf(k.role),
    })),
  });
  return publicId;
}

const JANE: Record<string, string> = {
  commitment_amount: "$250,000",
  amount_paid: "100,000.00",
  accreditation_basis: "NET_WORTH",
  legal_name: "Jane Doe",
  holder_type: "INDIVIDUAL",
  residence_state: "kentucky",
  investment_summary_date: "2026-11-05",
  address_street: "1 Main St",
  address_city: "Frankfort",
  address_state: "KY",
  address_zip: "40601",
  email: " Jane.Notice@Example.com ",
  investor_sign_date: "2026-11-12",
  investor_signature: PNG,
};

async function packetIds(c: TestCompany, publicId: string) {
  const t = await db.template.findFirstOrThrow({
    where: { publicId, companyId: c.id },
    select: {
      id: true,
      stakeholderId: true,
      eSignRecipient: { select: { id: true, role: true } },
      fields: {
        select: {
          id: true,
          semanticKey: true,
          recipientId: true,
          readOnly: true,
          prefilledValue: true,
        },
      },
    },
  });
  const investor = t.eSignRecipient.find((r) => r.role === "investor")?.id;
  const manager = t.eSignRecipient.find((r) => r.role === "manager")?.id;
  return {
    templateId: t.id,
    stakeholderId: t.stakeholderId ?? "",
    investorId: investor ?? "",
    managerId: manager ?? "",
    fields: t.fields,
  };
}

/** Field id → value for the fields of `recipientId`, by semantic key. */
function dataFor(
  fields: { id: string; semanticKey: string | null; recipientId: string }[],
  recipientId: string,
  answers: Record<string, string>,
) {
  const data: Record<string, string> = {};
  for (const f of fields) {
    if (f.recipientId !== recipientId || !f.semanticKey) continue;
    const v = answers[f.semanticKey];
    if (v !== undefined) data[f.id] = v;
  }
  return data;
}

/** send → the e-sign email worker marks the investor SENT. */
async function sendPacket(
  admin: Admin,
  masterPublicId: string,
  prospect: { name: string; email: string } | { stakeholderId: string },
): Promise<string> {
  const { admission } = callers(admin);
  const { publicId } = await admission.send({
    masterPublicId,
    managerMemberId: memberIdOf(admin),
    ...("stakeholderId" in prospect
      ? { stakeholderId: prospect.stakeholderId }
      : { prospect }),
  });
  for (const mail of take("esign-notify")) {
    await eSignNotificationEmailWorker.handler([asJob(mail)]);
  }
  return publicId;
}

async function investorSigns(
  admin: Admin,
  c: TestCompany,
  publicId: string,
  answers: Record<string, string>,
  extra: Record<string, string> = {},
) {
  const ids = await packetIds(c, publicId);
  const token = await EncodeEmailToken({
    templateId: ids.templateId,
    recipientId: ids.investorId,
  });
  const data = {
    ...dataFor(ids.fields, ids.investorId, answers),
    ...extra,
  };
  const result = await callers(admin).template.sign({
    token,
    templateId: ids.templateId,
    recipientId: ids.investorId,
    data,
  });
  take("admission-notice");
  return result;
}

const memberIdOf = (admin: Admin) =>
  (admin.session.user as unknown as { memberId: string }).memberId;

type View = Awaited<ReturnType<ReturnType<typeof callers>["admission"]["get"]>>;

/** The confirmDetails input a Manager would submit after reading `view`. */
function confirmInput(
  view: View,
  overrides: Partial<ConfirmDetailsInput> = {},
): ConfirmDetailsInput {
  const p = view.answers?.parsed;
  if (!p) throw new Error("no answers");
  return {
    publicId: view.packet.publicId,
    stakeholder: {
      name: p.legalName,
      holderType: p.holderType ?? "INDIVIDUAL",
      residenceState: p.residenceState ?? "KY",
      accreditationBasis: p.accreditationBasis ?? "NET_WORTH",
      streetAddress: p.streetAddress,
      city: p.city,
      state: p.state ?? "KY",
      zipcode: p.zipcode,
      noticeEmail: p.email,
      isInsider: false,
    },
    commitment: {
      committedCents: p.committedCents ?? 0,
      signedOn: p.investorSignDate ?? "2026-11-12",
      investmentSummaryDate: p.investmentSummaryDate ?? "2026-11-05",
    },
    expected: {
      commitmentId: view.commitment?.id ?? null,
      stakeholderVersion: view.stakeholderVersion,
    },
    ...overrides,
  };
}

/** Runs the captured PDF and completion jobs through their workers. */
async function runCompletionJobs(): Promise<number> {
  let runs = 0;
  for (const pdf of take("esign-pdf")) {
    await eSignPdfWorker.handler([asJob(pdf)]);
    runs += 1;
  }
  for (const complete of take("esign-complete")) {
    await eSignCompletePDFWorker.handler([asJob(complete)]);
    objectKeys.push(
      (complete as { bucketData: { key: string } }).bucketData.key,
    );
    runs += 1;
  }
  take("esign-confirmation");
  return runs;
}

/** All text drawn on the PDF's pages (pdf-lib writes hex strings for Tj). */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  let text = "";
  for (const page of pdf.getPages()) {
    const contents = page.node.Contents();
    const streams =
      contents === undefined
        ? []
        : "asArray" in contents
          ? contents.asArray()
          : [contents];
    for (const ref of streams) {
      const stream = pdf.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const filter = stream.dict.toString();
      const raw = Buffer.from(stream.contents);
      const decoded = filter.includes("FlateDecode")
        ? inflateSync(raw).toString("latin1")
        : raw.toString("latin1");
      for (const m of decoded.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        text += `${Buffer.from(m[1] ?? "", "hex").toString("latin1")}\n`;
      }
      for (const m of decoded.matchAll(/\(([^)]*)\)\s*Tj/g)) {
        text += `${m[1]}\n`;
      }
    }
  }
  return text;
}

async function invariantOk(label: string, commitmentId: string) {
  const c = await db.commitment.findFirstOrThrow({
    where: { id: commitmentId },
    include: { receipts: { where: { voidedAt: null } } },
  });
  const errors = ledgerInvariantErrors(
    c,
    c.receipts.map((r) => ({ ...r, unitsIssued: r.unitsIssued.toFixed(6) })),
  );
  check(
    `${label}: ledger invariant holds`,
    errors.length === 0,
    errors.join("; "),
  );
}

// ---------------------------------------------------------------------------
// Scenarios

let A: TestCompany;
let admin: Admin;
let second: Admin;
let masterPublicId: string;
let janePacket: string;
let janeId: string;
let bobPacket: string;
let bobFirstToken: string;

async function setup() {
  section("Setup: company, two team members, a ready master");
  A = await createCompany("main");
  companies.push(A);
  admin = await createAdmin(A);
  second = await createAdmin(A);
  await db.user.update({
    where: { id: second.session.user.id },
    data: { name: "Second Signer" },
  });
  // The Manager signatory named in the refusal message.
  await db.user.update({
    where: { id: admin.session.user.id },
    data: { name: "Isaac Reid" },
  });
  await db.unitClass.update({
    where: { id: A.preferredId },
    data: { minCommitmentCents: 10_000_000n },
  });
  masterPublicId = await createMaster(A, admin);
  const masters = await callers(admin).admission.masters();
  eq("the master is ready", masters[0]?.ready, true);
}

async function fullAcceptance() {
  section(
    "Worked example: $250,000 committed, $100,000 paid, accepted in full",
  );
  setToday("2026-11-12");
  const { admission, commitment, template } = callers(admin);
  janePacket = await sendPacket(admin, masterPublicId, {
    name: "Jane Doe",
    email: `jane.${randomUUID().slice(0, 8)}@example.com`,
  });
  const ids0 = await packetIds(A, janePacket);
  janeId = ids0.stakeholderId;

  let view = await admission.get({ publicId: janePacket });
  eq("before signing: stage", view.packet.stage, "AWAITING_INVESTOR");
  eq("before signing: no answers", view.answers, null);
  await expectRefused(
    "details cannot be confirmed before the investor signs",
    () => admission.confirmDetails(confirmInputUnsafe(view)),
    /after the investor has signed/,
    "BAD_REQUEST",
  );

  // The investor also posts a value for the Manager's ledger line.
  const ledgerField = ids0.fields.find(
    (f) => f.semanticKey === "contribution_received",
  );
  await investorSigns(admin, A, janePacket, JANE, {
    [ledgerField?.id ?? ""]: "$9,999,999.00",
  });
  view = await admission.get({ publicId: janePacket });
  eq("after signing: stage", view.packet.stage, "AWAITING_REVIEW");
  eq("answers: committed", view.answers?.parsed.committedCents, 25_000_000);
  eq("answers: paid", view.answers?.parsed.paidCents, 10_000_000);
  eq("answers: residence", view.answers?.parsed.residenceState, "KY");
  eq("answers: email", view.answers?.parsed.email, "jane.notice@example.com");
  eq("answers: no issues", view.answers?.issues.length, 0);
  eq(
    "the investor could not write the Manager's ledger line",
    view.answers?.raw.contribution_received,
    undefined,
  );
  const janeLedgerField = await db.templateField.findFirstOrThrow({
    where: { id: ledgerField?.id ?? "" },
  });
  eq(
    "the Manager's ledger field is still empty",
    janeLedgerField.prefilledValue,
    null,
  );

  // Manager countersign link is not active before acceptance.
  const managerToken = await EncodeEmailToken({
    templateId: ids0.templateId,
    recipientId: ids0.managerId,
  });
  await expectRefused(
    "the Manager cannot sign before acceptance (link not SENT)",
    () =>
      template.sign({
        token: managerToken,
        templateId: ids0.templateId,
        recipientId: ids0.managerId,
        data: {},
      }),
    /not active/,
  );

  // Stale member record.
  await expectRefused(
    "confirm with a stale member version is a CONFLICT",
    () =>
      admission.confirmDetails(
        confirmInput(view, {
          expected: {
            commitmentId: null,
            stakeholderVersion: "2000-01-01T00:00:00.000Z",
          },
        }),
      ),
    /member record was changed/,
    "CONFLICT",
  );

  view = await admission.confirmDetails(confirmInput(view));
  const stakeholder = await db.stakeholder.findFirstOrThrow({
    where: { id: janeId },
  });
  eq(
    "confirm: commitment created",
    view.commitment?.committedCents,
    25_000_000,
  );
  eq("confirm: commitment PENDING", view.commitment?.status, "PENDING");
  eq("confirm: signedOn", view.commitment?.signedOn, "2026-11-12");
  eq(
    "confirm: accreditation on commitment",
    view.commitment?.accreditationBasis,
    "NET_WORTH",
  );
  eq(
    "confirm: packet links the commitment",
    view.commitment?.packetPublicId,
    janePacket,
  );
  eq("confirm: member name", stakeholder.name, "Jane Doe");
  eq("confirm: member address", stakeholder.streetAddress, "1 Main St");
  eq("confirm: member residence", stakeholder.residenceState, "KY");
  eq(
    "confirm: notice email",
    stakeholder.noticeEmail,
    "jane.notice@example.com",
  );
  check(
    "confirm: record email unchanged",
    stakeholder.email.startsWith("jane."),
  );
  eq("confirm: still a prospect", stakeholder.memberStatus, "PROSPECT");
  eq("confirm: stage", view.packet.stage, "AWAITING_REVIEW");
  const confirmedAudit = await db.audit.count({
    where: { companyId: A.id, action: "admission.confirmed" },
  });
  eq("confirm: audit admission.confirmed", confirmedAudit, 1);

  await expectRefused(
    "double confirm (the commitment the Manager saw is gone) is a CONFLICT",
    () =>
      admission.confirmDetails(
        confirmInput(view, {
          expected: {
            commitmentId: null,
            stakeholderVersion: view.stakeholderVersion,
          },
        }),
      ),
    new RegExp(STALE_PACKET.slice(0, 40)),
    "CONFLICT",
  );
  // Saving again with what is on screen updates the pending commitment.
  view = await admission.confirmDetails(
    confirmInput(view, {
      commitment: {
        committedCents: 25_000_000,
        signedOn: "2026-11-12",
        investmentSummaryDate: "2026-11-06",
      },
    }),
  );
  eq(
    "re-confirm updates the pending commitment",
    view.commitment?.investmentSummaryDate,
    "2026-11-06",
  );
  const commitmentCount = await db.commitment.count({
    where: { companyId: A.id, stakeholderId: janeId },
  });
  eq("still one commitment", commitmentCount, 1);

  await expectRefused(
    "cannot cancel once a commitment exists",
    () => admission.cancel({ publicId: janePacket }),
    /can no longer be cancelled/,
  );
  await expectRefused(
    "countersign cannot be prepared before acceptance",
    () =>
      admission.prepareCountersign({
        publicId: janePacket,
        expectedReceivedCents: 0,
        expectedUnits: "0",
      }),
    /after the subscription is accepted/,
  );

  // Wire and acceptance through the F6 procedures (same as the Commitments page).
  const commitmentId = view.commitment?.id ?? "";
  await commitment.recordReceipt({
    commitmentId,
    receivedOn: "2026-11-12",
    amountCents: 10_000_000,
    reference: "WIRE-1",
  });
  view = await admission.get({ publicId: janePacket });
  eq("receipt held", view.commitment?.heldCents, 10_000_000);
  eq("decision deadline", view.commitment?.acceptanceDeadline, "2026-11-27");
  setToday("2026-11-13");
  await commitment.accept({ id: commitmentId, acceptedOn: "2026-11-13" });
  await invariantOk("full acceptance", commitmentId);
  view = await admission.get({ publicId: janePacket });
  eq("accepted: stage", view.packet.stage, "AWAITING_COUNTERSIGN");
  eq("accepted: status", view.commitment?.status, "ACCEPTED");
  eq("accepted: units", view.commitment?.units, "100.000000");
  eq("accepted: Balance", view.commitment?.outstandingBalanceCents, 15_000_000);
  eq(
    "countersign figures: received",
    view.countersign?.receivedCents,
    10_000_000,
  );
  eq("countersign figures: units", view.countersign?.units, "100.000000");
  eq(
    "countersign figures: date",
    view.countersign?.managerSignDate,
    "2026-11-13",
  );
  eq("manager is the current user", view.manager.isCurrentUser, true);
  const admitted = await db.stakeholder.findFirstOrThrow({
    where: { id: janeId },
  });
  eq("member admitted", admitted.memberStatus, "MEMBER");
  eq(
    "admitted on the acceptance date",
    admitted.admittedOn?.toISOString().slice(0, 10),
    "2026-11-13",
  );

  await expectRefused(
    "details cannot be changed after the decision",
    () => admission.confirmDetails(confirmInput(view)),
    /before the decision/,
  );
  await expectRefused(
    "a second accept is refused by the service",
    () => commitment.accept({ id: commitmentId, acceptedOn: "2026-11-13" }),
    /already been decided/,
  );
  await expectRefused(
    "reject after acceptance is refused",
    () =>
      admission.reject({
        publicId: janePacket,
        decidedOn: "2026-11-13",
        reason: "late",
      }),
    /waiting for the decision/,
  );

  // Countersign: only the designated signer, only with the figures shown.
  const secondAdmission = callers(second).admission;
  await expectRefused(
    "another team member cannot countersign",
    () =>
      secondAdmission.prepareCountersign({
        publicId: janePacket,
        expectedReceivedCents: 10_000_000,
        expectedUnits: "100.000000",
      }),
    /^Only Isaac Reid can countersign this packet\. Reassign the signer first\.$/,
    "BAD_REQUEST",
  );
  await expectRefused(
    "stale countersign figures are a CONFLICT",
    () =>
      admission.prepareCountersign({
        publicId: janePacket,
        expectedReceivedCents: 9_000_000,
        expectedUnits: "90",
      }),
    /ledger now shows \$100,000\.00 received and 100 Preferred Units/,
    "CONFLICT",
  );
  const { token } = await admission.prepareCountersign({
    publicId: janePacket,
    expectedReceivedCents: 10_000_000,
    expectedUnits: "100.000000",
  });
  const prepared = await packetIds(A, janePacket);
  const byKey = (key: string) =>
    prepared.fields.find(
      (f) => f.semanticKey === key && f.recipientId === prepared.managerId,
    );
  eq(
    "ledger line: received",
    byKey("contribution_received")?.prefilledValue,
    "$100,000.00",
  );
  eq(
    "ledger line: received read-only",
    byKey("contribution_received")?.readOnly,
    true,
  );
  eq("ledger line: units", byKey("units_issued")?.prefilledValue, "100");
  eq("ledger line: units read-only", byKey("units_issued")?.readOnly, true);
  eq(
    "date line prefilled",
    byKey("manager_sign_date")?.prefilledValue,
    "2026-11-13",
  );
  eq("date line stays editable", byKey("manager_sign_date")?.readOnly, false);
  const managerRow = await db.esignRecipient.findFirstOrThrow({
    where: { id: prepared.managerId },
  });
  eq("manager link active", managerRow.status, "SENT");

  // The Manager submits other values for the ledger lines: ignored.
  await template.sign({
    token,
    templateId: prepared.templateId,
    recipientId: prepared.managerId,
    data: dataFor(prepared.fields, prepared.managerId, {
      manager_signature: PNG,
      manager_sign_date: "2026-11-13",
      contribution_received: "$1.00",
      units_issued: "999",
    }),
  });
  const signedFields = await packetIds(A, janePacket);
  const signedByKey = (key: string) =>
    signedFields.fields.find(
      (f) => f.semanticKey === key && f.recipientId === signedFields.managerId,
    );
  eq(
    "the Manager's submitted amount did not replace the ledger figure",
    signedByKey("contribution_received")?.prefilledValue,
    "$100,000.00",
  );
  eq(
    "the Manager's submitted units did not replace the ledger figure",
    signedByKey("units_issued")?.prefilledValue,
    "100",
  );
  view = await admission.get({ publicId: janePacket });
  eq("after countersigning: stage", view.packet.stage, "FINALISING");
  await expectRefused(
    "the signer cannot be reassigned after countersigning",
    () =>
      admission.reassignManager({
        publicId: janePacket,
        managerMemberId: memberIdOf(second),
      }),
    /no longer be changed/,
  );

  const pdfJob = emitted.find((e) => e.name === "esign-pdf")?.data as
    | { data: Record<string, string> }
    | undefined;
  const pdfData = Object.values(pdfJob?.data ?? {});
  check("PDF job data has $100,000.00", pdfData.includes("$100,000.00"));
  eq(
    "one PDF job queued",
    emitted.filter((e) => e.name === "esign-pdf").length,
    1,
  );
  const runs = await runCompletionJobs();
  eq("PDF and completion jobs ran", runs, 2);

  view = await admission.get({ publicId: janePacket });
  eq("complete: stage", view.packet.stage, "COMPLETE");
  const doc = await db.document.findFirstOrThrow({
    where: { id: view.signedDocument?.id ?? "" },
  });
  eq("signed PDF filed on the member", doc.stakeholderId, janeId);
  eq("signed PDF kind", doc.kind, "exhibit-b");
  const attached = await db.audit.count({
    where: { companyId: A.id, action: "document.attached" },
  });
  eq("audit document.attached", attached, 1);

  const stamped = await getFileFromS3(view.signedDocument?.bucketKey ?? "");
  const text = await pdfText(new Uint8Array(stamped));
  check("PDF shows $100,000.00", text.includes("$100,000.00"), text);
  check("PDF shows 100 units", text.split("\n").includes("100"));
  check(
    "PDF dates are MM/DD/YYYY",
    text.includes("11/13/2026") && text.includes("11/12/2026"),
  );
  check(
    "PDF does not show the Manager's submitted $1.00",
    !text.includes("$1.00"),
  );

  // A retried completion job creates nothing new.
  const before = await db.document.count({ where: { companyId: A.id } });
  const retry = await db.$transaction((tx) =>
    completeEsignDocuments({
      companyId: A.id,
      db: tx,
      requestIp: "127.0.0.1",
      templateId: prepared.templateId,
      uploaderName: "x",
      userAgent: "x",
      bucketData: { key: "x", name: "x", mimeType: "application/pdf", size: 1 },
    }),
  );
  eq("retried completion: not created", retry.created, false);
  eq(
    "retried completion: no new document",
    await db.document.count({ where: { companyId: A.id } }),
    before,
  );
  eq(
    "retried completion: still one attach audit",
    await db.audit.count({
      where: { companyId: A.id, action: "document.attached" },
    }),
    1,
  );

  // W-9 on the member is listed.
  const w9Bucket = await db.bucket.create({
    data: {
      name: "w9.pdf",
      key: `${A.name}/w9-docs-test.pdf`,
      mimeType: "application/pdf",
      size: 1,
      tags: [],
    },
  });
  await db.document.create({
    data: {
      publicId: randomUUID(),
      name: "W-9 — Jane Doe",
      bucketId: w9Bucket.id,
      companyId: A.id,
      stakeholderId: janeId,
      kind: "w9",
    },
  });
  view = await admission.get({ publicId: janePacket });
  eq("W-9 listed", view.w9Documents.length, 1);

  const schedule = await loadMemberSchedule(db, {
    id: A.id,
    name: A.name,
    timezone: A.timezone,
  });
  const row = schedule.preferred.rows.find((r) => r.stakeholderId === janeId);
  eq("Member Schedule: committed", row?.committedCents, 25_000_000);
  eq("Member Schedule: paid", row?.paidCents, 10_000_000);
  eq("Member Schedule: units", row?.units, "100.000000");
  eq("Member Schedule: admitted", row?.admittedOn, "2026-11-13");
}

/** Like confirmInput, for a view without answers (refusal checks). */
function confirmInputUnsafe(view: View): ConfirmDetailsInput {
  return {
    publicId: view.packet.publicId,
    stakeholder: {
      name: "X",
      holderType: "INDIVIDUAL",
      residenceState: "KY",
      accreditationBasis: "NET_WORTH",
      streetAddress: "1",
      city: "c",
      state: "KY",
      zipcode: "1",
      isInsider: false,
    },
    commitment: {
      committedCents: 10_000_000,
      signedOn: "2026-11-12",
      investmentSummaryDate: "2026-11-05",
    },
    expected: {
      commitmentId: null,
      stakeholderVersion: view.stakeholderVersion,
    },
  };
}

async function signedAndConfirmed(
  name: string,
  answers: Record<string, string>,
  who: Admin = admin,
) {
  const publicId = await sendPacket(who, masterPublicId, {
    name,
    email: `${name.toLowerCase().replace(/\W+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`,
  });
  await investorSigns(who, A, publicId, {
    ...JANE,
    legal_name: name,
    ...answers,
  });
  const { admission } = callers(who);
  let view = await admission.get({ publicId });
  view = await admission.confirmDetails(confirmInput(view));
  return { publicId, view, commitmentId: view.commitment?.id ?? "" };
}

async function reducedAcceptance() {
  section(
    "Reduced acceptance: $200,000 committed, $100,000 paid, $150,000 accepted",
  );
  setToday("2026-11-13");
  const { admission, commitment } = callers(admin);
  const { publicId, commitmentId } = await signedAndConfirmed("Bob Reduced", {
    commitment_amount: "200,000",
  });
  await commitment.recordReceipt({
    commitmentId,
    receivedOn: "2026-11-12",
    amountCents: 10_000_000,
  });
  // The decision is exactly what the Manager saw: explicit amounts.
  await commitment.accept({
    id: commitmentId,
    acceptedOn: "2026-11-13",
    acceptedCents: 15_000_000,
    keepCents: 7_500_000,
  });
  await invariantOk("reduced acceptance", commitmentId);
  const view = await admission.get({ publicId });
  eq("reduced: status", view.commitment?.status, "REDUCED");
  eq("reduced: refund due", view.commitment?.refundDueCents, 2_500_000);
  check("reduced: refund date set", view.commitment?.refundDueBy !== null);
  eq(
    "reduced: countersign received",
    view.countersign?.receivedCents,
    7_500_000,
  );
  eq("reduced: countersign units", view.countersign?.units, "75.000000");
  const firstPrepare = await admission.prepareCountersign({
    publicId,
    expectedReceivedCents: 7_500_000,
    expectedUnits: "75",
  });
  bobPacket = publicId;
  bobFirstToken = firstPrepare.token;
  const ids = await packetIds(A, publicId);
  eq(
    "reduced: ledger line",
    ids.fields.find((f) => f.semanticKey === "contribution_received")
      ?.prefilledValue,
    "$75,000.00",
  );
  // A second prepare by the signer is idempotent (same link).
  const again = await errorOf(() =>
    admission.prepareCountersign({
      publicId,
      expectedReceivedCents: 7_500_000,
      expectedUnits: "75.000000",
    }),
  );
  eq("reduced: preparing again is allowed before signing", again, null);
}

async function rejection() {
  section("Rejection through admission.reject");
  setToday("2026-11-13");
  const { admission } = callers(admin);
  const { publicId, commitmentId } = await signedAndConfirmed(
    "Carol Rejected",
    {},
  );
  await callers(admin).commitment.recordReceipt({
    commitmentId,
    receivedOn: "2026-11-12",
    amountCents: 10_000_000,
  });
  await expectRefused(
    "reject needs a reason",
    () => admission.reject({ publicId, decidedOn: "2026-11-13", reason: "x" }),
    /too_small|Too small/,
  );
  const view = await admission.reject({
    publicId,
    decidedOn: "2026-11-13",
    reason: "Not accredited",
  });
  await invariantOk("rejection", commitmentId);
  eq("rejected: stage", view.packet.stage, "REJECTED");
  eq("rejected: status", view.commitment?.status, "REJECTED");
  eq("rejected: refund due", view.commitment?.refundDueCents, 10_000_000);
  eq(
    "rejected: refund date (5 business days after the window)",
    view.commitment?.refundDueBy,
    "2026-12-04",
  );
  const t = await db.template.findFirstOrThrow({ where: { publicId } });
  eq("rejected: packet cancelled", t.status, "CANCELLED");
  eq(
    "rejected: audits",
    await db.audit.count({
      where: {
        companyId: A.id,
        action: { in: ["commitment.rejected", "admission.cancelled"] },
      },
    }),
    2,
  );
  await expectRefused(
    "a rejected packet cannot be prepared",
    () =>
      admission.prepareCountersign({
        publicId,
        expectedReceivedCents: 0,
        expectedUnits: "0",
      }),
    /rejected/,
  );
}

async function ruleRefusals() {
  section(
    "Refusals of the agreement rules (same service as the Commitments page)",
  );
  const { commitment } = callers(admin);
  setToday("2026-11-13");

  const low = await signedAndConfirmed("Dan Short", {
    commitment_amount: "100,000",
    amount_paid: "39,999.99",
  });
  check(
    "answers flag the short Initial Installment",
    low.view.answers?.issues.some((i) => i.includes("Initial Installment")) ??
      false,
  );
  await commitment.recordReceipt({
    commitmentId: low.commitmentId,
    receivedOn: "2026-11-12",
    amountCents: 3_999_999,
  });
  await expectRefused(
    "below 40% of the accepted amount is refused",
    () => commitment.accept({ id: low.commitmentId, acceptedOn: "2026-11-13" }),
    /at least \$40,000\.00 \(40% of the accepted amount\) must be received before acceptance \(Section 4\.9\)/,
  );

  const capped = await signedAndConfirmed("Erin Capped", {
    commitment_amount: "300,000",
    amount_paid: "120,000",
  });
  await commitment.recordReceipt({
    commitmentId: capped.commitmentId,
    receivedOn: "2026-11-12",
    amountCents: 12_000_000,
  });
  // Accepted so far: 250,000 + 150,000 = 400,000; with a $600,000 cap,
  // $200,000 remains.
  await db.unitClass.update({
    where: { id: A.preferredId },
    data: { offeringCapCents: 60_000_000n },
  });
  await expectRefused(
    "over the offering cap is refused",
    () =>
      commitment.accept({ id: capped.commitmentId, acceptedOn: "2026-11-13" }),
    /Accepting \$300,000\.00 would exceed the \$600,000\.00 cap; \$200,000\.00 remains \(Section 4\.8\)/,
  );
  eq(
    "the refused acceptance left the commitment pending",
    (
      await db.commitment.findFirstOrThrow({
        where: { id: capped.commitmentId },
      })
    ).status,
    "PENDING",
  );

  setToday("2026-12-02");
  await expectRefused(
    "acceptance after the Final Closing Date is refused",
    () =>
      commitment.accept({
        id: capped.commitmentId,
        acceptedOn: "2026-12-01",
        acceptedCents: 10_000_000,
        keepCents: 10_000_000,
      }),
    /No Preferred Member may be admitted after the Final Closing Date \(2026-11-30\)/,
  );
  setToday("2026-11-13");
  await db.unitClass.update({
    where: { id: A.preferredId },
    data: { offeringCapCents: 500_000_000n },
  });
}

async function cancelledAndForeign() {
  section("Cancelled packet, another company's packet, existing Member");
  setToday("2026-11-13");
  const { admission } = callers(admin);

  const publicId = await sendPacket(admin, masterPublicId, {
    name: "Fay Cancelled",
    email: `fay.${randomUUID().slice(0, 8)}@example.com`,
  });
  await investorSigns(admin, A, publicId, { ...JANE, legal_name: "Fay" });
  const view = await admission.get({ publicId });
  await admission.cancel({ publicId });
  await expectRefused(
    "confirming a cancelled packet is refused",
    () => admission.confirmDetails(confirmInput(view)),
    /is cancelled/,
  );
  await expectRefused(
    "preparing a cancelled packet is refused",
    () =>
      admission.prepareCountersign({
        publicId,
        expectedReceivedCents: 0,
        expectedUnits: "0",
      }),
    /is cancelled/,
  );
  await expectRefused(
    "reassigning on a cancelled packet is refused",
    () =>
      admission.reassignManager({
        publicId,
        managerMemberId: memberIdOf(second),
      }),
    /is cancelled/,
  );

  const B = await createCompany("other");
  companies.push(B);
  const otherAdmin = await createAdmin(B);
  const other = callers(otherAdmin).admission;
  await expectRefused(
    "another company's packet: get",
    () => other.get({ publicId: janePacket }),
    /Subscription not found/,
    "NOT_FOUND",
  );
  await expectRefused(
    "another company's packet: confirm",
    () => other.confirmDetails(confirmInput(view)),
    /Subscription not found/,
    "NOT_FOUND",
  );
  await expectRefused(
    "another company's packet: reject",
    () =>
      other.reject({
        publicId: janePacket,
        decidedOn: "2026-11-13",
        reason: "nope",
      }),
    /Subscription not found/,
    "NOT_FOUND",
  );
  await expectRefused(
    "another company's packet: prepare",
    () =>
      other.prepareCountersign({
        publicId: janePacket,
        expectedReceivedCents: 0,
        expectedUnits: "0",
      }),
    /Subscription not found/,
    "NOT_FOUND",
  );
  await expectRefused(
    "another company's packet: reassign",
    () =>
      other.reassignManager({
        publicId: janePacket,
        managerMemberId: memberIdOf(otherAdmin),
      }),
    /Subscription not found/,
    "NOT_FOUND",
  );
  await expectRefused(
    "a manager from another company cannot be assigned",
    () =>
      admission.reassignManager({
        publicId: bobPacket,
        managerMemberId: memberIdOf(otherAdmin),
      }),
    /^Manager signer not found\.$/,
    "NOT_FOUND",
  );

  // Reassigning while the link is active (Bob: accepted, prepared, SENT).
  const bob = await packetIds(A, bobPacket);
  const signAttempt = (token: string) =>
    callers(admin).template.sign({
      token,
      templateId: bob.templateId,
      recipientId: bob.managerId,
      // No signature: a live link fails on the required field, a dead one
      // on the recipient status; nothing is signed either way.
      data: {},
    });
  await admission.reassignManager({
    publicId: bobPacket,
    managerMemberId: memberIdOf(second),
  });
  const bobManager = await db.esignRecipient.findFirstOrThrow({
    where: { id: bob.managerId },
  });
  eq(
    "reassign while SENT: recipient back to PENDING",
    bobManager.status,
    "PENDING",
  );
  eq(
    "reassign while SENT: new signer",
    bobManager.memberId,
    memberIdOf(second),
  );
  eq("reassign while SENT: new signer name", bobManager.name, "Second Signer");
  await expectRefused(
    "reassign while SENT: the earlier link is refused",
    () => signAttempt(bobFirstToken),
    /This signature request is not active/,
  );
  await expectRefused(
    "reassign while SENT: the previous signer can no longer prepare",
    () =>
      admission.prepareCountersign({
        publicId: bobPacket,
        expectedReceivedCents: 7_500_000,
        expectedUnits: "75",
      }),
    /^Only Second Signer can countersign this packet\. Reassign the signer first\.$/,
  );
  const secondPrepare = await callers(second).admission.prepareCountersign({
    publicId: bobPacket,
    expectedReceivedCents: 7_500_000,
    expectedUnits: "75",
  });
  check(
    "reassign while SENT: the new signer can prepare",
    !!secondPrepare.token,
  );
  // Known gap (reported): a signing token names the recipient row, not the
  // team member, so the earlier signer's link is live again once the new
  // signer has prepared. Observed, not asserted as desired behaviour.
  const old = await errorOf(() => signAttempt(bobFirstToken));
  console.log(
    `  note the earlier signer's link after re-prepare: ${
      old?.message.startsWith("Please complete")
        ? "ACCEPTED (live again)"
        : `refused (${old?.message})`
    }`,
  );

  // Jane is a Member now; a second subscription does not touch her record
  // unless the Manager says so.
  const again = await sendPacket(admin, masterPublicId, {
    stakeholderId: janeId,
  });
  await investorSigns(admin, A, again, {
    ...JANE,
    commitment_amount: "50,000",
    amount_paid: "50,000",
    address_street: "9 New Road",
  });
  let v = await admission.get({ publicId: again });
  const before = await db.stakeholder.findFirstOrThrow({
    where: { id: janeId },
  });
  await expectRefused(
    "an admitted Member's record needs an explicit choice",
    () => admission.confirmDetails(confirmInput(v)),
    /already a Member/,
  );
  v = await admission.confirmDetails(
    confirmInput(v, { updateMemberRecord: false }),
  );
  const kept = await db.stakeholder.findFirstOrThrow({ where: { id: janeId } });
  eq("member record kept", kept.streetAddress, before.streetAddress);
  eq(
    "member record version unchanged",
    kept.updatedAt.toISOString(),
    before.updatedAt.toISOString(),
  );
  eq("second commitment created", v.commitment?.committedCents, 5_000_000);
  v = await admission.confirmDetails(
    confirmInput(v, { updateMemberRecord: true }),
  );
  const changed = await db.stakeholder.findFirstOrThrow({
    where: { id: janeId },
  });
  eq("member record updated on request", changed.streetAddress, "9 New Road");
  const audit = await db.audit.findFirst({
    where: { companyId: A.id, action: "admission.confirmed" },
    orderBy: { occurredAt: "desc" },
  });
  check(
    "the update is audited field by field",
    audit?.summary?.includes("street 1 Main St → 9 New Road") ?? false,
    audit?.summary ?? "",
  );
  eq("still MEMBER", changed.memberStatus, "MEMBER");

  // Reassign the signer: the old signer can no longer prepare.
  await admission.reassignManager({
    publicId: again,
    managerMemberId: memberIdOf(second),
  });
  v = await admission.get({ publicId: again });
  eq("reassigned: manager", v.manager.memberId, memberIdOf(second));
  eq("reassigned: not the current user", v.manager.isCurrentUser, false);
  eq("reassigned: manager PENDING", v.manager.status, "PENDING");
}

async function concurrency() {
  section("Concurrency");
  setToday("2026-11-13");
  const { admission } = callers(admin);

  // confirm vs cancel.
  const p1 = await sendPacket(admin, masterPublicId, {
    name: "Gus Race",
    email: `gus.${randomUUID().slice(0, 8)}@example.com`,
  });
  await investorSigns(admin, A, p1, { ...JANE, legal_name: "Gus" });
  const v1 = await admission.get({ publicId: p1 });
  const r1 = await race(
    (tx) => confirmPacketDetails(tx, A.id, confirmInput(v1), actor),
    () => admission.cancel({ publicId: p1 }),
  );
  check(
    "confirm vs cancel: confirm succeeded",
    r1.first.ok,
    JSON.stringify(r1.first),
  );
  check("confirm vs cancel: cancel waited for the lock", r1.secondWaited);
  check(
    "confirm vs cancel: cancel refused",
    !r1.second.ok && /can no longer be cancelled/.test(r1.second.message),
    JSON.stringify(r1.second),
  );
  const t1 = await db.template.findFirstOrThrow({ where: { publicId: p1 } });
  eq(
    "confirm vs cancel: packet PENDING with its commitment",
    t1.status,
    "PENDING",
  );
  check("confirm vs cancel: commitment linked", t1.commitmentId !== null);

  // cancel (holding the packet lock) vs confirm.
  const p2 = await sendPacket(admin, masterPublicId, {
    name: "Hal Race",
    email: `hal.${randomUUID().slice(0, 8)}@example.com`,
  });
  await investorSigns(admin, A, p2, { ...JANE, legal_name: "Hal" });
  const v2 = await admission.get({ publicId: p2 });
  const t2 = await db.template.findFirstOrThrow({ where: { publicId: p2 } });
  const r2 = await race(
    async (tx) => {
      // What admission.cancel does under the same lock.
      await lockTemplate(tx, t2.id);
      await tx.template.update({
        where: { id: t2.id, status: "PENDING", AND: [{ commitmentId: null }] },
        data: { status: "CANCELLED" },
      });
    },
    (tx) => confirmPacketDetails(tx, A.id, confirmInput(v2), actor),
  );
  check("cancel vs confirm: cancel succeeded", r2.first.ok);
  check("cancel vs confirm: confirm waited", r2.secondWaited);
  check(
    "cancel vs confirm: confirm refused",
    !r2.second.ok && /is cancelled/.test(r2.second.message),
    JSON.stringify(r2.second),
  );
  eq(
    "cancel vs confirm: no commitment left behind",
    await db.commitment.count({
      where: { companyId: A.id, stakeholderId: t2.stakeholderId ?? "" },
    }),
    0,
  );

  // Two confirms of the same screen.
  const p3 = await sendPacket(admin, masterPublicId, {
    name: "Ivy Race",
    email: `ivy.${randomUUID().slice(0, 8)}@example.com`,
  });
  await investorSigns(admin, A, p3, { ...JANE, legal_name: "Ivy" });
  const v3 = await admission.get({ publicId: p3 });
  const r3 = await race(
    (tx) => confirmPacketDetails(tx, A.id, confirmInput(v3), actor),
    (tx) => confirmPacketDetails(tx, A.id, confirmInput(v3), actor),
  );
  check("two confirms: first succeeded", r3.first.ok);
  check("two confirms: second waited", r3.secondWaited);
  check(
    "two confirms: second is a CONFLICT",
    !r3.second.ok && r3.second.code === "CONFLICT",
    JSON.stringify(r3.second),
  );
  const t3 = await db.template.findFirstOrThrow({ where: { publicId: p3 } });
  eq(
    "two confirms: one commitment",
    await db.commitment.count({
      where: { companyId: A.id, stakeholderId: t3.stakeholderId ?? "" },
    }),
    1,
  );
}

async function removeBucketsAndObjects() {
  section(
    "Buckets, recipients, fields and stored objects of the test companies",
  );
  const ids = companies.map((c) => c.id);
  const templates = await db.template.findMany({
    where: { companyId: { in: ids } },
    select: { id: true, bucketId: true },
  });
  const documents = await db.document.findMany({
    where: { companyId: { in: ids } },
    select: { bucketId: true, bucket: { select: { key: true } } },
  });
  for (const d of documents) {
    if (
      !objectKeys.includes(d.bucket.key) &&
      !d.bucket.key.includes("w9-docs-test")
    ) {
      objectKeys.push(d.bucket.key);
    }
  }
  const bucketIds = [
    ...new Set([
      ...templates.map((t) => t.bucketId),
      ...documents.map((d) => d.bucketId),
    ]),
  ];
  const templateIds = templates.map((t) => t.id);
  await db.templateField.deleteMany({
    where: { templateId: { in: templateIds } },
  });
  await db.esignRecipient.deleteMany({
    where: { templateId: { in: templateIds } },
  });
  await db.bucket.deleteMany({ where: { id: { in: bucketIds } } });
  for (const key of new Set(objectKeys)) {
    await deleteObject(key);
  }
  eq(
    "buckets removed",
    await db.bucket.count({ where: { id: { in: bucketIds } } }),
    0,
  );
  eq(
    "recipients and fields removed",
    (await db.esignRecipient.count({
      where: { templateId: { in: templateIds } },
    })) +
      (await db.templateField.count({
        where: { templateId: { in: templateIds } },
      })),
    0,
  );
  console.log(`  removed ${new Set(objectKeys).size} stored objects`);
}

await runScenarios([
  ["setup", setup],
  ["full acceptance", fullAcceptance],
  ["reduced acceptance", reducedAcceptance],
  ["rejection", rejection],
  ["rule refusals", ruleRefusals],
  ["cancelled, foreign, existing member", cancelledAndForeign],
  ["concurrency", concurrency],
  ["remove buckets and objects", removeBucketsAndObjects],
]);
