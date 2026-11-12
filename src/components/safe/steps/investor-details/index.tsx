"use client";

import { api } from "@/trpc/react";
import { InvestorDetailsForm } from "./form";

export type { TFormSchema } from "./form";

// Rendered inside the client-side SAFE modals, so it fetches through the
// React tRPC client (it used to be a "use server" module, which exposed it
// as a publicly callable Server Action).
export function InvestorDetails() {
  const { data: stakeholders } = api.stakeholder.getStakeholders.useQuery();
  return <InvestorDetailsForm stakeholders={stakeholders ?? []} />;
}
