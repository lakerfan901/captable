import { z } from "zod";

import { dayjsExt } from "@/common/dayjs";
import { resolveTimeZone } from "@/lib/company-time";
import { EsignAudit } from "@/server/audit";
import { db } from "@/server/db";
import {
  type EsignGetTemplateType,
  generateEsignPdf,
  getEsignAudits,
  uploadEsignDocuments,
} from "@/server/esign";
import { defineJob, defineWorker, defineWorkerConfig } from "../lib/queue";
import {
  Schema as EsignCompleteSchema,
  eSignCompletePDFJob,
} from "./esign-complete-pdf";

const fields = z.array(z.any()) as z.ZodType<EsignGetTemplateType["fields"]>;

const schema = z
  .object({
    fields,
    data: z.record(z.string(), z.string()),
    bucketKey: z.string(),
  })
  .merge(EsignCompleteSchema.omit({ bucketData: true }));

export type TEsignPdfSchema = z.infer<typeof schema>;

const config = defineWorkerConfig({
  name: "esign.generate-pdf",
  schema,
});

export const eSignPdfJob = defineJob(config);
export const eSignPdfWorker = defineWorker(config, async (job) => {
  const {
    bucketKey,
    data,
    fields,
    companyId,
    templateName,
    requestIp,
    userAgent,
    sender,
    templateId,
    recipients,
    company,
  } = job.data;

  const template = await db.template.findUnique({
    where: { id: templateId },
    select: {
      status: true,
      workflow: true,
      company: { select: { timezone: true } },
    },
  });

  // Already completed (a retried job): nothing to stamp, upload or audit.
  if (!template || template.status === "COMPLETE") return;

  await EsignAudit.create(
    {
      action: "document.complete",
      companyId,
      templateId,
      ip: requestIp,
      location: "",
      userAgent: userAgent,
      summary: `"${templateName}" completely signed at ${dayjsExt(
        new Date(),
      ).format("lll")}`,
    },
    db,
  );

  const audits = await getEsignAudits({ templateId, tx: db });

  const modifiedPdfBytes = await generateEsignPdf({
    bucketKey,
    data,
    fields,
    audits,
    templateName,
    // Subscription packets are US documents (A3.13).
    dateFormat: template.workflow === "SUBSCRIPTION" ? "MM/DD/YYYY" : undefined,
    timeZone: resolveTimeZone(template.company.timezone),
  });
  const { fileUrl: _fileUrl, ...bucketData } = await uploadEsignDocuments({
    buffer: Buffer.from(modifiedPdfBytes),
    companyId,
    templateName,
  });

  await eSignCompletePDFJob.emit({
    requestIp,
    userAgent,
    sender,
    templateId,
    recipients,
    company,
    bucketData,
    companyId,
    templateName,
  });
});
