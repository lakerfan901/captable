import type { Metadata } from "next";
import { NewResolutionFlow } from "@/components/governance/resolution-preset-form";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "New resolution" };

export default async function NewResolutionPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const canCreate = allow(true, ["governance", "create"], false);
  const rows = canCreate
    ? await allow(api.resolution.list({}), ["governance", "read"])
    : null;
  if (!canCreate || !rows) return <UnAuthorizedState />;

  // Prefill the names from the most recent purchase-order resolution.
  const lastPo = rows.find((r) => r.type === "PURCHASE_ORDER");
  let poPrefill: Record<string, unknown> = {};
  if (lastPo) {
    const detail = await api.resolution.get({ publicId: lastPo.publicId });
    const params = (detail.resolution.params ?? {}) as Record<string, unknown>;
    poPrefill = {
      managerName:
        typeof params.managerName === "string" ? params.managerName : "",
      purchasingAgentName:
        typeof params.purchasingAgentName === "string"
          ? params.purchasingAgentName
          : "",
    };
  }

  const stakeholders =
    (await allow(api.stakeholder.getStakeholders(), ["stakeholder", "read"])) ??
    [];
  const members = stakeholders
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));

  return (
    <div className="flex flex-col gap-y-4">
      <div>
        <h3 className="font-medium">New resolution</h3>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Choose the kind of resolution. Creating it saves a draft; nothing is
          signed or sent until you review and send it.
        </p>
      </div>
      <NewResolutionFlow
        base={`/${entity.publicId}/resolutions`}
        members={members}
        prefill={{ PURCHASE_ORDER: poPrefill }}
      />
    </div>
  );
}
