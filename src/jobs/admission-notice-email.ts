import { render } from "react-email";
import { z } from "zod";
import AdmissionNoticeEmail from "@/emails/AdmissionNoticeEmail";
import { logger } from "@/lib/logger";
import { db } from "@/server/db";
import {
  type AdmissionNoticePayload,
  encodeW9Token,
  loadW9Packet,
  w9UploadUrl,
} from "@/server/llc/admission";
import { sendMail } from "@/server/mailer";
import { defineJob, defineWorker, defineWorkerConfig } from "../lib/queue";

// Exhibit B notices (01-foundation.md F12): the W-9 request to the investor
// and the review notice to the Manager, emitted by `template.sign` after the
// investor's signature commits.
//
// The W-9 link is a credential, so it is not in the job payload: for a W-9
// request the payload names the investor recipient and the worker mints a
// fresh link when it sends, after checking the packet still accepts a W-9
// (a packet cancelled in between gets no link). The link is never logged.

const Schema = z.object({
  to: z.string().email(),
  companyId: z.string(),
  companyName: z.string(),
  kind: z.enum(["admission.w9-request", "admission.signed-notice"]),
  subject: z.string().min(1).max(300),
  heading: z.string(),
  lines: z.array(z.string()),
  cta: z.object({ label: z.string(), url: z.string().url() }).nullable(),
  w9RecipientId: z.string().optional(),
  stakeholderId: z.string().optional(),
  templateId: z.string(),
}) satisfies z.ZodType<AdmissionNoticePayload>;

export type TAdmissionNoticeEmailJobInput = z.infer<typeof Schema>;

const config = defineWorkerConfig({
  name: "email.admission-notice",
  schema: Schema,
});

const log = logger.child({ module: "admission-notice-email" });

export const admissionNoticeEmailJob = defineJob(config);
export const admissionNoticeEmailWorker = defineWorker(config, async (job) => {
  const data = job.data;
  let cta = data.cta;

  if (data.w9RecipientId) {
    const packet = await loadW9Packet(db, {
      templateId: data.templateId,
      recipientId: data.w9RecipientId,
    });
    if (!packet || packet.companyId !== data.companyId) {
      log.info(
        { templateId: data.templateId, kind: data.kind },
        "W-9 request skipped: the packet no longer accepts a W-9",
      );
      return;
    }
    const token = await encodeW9Token({
      templateId: packet.templateId,
      recipientId: packet.recipientId,
    });
    cta = { label: "Upload Form W-9", url: w9UploadUrl(token) };
  }

  const html = await render(
    AdmissionNoticeEmail({
      companyName: data.companyName,
      heading: data.heading,
      lines: data.lines,
      cta,
    }),
  );

  await sendMail(
    {
      to: data.to,
      subject: data.subject,
      html,
      headers: { "X-From-Name": data.companyName },
    },
    {
      kind: data.kind,
      companyId: data.companyId,
      ...(data.stakeholderId ? { stakeholderId: data.stakeholderId } : {}),
      relatedType: "template",
      relatedId: data.templateId,
    },
  );
});
