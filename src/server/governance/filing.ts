import "server-only";
import type { BooksRecordCategoryEnum } from "@prisma/client";
import { generatePublicId } from "@/common/id";
import type { TAG } from "@/lib/tags";
import { Audit } from "@/server/audit";
import { db, type PrismaTransactionalClient } from "@/server/db";
import { uploadFile } from "@/server/file-uploads";

// Files a server-generated PDF in Documents (03-governance.md G9): one
// private-bucket object, one Bucket row and one Document per books-and-records
// category, all pointing at the same Bucket. Used by the resolution finalize
// job (G9) and the member-report filing job (G13). Does NOT use
// createBucketHandler / createDocumentHandler (A4): there is no request.
//
// Pass the caller's transaction when the rows must commit together with the
// caller's own writes (the finalize job sets `executedDocumentId` in the same
// transaction, under the resolution's row lock, so two runs can never file
// two Documents). The object is uploaded first; if the transaction then rolls
// back, the object is an orphan with no rows (acceptable), never a duplicate
// Document.

const MAX_FILE_NAME = 120;

/** Removes / \ : * ? " < > | and control characters, caps at 120 chars, ends ".pdf". */
export function sanitizePdfFileName(raw: string): string {
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned.replace(/\.pdf$/i, "").trim() || "document";
  return `${base.slice(0, MAX_FILE_NAME - 4).trimEnd()}.pdf`;
}

export interface FileGeneratedPdfInput {
  company: { id: string; publicId: string };
  buffer: Buffer;
  fileName: string;
  keyPrefix: "resolutions" | "member-reports";
  tag: TAG;
  categories: {
    recordCategory: BooksRecordCategoryEnum;
    recordYear: number | null;
  }[];
  jobName: string;
}

export async function fileGeneratedPdf(
  input: FileGeneratedPdfInput,
  /** Create the rows in this transaction instead of a new one. */
  tx?: PrismaTransactionalClient,
): Promise<{ documentIds: string[]; bucketId: string; key: string }> {
  if (input.categories.length === 0) {
    throw new Error("fileGeneratedPdf needs at least one category");
  }
  const name = sanitizePdfFileName(input.fileName);
  const file = new File([new Uint8Array(input.buffer)], name, {
    type: "application/pdf",
  });
  const { key } = await uploadFile(file, {
    identifier: input.company.id,
    keyPrefix: input.keyPrefix,
  });

  if (tx) return await createPdfRows(tx, input, name, key);
  return await db.$transaction((t) => createPdfRows(t, input, name, key));
}

async function createPdfRows(
  tx: PrismaTransactionalClient,
  input: FileGeneratedPdfInput,
  name: string,
  key: string,
): Promise<{ documentIds: string[]; bucketId: string; key: string }> {
  const bucket = await tx.bucket.create({
    data: {
      name,
      key,
      mimeType: "application/pdf",
      size: input.buffer.byteLength,
      tags: [input.tag],
    },
  });
  const documentIds: string[] = [];
  for (const { recordCategory, recordYear } of input.categories) {
    const document = await tx.document.create({
      data: {
        companyId: input.company.id,
        publicId: generatePublicId(),
        name,
        bucketId: bucket.id,
        recordCategory,
        recordYear,
      },
    });
    documentIds.push(document.id);
    await Audit.create(
      {
        action: "document.created",
        companyId: input.company.id,
        actor: { type: "system", id: null },
        context: { requestIp: "system", userAgent: `job:${input.jobName}` },
        target: [{ type: "document", id: document.id }],
        summary: `Filed generated document "${name}" (${recordCategory}${
          recordYear === null ? "" : ` ${recordYear}`
        })`,
      },
      tx,
    );
  }
  return { documentIds, bucketId: bucket.id, key };
}
