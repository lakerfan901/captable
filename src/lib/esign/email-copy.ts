// Subjects and wording of the e-sign emails. An ordinary e-sign template keeps
// the generic wording; a SUBSCRIPTION packet (online subscription, F12/F13)
// names the company and says what the documents are. Pure.

export type EsignEmailWorkflow = "STANDARD" | "SUBSCRIPTION";

export const STANDARD_REQUEST_SUBJECT = "eSign Document Request";
export const STANDARD_COMPLETED_SUBJECT =
  "Completed e-signed documents from all parties";

export interface EsignRequestCopy {
  subject: string;
  preview: string;
  /** The sentence under the company name; null keeps the standard layout. */
  headline: string | null;
  /** Shown when the sender wrote no message; null keeps the standard text. */
  intro: string | null;
  button: string;
}

/** The request to sign (sent to the investor for a SUBSCRIPTION packet). */
export function esignRequestCopy(input: {
  workflow: EsignEmailWorkflow | null | undefined;
  companyName: string | null | undefined;
  senderName: string | null | undefined;
}): EsignRequestCopy {
  const company = input.companyName?.trim();
  if (input.workflow === "SUBSCRIPTION" && company) {
    return {
      subject: `${company}: your subscription documents to sign`,
      preview: `${company} has sent you your subscription documents to sign.`,
      headline: `Your subscription documents for ${company} are ready to sign.`,
      intro: `${company} has sent you its subscription documents: the Operating Agreement signature page (Exhibit B) for your investment. Please review and sign them. After you sign, you will be asked to upload a Form W-9. Your subscription is subject to acceptance by the Manager.`,
      button: "Review and sign",
    };
  }
  return {
    subject: STANDARD_REQUEST_SUBJECT,
    preview: `${input.senderName ?? ""} has sent you a document to sign.`,
    headline: null,
    intro: null,
    button: "Sign the document",
  };
}

/**
 * The body sentence of the "all parties signed" email for a SUBSCRIPTION
 * packet (null keeps the standard wording).
 */
export function esignCompletedBody(input: {
  workflow: EsignEmailWorkflow | null | undefined;
  companyName: string | null | undefined;
}): string | null {
  const company = input.companyName?.trim();
  if (input.workflow === "SUBSCRIPTION" && company) {
    return `The Manager of ${company} has countersigned the subscription documents, and the subscription is accepted. The fully signed Exhibit B is attached for your records.`;
  }
  return null;
}

/** The "all parties signed" email with the PDF attached. */
export function esignCompletedSubject(input: {
  workflow: EsignEmailWorkflow | null | undefined;
  companyName: string | null | undefined;
}): string {
  const company = input.companyName?.trim();
  if (input.workflow === "SUBSCRIPTION" && company) {
    return `${company}: your subscription documents are countersigned`;
  }
  return STANDARD_COMPLETED_SUBJECT;
}
