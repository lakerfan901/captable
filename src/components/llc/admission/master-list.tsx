"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Allow } from "@/components/rbac/allow";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";

// Exhibit B masters (01-foundation.md F12): uploaded once, fields placed in
// the existing e-sign editor, then cloned into one packet per investor.

export type MasterRow = RouterOutputs["admission"]["masters"][number];

function ArchiveMasterDialog({
  master,
  open,
  onOpenChange,
}: {
  master: MasterRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { mutate, isPending } = api.admission.archiveMaster.useMutation({
    onSuccess: () => {
      toast.success("Master archived.");
      onOpenChange(false);
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive master</DialogTitle>
          <DialogDescription>
            “{master.name}” will no longer be offered when sending a
            subscription. Packets already sent from it are not affected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep
          </Button>
          <Button
            variant="destructive"
            loading={isPending}
            onClick={() => mutate({ publicId: master.publicId })}
          >
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MasterActions({
  master,
  companyPublicId,
}: {
  master: MasterRow;
  companyPublicId: string;
}) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  return (
    <div className="flex justify-end gap-2">
      <Allow action="update" subject="commitments">
        <Link
          href={`/${companyPublicId}/documents/esign/${master.publicId}`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Edit fields
        </Link>
      </Allow>
      <Allow action="delete" subject="commitments">
        <Button variant="ghost" size="sm" onClick={() => setArchiveOpen(true)}>
          Archive
        </Button>
        <ArchiveMasterDialog
          master={master}
          open={archiveOpen}
          onOpenChange={setArchiveOpen}
        />
      </Allow>
    </div>
  );
}

export function MasterList({
  masters,
  companyPublicId,
}: {
  masters: MasterRow[];
  companyPublicId: string;
}) {
  return (
    <div className="w-full p-6">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Fields</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {masters.map((master) => (
            <TableRow key={master.publicId}>
              <TableCell className="font-medium">{master.name}</TableCell>
              <TableCell className="tabular-nums">
                {master.fieldCount}
              </TableCell>
              <TableCell>
                {master.ready ? (
                  <Badge variant="success">Ready</Badge>
                ) : (
                  <span className="text-sm text-amber-700">
                    Missing: {master.missingKeys.join(", ")}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <MasterActions
                  master={master}
                  companyPublicId={companyPublicId}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
