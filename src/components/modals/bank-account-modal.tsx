"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import Modal from "@/components/common/push-modal";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/trpc/react";
import {
  type TypeZodCreateBankAccountSchema,
  ZodCreateBankAccountSchema,
} from "@/trpc/routers/bank-accounts/schema";
import { popModal } from ".";

type BankAccountModalProps = {
  title: string | React.ReactNode;
  subtitle: string | React.ReactNode;
};

type TextField = Exclude<
  keyof TypeZodCreateBankAccountSchema,
  "accountType" | "swiftCode"
>;

const TEXT_FIELDS: { name: TextField; label: string; secret?: boolean }[] = [
  { name: "beneficiaryName", label: "Beneficiary name" },
  { name: "beneficiaryAddress", label: "Beneficiary address" },
  { name: "bankName", label: "Bank name" },
  { name: "bankAddress", label: "Bank address" },
  { name: "accountNumber", label: "Account number", secret: true },
  { name: "routingNumber", label: "Routing number (ABA)" },
];

export const BankAccountModal = ({
  title,
  subtitle,
}: BankAccountModalProps) => {
  const router = useRouter();
  const form = useForm<TypeZodCreateBankAccountSchema>({
    resolver: zodResolver(ZodCreateBankAccountSchema),
    defaultValues: {
      beneficiaryName: "",
      beneficiaryAddress: "",
      bankName: "",
      bankAddress: "",
      accountNumber: "",
      routingNumber: "",
      accountType: "CHECKING",
      swiftCode: undefined,
    },
  });

  const create = api.bankAccounts.create.useMutation({
    onSuccess: () => {
      toast.success("Bank account added.");
      form.reset();
      popModal("BankAccountModal");
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const onSubmit = async (values: TypeZodCreateBankAccountSchema) => {
    await create.mutateAsync(values).catch(() => undefined);
  };

  return (
    <Modal size="xl" title={title} subtitle={subtitle}>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        >
          {TEXT_FIELDS.map((f) => (
            <FormField
              key={f.name}
              control={form.control}
              name={f.name}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{f.label}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage className="text-xs font-light" />
                </FormItem>
              )}
            />
          ))}

          <FormField
            control={form.control}
            name="accountType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Account type</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="CHECKING">Checking</SelectItem>
                    <SelectItem value="SAVINGS">Savings</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage className="text-xs font-light" />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="swiftCode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>SWIFT / BIC (optional)</FormLabel>
                <FormControl>
                  <Input
                    autoComplete="off"
                    value={field.value ?? ""}
                    onChange={(e) => {
                      const v = e.target.value.toUpperCase();
                      field.onChange(v === "" ? undefined : v);
                    }}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                </FormControl>
                <FormMessage className="text-xs font-light" />
              </FormItem>
            )}
          />

          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" loading={form.formState.isSubmitting}>
              Add bank account
            </Button>
          </div>
        </form>
      </Form>
    </Modal>
  );
};
