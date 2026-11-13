/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { createHash } from "node:crypto";
import { createTransport, type SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { env } from "@/env";
import { normalizeRecipients } from "@/lib/email-recipients";
import { logger } from "@/lib/logger";
import { isMailCatcherUrl } from "@/lib/mail-catcher";
import { buildFrom } from "@/lib/mail-from";
import { db } from "@/server/db";

const getTransport = () => {
  return createTransport({
    url: env.EMAIL_SERVER,
  });
};

type RecordType = Record<string, string | undefined>;

export type EmailLogContext = {
  kind: string;
  companyId?: string | null;
  stakeholderId?: string | null;
  relatedType?: string;
  relatedId?: string;
};

export type SendMailResult = {
  emailLogId: string | null;
  sentAt: Date;
  messageId: string | null;
};

type LogRow = {
  status: "SENT" | "FAILED";
  sentAt: Date | null;
  providerMessageId?: string | null;
  smtpResponse?: string | null;
  errorMessage?: string | null;
};

export const isMailCatcherConfigured = (): boolean =>
  isMailCatcherUrl(env.EMAIL_SERVER);

const resolveStakeholderId = async (
  companyId: string,
  toAddress: string,
): Promise<string | null> => {
  if (!toAddress || toAddress.includes(",")) return null;
  const stakeholder = await db.stakeholder.findFirst({
    where: {
      companyId,
      OR: [
        { email: { equals: toAddress, mode: "insensitive" } },
        { noticeEmail: { equals: toAddress, mode: "insensitive" } },
      ],
    },
    select: { id: true },
  });
  return stakeholder?.id ?? null;
};

/** Writes one EmailLog row. Never throws: a throw after a successful send would make pg-boss resend. */
const writeEmailLog = async (
  options: Omit<SendMailOptions, "from">,
  log: EmailLogContext | undefined,
  toAddress: string,
  row: LogRow,
): Promise<string | null> => {
  try {
    const companyId = log?.companyId ?? null;
    let stakeholderId = log?.stakeholderId ?? null;
    if (companyId && !stakeholderId) {
      stakeholderId = await resolveStakeholderId(companyId, toAddress);
    }
    const bodySha256 =
      typeof options.html === "string"
        ? createHash("sha256").update(options.html).digest("hex")
        : null;

    const created = await db.emailLog.create({
      data: {
        ...row,
        toAddress,
        fromAddress: env.EMAIL_FROM,
        subject: typeof options.subject === "string" ? options.subject : "",
        kind: log?.kind ?? "uncategorized",
        companyId,
        stakeholderId,
        relatedType: log?.relatedType ?? null,
        relatedId: log?.relatedId ?? null,
        bodySha256,
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    logger.error({ err: error, kind: log?.kind }, "Failed to write EmailLog");
    return null;
  }
};

/**
 * Sends one email. Callers may pass the sender's display name (usually the
 * company name) as the `X-From-Name` pseudo-header: it is turned into the
 * name of the From address and NOT sent as a header. The address is always
 * EMAIL_FROM's; the name is cleaned and passed to nodemailer as
 * `{ name, address }` so it can never change the sender (see lib/mail-from).
 */
export const sendMail = async (
  options: Omit<SendMailOptions, "from">,
  log?: EmailLogContext,
): Promise<SendMailResult> => {
  const { "X-From-Name": senderName, ...headers } = (options.headers ||
    {}) as RecordType;
  const toAddress = normalizeRecipients(options.to);
  const transport = getTransport();

  let info: SMTPTransport.SentMessageInfo;
  try {
    // Inside the try: a missing / unparsable EMAIL_FROM is a failed send
    // with a FAILED EmailLog row, like any transport error.
    info = await transport.sendMail({
      ...options,
      headers,
      from: buildFrom(senderName, env.EMAIL_FROM ?? ""),
    });
  } catch (error) {
    // Connection errors (e.g. ECONNREFUSED as an AggregateError) can have an
    // empty message; fall back to the error code.
    const code = (error as { code?: unknown } | null)?.code;
    const message =
      (error instanceof Error && error.message) ||
      (typeof code === "string" ? code : "") ||
      String(error);
    await writeEmailLog(options, log, toAddress, {
      status: "FAILED",
      sentAt: null,
      errorMessage: message.slice(0, 1000),
    });
    throw error;
  }

  const accepted = Array.isArray(info.accepted) ? info.accepted : [];
  const rejected = Array.isArray(info.rejected) ? info.rejected : [];
  if (accepted.length === 0 && rejected.length > 0) {
    const error = new Error("All recipients were rejected");
    await writeEmailLog(options, log, toAddress, {
      status: "FAILED",
      sentAt: null,
      providerMessageId: info.messageId ?? null,
      smtpResponse: info.response?.slice(0, 500) ?? null,
      errorMessage: error.message,
    });
    throw error;
  }

  const sentAt = new Date();
  const messageId = info.messageId ?? null;
  const emailLogId = await writeEmailLog(options, log, toAddress, {
    status: "SENT",
    sentAt,
    providerMessageId: messageId,
    smtpResponse: info.response?.slice(0, 500) ?? null,
  });

  return { emailLogId, sentAt, messageId };
};
