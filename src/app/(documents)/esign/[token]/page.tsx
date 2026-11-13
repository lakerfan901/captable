import { RiErrorWarningLine } from "@remixicon/react";
import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { PdfCanvas } from "@/components/template/pdf-canvas";
import { SigningFields } from "@/components/template/signing-fields";
import { TemplateSigningFieldProvider } from "@/providers/template-signing-field-provider";
import { getServerComponentAuthSession } from "@/server/auth";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Document signing",
};

interface SigningPageProps {
  params: Promise<{
    token: string;
  }>;
}

/**
 * A link that cannot be opened for signing: a purpose token (W-9, ballot,
 * report: FORBIDDEN), a malformed, tampered or expired token (jose), a token
 * without the signing claims (zod), or no recipient still waiting to sign
 * (Prisma "not found"). Anything else is a real failure and is rethrown.
 */
function isInvalidLink(error: unknown): boolean {
  if (!(error instanceof TRPCError)) return false;
  if (error.code === "FORBIDDEN" || error.code === "NOT_FOUND") return true;
  const cause = error.cause as { code?: unknown; name?: unknown } | undefined;
  if (cause?.name === "ZodError") return true;
  return (
    typeof cause?.code === "string" &&
    (cause.code.startsWith("ERR_J") || cause.code === "P2025")
  );
}

export default async function SigningPage(props: SigningPageProps) {
  const { token } = await props.params;

  const data = await api.template
    .getSigningFields({ token })
    .catch((error: unknown) => {
      if (isInvalidLink(error)) return null;
      throw error;
    });

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-5">
        <EmptyState
          icon={<RiErrorWarningLine />}
          title="Link not valid"
          subtitle="This link is invalid or has expired."
          error={true}
        />
      </div>
    );
  }

  const {
    fields,
    url,
    recipientId,
    templateId,
    signableFields,
    status: templateStatus,
  } = data;

  const session = await getServerComponentAuthSession();
  const companyPublicId = session?.user.companyPublicId;

  if (templateStatus === "CANCELLED") {
    return (
      <EmptyState
        title={"Cancelled"}
        subtitle={"This document signing has been cancelled."}
        error={true}
      />
    );
  }

  return (
    <TemplateSigningFieldProvider fields={fields}>
      <div className="flex min-h-screen bg-gray-50">
        <div className="flex h-full grow flex-col">
          <div className="mx-auto min-h-full w-full px-5 py-10 lg:px-8 2xl:max-w-(--breakpoint-xl)">
            <div className="grid grid-cols-12">
              <PdfCanvas mode="readonly" url={url} />
            </div>
          </div>
        </div>
        <div className="sticky top-0 flex min-h-full w-80 flex-col lg:border-l">
          <SigningFields
            recipientId={recipientId}
            templateId={templateId}
            token={token}
            fields={signableFields}
            companyPublicId={companyPublicId}
          />
        </div>
      </div>
    </TemplateSigningFieldProvider>
  );
}
