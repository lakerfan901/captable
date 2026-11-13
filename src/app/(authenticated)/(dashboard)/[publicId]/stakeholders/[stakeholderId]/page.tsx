import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EconomicsTab } from "@/components/llc/economics/member-economics-tab";
import { CommitmentsTab } from "@/components/llc/member/commitments-tab";
import { EmailsTab } from "@/components/llc/member/emails-tab";
import { MemberDocumentsTab } from "@/components/llc/member/member-documents-tab";
import { MemberFormDialog } from "@/components/llc/member/member-form-dialog";
import {
  InsiderBadge,
  MemberProfileCard,
  MemberStatusBadge,
} from "@/components/llc/member/member-profile-card";
import { Allow } from "@/components/rbac/allow";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Member",
};

const rethrowUnlessNotFound = (error: unknown): never => {
  if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
  throw error;
};

export default async function MemberPage(props: {
  params: Promise<{ stakeholderId: string }>;
}) {
  await requireLlc();
  const { stakeholderId } = await props.params;
  const { allow } = await serverAccessControl();

  // Thunks so a procedure the caller may not use is never called.
  const loadMember = allow(
    () =>
      api.stakeholder
        .getMember({ id: stakeholderId })
        .catch(rethrowUnlessNotFound),
    ["stakeholder", "read"],
  );
  const loadDocuments = allow(
    () =>
      api.stakeholder
        .memberDocuments({ stakeholderId })
        .catch(rethrowUnlessNotFound),
    ["documents", "read"],
  );

  const member = loadMember ? await loadMember() : null;

  if (!member) {
    return <UnAuthorizedState />;
  }

  const documents = loadDocuments ? await loadDocuments() : null;

  return (
    <div className="flex flex-col gap-y-3">
      <div className="flex items-center justify-between gap-y-3">
        <div className="flex flex-col gap-y-1">
          <h3 className="font-medium">{member.name}</h3>
          <div className="flex items-center gap-2">
            <MemberStatusBadge status={member.memberStatus} />
            {member.isInsider && <InsiderBadge />}
          </div>
        </div>
        <Allow subject="stakeholder" action="update">
          <MemberFormDialog
            member={member}
            trigger={<Button variant="outline">Edit</Button>}
          />
        </Allow>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="commitments">Commitments</TabsTrigger>
          <TabsTrigger value="economics">Economics</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="emails">Emails</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <MemberProfileCard member={member} />
        </TabsContent>
        <TabsContent value="commitments">
          <CommitmentsTab stakeholderId={member.id} />
        </TabsContent>
        <TabsContent value="economics">
          <EconomicsTab stakeholderId={member.id} />
        </TabsContent>
        <TabsContent value="documents">
          {documents ? (
            <MemberDocumentsTab
              stakeholderId={member.id}
              documents={documents}
            />
          ) : (
            <Alert>
              <AlertDescription>
                You do not have access to documents.
              </AlertDescription>
            </Alert>
          )}
        </TabsContent>
        <TabsContent value="emails">
          <EmailsTab stakeholderId={member.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
