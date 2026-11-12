import { createTRPCRouter } from "@/trpc/api/trpc";

import { addStakeholdersProcedure } from "./procedures/add-stakeholders";
import { attachDocumentProcedure } from "./procedures/attach-document";
import { createMemberProcedure } from "./procedures/create-member";
import { getMemberProcedure } from "./procedures/get-member";
import { getStakeholdersProcedure } from "./procedures/get-stakeholders";
import { importExhibitAProcedure } from "./procedures/import-exhibit-a";
import { memberDocumentsProcedure } from "./procedures/member-documents";
import { setMemberStatusProcedure } from "./procedures/set-member-status";
import { updateMemberProcedure } from "./procedures/update-member";
import { updateStakeholderProcedure } from "./procedures/update-stakeholder";

export const stakeholderRouter = createTRPCRouter({
  addStakeholders: addStakeholdersProcedure,
  getStakeholders: getStakeholdersProcedure,
  updateStakeholder: updateStakeholderProcedure,
  getMember: getMemberProcedure,
  createMember: createMemberProcedure,
  updateMember: updateMemberProcedure,
  setMemberStatus: setMemberStatusProcedure,
  memberDocuments: memberDocumentsProcedure,
  attachDocument: attachDocumentProcedure,
  importExhibitA: importExhibitAProcedure,
});
