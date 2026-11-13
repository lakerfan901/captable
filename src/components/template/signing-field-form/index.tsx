"use client";

import { useRouter } from "next/navigation";
import type { ComponentProps, ReactNode } from "react";
import { useFormContext } from "react-hook-form";
import { toast } from "sonner";
import type { TemplateSigningFieldForm } from "@/providers/template-signing-field-provider";
import { api } from "@/trpc/react";

interface SigningFieldFormProps extends ComponentProps<"form"> {
  companyPublicId?: string;
  children: ReactNode;
  recipientId: string;
  templateId: string;
  token: string;
}

export function SigningFieldForm({
  companyPublicId,
  children,
  recipientId,
  templateId,
  token,
  ...rest
}: SigningFieldFormProps) {
  const { handleSubmit } = useFormContext<TemplateSigningFieldForm>();

  const router = useRouter();

  const { mutateAsync } = api.template.sign.useMutation({
    onSuccess(data) {
      toast.success("🎉 Great job, you are done signing this document.");

      // An investor who signed an Exhibit B packet goes on to upload a Form
      // W-9 (F12). The token is only ever in the path of this same-origin page.
      const w9Token = "w9Token" in data ? data.w9Token : undefined;
      if (w9Token) {
        router.push(`/w9/${w9Token}`);
      } else if (companyPublicId) {
        router.push(`/${companyPublicId}/documents`);
      } else {
        router.push("/");
      }
    },
  });
  const onSubmit = async (values: TemplateSigningFieldForm) => {
    await mutateAsync({
      data: values.fieldValues,
      recipientId,
      templateId,
      token,
    });
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex flex-col gap-y-4 px-2 py-10"
      {...rest}
    >
      {children}
    </form>
  );
}
