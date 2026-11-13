import { RiErrorWarningLine } from "@remixicon/react";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { W9Upload } from "@/components/llc/admission/w9-upload";
import { Card } from "@/components/ui/card";
import { api } from "@/trpc/server";

// Public Form W-9 upload page (01-foundation.md F12): where an investor lands
// after signing the Exhibit B signature page, and what the W-9 email links
// to. No login: the token in the path is the only credential. It is passed
// to `admission.w9Info` (server side; a mutation, so never in a URL query)
// and to the client `W9Upload`, and is never logged, rendered or put in the
// title. `no-referrer` keeps it out of the Referer of every request this
// page makes (the presigned PUT to storage included); the page loads nothing
// from another origin and links nowhere. The access log redacts the
// JWT-shaped path segment (src/lib/token-redaction.ts).

export const metadata: Metadata = {
  title: "Form W-9",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

export default async function W9Page(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const info = await api.admission.w9Info({ token }).catch(() => null);

  if (!info) {
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

  return (
    <div className="flex min-h-screen justify-center bg-gray-50 px-5 pb-5 pt-12">
      <div className="mx-auto flex w-full max-w-xl flex-col">
        <div className="mb-8 text-lg font-semibold">{info.companyName}</div>
        <Card className="p-8">
          <W9Upload
            token={token}
            companyName={info.companyName}
            investorName={info.investorName}
            uploaded={info.uploaded}
            remaining={info.remaining}
          />
        </Card>
      </div>
    </div>
  );
}
