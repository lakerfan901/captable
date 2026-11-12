"use client";

import {
  createContext,
  type Dispatch,
  type ReactNode,
  useContext,
  useReducer,
} from "react";
import type { FileWithPath } from "react-dropzone";
import { invariant } from "@/lib/error";

interface EsignFormProviderProps {
  children: ReactNode;
}

const EsignFormProviderContext = createContext<{
  value: Value;
  setValue: Dispatch<Partial<Value>>;
} | null>(null);

type Value = {
  recipients: {
    email: string;
    name?: string;
  }[];
  orderedDelivery: boolean;
  document: FileWithPath[];
};

export function EsignFormProvider({ children }: EsignFormProviderProps) {
  const [value, setValue] = useReducer(
    (data: Value, partialData: Partial<Value>) => ({ ...data, ...partialData }),
    {} as Value,
  );

  return (
    <EsignFormProviderContext.Provider value={{ value, setValue }}>
      {children}
    </EsignFormProviderContext.Provider>
  );
}

export const useEsignValues = () => {
  const data = useContext(EsignFormProviderContext);

  invariant(
    data,
    "useEsignValues must be used within EsignFormProviderContext",
  );

  return data;
};
