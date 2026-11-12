"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useRef } from "react";
import { api } from "@/trpc/react";

type SwitchCompanyProps = {
  memberId: string;
  next: string;
};

export function SwitchCompany({ memberId, next }: SwitchCompanyProps) {
  const router = useRouter();
  const { update } = useSession();
  const switchCompany = api.company.switchCompany.useMutation();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      await switchCompany.mutateAsync({ id: memberId });
      await update();
      router.replace(next);
    })();
  }, [memberId, next, router, update, switchCompany]);

  return (
    <div className="flex min-h-screen items-center justify-center text-gray-600 text-sm">
      Switching company…
    </div>
  );
}
