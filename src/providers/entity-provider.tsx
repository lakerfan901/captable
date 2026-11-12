"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { getVocabulary } from "@/lib/vocabulary";

export type EntityContextValue = {
  entityType: "CORPORATION" | "LLC";
  isLlc: boolean;
  timezone: string;
  companyName: string;
};

const EntityContext = createContext<EntityContextValue | null>(null);

export function EntityProvider({
  value,
  children,
}: {
  value: EntityContextValue;
  children: ReactNode;
}) {
  return (
    <EntityContext.Provider value={value}>{children}</EntityContext.Provider>
  );
}

export function useEntity(): EntityContextValue {
  const ctx = useContext(EntityContext);
  if (!ctx) {
    throw new Error("useEntity must be used within an EntityProvider");
  }
  return ctx;
}

export function useVocabulary() {
  const { entityType } = useEntity();
  return useMemo(() => getVocabulary(entityType), [entityType]);
}
