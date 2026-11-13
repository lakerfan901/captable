import { LlcEconomicsWidgets } from "@/components/llc/economics/overview-widgets";

// biome-ignore lint/suspicious/useAwait: async server-component signature fixed by the plan (E19)
export default async function EconomicsSlot() {
  return <LlcEconomicsWidgets />;
}
