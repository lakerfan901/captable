"use client";

import { RiDeleteBinLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/trpc/react";
import { maskAccountNumber } from "@/trpc/routers/bank-accounts/schema";

export type BankAccountRow = {
  id: string;
  bankName: string;
  beneficiaryName: string;
  accountNumber: string;
  routingNumber: string;
  primary: boolean;
};

const BankAccountsTable = ({ accounts }: { accounts: BankAccountRow[] }) => {
  const router = useRouter();
  const remove = api.bankAccounts.delete.useMutation({
    onSuccess: () => {
      toast.success("Bank account deleted.");
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Bank</TableHead>
            <TableHead>Beneficiary</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Routing number</TableHead>
            <TableHead />
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((account) => (
            <TableRow key={account.id}>
              <TableCell className="font-medium">{account.bankName}</TableCell>
              <TableCell>{account.beneficiaryName}</TableCell>
              <TableCell className="font-mono">
                {maskAccountNumber(account.accountNumber)}
              </TableCell>
              <TableCell className="font-mono">
                {account.routingNumber}
              </TableCell>
              <TableCell>
                {account.primary ? <Badge>Primary</Badge> : null}
              </TableCell>
              <TableCell className="text-right">
                <ConfirmDialog
                  title="Delete bank account?"
                  body={`${account.bankName} ${maskAccountNumber(account.accountNumber)} will be removed.`}
                  trigger={
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={remove.isPending}
                      aria-label="Delete bank account"
                    >
                      <RiDeleteBinLine className="h-4 w-4" />
                    </Button>
                  }
                  onConfirm={() => remove.mutate({ id: account.id })}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

export default BankAccountsTable;
