import { TRPCError } from "@trpc/server";
import { UAParser } from "ua-parser-js";
import {
  admissionNoticeEmailJob,
  type TAdmissionNoticeEmailJobInput,
} from "@/jobs/admission-notice-email";
import { filterSignerValues } from "@/lib/esign/filter-signer-values";
import { logger } from "@/lib/logger";
import { isKeyInCompanyNamespace } from "@/lib/upload-authorization";
import { guardedUpdate } from "@/server/guarded-write";
import {
  encodeW9Token,
  INVESTOR_ROLE,
  investorSignedNotices,
  lockTemplate,
  MANAGER_ROLE,
} from "@/server/llc/admission";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import { EsignService } from "@/services/esign-service";
import { withoutAuth } from "@/trpc/api/trpc";
import { assertCountersignFiguresCurrent } from "@/trpc/routers/admission-router/countersign";
import { DecodeEmailToken } from "../../template-field-router/procedures/add-fields";
import { SignTemplateMutationSchema } from "../schema";

export interface SignTemplateResult {
  /** The investor of a SUBSCRIPTION packet goes on to upload a Form W-9. */
  w9Token?: string;
  /**
   * The Manager countersigned a SUBSCRIPTION packet: the browser goes to that
   * packet's Admissions page (it needs a session there to open it).
   */
  countersigned?: { companyPublicId: string; templatePublicId: string };
}

