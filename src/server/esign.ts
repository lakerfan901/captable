/* eslint-disable @typescript-eslint/prefer-for-of */

import { renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { dayjsExt } from "@/common/dayjs";
import { TAG } from "@/lib/tags";
import { AuditLogTemplate } from "@/pdf-templates/audit-log-template";
import { Audit } from "@/server/audit";
import {
  getFileFromS3,
  type TUploadFile,
  uploadFile,
} from "@/server/file-uploads";
import { createBucketHandler } from "@/trpc/routers/bucket-router/procedures/create-bucket";
import { createDocumentHandler } from "@/trpc/routers/document-router/procedures/create-document";
import type { PrismaTransactionalClient } from "./db";

interface getEsignAuditsOptions {
  templateId: string;
  tx: PrismaTransactionalClient;
}

export async function getEsignAudits({
  templateId,
  tx,
}: getEsignAuditsOptions) {
  const audits = await tx.esignAudit.findMany({
    where: {
      templateId,
    },
    select: {
      id: true,
      summary: true,
      occurredAt: true,
      action: true,
    },
  });
  return audits;
}

export type TGetEsignAudits = Awaited<ReturnType<typeof getEsignAudits>>;

interface getEsignTemplateOptions {
  templateId: string;
  tx: PrismaTransactionalClient;
}

export function getEsignTemplate({ tx, templateId }: getEsignTemplateOptions) {
  return tx.template.findFirstOrThrow({
    where: { id: templateId },
    select: {
      bucket: true,
      fields: {
        orderBy: {
          top: "asc",
        },
      },
      companyId: true,
      id: true,
      name: true,
      orderedDelivery: true,
      uploader: {
        select: {
          user: {
            select: {
              name: true,
              email: true,
            },
          },
        },
      },
      message: true,
      status: true,
      workflow: true,
      isMaster: true,
      stakeholderId: true,
      commitmentId: true,
      company: {
        select: {
          name: true,
          logo: true,
          publicId: true,
        },
      },
    },
  });
}

export type EsignGetTemplateType = Awaited<ReturnType<typeof getEsignTemplate>>;

type Field = EsignGetTemplateType["fields"][number];
/** How a `DATE` field is stamped: `STANDARD` keeps `DD/MM/YYYY` (A3.13). */
export type EsignDateFormat = "DD/MM/YYYY" | "MM/DD/YYYY";

interface TGetFieldValue {
  type: Field["type"];
  id: Field["id"];
  data: Record<string, string>;
  meta: Field["meta"];
  dateFormat?: EsignDateFormat;
}

export const getFieldValue = ({
  type,
  id,
  data,
  meta,
  dateFormat = "DD/MM/YYYY",
}: TGetFieldValue) => {
  const value = data?.[id];

  const selectValue = meta?.options
    ? meta.options.find((val) => val.id === value)?.value
    : undefined;

  return value
    ? type === "DATE"
      ? dayjsExt(value).format(dateFormat)
      : type === "SELECT"
        ? selectValue
        : value
    : undefined;
};

export interface GenerateEsignSignPdfOptionsType {
  bucketKey: string;
  data: Record<string, string>;
  fields: EsignGetTemplateType["fields"];
  audits: TGetEsignAudits;
  templateName: string;
  dateFormat?: EsignDateFormat;
}

export async function generateEsignPdf({
  bucketKey,
  data,
  fields,
  audits,
  templateName,
  dateFormat = "DD/MM/YYYY",
}: GenerateEsignSignPdfOptionsType) {
  const docBuffer = await getFileFromS3(bucketKey);
  const pdfDoc = await PDFDocument.load(docBuffer);

  const pages = pdfDoc.getPages();

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 8;
  const textHeight = font.heightAtSize(fontSize);

  for (const field of fields) {
    const value = getFieldValue({
      data,
      id: field.id,
      meta: field.meta,
      type: field.type,
      dateFormat,
    });

    if (value) {
      const pageNumber = field.page - 1;

      const page = pages.at(pageNumber);

      if (!page) {
        throw new Error("page not found");
      }

      const { width: pageWidth, height: pageHeight } = page.getSize();

      const widthRatio = pageWidth / field.viewportWidth;
      const heightRatio = pageHeight / field.viewportHeight;

      const fieldX = field.left * widthRatio;

      const fieldY = field.top * heightRatio;
      const height = field.height * heightRatio;
      const width = height;

      if (field.type === "SIGNATURE") {
        const image = await pdfDoc.embedPng(value);

        const updatedY = fieldY + height;

        page.drawImage(image, {
          x: fieldX,
          y: pageHeight - updatedY,
          width,
          height,
        });
      } else {
        const padding = (height + textHeight) / 2;

        page.drawText(value, {
          x: fieldX,
          y: pageHeight - fieldY - padding,
          font,
          size: fontSize,
        });
      }
    }
  }

  if (audits.length) {
    const audit = await renderToBuffer(
      AuditLogTemplate({ audits, templateName }),
    );
    const auditPDFDoc = await PDFDocument.load(audit);
    const indices = auditPDFDoc.getPageIndices();
    const copiedPages = await pdfDoc.copyPages(auditPDFDoc, indices);

    for (const auditPage of copiedPages) {
      if (auditPage) {
        pdfDoc.addPage(auditPage);
      }
    }
  }

  const modifiedPdfBytes = await pdfDoc.save();

  return modifiedPdfBytes;
}

export interface uploadEsignDocumentsOptions {
  buffer: Buffer;
  templateName: string;
  companyId: string;
}

export async function uploadEsignDocuments({
  buffer,
  companyId,
  templateName,
}: uploadEsignDocumentsOptions) {
  const file = {
    name: templateName,
    type: "application/pdf",
    arrayBuffer: async () => Promise.resolve(buffer),
    size: 0,
  } as unknown as File;

  const data = await uploadFile(file, {
    identifier: companyId,
    keyPrefix: "signed-esign-doc",
  });

  return data;
}

export interface CompleteEsignDocumentsOptionsType {
  companyId: string;
  db: PrismaTransactionalClient;
  requestIp: string;
  userAgent: string;
  uploaderName: string;
  templateId: string;
  bucketData: Omit<TUploadFile, "fileUrl">;
}

export interface CompleteEsignDocumentsResult {
  documentId: string;
  /** False when the template was already completed (a retried job). */
  created: boolean;
}

/**
 * Files the signed PDF as a `Document` and marks the template `COMPLETE`.
 * Idempotent (A3.12): the template row is locked first and a template that
 * already has `signedDocumentId` returns it without creating anything, so a
 * retried or overlapping `esign.complete-pdf` job creates no second Bucket or
 * Document. Must run inside a transaction (the row lock lasts until commit).
 */
export async function completeEsignDocuments({
  companyId,
  db,
  requestIp,
  templateId,
  uploaderName,
  userAgent,
  bucketData,
}: CompleteEsignDocumentsOptionsType): Promise<CompleteEsignDocumentsResult> {
  // Lock, then read: a concurrent run waits here and then sees the
  // committed `signedDocumentId`.
  await db.$queryRaw`
    SELECT id FROM "Template"
    WHERE id = ${templateId} AND "companyId" = ${companyId}
    FOR UPDATE`;

  const template = await db.template.findFirstOrThrow({
    where: { id: templateId, companyId },
    select: {
      id: true,
      companyId: true,
      signedDocumentId: true,
      workflow: true,
      stakeholderId: true,
    },
  });

  if (template.signedDocumentId) {
    return { documentId: template.signedDocumentId, created: false };
  }

  const { id: bucketId, name } = await createBucketHandler({
    db,
    input: { ...bucketData, tags: [TAG.ESIGN] },
    userAgent,
    requestIp,
    user: { id: "", name: uploaderName, companyId: template.companyId },
  });

  const document = await createDocumentHandler({
    input: { bucketId, name },
    requestIp,
    db,
    userAgent,
    companyId: template.companyId,
    uploaderName,
  });

  // F13: a countersigned Exhibit B is filed on the member, in the same
  // transaction (and so as idempotent as the rest of this function). A
  // stakeholder outside the company is skipped, not thrown on: a throw would
  // make the job retry forever and the packet would never complete.
  if (template.workflow === "SUBSCRIPTION" && template.stakeholderId) {
    const stakeholder = await db.stakeholder.findFirst({
      where: { id: template.stakeholderId, companyId: template.companyId },
      select: { id: true, name: true },
    });
    if (stakeholder) {
      await db.document.update({
        where: { id: document.id, companyId: template.companyId },
        data: { stakeholderId: stakeholder.id, kind: "exhibit-b" },
      });
      await Audit.create(
        {
          action: "document.attached",
          companyId: template.companyId,
          actor: { type: "company", id: template.companyId },
          context: { requestIp, userAgent },
          target: [
            { type: "document", id: document.id },
            { type: "stakeholder", id: stakeholder.id },
          ],
          summary: `The signed Exhibit B "${document.name}" was filed on ${stakeholder.name}.`,
        },
        db,
      );
    }
  }

  await db.template.update({
    where: { id: template.id },
    data: {
      signedDocumentId: document.id,
      completedOn: new Date(),
      status: "COMPLETE",
    },
  });

  return { documentId: document.id, created: true };
}
