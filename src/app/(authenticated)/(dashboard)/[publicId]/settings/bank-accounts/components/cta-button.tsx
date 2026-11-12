"use client";

import { RiAddLine } from "@remixicon/react";
import { pushModal } from "@/components/modals";
import { Button } from "@/components/ui/button";

const CtaButton = () => {
  return (
    <Button
      onClick={() => {
        pushModal("BankAccountModal", {
          title: "Add a bank account",
          subtitle: "Add a bank account to receive funds",
        });
      }}
    >
      <RiAddLine className="inline-block h-5 w-5" />
      Add a bank account
    </Button>
  );
};

export default CtaButton;