export const signTemplateProcedure = withoutAuth
  .input(SignTemplateMutationSchema)
  .mutation(async ({ ctx, input }): Promise<SignTemplateResult> => {
    const { db, requestIp, userAgent } = ctx;

    // Public endpoint: the signing token (sent by email) is the credential.
    const token = await DecodeEmailToken(input.token).catch(() => null);

    if (
      !token ||
      token.id !== input.templateId ||
      token.rec !== input.recipientId
    ) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Invalid token" });
    }

    const userAgentParser = new UAParser(userAgent);
    const userAgentResult = userAgentParser.getResult();
    const browser = userAgentResult.browser.name;

    const eSignService = new EsignService();

    // SUBSCRIPTION packets (F12, B23): set when the investor signed; the
    // notices are emitted after the transaction commits.
    const signed = await db.$transaction(async (tx) => {
      let template = await eSignService.getTemplate(token.id, tx);
      const isSubscription = template.workflow === "SUBSCRIPTION";

      // A packet is signed, cancelled, prepared for countersigning and gets
      // its W-9s under the template row lock, so signing never races any of
      // them; the template (status and fields) is re-read under the lock.
      if (isSubscription) {
        // F13: the Manager's countersignature re-checks the ledger figures,
        // so it takes the company ledger and unit-class locks first (the lock
        // order everywhere: ledger, classes, then the template). The role is
        // read before any lock; a link to a replaced recipient row is dead.
        const signer = await tx.esignRecipient.findFirst({
          where: { id: token.rec, templateId: template.id },
          select: { role: true },
        });
        if (!signer) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This signature request is not active.",
          });
        }
        if (signer.role === MANAGER_ROLE) {
          await lockCompanyLedgerAndUnitClasses(tx, template.companyId);
        }
        await lockTemplate(tx, template.id);
        template = await eSignService.getTemplate(token.id, tx);
      }

      if (template.status !== "PENDING") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This document is not open for signing.",
        });
      }

      const bucketKey = template.bucket.key;

      // Never render another company's object into this company's document.
      if (
        !isKeyInCompanyNamespace(bucketKey, {
          id: template.companyId,
          publicId: template.company.publicId,
        })
      ) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      const companyId = template.companyId;
      const templateName = template.name;
      const sender = template.uploader.user;
      const allRecipients = new Set(
        template.fields.map((item) => item.recipientId),
      );
      const isMultiRecipient = allRecipients.size > 1;
      const isOrderedDelivery = template.orderedDelivery;

      const recipient = await eSignService.getRecipient(
        token.rec,
        template.id,
        tx,
      );

      if (recipient.status !== "SENT") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This signature request is not active.",
        });
      }

      // F13: the Exhibit B the Manager signs shows what the ledger says now.
      if (isSubscription && recipient.role === MANAGER_ROLE) {
        await assertCountersignFiguresCurrent(tx, {
          companyId,
          commitmentId: template.commitmentId,
          managerRecipientId: recipient.id,
          fields: template.fields,
        });
      }

      // Signer isolation (A3.8): only this recipient's own, writable fields
      // are taken from the request; required fields are checked here.
      const { values, missingRequired } = filterSignerValues(
        template.fields,
        recipient.id,
        input.data,
      );

      if (missingRequired.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Please complete: ${missingRequired.join(", ")}`,
        });
      }

      if (isSubscription) {
        // Guarded on SENT: a double submit signs (and notifies) once.
        const marked = await guardedUpdate(() =>
          tx.esignRecipient.update({
            where: { id: recipient.id, status: "SENT" },
            data: { status: "SIGNED" },
            select: { id: true },
          }),
        );
        if (marked === null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This signature request is not active.",
          });
        }
      } else {
        await eSignService.updateRecipientStatus(recipient.id, "SIGNED", tx);
      }

      await eSignService.createSignedAuditLog(
        {
          browser,
          companyId,
          recipientId: recipient.id,
          templateId: template.id,
          ip: ctx.requestIp,
          location: "",
          userAgent: ctx.userAgent,
          templateName: template.name,
          recipientName: recipient.name,
        },
        tx,
      );

      // A packet always keeps its answers on the fields (F13 reads them).
      if (!isMultiRecipient && !isSubscription) {
        await eSignService.completeDocument({
          companyId,
          templateName,
          fields: template.fields,
          data: values,
          templateId: template.id,
          requestIp,
          userAgent,
          sender,
          recipients: [
            {
              email: recipient.email,
              name: recipient.name,
            },
          ],
          company: template.company,
          bucketKey,
        });
      }

      if (isMultiRecipient || isSubscription) {
        await eSignService.saveFieldValues(template.fields, values, tx);

        const allRecipients = await eSignService.getAllRecipients(
          template.id,
          tx,
        );
        const areAllRecipientsSigned = allRecipients.every(
          (recipient) => recipient.status === "SIGNED",
        );

        if (areAllRecipientsSigned) {
          const fieldValues = await eSignService.getFieldValues(
            template.id,
            tx,
          );

          await eSignService.completeDocument({
            bucketKey,
            companyId,
            templateName,
            fields: template.fields,
            data: fieldValues,
            templateId: template.id,
            requestIp,
            userAgent,
            company: template.company,
            recipients: allRecipients.map((item) => ({
              email: item.email,
              name: item.name,
            })),
            sender,
          });
        }
      }

      // A packet never emails the next signer (B23): the Manager's link is
      // activated from the confirmation screen after acceptance (F13).
      if (isOrderedDelivery && !isSubscription) {
        await eSignService.handleOrderedDelivery(
          template,
          { sender, requestIp, userAgent },
          tx,
        );
      }

      if (isSubscription && recipient.role === INVESTOR_ROLE) {
        const notices: TAdmissionNoticeEmailJobInput[] =
          await investorSignedNotices(tx, {
            templateId: template.id,
            investorRecipientId: recipient.id,
          });
        return {
          kind: "investor" as const,
          templateId: template.id,
          recipientId: recipient.id,
          notices,
        };
      }
      if (isSubscription && recipient.role === MANAGER_ROLE) {
        return {
          kind: "manager" as const,
          companyPublicId: template.company.publicId,
          templatePublicId: template.publicId,
        };
      }
      return null;
    });

    if (signed === null) return {};
    if (signed.kind === "manager") {
      return {
        countersigned: {
          companyPublicId: signed.companyPublicId,
          templatePublicId: signed.templatePublicId,
        },
      };
    }

    // After commit (F12): the W-9 request to the investor and the review
    // notice to the Manager; the browser goes on to the W-9 page. The
    // signature is already recorded, so a failed emit is logged (without
    // the token) and does not fail the request: the investor still gets the
    // W-9 page.
    const w9Token = await encodeW9Token({
      templateId: signed.templateId,
      recipientId: signed.recipientId,
    });
    for (const notice of signed.notices) {
      try {
        await admissionNoticeEmailJob.emit(notice);
      } catch (error) {
        logger.error(
          { err: error, templateId: signed.templateId, kind: notice.kind },
          "Failed to queue an admission notice",
        );
      }
    }
    return { w9Token };
  });
