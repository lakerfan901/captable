"use client";

import { RiAddFill } from "@remixicon/react";
import { pushModal } from "@/components/modals";
import { Button } from "@/components/ui/button";

type DocumentUploadButtonProps = {
  companyPublicId: string;
  buttonDisplayName: string;
};

export const DocumentUploadButton = ({
  companyPublicId,
  buttonDisplayName,
}: DocumentUploadButtonProps) => {
  return (
    <Button
      onClick={() => {
        pushModal("DocumentUploadModal", {
          companyPublicId,
        });
      }}
    >
      <RiAddFill className="mr-2 h-5 w-5" />
      {buttonDisplayName}
    </Button>
  );
};
