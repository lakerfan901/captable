import { type ReactNode, createContext, useContext } from "react";

import type { ReactTable, RowData } from "@tanstack/react-table";
import type { DataTableFeatures } from "./features";

interface DataTableRootProps<TData extends RowData> {
  children: ReactNode;
  table: ReactTable<DataTableFeatures, TData>;
}

interface TDataTableContext<TData extends RowData> {
  table: ReactTable<DataTableFeatures, TData>;
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
type AnyDataTableContext = TDataTableContext<any>;

const dataTableContext = createContext<AnyDataTableContext | null>(null);

export const useDataTable = () => {
  const context = useContext(dataTableContext);

  if (!context) {
    throw new Error("useDataTable should be called inside DataTable");
  }

  return context;
};

export function DataTable<TData extends RowData>({
  children,
  table,
}: DataTableRootProps<TData>) {
  return (
    // TanStack Table v9 types are invariant in TData; the shared context is
    // untyped (like before), so widen the table at this boundary.
    <dataTableContext.Provider
      value={{ table: table as unknown as AnyDataTableContext["table"] }}
    >
      {children}
    </dataTableContext.Provider>
  );
}
