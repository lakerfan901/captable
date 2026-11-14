"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  buildLockedClauses,
  buildRequirements,
  describeRequirements,
  type ResolutionType,
} from "@/lib/governance/presets";
import { api } from "@/trpc/react";
import {
  type PresetMember,
  ResolutionPresetForm,
} from "./resolution-preset-form";
import { RESOLUTION_TYPE_LABEL } from "./resolution-table";
import { RichTextEditorLazy } from "./rich-text-editor-lazy";
import { SendDialog } from "./send-dialog";
import { StatusBadge } from "./status-badge";

// Draft editor (03-governance.md G10, session b).

type Params = Record<string, unknown>;

/** Locked clauses and requirement sentence; null while params do not validate. */
export function lockedPreview(
  type: ResolutionType,
  params: Params,
  companyName: string,
): { clauses: string[]; requirements: string } | null {
  try {
    return {
      clauses: buildLockedClauses(type, params, { companyName }),
      requirements: describeRequirements(buildRequirements(type, params)),
    };
  } catch {
    return null;
  }
}

export interface ResolutionDraftEditorProps {
  base: string;
  companyName: string;
  publicId: string;
  type: ResolutionType;
  title: string;
  params: Params;
  body: unknown[];
  members: PresetMember[];
  canEdit: boolean;
  canDelete: boolean;
  mailCatcher: boolean;
  defaultSignerName: string;
  /** Company time zone (record date and deadline are measured in it). */
  timeZone: string;
}

export function ResolutionDraftEditor({
  base,
  companyName,
  publicId,
  type,
  title: initialTitle,
  params: initialParams,
  body: initialBody,
  members,
  canEdit,
  canDelete,
  mailCatcher,
  defaultSignerName,
  timeZone,
}: ResolutionDraftEditorProps) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [params, setParams] = useState<Params>(initialParams);
  // Bumped when the server replaced the params (remounts the details form).
  const [paramsVersion, setParamsVersion] = useState(0);
  const [paramsValid, setParamsValid] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  // The editor reports on every change; keep the latest blocks in a ref so
  // typing does not re-render the whole page.
  const bodyRef = useRef<unknown[]>(initialBody);

  const update = api.resolution.update.useMutation();
  const utils = api.useUtils();
  const remove = api.resolution.delete.useMutation();

  const locked = useMemo(
    () => lockedPreview(type, params, companyName),
    [type, params, companyName],
  );

  const onParamsChange = useCallback((next: Params, valid: boolean) => {
    setParams(next);
    setParamsValid(valid);
  }, []);
  const onBodyChange = useCallback((blocks: unknown[]) => {
    bodyRef.current = blocks;
  }, []);

  const save = async (): Promise<boolean> => {
    if (title.trim() === "") {
      toast.error("Give the resolution a title.");
      return false;
    }
    if (!paramsValid) {
      setDetailsOpen(true);
      toast.error("Complete the details before saving.");
      return false;
    }
    try {
      const saved = await update.mutateAsync({
        publicId,
        title: title.trim(),
        params,
        body: bodyRef.current,
      });
      // A term extension's dates and title are set by the server from the
      // term clock: show (and send) what it stored.
      if (saved.title !== undefined) setTitle(saved.title);
      if (saved.params !== undefined) {
        setParams(saved.params as Params);
        setParamsVersion((v) => v + 1);
      }
      // The send dialog's blockers read the stored text (placeholders).
      void utils.resolution.preview.invalidate();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const onSave = async () => {
    if (await save()) {
      toast.success("Draft saved.");
      router.refresh();
    }
  };

  const onReviewAndSend = async () => {
    if (await save()) setSendOpen(true);
  };

  const onDelete = async () => {
    try {
      await remove.mutateAsync({ publicId });
      toast.success("Draft deleted.");
      router.push(base);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = update.isPending || remove.isPending;

  return (
    <div className="flex flex-col gap-4">
      <Link href={base} className="text-sm text-muted-foreground">
        ← Resolutions
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Title"
          className="max-w-2xl flex-1 font-medium"
          value={title}
          maxLength={200}
          disabled={!canEdit || type === "TERM_EXTENSION"}
          title={
            type === "TERM_EXTENSION"
              ? "Set from the term clock: it states the extended Target Sale Date."
              : undefined
          }
          onChange={(e) => setTitle(e.target.value)}
        />
        <StatusBadge status="DRAFT" />
        <span className="text-sm text-muted-foreground">
          {RESOLUTION_TYPE_LABEL[type]}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Text</CardTitle>
          </CardHeader>
          <CardContent>
            <RichTextEditorLazy
              initialBlocks={initialBody}
              onChange={onBodyChange}
              editable={canEdit}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Details</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDetailsOpen((o) => !o)}
              >
                {detailsOpen ? "Hide" : "Show"}
              </Button>
            </CardHeader>
            {/* Kept mounted so edits survive collapsing. */}
            <CardContent className={detailsOpen ? undefined : "hidden"}>
              <ResolutionPresetForm
                key={paramsVersion}
                type={type}
                defaultValues={paramsVersion === 0 ? initialParams : params}
                members={members}
                disabled={!canEdit}
                onChange={onParamsChange}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Locked text</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p className="text-muted-foreground">
                This text is added automatically and cannot be edited
              </p>
              {locked ? (
                <ol className="list-decimal space-y-1 pl-5">
                  {locked.clauses.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ol>
              ) : (
                <p className="text-destructive">
                  Complete the details to see the locked text.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Approval required</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {locked ? locked.requirements : "—"}
            </CardContent>
          </Card>
        </div>
      </div>

      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={onSave}
            loading={update.isPending}
            disabled={busy}
          >
            Save draft
          </Button>
          {canDelete ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={busy}>
                  Delete draft
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Nothing has been sent. The draft is removed and cannot be
                    recovered.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete}>
                    Delete draft
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
          <Button onClick={onReviewAndSend} disabled={busy}>
            Review and send
          </Button>
        </div>
      ) : null}

      {sendOpen ? (
        <SendDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          publicId={publicId}
          type={type}
          params={params}
          mailCatcher={mailCatcher}
          defaultSignerName={defaultSignerName}
          timeZone={timeZone}
        />
      ) : null}
    </div>
  );
}
