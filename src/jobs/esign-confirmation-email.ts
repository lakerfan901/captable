import { render } from "react-email";
import { z } from "zod";
import ESignConfirmationEmail from "@/emails/EsignConfirmationEmail";
import { getPresignedGetUrl } from "@/server/file-uploads";
import { sendMail } from "@/server/mailer";
import { defineJob, defineWorker, defineWorkerConfig } from "../lib/queue";

const Schema = z.object({
  fileUrl: z.string(),
  fileKey: z.string().optional(),
  companyId: z.string().optional(),
  templateId: z.string().optional(),
  documentName: z.string(),
  senderName: z.string().nullable(),
  senderEmail: z.string().nullable(),
  company: z.object({
    name: z.string(),
    logo: z.string().nullish(),
  }),
  recipient: z.object({
    name: z.string().nullish(),
    email: z.string().email(),
  }),
});

const config = defineWorkerConfig({
  name: "email.esign-confirmation",
  schema: Schema,
});

export type TSchema = z.infer<typeof Schema>;

export const eSignConfirmationEmailJob = defineJob(config);
export const eSignConfirmationEmailWorker = defineWorker(
  config,
  async (job) => {
    const payload = job.data;

    const html = await render(
      ESignConfirmationEmail({
        documentName: payload.documentName,
        recipient: payload.recipient,
        senderName: payload.senderName,
        senderEmail: payload.senderEmail,
        company: payload.company,
      }),
    );
    // A fresh presigned URL on every attempt, so a retry after the old URL
    // expired still attaches the file (jobs queued before fileKey existed
    // fall back to fileUrl).
    const attachmentUrl = payload.fileKey
      ? (await getPresignedGetUrl(payload.fileKey)).url
      : payload.fileUrl;

    await sendMail(
      {
        to: payload.recipient.email,
        ...(payload.senderEmail && { replyTo: payload.senderEmail }),
        subject: "Completed e-signed documents from all parties",
        html,
        attachments: [
          {
            filename: payload.documentName,
            path: attachmentUrl,
          },
        ],

        headers: {
          "X-From-Name": payload.senderName || "Captable",
        },
      },
      {
        kind: "esign.completed",
        companyId: payload.companyId,
        ...(payload.templateId && {
          relatedType: "template",
          relatedId: payload.templateId,
        }),
      },
    );
  },
);
