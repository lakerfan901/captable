import { createTRPCRouter } from "@/trpc/api/trpc";
import { archiveMasterProcedure } from "./procedures/archive-master";
import { cancelProcedure } from "./procedures/cancel";
import { confirmDetailsProcedure } from "./procedures/confirm-details";
import { createMasterProcedure } from "./procedures/create-master";
import { getPacketProcedure } from "./procedures/get-packet";
import { listProcedure } from "./procedures/list";
import { mastersProcedure } from "./procedures/masters";
import { prepareCountersignProcedure } from "./procedures/prepare-countersign";
import { reassignManagerProcedure } from "./procedures/reassign-manager";
import { rejectPacketProcedure } from "./procedures/reject-packet";
import { resendProcedure } from "./procedures/resend";
import { sendProcedure } from "./procedures/send";
import {
  w9CompleteProcedure,
  w9InfoProcedure,
  w9UploadUrlProcedure,
} from "./procedures/w9";

// Exhibit B packets (01-foundation.md F12). Team procedures use
// `withLlcAccessControl` with the `commitments` subject; the three W-9
// procedures are public and gated by the W-9 link token only. F13 adds the
// Manager confirmation screen: get, confirmDetails, reject, reassignManager
// and prepareCountersign (accept / reduce and receipts use `commitment.*`).
export const admissionRouter = createTRPCRouter({
  masters: mastersProcedure,
  createMaster: createMasterProcedure,
  archiveMaster: archiveMasterProcedure,
  send: sendProcedure,
  list: listProcedure,
  cancel: cancelProcedure,
  resend: resendProcedure,
  get: getPacketProcedure,
  confirmDetails: confirmDetailsProcedure,
  reject: rejectPacketProcedure,
  reassignManager: reassignManagerProcedure,
  prepareCountersign: prepareCountersignProcedure,
  w9Info: w9InfoProcedure,
  w9UploadUrl: w9UploadUrlProcedure,
  w9Complete: w9CompleteProcedure,
});
