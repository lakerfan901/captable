import type { DataRoom } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { generatePublicId } from "@/common/id";
import { env } from "@/env";
import { shareDataRoomEmailJob } from "@/jobs/share-data-room-email";
import { encode } from "@/lib/jwt";
import { ShareRecipientSchema } from "@/schema/contacts";
import { Audit } from "@/server/audit";
import { checkMembership } from "@/server/auth";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { createTRPCRouter, withAuth } from "@/trpc/api/trpc";
import { DataRoomSchema } from "./schema";

export const dataRoomRouter = createTRPCRouter({
  getDataRoom: withAuth
    .input(
      z.object({
        dataRoomPublicId: z.string(),
        include: z.object({
          company: z.boolean().optional().default(false),
          documents: z.boolean().optional().default(false),
          recipients: z.boolean().optional().default(false),
        }),
      }),
    )
    .query(async ({ ctx, input }) => {
      const response = {
        dataRoom: {},
        documents: [],
        recipients: [],
        company: {},
      } as {
        dataRoom: object;
        documents: object[];
        recipients: object[];
        company: object;
      };

      const { db, session } = ctx;
      const { dataRoomPublicId, include } = input;

      const { dataRoom } = await db.$transaction(async (tx) => {
        const { companyId } = await checkMembership({ session, tx });

        const dataRoom = await tx.dataRoom.findUniqueOrThrow({
          where: {
            publicId: dataRoomPublicId,
            companyId,
          },
          include: {
            documents: include.documents,
            company: include.company,
            recipients: include.recipients,
          },
        });

        response.dataRoom = dataRoom;

        if (include.documents) {
          const documentIds = dataRoom.documents.map((doc) => doc.id);

          const dataRoomDocument = await tx.dataRoomDocument.findMany({
            where: {
              id: { in: documentIds },
              dataRoomId: dataRoom.id,
              document: { companyId },
            },

            include: {
              document: {
                select: {
                  id: true,
                  bucket: true,
                },
              },
            },
          });

          response.documents = dataRoomDocument.map((doc) => ({
            id: doc.document.bucket.id,
            name: doc.document.bucket.name,
            key: doc.document.bucket.key,
            mimeType: doc.document.bucket.mimeType,
            size: doc.document.bucket.size,
            createdAt: doc.document.bucket.createdAt,
            updatedAt: doc.document.bucket.updatedAt,
          }));
        }

        if (include.recipients) {
          response.recipients = await Promise.all(
            dataRoom.recipients.map(async (recipient) => ({
              ...recipient,
              token: await encode({
                companyId,
                dataRoomId: dataRoom.id,
                recipientId: recipient.id,
              }),
            })),
          );
        }

        return { dataRoom };
      });

      if (include.company) {
        response.company = dataRoom.company;
      }

      return response;
    }),

  save: withAuth.input(DataRoomSchema).mutation(async ({ ctx, input }) => {
    try {
      let room = {} as DataRoom;
      const { db, session, userAgent, requestIp } = ctx;

      const { publicId } = input;

      await db.$transaction(async (tx) => {
        const { companyId } = await checkMembership({ tx, session });
        const { user } = session;
        if (!publicId) {
          room = await tx.dataRoom.create({
            data: {
              name: input.name,
              companyId,
              publicId: generatePublicId(),
            },
          });

          await Audit.create(
            {
              action: "dataroom.created",
              companyId: user.companyId,
              actor: { type: "user", id: user.id },
              context: {
                userAgent,
                requestIp,
              },
              target: [{ type: "dataroom", id: room.id }],
              summary: `${user.name} created the data room ${room.name}`,
            },
            tx,
          );
        } else {
          const { documents, recipients } = input;

          await assertCompanyOwns(tx, companyId, {
            documentIds: documents?.map((document) => document.documentId),
            memberIds: recipients?.map((recipient) => recipient.memberId),
            stakeholderIds: recipients?.map(
              (recipient) => recipient.stakeholderId,
            ),
          });

          const existing = await tx.dataRoom.findFirst({
            where: { publicId, companyId },
            select: { id: true },
          });

          if (!existing) {
            throw new TRPCError({ code: "NOT_FOUND" });
          }

          room = await tx.dataRoom.update({
            where: {
              id: existing.id,
              companyId,
            },
            data: {
              name: input.name,
            },
          });

          await Audit.create(
            {
              action: "dataroom.updated",
              companyId: user.companyId,
              actor: { type: "user", id: user.id },
              context: {
                userAgent,
                requestIp,
              },
              target: [{ type: "dataroom", id: room.id }],
              summary: `${user.name} updated the data room ${room.name}`,
            },
            tx,
          );

          if (documents) {
            await tx.dataRoomDocument.createMany({
              data: documents.map((document) => ({
                dataRoomId: room.id,
                documentId: document.documentId,
              })),
            });
          }

          if (recipients) {
            await tx.dataRoomRecipient.createMany({
              data: recipients.map((recipient) => ({
                dataRoomId: room.id,
                email: recipient.email,
                memberId: recipient.memberId,
                stakeholderId: recipient.stakeholderId,
                expiresAt: recipient.expiresAt,
              })),
            });
          }
        }
      });

      return {
        success: true,
        message: "Successfully updated data room",
        data: room,
      };
    } catch (error) {
      if (error instanceof TRPCError) {
        throw error;
      }
      console.error(error);
      return {
        success: false,
        message:
          "Oops, something went wrong while saving data room. Please try again.",
      };
    }
  }),

  share: withAuth
    .input(
      z.object({
        dataRoomId: z.string(),
        others: z.array(ShareRecipientSchema),
        selectedContacts: z.array(ShareRecipientSchema),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { session, db, requestIp, userAgent } = ctx;
      const { dataRoomId, others, selectedContacts } = input;
      const { name: senderName, email: senderEmail } = session.user;
      const { user } = session;
      const { companyId } = await checkMembership({ session, tx: db });
      const dataRoom = await db.dataRoom.findUniqueOrThrow({
        where: {
          id: dataRoomId,
          companyId,
        },

        include: {
          company: true,
        },
      });

      if (!dataRoom) {
        throw new Error("Data room not found");
      }

      const company = dataRoom.company;

      // Recipient member/stakeholder ids come from the client.
      const allRecipients = [...others, ...selectedContacts];
      await assertCompanyOwns(db, companyId, {
        memberIds: allRecipients
          .filter((recipient) => recipient.type === "member")
          .map((recipient) => recipient.id),
        stakeholderIds: allRecipients
          .filter((recipient) => recipient.type === "stakeholder")
          .map((recipient) => recipient.id),
      });

      const upsertManyRecipients = async () => {
        const baseUrl = env.NEXT_PUBLIC_BASE_URL;
        const recipients = [...others, ...selectedContacts];

        for (const recipient of recipients) {
          const email = (recipient.email || recipient.value).trim();
          if (!email) {
            throw new Error("Email is required");
          }

          const memberOrStakeholderId =
            recipient.type === "member"
              ? { memberId: recipient.id }
              : recipient.type === "stakeholder"
                ? { stakeholderId: recipient.id }
                : {};

          const { recipientRecord } = await db.$transaction(async (tx) => {
            const recipientRecord = await tx.dataRoomRecipient.upsert({
              where: {
                dataRoomId_email: {
                  dataRoomId,
                  email,
                },
              },
              create: {
                dataRoomId,
                name: recipient.name,
                email,
                ...memberOrStakeholderId,
              },
              update: {
                name: recipient.name,
                ...memberOrStakeholderId,
              },
            });
            return { recipientRecord };
          });

          const token = await encode({
            companyId,
            dataRoomId,
            recipientId: recipientRecord.id,
          });

          const link = `${baseUrl}/data-rooms/${dataRoom.publicId}?token=${token}`;

          await shareDataRoomEmailJob.emit({
            senderName: `${senderName}`,
            recipientName: recipient.name,
            companyName: company.name,
            dataRoom: dataRoom.name,
            link,
            email,
            senderEmail,
            companyId,
          });

          await db.$transaction(async (tx) => {
            await Audit.create(
              {
                action: "dataroom.shared",
                companyId: user.companyId,
                actor: { type: "user", id: user.id },
                context: {
                  userAgent,
                  requestIp,
                },
                target: [{ type: "dataroom", id: dataRoom.id }],
                summary: `${user.name} shared the data room ${dataRoom.name}`,
              },
              tx,
            );
          });
        }
      };

      await upsertManyRecipients();

      return {
        success: true,
        message: "Data room successfully shared!",
      };
    }),

  unShare: withAuth
    .input(
      z.object({
        dataRoomId: z.string(),
        recipientId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { session, db, requestIp, userAgent } = ctx;
      const { dataRoomId, recipientId } = input;
      const { companyId } = await checkMembership({ session, tx: db });
      const { user } = session;
      const dataRoom = await db.dataRoom.findUniqueOrThrow({
        where: {
          id: dataRoomId,
          companyId,
        },
      });

      if (!dataRoom) {
        throw new Error("Data room not found");
      }

      await db.$transaction(async (tx) => {
        await tx.dataRoomRecipient.delete({
          where: {
            id: recipientId,
            dataRoomId,
          },
        });

        await Audit.create(
          {
            action: "dataroom.deleted",
            companyId: user.companyId,
            actor: { type: "user", id: user.id },
            context: {
              userAgent,
              requestIp,
            },
            target: [{ type: "dataroom", id: dataRoom.id }],
            summary: `${user.name} deleted the data room ${dataRoom.name}`,
          },
          tx,
        );
      });

      return {
        success: true,
        message: "Successfully removed access to data room!",
      };
    }),
});
