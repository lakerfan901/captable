"use client";

import { useIsMutating } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { type ManagerOption, type PacketView, sanitizeView } from "./view";

export type { ManagerOption, PacketView };

// State shared by the sections of the Manager confirmation screen
// (01-foundation.md F13). The page loads `admission.get` on the server; the
// view held here is replaced by the view an `admission.*` mutation returns
// and re-synced from the server after every change (router.refresh), so each
// mutation sends back the latest `stakeholderVersion`, commitment id and
// ledger figures exactly as received.

type ErrorLike = { message: string; data?: { code?: string } | null };

type ReviewContextValue = {
  view: PacketView;
  companyPublicId: string;
  managers: ManagerOption[] | null;
  /** A mutation or the reload after it is running: every action is disabled. */
  busy: boolean;
  /** Re-reads the view from the server. */
  reload: () => void;
  /** Takes the view an `admission.*` mutation returned, then reloads. */
  applyView: (next: PacketView) => void;
  /**
   * Shows a server error. CONFLICT means the data changed: say so and reload.
   * Anything else (BAD_REQUEST, …): show the server's message.
   */
  onError: (error: ErrorLike) => void;
};

const ReviewContext = createContext<ReviewContextValue | null>(null);

export function useReview(): ReviewContextValue {
  const value = useContext(ReviewContext);
  if (!value) throw new Error("useReview outside ReviewProvider");
  return value;
}

export function ReviewProvider({
  initialView,
  companyPublicId,
  managers,
  canReadDocuments,
  children,
}: {
  initialView: PacketView;
  companyPublicId: string;
  managers: ManagerOption[] | null;
  canReadDocuments: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [view, setView] = useState(initialView);
  const [reloading, startReload] = useTransition();
  // Any pending mutation on the page (ours or a reused ledger dialog's).
  const mutating = useIsMutating() > 0;

  // A server refresh brings a new initial view: it wins.
  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  const reload = useCallback(() => {
    startReload(() => router.refresh());
  }, [router]);

  // Coming back from the signing page (browser Back) can restore a cached
  // view; read the current one so the stage, signer status and ledger
  // figures are fresh before the Manager prepares again.
  useEffect(() => {
    reload();
  }, [reload]);

  const applyView = useCallback(
    (next: PacketView) => {
      setView(sanitizeView(next, canReadDocuments));
      reload();
    },
    [canReadDocuments, reload],
  );

  const onError = useCallback(
    (error: ErrorLike) => {
      if (error.data?.code === "CONFLICT") {
        toast.error(error.message);
        reload();
        return;
      }
      toast.error(error.message);
    },
    [reload],
  );

  const value = useMemo(
    () => ({
      view,
      companyPublicId,
      managers,
      busy: mutating || reloading,
      reload,
      applyView,
      onError,
    }),
    [
      view,
      companyPublicId,
      managers,
      mutating,
      reloading,
      reload,
      applyView,
      onError,
    ],
  );

  return (
    <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>
  );
}
