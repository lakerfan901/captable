"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { api } from "@/trpc/react";
import { zIsoDate } from "@/trpc/routers/llc-shared/schema";

const formSchema = z.object({
  date: zIsoDate,
  noticeSentOn: z.union([zIsoDate, z.literal("")]),
});
type FormValues = z.infer<typeof formSchema>;

export function OcdForm({
  operationsCommencementDate,
  ocdNoticeSentOn,
  today,
  extensionsApproved,
  canEdit,
}: {
  operationsCommencementDate: string | null;
  ocdNoticeSentOn: string | null;
  today: string;
  extensionsApproved: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      date: operationsCommencementDate ?? "",
      noticeSentOn: ocdNoticeSentOn ?? "",
    },
  });
  const mutation = api.llcTerm.setOperationsCommencementDate.useMutation({
    onSuccess: () => {
      toast.success("Operations Commencement Date saved.");
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const dateLocked =
    operationsCommencementDate !== null && extensionsApproved > 0;

  const onSubmit = async (values: FormValues) => {
    await mutation.mutateAsync({
      date: values.date,
      noticeSentOn: values.noticeSentOn === "" ? null : values.noticeSentOn,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Operations Commencement Date</CardTitle>
        <CardDescription>
          Section 1.21: the date operations commence. The Manager notifies the
          Members within ten business days; the Target Sale Date is its fifth
          anniversary (Section 2.4).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2"
          >
            <FormField
              control={form.control}
              name="date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Operations Commencement Date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      max={today}
                      disabled={!canEdit || dateLocked}
                      {...field}
                    />
                  </FormControl>
                  {dateLocked ? (
                    <FormDescription>
                      Cannot change after a term extension was approved.
                    </FormDescription>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="noticeSentOn"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notice to Members sent on (optional)</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      max={today}
                      disabled={!canEdit}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={!canEdit || mutation.isPending}
                loading={mutation.isPending}
              >
                Save
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
