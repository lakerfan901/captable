import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isValidTimeZone } from "@/lib/date-only";
import { Audit } from "@/server/audit";
import { ensureDefaultUnitClasses } from "@/server/llc/seed-unit-classes";
import { createTRPCRouter, withAccessControl, withAuth } from "@/trpc/api/trpc";
import { ZodOnboardingMutationSchema } from "../onboarding-router/schema";
import { ZodSwitchCompanyMutationSchema } from "./schema";

export const companyRouter = createTRPCRouter({
  getCompany: withAuth.query(async ({ ctx }) => {
    const user = ctx.session.user;
    const companyId = user.companyId;

    const company = await ctx.db.member.findFirstOrThrow({
      where: {
        id: user.memberId,
        companyId,
      },
      select: {
        id: true,
        title: true,
        company: {
          select: {
            id: true,
            publicId: true,
            name: true,
            website: true,
            incorporationDate: true,
            incorporationType: true,
            incorporationState: true,
            incorporationCountry: true,
            state: true,
            city: true,
            zipcode: true,
            streetAddress: true,
            country: true,
            logo: true,
            entityType: true,
            timezone: true,
          },
        },
      },
    });
    return company;
  }),
  switchCompany: withAuth
    .input(ZodSwitchCompanyMutationSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, session } = ctx;

      await db.$transaction(async (tx) => {
        const member = await tx.member.findFirst({
          where: {
            id: input.id,
            userId: session.user.id,
            status: "ACTIVE",
            isOnboarded: true,
          },
        });

        if (!member) {
          return { success: true };
        }

        await tx.member.update({
          where: {
            id: member.id,
          },
          data: {
            lastAccessed: new Date(),
          },
        });
      });

      return { success: true };
    }),
  updateCompany: withAccessControl
    .meta({ policies: { company: { allow: ["update"] } } })
    .input(ZodOnboardingMutationSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { company } = input;
        const { incorporationDate, ...rest } = company;
        const { requestIp, userAgent, session, db } = ctx;
        const { user } = session;
        const { companyId } = ctx.membership;

        await db.company.update({
          where: {
            id: companyId,
          },
          data: {
            incorporationDate: new Date(incorporationDate),
            ...rest,
          },
        });

        await Audit.create(
          {
            action: "company.updated",
            companyId: user.companyId,
            actor: { type: "user", id: user.id },
            context: {
              userAgent,
              requestIp,
            },
            target: [{ type: "company", id: user.companyId }],
            summary: `${user.name} updated the company ${company.name}`,
          },
          db,
        );

        return {
          success: true,
          message: "successfully updated company",
        };
      } catch (error) {
        console.error("Error onboarding:", error);
        return {
          success: false,
          message:
            "Oops, something went wrong while onboarding. Please try again.",
        };
      }
    }),
  setEntityType: withAccessControl
    .meta({ policies: { company: { allow: ["update"] } } })
    .input(z.object({ entityType: z.enum(["CORPORATION", "LLC"]) }))
    .mutation(async ({ ctx, input }) => {
      const { requestIp, userAgent, session, db } = ctx;
      const { user } = session;
      const { companyId } = ctx.membership;

      return await db.$transaction(async (tx) => {
        const company = await tx.company.findUniqueOrThrow({
          where: { id: companyId },
          select: { id: true, name: true, entityType: true },
        });

        if (company.entityType === input.entityType) {
          return { entityType: company.entityType };
        }

        if (input.entityType === "LLC") {
          const where = { companyId };
          const counts = await Promise.all([
            tx.share.count({ where }),
            tx.option.count({ where }),
            tx.safe.count({ where }),
            tx.convertibleNote.count({ where }),
            tx.investment.count({ where }),
          ]);
          if (counts.some((n) => n > 0)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Remove existing shares, options, SAFEs, convertible notes and investments before switching to LLC.",
            });
          }
        } else {
          const commitments = await tx.commitment.count({
            where: { companyId },
          });
          if (commitments > 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "This company has LLC commitments and cannot be switched back.",
            });
          }
        }

        await tx.company.update({
          where: { id: companyId },
          data: { entityType: input.entityType },
        });

        if (input.entityType === "LLC") {
          await ensureDefaultUnitClasses(tx, companyId);
        }

        await Audit.create(
          {
            action: "company.entity-type-changed",
            companyId,
            actor: { type: "user", id: user.id },
            context: { userAgent, requestIp },
            target: [{ type: "company", id: companyId }],
            summary: `${user.name} changed the entity type of ${company.name} to ${input.entityType}`,
          },
          tx,
        );

        return { entityType: input.entityType };
      });
    }),
  setTimezone: withAccessControl
    .meta({ policies: { company: { allow: ["update"] } } })
    .input(
      z.object({
        timezone: z
          .string()
          .refine(isValidTimeZone, "Choose a valid IANA time zone"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { requestIp, userAgent, session, db } = ctx;
      const { user } = session;
      const { companyId } = ctx.membership;

      return await db.$transaction(async (tx) => {
        const company = await tx.company.update({
          where: { id: companyId },
          data: { timezone: input.timezone },
          select: { name: true, timezone: true },
        });

        await Audit.create(
          {
            action: "company.updated",
            companyId,
            actor: { type: "user", id: user.id },
            context: { userAgent, requestIp },
            target: [{ type: "company", id: companyId }],
            summary: `${user.name} set the time zone of ${company.name} to ${input.timezone}`,
          },
          tx,
        );

        return { timezone: company.timezone };
      });
    }),
});
