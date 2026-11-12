"use client";

import type { ReactNode } from "react";
import { useAllowed, type useAllowedOptions } from "@/hooks/use-allowed";

interface AllowProps extends useAllowedOptions {
  children: ReactNode | ((authorized: boolean) => ReactNode);
}

export const Allow = ({ children, ...rest }: AllowProps) => {
  const { isAllowed } = useAllowed({ ...rest });

  if (isAllowed) {
    if (typeof children === "function") {
      return children(isAllowed);
    }
    return children;
  }
  return null;
};
