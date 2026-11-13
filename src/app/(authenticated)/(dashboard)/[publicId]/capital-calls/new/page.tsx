import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";
import { NoticeForm } from "../components/notice-form";

export const metadata: Metadata = { title: "New Call Notice" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** New Call Notice, or `?id=<draft id>` to edit a draft. */
export default async function NewCallNoticePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const canCreate = allow(true, ["capital-calls", "create"], false);
  const eligible = canCreate
    ? await allow(api.callNotice.eligible(), ["capital-calls", "read"])
    : null;
  if (!canCreate || !eligible) return <UnAuthorizedState />;

  const sp = await searchParams;
  const draftId = typeof sp.id === "string" ? sp.id : undefined;
  const draft = draftId ? await api.callNotice.get({ id: draftId }) : null;
  if (draft && draft.notice.status !== "DRAFT") notFound();

  return (
    <div className="flex flex-col gap-y-4">
      <div>
        <h3 className="font-medium">
          {draft
            ? `Edit draft Call Notice No. ${draft.notice.number}`
            : "New Call Notice"}
        </h3>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Saving creates a draft. Nothing is sent until you send it from the
          notice page.
        </p>
      </div>
      <NoticeForm
        base={`/${entity.publicId}/capital-calls`}
        eligible={eligible}
        draft={
          draft
            ? {
                id: draft.notice.id,
                purpose: draft.notice.purpose,
                bankAccountId: draft.notice.bankAccountId,
                lines: draft.lines.map((l) => ({
                  commitmentId: l.commitmentId,
                  amountCalled: l.amountCalled,
                })),
              }
            : null
        }
      />
    </div>
  );
}
