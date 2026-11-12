"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { type Control, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
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
import states from "@/lib/states";
import { api } from "@/trpc/react";
import {
  ACCREDITATION_BASES,
  HOLDER_TYPES,
  type MemberDTO,
} from "@/trpc/routers/stakeholder-router/member-schema";
import {
  ACCREDITATION_LABELS,
  HOLDER_TYPE_LABELS,
} from "./member-profile-card";

const optionalEmail = z
  .string()
  .trim()
  .refine((v) => v === "" || z.string().email().safeParse(v).success, {
    message: "Invalid email",
  });

const formSchema = z
  .object({
    name: z.string().trim().min(1, "Required").max(200),
    email: z.string().trim().email(),
    holderType: z.enum(HOLDER_TYPES),
    residenceState: z.string(),
    accreditationBasis: z.string(),
    signerName: z.string().trim().max(120),
    signerTitle: z.string().trim().max(120),
    noticeEmail: optionalEmail,
    phone: z.string().trim().max(40),
    streetAddress: z.string(),
    city: z.string(),
    state: z.string(),
    zipcode: z.string(),
    isInsider: z.boolean(),
  })
  .refine(
    (v) =>
      !(v.holderType === "TRUST" || v.holderType === "ENTITY") ||
      v.signerName.length > 0,
    {
      message: "Signer name is required for trusts and entities",
      path: ["signerName"],
    },
  );

type FormValues = z.infer<typeof formSchema>;

const toDefaults = (m?: MemberDTO): FormValues => ({
  name: m?.name ?? "",
  email: m?.email ?? "",
  holderType: m?.holderType ?? "INDIVIDUAL",
  residenceState: m?.residenceState ?? "",
  accreditationBasis: m?.accreditationBasis ?? "",
  signerName: m?.signerName ?? "",
  signerTitle: m?.signerTitle ?? "",
  noticeEmail: m?.noticeEmail ?? "",
  phone: m?.phone ?? "",
  streetAddress: m?.streetAddress ?? "",
  city: m?.city ?? "",
  state: m?.state ?? "",
  zipcode: m?.zipcode ?? "",
  isInsider: m?.isInsider ?? false,
});

const opt = (v: string) => {
  const t = v.trim();
  return t === "" ? undefined : t;
};

function TextField({
  control,
  name,
  label,
  type,
}: {
  control: Control<FormValues>;
  name:
    | "name"
    | "email"
    | "signerName"
    | "signerTitle"
    | "noticeEmail"
    | "phone"
    | "streetAddress"
    | "city"
    | "zipcode";
  label: string;
  type?: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input type={type} {...field} />
          </FormControl>
          <FormMessage className="text-xs font-light" />
        </FormItem>
      )}
    />
  );
}

function StateField({
  control,
  name,
  label,
}: {
  control: Control<FormValues>;
  name: "residenceState" | "state";
  label: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select
            value={field.value || undefined}
            onValueChange={field.onChange}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder="Select a state" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {states.map((s) => (
                <SelectItem key={s.abbreviation} value={s.abbreviation}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage className="text-xs font-light" />
        </FormItem>
      )}
    />
  );
}

export function MemberFormDialog({
  member,
  trigger,
}: {
  member?: MemberDTO;
  trigger: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = !!member;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: toDefaults(member),
  });
  const holderType = useWatch({ control: form.control, name: "holderType" });
  const needsSigner = holderType === "TRUST" || holderType === "ENTITY";

  const onSuccess = () => {
    toast.success(isEdit ? "Member updated." : "Member added.");
    setOpen(false);
    if (!isEdit) form.reset(toDefaults());
    router.refresh();
  };
  const onError = (error: { message: string }) => toast.error(error.message);

  const createMutation = api.stakeholder.createMember.useMutation({
    onSuccess,
    onError,
  });
  const updateMutation = api.stakeholder.updateMember.useMutation({
    onSuccess,
    onError,
  });
  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = async (v: FormValues) => {
    const payload = {
      name: v.name,
      email: v.email,
      holderType: v.holderType,
      residenceState: opt(v.residenceState),
      accreditationBasis: opt(v.accreditationBasis) as
        | (typeof ACCREDITATION_BASES)[number]
        | undefined,
      signerName: opt(v.signerName),
      signerTitle: opt(v.signerTitle),
      noticeEmail: opt(v.noticeEmail),
      phone: opt(v.phone),
      streetAddress: opt(v.streetAddress),
      city: opt(v.city),
      state: opt(v.state),
      zipcode: opt(v.zipcode),
      isInsider: v.isInsider,
    };
    if (member) {
      await updateMutation.mutateAsync({ id: member.id, ...payload });
    } else {
      await createMutation.mutateAsync(payload);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) form.reset(toDefaults(member));
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit member" : "Add member"}</DialogTitle>
          <DialogDescription>
            Details as given on the signature page (Exhibit B).
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-5"
          >
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="name"
                label="Legal name"
              />
              <TextField
                control={form.control}
                name="email"
                label="Email"
                type="email"
              />
              <FormField
                control={form.control}
                name="holderType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {HOLDER_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {HOLDER_TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage className="text-xs font-light" />
                  </FormItem>
                )}
              />
              <StateField
                control={form.control}
                name="residenceState"
                label="State of residence (or formation)"
              />
              <div className="sm:col-span-2">
                <FormField
                  control={form.control}
                  name="accreditationBasis"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Accreditation basis</FormLabel>
                      <Select
                        value={field.value || undefined}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a basis" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {ACCREDITATION_BASES.map((b) => (
                            <SelectItem key={b} value={b}>
                              {ACCREDITATION_LABELS[b]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription className="text-xs">
                        Net worth / income / license bases apply to individuals;
                        entity bases to entities; the trust basis to trusts.
                      </FormDescription>
                      <FormMessage className="text-xs font-light" />
                    </FormItem>
                  )}
                />
              </div>
              <TextField
                control={form.control}
                name="signerName"
                label={needsSigner ? "Signer name" : "Signer name (optional)"}
              />
              <TextField
                control={form.control}
                name="signerTitle"
                label="Signer title"
              />
              <TextField
                control={form.control}
                name="noticeEmail"
                label="Notice email (if different)"
                type="email"
              />
              <TextField control={form.control} name="phone" label="Phone" />
              <div className="sm:col-span-2">
                <TextField
                  control={form.control}
                  name="streetAddress"
                  label="Street address"
                />
              </div>
              <TextField control={form.control} name="city" label="City" />
              <StateField control={form.control} name="state" label="State" />
              <TextField
                control={form.control}
                name="zipcode"
                label="ZIP code"
              />
              <FormField
                control={form.control}
                name="isInsider"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-2 self-end">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(c) => field.onChange(c === true)}
                      />
                    </FormControl>
                    <FormLabel className="!mt-0">
                      Insider (not Disinterested, Section 1.18)
                    </FormLabel>
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={isPending} loading={isPending}>
                {isEdit ? "Save" : "Add member"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
