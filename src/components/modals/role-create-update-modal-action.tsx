"use client";

import type { ComponentProps } from "react";
import { Button } from "../ui/button";
import { pushModal } from ".";

// Kept apart from role-create-update-modal.tsx: importing the action from
// that file made it the entry of an import cycle with ./index, which then
// read RoleCreateUpdateModal before it was initialized and crashed the page.

interface RoleCreateUpdateModalActionProps extends ComponentProps<"button"> {}

export const RoleCreateUpdateModalAction = (
  props: RoleCreateUpdateModalActionProps,
) => {
  return (
    <Button
      {...props}
      onClick={() => {
        pushModal("RoleCreateUpdate", {
          title: "Create a role",
          type: "create",
        });
      }}
    >
      Create a role
    </Button>
  );
};
