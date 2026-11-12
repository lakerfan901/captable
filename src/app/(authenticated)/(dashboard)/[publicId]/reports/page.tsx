import { RiFilePdf2Fill } from "@remixicon/react";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { ComingSoon } from "@/components/llc/coming-soon";
import { Button } from "@/components/ui/button";
import { getSessionEntity } from "@/server/entity";

export const metadata: Metadata = {
  title: "Reports",
};

const ReportsPage = async () => {
  if ((await getSessionEntity()).isLlc) {
    return <ComingSoon title="Member reports" owner="GOVERNANCE" />;
  }

  return (
    <EmptyState
      icon={<RiFilePdf2Fill />}
      title="No reports available."
      subtitle="Please click the button below to generate a report"
    >
      <Button>Coming soon...</Button>
    </EmptyState>
  );
};

export default ReportsPage;
