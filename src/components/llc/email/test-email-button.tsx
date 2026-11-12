"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/trpc/react";

export function TestEmailButton() {
  const router = useRouter();
  const utils = api.useUtils();
  const [to, setTo] = useState("");

  const { mutate, isPending } = api.emailLog.sendTest.useMutation({
    onSuccess: async () => {
      toast.success(`Test email sent to ${to}.`);
      await utils.emailLog.list.invalidate();
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!to.trim()) return;
        mutate({ to: to.trim() });
      }}
    >
      <Input
        type="email"
        required
        placeholder="name@example.com"
        aria-label="Test email address"
        className="w-64"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      />
      <Button type="submit" loading={isPending} disabled={!to.trim()}>
        Send test email
      </Button>
    </form>
  );
}
